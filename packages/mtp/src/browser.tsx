import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast as sonnerToast } from "@nonanium/ui";
import { base64ToBytes, ConnectionState, MTPClient } from "mtp";
import createAsyncQueue from "@tensamin/shared/asyncQueue";
import {
  mtp as mtpSchemas,
  type Calls,
  type Communities,
  type Contacts,
} from "@tensamin/shared/data";
import { getAppFocused } from "@tensamin/shared/focus";
import { log, logMTP } from "@tensamin/shared/log";
import { useStorage } from "@tensamin/storage/context";
import type { SyncRecord } from "@tensamin/shared/accountSync";
import { persistAccountSnapshot, projectAccountState } from "./accountSync";

import {
  type BoundSendFn,
  MTPContext,
  type ProtocolMessage,
  removeMissingContacts,
  updateContactNotifications,
  type SealedRelaySend,
  useMessageHandlers,
  type MTPConnectionStatus,
} from "./mtpContext";
import {
  DISCOVERY_TIMEOUT,
  INITIAL_SYNC_TIMEOUT,
  RECONNECT_JITTER,
  RECONNECT_TRIES,
  RETRY_INTERVAL,
} from "./values";

type BrowserMtpClient = Awaited<ReturnType<typeof createBrowserClient>>;

const CONNECTION_TOAST_ID = "mtp-connection-toast";

function createBrowserClient(
  options: Omit<Parameters<typeof MTPClient.create>[0], "schemas">,
) {
  return MTPClient.create({
    ...options,
    schemas: mtpSchemas,
    throwProtocolErrors: true,
    onValidationError: (error) => {
      log(1, "mtp", "red", "Failed to validate push message", error);
    },
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Initial state synchronization was cancelled");
}

function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const timeout = setTimeout(
      () => finish(() => reject(new Error(timeoutMessage))),
      timeoutMs,
    );
    const onAbort = () => finish(() => reject(abortError(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function initializeAccountState(
  client: BrowserMtpClient,
  signal: AbortSignal,
  userId: number,
  deviceId: string,
  syncTimeoutMs = INITIAL_SYNC_TIMEOUT,
): Promise<ProtocolMessage<"AccountStateSnapshot">["data"]> {
  await withDeadline(
    client.auth(),
    syncTimeoutMs,
    "MTP authentication timed out",
    signal,
  );
  const dictionary = client.dictionaryIdentity?.fingerprint;
  if (!dictionary) throw new Error("MTP dictionary identity is unavailable");
  const exchange = async (request: object) => {
    const response = await withDeadline(
      client.request("AccountStateRequest", {
        Json: new TextEncoder().encode(JSON.stringify(request)),
      }),
      syncTimeoutMs,
      "Account synchronization timed out",
      signal,
    );
    if (response.type !== "AccountStateSnapshot")
      throw new Error("Unexpected account sync response");
    if (response.data.state === "unavailable")
      throw new Error(`Account synchronization: ${response.data.error}`);
    return response.data;
  };
  const discovered = await exchange({
    operation: "discover",
    device_id: deviceId,
    dictionary,
  });
  if (
    discovered.state !== "scope" ||
    discovered.scope.principal.user_id !== userId ||
    discovered.scope.dictionary !== dictionary ||
    discovered.scope.device_id !== deviceId
  ) {
    throw new Error(
      "Account synchronization scope does not match this session",
    );
  }
  const scope = discovered.scope;
  const records: SyncRecord[] = [];
  let page: { id: string; offset: number } | null = null;
  let head: number | null = null;
  let pageId: string | null = null;
  let size = 0;
  for (;;) {
    const response = await exchange({
      operation: "snapshot",
      scope,
      page,
      limit: 128,
    });
    if (
      response.state !== "snapshot" ||
      JSON.stringify(response.scope) !== JSON.stringify(scope) ||
      response.floor > response.head ||
      (head !== null && head !== response.head) ||
      (pageId !== null && pageId !== response.page_id)
    ) {
      throw new Error("Account synchronization page does not match its scope");
    }
    head = response.head;
    pageId = response.page_id;
    records.push(...response.records);
    size += new TextEncoder().encode(
      JSON.stringify(response.records),
    ).byteLength;
    if (records.length > 100_000 || size > 32 * 1024 * 1024)
      throw new Error("Account snapshot exceeds capacity");
    if (!response.next) break;
    if (
      response.next.id !== pageId ||
      response.records.length === 0 ||
      response.next.offset !== (page?.offset ?? 0) + response.records.length
    ) {
      throw new Error("Account synchronization returned an invalid page token");
    }
    page = response.next;
  }
  const state = projectAccountState(scope, head, records);
  // Acknowledge only after the complete snapshot is durable, including records
  // that do not yet have a UI projection.
  await persistAccountSnapshot(scope, head, records);
  if (signal.aborted) throw abortError(signal);
  const cursor = { scope, sequence: head };
  const acknowledged = await exchange({
    operation: "acknowledge",
    cursor,
    page_id: pageId,
  });
  if (
    acknowledged.state !== "acknowledged" ||
    JSON.stringify(acknowledged.cursor) !== JSON.stringify(cursor)
  ) {
    throw new Error("Account synchronization acknowledgement does not match");
  }
  return state;
}

function protocolErrorDetails(error: unknown) {
  if (typeof error !== "object" || error === null || !("type" in error)) {
    return null;
  }
  const protocolError = error as {
    id?: unknown;
    type?: unknown;
    frame?: unknown;
  };
  return {
    id: protocolError.id,
    type: protocolError.type,
    frame: protocolError.frame,
  };
}

export function BrowserProvider(props: {
  children: ReactNode;
  blockConnection?: boolean;
}) {
  const { load } = useStorage();
  const [readyState, setReadyState] = useState<number>(
    ConnectionState.Disconnected,
  );
  const [identified, setIdentified] = useState(false);
  const [identifying, setIdentifying] = useState(false);
  const [sessionEstablished, setSessionEstablished] = useState(false);
  const [connectionStatus, setConnectionStatus] =
    useState<MTPConnectionStatus | null>(null);
  const [freshCommunities, setFreshCommunities] = useState<Communities>([]);
  const [freshContacts, setFreshContacts] = useState<Contacts>([]);
  const [freshCalls, setFreshCalls] = useState<Calls>([]);
  const [clientState, setClientState] = useState<
    ProtocolMessage<"AccountStateSnapshot">["data"] | null
  >(null);
  const clientRef = useRef<BrowserMtpClient | null>(null);
  const [contextClient, setContextClient] = useState<BrowserMtpClient | null>(
    null,
  );
  const callControlRequestRef = useRef<
    | ((
        ownerOmikronId: number | undefined,
        ...args: Parameters<BoundSendFn>
      ) => ReturnType<BoundSendFn>)
    | null
  >(null);
  const { addInterceptor, attachSubscriptions, interceptorsRef, subscribe } =
    useMessageHandlers();
  const connected = readyState === ConnectionState.Connected;
  const retryConnectionRef = useRef(() => {});

  useEffect(() => {
    if (!connectionStatus) {
      sonnerToast.dismiss(CONNECTION_TOAST_ID);
      return;
    }
    if (connectionStatus.kind === "reconnecting" || !sessionEstablished) {
      return;
    }
    sonnerToast.error("Connection failed", {
      id: CONNECTION_TOAST_ID,
      description: connectionStatus.description,
      icon: null,
      duration: Infinity,
      closeButton: true,
      action: {
        label: "Retry",
        onClick: () => retryConnectionRef.current(),
      },
    });
  }, [connectionStatus, sessionEstablished]);

  const [mtpUrl, setMtpUrl] = useState<string | null>(null);
  useEffect(() => {
    load("omega_url").then(setMtpUrl);
  }, [load]);

  const send: BoundSendFn = useMemo(
    () => async (type, data, options) => {
      const client = clientRef.current;
      if (!client) throw new Error("mtp is not connected");
      try {
        const response = await client.request(type, data, options);
        log(2, "mtp", "cyan", `< ${response.type}`, {
          hint: "info",
          type: response.type,
          data: response.data,
          direction: "recv",
        });
        if (response.type === "GetStates") {
          setFreshContacts((contacts) =>
            removeMissingContacts(
              contacts,
              (response as ProtocolMessage<"GetStates">).data.MissingUserIds ??
                [],
            ),
          );
        }
        return response;
      } catch (error) {
        const details = protocolErrorDetails(error);
        log(
          1,
          "mtp",
          "red",
          `< ${typeof details?.type === "string" ? details.type : `${type} failed`}`,
          error,
        );
        throw error;
      }
    },
    [],
  );
  const sendToCallOwner = useMemo(
    () =>
      async (
        ownerOmikronId: number | undefined,
        ...args: Parameters<BoundSendFn>
      ) => {
        const request = callControlRequestRef.current;
        if (!request) throw new Error("mtp call control is not connected");
        return request(ownerOmikronId, ...args);
      },
    [],
  );
  const sendSealedRelay: SealedRelaySend = useMemo(
    () => async (type, data, options) => {
      const client = clientRef.current;
      if (!client) throw new Error("mtp is not connected");
      const response = await client.requestSealedRelay(type, data, {
        nextHop: options.nextHop,
        finalRecipientId: options.finalRecipientId,
        metadataRecipients: options.metadataRecipients,
        contentRecipients: options.contentRecipients,
      });
      return {
        type: response.type,
        data: response.data as Record<string, unknown>,
      };
    },
    [],
  );

  const resolveConnectionRef = useRef(() => {});
  useEffect(() => {
    if (!mtpUrl) return;
    const omegaBaseUrl = `${mtpUrl.replace(/\/+$/, "")}/`;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectScheduled = false;
    let disposed = false;
    let connectionGeneration = 0;
    let cleanupConnection = () => {};

    const clearReconnectTimer = () => {
      if (!reconnectTimer) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      reconnectScheduled = false;
    };
    const scheduleReconnect = (error: unknown) => {
      if (disposed || reconnectScheduled) return;
      attempts += 1;
      const shortRetry = attempts <= RECONNECT_TRIES;
      if (!shortRetry) {
        log(0, "mtp", "red", "Reconnection attempts exhausted", error);
        setConnectionStatus({
          kind: "failed",
          description:
            error instanceof Error
              ? `${error.message.split(":")[0]}.`
              : "Connection lost.",
        });
        return;
      }
      setConnectionStatus({ kind: "reconnecting", attempt: attempts });
      const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER;
      reconnectScheduled = true;
      reconnectTimer = setTimeout(
        () => {
          reconnectScheduled = false;
          reconnectTimer = null;
          void connect();
        },
        Math.round(RETRY_INTERVAL * jitter),
      );
    };

    async function connect() {
      if (disposed || props.blockConnection) return;
      const generation = ++connectionGeneration;
      let client: BrowserMtpClient | null = null;
      let failed = false;
      let connectionReady = false;
      let detachSubscriptions = () => {};
      let unsubscribeNoIota = () => {};
      const ownerClients = new Map<number, BrowserMtpClient>();
      const attemptAbort = new AbortController();
      const cleanup = () => {
        attemptAbort.abort(
          new Error("Initial state synchronization was cancelled"),
        );
        unsubscribeNoIota();
        detachSubscriptions();
        for (const ownerClient of ownerClients.values())
          ownerClient.disconnect();
        ownerClients.clear();
        callControlRequestRef.current = null;
        client?.disconnect();
        if (clientRef.current === client) {
          clientRef.current = null;
          setContextClient(null);
        }
        if (generation === connectionGeneration) {
          setReadyState(ConnectionState.Disconnected);
          setIdentified(false);
          setIdentifying(false);
        }
      };
      cleanupConnection = cleanup;
      try {
        setIdentified(false);
        setIdentifying(false);
        setClientState(null);
        const [userId, keyring] = await Promise.all([
          load("user_id"),
          load("mtp_keyring"),
        ]);
        if (!userId || !keyring) throw new Error("Missing login credentials");
        const forcedOmikronUrl = await load("forced_omikron_url");
        const forcedOmikronPublicKey = await load("forced_omikron_public_key");
        let url = null;
        let omikronPublicKey = null;
        let primaryOmikronId: number | undefined;
        if (forcedOmikronUrl && forcedOmikronPublicKey) {
          url = forcedOmikronUrl;
          omikronPublicKey = forcedOmikronPublicKey;
        } else {
          log(2, "mtp", "purple", "Fetching Omikron data.");
          const data = await fetch(
            new URL(`api/get/omikron/${userId}`, omegaBaseUrl),
            {
              signal: AbortSignal.any([
                attemptAbort.signal,
                AbortSignal.timeout(DISCOVERY_TIMEOUT),
              ]),
            },
          );
          if (data.status === 404) {
            throw new Error("No Omikron assignment is currently available");
          }
          if (!data.ok)
            throw new Error(`Omikron discovery failed: HTTP ${data.status}`);
          const omikronData = (await data.json()) as {
            id: number;
            ip_address: string;
            port: number;
            public_key: string;
          };
          if (
            !omikronData.ip_address ||
            !omikronData.port ||
            !omikronData.id ||
            !omikronData.public_key
          ) {
            throw new Error("Invalid Omikron data");
          }
          url = `https://${omikronData.ip_address}:${omikronData.port}`;
          omikronPublicKey = omikronData.public_key;
          primaryOmikronId = omikronData.id;
        }
        if (!url || !omikronPublicKey) {
          throw new Error("Missing Omikron URL or Public Key");
        }
        log(2, "mtp", "green", "Connecting to: " + url);
        client = await createBrowserClient({
          url,
          credentials: { clientId: userId, keyring: base64ToBytes(keyring) },
          hostPublicKey: { value: omikronPublicKey, encoding: "base64" },
          descriptor: "client",
          pings: true,
          securityProfile: { protectedSignatureSuite: "dual" },
          logger: (event) => logMTP(event, ["Ping", "Pong", "Relay"]),
          onStateChange: (state) => {
            if (generation !== connectionGeneration) return;
            setReadyState(state);
            if (
              (state === ConnectionState.Disconnected ||
                state === ConnectionState.Failed) &&
              clientRef.current === client &&
              !failed
            ) {
              failed = true;
              const error = new Error("MTP connection lost");
              attemptAbort.abort(error);
              if (connectionReady) {
                cleanup();
                scheduleReconnect(error);
              }
            }
          },
        });
        if (disposed || generation !== connectionGeneration) {
          client.disconnect();
          return;
        }
        const activeClient = client;
        clientRef.current = activeClient;
        setContextClient(activeClient);
        callControlRequestRef.current = async (
          ownerOmikronId,
          type,
          data,
          options,
        ) => {
          if (ownerOmikronId == null || ownerOmikronId === primaryOmikronId) {
            return activeClient.request(type, data, options);
          }

          let ownerClient = ownerClients.get(ownerOmikronId);
          if (!ownerClient) {
            const response = await fetch(
              new URL(`api/get/omikron/${ownerOmikronId}`, omegaBaseUrl),
              {
                signal: attemptAbort.signal,
              },
            );
            if (!response.ok) {
              throw new Error(
                `Call owner discovery failed: HTTP ${response.status}`,
              );
            }
            const owner = (await response.json()) as {
              id: number;
              ip_address: string;
              port: number;
              public_key: string;
            };
            if (
              owner.id !== ownerOmikronId ||
              !owner.ip_address ||
              !owner.port ||
              !owner.public_key
            ) {
              throw new Error(
                "Call owner discovery returned an invalid Omikron",
              );
            }
            ownerClient = await createBrowserClient({
              url: `https://${owner.ip_address}:${owner.port}`,
              credentials: {
                clientId: userId,
                keyring: base64ToBytes(keyring),
              },
              hostPublicKey: { value: owner.public_key, encoding: "base64" },
              descriptor: "client-call-control",
              pings: true,
              securityProfile: { protectedSignatureSuite: "dual" },
              logger: logMTP,
            });
            try {
              await ownerClient.auth();
            } catch (error) {
              ownerClient.disconnect();
              throw error;
            }
            ownerClients.set(ownerOmikronId, ownerClient);
          }
          return ownerClient.request(type, data, options);
        };
        detachSubscriptions = attachSubscriptions(activeClient);
        const unsubscribeForeground = activeClient.subscribe(
          "SessionActivitySet",
          (message) => {
            if (clientRef.current !== activeClient || !message.id) return;
            void activeClient
              .send(
                "SessionActivitySet",
                { Foreground: getAppFocused() },
                { id: message.id },
              )
              .catch((error) =>
                log(1, "mtp", "yellow", "Foreground reply failed", error),
              );
          },
        );
        const detachMessages = detachSubscriptions;
        detachSubscriptions = () => {
          unsubscribeForeground();
          detachMessages();
        };
        unsubscribeNoIota = subscribe("ErrorNoIota", () => {
          if (clientRef.current !== activeClient || failed) return;
          failed = true;
          const error = new Error("No Iota is currently connected");
          attemptAbort.abort(error);
          cleanup();
          scheduleReconnect(error);
        });
        setReadyState(activeClient.state);
        setIdentifying(true);
        const state = await initializeAccountState(
          activeClient,
          attemptAbort.signal,
          userId,
          String(await load("session_id")),
        );
        if (disposed || clientRef.current !== activeClient) return;
        setFreshContacts(state.Contacts);
        if (state.PresenceSnapshotComplete) {
          setFreshContacts((contacts) =>
            removeMissingContacts(contacts, state.MissingUserIds),
          );
        }
        setFreshCommunities(state.Communities);
        setFreshCalls(state.Calls);
        setClientState(state);
        connectionReady = true;
        setIdentifying(false);
        setIdentified(true);
        setSessionEstablished(true);
        clearReconnectTimer();
        attempts = 0;
        setConnectionStatus(null);
        resolveConnectionRef.current?.();
      } catch (connectError) {
        if (disposed || generation !== connectionGeneration) {
          client?.disconnect();
          return;
        }
        failed = true;
        cleanup();
        const message =
          connectError instanceof Error
            ? connectError.message
            : String(connectError ?? "Unknown error");
        log(
          0,
          "mtp",
          "red",
          `Connection/authentication attempt failed: ${message}`,
          protocolErrorDetails(connectError) ?? connectError,
        );
        scheduleReconnect(connectError);
      }
    }

    retryConnectionRef.current = () => {
      if (disposed) return;
      clearReconnectTimer();
      attempts = 0;
      setConnectionStatus(null);
      void connect();
    };
    void connect();
    return () => {
      disposed = true;
      retryConnectionRef.current = () => {};
      clearReconnectTimer();
      cleanupConnection();
      setReadyState(ConnectionState.Disconnected);
      setIdentified(false);
      setIdentifying(false);
      setSessionEstablished(false);
      setConnectionStatus(null);
      sonnerToast.dismiss(CONNECTION_TOAST_ID);
    };
  }, [attachSubscriptions, load, mtpUrl, props.blockConnection, subscribe]);

  useEffect(() => {
    return subscribe("ErrorNoIota", () => {
      setIdentified(false);
      setIdentifying(false);
      sonnerToast.error("We couldn't reach your Iota", {
        description:
          "Check your network connection and try restarting your Iota",
        icon: null,
        duration: Infinity,
        closeButton: true,
      });
      resolveConnectionRef.current?.();
    });
  }, [subscribe]);

  useEffect(
    () =>
      subscribe("GetStates", (message) => {
        setFreshContacts((contacts) =>
          removeMissingContacts(contacts, message.data.MissingUserIds ?? []),
        );
      }),
    [subscribe],
  );

  useEffect(() => {
    const messageLive = subscribe("MessageLive", ({ data }) => {
      setFreshContacts((contacts) =>
        updateContactNotifications(
          contacts,
          data.SenderId,
          data.notifications,
          data.LastMessageAt,
        ),
      );
    });
    const notificationChanged = subscribe("PushNotification", ({ data }) => {
      setFreshContacts((contacts) =>
        updateContactNotifications(
          contacts,
          data.ChatPartnerId,
          data.notifications,
          data.LastMessageAt,
        ),
      );
    });
    return () => {
      messageLive();
      notificationChanged();
    };
  }, [subscribe]);

  const loadingDescription = useMemo(() => {
    if (!mtpUrl) return "Finding an Omikron...";
    if (readyState === ConnectionState.Connecting || !connected) {
      return "Connecting to Omikron...";
    }
    if (identifying || !identified) return "Authenticating...";
    return "Loading...";
  }, [connected, identified, identifying, readyState, mtpUrl]);
  const contextReady = connected && identified && mtpUrl !== null;
  const mtpRef = useMemo(() => createAsyncQueue<{ send: typeof send }>(), []);
  useEffect(() => {
    if (connected && identified && mtpUrl) {
      mtpRef.set({ send });
    }
  }, [connected, identified, mtpUrl, send, mtpRef]);

  const sendQueued: BoundSendFn = useMemo(
    () => async (type, data, options) => {
      const mtp = await mtpRef.get();
      const response = await mtp.send(type, data, options);
      for (const interceptor of interceptorsRef.current) {
        void Promise.resolve(interceptor({ type, data, response })).catch(
          (error) => {
            log(1, "mtp", "yellow", "MTP interceptor failed", error, { type });
          },
        );
      }
      return response;
    },
    [interceptorsRef, mtpRef],
  );

  return (
    <MTPContext.Provider
      value={{
        send: sendQueued,
        sendCallControl: sendToCallOwner,
        sendSealedRelay,
        subscribe,
        addInterceptor,
        client: contextClient,
        readyState,
        identified,
        freshContacts,
        updateContacts: setFreshContacts,
        freshCommunities,
        freshCalls,
        clientState,
        contextReady,
        sessionEstablished,
        loadingDescription,
        connectionStatus,
        retryConnection: () => retryConnectionRef.current(),
      }}
    >
      {props.children}
    </MTPContext.Provider>
  );
}

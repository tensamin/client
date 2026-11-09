import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast as sonnerToast } from "@nonanium/ui";
import {
  base64ToBytes,
  ConnectionState,
  MTPClient,
  MTPProtocol,
  decode,
} from "mtp";
import {
  mtp as mtpSchemas,
  type Calls,
  type Communities,
  type Contacts,
} from "@tensamin/shared/data";
import {
  getAppFocused,
  subscribeAppFocus,
  setPlatformVisible,
  useAppFocused,
} from "@tensamin/shared/focus";
import { listen } from "@tauri-apps/api/event";
import { publishNotificationHint } from "@tensamin/shared/notification";
import {
  credentialMetadata,
  getSyncDeviceId,
} from "@tensamin/shared/accountSync";
import {
  createNativeCallControl,
  callControlRequests,
} from "./nativeCallControl";
import { createNativeRelayClient } from "./nativeRelay";
import { log, logMTP } from "@tensamin/shared/log";
import { useStorage } from "@tensamin/storage/context";
import {
  accountSnapshotKey,
  projectAccountJournal,
  loadAccountRuntime,
  accountCacheBinding,
  loadOfflineAccountState,
  loadCachedMessages,
  persistAccountScope,
  type AccountCacheBinding,
  type AccountState,
} from "./accountSync";
import { AccountJournal } from "./accountJournal";
import { useRelayOutbox } from "./useRelayOutbox";
import { invoke, isTauri } from "@tauri-apps/api/core";

import {
  type BoundSendFn,
  MTPContext,
  useMessageHandlers,
  useAccountRefresh,
  type MTPConnectionStatus,
} from "./mtpContext";
import { subscribeCommittedRelays } from "./relay";
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
      log(1, "mtp", "red", "Failed to validate push message", {
        phase: error.phase,
        messageType: error.messageType,
      });
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
  binding: AccountCacheBinding,
  syncTimeoutMs = INITIAL_SYNC_TIMEOUT,
  forceSnapshot = false,
): Promise<AccountState> {
  const userId = binding.user_id;
  const deviceId = binding.device_id;
  signal.throwIfAborted();
  const dictionary = client.dictionaryIdentity?.fingerprint;
  if (!dictionary) throw new Error("MTP dictionary identity is unavailable");
  const exchange = async (request: object) => {
    signal.throwIfAborted();
    if (!getAppFocused()) throw new Error("Foreground synchronization paused");
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
  if (!navigator.locks)
    throw new Error("Account synchronization requires Web Locks");
  const state = await navigator.locks.request(
    accountSnapshotKey(scope),
    { signal },
    async () => {
      const stored = await AccountJournal.load(scope);
      const resumable = forceSnapshot ? null : stored;
      const after = resumable?.head ?? 0;
      let resuming = resumable !== null;
      let journal = resumable ?? (await AccountJournal.begin(scope, signal));
      let staging = resumable === null;
      try {
        let sequence = after;
        let page: { id: string; offset: number } | null = null;
        let head: number | null = null;
        let floor: number | null = null;
        let pageId: string | null = null;
        for (;;) {
          const response = await exchange(
            resuming
              ? {
                  operation: "delta",
                  after: { scope, sequence: after },
                  page,
                  limit: 128,
                }
              : {
                  operation: "snapshot",
                  scope,
                  page,
                  limit: 128,
                },
          );
          if (response.state === "unavailable") {
            if (resuming && response.error === "snapshot_required") {
              resuming = false;
              journal = await AccountJournal.begin(scope, signal);
              staging = true;
              page = null;
              head = null;
              floor = null;
              pageId = null;
              continue;
            }
            throw new Error(`Account synchronization: ${response.error}`);
          }
          if (
            (response.state !== "snapshot" && response.state !== "delta") ||
            (resuming
              ? response.state !== "delta"
              : response.state !== "snapshot") ||
            JSON.stringify(response.scope) !== JSON.stringify(scope) ||
            response.floor > response.head ||
            (resuming &&
              (response.floor > after || response.head < sequence)) ||
            (head !== null && head !== response.head) ||
            (floor !== null && floor !== response.floor) ||
            (pageId !== null && pageId !== response.page_id)
          ) {
            throw new Error(
              "Account synchronization page does not match its scope",
            );
          }
          head = response.head;
          floor = response.floor;
          pageId = response.page_id;
          const items =
            response.state === "snapshot" ? response.records : response.events;
          if (response.state === "snapshot") {
            await journal.append(response.records, signal);
          } else {
            for (const event of response.events) {
              if (
                event.sequence !== sequence + 1 ||
                event.sequence > head ||
                event.event_id !==
                  `${scope.principal.authority}:${scope.principal.user_id}:${event.sequence}`
              )
                throw new Error("Account delta is not contiguous");
              if (event.operation === "delete") {
                if (event.record !== null)
                  throw new Error("Account deletion contains a record");
              } else {
                if (
                  !event.record ||
                  event.record.entity !== event.entity ||
                  event.record.key !== event.key
                ) {
                  throw new Error(
                    "Account delta record does not match its event",
                  );
                }
              }
              sequence = event.sequence;
            }
            await journal.apply(
              response.events.map((event) => ({
                entity: event.entity,
                key: event.key,
                record: event.record,
              })),
              sequence,
              signal,
            );
          }
          if (!response.next) break;
          if (
            response.next.id !== pageId ||
            items.length === 0 ||
            response.next.offset !== (page?.offset ?? 0) + items.length
          ) {
            throw new Error(
              "Account synchronization returned an invalid page token",
            );
          }
          page = response.next;
        }
        if (resuming && sequence !== head)
          throw new Error("Account delta omitted events");
        signal.throwIfAborted();
        if (!getAppFocused())
          throw new Error("Foreground synchronization paused");
        const state = {
          ...(await projectAccountJournal(journal, undefined, signal)),
          VersionNumber: head,
        };
        // Activation commits only after all snapshot pages are durable and valid. Delta
        // pages commit records with their own contiguous local checkpoint.
        await journal.commit(head, signal);
        staging = false;
        await persistAccountScope(binding, scope);
        if (stored && stored.generation !== journal.generation)
          await stored.discard();
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
          throw new Error(
            "Account synchronization acknowledgement does not match",
          );
        }
        return state;
      } finally {
        if (staging) await journal.discard();
      }
    },
  );
  signal.throwIfAborted();
  if (!getAppFocused()) throw new Error("Foreground synchronization paused");
  return withDeadline(
    loadAccountRuntime(state, client),
    syncTimeoutMs,
    "Account runtime state loading timed out",
    signal,
  );
}

export function RendererProvider(props: {
  children: ReactNode;
  blockConnection?: boolean;
}) {
  const { load, subscribe: subscribeStorage } = useStorage();
  const visible = useAppFocused();
  const [callActive, setCallActivity] = useState(false);
  const callActiveRef = useRef(false);
  const [nativeViewReady, setNativeViewReady] = useState(false);
  const setCallActive = useCallback((active: boolean, microphone: boolean) => {
    callActiveRef.current = active;
    setCallActivity(active);
    if (isTauri())
      void invoke("mtp_set_call_active", { active, microphone }).catch(
        (error) =>
          log(1, "call", "red", "Native audio lifecycle failed", error),
      );
  }, []);
  const [credentials, setCredentials] = useState<{
    userId: number;
    identity: { keyring: string } | { binding: AccountCacheBinding };
    omegaUrl: string;
    deviceId: string;
    forcedUrl: string | undefined;
    forcedKey: string | undefined;
  } | null>(null);
  const credentialRevisionRef = useRef(0);
  const reloadCredentialsRef = useRef<() => Promise<void>>(async () => {});
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
  const [clientState, setClientState] = useState<AccountState | null>(null);
  const clientStateRef = useRef<AccountState | null>(null);
  const publishState = useCallback((state: AccountState | null) => {
    clientStateRef.current = state;
    setClientState(state);
    setFreshContacts(state?.Contacts ?? []);
    setFreshCommunities(state?.Communities ?? []);
    setFreshCalls(state?.Calls ?? []);
  }, []);
  const readCachedMessages = useCallback(
    (principal: string) =>
      clientState?.Scope
        ? loadCachedMessages(clientState.Scope, principal)
        : Promise.resolve(null),
    [clientState],
  );
  const clientRef = useRef<BrowserMtpClient | null>(null);
  const authenticatedClientRef = useRef<BrowserMtpClient | null>(null);
  const bindingRef = useRef<AccountCacheBinding | null>(null);
  const forceSnapshotRef = useRef(false);
  const sessionAbortRef = useRef<AbortController | null>(null);
  const nativeGenerationRef = useRef<number | undefined>(undefined);
  const [contextClient, setContextClient] = useState<BrowserMtpClient | null>(
    null,
  );
  const attachNativeView = useCallback(async (client: BrowserMtpClient) => {
    if (
      clientRef.current !== client ||
      authenticatedClientRef.current !== client
    )
      throw new Error("Native session changed");
    const status = await invoke<{ generation: number }>("mtp_status");
    const metadata = credentialMetadata.parse(
      await invoke("mtp_credential_metadata"),
    );
    const binding = bindingRef.current;
    if (
      !binding ||
      metadata.userId !== binding.user_id ||
      metadata.credentialSha256 !== binding.credential_sha256 ||
      metadata.omegaUrl !== binding.omega_url
    ) {
      await reloadCredentialsRef.current();
      throw new Error("Native credentials changed");
    }
    if (client.state !== ConnectionState.Connected) await client.connect();
    if (
      clientRef.current !== client ||
      authenticatedClientRef.current !== client
    )
      throw new Error("Native session changed during attachment");
    nativeGenerationRef.current = status.generation;
    setNativeViewReady(true);
  }, []);
  useEffect(() => {
    if (!isTauri() || !contextClient || !identified) return;
    let disposed = false;
    if (!visible && !callActive) {
      contextClient.disconnect();
      setNativeViewReady(false);
      return;
    }
    void attachNativeView(contextClient)
      .then(() => {
        if (!getAppFocused() && !callActiveRef.current) {
          contextClient.disconnect();
          setNativeViewReady(false);
        }
      })
      .catch((error) => {
        if (!disposed)
          log(1, "mtp", "red", "Native view attachment failed", error);
      });
    return () => {
      disposed = true;
    };
  }, [attachNativeView, callActive, contextClient, identified, visible]);
  const callControlRequestRef = useRef<
    | ((
        ownerOmikronId: number | undefined,
        ...args: Parameters<BoundSendFn>
      ) => ReturnType<BoundSendFn>)
    | null
  >(null);
  const {
    addInterceptor,
    attachSubscriptions,
    interceptorsRef,
    subscribe,
    publish,
  } = useMessageHandlers();
  useEffect(() => {
    if (isTauri() && contextClient && identified && nativeViewReady)
      return attachSubscriptions(contextClient);
  }, [attachSubscriptions, contextClient, identified, nativeViewReady]);
  const connected = readyState === ConnectionState.Connected;
  const retryConnectionRef = useRef(() => {});
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<{
      kind: string;
      snapshot?: {
        generation: number;
        readyState: number;
        identified: boolean;
      };
    }>("tensamin://mtp", ({ payload }) => {
      const snapshot = payload.snapshot;
      if (payload.kind !== "state" || !snapshot || disposed) return;
      const previous = nativeGenerationRef.current;
      nativeGenerationRef.current = snapshot.generation;
      setReadyState(snapshot.readyState);
      if (!snapshot.identified && authenticatedClientRef.current) {
        sessionAbortRef.current?.abort(new Error("Native session changed"));
        authenticatedClientRef.current = null;
        setIdentified(false);
      } else if (
        snapshot.identified &&
        ((authenticatedClientRef.current &&
          previous !== undefined &&
          previous !== snapshot.generation) ||
          sessionAbortRef.current?.signal.aborted)
      ) {
        void invoke("mtp_credential_metadata")
          .then((value) => {
            if (disposed || nativeGenerationRef.current !== snapshot.generation)
              return;
            const metadata = credentialMetadata.parse(value);
            const binding = bindingRef.current;
            if (
              binding &&
              binding.user_id === metadata.userId &&
              binding.omega_url === metadata.omegaUrl &&
              binding.credential_sha256 === metadata.credentialSha256
            )
              retryConnectionRef.current();
            else return reloadCredentialsRef.current();
          })
          .catch((error) =>
            log(1, "mtp", "red", "Native credential handoff failed", error),
          );
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  const refreshSnapshot = useCallback(async () => {
    const client = clientRef.current;
    const binding = bindingRef.current;
    if (!client || client !== authenticatedClientRef.current || !binding)
      throw new Error("MTP is not authenticated");
    if (!getAppFocused())
      throw new Error("Account synchronization is paused while hidden");
    const controller = new AbortController();
    const unsubscribe = subscribeAppFocus(() => {
      if (!getAppFocused())
        controller.abort(new Error("Account synchronization paused"));
    });
    let state: AccountState;
    try {
      const signal = AbortSignal.any([
        controller.signal,
        sessionAbortRef.current?.signal ?? AbortSignal.abort(),
        AbortSignal.timeout(INITIAL_SYNC_TIMEOUT),
      ]);
      if (isTauri() && client.state !== ConnectionState.Connected)
        await attachNativeView(client);
      if (!clientStateRef.current) {
        try {
          const cached = await loadOfflineAccountState(binding, signal);
          signal.throwIfAborted();
          if (
            cached &&
            clientRef.current === client &&
            bindingRef.current === binding
          )
            publishState(cached);
        } catch (error) {
          signal.throwIfAborted();
          forceSnapshotRef.current = true;
          log(
            1,
            "mtp",
            "yellow",
            "Saved account state could not be projected",
            error,
          );
        }
      }
      state = await initializeAccountState(
        client,
        signal,
        binding,
        INITIAL_SYNC_TIMEOUT,
        forceSnapshotRef.current,
      );
      signal.throwIfAborted();
      if (isTauri()) {
        if (!getAppFocused())
          throw new Error("Foreground synchronization paused");
        await invoke("mtp_refresh_identity");
        signal.throwIfAborted();
      }
    } finally {
      unsubscribe();
    }
    if (
      clientRef.current !== client ||
      authenticatedClientRef.current !== client ||
      !getAppFocused()
    )
      throw new Error("Account connection changed");
    forceSnapshotRef.current = false;
    publishState(state);
    return state;
  }, [attachNativeView, publishState]);
  const refreshAccountState = useAccountRefresh(
    refreshSnapshot,
    subscribe,
    sessionEstablished,
    addInterceptor,
  );
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<{
      account: string;
      signer: string;
      relayId: string;
      kind: string;
      time: number;
      order: number;
    }>("tensamin://notification", ({ payload }) => {
      if (
        payload.kind === "FileShareOffered" ||
        payload.kind === "FileShareRevoked"
      ) {
        publishNotificationHint({
          ...payload,
          kind: payload.kind,
          time: payload.time,
        });
        return;
      }
      if (getAppFocused())
        void refreshAccountState().catch((error) =>
          log(1, "mtp", "red", "Foreground relay catch-up failed", error),
        );
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [refreshAccountState]);

  useEffect(() => {
    if (!connectionStatus) {
      sonnerToast.dismiss(CONNECTION_TOAST_ID);
      return;
    }
    if (
      connectionStatus.kind === "reconnecting" ||
      (!sessionEstablished && !clientState)
    ) {
      return;
    }
    sonnerToast.error(
      clientState ? "Offline. Showing saved data" : "Connection failed",
      {
        id: CONNECTION_TOAST_ID,
        description: connectionStatus.description,
        icon: null,
        duration: Infinity,
        closeButton: true,
        action: {
          label: "Retry",
          onClick: () => retryConnectionRef.current(),
        },
      },
    );
  }, [connectionStatus, sessionEstablished, clientState]);

  const mtpUrl = credentials?.omegaUrl ?? null;
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<boolean>("tensamin://visibility", ({ payload }) =>
      setPlatformVisible(payload),
    ).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    const update = () =>
      void invoke("mtp_set_ui_visible", {
        visible: document.visibilityState === "visible",
      });
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      disposed = true;
      unlisten?.();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    const reloadCredentials = async () => {
      const revision = ++credentialRevisionRef.current;
      authenticatedClientRef.current = null;
      sessionAbortRef.current?.abort(new Error("Account credentials changed"));
      bindingRef.current = null;
      forceSnapshotRef.current = false;
      const previous = clientRef.current;
      clientRef.current = null;
      previous?.disconnect();
      callControlRequestRef.current = null;
      setContextClient(null);
      setCredentials(null);
      publishState(null);
      setIdentified(false);
      setSessionEstablished(false);
      const deviceId = await getSyncDeviceId();
      if (isTauri()) {
        if (!(await invoke<boolean>("mtp_has_credentials"))) return;
        const metadata = credentialMetadata.parse(
          await invoke("mtp_credential_metadata"),
        );
        if (!disposed && revision === credentialRevisionRef.current)
          setCredentials({
            userId: metadata.userId,
            omegaUrl: metadata.omegaUrl,
            deviceId,
            forcedUrl: undefined,
            forcedKey: undefined,
            identity: {
              binding: {
                user_id: metadata.userId,
                device_id: deviceId,
                omega_url: metadata.omegaUrl,
                credential_sha256: metadata.credentialSha256,
              },
            },
          });
        return;
      }
      const [userId, keyring, omegaUrl, forcedUrl, forcedKey] =
        await Promise.all([
          load("user_id"),
          load("mtp_keyring"),
          load("omega_url"),
          load("forced_omikron_url"),
          load("forced_omikron_public_key"),
        ]);
      if (
        !disposed &&
        revision === credentialRevisionRef.current &&
        userId &&
        keyring
      ) {
        setCredentials({
          userId,
          identity: { keyring },
          omegaUrl,
          deviceId,
          forcedUrl,
          forcedKey,
        });
      }
    };
    reloadCredentialsRef.current = reloadCredentials;
    const unsubscribe = subscribeStorage((keys) => {
      if (
        keys.some((key) =>
          [
            "user_id",
            "mtp_keyring",
            "omega_url",
            "session_id",
            "forced_omikron_url",
            "forced_omikron_public_key",
          ].includes(key),
        )
      ) {
        void reloadCredentials().catch((error) =>
          log(0, "mtp", "red", "Failed to load account credentials", error),
        );
      }
    });
    void reloadCredentials().catch((error) =>
      log(0, "mtp", "red", "Failed to load account credentials", error),
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [load, publishState, subscribeStorage]);

  const send: BoundSendFn = useMemo(
    () => async (type, data, options) => {
      const client = contextClient;
      if (
        !client ||
        clientRef.current !== client ||
        client !== authenticatedClientRef.current
      )
        throw new Error("MTP is not authenticated");
      const backgroundCall =
        callControlRequests.has(type) ||
        (callActiveRef.current && type === "UserResolve");
      if (isTauri()) {
        if (!getAppFocused() && !backgroundCall)
          throw new Error("Native foreground requests are paused");
        if (client.state !== ConnectionState.Connected)
          await attachNativeView(client);
        if (!getAppFocused() && !backgroundCall)
          throw new Error("Native foreground requests are paused");
      }
      const response = await client.request(type, data, options);
      if (
        clientRef.current !== client ||
        authenticatedClientRef.current !== client
      )
        throw new Error("Account connection changed");
      return response;
    },
    [attachNativeView, contextClient],
  );
  const dismissCallInvite = useCallback(
    async (callId: string) => {
      if (!isTauri()) return;
      const active = contextClient;
      const identity = credentials?.identity;
      if (
        !active ||
        clientRef.current !== active ||
        !identity ||
        !("binding" in identity)
      )
        throw new Error("Call invitation account changed");
      await invoke("mtp_dismiss_call_invite", {
        callId,
        generation: nativeGenerationRef.current,
        credentialSha256: identity.binding.credential_sha256,
      });
      if (clientRef.current !== active)
        throw new Error("Call invitation account changed");
    },
    [contextClient, credentials],
  );
  const isCallInviteHandled = useCallback(
    async (callId: string) => {
      if (!isTauri()) return false;
      const active = contextClient;
      const identity = credentials?.identity;
      if (
        !active ||
        clientRef.current !== active ||
        !identity ||
        !("binding" in identity)
      )
        throw new Error("Call invitation account changed");
      const handled = await invoke<boolean>("mtp_call_invite_handled", {
        callId,
        generation: nativeGenerationRef.current,
        credentialSha256: identity.binding.credential_sha256,
      });
      if (clientRef.current !== active)
        throw new Error("Call invitation account changed");
      return handled;
    },
    [contextClient, credentials],
  );
  const sendToCallOwner = useMemo(
    () =>
      async (
        ownerOmikronId: number | undefined,
        ...args: Parameters<BoundSendFn>
      ) => {
        const active = contextClient;
        if (
          !active ||
          clientRef.current !== active ||
          authenticatedClientRef.current !== active
        )
          throw new Error("Call session changed");
        if (isTauri()) {
          if (active.state !== ConnectionState.Connected)
            await attachNativeView(active);
          try {
            return await createNativeCallControl({
              send,
              session: () => ({
                authenticated:
                  authenticatedClientRef.current === active &&
                  clientRef.current === active,
                generation: nativeGenerationRef.current ?? -1,
                client: active,
              }),
            })(ownerOmikronId, ...args);
          } finally {
            if (!getAppFocused() && !callActiveRef.current) {
              active.disconnect();
              setNativeViewReady(false);
            }
          }
        }
        const request = callControlRequestRef.current;
        if (!request || !active)
          throw new Error("mtp call control is not authenticated");
        const response = await request(ownerOmikronId, ...args);
        if (authenticatedClientRef.current !== active)
          throw new Error("Account connection changed");
        return response;
      },
    [attachNativeView, contextClient, send],
  );
  const isRelaySessionCurrent = useCallback(
    () =>
      contextClient !== null &&
      clientRef.current === contextClient &&
      authenticatedClientRef.current === contextClient,
    [contextClient],
  );
  const relayTransport = useCallback(() => {
    if (!contextClient) throw new Error("MTP is not authenticated");
    if (isTauri())
      return createNativeRelayClient({
        session: () => ({
          authenticated: authenticatedClientRef.current === contextClient,
          generation: nativeGenerationRef.current ?? -1,
          client: clientRef.current,
        }),
      });
    return contextClient;
  }, [contextClient]);
  const sendSealedRelay = useRelayOutbox({
    transport: relayTransport,
    scope: clientState?.Scope,
    ready:
      identified &&
      contextClient !== null &&
      sessionEstablished &&
      !props.blockConnection,
    isCurrent: isRelaySessionCurrent,
  });

  const resolveConnectionRef = useRef(() => {});
  useEffect(() => {
    if (!mtpUrl || !credentials) return;
    const credentialRevision = credentialRevisionRef.current;
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
      sessionAbortRef.current = attemptAbort;
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
          authenticatedClientRef.current = null;
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
        const { userId, identity, deviceId } = credentials!;
        if (!userId || ("keyring" in identity && !identity.keyring))
          throw new Error("Missing login credentials");
        const binding =
          "binding" in identity
            ? identity.binding
            : await accountCacheBinding({
                userId,
                keyring: identity.keyring,
                deviceId,
                omegaUrl: mtpUrl!,
              });
        bindingRef.current = binding;
        let cached: AccountState | null = null;
        let forceSnapshot = false;
        const cacheAbort = new AbortController();
        const stopCacheVisibility = subscribeAppFocus(() => {
          if (!getAppFocused())
            cacheAbort.abort(new Error("Saved-state projection paused"));
        });
        try {
          if (getAppFocused())
            cached = await loadOfflineAccountState(
              binding,
              AbortSignal.any([attemptAbort.signal, cacheAbort.signal]),
            );
        } catch (error) {
          if (!cacheAbort.signal.aborted && !attemptAbort.signal.aborted) {
            forceSnapshot = true;
            log(
              1,
              "mtp",
              "yellow",
              "Saved account state could not be projected; fetching a fresh snapshot",
              error,
            );
          }
        } finally {
          stopCacheVisibility();
        }
        if (
          disposed ||
          generation !== connectionGeneration ||
          credentialRevision !== credentialRevisionRef.current
        )
          return;
        forceSnapshotRef.current ||= forceSnapshot;
        if (cached && !clientStateRef.current) publishState(cached);
        const forcedOmikronUrl = credentials!.forcedUrl;
        const forcedOmikronPublicKey = credentials!.forcedKey;
        let url = null;
        let omikronPublicKey = null;
        let nativeOptions: Partial<
          Omit<
            Parameters<typeof createBrowserClient>[0],
            "credentials" | "hostPublicKey"
          >
        > = {};
        let primaryOmikronId: number | undefined;
        if (isTauri()) {
          await invoke("mtp_restore_credentials");
          await invoke("plugin:mtp|mtp_set_background_enabled", {
            enabled: true,
          });
          const options = await invoke<
            typeof nativeOptions & { url: string; hostPublicKey: number[] }
          >("mtp_frontend_options");
          const { hostPublicKey, ...rest } = options;
          nativeOptions = rest;
          const snapshot = await invoke<{ generation: number }>("mtp_status");
          nativeGenerationRef.current = snapshot.generation;
          url = options.url;
          omikronPublicKey = hostPublicKey;
        } else if (forcedOmikronUrl && forcedOmikronPublicKey) {
          url = forcedOmikronUrl;
          omikronPublicKey = forcedOmikronPublicKey;
        } else {
          log(2, "mtp", "purple", "Fetching Omikron data.");
          const data = await fetch(
            new URL(`api/get/user/${userId}/omikron`, omegaBaseUrl),
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
          ...nativeOptions,
          url,
          ...("keyring" in identity
            ? {
                credentials: {
                  clientId: userId,
                  keyring: base64ToBytes(identity.keyring),
                },
              }
            : {}),
          hostPublicKey:
            typeof omikronPublicKey === "string"
              ? { value: omikronPublicKey, encoding: "base64" }
              : Uint8Array.from(omikronPublicKey),
          ...(isTauri() ? { nativeName: "mtp:credentials" } : {}),
          descriptor: nativeOptions.descriptor ?? "client",
          pings: nativeOptions.pings ?? true,
          securityProfile: { protectedSignatureSuite: "dual" },
          logger: (event) => logMTP(event, ["Ping", "Pong", "Relay"]),
          onStateChange: (state) => {
            if (
              generation !== connectionGeneration ||
              credentialRevision !== credentialRevisionRef.current
            )
              return;
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
        if (
          disposed ||
          generation !== connectionGeneration ||
          credentialRevision !== credentialRevisionRef.current
        ) {
          client.disconnect();
          return;
        }
        const activeClient = client;
        clientRef.current = activeClient;
        setContextClient(activeClient);
        callControlRequestRef.current =
          "keyring" in identity
            ? async (ownerOmikronId, type, data, options) => {
                if (
                  ownerOmikronId == null ||
                  ownerOmikronId === primaryOmikronId
                ) {
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
                      keyring: base64ToBytes(identity.keyring),
                    },
                    hostPublicKey: {
                      value: owner.public_key,
                      encoding: "base64",
                    },
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
              }
            : null;
        detachSubscriptions = isTauri()
          ? () => {}
          : attachSubscriptions(activeClient);
        const detachRelays = isTauri()
          ? () => {}
          : subscribeCommittedRelays(
              activeClient,
              async () => {
                const state = clientStateRef.current;
                if (!state?.Scope || clientRef.current !== activeClient)
                  throw new Error("Account identity unavailable");
                return state;
              },
              () => {
                if (getAppFocused())
                  void refreshAccountState().catch((error) =>
                    log(1, "mtp", "red", "Relay catch-up failed", error),
                  );
              },
            );
        const detachAuthenticated = detachSubscriptions;
        detachSubscriptions = () => {
          detachRelays();
          detachAuthenticated();
        };
        const unsubscribeForeground = isTauri()
          ? () => {}
          : activeClient.subscribe("SessionActivitySet", (message) => {
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
            });
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
        await withDeadline(
          isTauri()
            ? activeClient.connect()
            : activeClient.auth().then(() => {}),
          INITIAL_SYNC_TIMEOUT,
          "MTP authentication timed out",
          attemptAbort.signal,
        );
        if (
          disposed ||
          clientRef.current !== activeClient ||
          credentialRevision !== credentialRevisionRef.current
        )
          return;
        connectionReady = true;
        if (isTauri()) setNativeViewReady(true);
        setReadyState(activeClient.state);
        authenticatedClientRef.current = activeClient;
        setIdentifying(false);
        setIdentified(true);
        setSessionEstablished(true);
        clearReconnectTimer();
        attempts = 0;
        setConnectionStatus(null);
        resolveConnectionRef.current?.();
      } catch (connectError) {
        if (
          disposed ||
          generation !== connectionGeneration ||
          credentialRevision !== credentialRevisionRef.current
        ) {
          client?.disconnect();
          return;
        }
        failed = true;
        cleanup();
        log(0, "mtp", "red", "Connection/authentication attempt failed");
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
  }, [
    attachSubscriptions,
    credentials,
    mtpUrl,
    props.blockConnection,
    publishState,
    refreshAccountState,
    subscribe,
  ]);

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

  useEffect(() => {
    const binding = bindingRef.current;
    if (
      !visible ||
      !binding ||
      clientStateRef.current ||
      authenticatedClientRef.current
    )
      return;
    const controller = new AbortController();
    void loadOfflineAccountState(binding, controller.signal)
      .then((cached) => {
        if (
          !controller.signal.aborted &&
          getAppFocused() &&
          bindingRef.current === binding &&
          !clientStateRef.current &&
          cached
        )
          publishState(cached);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          forceSnapshotRef.current = true;
          log(1, "mtp", "yellow", "Saved account state unavailable", error);
        }
      });
    return () => controller.abort();
  }, [contextClient, credentials, identified, publishState, visible]);

  const loadingDescription = useMemo(() => {
    if (!mtpUrl) return "Finding an Omikron...";
    if (readyState === ConnectionState.Connecting || !connected) {
      return "Connecting to Omikron...";
    }
    if (identifying || !identified) return "Authenticating...";
    return "Loading...";
  }, [connected, identified, identifying, readyState, mtpUrl]);
  useEffect(() => {
    if (
      !isTauri() ||
      !contextClient ||
      !identified ||
      (!visible && !callActive)
    )
      return;
    let disposed = false;
    let stop: (() => void) | undefined;
    const replay = async () => {
      const status = await invoke<{ identified: boolean; generation: number }>(
        "mtp_status",
      );
      if (!status.identified || disposed) return;
      const frames = await invoke<number[][]>("mtp_pending_calls");
      const protocol = new MTPProtocol({
        schemas: mtpSchemas,
        throwProtocolErrors: true,
      });
      for (const bytes of frames) {
        if (
          disposed ||
          authenticatedClientRef.current !== contextClient ||
          nativeGenerationRef.current !== status.generation
        )
          return;
        const invitation = await protocol.parseResponse(
          "CallInvite",
          decode(Uint8Array.from(bytes)),
        );
        if (
          invitation.type !== "CallInvite" ||
          !invitation.data.CallId ||
          !invitation.data.OmikronId
        )
          continue;
        try {
          const current = await sendToCallOwner(
            invitation.data.OmikronId,
            "CallData",
            { CallId: invitation.data.CallId },
          );
          if (
            !disposed &&
            current.type === "CallData" &&
            authenticatedClientRef.current === contextClient &&
            nativeGenerationRef.current === status.generation
          )
            publish(invitation);
        } catch (error) {
          log(
            1,
            "call",
            "yellow",
            "Saved invitation is no longer available",
            error,
          );
        }
      }
    };
    const wake = () => {
      void replay().catch((error) =>
        log(1, "call", "red", "Native call handoff failed", error),
      );
    };
    void listen<{ kind: string; snapshot?: { identified: boolean } }>(
      "tensamin://mtp",
      ({ payload }) => {
        if (payload.kind === "state" && payload.snapshot?.identified) wake();
      },
    ).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    wake();
    return () => {
      disposed = true;
      stop?.();
    };
  }, [
    callActive,
    contextClient,
    identified,
    publish,
    sendToCallOwner,
    visible,
  ]);
  const contextReady =
    connected &&
    identified &&
    mtpUrl !== null &&
    (!isTauri() || nativeViewReady);
  const sendWithInterceptors: BoundSendFn = useMemo(
    () => async (type, data, options) => {
      const response = await send(type, data, options);
      for (const interceptor of interceptorsRef.current) {
        void Promise.resolve(interceptor({ type, data, response })).catch(
          (error) => {
            log(1, "mtp", "yellow", "MTP interceptor failed", error, { type });
          },
        );
      }
      return response;
    },
    [interceptorsRef, send],
  );

  return (
    <MTPContext.Provider
      value={{
        send: sendWithInterceptors,
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
        refreshAccountState,
        readCachedMessages,
        contextReady,
        sessionEstablished,
        loadingDescription,
        connectionStatus,
        retryConnection: () => retryConnectionRef.current(),
        setCallActive,
        dismissCallInvite,
        isCallInviteHandled,
      }}
    >
      {props.children}
    </MTPContext.Provider>
  );
}

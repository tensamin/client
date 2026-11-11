import { toast as sonnerToast } from "@nonanium/ui";
import { isTauri } from "@tauri-apps/api/core";
import { log, logMTP } from "@tensamin/shared/log";
import { base64ToBytes, ConnectionState } from "mtp";
import { useEffect } from "react";
import { accountCacheBinding, type AccountState } from "../accountSync";

import {
  INITIAL_SYNC_TIMEOUT,
  RECONNECT_JITTER,
  RECONNECT_TRIES,
  RETRY_INTERVAL,
} from "../values";

import { loadConnectionCache } from "./accountState";
import { createBrowserClient, type BrowserMtpClient } from "./client";
import { withDeadline } from "./deadline";
import type { RendererState } from "./state";
import { attachBrowserMessages } from "./attachBrowserMessages";
import { createCallOwnerRequest } from "./callOwner";
import { resolveEndpoint } from "./endpoints";
import { CONNECTION_TOAST_ID } from "./useConnectionFeedback";

export function useRendererConnection(
  state: Pick<
    RendererState,
    | "credentials"
    | "credentialRevisionRef"
    | "setConnectionStatus"
    | "sessionAbortRef"
    | "callControlRequestRef"
    | "clientRef"
    | "authenticatedClientRef"
    | "setContextClient"
    | "setReadyState"
    | "setIdentified"
    | "setIdentifying"
    | "bindingRef"
    | "forceSnapshotRef"
    | "clientStateRef"
    | "publishState"
    | "nativeGenerationRef"
    | "subscribe"
    | "setNativeViewReady"
    | "setSessionEstablished"
    | "resolveConnectionRef"
    | "retryConnectionRef"
    | "attachSubscriptions"
  >,
  refreshAccountState: () => Promise<AccountState>,
  blockConnection?: boolean,
) {
  const {
    credentials,
    credentialRevisionRef,
    setConnectionStatus,
    sessionAbortRef,
    callControlRequestRef,
    clientRef,
    authenticatedClientRef,
    setContextClient,
    setReadyState,
    setIdentified,
    setIdentifying,
    bindingRef,
    forceSnapshotRef,
    clientStateRef,
    publishState,
    nativeGenerationRef,
    subscribe,
    setNativeViewReady,
    setSessionEstablished,
    resolveConnectionRef,
    retryConnectionRef,
    attachSubscriptions,
  } = state;
  const mtpUrl = credentials?.omegaUrl ?? null;
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
      const description =
        error instanceof Error ? error.message : String(error);

      if (!shortRetry) {
        log(0, "mtp", "red", "Reconnection attempts exhausted", error);
        setConnectionStatus({
          kind: "failed",
          description,
        });

        return;
      }

      setConnectionStatus({
        kind: "reconnecting",
        attempt: attempts,
        description,
      });
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
      if (disposed || blockConnection) return;
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
        const { cached, forceSnapshot } = await loadConnectionCache(
          binding,
          attemptAbort.signal,
        );
        if (
          disposed ||
          generation !== connectionGeneration ||
          credentialRevision !== credentialRevisionRef.current
        )
          return;
        forceSnapshotRef.current ||= forceSnapshot;

        if (cached && !clientStateRef.current) publishState(cached);
        const { url, omikronPublicKey, nativeOptions, primaryOmikronId } =
          await resolveEndpoint(
            credentials!,
            attemptAbort.signal,
            nativeGenerationRef,
          );
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
        callControlRequestRef.current = createCallOwnerRequest(
          activeClient,
          identity,
          userId,
          primaryOmikronId,
          ownerClients,
          omegaBaseUrl,
          attemptAbort.signal,
        );
        detachSubscriptions = attachBrowserMessages(
          { attachSubscriptions, clientStateRef, clientRef },
          activeClient,
          refreshAccountState,
        );
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
    blockConnection,
    publishState,
    refreshAccountState,
    subscribe,
    credentialRevisionRef,
    retryConnectionRef,
    setConnectionStatus,
    sessionAbortRef,
    callControlRequestRef,
    clientRef,
    authenticatedClientRef,
    setContextClient,
    setReadyState,
    setIdentified,
    setIdentifying,
    bindingRef,
    forceSnapshotRef,
    clientStateRef,
    nativeGenerationRef,
    setNativeViewReady,
    setSessionEstablished,
    resolveConnectionRef,
  ]);
}

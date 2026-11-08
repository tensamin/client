import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ConnectionState, MTPClient } from "mtp";
import { LoadingScreen } from "@nonanium/ui";
import { mtp as mtpSchemas, type Contacts } from "@tensamin/shared/data";
import { log, toast } from "@tensamin/shared/log";
import { getAppFocused, subscribeAppFocus } from "@tensamin/shared/focus";
import {
  loadAccountRuntime,
  projectNativeAccountState,
  type AccountState,
} from "./accountSync";
import { createNativeCallControl } from "./nativeCallControl";
import { useRelayOutbox } from "./useRelayOutbox";
import { createNativeRelayClient } from "./nativeRelay";

import {
  type BoundSendFn,
  type MTPContextType,
  MTPContext,
  useMessageHandlers,
  useAccountRefresh,
} from "./mtpContext";

type NativeSnapshot = {
  generation: number;
  readyState: number;
  identified: boolean;
  state?: unknown;
  error?: string;
};

export function TauriProvider(props: {
  children: ReactNode;
  blockConnection?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<NativeSnapshot>({
    generation: 0,
    readyState: ConnectionState.Disconnected,
    identified: false,
  });
  const [freshContacts, setFreshContacts] = useState<Contacts>([]);
  const [clientState, setClientState] = useState<AccountState | null>(null);
  const clientStateRef = useRef<AccountState | null>(null);
  const generationRef = useRef(0);
  const snapshotRevisionRef = useRef(0);
  const authenticatedRef = useRef(false);
  const invalidateSnapshot = useCallback(() => {
    authenticatedRef.current = false;
    return ++snapshotRevisionRef.current;
  }, []);
  const { addInterceptor, attachSubscriptions, interceptorsRef, subscribe } =
    useMessageHandlers();
  const [attachment, setAttachment] = useState<{
    client: MTPClient<typeof mtpSchemas>;
    generation: number;
  } | null>(null);
  const connection = attachment?.client ?? null;
  const attachedConnectionRef = useRef<typeof attachment>(null);
  const hasInitialState = clientState !== null;
  const refreshSnapshot = useCallback(async () => {
    if (!authenticatedRef.current) {
      throw new Error("Native session is not authenticated");
    }
    const revision = snapshotRevisionRef.current;
    const attached = attachedConnectionRef.current;
    if (!attached) throw new Error("Native SDK is not attached");
    const state = await loadAccountRuntime(
      projectNativeAccountState(await invoke("mtp_refresh_state")),
      attached.client,
    );
    if (
      revision !== snapshotRevisionRef.current ||
      !authenticatedRef.current ||
      attachedConnectionRef.current !== attached
    ) {
      throw new Error("Native session changed during account refresh");
    }
    clientStateRef.current = state;
    setClientState(state);
    setFreshContacts(state.Contacts);
    return state;
  }, []);
  const refreshAccountState = useAccountRefresh(
    refreshSnapshot,
    subscribe,
    !props.blockConnection &&
      connection !== null &&
      snapshot.identified &&
      snapshot.readyState === ConnectionState.Connected,
    addInterceptor,
  );
  useEffect(() => {
    if (props.blockConnection || !hasInitialState) return;
    let disposed = false;
    const generation = snapshot.generation;
    let client: MTPClient<typeof mtpSchemas> | undefined;
    void (async () => {
      const options = await invoke<{
        url: string;
        descriptor: string;
        hostPublicKey: number[];
      }>("mtp_frontend_options");
      if (disposed || generationRef.current !== generation) return;
      client = await MTPClient.create({
        ...options,
        hostPublicKey: Uint8Array.from(options.hostPublicKey),
        nativeName: "mtp:credentials",
        schemas: mtpSchemas,
        throwProtocolErrors: true,
      });
      if (disposed || generationRef.current !== generation) {
        client.disconnect();
        return;
      }
      await client.connect();
      if (disposed || generationRef.current !== generation) client.disconnect();
      else {
        const attached = { client, generation };
        attachedConnectionRef.current = attached;
        setAttachment(attached);
      }
    })().catch((error) =>
      log(0, "mtp", "red", "Native SDK attachment failed", error),
    );
    return () => {
      disposed = true;
      attachedConnectionRef.current = null;
      client?.disconnect();
      setAttachment(null);
    };
  }, [props.blockConnection, hasInitialState, snapshot.generation]);

  // The native backend loads an AccountStateSnapshot after every login.
  const applySnapshot = useCallback(async (next: NativeSnapshot) => {
    if (next.generation < generationRef.current) return;
    const previousGeneration = generationRef.current;
    generationRef.current = next.generation;
    const revision = ++snapshotRevisionRef.current;
    if (next.error) {
      log(0, "android", "orange", "MTP connection failed", next.error);
      toast("error", "Messaging connection failed", next.error);
    }
    if (next.state === undefined || next.state === null) {
      authenticatedRef.current = false;
      clientStateRef.current = null;
      setClientState(null);
      setFreshContacts([]);
      setSnapshot(
        next.identified
          ? {
              ...next,
              identified: false,
              error: "Native MTP connection omitted initial state",
            }
          : next,
      );
      return;
    }
    try {
      let state: AccountState = projectNativeAccountState(next.state);
      const previous = clientStateRef.current;
      const sameSession =
        previousGeneration === next.generation &&
        authenticatedRef.current &&
        next.identified &&
        next.readyState === ConnectionState.Connected &&
        previous !== null &&
        JSON.stringify(previous.Scope) === JSON.stringify(state.Scope);
      if (!sameSession) {
        authenticatedRef.current = false;
        setSnapshot({ ...next, identified: false });
      }
      await MTPClient.init();
      if (revision !== snapshotRevisionRef.current) return;
      if (sameSession) {
        state = {
          ...state,
          Calls: previous.Calls,
          Communities: previous.Communities,
          callsAndCommunitiesLoaded: previous.callsAndCommunitiesLoaded,
          presenceSnapshot: previous.presenceSnapshot,
        };
      }
      clientStateRef.current = state;
      setFreshContacts(state.Contacts);
      setClientState(state);
      authenticatedRef.current =
        next.identified && next.readyState === ConnectionState.Connected;
      setSnapshot(next);
    } catch (error) {
      if (revision !== snapshotRevisionRef.current) return;
      authenticatedRef.current = false;
      log(0, "mtp", "red", "Invalid native MTP state", error);
      setSnapshot({
        ...next,
        identified: false,
        error: "Invalid AccountStateSnapshot payload",
      });
    }
  }, []);

  useEffect(() => {
    if (!connection) return;
    return attachSubscriptions(connection);
  }, [attachSubscriptions, connection]);

  useEffect(() => {
    if (props.blockConnection) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void (async () => {
      try {
        const nextUnlisten = await listen<
          | { kind: "state"; snapshot: NativeSnapshot }
          | { kind: "log"; level: number; message: string; details?: unknown }
        >("tensamin://mtp", ({ payload }) => {
          if (disposed) return;
          if (payload.kind === "state") {
            void applySnapshot(payload.snapshot);
          } else {
            log(
              payload.level,
              "android",
              "orange",
              payload.message,
              payload.details,
            );
          }
        });
        if (disposed) nextUnlisten();
        else unlisten = nextUnlisten;
      } catch (error) {
        log(0, "mtp", "red", "Failed to subscribe to native MTP events", error);
      }
      try {
        const current = await invoke<NativeSnapshot>("mtp_status");
        if (!disposed) await applySnapshot(current);
      } catch (error) {
        log(0, "mtp", "red", "Failed to load native MTP status", error);
      }
    })();
    return () => {
      disposed = true;
      invalidateSnapshot();
      unlisten?.();
    };
  }, [applySnapshot, invalidateSnapshot, props.blockConnection]);

  useEffect(() => {
    if (props.blockConnection) return;
    void invoke<boolean>("mtp_restore_credentials")
      .then(async (restored) => {
        if (restored) {
          await invoke("plugin:mtp|mtp_set_background_enabled", {
            enabled: true,
          });
          await invoke("plugin:mtp|mtp_connect", {
            name: "mtp:credentials",
            mode: "connect",
          });
        }
      })
      .catch((error) => {
        log(0, "mtp", "red", "Failed to start native MTP service", error);
      });
  }, [props.blockConnection]);

  useEffect(() => {
    if (props.blockConnection) return;
    const updateVisibility = () => {
      void invoke("mtp_set_ui_visible", {
        visible: getAppFocused(),
      });
    };
    updateVisibility();
    const unsubscribe = subscribeAppFocus(updateVisibility);
    return () => {
      unsubscribe();
      void invoke("mtp_set_ui_visible", { visible: false });
    };
  }, [props.blockConnection]);

  const send = useCallback<BoundSendFn>(
    async (type, data, options) => {
      if (!authenticatedRef.current) {
        throw new Error("Native session is not authenticated");
      }
      if (!connection) throw new Error("Native SDK is not attached");
      const generation = generationRef.current;
      if (
        attachedConnectionRef.current?.client !== connection ||
        attachedConnectionRef.current.generation !== generation
      ) {
        throw new Error("Native SDK belongs to a replaced session");
      }
      const response = await connection.request(type, data, options);
      if (
        !authenticatedRef.current ||
        generationRef.current !== generation ||
        attachedConnectionRef.current?.client !== connection
      ) {
        throw new Error("Native session changed during request");
      }
      for (const interceptor of interceptorsRef.current) {
        void Promise.resolve(interceptor({ type, data, response })).catch(
          (error) => {
            log(1, "mtp", "yellow", "MTP interceptor failed", error, { type });
          },
        );
      }
      return response;
    },
    [connection, interceptorsRef],
  );
  const sendCallControl = useCallback<MTPContextType["sendCallControl"]>(
    (...args) =>
      createNativeCallControl({
        send,
        session: () => ({
          authenticated: authenticatedRef.current,
          generation: generationRef.current,
          client: attachedConnectionRef.current?.client ?? null,
        }),
      })(...args),
    [send],
  );
  const connected = snapshot.readyState === ConnectionState.Connected;
  const sessionEstablished =
    !props.blockConnection &&
    connected &&
    snapshot.identified &&
    hasInitialState &&
    connection !== null &&
    attachment?.generation === snapshot.generation;

  const isRelaySessionCurrent = useCallback(
    () =>
      connection !== null &&
      authenticatedRef.current &&
      attachedConnectionRef.current?.client === connection &&
      attachedConnectionRef.current.generation === generationRef.current,
    [connection],
  );
  const relayTransport = useCallback(() => {
    if (!connection)
      throw new Error("Native relay session is not authenticated");
    return createNativeRelayClient({
      session: () => ({
        authenticated: authenticatedRef.current,
        generation: generationRef.current,
        client: attachedConnectionRef.current?.client ?? null,
      }),
    });
  }, [connection]);
  const sendSealedRelay = useRelayOutbox({
    transport: relayTransport,
    scope: clientState?.Scope,
    ready: sessionEstablished,
    isCurrent: isRelaySessionCurrent,
  });

  return (
    <MTPContext.Provider
      value={{
        send,
        sendCallControl,
        sendSealedRelay,
        subscribe,
        addInterceptor,
        client: connection,
        readyState: snapshot.readyState,
        identified: snapshot.identified,
        freshContacts,
        updateContacts: setFreshContacts,
        freshCommunities: clientState?.Communities ?? [],
        freshCalls: clientState?.Calls ?? [],
        clientState,
        refreshAccountState,
        contextReady:
          sessionEstablished && clientState?.callsAndCommunitiesLoaded === true,
        sessionEstablished,
        connectionStatus: null,
        retryConnection: () => location.reload(),
        loadingDescription: connected
          ? "Waiting for authenticated session"
          : "Establishing native transport channel",
      }}
    >
      {props.blockConnection || connection || clientState ? (
        props.children
      ) : (
        <LoadingScreen title="Attaching native messaging" progress={8} />
      )}
    </MTPContext.Provider>
  );
}

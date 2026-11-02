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
import {
  mtp as mtpSchemas,
  type Calls,
  type Communities,
  type Contacts,
} from "@tensamin/shared/data";
import { log, toast } from "@tensamin/shared/log";
import { getAppFocused, subscribeAppFocus } from "@tensamin/shared/focus";
import { projectNativeAccountState, type AccountState } from "./accountSync";

import {
  type BoundSendFn,
  MTPContext,
  type SealedRelayResult,
  type SealedRelaySend,
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
  const [freshCommunities, setFreshCommunities] = useState<Communities>([]);
  const [freshCalls, setFreshCalls] = useState<Calls>([]);
  const [clientState, setClientState] = useState<AccountState | null>(null);
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
    const state = projectNativeAccountState(await invoke("mtp_refresh_state"));
    if (revision !== snapshotRevisionRef.current || !authenticatedRef.current) {
      throw new Error("Native session changed during account refresh");
    }
    setClientState(state);
    setFreshContacts(state.Contacts);
    setFreshCommunities(state.Communities);
    setFreshCalls(state.Calls);
    return state;
  }, []);
  const refreshAccountState = useAccountRefresh(
    refreshSnapshot,
    subscribe,
    !props.blockConnection &&
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
  const applySnapshot = useCallback(
    async (next: NativeSnapshot) => {
      if (next.generation < generationRef.current) return;
      generationRef.current = next.generation;
      const revision = invalidateSnapshot();
      setSnapshot({ ...next, identified: false });
      if (next.error) {
        log(0, "android", "orange", "MTP connection failed", next.error);
        toast("error", "Messaging connection failed", next.error);
      }
      if (next.state === undefined || next.state === null) {
        setClientState(null);
        setFreshContacts([]);
        setFreshCommunities([]);
        setFreshCalls([]);
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
        await MTPClient.init();
        if (revision !== snapshotRevisionRef.current) return;
        const state = projectNativeAccountState(next.state);
        setFreshContacts(state.Contacts);
        setFreshCommunities(state.Communities);
        setFreshCalls(state.Calls);
        setClientState(state);
        authenticatedRef.current =
          next.identified && next.readyState === ConnectionState.Connected;
        setSnapshot(next);
      } catch (error) {
        if (revision !== snapshotRevisionRef.current) return;
        log(0, "mtp", "red", "Invalid native MTP state", error);
        setSnapshot({
          ...next,
          identified: false,
          error: "Invalid AccountStateSnapshot payload",
        });
      }
    },
    [invalidateSnapshot],
  );

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
  const sendSealedRelay = useCallback<SealedRelaySend>(
    async (type, data, options) => {
      if (!authenticatedRef.current) {
        throw new Error("Native session is not authenticated");
      }
      const generation = generationRef.current;
      const response = await invoke<SealedRelayResult>(
        "mtp_send_sealed_relay",
        {
          generation,
          request: {
            typeName: type,
            data: JSON.parse(
              JSON.stringify(data, (_key, value) =>
                value instanceof Uint8Array ? Array.from(value) : value,
              ),
            ),
            nextHop: options.nextHop,
            finalRecipientId: options.finalRecipientId,
            metadataRecipients: options.metadataRecipients,
            contentRecipients: options.contentRecipients,
            metadata:
              options.metadata instanceof Uint8Array
                ? Array.from(options.metadata)
                : options.metadata,
          },
        },
      );
      if (!authenticatedRef.current || generationRef.current !== generation) {
        throw new Error("Native session changed during sealed relay request");
      }
      return response;
    },
    [],
  );
  const connected = snapshot.readyState === ConnectionState.Connected;
  const sessionEstablished =
    !props.blockConnection &&
    connected &&
    snapshot.identified &&
    hasInitialState &&
    connection !== null &&
    attachment?.generation === snapshot.generation;

  return (
    <MTPContext.Provider
      value={{
        send,
        sendCallControl: (_ownerOmikronId, ...args) => send(...args),
        sendSealedRelay,
        subscribe,
        addInterceptor,
        client: connection,
        readyState: snapshot.readyState,
        identified: snapshot.identified,
        freshContacts,
        updateContacts: setFreshContacts,
        freshCommunities,
        freshCalls,
        clientState,
        refreshAccountState,
        contextReady: sessionEstablished,
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

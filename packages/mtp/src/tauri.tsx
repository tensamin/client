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
import { projectNativeAccountState } from "./accountSync";

import {
  type BoundSendFn,
  MTPContext,
  type ProtocolMessage,
  removeMissingContacts,
  updateContactNotifications,
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
  const [clientState, setClientState] = useState<
    ProtocolMessage<"AccountStateSnapshot">["data"] | null
  >(null);
  const generationRef = useRef(0);
  const { addInterceptor, attachSubscriptions, interceptorsRef, subscribe } =
    useMessageHandlers();
  const [connection, setConnection] = useState<MTPClient<
    typeof mtpSchemas
  > | null>(null);
  const hasInitialState = clientState !== null;
  const refreshSnapshot = useCallback(async () => {
    const state = projectNativeAccountState(await invoke("mtp_refresh_state"));
    setClientState(state);
    setFreshContacts(state.Contacts);
    return state;
  }, []);
  const refreshAccountState = useAccountRefresh(refreshSnapshot, subscribe);
  useEffect(() => {
    if (props.blockConnection || !hasInitialState) return;
    let disposed = false;
    let client: MTPClient<typeof mtpSchemas> | undefined;
    void (async () => {
      const options = await invoke<{
        url: string;
        descriptor: string;
        hostPublicKey: number[];
      }>("mtp_frontend_options");
      client = await MTPClient.create({
        ...options,
        hostPublicKey: Uint8Array.from(options.hostPublicKey),
        nativeName: "mtp:credentials",
        schemas: mtpSchemas,
        throwProtocolErrors: true,
      });
      if (disposed) {
        client.disconnect();
        return;
      }
      await client.connect();
      if (disposed) client.disconnect();
      else setConnection(client);
    })().catch((error) =>
      log(0, "mtp", "red", "Native SDK attachment failed", error),
    );
    return () => {
      disposed = true;
      client?.disconnect();
      setConnection(null);
    };
  }, [props.blockConnection, hasInitialState]);

  // The native backend loads an AccountStateSnapshot after every login.
  const applySnapshot = useCallback(async (next: NativeSnapshot) => {
    if (next.generation < generationRef.current) return;
    generationRef.current = next.generation;
    if (next.error) {
      log(0, "android", "orange", "MTP connection failed", next.error);
      toast("error", "Messaging connection failed", next.error);
    }
    if (!next.identified) {
      setSnapshot(next);
      return;
    }
    if (next.state === undefined) {
      setSnapshot({
        ...next,
        identified: false,
        error: "Native MTP connection omitted initial state",
      });
      return;
    }
    try {
      await MTPClient.init();
      const state = projectNativeAccountState(next.state);
      setFreshContacts(state.Contacts);
      setFreshCommunities(state.Communities);
      setFreshCalls(state.Calls);
      setClientState(state);
      setSnapshot(next);
    } catch (error) {
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
    if (clientState?.PresenceSnapshotComplete) {
      setFreshContacts((contacts) =>
        removeMissingContacts(contacts, clientState.MissingUserIds),
      );
    }
  }, [clientState]);

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
      unlisten?.();
    };
  }, [applySnapshot, props.blockConnection]);

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
      if (!connection) throw new Error("Native SDK is not attached");
      const response = await connection.request(type, data, options);
      if (response.type === "GetStates") {
        setFreshContacts((contacts) =>
          removeMissingContacts(
            contacts,
            (response as ProtocolMessage<"GetStates">).data.MissingUserIds ??
              [],
          ),
        );
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
      return invoke<SealedRelayResult>("mtp_send_sealed_relay", {
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
      });
    },
    [],
  );
  const connected = snapshot.readyState === ConnectionState.Connected;

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
        contextReady: hasInitialState && connection !== null,
        sessionEstablished: hasInitialState && connection !== null,
        connectionStatus: null,
        retryConnection: () => location.reload(),
        loadingDescription: connected
          ? "Waiting for authenticated session"
          : "Establishing native transport channel",
      }}
    >
      {props.blockConnection || connection ? (
        props.children
      ) : (
        <LoadingScreen title="Attaching native messaging" progress={8} />
      )}
    </MTPContext.Provider>
  );
}

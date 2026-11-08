import { createContext, useCallback, useEffect, useRef } from "react";
import type { MTPClient } from "mtp";
import type {
  MTPDataValueInput,
  MTPEncodedBytesInput,
  MTPRequestFunction,
  MTPResponseFrame,
  MTPSubscriptionFunction,
} from "mtp";
import {
  mtp as mtpSchemas,
  type Calls,
  type Communities,
  type Contacts,
} from "@tensamin/shared/data";
import { log } from "@tensamin/shared/log";
import { getAppFocused, subscribeAppFocus } from "@tensamin/shared/focus";
import type { AccountState } from "./accountSync";
import { PresenceMailbox } from "./presence";

export type ProtocolMessage<
  Type extends keyof typeof mtpSchemas & string = keyof typeof mtpSchemas &
    string,
> = MTPResponseFrame<typeof mtpSchemas, Type>;

export type BoundSendFn = MTPRequestFunction<typeof mtpSchemas>;

export type RelayTarget =
  { kind: "user"; id: number } | { kind: "iota"; id: number };

export type SealedRelayOptions = {
  nextHop: RelayTarget;
  finalRecipientId: number;
  metadataRecipients: MTPEncodedBytesInput[];
  contentRecipients: MTPEncodedBytesInput[];
  metadata?: MTPDataValueInput;
};

export type SealedRelayResult = {
  type: string;
  data: Record<string, unknown>;
};

export type SealedRelaySend = (
  type: string,
  data: MTPDataValueInput,
  options: SealedRelayOptions,
) => Promise<SealedRelayResult>;

export type MTPConnectionStatus =
  | { kind: "reconnecting"; attempt: number }
  | { kind: "failed"; description: string };

export type MTPExchange = {
  type: keyof typeof mtpSchemas & string;
  data: unknown;
  response: ProtocolMessage;
};

export type MTPInterceptor = (exchange: MTPExchange) => void | Promise<void>;

export type MTPContextType = {
  refreshAccountState: () => Promise<AccountState>;
  readCachedMessages: (
    principal: string,
  ) => Promise<AccountState["Messages"] | null>;
  send: BoundSendFn;
  sendCallControl: (
    ownerOmikronId: number | undefined,
    ...args: Parameters<BoundSendFn>
  ) => ReturnType<BoundSendFn>;
  sendSealedRelay: SealedRelaySend;
  subscribe: MTPSubscriptionFunction<typeof mtpSchemas>;
  addInterceptor: (interceptor: MTPInterceptor) => () => void;
  /**
   * Raw WASM client behind the authenticated "client" connection. Null on
   * transports without an in-page client (native Tauri bridge). Needed by
   * flows that must use capabilities the context does not wrap, such as
   * protected password-management RPCs.
   */
  client: MTPClient | null;
  readyState: number;
  identified: boolean;
  freshContacts: Contacts;
  updateContacts: (update: (contacts: Contacts) => Contacts) => void;
  freshCommunities: Communities;
  freshCalls: Calls;
  clientState: AccountState | null;
  contextReady: boolean;
  sessionEstablished: boolean;
  loadingDescription: string;
  connectionStatus: MTPConnectionStatus | null;
  retryConnection(): void;
};

export const MTPContext = createContext<MTPContextType | undefined>(undefined);

export function useAccountRefresh(
  operation: MTPContextType["refreshAccountState"],
  subscribe: MTPContextType["subscribe"],
  enabled: boolean,
  addInterceptor: MTPContextType["addInterceptor"],
) {
  const pending = useRef<
    | {
        operation: typeof operation;
        promise: ReturnType<typeof operation>;
        again: boolean;
      }
    | undefined
  >(undefined);
  const refresh = useCallback(() => {
    if (pending.current?.operation === operation) {
      pending.current.again = true;
      return pending.current.promise;
    }
    const run = async () => {
      let state = await operation();
      while (
        pending.current?.operation === operation &&
        pending.current.again
      ) {
        pending.current.again = false;
        state = await operation();
      }
      return state;
    };
    const promise = run().finally(() => {
      if (pending.current?.promise === promise) pending.current = undefined;
    });
    pending.current = { operation, promise, again: false };
    return promise;
  }, [operation]);
  useEffect(() => {
    if (!enabled) return;
    const wake = () => {
      void refresh().catch((error) =>
        log(1, "mtp", "red", "Account refresh failed", error),
      );
    };
    const wakeTypes = [
      "ChatSecretForward",
      "MessageLive",
      "MessageEditLive",
      "MessageDeleteLive",
      "MessageReactionLive",
      "MessageState",
      "PushNotification",
      "UserBlobChanged",
      "UserAssetChanged",
      "SyncedSettingChanged",
      "BlockedUsersChanged",
      "ReceiptPolicyChanged",
      "MessageStoragePolicyChanged",
      "CallInvite",
      "CallEnded",
    ] as const;
    const unsubscribers = wakeTypes.map((type) => subscribe(type, wake));
    const mutations = new Set([
      "ReadNotification",
      "UserBlobPut",
      "UserBlobDelete",
      "UserBlock",
      "UserUnblock",
      "ReceiptPolicySet",
      "MessageStoragePolicySet",
      "SyncedSettingSet",
      "SyncedSettingDelete",
      "UserAssetUploadCommit",
      "UserAssetDelete",
      "CallActivate",
      "CallInvite",
      "CallToken",
      "CallDisconnectUser",
      "CallTimeoutUser",
      "EndCall",
    ]);
    const unintercept = addInterceptor(({ type }) => {
      if (mutations.has(type)) wake();
    });
    const unfocus = subscribeAppFocus(() => {
      if (getAppFocused()) wake();
    });
    wake();
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      unfocus();
      unintercept();
    };
  }, [addInterceptor, enabled, refresh, subscribe]);
  return refresh;
}

export function removeMissingContacts(
  contacts: Contacts,
  missingUserIds: readonly number[],
): Contacts {
  const missing = new Set(missingUserIds);
  return contacts.filter((contact) => !missing.has(contact.UserId));
}

export function updateContactNotifications(
  contacts: Contacts,
  userId: number,
  notifications: number | undefined,
  lastMessageAt: number,
): Contacts {
  const contact = contacts.find((item) => item.UserId === userId);
  const nextNotifications = notifications ?? (contact?.notifications ?? 0) + 1;
  if (!contact) {
    return contacts;
  }

  return [
    {
      ...contact,
      LastMessageAt: lastMessageAt,
      notifications: nextNotifications,
    },
    ...contacts.filter((item) => item.UserId !== userId),
  ];
}

export function useMessageHandlers() {
  const presence = useRef(new PresenceMailbox());
  const interceptorsRef = useRef(new Set<MTPInterceptor>());
  const subscriptionHandlersRef = useRef(
    new Map<string, Set<(message: ProtocolMessage) => void | Promise<void>>>(),
  );
  const transportRef = useRef<{
    subscribe: MTPSubscriptionFunction<typeof mtpSchemas>;
  } | null>(null);
  const transportGenerationRef = useRef(0);
  const transportUnsubscribersRef = useRef(new Map<string, () => void>());

  const attachType = useCallback(
    <Type extends keyof typeof mtpSchemas & string>(type: Type) => {
      const transport = transportRef.current;
      if (!transport || transportUnsubscribersRef.current.has(type)) return;
      const generation = transportGenerationRef.current;
      const unsubscribe = transport.subscribe(type, (message) => {
        if (
          transportRef.current !== transport ||
          transportGenerationRef.current !== generation
        )
          return;
        if (type === "GetStates" || type === "ClientChanged")
          presence.current.remember(type, message.data);
        for (const handler of [
          ...(subscriptionHandlersRef.current.get(type) ?? []),
        ]) {
          void Promise.resolve(handler(message as ProtocolMessage)).catch(
            (error) => {
              log(1, "mtp", "red", "Subscription handler failed", error, {
                type,
              });
            },
          );
        }
      });
      transportUnsubscribersRef.current.set(type, unsubscribe);
    },
    [],
  );

  const attachSubscriptions = useCallback(
    (transport: { subscribe: MTPSubscriptionFunction<typeof mtpSchemas> }) => {
      for (const unsubscribe of transportUnsubscribersRef.current.values()) {
        unsubscribe();
      }
      transportUnsubscribersRef.current.clear();
      presence.current = new PresenceMailbox();
      transportRef.current = transport;
      const generation = ++transportGenerationRef.current;
      attachType("GetStates");
      attachType("ClientChanged");
      for (const type of subscriptionHandlersRef.current.keys()) {
        attachType(type as keyof typeof mtpSchemas & string);
      }
      return () => {
        if (
          transportRef.current !== transport ||
          transportGenerationRef.current !== generation
        )
          return;
        transportRef.current = null;
        presence.current = new PresenceMailbox();
        transportGenerationRef.current += 1;
        for (const unsubscribe of transportUnsubscribersRef.current.values()) {
          unsubscribe();
        }
        transportUnsubscribersRef.current.clear();
      };
    },
    [attachType],
  );

  const subscribe = useCallback<MTPSubscriptionFunction<typeof mtpSchemas>>(
    (type, handler) => {
      const handlers = subscriptionHandlersRef.current.get(type) ?? new Set();
      const untypedHandler = handler as (
        message: ProtocolMessage,
      ) => void | Promise<void>;
      handlers.add(untypedHandler);
      subscriptionHandlersRef.current.set(type, handlers);
      attachType(type);
      if (type === "GetStates" || type === "ClientChanged") {
        for (const message of presence.current.replay(type)) {
          void Promise.resolve(untypedHandler(message)).catch((error) =>
            log(1, "mtp", "red", "Presence replay failed", error),
          );
        }
      }
      return () => {
        handlers.delete(untypedHandler);
        if (handlers.size !== 0) return;
        subscriptionHandlersRef.current.delete(type);
        if (type === "GetStates" || type === "ClientChanged") return;
        transportUnsubscribersRef.current.get(type)?.();
        transportUnsubscribersRef.current.delete(type);
      };
    },
    [attachType],
  );
  const addInterceptor = useCallback((interceptor: MTPInterceptor) => {
    interceptorsRef.current.add(interceptor);
    return () => interceptorsRef.current.delete(interceptor);
  }, []);
  return {
    addInterceptor,
    attachSubscriptions,
    interceptorsRef,
    subscribe,
  };
}

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

export class RelayRejectedError extends Error {
  public readonly responseType: string;

  constructor(responseType: string) {
    super(`Relay rejected with ${responseType}`);
    this.responseType = responseType;
    this.name = "RelayRejectedError";
  }
}

export function requireRelaySuccess(response: SealedRelayResult): void {
  if (response.type !== "Success") {
    throw new RelayRejectedError(response.type);
  }
}

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
  refreshAccountState: () => Promise<
    ProtocolMessage<"AccountStateSnapshot">["data"]
  >;
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
  clientState: ProtocolMessage<"AccountStateSnapshot">["data"] | null;
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
  useEffect(
    () =>
      subscribe("ChatSecretForward", () => {
        void refresh().catch((error) =>
          log(1, "mtp", "red", "Account refresh failed", error),
        );
      }),
    [refresh, subscribe],
  );
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
    return [
      {
        UserId: userId,
        LastMessageAt: lastMessageAt,
        Messages: [],
        notifications: nextNotifications,
      },
      ...contacts,
    ];
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
      transportRef.current = transport;
      const generation = ++transportGenerationRef.current;
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
      return () => {
        handlers.delete(untypedHandler);
        if (handlers.size !== 0) return;
        subscriptionHandlersRef.current.delete(type);
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

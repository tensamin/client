import { useCallback, useEffect, useRef, useState } from "react";
import { createCache, type CachedMessage } from "@tensamin/cache";
import { useMTP, type MTPExchange, type ProtocolMessage } from "@tensamin/mtp";
import { useStorage } from "@tensamin/storage/context";
import { secureValueCodec } from "@tensamin/storage/secure";

const messageStateRank: Record<CachedMessage["MessageState"], number> = {
  awaiting: 0,
  sending: 0,
  sent: 1,
  received: 2,
  read: 3,
};

function isError(message: ProtocolMessage) {
  return message.type.startsWith("Error");
}

export default function CacheSync() {
  const {
    addInterceptor,
    clientState,
    contextReady,
    freshContacts,
    subscribe,
    accountKey,
  } = useMTP();
  const { load } = useStorage();
  const [accountId, setAccountId] = useState(0);
  const queueRef = useRef(Promise.resolve());

  useEffect(() => {
    void load("user_id").then(setAccountId);
  }, [load]);

  const enqueue = useCallback((operation: () => Promise<void>) => {
    const next = queueRef.current.then(operation);
    queueRef.current = next.catch(() => undefined);
    return next;
  }, []);

  const secureCache = useCallback(() => {
    if (!accountKey) throw new Error("Account identity is unavailable");
    return createCache(accountKey, {
      codec: secureValueCodec,
    });
  }, [accountKey]);
  const peerKey = useCallback(
    (handle: number) => {
      const principal = freshContacts.find(
        (contact) => contact.UserId === handle,
      )?.Principal;
      if (!principal)
        throw new Error("Contact canonical identity is unavailable");
      return principal;
    },
    [freshContacts],
  );

  const removeMissingContacts = useCallback(
    async (userIds: number[]) => {
      if (userIds.length === 0) return;
      const cache = secureCache();
      await Promise.all(
        userIds.map((userId) => cache.conversations.delete(peerKey(userId))),
      );
    },
    [peerKey, secureCache],
  );

  const replaceMessage = useCallback(
    async (
      partnerId: number,
      sendTime: number,
      edit: Partial<CachedMessage>,
    ) => {
      const cache = secureCache();
      const window = await cache.conversations.get(peerKey(partnerId));
      if (!window) return;
      await cache.conversations.replace({
        ...window,
        Messages: window.Messages.map((message) =>
          message.SendTime === sendTime &&
          !(
            edit.MessageState !== undefined &&
            messageStateRank[edit.MessageState] <
              messageStateRank[message.MessageState]
          )
            ? { ...message, ...edit }
            : message,
        ),
      });
    },
    [peerKey, secureCache],
  );

  const insertMessage = useCallback(
    async (partnerId: number, message: CachedMessage) => {
      const cache = secureCache();
      const window = await cache.conversations.get(peerKey(partnerId));
      await cache.conversations.replace({
        Principal: peerKey(partnerId),
        UserId: partnerId,
        LastMessageAt: Math.max(window?.LastMessageAt ?? 0, message.SendTime),
        Messages: [
          ...(window?.Messages ?? []).filter(
            (cached) => cached.SendTime !== message.SendTime,
          ),
          message,
        ],
      });
    },
    [peerKey, secureCache],
  );

  const removeMessage = useCallback(
    async (partnerId: number, sendTime: number) => {
      const cache = secureCache();
      const window = await cache.conversations.get(peerKey(partnerId));
      if (!window) return;
      await cache.conversations.replace({
        ...window,
        Messages: window.Messages.filter(
          (message) => message.SendTime !== sendTime,
        ),
      });
    },
    [peerKey, secureCache],
  );

  useEffect(() => {
    if (!accountKey || !accountId || !contextReady || !clientState) return;
    void enqueue(async () => {
      const cache = secureCache();
      await cache.conversations.replaceSelected(
        clientState.Contacts.map((contact) => ({
          UserId: contact.UserId,
          Principal: peerKey(contact.UserId),
          LastMessageAt: contact.LastMessageAt,
          Messages: contact.Messages,
        })),
      );
    });
  }, [
    accountId,
    accountKey,
    clientState,
    contextReady,
    enqueue,
    peerKey,
    secureCache,
  ]);

  useEffect(() => {
    if (!accountKey || !accountId || !contextReady) return;
    void enqueue(() => secureCache().contacts.replace(freshContacts));
  }, [
    accountId,
    accountKey,
    contextReady,
    enqueue,
    freshContacts,
    secureCache,
  ]);

  const synchronizeExchange = useCallback(
    async ({ type, data, response }: MTPExchange) => {
      if (!accountKey || !accountId || isError(response)) return;
      const request = (data ?? {}) as Record<string, unknown>;
      const result = response.data as Record<string, unknown>;

      if (type === "GetStates" && Array.isArray(result.MissingUserIds)) {
        await removeMissingContacts(
          result.MissingUserIds.filter(
            (userId): userId is number => typeof userId === "number",
          ),
        );
        return;
      }

      if (type === "MessagesGet" && Number(request.Offset) === 0) {
        const partnerId = Number(request.UserId);
        const messages = result.Messages as CachedMessage[];
        const cache = secureCache();
        const previous = await cache.conversations.get(peerKey(partnerId));
        const fetchedSendTimes = new Set(
          messages.map((message) => message.SendTime),
        );
        const pendingMessages = (previous?.Messages ?? []).filter(
          (message) =>
            message.SenderId === accountId &&
            !fetchedSendTimes.has(message.SendTime),
        );
        await cache.conversations.replace({
          Principal: peerKey(partnerId),
          UserId: partnerId,
          LastMessageAt: Math.max(
            previous?.LastMessageAt ?? 0,
            ...messages.map((message) => message.SendTime),
          ),
          Messages: [...messages, ...pendingMessages].sort(
            (first, second) => first.SendTime - second.SendTime,
          ),
        });
        return;
      }

      if (type === "MessageSend") {
        const partnerId = Number(request.ReceiverId);
        await insertMessage(partnerId, {
          Content: String(request.Content),
          Files: request.Files as CachedMessage["Files"],
          MessageState: "sent",
          SenderId: accountId,
          SendTime: Number(request.SendTime),
          VersionNumber: Number(request.VersionNumber ?? 1),
          ReplyId: request.ReplyId ? Number(request.ReplyId) : undefined,
        });
        return;
      }

      if (type === "MessageEdit") {
        await replaceMessage(
          Number(request.ChatPartnerId),
          Number(request.SendTime),
          { Content: String(request.Content), Edited: true },
        );
        return;
      }

      if (type === "MessageDelete") {
        await removeMessage(
          Number(request.ChatPartnerId),
          Number(request.SendTime),
        );
        return;
      }

      if (type === "MessageReactionAdd" || type === "MessageReactionRemove") {
        const partnerId = Number(request.ChatPartnerId);
        const sendTime = Number(request.SendTime);
        const reaction = String(request.Reaction);
        const cache = secureCache();
        const window = await cache.conversations.get(peerKey(partnerId));
        const message = window?.Messages.find(
          (candidate) => candidate.SendTime === sendTime,
        );
        if (!message) return;
        const reactions = (message.Reactions ?? []).filter(
          (candidate) =>
            candidate.SenderId !== accountId || candidate.Reaction !== reaction,
        );
        if (type === "MessageReactionAdd") {
          reactions.push({ SenderId: accountId, Reaction: reaction });
        }
        await replaceMessage(partnerId, sendTime, { Reactions: reactions });
        return;
      }

      if (type === "MessageState") {
        await replaceMessage(
          Number(result.ChatPartnerId),
          Number(result.SendTime),
          {
            MessageState: result.MessageState as CachedMessage["MessageState"],
          },
        );
        return;
      }
    },
    [
      accountId,
      accountKey,
      peerKey,
      insertMessage,
      removeMissingContacts,
      removeMessage,
      replaceMessage,
      secureCache,
    ],
  );

  useEffect(() => {
    if (!accountId) return;
    return addInterceptor((exchange) =>
      enqueue(() => synchronizeExchange(exchange)),
    );
  }, [accountId, addInterceptor, enqueue, synchronizeExchange]);

  const synchronizePush = useCallback(
    async (message: ProtocolMessage) => {
      if (!accountKey || !accountId || isError(message)) return;
      const data = message.data as Record<string, unknown>;
      if (message.type === "GetStates" && Array.isArray(data.MissingUserIds)) {
        await removeMissingContacts(
          data.MissingUserIds.filter(
            (userId): userId is number => typeof userId === "number",
          ),
        );
        return;
      }
      if (message.type === "MessageLive") {
        await insertMessage(
          Number(data.SenderId),
          data.Message as CachedMessage,
        );
        return;
      }
      if (message.type === "MessageEditLive") {
        await replaceMessage(
          Number(data.ChatPartnerId),
          Number(data.SendTime),
          { Content: String(data.Content), Edited: true },
        );
        return;
      }
      if (message.type === "MessageDeleteLive") {
        const deleteData = message.data as {
          ChatPartnerId: number;
          SendTime: number;
        };
        await removeMessage(deleteData.ChatPartnerId, deleteData.SendTime);
        return;
      }
      if (message.type === "MessageState") {
        await replaceMessage(
          Number(data.ChatPartnerId),
          Number(data.SendTime),
          { MessageState: data.MessageState as CachedMessage["MessageState"] },
        );
        return;
      }
      if (message.type === "MessageReactionLive") {
        const partnerId = Number(data.ChatPartnerId);
        const sendTime = Number(data.SendTime);
        const senderId = Number(data.SenderId);
        const reaction = String(data.Reaction);
        const cache = secureCache();
        const window = await cache.conversations.get(peerKey(partnerId));
        const target = window?.Messages.find(
          (candidate) => candidate.SendTime === sendTime,
        );
        if (!window || !target) return;

        const reactions = (target.Reactions ?? []).filter(
          (candidate) =>
            candidate.SenderId !== senderId || candidate.Reaction !== reaction,
        );
        if (data.Accepted === true) {
          reactions.push({ SenderId: senderId, Reaction: reaction });
        }
        await replaceMessage(partnerId, sendTime, { Reactions: reactions });
      }
    },
    [
      accountId,
      accountKey,
      peerKey,
      insertMessage,
      removeMessage,
      removeMissingContacts,
      replaceMessage,
      secureCache,
    ],
  );

  useEffect(() => {
    if (!accountId || !contextReady) return;
    const handleMessage = (message: ProtocolMessage) => {
      void enqueue(() => synchronizePush(message));
    };
    const unsubscribers = [
      subscribe("GetStates", handleMessage),
      subscribe("MessageLive", handleMessage),
      subscribe("MessageEditLive", handleMessage),
      subscribe("MessageDeleteLive", handleMessage),
      subscribe("MessageState", handleMessage),
      subscribe("MessageReactionLive", handleMessage),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [accountId, contextReady, enqueue, subscribe, synchronizePush]);

  return null;
}

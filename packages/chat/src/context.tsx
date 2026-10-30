import {
  createContext,
  useMemo,
  useEffect,
  useCallback,
  useState,
  useContext,
  type ReactNode,
  useRef,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import type { InfiniteData } from "@tanstack/react-query";
import type { LiveMessage, RawMessage, RawMessages } from "./values";
import {
  decryptChatText,
  kemPublicKeyFromPublicKeyBundle,
  ownKemPublicKeyFromKeyring,
} from "@tensamin/crypto/chatSecret";
import { useStorage } from "@tensamin/storage/context";
import { requireRelaySuccess, useMTP } from "@tensamin/mtp";
import type { MTPDataValueInput } from "mtp";
import {
  deriveChatId,
  encodePrincipal,
  parsePrincipal,
  type Principal,
} from "@tensamin/shared/principal";
import { log, toast } from "@tensamin/shared/log";
import { useSession } from "@tensamin/identity/session";
import { useUser } from "@tensamin/identity/context";
import { createCache, type ChatDraft } from "@tensamin/cache";
import { secureValueCodec } from "@tensamin/storage/secure";
import { ConversationSecrets, type SecretState } from "./chatSecret";

export const context = createContext<contextType | undefined>(undefined);

const queryClient = new QueryClient();

type EditableMessage = RawMessage & { failed?: boolean };
type MessageEdit = Partial<
  Pick<
    EditableMessage,
    "Content" | "Edited" | "MessageState" | "Reactions" | "failed"
  >
>;

const messageStateRank: Record<RawMessage["MessageState"], number> = {
  awaiting: 0,
  sending: 0,
  sent: 1,
  received: 2,
  read: 3,
};

function updateMessagesBySendTime<T extends EditableMessage>(
  messages: T[],
  sendTime: number,
  edit: MessageEdit,
): { next: T[]; updated: boolean } {
  let updated = false;

  const next = messages.map((item) => {
    if (item.SendTime !== sendTime) {
      return item;
    }

    if (
      edit.MessageState !== undefined &&
      messageStateRank[edit.MessageState] < messageStateRank[item.MessageState]
    ) {
      return item;
    }

    const entries = Object.entries(edit) as Array<
      [keyof MessageEdit, MessageEdit[keyof MessageEdit]]
    >;

    if (entries.every(([key, value]) => item[key] === value)) {
      return item;
    }

    updated = true;
    return {
      ...item,
      ...edit,
    };
  });

  return {
    next,
    updated,
  };
}

function updateMessageReaction<T extends EditableMessage>(
  message: T,
  reaction: string,
  senderId: number,
  accepted: boolean,
): T {
  const current = message.Reactions ?? [];
  const withoutReaction = current.filter(
    (item) => item.Reaction !== reaction || item.SenderId !== senderId,
  );
  const next = accepted
    ? [...withoutReaction, { Reaction: reaction, SenderId: senderId }]
    : withoutReaction;

  if (
    next.length === current.length &&
    next.every(
      (item, index) =>
        item.Reaction === current[index]?.Reaction &&
        item.SenderId === current[index]?.SenderId,
    )
  ) {
    return message;
  }

  return { ...message, Reactions: next };
}

function updateMessageReactionBySendTime<T extends EditableMessage>(
  messages: T[],
  sendTime: number,
  reaction: string,
  senderId: number,
  accepted: boolean,
): { next: T[]; updated: boolean } {
  const index = messages.findIndex((message) => message.SendTime === sendTime);
  if (index === -1) return { next: messages, updated: false };

  const message = messages[index];
  const nextMessage = updateMessageReaction(
    message,
    reaction,
    senderId,
    accepted,
  );
  if (nextMessage === message) return { next: messages, updated: false };

  const next = [...messages];
  next[index] = nextMessage;
  return { next, updated: true };
}

type SendMessageGet = (
  type: "MessageGet",
  data: { SendTime: number; ChatPartnerId?: number },
) => Promise<{ data: { Message: RawMessage; Offset?: number } }>;

type StoredDraftState = ChatDraft & {
  accountId: string;
  userId: number;
  loaded: boolean;
  revision: number;
};

function draftKey(accountId: string, userId: number) {
  return JSON.stringify([accountId, userId]);
}

export async function getMessage({
  sendTime,
  chatPartnerId,
  send,
}: {
  sendTime: number;
  chatPartnerId: number;
  send: SendMessageGet;
}): Promise<RawMessage> {
  const message = (
    await send("MessageGet", {
      SendTime: sendTime,
      ChatPartnerId: chatPartnerId,
    })
  ).data.Message;
  return message;
}

export async function fetchReplyMessage({
  replyTo,
  chatUserId,
  currentChatSecret,
  currentChatSecretVersion,
  send,
  getChatSecret,
}: {
  replyTo: number;
  chatUserId: number;
  currentChatSecret?: Uint8Array | null;
  currentChatSecretVersion?: number;
  send: SendMessageGet;
  getChatSecret: (
    userId: number,
    version?: number,
  ) => Promise<Uint8Array | null>;
}) {
  const message = await getMessage({
    sendTime: replyTo,
    chatPartnerId: chatUserId,
    send,
  });
  const chatSecret =
    currentChatSecret && message.VersionNumber === currentChatSecretVersion
      ? currentChatSecret
      : await getChatSecret(chatUserId, message.VersionNumber);

  if (!chatSecret) {
    throw new Error("Missing chat secret");
  }

  const decryptedContent = await decryptChatText(
    chatSecret,
    message.Content,
    message.VersionNumber,
  );

  return {
    ...message,
    Content: decryptedContent,
  };
}

export default function Provider({ children }: { children: ReactNode }) {
  const { load } = useStorage();
  const {
    send,
    sendSealedRelay,
    subscribe,
    contextReady,
    clientState,
    client,
    refreshAccountState,
    accountKey = "",
  } = useMTP();
  const { getRelayIota } = useUser();
  const { contacts, moveUserIdToTop } = useSession();
  const scope = clientState?.Scope;
  const authority = scope?.principal.authority;
  const ownerId = scope?.principal.user_id;
  const owner = useMemo(
    () => (authority && ownerId ? { authority, user_id: ownerId } : undefined),
    [authority, ownerId],
  );
  const dictionaryFingerprint = scope?.dictionary;
  const peerPrincipal = useCallback(
    (handle: number) => {
      const contact = contacts.find((contact) => contact.UserId === handle);
      if (!contact?.Principal)
        throw new Error("Contact canonical identity is unavailable");
      return parsePrincipal(contact.Principal);
    },
    [contacts],
  );
  const resolveParticipant = useCallback(
    async (principal: Principal) => {
      const response = await send("UserResolve", {
        UserAddress: encodePrincipal(principal),
      });
      if (
        response.type !== "UserResolved" ||
        response.data.Principal !== encodePrincipal(principal) ||
        response.data.AuthorityId !== principal.authority ||
        response.data.UserId !== principal.user_id ||
        response.data.SigningKeys.length !== 1
      )
        throw new Error("Participant identity could not be verified");
      return response.data;
    },
    [send],
  );
  const sendPrincipalRelay = useCallback(
    async (
      peer: Principal,
      type: string,
      data: Record<string, MTPDataValueInput>,
    ) => {
      const dictionary = client?.dictionaryIdentity;
      if (
        !contextReady ||
        !owner ||
        !dictionary ||
        dictionary.fingerprint !== dictionaryFingerprint
      ) {
        throw new Error("Authenticated chat dictionary is unavailable");
      }
      const [self, recipient, ownIota] = await Promise.all([
        resolveParticipant(owner),
        resolveParticipant(peer),
        getRelayIota(owner.user_id),
      ]);
      const response = await sendSealedRelay(
        type,
        {
          ...data,
          ...(data.ChatPartnerId !== undefined && {
            ChatPartnerId: peer.user_id,
          }),
          ...(data.ReceiverId !== undefined && { ReceiverId: peer.user_id }),
        },
        {
          nextHop: { kind: "iota", id: ownIota.IotaId },
          finalRecipientId: peer.user_id,
          metadata: new TextEncoder().encode(
            JSON.stringify({
              signer: owner,
              recipient: peer,
              destination: recipient.NodeId,
              type_map_version: dictionary.version,
              type_map_fingerprint: dictionary.fingerprint,
            }),
          ),
          metadataRecipients: [
            { value: self.PublicKey, encoding: "base64" },
            { value: recipient.PublicKey, encoding: "base64" },
          ],
          contentRecipients: [
            { value: self.PublicKey, encoding: "base64" },
            { value: recipient.PublicKey, encoding: "base64" },
          ],
        },
      );
      return response;
    },
    [
      client,
      contextReady,
      dictionaryFingerprint,
      getRelayIota,
      owner,
      resolveParticipant,
      sendSealedRelay,
    ],
  );
  const sendChatRelay = useCallback(
    (handle: number, type: string, data: Record<string, MTPDataValueInput>) =>
      sendPrincipalRelay(peerPrincipal(handle), type, data),
    [peerPrincipal, sendPrincipalRelay],
  );
  const secrets = useMemo(() => {
    if (!contextReady || !owner || !accountKey) return null;
    return new ConversationSecrets({
      owner,
      keyring: () => load("mtp_keyring"),
      request: (data) => send("GetChatSecret", data),
      propose: (peer, data) => sendPrincipalRelay(peer, "SetChatSecret", data),
      kemKeys: async (peer) => {
        const [keyring, identity] = await Promise.all([
          load("mtp_keyring"),
          resolveParticipant(peer),
        ]);
        return [
          ownKemPublicKeyFromKeyring(keyring),
          kemPublicKeyFromPublicKeyBundle(identity.SigningKeys[0]),
        ];
      },
    });
  }, [
    accountKey,
    contextReady,
    owner,
    load,
    send,
    sendPrincipalRelay,
    resolveParticipant,
  ]);
  useEffect(() => () => secrets?.close(), [secrets]);
  const [secretStatus, setSecretStatus] = useState<SecretState>({
    kind: "pending",
  });

  const [liveMessagesByUser, setLiveMessagesByUser] = useState<
    Record<number, LiveMessage[]>
  >({});
  const [newMessageCounts, setNewMessageCounts] = useState<
    Record<number, number>
  >({});
  const [newMessageStarts, setNewMessageStarts] = useState<
    Record<number, number | undefined>
  >({});
  const ownId = owner?.user_id ?? 0;
  const [drafts, setDrafts] = useState<Record<string, StoredDraftState>>({});
  const draftsRef = useRef<Record<string, StoredDraftState>>({});
  const loadingDraftsRef = useRef(new Set<string>());
  const draftWriteQueuesRef = useRef(new Map<string, Promise<void>>());
  const [currentChatSecretState, setCurrentChatSecretState] = useState<{
    source: ConversationSecrets | null;
    userId: number;
    value: Uint8Array | null;
    version: number;
  }>({
    source: null,
    userId: 0,
    value: null,
    version: 0,
  });
  useEffect(
    () => () => {
      queryClient.clear();
      setLiveMessagesByUser({});
      setNewMessageCounts({});
      setNewMessageStarts({});
      draftsRef.current = {};
      setDrafts({});
      loadingDraftsRef.current.clear();
      draftWriteQueuesRef.current.clear();
    },
    [accountKey],
  );

  const inputBoxRef = useRef<HTMLDivElement>(null);

  const locationSearch = useRouterState({
    select: (state) => state.location.search,
  });
  const locationPathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  // User ID compare to clear shared secret
  const userIdValue = useMemo(() => {
    const rawId = (locationSearch as unknown as { id?: unknown })?.id;
    const userId = Number(rawId ?? 0);
    return Number.isSafeInteger(userId) && userId > 0 ? userId : 0;
  }, [locationSearch]);
  const activeChatUserId =
    locationPathname === "/chat" && userIdValue > 0 ? userIdValue : null;
  const selectedPrincipal = contacts.find(
    (contact) => contact.UserId === userIdValue,
  )?.Principal;
  const conversationKey =
    owner && selectedPrincipal
      ? deriveChatId(owner, parsePrincipal(selectedPrincipal))
      : "";
  const previousActiveChatUserIdRef = useRef(activeChatUserId);

  const currentChatSecret = useMemo(() => {
    if (
      currentChatSecretState.userId !== userIdValue ||
      currentChatSecretState.source !== secrets
    ) {
      return null;
    }

    return currentChatSecretState.value;
  }, [currentChatSecretState, secrets, userIdValue]);

  const persistDraft = useCallback(
    (key: string, accountId: string, userId: number, draft: ChatDraft) => {
      const previous =
        draftWriteQueuesRef.current.get(key) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          const cache = createCache(accountId, {
            codec: secureValueCodec,
          });
          if (draft.Content === "" && draft.ReplyId === undefined) {
            await cache.drafts.delete(encodePrincipal(peerPrincipal(userId)));
          } else {
            await cache.drafts.put(
              encodePrincipal(peerPrincipal(userId)),
              draft,
            );
          }
        })
        .catch((err) => {
          log(1, "chat", "red", "Failed to cache chat draft", err);
        });
      draftWriteQueuesRef.current.set(key, next);
    },
    [peerPrincipal],
  );

  const updateDraft = useCallback(
    (
      accountId: string,
      userId: number,
      update: (current: ChatDraft) => ChatDraft,
    ) => {
      const key = draftKey(accountId, userId);
      const current = draftsRef.current[key] ?? {
        accountId,
        userId,
        Content: "",
        loaded: false,
        revision: 0,
      };
      const changed = update(current);
      const next: StoredDraftState = {
        ...current,
        ...changed,
        revision: current.revision + 1,
      };
      const nextDrafts = { ...draftsRef.current, [key]: next };
      draftsRef.current = nextDrafts;
      setDrafts(nextDrafts);

      if (next.loaded) {
        persistDraft(key, accountId, userId, {
          Content: next.Content,
          ReplyId: next.ReplyId,
        });
      }
    },
    [persistDraft],
  );

  useEffect(() => {
    if (!accountKey || !Number.isSafeInteger(userIdValue) || userIdValue <= 0) {
      return;
    }

    const key = draftKey(accountKey, userIdValue);
    if (draftsRef.current[key]?.loaded || loadingDraftsRef.current.has(key)) {
      return;
    }
    loadingDraftsRef.current.add(key);

    void (async () => {
      let stored: ChatDraft | undefined;
      try {
        stored = await createCache(accountKey, {
          codec: secureValueCodec,
        }).drafts.get(encodePrincipal(peerPrincipal(userIdValue)));
      } catch (err) {
        log(1, "chat", "red", "Failed to restore chat draft", err);
      } finally {
        const current = draftsRef.current[key];
        const next: StoredDraftState =
          current && current.revision > 0
            ? { ...current, loaded: true }
            : {
                accountId: accountKey,
                userId: userIdValue,
                Content: stored?.Content ?? "",
                ReplyId: stored?.ReplyId,
                loaded: true,
                revision: 0,
              };
        const nextDrafts = { ...draftsRef.current, [key]: next };
        draftsRef.current = nextDrafts;
        setDrafts(nextDrafts);
        loadingDraftsRef.current.delete(key);

        if (next.revision > 0) {
          persistDraft(key, accountKey, userIdValue, {
            Content: next.Content,
            ReplyId: next.ReplyId,
          });
        }
      }
    })();
  }, [accountKey, peerPrincipal, persistDraft, userIdValue]);

  const activeDraftKey =
    accountKey && userIdValue > 0
      ? draftKey(accountKey, userIdValue)
      : undefined;
  const activeDraft = activeDraftKey ? drafts[activeDraftKey] : undefined;
  const composerValue = activeDraft?.Content ?? "";
  const replyTo = activeDraft?.ReplyId;
  const setComposerValue = useCallback(
    (value: string) => {
      if (!accountKey || userIdValue <= 0) return;
      updateDraft(accountKey, userIdValue, (current) => ({
        ...current,
        Content: value,
      }));
    },
    [accountKey, updateDraft, userIdValue],
  );
  const setReplyTo = useCallback(
    (value: number | undefined) => {
      if (!accountKey || userIdValue <= 0) return;
      updateDraft(accountKey, userIdValue, (current) => ({
        ...current,
        ReplyId: value,
      }));
    },
    [accountKey, updateDraft, userIdValue],
  );

  const getChatSecret = useCallback(
    async (handle: number, version?: number) => {
      if (!secrets)
        throw new Error("Authenticated chat identity is unavailable");
      const state = await secrets.read(peerPrincipal(handle), version);
      return state.kind === "ready" ? state.value : null;
    },
    [peerPrincipal, secrets],
  );

  const createInitialChatSecret = useCallback(
    async (handle: number) => {
      if (!secrets)
        throw new Error("Authenticated chat identity is unavailable");
      const state = await secrets.ensure(peerPrincipal(handle));
      return state.kind === "ready" ? state.value : null;
    },
    [peerPrincipal, secrets],
  );

  const startConversation = useCallback(
    async (address: string) => {
      if (!secrets || !owner)
        throw new Error("Authenticated chat identity is unavailable");
      const resolved = await send("UserResolve", { UserAddress: address });
      if (resolved.type !== "UserResolved")
        throw new Error("Could not resolve conversation participant");
      const peer = parsePrincipal(resolved.data.Principal);
      deriveChatId(owner, peer);
      requireRelaySuccess(
        await sendPrincipalRelay(peer, "AddConversation", {
          ChatPartnerId: peer.user_id,
        }),
      );
      await secrets.ensure(peer);
      const state = await refreshAccountState();
      const contact = state.Contacts.find(
        (contact) => contact.Principal === encodePrincipal(peer),
      );
      if (!contact) throw new Error("Conversation has not been committed yet");
      return contact.UserId;
    },
    [owner, refreshAccountState, secrets, send, sendPrincipalRelay],
  );

  useEffect(() => {
    if (!secrets || userIdValue <= 0) return;
    let active = true;
    setCurrentChatSecretState({
      source: secrets,
      userId: userIdValue,
      value: null,
      version: 0,
    });
    setSecretStatus({ kind: "pending" });
    void secrets
      .ensure(peerPrincipal(userIdValue))
      .then((state) => {
        if (!active) return;
        setSecretStatus(state);
        if (state.kind === "ready")
          setCurrentChatSecretState({
            source: secrets,
            userId: userIdValue,
            value: state.value,
            version: state.version,
          });
      })
      .catch((error) => {
        if (active)
          setSecretStatus({
            kind: "retryable",
            reason:
              error instanceof Error ? error.message : "Secret read failed",
          });
      });
    return () => {
      active = false;
    };
  }, [clientState, peerPrincipal, secrets, userIdValue]);

  const decryptMessages = useCallback(
    async (messages: RawMessages) => {
      return Promise.all(
        messages.map(async (message) => {
          try {
            const secret =
              message.VersionNumber === currentChatSecretState.version
                ? currentChatSecret
                : await getChatSecret(userIdValue, message.VersionNumber);
            if (!secret) throw new Error("missing message key epoch");
            return {
              ...message,
              Content: await decryptChatText(
                secret,
                message.Content,
                message.VersionNumber,
              ),
            };
          } catch (err) {
            log(1, "chat", "red", "Failed to decrypt historical message", err, {
              SendTime: message.SendTime,
            });
            return {
              ...message,
              Content: "Failed to decrypt message",
              decryptionFailed: true,
            };
          }
        }),
      );
    },
    [
      currentChatSecret,
      currentChatSecretState.version,
      getChatSecret,
      userIdValue,
    ],
  );

  const getCachedMessages = useCallback(async () => {
    if (!ownId || !userIdValue || !currentChatSecret) return [];
    const cache = createCache(accountKey, {
      codec: secureValueCodec,
    });
    const window = await cache.conversations.get(
      encodePrincipal(peerPrincipal(userIdValue)),
    );
    return decryptMessages(window?.Messages ?? []);
  }, [
    accountKey,
    currentChatSecret,
    decryptMessages,
    ownId,
    peerPrincipal,
    userIdValue,
  ]);

  const getMessages = useCallback(
    async (amount: number, offset: number) => {
      if (!currentChatSecret) {
        return [];
      }

      const messages = await send("MessagesGet", {
        Amount: amount,
        Offset: offset,
        UserId: userIdValue,
      });

      if (messages.type.startsWith("error")) {
        throw new Error(messages.type);
      }

      const rawMessages = messages.data.Messages;
      const sorted = [...rawMessages].sort((a, b) => a.SendTime - b.SendTime);

      if (sorted.length > 0) {
        const fetchedSendTimes = new Set(sorted.map((item) => item.SendTime));

        setLiveMessagesByUser((previous) => {
          const current = previous[userIdValue] ?? [];
          const filtered = current.filter(
            (liveMessage) => !fetchedSendTimes.has(liveMessage.SendTime),
          );

          return filtered.length === current.length
            ? previous
            : { ...previous, [userIdValue]: filtered };
        });
      }

      return decryptMessages(sorted);
    },
    [currentChatSecret, decryptMessages, send, userIdValue],
  );

  useEffect(() => {
    if (!currentChatSecret || !ownId || !userIdValue) return;
    const queryKey = [
      "chat-messages",
      accountKey,
      conversationKey,
      true,
    ] as const;
    void getCachedMessages().then((messages) => {
      if (messages.length === 0 || queryClient.getQueryData(queryKey)) return;
      queryClient.setQueryData<InfiniteData<RawMessages>>(queryKey, {
        pages: [messages],
        pageParams: [0],
      });
    });
  }, [
    accountKey,
    conversationKey,
    currentChatSecret,
    getCachedMessages,
    ownId,
    userIdValue,
  ]);

  const editMessageForUser = useCallback(
    (chatUserId: number, sendTime: number, edit: MessageEdit) => {
      setLiveMessagesByUser((previous) => {
        const current = previous[chatUserId] ?? [];
        const { next, updated } = updateMessagesBySendTime(
          current,
          sendTime,
          edit,
        );
        return updated ? { ...previous, [chatUserId]: next } : previous;
      });

      const queryKey = [
        "chat-messages",
        accountKey,
        owner ? deriveChatId(owner, peerPrincipal(chatUserId)) : "",
        true,
      ] as const;
      queryClient.setQueryData<InfiniteData<RawMessages>>(
        queryKey,
        (current) => {
          if (!current) {
            return current;
          }

          let updated = false;

          const pages = current.pages.map((page) => {
            const nextPage = updateMessagesBySendTime(page, sendTime, edit);

            if (nextPage.updated) {
              updated = true;
            }

            return nextPage.next;
          });

          if (!updated) {
            return current;
          }

          return {
            ...current,
            pages,
          };
        },
      );
    },
    [accountKey, owner, peerPrincipal],
  );

  const editMessage = useCallback(
    (sendTime: number, edit: MessageEdit) => {
      editMessageForUser(userIdValue, sendTime, edit);
    },
    [editMessageForUser, userIdValue],
  );

  const removeMessage = useCallback(
    (sendTime: number) => {
      setLiveMessagesByUser((previous) => ({
        ...previous,
        [userIdValue]: (previous[userIdValue] ?? []).filter(
          (message) => message.SendTime !== sendTime,
        ),
      }));
      const queryKey = [
        "chat-messages",
        accountKey,
        conversationKey,
        currentChatSecret !== null,
      ] as const;

      queryClient.setQueryData<InfiniteData<RawMessages>>(
        queryKey,
        (current) => {
          if (!current) {
            return current;
          }

          let updated = false;

          const pages = current.pages.map((page) => {
            const nextPage = page.filter((message) => {
              const keep = message.SendTime !== sendTime;
              if (!keep) {
                updated = true;
              }
              return keep;
            });

            return nextPage;
          });

          if (!updated) {
            return current;
          }

          return {
            ...current,
            pages,
          };
        },
      );
    },
    [accountKey, conversationKey, currentChatSecret, userIdValue],
  );

  const applyLiveReaction = useCallback(
    (
      sendTime: number,
      reaction: string,
      senderId: number,
      accepted: boolean,
    ) => {
      setLiveMessagesByUser((previous) => {
        const current = previous[userIdValue] ?? [];
        const { next, updated } = updateMessageReactionBySendTime(
          current,
          sendTime,
          reaction,
          senderId,
          accepted,
        );
        return updated ? { ...previous, [userIdValue]: next } : previous;
      });

      const queryKey = [
        "chat-messages",
        accountKey,
        conversationKey,
        currentChatSecret !== null,
      ] as const;
      queryClient.setQueryData<InfiniteData<RawMessages>>(
        queryKey,
        (current) => {
          if (!current) return current;

          let updated = false;
          const pages = current.pages.map((page) => {
            const nextPage = updateMessageReactionBySendTime(
              page,
              sendTime,
              reaction,
              senderId,
              accepted,
            );
            updated ||= nextPage.updated;
            return nextPage.next;
          });

          return updated ? { ...current, pages } : current;
        },
      );
    },
    [accountKey, conversationKey, currentChatSecret, userIdValue],
  );

  const deleteMessage = useCallback(
    async (sendTime: number) => {
      try {
        const response = await sendChatRelay(userIdValue, "MessageDelete", {
          ChatPartnerId: userIdValue,
          SendTime: sendTime,
        });
        requireRelaySuccess(response);
        removeMessage(sendTime);
      } catch (err) {
        log(1, "chat", "red", "Failed to delete message", err);
        toast("error", "Failed to delete message", String(err));
      }
    },
    [removeMessage, sendChatRelay, userIdValue],
  );

  const setReaction = useCallback(
    async (sendTime: number, reaction: string, add: boolean) => {
      let previousReactions: RawMessage["Reactions"];
      let foundMessage = false;

      const rememberPreviousReactions = (messages: EditableMessage[]) => {
        const message = messages.find((item) => item.SendTime === sendTime);
        if (!message) return;

        previousReactions ??= message.Reactions;
        foundMessage = true;
      };

      setLiveMessagesByUser((previous) => {
        const current = previous[userIdValue] ?? [];
        rememberPreviousReactions(current);
        const { next, updated } = updateMessageReactionBySendTime(
          current,
          sendTime,
          reaction,
          ownId,
          add,
        );
        return updated ? { ...previous, [userIdValue]: next } : previous;
      });

      const queryKey = [
        "chat-messages",
        accountKey,
        conversationKey,
        currentChatSecret !== null,
      ] as const;
      queryClient.setQueryData<InfiniteData<RawMessages>>(
        queryKey,
        (current) => {
          if (!current) return current;

          let updated = false;
          const pages = current.pages.map((page) => {
            rememberPreviousReactions(page);
            const nextPage = updateMessageReactionBySendTime(
              page,
              sendTime,
              reaction,
              ownId,
              add,
            );
            updated ||= nextPage.updated;
            return nextPage.next;
          });

          return updated ? { ...current, pages } : current;
        },
      );

      try {
        requireRelaySuccess(
          await sendChatRelay(
            userIdValue,
            add ? "MessageReactionAdd" : "MessageReactionRemove",
            {
              ChatPartnerId: userIdValue,
              Reaction: reaction,
              SendTime: sendTime,
            },
          ),
        );
      } catch (err) {
        if (foundMessage) {
          editMessage(sendTime, { Reactions: previousReactions });
        }
        log(1, "chat", "red", "Failed to update reaction", err);
        toast("error", "Failed to update reaction", String(err));
      }
    },
    [
      currentChatSecret,
      accountKey,
      conversationKey,
      editMessage,
      ownId,
      sendChatRelay,
      userIdValue,
    ],
  );

  const addReaction = useCallback(
    (sendTime: number, reaction: string) =>
      setReaction(sendTime, reaction, true),
    [setReaction],
  );
  const removeReaction = useCallback(
    (sendTime: number, reaction: string) =>
      setReaction(sendTime, reaction, false),
    [setReaction],
  );

  const addLiveMessage = useCallback(
    (message: RawMessage, unreadCount = 0) => {
      const chatUserId = userIdValue;
      const localId =
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      if (message.Principal !== (owner && encodePrincipal(owner))) {
        moveUserIdToTop(chatUserId);
      }

      if (unreadCount > 0) {
        setNewMessageCounts((current) => ({
          ...current,
          [chatUserId]: Math.max(current[chatUserId] ?? 0, unreadCount),
        }));
        setNewMessageStarts((current) =>
          current[chatUserId] === undefined
            ? { ...current, [chatUserId]: message.SendTime }
            : current,
        );
      }

      setLiveMessagesByUser((previous) => ({
        ...previous,
        [chatUserId]: [
          ...(previous[chatUserId] ?? []),
          {
            ...message,
            localId,
            failed: false,
          },
        ],
      }));

      return {
        setFailed: (failed: boolean) => {
          editMessageForUser(chatUserId, message.SendTime, { failed });
        },
        setMessageState: (MessageState: RawMessage["MessageState"]) => {
          editMessageForUser(chatUserId, message.SendTime, { MessageState });
        },
      };
    },
    [editMessageForUser, userIdValue, moveUserIdToTop, owner],
  );

  const markMessagesAsNew = useCallback((chatUserId: number, count: number) => {
    if (count <= 0) return;
    setNewMessageCounts((current) => ({
      ...current,
      [chatUserId]: Math.max(current[chatUserId] ?? 0, count),
    }));
  }, []);

  const clearNewMessages = useCallback((chatUserId: number) => {
    setNewMessageCounts((current) => {
      if (!current[chatUserId]) return current;
      return { ...current, [chatUserId]: 0 };
    });
    setNewMessageStarts((current) => {
      if (current[chatUserId] === undefined) return current;
      return { ...current, [chatUserId]: undefined };
    });
  }, []);

  const setNewMessagesStart = useCallback(
    (chatUserId: number, sendTime: number) => {
      setNewMessageStarts((current) =>
        current[chatUserId] === undefined
          ? { ...current, [chatUserId]: sendTime }
          : current,
      );
    },
    [],
  );

  useEffect(() => {
    const previousChatUserId = previousActiveChatUserIdRef.current;
    previousActiveChatUserIdRef.current = activeChatUserId;
    if (
      previousChatUserId !== null &&
      previousChatUserId !== activeChatUserId
    ) {
      clearNewMessages(previousChatUserId);
    }
  }, [activeChatUserId, clearNewMessages]);

  // Get live updates for message states
  useEffect(() => {
    const unsubscribeEdit = subscribe("MessageEditLive", ({ data }) => {
      if (!currentChatSecret) return;
      if (data.ChatPartnerId !== userIdValue) {
        log(
          3,
          "chat",
          "yellow",
          "Cancel message edit update due to user ID mismatch",
          {
            expected: userIdValue,
            received: data.ChatPartnerId,
          },
        );
        return;
      }

      void getChatSecret(userIdValue, data.VersionNumber)
        .then((secret) => {
          if (!secret) throw new Error("missing edit key epoch");
          return decryptChatText(secret, data.Content, data.VersionNumber);
        })
        .then((content) => {
          editMessage(data.SendTime, { Content: content, Edited: true });
        })
        .catch((err) => {
          log(1, "chat", "red", "Failed to decrypt message edit", err, {
            SendTime: data.SendTime,
          });
        });
    });
    const unsubscribeReaction = subscribe("MessageReactionLive", ({ data }) => {
      if (data.ChatPartnerId !== userIdValue) return;
      applyLiveReaction(
        data.SendTime,
        data.Reaction,
        data.SenderId,
        data.Accepted,
      );
    });
    const unsubscribeDelete = subscribe("MessageDeleteLive", ({ data }) => {
      if (data.ChatPartnerId !== userIdValue) return;
      removeMessage(data.SendTime);
    });
    const unsubscribeState = subscribe("MessageState", ({ data }) => {
      if (data.ChatPartnerId !== userIdValue) {
        log(
          3,
          "chat",
          "yellow",
          "Cancel message state update due to user ID mismatch",
          {
            expected: userIdValue,
            received: data.ChatPartnerId,
          },
        );
        return;
      }
      editMessage(data.SendTime, { MessageState: data.MessageState });
    });
    return () => {
      unsubscribeEdit();
      unsubscribeReaction();
      unsubscribeDelete();
      unsubscribeState();
    };
  }, [
    currentChatSecret,
    applyLiveReaction,
    editMessage,
    getChatSecret,
    removeMessage,
    subscribe,
    userIdValue,
  ]);

  return (
    <QueryClientProvider client={queryClient}>
      <context.Provider
        value={{
          getMessages,
          getChatSecret,
          sendChatRelay,
          startConversation,
          secretStatus,
          accountKey,
          conversationKey,
          ownPrincipal: owner ? encodePrincipal(owner) : undefined,
          liveMessages: () => liveMessagesByUser[userIdValue] ?? [],
          newMessageCount: newMessageCounts[userIdValue] ?? 0,
          newMessagesStart: newMessageStarts[userIdValue] ?? null,
          addLiveMessage,
          markMessagesAsNew,
          setNewMessagesStart,
          clearNewMessages,
          editMessage,
          deleteMessage,
          addReaction,
          removeReaction,
          chatSecret: currentChatSecret,
          chatSecretVersion: currentChatSecretState.version,
          ensureChatSecret: createInitialChatSecret,
          ownId,
          userId: userIdValue,
          inputBoxRef,
          composerValue,
          setComposerValue,
          replyTo,
          setReplyTo,
        }}
      >
        {children}
      </context.Provider>
    </QueryClientProvider>
  );
}

type contextType = {
  sendChatRelay: (
    handle: number,
    type: string,
    data: Record<string, MTPDataValueInput>,
  ) => Promise<{ type: string; data: Record<string, unknown> }>;
  startConversation: (address: string) => Promise<number>;
  secretStatus: SecretState;
  accountKey: string;
  conversationKey: string;
  ownPrincipal: string | undefined;
  getMessages: (amount: number, offset: number) => Promise<RawMessages>;
  getChatSecret: (
    userId: number,
    version?: number,
  ) => Promise<Uint8Array | null>;
  liveMessages: () => LiveMessage[];
  newMessageCount: number;
  newMessagesStart: number | null;
  addLiveMessage: (
    message: RawMessage,
    unreadCount?: number,
  ) => {
    setFailed: (failed: boolean) => void;
    setMessageState: (messageState: RawMessage["MessageState"]) => void;
  };
  markMessagesAsNew: (userId: number, count: number) => void;
  setNewMessagesStart: (userId: number, sendTime: number) => void;
  clearNewMessages: (userId: number) => void;
  editMessage: (sendTime: number, edit: MessageEdit) => void;
  deleteMessage: (sendTime: number) => void;
  addReaction: (sendTime: number, reaction: string) => Promise<void>;
  removeReaction: (sendTime: number, reaction: string) => Promise<void>;
  chatSecret: Uint8Array | null;
  chatSecretVersion: number;
  ensureChatSecret: (userId: number) => Promise<Uint8Array | null>;
  ownId: number;
  userId: number;
  inputBoxRef: React.RefObject<HTMLDivElement | null>;
  composerValue: string;
  setComposerValue: (value: string) => void;
  replyTo: number | undefined;
  setReplyTo: (value: number | undefined) => void;
};

export function useChat(): contextType {
  const ctx = useContext(context);
  if (!ctx) {
    throw new Error("useChat must be used within a ChatProvider");
  }
  return ctx;
}

export function useReplyMessage() {
  const { send } = useMTP();
  const {
    chatSecret,
    chatSecretVersion,
    replyTo,
    setReplyTo,
    getChatSecret,
    userId,
    ownId,
  } = useChat();
  const [replyMessage, setReplyMessage] = useState<RawMessage | undefined>();

  const handleReplyError = useCallback(
    (err: unknown) => {
      log(1, "chat", "red", "Failed to get reply message", err);
      toast("error", "Failed to get reply message", String(err));
      setReplyTo(undefined);
      setReplyMessage(undefined);
    },
    [setReplyTo],
  );

  useEffect(() => {
    if (!replyTo || !ownId) {
      setReplyMessage(undefined);
      return;
    }

    let active = true;
    setReplyMessage(undefined);

    void fetchReplyMessage({
      replyTo,
      chatUserId: userId,
      currentChatSecret: chatSecret,
      currentChatSecretVersion: chatSecretVersion,
      send,
      getChatSecret,
    })
      .then((message) => {
        if (active) {
          setReplyMessage(message);
        }
      })
      .catch((err) => {
        if (active) {
          handleReplyError(err);
        }
      });

    return () => {
      active = false;
    };
  }, [
    chatSecret,
    chatSecretVersion,
    getChatSecret,
    handleReplyError,
    ownId,
    replyTo,
    send,
    userId,
  ]);

  return {
    ownId,
    replyTo,
    replyMessage,
    replyUserId: replyMessage?.SenderId,
  };
}

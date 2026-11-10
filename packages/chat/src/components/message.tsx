import type { RawMessage, ChatAttachmentRenderer } from "../values";
import { AlertTriangle, Check, CheckLine, RefreshCw } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { usePrincipalPresentation } from "@tensamin/identity/context";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Card,
  cn,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nonanium/ui";
import MessageContextMenu from "./messageContextMenu";
import Media from "./media/media";
import { useStorage } from "@tensamin/storage/context";
import { requireRelaySuccess, useMTP } from "@tensamin/mtp";
import { getMessage, useChat } from "../context";
import { decryptChatText, encryptChatText } from "@tensamin/crypto/chatSecret";
import { log, toast } from "@tensamin/shared/log";
import { Emoji, Input, normalizeShortcode, Text } from "@nonanium/ui/markdown";
import { useRecordEmojiUse } from "./emojiRanks";
import ReplyBox from "./replyBox";
import { useHotkey } from "@tensamin/hotkeys";
import { cancelMessageEditHotkey } from "../hotkeys";
import { getAppFocused, useAppFocused } from "@tensamin/shared/focus";

function MessageComponent({
  editing,
  grouped,
  highlighted,
  message,
  onReplyActivate,
  onSetEditing,
  renderAttachments,
}: {
  editing: boolean;
  grouped: boolean;
  highlighted: boolean;
  message: RawMessage & {
    failed?: boolean;
    decryptionFailed?: boolean;
  };
  onSetEditing: (editing: boolean) => void;
  onReplyActivate: (sendTime: number) => void;
  renderAttachments?: ChatAttachmentRenderer;
}) {
  const user = usePrincipalPresentation(message.Principal);
  const actuallyFailed =
    Boolean(message.ErrorType) ||
    (message.failed && message.MessageState === "awaiting") ||
    message.decryptionFailed;

  const isLiveMessage = "localId" in message;
  const [hasFadedIn, setHasFadedIn] = useState(!isLiveMessage);
  const opacityClass =
    isLiveMessage && !hasFadedIn
      ? "opacity-0"
      : message.MessageState === "awaiting"
        ? "opacity-50"
        : "opacity-100";
  const messageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editing) return;

    const frame = requestAnimationFrame(() => {
      const input =
        messageRef.current?.querySelector<HTMLElement>(".cm-content");

      if (!input) return;

      input.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(input);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });

    return () => cancelAnimationFrame(frame);
  }, [editing]);

  useEffect(() => {
    if (!isLiveMessage) return;

    const frame = requestAnimationFrame(() => {
      setHasFadedIn(true);
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [isLiveMessage]);

  // Message states
  const { load } = useStorage();
  const { send } = useMTP();
  const { sendChatRelay, ownId, ownPrincipal, userId } = useChat();
  const isOwn =
    message.Principal !== undefined && message.Principal === ownPrincipal;
  const appFocused = useAppFocused();
  const messageStateReadUpdate = useCallback(async () => {
    const readConfirmations = await load("settings.read_confirmations");

    if (!userId || ownId === 0 || !message.Principal) return;

    if (!message.RelayMessageId) return;
    // Recheck after loading keys so a blur during the request cannot mark it read.
    const messageState =
      readConfirmations && getAppFocused() ? "read" : "received";

    if (message.MessageState === messageState) return;
    const response = await sendChatRelay(userId, "MessageState", {
      ChatPartnerId: userId,
      RelayMessageId: message.RelayMessageId,
      EventAt: Date.now(),
      MessageState: messageState,
      ReceiverId: userId,
    });
    requireRelaySuccess(response);
  }, [
    load,
    ownId,
    sendChatRelay,
    userId,
    message.Principal,
    message.RelayMessageId,
    message.MessageState,
  ]);
  useEffect(() => {
    if (isOwn || ownId === 0) return;

    let cancelled = false;

    async function run() {
      const receiveConfirmations = await load("settings.receive_confirmations");

      if (cancelled) return;

      switch (message.MessageState) {
        case "sent":
          if (receiveConfirmations) {
            await messageStateReadUpdate();
          }

          break;

        case "received":
          await messageStateReadUpdate();
          break;

        default:
          break;
      }
    }

    void run().catch((error) => {
      log(1, "chat", "red", "Failed to update message state", error);
    });

    return () => {
      cancelled = true;
    };
  }, [
    message.MessageState,
    load,
    messageStateReadUpdate,
    isOwn,
    ownId,
    appFocused,
  ]);

  // Check if message is a url
  const [isValidURL, setIsValidURL] = useState(false);
  const time = new Date(message.SendTime).toLocaleString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const renderText = (body: string) => (
    <Text
      showEditedIndicator={message.Edited}
      value={body}
      renderImage={({ src, alt, title }) => (
        <Media
          link={src}
          alt={alt}
          title={title}
          principal={message.Principal}
          time={time}
        />
      )}
    />
  );
  const attachmentContent = renderAttachments?.(
    message.Content,
    message.Principal,
    renderText,
  );
  useEffect(() => {
    try {
      if (message.Content.split(" ").length > 1) throw new Error();

      if (new URL(message.Content).protocol !== "https:") throw new Error();
      setIsValidURL(true);
    } catch {
      setIsValidURL(false);
    }
  }, [message.Content]);

  // Message editing
  const {
    addReaction,
    chatSecret,
    chatSecretVersion,
    editMessage,
    getChatSecret,
    removeReaction,
    replyTo,
  } = useChat();
  const [replyMessage, setReplyMessage] = useState<RawMessage | null>(null);
  const replyUser = usePrincipalPresentation(replyMessage?.Principal);
  useEffect(() => {
    if (!message.ReplyId || !ownId || !chatSecret) {
      setReplyMessage(null);

      return;
    }

    let active = true;
    void getMessage({
      sendTime: message.ReplyId,
      chatPartnerId: userId,
      send,
    })
      .then(async (reply) => {
        const replySecret =
          reply.VersionNumber === chatSecretVersion
            ? chatSecret
            : await getChatSecret(userId, reply.VersionNumber);

        if (!replySecret) throw new Error("Reply secret is unavailable");
        const Content = await decryptChatText(
          replySecret,
          reply.Content,
          reply.VersionNumber,
        );

        if (!active) return;
        setReplyMessage({ ...reply, Content });
      })
      .catch((err) => {
        if (!active) return;
        setReplyMessage(null);
        log(1, "chat", "red", "Failed to get replied-to message", err);
      });

    return () => {
      active = false;
    };
  }, [
    chatSecret,
    chatSecretVersion,
    getChatSecret,
    message.ReplyId,
    ownId,
    send,
    userId,
  ]);
  const recordUse = useRecordEmojiUse();
  const editingRef = useRef(editing);
  const onSetEditingRef = useRef(onSetEditing);
  useEffect(() => {
    editingRef.current = editing;
    onSetEditingRef.current = onSetEditing;
  }, [editing, onSetEditing]);
  useEffect(
    () => () => {
      if (editingRef.current) onSetEditingRef.current(false);
    },
    [],
  );
  const [editDraft, setEditDraft] = useState(message.Content);
  const cancelEditing = useCallback(() => {
    setEditDraft(message.Content);
    onSetEditing(false);
  }, [message.Content, onSetEditing]);
  useHotkey(cancelMessageEditHotkey, cancelEditing, {
    enabled: editing,
    target: messageRef,
  });
  useEffect(() => {
    if (!editing) {
      setEditDraft(message.Content);
    }
  }, [editing, message.Content]);
  const submitEditMessage = useCallback(
    async (newContent: string) => {
      if (!chatSecret) return;

      const editSecret =
        message.VersionNumber === chatSecretVersion
          ? chatSecret
          : await getChatSecret(userId, message.VersionNumber);

      if (!editSecret) return;
      const encryptedContent = await encryptChatText(
        editSecret,
        newContent,
        message.VersionNumber,
      ).catch((err) => {
        toast("error", "Failed to encrypt edit", String(err));
      });

      if (!encryptedContent) return;

      const previousContent = message.Content;
      editMessage(message.SendTime, { Content: newContent, Edited: true });

      try {
        const response = await sendChatRelay(userId, "MessageEdit", {
          Content: encryptedContent,
          SendTime: message.SendTime,
          VersionNumber: message.VersionNumber,
        });
        requireRelaySuccess(response);
      } catch (err) {
        editMessage(message.SendTime, {
          Content: previousContent,
          Edited: message.Edited ?? false,
        });
        log(1, "chat", "red", "Failed to edit message", err);
        toast("error", "Failed to edit message", String(err));
      }
    },
    [
      chatSecret,
      chatSecretVersion,
      getChatSecret,
      editMessage,
      userId,
      message.Content,
      message.Edited,
      message.SendTime,
      message.VersionNumber,
      sendChatRelay,
    ],
  );

  const groupedReactions = Object.entries(
    (message.Reactions ?? []).reduce<
      Record<string, { count: number; reactedByMe: boolean }>
    >((groups, item) => {
      const reaction = normalizeShortcode(item.Reaction);

      if (!reaction) return groups;

      const group = groups[reaction] ?? {
        count: 0,
        reactedByMe: false,
      };
      group.count += 1;
      group.reactedByMe ||= item.Principal === ownPrincipal;
      groups[reaction] = group;

      return groups;
    }, {}),
  );
  const reactionButtons = useRef(new Map<string, HTMLButtonElement>());
  const previousReactions = useRef<Map<string, number> | null>(null);
  useLayoutEffect(() => {
    const counts = new Map(
      groupedReactions.map(([reaction, { count }]) => [reaction, count]),
    );

    if (
      previousReactions.current &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      for (const [reaction, count] of counts) {
        if (count > (previousReactions.current.get(reaction) ?? 0)) {
          reactionButtons.current
            .get(reaction)
            ?.animate(
              [
                { transform: "scale(0.85)" },
                { transform: "scale(1.13)", offset: 0.55 },
                { transform: "scale(1)" },
              ],
              { duration: 260, easing: "ease-out" },
            );
        }
      }
    }

    previousReactions.current = counts;
  }, [groupedReactions]);

  function toggleReaction(reaction: string) {
    const reactedByMe = message.Reactions?.some(
      (item) =>
        normalizeShortcode(item.Reaction) === reaction &&
        item.Principal === ownPrincipal,
    );

    if (reactedByMe) {
      return removeReaction(message.SendTime, reaction);
    }

    recordUse(reaction);

    return addReaction(message.SendTime, reaction);
  }

  return (
    <div
      ref={messageRef}
      // pt-3 is to get a gap between messages
      className={`${grouped ? "" : "pt-3"} w-full flex flex-col gap-1 justify-start items-start transition-opacity duration-150 ${opacityClass}`}
    >
      {/* reply */}
      {replyMessage && replyUser && (
        <ReplyBox
          edited={replyMessage.Edited}
          content={replyMessage.Content}
          onActivate={() => onReplyActivate(replyMessage.SendTime)}
          user={replyUser}
          variant="message"
        />
      )}
      {message.Content ? (
        <MessageContextMenu
          content={message.Content}
          hideMiniMenu={editing}
          isOwnMessage={isOwn}
          messageId={message.SendTime}
          onReact={toggleReaction}
          onSetEditing={onSetEditing}
        >
          <>
            <div
              className={cn(
                "group hover:bg-muted/50 select-text! relative justify-start flex gap-1 items-center w-full px-2 whitespace-pre-wrap wrap-break-word transition-colors duration-200 ease-in-out",
                {
                  "bg-(--destructive)/10 text-destructive-foreground hover:bg-(--destructive)/15":
                    actuallyFailed,
                  "bg-(--primary-foreground-alt)/15 hover:bg-(--primary-foreground-alt)/20":
                    replyTo === message.SendTime && !actuallyFailed,
                  "bg-(--primary-foreground-alt)/25 hover:bg-(--primary-foreground-alt)/25":
                    highlighted && !actuallyFailed,
                },
              )}
            >
              <>
                {grouped ? (
                  <p className="w-9 shrink-0 self-start pt-[5px] text-xs group-hover:visible invisible text-muted-foreground">
                    {time}
                  </p>
                ) : (
                  <div className="shrink-0 self-start pr-1 pt-1">
                    <Avatar className="size-8">
                      <AvatarImage src={user?.Avatar} />
                      <AvatarFallback>
                        {user?.Display.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                  </div>
                )}
                <div className="flex flex-col group min-w-0 flex-1">
                  {!grouped && (
                    <div className="flex min-h-6 items-center gap-1">
                      {user ? (
                        <p className="font-semibold">{user.Display}</p>
                      ) : (
                        <Skeleton className="h-4 w-16" />
                      )}
                      <p className="text-xs text-muted-foreground">{time}</p>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <div className="flex items-center justify-start gap-1">
                              {message.SenderId !==
                              ownId ? null : message.MessageState === "read" ? (
                                <Check
                                  size={12}
                                  color="var(--primary-foreground-alt)"
                                />
                              ) : message.MessageState === "received" ? (
                                <CheckLine
                                  size={12}
                                  color="var(--muted-foreground)"
                                />
                              ) : message.MessageState === "sent" ? (
                                <Check
                                  size={12}
                                  color="var(--muted-foreground)"
                                />
                              ) : message.MessageState === "sending" ? (
                                <RefreshCw
                                  size={12}
                                  color="var(--muted-foreground)"
                                />
                              ) : null}
                              {actuallyFailed && (
                                <AlertTriangle
                                  color="var(--destructive)"
                                  size={12}
                                />
                              )}
                            </div>
                          }
                        />
                        <TooltipContent>
                          {message.MessageState.at(0)?.toUpperCase() +
                            message.MessageState.slice(1)}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  )}
                  {editing ? (
                    <div className="flex w-full flex-col gap-1 py-1.5">
                      <Card className="px-2! py-0! rounded-md">
                        <Input
                          autoFocus
                          className="w-full"
                          setValue={setEditDraft}
                          value={editDraft}
                          onSubmit={() => {
                            if (!editDraft.trim()) return;

                            if (editDraft !== message.Content) {
                              void submitEditMessage(editDraft);
                            }

                            onSetEditing(false);
                          }}
                        />
                      </Card>
                      <div className="flex gap-1">
                        <Button
                          size="xs"
                          onClick={() => {
                            if (!editDraft.trim()) return;

                            if (editDraft !== message.Content) {
                              void submitEditMessage(editDraft);
                            }

                            setEditDraft(message.Content);
                            onSetEditing(false);
                          }}
                        >
                          Save
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={cancelEditing}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-1 w-full!">
                      {attachmentContent ??
                        (isValidURL ? (
                          <Media
                            link={message.Content}
                            principal={message.Principal}
                            time={time}
                          />
                        ) : (
                          <div className="min-w-0 flex-1">
                            {renderText(message.Content)}
                          </div>
                        ))}
                    </div>
                  )}
                  {groupedReactions.length > 0 && (
                    <div className="pt-1 flex flex-wrap gap-1 pb-1">
                      {groupedReactions.map(
                        ([reaction, { count, reactedByMe }]) => (
                          <Button
                            key={reaction}
                            aria-pressed={reactedByMe}
                            ref={(element) => {
                              if (element)
                                reactionButtons.current.set(reaction, element);
                              else reactionButtons.current.delete(reaction);
                            }}
                            className={cn(
                              "h-7 gap-2 rounded-lg py-3.5 px-1.5! border-[0.75px]! active:scale-95 motion-safe:transition-transform",
                              reactedByMe
                                ? "border-(--primary-foreground-alt)/40! text-foreground! bg-(--primary)/30!"
                                : "",
                            )}
                            onClick={() => void toggleReaction(reaction)}
                            size="xs"
                            variant={reactedByMe ? "default" : "outline"}
                          >
                            <Emoji className="h-5 w-5" shortcode={reaction} />
                            <span className="text-sm">{count}</span>
                          </Button>
                        ),
                      )}
                    </div>
                  )}
                </div>
              </>
            </div>
          </>
        </MessageContextMenu>
      ) : (
        <Skeleton className="h-10 w-30" />
      )}
    </div>
  );
}

export default memo(MessageComponent, (prev, next) => {
  return (
    prev.message.SendTime === next.message.SendTime &&
    prev.editing === next.editing &&
    prev.highlighted === next.highlighted &&
    prev.message.Content === next.message.Content &&
    prev.message.Principal === next.message.Principal &&
    prev.message.ReplyId === next.message.ReplyId &&
    prev.message.MessageState === next.message.MessageState &&
    prev.message.failed === next.message.failed &&
    prev.message.decryptionFailed === next.message.decryptionFailed &&
    JSON.stringify(prev.message.Reactions) ===
      JSON.stringify(next.message.Reactions) &&
    prev.grouped === next.grouped &&
    prev.onReplyActivate === next.onReplyActivate &&
    prev.renderAttachments === next.renderAttachments
  );
});

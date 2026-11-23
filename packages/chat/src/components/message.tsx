import type { RawMessage, EditAttachments } from "../values";
import { AlertTriangle, Check, CheckLine, RefreshCw } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
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
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nonanium/ui";
import Profile from "@tensamin/identity/profile";
import MessageContextMenu from "./messageContextMenu";
import Media from "./media/media";
import { useStorage } from "@tensamin/storage/context";
import { requireRelaySuccess, useMTP } from "@tensamin/mtp";
import { decryptChatMessage, getMessage, useChat } from "../context";
import { useFileSettlements } from "../settlements";
import { isDefinitiveRelayRejection } from "@tensamin/mtp/relayResult";
import {
  MAX_MESSAGE_FILES,
  MAX_MESSAGE_BODY_BYTES,
  messageBodyBytes,
} from "@tensamin/shared/data";
import { encryptChatText } from "@tensamin/crypto/chatSecret";
import { log, toast } from "@tensamin/shared/log";
import { Emoji, Input, normalizeShortcode, Text } from "@nonanium/ui/markdown";
import { useRecordEmojiUse } from "./emojiRanks";
import ReplyBox from "./replyBox";
import { useHotkey } from "@tensamin/hotkeys";
import { cancelMessageEditHotkey } from "../hotkeys";
import { getAppFocused, useAppFocused } from "@tensamin/shared/focus";
import {
  ChatFileChip,
  ChatFiles,
  chatMessagePreview,
  encryptChatFiles,
  parseChatFile,
  withChatFileStatuses,
} from "./fileMessages";

function MessageComponent({
  editAttachments,
  editing,
  grouped,
  highlighted,
  message,
  onReplyActivate,
  onSetEditing,
}: {
  editAttachments?: EditAttachments;
  editing: boolean;
  grouped: boolean;
  highlighted: boolean;
  message: RawMessage & {
    failed?: boolean;
    decryptionFailed?: boolean;
  };
  onSetEditing: (editing: boolean) => void;
  onReplyActivate: (sendTime: number) => void;
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
      range.collapse(false);
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
  const { send, contextReady } = useMTP();
  const { sendChatRelay, ownId, ownPrincipal, userId } = useChat();
  const isOwn =
    message.Principal !== undefined && message.Principal === ownPrincipal;
  const appFocused = useAppFocused();
  // An effect event, so new relay or contact identities after a refresh do not resend the receipt.
  const messageStateReadUpdate = useEffectEvent(async () => {
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
  });
  useEffect(() => {
    if (isOwn || ownId === 0 || !contextReady) return;

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
    message.RelayMessageId,
    load,
    isOwn,
    ownId,
    appFocused,
    contextReady,
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
    beginFilesSettle,
    deleteMessage,
    filesSettling,
    editMessage,
    getChatSecret,
    removeReaction,
    replyTo,
  } = useChat();
  const settlements = useFileSettlements();
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
        const decrypted = await decryptChatMessage(replySecret, reply);

        if (!active) return;
        setReplyMessage(decrypted);
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
  const [removedFiles, setRemovedFiles] = useState<string[]>([]);
  const keptFiles = message.Files.filter(
    (file) => !removedFiles.includes(file.Content),
  );
  const editEmpty =
    !editDraft.trim() && keptFiles.length === 0 && !editAttachments?.count;
  const tooManyFiles =
    keptFiles.length + (editAttachments?.count ?? 0) > MAX_MESSAGE_FILES;
  const [saving, setSaving] = useState(false);
  const cancelEditing = useCallback(() => {
    setEditDraft(message.Content);
    setRemovedFiles([]);
    editAttachments?.discard();
    onSetEditing(false);
  }, [editAttachments, message.Content, onSetEditing]);
  useHotkey(cancelMessageEditHotkey, cancelEditing, {
    enabled: editing,
    target: messageRef,
  });
  useEffect(() => {
    if (!editing) {
      setEditDraft(message.Content);
      setRemovedFiles([]);
    }
  }, [editing, message.Content]);
  const saveBlocked = saving || tooManyFiles || editAttachments?.busy;

  async function deleteWithFiles() {
    onSetEditing(false);
    if (!(await deleteMessage(message.SendTime))) return;
    const keys = message.Files.flatMap(
      (file) => parseChatFile(file, message.Principal)?.key ?? [],
    );
    await settlements.forget(message.SendTime, keys).catch((err) => {
      toast("error", "Failed to revoke file shares", String(err));
    });
  }

  async function submitEdit() {
    if (
      editDraft === message.Content &&
      removedFiles.length === 0 &&
      !editAttachments?.count
    ) {
      onSetEditing(false);
      return;
    }
    if (editEmpty || !chatSecret || saveBlocked) return;
    setSaving(true);
    editAttachments?.onSendingChange(true);
    let finishSettle: (() => void) | undefined;
    let settling: Promise<void> | undefined;
    try {
      const prepared = editAttachments?.count
        ? await editAttachments.prepare()
        : undefined;
      if (editAttachments?.count && !prepared) return;
      const text = editDraft.trim() ? editDraft : "";

      const files = [
        ...keptFiles,
        ...(prepared?.references ?? []).map((Content) => ({
          Content,
          Status: "uploading" as const,
        })),
      ];
      const encrypted = await Promise.all([
        text ? encryptChatText(chatSecret, text, chatSecretVersion) : undefined,
        encryptChatFiles(chatSecret, chatSecretVersion, files),
      ]).catch((err) => {
        toast("error", "Failed to encrypt edit", String(err));
      });

      if (!encrypted) return;
      const [encryptedContent, encryptedFiles] = encrypted;
      if (
        messageBodyBytes(encryptedContent, encryptedFiles) >
        MAX_MESSAGE_BODY_BYTES
      ) {
        toast(
          "error",
          "Message is too large",
          "Shorten the text or attach fewer files.",
        );
        return;
      }
      if (prepared) finishSettle = beginFilesSettle(message.SendTime);

      const removed = message.Files.filter((file) =>
        removedFiles.includes(file.Content),
      ).flatMap((file) => parseChatFile(file, message.Principal)?.key ?? []);

      const settlement =
        prepared || removed.length > 0
          ? await settlements.begin(
              message.SendTime,
              keptFiles.length,
              prepared?.files ?? [],
              removed,
            )
          : undefined;

      try {
        const response = await sendChatRelay(userId, "MessageEdit", {
          ...(encryptedContent && { Content: encryptedContent }),
          ...(encryptedFiles.length > 0 && { Files: encryptedFiles }),
          SendTime: message.SendTime,
          VersionNumber: chatSecretVersion,
        });
        requireRelaySuccess(response);
      } catch (err) {
        log(1, "chat", "red", "Failed to edit message", err);
        toast("error", "Failed to edit message", String(err));
        if (isDefinitiveRelayRejection(err)) {
          await settlement?.abandon();
          return;
        }

        prepared?.complete();
        onSetEditing(false);
        settling = settlement?.settle();
        return;
      }
      prepared?.complete();
      editMessage(message.SendTime, {
        Content: text,
        Files: files,
        Edited: true,
      });
      onSetEditing(false);
      settling = settlement?.settle((statuses) =>
        editMessage(message.SendTime, {
          Files: withChatFileStatuses(files, keptFiles.length, statuses),
        }),
      );
    } finally {
      setSaving(false);
      editAttachments?.onSendingChange(false);
      if (finishSettle) void Promise.resolve(settling).then(finishSettle);
    }
  }

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
          content={chatMessagePreview(replyMessage)}
          onActivate={() => onReplyActivate(replyMessage.SendTime)}
          user={replyUser}
          variant="message"
        />
      )}
      <MessageContextMenu
        content={message.Content}
        hideMiniMenu={editing}
        isOwnMessage={isOwn}
        editable={
          !filesSettling(message.SendTime) &&
          !message.Files.some((file) => file.Status === "uploading")
        }
        messageId={message.SendTime}
        onDelete={deleteWithFiles}
        onReact={toggleReaction}
        onSetEditing={onSetEditing}
      >
        <Popover>
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
                <p className="w-10 shrink-0 self-start pt-[5px] text-xs group-hover:visible invisible text-muted-foreground">
                  {time}
                </p>
              ) : (
                <PopoverTrigger
                  disabled={!user}
                  render={
                    <button
                      type="button"
                      className="shrink-0 self-start pr-1 pt-1"
                      aria-label={
                        user ? `View ${user.Display}'s profile` : "View profile"
                      }
                    >
                      <Avatar className="size-9">
                        <AvatarImage src={user?.Avatar} />
                        <AvatarFallback className="text-md">
                          {user?.Display.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                    </button>
                  }
                />
              )}
              <div className="flex flex-col group min-w-0 flex-1">
                {!grouped && (
                  <div className="flex min-h-6 items-center gap-1">
                    {user ? (
                      <PopoverTrigger
                        render={
                          <button
                            type="button"
                            className="font-semibold"
                            aria-label={`View ${user.Display}'s profile`}
                          >
                            {user.Display}
                          </button>
                        }
                      />
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
                        onSubmit={() => void submitEdit()}
                      />
                    </Card>
                    <div className="flex min-w-0 flex-wrap items-center gap-1">
                      {editAttachments?.action(keptFiles.length)}
                      {keptFiles.map((file) => (
                        <ChatFileChip
                          key={file.Content}
                          file={file}
                          principal={message.Principal}
                          onRemove={() =>
                            setRemovedFiles((current) => [
                              ...current,
                              file.Content,
                            ])
                          }
                        />
                      ))}
                    </div>
                    <div className="flex gap-1">
                      {editEmpty ? (
                        <Button
                          size="xs"
                          variant="destructive"
                          onClick={() => void deleteWithFiles()}
                        >
                          Delete message
                        </Button>
                      ) : (
                        <Button
                          size="xs"
                          disabled={saveBlocked}
                          onClick={() => void submitEdit()}
                        >
                          Save
                        </Button>
                      )}
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
                    <div className="min-w-0 flex-1">
                      {message.Content ? (
                        isValidURL ? (
                          <Media
                            link={message.Content}
                            principal={message.Principal}
                            time={time}
                          />
                        ) : (
                          renderText(message.Content)
                        )
                      ) : message.Files.length === 0 ? (
                        <p className="text-muted-foreground">Empty message</p>
                      ) : (
                        message.Edited && renderText("")
                      )}
                      {message.Files.length > 0 && (
                        <ChatFiles
                          files={message.Files}
                          principal={message.Principal}
                        />
                      )}
                    </div>
                  </div>
                )}
                {groupedReactions.length > 0 && (
                  <div className="pt-1 flex flex-wrap gap-1 pb-1">
                    {groupedReactions.map(
                      ([reaction, { count, reactedByMe }]) => (
                        <Button
                          key={reaction}
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
          {user && (
            <PopoverContent side="bottom">
              <Profile user={user} />
            </PopoverContent>
          )}
        </Popover>
      </MessageContextMenu>
    </div>
  );
}

export default memo(MessageComponent, (prev, next) => {
  return (
    prev.message.SendTime === next.message.SendTime &&
    prev.editing === next.editing &&
    prev.highlighted === next.highlighted &&
    prev.message.Content === next.message.Content &&
    JSON.stringify(prev.message.Files) === JSON.stringify(next.message.Files) &&
    prev.message.Principal === next.message.Principal &&
    prev.message.ReplyId === next.message.ReplyId &&
    prev.message.MessageState === next.message.MessageState &&
    prev.message.failed === next.message.failed &&
    prev.message.decryptionFailed === next.message.decryptionFailed &&
    JSON.stringify(prev.message.Reactions) ===
      JSON.stringify(next.message.Reactions) &&
    prev.grouped === next.grouped &&
    prev.onReplyActivate === next.onReplyActivate &&
    prev.editAttachments === next.editAttachments
  );
});

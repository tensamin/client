import { Input, type InputController } from "@nonanium/ui/markdown";
import {
  Card,
  CardHeader,
  EmojiPicker,
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
  notify as toast,
} from "@nonanium/ui";
import { useStorage } from "@tensamin/storage/context";
import React, { useCallback, useEffect, useId, useState, useRef } from "react";
import { flushSync } from "react-dom";
import type { ComposerAttachments } from "../values";
import { Button } from "@nonanium/ui";

import { Laugh, FileVideo, SendHorizonal } from "lucide-react";
import { useChat, useComposer, useReplyMessage } from "../context";
import { useFileSettlements } from "../settlements";
import { requireRelaySuccess, useMTP } from "@tensamin/mtp";
import { isDefinitiveRelayRejection } from "@tensamin/mtp/relayResult";
import { log } from "@tensamin/shared/log";
import { cn, useIsMobile } from "@nonanium/ui";
import { encryptChatText } from "@tensamin/crypto/chatSecret";
import {
  MAX_MESSAGE_BODY_BYTES,
  messageBodyBytes,
} from "@tensamin/shared/data";
import {
  chatMessagePreview,
  encryptChatFiles,
  withChatFileStatuses,
} from "./fileMessages";

import { useSession } from "@tensamin/identity/session";
import { useEmojiRanks, useRecordEmojiUse } from "./emojiRanks";
import ReplyBox from "./replyBox";
import { useHotkey } from "@tensamin/hotkeys";
import { editLastMessageHotkey } from "../hotkeys";
import GifPicker from "./media/gifPicker";

export default function InputComponent({
  onEditLastMessage,
  uploadAction,
  attachments,
}: {
  onEditLastMessage: () => void;
  uploadAction?: React.ReactNode;
  attachments?: ComposerAttachments;
}) {
  const { value, setValue } = useComposer();
  const [invertEnterBehavior, setInvertEnterBehavior] = useState(false);
  const [sending, setSending] = useState(false);
  const submitting = useRef(false);
  const { refreshAccountState, contextReady } = useMTP();
  const settlements = useFileSettlements();

  const {
    addLiveMessage,
    chatSecret,
    chatSecretVersion,
    sendChatRelay,
    ownPrincipal,
    ownId,
    secretStatus,
    userId,
    composerController: composerRef,
    replyTo,
    setReplyTo,
    beginFilesSettle,
  } = useChat();
  const secretToastId = useId();
  const secretError =
    secretStatus.kind === "retryable" || secretStatus.kind === "terminal"
      ? secretStatus.reason
      : undefined;
  const retryConversation = useCallback(
    function retryConversation() {
      toast.dismiss(secretToastId);
      void refreshAccountState().catch((error: unknown) => {
        toast(
          "error",
          "Refreshing conversation failed",
          error instanceof Error ? error.message : String(error),
          {
            id: secretToastId,
            closeButton: true,
            duration: Infinity,
            action: { label: "Retry", onClick: retryConversation },
          },
        );
      });
    },
    [refreshAccountState, secretToastId],
  );

  useEffect(() => {
    return () => {
      toast.dismiss(secretToastId);
    };
  }, [secretToastId, userId]);

  useEffect(() => {
    if (!contextReady || chatSecret || !secretError) {
      toast.dismiss(secretToastId);

      return;
    }

    toast("error", "Loading conversation failed", secretError, {
      id: secretToastId,
      duration: Infinity,
      closeButton: true,
      action:
        secretStatus.kind === "retryable"
          ? {
              label: "Retry",
              onClick: retryConversation,
            }
          : undefined,
    });
  }, [
    chatSecret,
    contextReady,
    retryConversation,
    secretError,
    secretStatus.kind,
    secretToastId,
  ]);

  const { load, save, subscribe } = useStorage();
  const [showDesktopSendButton, setShowDesktopSendButton] = useState(false);

  useEffect(() => {
    let active = true;
    const update = () => {
      void load("settings.show_desktop_send_button").then((value) => {
        if (active) setShowDesktopSendButton(value);
      });
    };
    const unsubscribe = subscribe((keys) => {
      if (keys.includes("settings.show_desktop_send_button")) update();
    });
    update();

    return () => {
      active = false;
      unsubscribe();
    };
  }, [load, subscribe]);
  const { moveUserIdToTop } = useSession();
  const gifPopoverRef = useRef<HTMLDivElement>(null);
  const [gifPopoverOpen, setGifPopoverOpen] = useState(false);
  const [emojiPopoverOpen, setEmojiPopoverOpen] = useState(false);
  const focusComposerAfterEmojiSelect = useRef(false);
  const recordUse = useRecordEmojiUse();
  const { ranks: emojiFrequencies } = useEmojiRanks();
  const [gifPopoverSize, setGifPopoverSize] = useState<{
    width: number;
    height: number;
  }>();
  const setComposer = useCallback(
    (controller: InputController | null) => {
      composerRef.current = controller;
    },
    [composerRef],
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => composerRef.current?.focus());

    return () => cancelAnimationFrame(frame);
  }, [composerRef, userId]);

  useEffect(() => {
    if (replyTo === undefined) return;

    const frame = requestAnimationFrame(() => composerRef.current?.focus());

    return () => cancelAnimationFrame(frame);
  }, [composerRef, replyTo]);

  useEffect(() => {
    const focusComposerOnType = (event: KeyboardEvent) => {
      const composer = composerRef.current;
      const target = event.target;

      if (
        !composer ||
        composer.hasFocus() ||
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.key.length !== 1
      ) {
        return;
      }

      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest(
            'button, a[href], input, textarea, select, summary, [contenteditable], [role], [tabindex]:not([tabindex="-1"])',
          ))
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      composer.focus();
      composer.insertText(event.key);
    };

    window.addEventListener("keydown", focusComposerOnType, true);

    return () =>
      window.removeEventListener("keydown", focusComposerOnType, true);
  }, [composerRef]);

  useHotkey(editLastMessageHotkey, onEditLastMessage, {
    enabled: value.length === 0,
    ignoreInputs: false,
  });

  useEffect(() => {
    void load("settings.reverse_enter_behavior").then((shouldInvert) => {
      setInvertEnterBehavior(shouldInvert);
    });
  }, [load]);

  useEffect(() => {
    void load("chat_picker_size").then((size) => {
      if (size) {
        setGifPopoverSize(size);
      }
    });
  }, [load]);

  async function handleSubmit(content = value, preserveContent = false) {
    const queued =
      !preserveContent && attachments?.count ? attachments : undefined;
    if (
      (content.trim() === "" && !queued) ||
      !contextReady ||
      !chatSecret ||
      submitting.current ||
      queued?.busy
    )
      return;

    const time = new Date().getTime();

    if (!Number.isSafeInteger(userId) || userId <= 0) {
      toast("error", "No conversation selected");

      return;
    }

    log(3, "chat", "purple", "Message send init, adding live message ...");
    submitting.current = true;
    setSending(true);
    queued?.onSendingChange(true);

    let finishSettle: (() => void) | undefined;
    let settling: Promise<void> | undefined;
    try {
      const prepared = queued ? await queued.prepare() : undefined;
      if (queued && !prepared) {
        return;
      }
      const text = content.trim() ? content : "";
      const files = (prepared?.references ?? []).map((Content) => ({
        Content,
        Status: "uploading" as const,
      }));

      const reference = flushSync(() => {
        if (!preserveContent) setValue("");
        return addLiveMessage({
          NotEncrypted: true,
          SendTime: time,
          Content: text,
          Files: files,
          VersionNumber: chatSecretVersion,
          SenderId: ownId,
          Principal: ownPrincipal,
          MessageState: "awaiting",
          ...(replyTo && { ReplyId: replyTo }),
        });
      });

      if (prepared) finishSettle = beginFilesSettle(time);
      if (replyTo) {
        setReplyTo(undefined);
      }

      log(3, "chat", "purple", "Live message added, encrypting...");

      const encrypted = await Promise.all([
        text ? encryptChatText(chatSecret, text, chatSecretVersion) : undefined,
        encryptChatFiles(chatSecret, chatSecretVersion, files),
      ]).catch((err) => {
        toast("error", "Failed to encrypt message", String(err));
        reference.setFailed(true);
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
        reference.setFailed(true);
        return;
      }

      log(3, "chat", "purple", "Content encrypted, sending message...");

      const settlement = prepared
        ? await settlements.begin(time, 0, prepared.files)
        : undefined;
      try {
        const response = await sendChatRelay(userId, "MessageSend", {
          ...(encryptedContent && { Content: encryptedContent }),
          ...(encryptedFiles.length > 0 && { Files: encryptedFiles }),
          ReceiverId: userId,
          SendTime: time,
          VersionNumber: chatSecretVersion,
          ...(replyTo && { ReplyId: replyTo }),
        });
        requireRelaySuccess(response);
        reference.setMessageState("sending");

        prepared?.complete();
      } catch (e) {
        log(0, "Chat", "red", "Failed to send message", e, {
          ReceiverId: userId,
          SendTime: time,
        });
        reference.setFailed(true);
        toast(
          "error",
          "Failed to send message",
          e instanceof Error ? e.message : String(e),
        );

        if (isDefinitiveRelayRejection(e)) {
          await settlement?.abandon();
          return;
        }

        prepared?.complete();
        settling = settlement?.settle();
        return;
      }

      log(
        3,
        "chat",
        "purple",
        "Message relayed; awaiting synchronized acceptance",
      );

      moveUserIdToTop(userId);
      settling = settlement?.settle((statuses) =>
        reference.setFiles(withChatFileStatuses(files, 0, statuses)),
      );
    } catch (error) {
      toast("error", "Failed to prepare attachments", String(error));
    } finally {
      submitting.current = false;
      setSending(false);
      queued?.onSendingChange(false);
      if (finishSettle) void Promise.resolve(settling).then(finishSettle);
    }
  }

  function handleGifPopoverResizeStart(
    event: React.PointerEvent<HTMLDivElement>,
  ) {
    const popover = gifPopoverRef.current;

    if (!popover) return;

    event.preventDefault();
    event.stopPropagation();

    const rect = popover.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = rect.width;
    const startHeight = rect.height;
    const minSize = 40;
    const maxSize = 720;

    function clampSize(size: number) {
      return Math.min(Math.max(size, minSize), maxSize);
    }

    function handlePointerMove(moveEvent: PointerEvent) {
      const nextSize = {
        width: clampSize(startWidth + startX - moveEvent.clientX),
        height: clampSize(startHeight + startY - moveEvent.clientY),
      };

      setGifPopoverSize(nextSize);
    }

    function handlePointerUp() {
      const popover = gifPopoverRef.current;

      if (popover) {
        const rect = popover.getBoundingClientRect();

        void save("chat_picker_size", {
          width: clampSize(rect.width),
          height: clampSize(rect.height),
        });
      }

      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  const { replyMessage, replyPrincipal } = useReplyMessage();

  const isMobile = useIsMobile();
  const emojiPicker = (
    <EmojiPicker
      className={
        isMobile
          ? "max-w-none h-[min(400px,70dvh)] border-0 rounded-none"
          : "w-[400px]"
      }
      onEmojiSelect={({ shortcode }) => {
        setValue(`${value}${shortcode} `);
        recordUse(shortcode);
        focusComposerAfterEmojiSelect.current = true;
        setEmojiPopoverOpen(false);
      }}
    />
  );
  const gifPicker = (
    <GifPicker
      resizeHeight={isMobile ? undefined : gifPopoverSize?.height}
      resizeWidth={isMobile ? undefined : gifPopoverSize?.width}
      onSelect={(url) => {
        void handleSubmit(url, true);
        setGifPopoverOpen(false);
      }}
    />
  );

  return (
    <div className="flex flex-col">
      {replyTo !== undefined && (
        <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200">
          <ReplyBox
            edited={replyMessage?.Edited}
            content={replyMessage && chatMessagePreview(replyMessage)}
            loading={!replyMessage}
            onDismiss={() => setReplyTo(undefined)}
            principal={replyPrincipal}
            variant="composer"
          />
        </div>
      )}
      <Card
        data-chat-composer
        className={cn(
          "rounded-none py-0! gap-1! [&&]:border-t!",
          isMobile ? "w-full" : "rounded-t-xl [&&]:border-x! mx-5",
        )}
      >
        <CardHeader className="relative min-w-0 px-2.5 pt-2.25 pb-0 flex flex-col">
          <Input
            className="w-full"
            onControllerChange={setComposer}
            paddingY="0px"
            paddingX="0px"
            placeholder="Send a message..."
            value={value}
            setValue={setValue}
            onSubmit={handleSubmit}
            invertEnterBehavior={invertEnterBehavior}
            emojiFrequencies={emojiFrequencies}
            onEmojiSelect={recordUse}
          />
        </CardHeader>
        <div className="w-full flex items-end justify-between gap-1 px-1 pb-2">
          <div className="min-w-0 flex-1">{uploadAction}</div>
          <div className="flex shrink-0 gap-1">
            <Popover open={emojiPopoverOpen} onOpenChange={setEmojiPopoverOpen}>
              <PopoverTrigger
                render={({ onClick }) => (
                  <Button
                    aria-label="Choose an emoji"
                    onClick={onClick}
                    className="w-9 h-9! p-0"
                    variant="ghost"
                  >
                    <Laugh size={20} />
                  </Button>
                )}
              />
              <PopoverContent
                className="w-auto p-0"
                portalProps={{ keepMounted: true }}
                finalFocus={() => {
                  if (!focusComposerAfterEmojiSelect.current) return true;
                  focusComposerAfterEmojiSelect.current = false;
                  composerRef.current?.focus();

                  return false;
                }}
              >
                <PopoverTitle className="sr-only">Choose an emoji</PopoverTitle>
                {emojiPicker}
              </PopoverContent>
            </Popover>
            <Popover open={gifPopoverOpen} onOpenChange={setGifPopoverOpen}>
              <PopoverTrigger
                render={({ onClick }) => (
                  <Button
                    aria-label="Choose a GIF"
                    onClick={onClick}
                    className="w-9 h-9! p-0"
                    variant="ghost"
                  >
                    <FileVideo size={20} />
                  </Button>
                )}
              />
              <PopoverContent
                ref={gifPopoverRef}
                className={
                  isMobile
                    ? "h-[80dvh] gap-0 px-3 pb-3"
                    : "relative h-130 w-120 min-h-80 max-h-180 min-w-80 max-w-180 overflow-hidden border!"
                }
                {...(!isMobile && {
                  onTouchMoveCapture: (event) => event.stopPropagation(),
                  onWheelCapture: (event) => event.stopPropagation(),
                  style: {
                    ...gifPopoverSize,
                    maxHeight: gifPopoverSize?.height,
                  },
                })}
              >
                <PopoverTitle className="sr-only">Choose a GIF</PopoverTitle>
                {isMobile ? (
                  <div className="min-h-0 flex-1">{gifPicker}</div>
                ) : (
                  <>
                    <div
                      className="absolute left-0 top-0 z-10 h-4 w-4 cursor-nwse-resize"
                      onPointerDown={handleGifPopoverResizeStart}
                    />
                    {gifPicker}
                  </>
                )}
              </PopoverContent>
            </Popover>
            {(isMobile || showDesktopSendButton) && (
              <Button
                aria-label="Send message"
                disabled={
                  !chatSecret || !contextReady || sending || attachments?.busy
                }
                title={
                  !contextReady
                    ? "Connect before sending"
                    : !chatSecret
                      ? "Preparing conversation encryption"
                      : sending
                        ? "Sending message"
                        : attachments?.unavailableReason
                }
                onClick={() => handleSubmit(value)}
                className="w-9! h-9! shrink-0"
              >
                <SendHorizonal />
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

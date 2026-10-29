import { Input, type InputController } from "@nonanium/ui/markdown";
import {
  Card,
  CardHeader,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
  EmojiPicker,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@nonanium/ui";
import { useStorage } from "@tensamin/storage/context";
import React, { useCallback, useEffect, useState, useRef } from "react";
import { flushSync } from "react-dom";
import { Button } from "@nonanium/ui";

import { Plus, Laugh, FileVideo, SendHorizonal } from "lucide-react";
import { useChat, useReplyMessage } from "../context";
import { requireRelaySuccess, useMTP } from "@tensamin/mtp";
import { log, toast } from "@tensamin/shared/log";
import { cn, useIsMobile } from "@nonanium/ui";
import { encryptChatText } from "@tensamin/crypto/chatSecret";

import { useSession } from "@tensamin/identity/session";
import { useEmojiRanks, useRecordEmojiUse } from "./emojiRanks";
import ReplyBox from "./replyBox";
import { useHotkey } from "@tensamin/hotkeys";
import { editLastMessageHotkey } from "../hotkeys";
import { useUser } from "@tensamin/identity/context";
import GifPicker from "./media/gifPicker";

export default function InputComponent({
  value,
  setValue,
  onEditLastMessage,
}: {
  value: string;
  setValue: (value: string) => void;
  onEditLastMessage: () => void;
}) {
  const [invertEnterBehavior, setInvertEnterBehavior] = useState(false);

  const { sendSealedRelay } = useMTP();
  const { getRelayIota } = useUser();
  const {
    addLiveMessage,
    chatSecret,
    chatSecretVersion,
    userId,
    inputBoxRef,
    replyTo,
    setReplyTo,
  } = useChat();
  const { load, save } = useStorage();
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
  const composerRef = useRef<InputController | null>(null);
  const setComposer = useCallback((controller: InputController | null) => {
    composerRef.current = controller;
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [userId]);

  useEffect(() => {
    if (replyTo === undefined) return;

    const frame = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [replyTo]);

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
  }, []);

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
    if (content.trim() === "") return;

    const time = new Date().getTime();
    const currentValue = content;

    if (!Number.isSafeInteger(userId) || userId <= 0) {
      toast("error", "No conversation selected");
      return;
    }

    if (!chatSecret) {
      toast("error", "Still getting chat secret...");
      return;
    }

    log(3, "chat", "purple", "Message send init, adding live message ...");

    if (!preserveContent) {
      // Sync the editor before rendering the live message, not after it.
      flushSync(() => setValue(""));
    }

    const reference = addLiveMessage({
      NotEncrypted: true,
      SendTime: time,
      Content: currentValue,
      VersionNumber: chatSecretVersion,
      SenderId: ownId,
      MessageState: "awaiting",
      ...(replyTo && { ReplyId: replyTo }),
    });

    if (replyTo) {
      setReplyTo(undefined);
    }

    log(3, "chat", "purple", "Live message added, encrypting...");

    const encryptedContent = await encryptChatText(
      chatSecret,
      currentValue,
      chatSecretVersion,
    ).catch((err) => {
      toast("error", "Failed to encrypt message", String(err));
      reference.setFailed(true);
    });

    if (!encryptedContent) return;

    log(3, "chat", "purple", "Content encrypted, sending message...");

    try {
      const [ownIota, peerIota] = await Promise.all([
        getRelayIota(ownId),
        getRelayIota(userId),
      ]);
      const response = await sendSealedRelay(
        "MessageSend",
        {
          Content: encryptedContent,
          ReceiverId: userId,
          SendTime: time,
          VersionNumber: chatSecretVersion,
          ...(replyTo && { ReplyId: replyTo }),
        },
        {
          nextHop: { kind: "iota", id: ownIota.IotaId },
          finalRecipientId: userId,
          metadataRecipients: [
            { value: ownIota.PublicKey, encoding: "base64" },
            { value: peerIota.PublicKey, encoding: "base64" },
          ],
          contentRecipients: [
            { value: ownIota.PublicKey, encoding: "base64" },
            { value: peerIota.PublicKey, encoding: "base64" },
          ],
        },
      );
      requireRelaySuccess(response);
      reference.setMessageState("sent");
    } catch (e) {
      log(0, "Chat", "red", "Failed to send message", e, {
        ReceiverId: userId,
        SendTime: time,
      });
      reference.setFailed(true);
      toast("error", "Failed to send message");
      return;
    }

    log(3, "chat", "purple", "Message sent");

    moveUserIdToTop(userId);
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

  const { ownId, replyMessage, replyUserId } = useReplyMessage();

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
  return (
    <div className="flex flex-col">
      {/* reply */}
      {replyTo !== undefined && (
        <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200">
          <ReplyBox
            edited={replyMessage?.Edited}
            content={replyMessage?.Content}
            loading={!replyMessage}
            onDismiss={() => setReplyTo(undefined)}
            userId={replyUserId ?? ownId}
            variant="composer"
          />
        </div>
      )}
      <Card
        data-chat-composer
        ref={inputBoxRef}
        className={cn(
          "rounded-none border-1! border-b-0! border-(--input)/50! pt-0 pb-0 mx-2",
          isMobile ? "border-x-0! w-full mx-0 px-2" : "rounded-t-xl",
        )}
      >
        <CardHeader className="relative p-0 flex flex-col">
          <div className="w-full flex items-center">
            <Input
              className="w-full p-2 px-3"
              onControllerChange={setComposer}
              paddingY="13px"
              paddingX="13px"
              placeholder="Send a message..."
              value={value}
              setValue={setValue}
              onSubmit={handleSubmit}
              invertEnterBehavior={invertEnterBehavior}
              emojiFrequencies={emojiFrequencies}
              onEmojiSelect={recordUse}
            />
            <Button
              aria-label="Send message"
              onClick={() => handleSubmit(value)}
              className={cn("w-9! h-9!", isMobile ? "" : "hidden")}
            >
              <SendHorizonal />
            </Button>
          </div>
          <div className="w-full flex justify-between gap-1 p-1 pt-0">
            <div className="flex gap-1">
              <Button className="w-9 h-9! p-0" variant="ghost">
                <Plus size={20} />
              </Button>
              <div className="w-auto flex text-red-500">
                <p>Files list</p>
              </div>
            </div>
            <div className="flex gap-1">
              {isMobile ? (
                <Drawer
                  open={emojiPopoverOpen}
                  onOpenChange={setEmojiPopoverOpen}
                >
                  <DrawerTrigger asChild>
                    <Button
                      aria-label="Choose an emoji"
                      className="w-9 h-9! p-0"
                      variant="ghost"
                    >
                      <Laugh size={20} />
                    </Button>
                  </DrawerTrigger>
                  <DrawerContent
                    onCloseAutoFocus={(event) => {
                      if (!focusComposerAfterEmojiSelect.current) return;
                      event.preventDefault();
                      focusComposerAfterEmojiSelect.current = false;
                      composerRef.current?.focus();
                    }}
                  >
                    <DrawerTitle className="sr-only">
                      Choose an emoji
                    </DrawerTitle>
                    <DrawerDescription className="sr-only">
                      Select an emoji to insert into your message.
                    </DrawerDescription>
                    <div className="pt-3">{emojiPicker}</div>
                  </DrawerContent>
                </Drawer>
              ) : (
                <Popover
                  open={emojiPopoverOpen}
                  onOpenChange={setEmojiPopoverOpen}
                >
                  <PopoverTrigger
                    render={({ onClick }) => (
                      <Button
                        onClick={onClick}
                        className="w-9 h-9! p-0"
                        variant="ghost"
                      >
                        <Laugh size={20} />
                      </Button>
                    )}
                  />
                  <PopoverContent
                    className="w-auto p-0 mr-2"
                    finalFocus={() => {
                      if (!focusComposerAfterEmojiSelect.current) return true;
                      focusComposerAfterEmojiSelect.current = false;
                      composerRef.current?.focus();
                      return false;
                    }}
                  >
                    {emojiPicker}
                  </PopoverContent>
                </Popover>
              )}
              {isMobile ? (
                <Drawer open={gifPopoverOpen} onOpenChange={setGifPopoverOpen}>
                  <DrawerTrigger asChild>
                    <div>
                      <Button
                        aria-label="Choose a GIF"
                        className="w-9 h-9! p-0"
                        variant="ghost"
                      >
                        <FileVideo size={20} />
                      </Button>
                    </div>
                  </DrawerTrigger>
                  <DrawerContent className="h-[80dvh]">
                    <DrawerTitle className="sr-only">Choose a GIF</DrawerTitle>
                    <DrawerDescription className="sr-only">
                      Select a GIF to insert into your message.
                    </DrawerDescription>
                    <div className="min-h-0 flex-1 p-3">
                      <GifPicker
                        onSelect={(url) => {
                          void handleSubmit(url, true);
                          setGifPopoverOpen(false);
                        }}
                      />
                    </div>
                  </DrawerContent>
                </Drawer>
              ) : (
                <Popover open={gifPopoverOpen} onOpenChange={setGifPopoverOpen}>
                  <PopoverTrigger
                    render={({ onClick }) => (
                      <Button
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
                    className="relative h-130 w-120 min-h-80 max-h-180 min-w-80 max-w-180 overflow-hidden border!"
                    onTouchMoveCapture={(event) => event.stopPropagation()}
                    onWheelCapture={(event) => event.stopPropagation()}
                    style={{
                      ...gifPopoverSize,
                      maxHeight: gifPopoverSize?.height,
                    }}
                  >
                    <div
                      className="absolute left-0 top-0 z-10 h-4 w-4 cursor-nwse-resize"
                      onPointerDown={handleGifPopoverResizeStart}
                    />
                    <GifPicker
                      resizeHeight={gifPopoverSize?.height}
                      resizeWidth={gifPopoverSize?.width}
                      onSelect={(url) => {
                        void handleSubmit(url, true);
                        setGifPopoverOpen(false);
                      }}
                    />
                  </PopoverContent>
                </Popover>
              )}
            </div>
          </div>
        </CardHeader>
      </Card>
    </div>
  );
}

import {
  Button,
  Card,
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  EmojiPicker,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useIsMobile,
} from "@nonanium/ui";
import {
  Clipboard,
  Ellipsis,
  Forward,
  Laugh,
  Pen,
  Pin,
  Reply,
  Trash,
} from "lucide-react";
import {
  cloneElement,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal, flushSync } from "react-dom";
import type {
  MouseEvent as ReactMouseEvent,
  ReactElement,
  ReactNode,
  Ref,
} from "react";
import { useChat } from "../context";
import { Emoji } from "@nonanium/ui/markdown";
import { getRecentEmojis, useEmojiRanks } from "./emojiRanks";
import { toast } from "@tensamin/shared/log";

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("success", "Copied to clipboard");
  } catch (error) {
    toast("error", "Failed to copy", String(error));
  }
}

let shiftPressed = false;
const shiftListeners = new Set<() => void>();

function setShiftPressed(value: boolean) {
  if (shiftPressed === value) return;

  shiftPressed = value;
  shiftListeners.forEach((listener) => listener());
}

function subscribeToShift(listener: () => void) {
  shiftListeners.add(listener);

  if (shiftListeners.size === 1) {
    window.addEventListener("keydown", handleShiftKey);
    window.addEventListener("keyup", handleShiftKey);
    window.addEventListener("blur", handleWindowBlur);
  }

  return () => {
    shiftListeners.delete(listener);
    if (shiftListeners.size === 0) {
      window.removeEventListener("keydown", handleShiftKey);
      window.removeEventListener("keyup", handleShiftKey);
      window.removeEventListener("blur", handleWindowBlur);
      shiftPressed = false;
    }
  };
}

function handleShiftKey(event: KeyboardEvent) {
  setShiftPressed(event.shiftKey);
}

function handleWindowBlur() {
  setShiftPressed(false);
}

function useShiftPressed() {
  return useSyncExternalStore(
    subscribeToShift,
    () => shiftPressed,
    () => false,
  );
}

function MiniMenuTooltip({
  children,
  label,
}: {
  children: ReactElement<{
    onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
    ref?: Ref<HTMLElement>;
  }>;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={({ ref, onClick }) =>
          cloneElement(children, {
            ref,
            onClick: (event) => {
              onClick?.(event);
              children.props.onClick?.(event);
            },
          })
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function MiniMessageMenu({
  editable,
  fadeOut,
  isOwnMessage,
  onDelete,
  onEdit,
  onOpenMenu,
  onPointerEnter,
  onPointerLeave,
  onReact,
  quickReactions,
  onReply,
  shiftIsPressed,
}: {
  editable: boolean;
  fadeOut: boolean;
  isOwnMessage: boolean;
  onDelete: () => void;
  onEdit: () => void;
  onOpenMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onReact: (emoji: string) => void;
  quickReactions: string[];
  onReply: () => void;
  shiftIsPressed: boolean;
}) {
  return (
    <div
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={`absolute right-4 -top-3 z-10 transition-opacity duration-50 ${fadeOut ? "opacity-0" : "opacity-100"}`}
    >
      <Card className="border! flex flex-row justify-end gap-0.5! rounded-lg! p-0.5! shadow-lg">
        {quickReactions.map((emoji) => (
          <MiniMenuTooltip
            key={emoji}
            label={emoji}
            children={
              <Button
                variant="ghost"
                className="h-8 w-8 p-0!"
                onClick={() => onReact(emoji)}
              >
                <Emoji className="h-5 w-5" shortcode={emoji} tooltip={false} />
              </Button>
            }
          />
        ))}
        <Separator orientation="vertical" className="my-1" />
        <MiniMenuTooltip
          label="Add reaction"
          children={
            <PopoverTrigger
              render={({ onClick }) => (
                <Button onClick={onClick} variant="ghost" className="h-8 w-8">
                  <Laugh />
                </Button>
              )}
            />
          }
        />
        <MiniMenuTooltip
          label={isOwnMessage ? "Edit message" : "Reply to message"}
          children={
            <Button
              variant="ghost"
              className="h-8 w-8"
              disabled={isOwnMessage && !editable}
              onClick={isOwnMessage ? onEdit : onReply}
            >
              {isOwnMessage ? <Pen /> : <Reply />}
            </Button>
          }
        />
        <MiniMenuTooltip
          label="Forward message"
          children={
            <Button variant="ghost" className="h-8 w-8">
              <Forward />
            </Button>
          }
        />
        <Separator orientation="vertical" className="my-1" />
        {isOwnMessage && shiftIsPressed ? (
          <MiniMenuTooltip
            label="Delete message"
            children={
              <Button
                variant="ghost"
                className="h-8 w-8 text-destructive"
                onClick={onDelete}
              >
                <Trash />
              </Button>
            }
          />
        ) : (
          <MiniMenuTooltip
            label="Open message menu"
            children={
              <Button variant="ghost" className="h-8 w-8" onClick={onOpenMenu}>
                <Ellipsis />
              </Button>
            }
          />
        )}
      </Card>
    </div>
  );
}

function MessageMenuContent({
  content,
  devEnabled,
  editable,
  isOwnMessage,
  messageId,
  onAddReaction,
  onDelete,
  reactionEmojis,
  onReact,
  showReactionItems = true,
  onSetEditing,
}: {
  content: string;
  devEnabled: boolean;
  editable: boolean;
  isOwnMessage: boolean;
  messageId: number;
  onAddReaction?: () => void | Promise<void>;
  onDelete: () => Promise<void>;
  reactionEmojis: string[];
  onReact: (emoji: string) => void;
  showReactionItems?: boolean;
  onSetEditing: (value: boolean) => void;
}) {
  const { setReplyTo } = useChat();

  return (
    <ContextMenuContent>
      <ContextMenuGroup>
        {showReactionItems ? (
          <ContextMenuSub>
            <ContextMenuSubTrigger>Add Reaction</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {reactionEmojis.map((emoji) => (
                <ContextMenuItem key={emoji} onClick={() => onReact(emoji)}>
                  <Emoji className="w-4.5 h-4.5" shortcode={emoji} />
                  <span>{emoji}</span>
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        ) : (
          <ContextMenuItem onClick={onAddReaction}>
            Add Reaction
          </ContextMenuItem>
        )}
        <ContextMenuItem disabled className="flex justify-between">
          <p>Pin Message</p> <Pin />
        </ContextMenuItem>
        <ContextMenuItem
          className="flex justify-between"
          onClick={() => copyText(content)}
        >
          <p>Copy Raw</p> <Clipboard />
        </ContextMenuItem>
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <ContextMenuGroup>
        {isOwnMessage && (
          <ContextMenuItem
            className="flex justify-between"
            disabled={!editable}
            onClick={() => {
              onSetEditing(true);
            }}
          >
            <p>Edit Message</p> <Pen />
          </ContextMenuItem>
        )}
        <ContextMenuItem
          className="flex justify-between"
          onClick={() => {
            setReplyTo(messageId);
          }}
        >
          <p>Reply</p> <Reply />
        </ContextMenuItem>
        <ContextMenuItem disabled className="flex justify-between">
          <p>Forward</p> <Forward />
        </ContextMenuItem>
      </ContextMenuGroup>
      {isOwnMessage && (
        <>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem
              variant="destructive"
              className="flex justify-between"
              onClick={() => void onDelete()}
            >
              <p>Delete Message</p> <Trash />
            </ContextMenuItem>
          </ContextMenuGroup>
        </>
      )}
      {devEnabled && (
        <>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem
              className="flex justify-between"
              onClick={() => copyText(String(messageId))}
            >
              <p>Copy ID</p> <Clipboard />
            </ContextMenuItem>
          </ContextMenuGroup>
        </>
      )}
    </ContextMenuContent>
  );
}

type MessageMenuTarget = {
  element: HTMLDivElement;
  content: string;
  hideMiniMenu?: boolean;
  isOwnMessage: boolean;
  editable: boolean;
  messageId: number;
  onDelete: () => Promise<void>;
  onReact: (emoji: string) => void | Promise<void>;
  onSetEditing: (value: boolean) => void;
};

const MessageMenuContext = createContext<{
  activate: (target: MessageMenuTarget, force?: boolean) => void;
  leave: () => void;
  release: (element: HTMLDivElement) => void;
} | null>(null);

export default function MessageContextMenu({
  children,
  ...props
}: Omit<MessageMenuTarget, "element"> & { children: ReactElement }) {
  const menu = useContext(MessageMenuContext);
  if (!menu) throw new Error("Message menus require MessageMenuProvider");
  const elementRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (elementRef.current)
      menu.activate({ element: elementRef.current, ...props }, false);
  }, [menu, props]);
  useEffect(() => {
    const element = elementRef.current;
    return () => {
      if (element) menu.release(element);
    };
  }, [menu]);

  return (
    <ContextMenuTrigger
      render={
        <div
          ref={elementRef}
          className="group/message-menu relative w-full"
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse")
              menu.activate({ element: event.currentTarget, ...props }, true);
          }}
          onTouchStartCapture={(event) => {
            menu.activate({ element: event.currentTarget, ...props }, true);
          }}
          onPointerLeave={menu.leave}
          onContextMenuCapture={(event) => {
            flushSync(() =>
              menu.activate({ element: event.currentTarget, ...props }, true),
            );
          }}
        >
          {children}
        </div>
      }
    />
  );
}

export function MessageMenuProvider({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const shiftIsPressed = useShiftPressed();
  const { setReplyTo } = useChat();
  const devEnabled = useMemo(
    () => Number(localStorage.getItem("log_level")) >= 3,
    [],
  );
  const [target, setTarget] = useState<MessageMenuTarget | null>(null);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerClosing, setPickerClosing] = useState(false);
  const [fadeMiniMenu, setFadeMiniMenu] = useState(false);
  const [hovered, setHovered] = useState(false);
  const closeTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const locked = useRef(false);
  useLayoutEffect(() => {
    locked.current =
      contextMenuOpen || reactionPickerOpen || pickerOpen || pickerClosing;
  }, [contextMenuOpen, reactionPickerOpen, pickerOpen, pickerClosing]);
  const menu = useMemo(
    () => ({
      activate(next: MessageMenuTarget, force = false) {
        if (force) {
          clearTimeout(closeTimeout.current);
          setHovered(true);
        }
        setTarget((current) => {
          if (current?.element === next.element) return next;
          return force && !locked.current ? next : current;
        });
      },
      leave() {
        clearTimeout(closeTimeout.current);
        closeTimeout.current = setTimeout(() => setHovered(false), 80);
      },
      release(element: HTMLDivElement) {
        setTarget((current) => (current?.element === element ? null : current));
      },
    }),
    [],
  );
  useEffect(() => () => clearTimeout(closeTimeout.current), []);
  useEffect(() => {
    if (target) return;
    setContextMenuOpen(false);
    setReactionPickerOpen(false);
    setPickerOpen(false);
    setPickerClosing(false);
  }, [target]);
  const { ranks } = useEmojiRanks();
  const quickReactions = getRecentEmojis(ranks, 3);
  const menuReactions = getRecentEmojis(ranks, 5);

  function setPickerVisibility(open: boolean) {
    setPickerOpen(open);
    setPickerClosing(!isMobile && pickerOpen && !open);
  }
  function selectReaction(emoji: string) {
    void target?.onReact(emoji);
    setHovered(false);
    setReactionPickerOpen(false);
    setPickerVisibility(false);
  }
  const content = target && (
    <MessageMenuContent
      content={target.content}
      devEnabled={devEnabled}
      editable={target.editable}
      isOwnMessage={target.isOwnMessage}
      messageId={target.messageId}
      onAddReaction={() => setReactionPickerOpen(true)}
      onDelete={target.onDelete}
      onReact={selectReaction}
      reactionEmojis={menuReactions}
      showReactionItems={!isMobile}
      onSetEditing={target.onSetEditing}
    />
  );

  return (
    <MessageMenuContext value={menu}>
      <Popover
        open={pickerOpen}
        onOpenChange={(open, details) => {
          setPickerVisibility(open);
          setFadeMiniMenu(!open && details.reason === "outside-press");
        }}
        onOpenChangeComplete={(open) => {
          if (!open) {
            setPickerClosing(false);
            setFadeMiniMenu(false);
          }
        }}
      >
        <ContextMenu open={contextMenuOpen} onOpenChange={setContextMenuOpen}>
          {children}
          {content}
          {!isMobile &&
            target &&
            !target.hideMiniMenu &&
            (hovered || contextMenuOpen || pickerOpen || pickerClosing) &&
            createPortal(
              <MiniMessageMenu
                editable={target.editable}
                fadeOut={fadeMiniMenu}
                isOwnMessage={target.isOwnMessage}
                onPointerEnter={() => menu.activate(target, true)}
                onPointerLeave={menu.leave}
                onDelete={target.onDelete}
                onEdit={() => target.onSetEditing(true)}
                onOpenMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  target.element.dispatchEvent(
                    new MouseEvent("contextmenu", {
                      bubbles: true,
                      button: 2,
                      clientX: event.clientX,
                      clientY: event.clientY,
                    }),
                  );
                }}
                onReact={(emoji) => {
                  void target.onReact(emoji);
                }}
                quickReactions={quickReactions}
                onReply={() => setReplyTo(target.messageId)}
                shiftIsPressed={shiftIsPressed}
              />,
              target.element,
            )}
        </ContextMenu>
        {!isMobile && (
          <PopoverContent
            className="w-auto p-0"
            portalProps={{ keepMounted: true }}
          >
            <EmojiPicker
              className="w-[410px] h-[390px]!"
              onEmojiSelect={({ shortcode }) => selectReaction(shortcode)}
            />
          </PopoverContent>
        )}
      </Popover>
      {isMobile && (
        <Dialog open={reactionPickerOpen} onOpenChange={setReactionPickerOpen}>
          <DialogContent showCloseButton={false} finalFocus={false}>
            <DialogTitle className="sr-only">Add reaction</DialogTitle>
            <DialogDescription className="sr-only">
              Choose a reaction to add to this message.
            </DialogDescription>
            <div className="flex flex-col">
              {menuReactions.map((emoji) => (
                <Button
                  key={emoji}
                  variant="ghost"
                  className="justify-start"
                  onClick={() => selectReaction(emoji)}
                >
                  <Emoji className="w-4.5 h-4.5" shortcode={emoji} />
                  <span>{emoji}</span>
                </Button>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </MessageMenuContext>
  );
}

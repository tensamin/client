import {
  Button,
  Card,
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
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

type MenuComponents = {
  Content: (props: { className?: string; children: ReactNode }) => ReactElement;
  Group: (props: { children: ReactNode }) => ReactElement;
  Item: (props: {
    children: ReactNode;
    className?: string;
    disabled?: boolean;
    onClick?: () => void | Promise<void>;
    variant?: "default" | "destructive";
  }) => ReactElement;
  Separator: (props: { className?: string }) => ReactElement;
  Sub: (props: { children: ReactNode }) => ReactElement;
  SubTrigger: (props: {
    children: ReactNode;
    onClick?: () => void | Promise<void>;
  }) => ReactElement;
  SubContent: (props: { children: ReactNode }) => ReactElement;
};

function blurActiveElement() {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

const desktopMenuComponents: MenuComponents = {
  Content: ContextMenuContent,
  Group: ContextMenuGroup,
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};

function getMobileMenuComponents({
  description,
  onClose,
  title,
}: {
  description: string;
  onClose: () => void;
  title: string;
}): MenuComponents {
  return {
    Content: ({ className, children }) => (
      <DrawerContent
        onCloseAutoFocus={(event) => {
          if (document.activeElement?.closest(".cm-content")) {
            event.preventDefault();
          }
        }}
      >
        <DrawerTitle className="sr-only">{title}</DrawerTitle>
        <DrawerDescription className="sr-only">{description}</DrawerDescription>
        <div className={cn("p-3!", className)}>{children}</div>
      </DrawerContent>
    ),
    Group: ({ children }) => <div>{children}</div>,
    Item: ({ children, className, disabled, onClick, variant = "default" }) => {
      async function handleClick() {
        blurActiveElement();
        onClose();
        await onClick?.();
      }

      return (
        <button
          type="button"
          disabled={disabled}
          data-variant={variant}
          className={cn(
            "relative flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-2 text-left text-sm outline-hidden select-none data-[variant=destructive]:text-destructive disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive",
            className,
          )}
          onClick={handleClick}
        >
          {children}
        </button>
      );
    },
    Separator: ({ className }) => (
      <div className={cn("-mx-1 my-1 h-px bg-border", className)} />
    ),
    Sub: ({ children }) => <div>{children}</div>,
    SubTrigger: ({ children, onClick }) => {
      async function handleClick() {
        blurActiveElement();
        onClose();
        await onClick?.();
      }

      return (
        <button
          type="button"
          className="flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-2 text-left text-sm outline-hidden select-none"
          onClick={handleClick}
        >
          {children}
        </button>
      );
    },
    SubContent: ({ children }) => <div className="pl-3">{children}</div>,
  };
}

function ReactionItems({
  Item,
  emojis,
  onSelect,
}: {
  Item: MenuComponents["Item"];
  emojis: string[];
  onSelect: (emoji: string) => void;
}) {
  return emojis.map((emoji) => (
    <Item key={emoji} onClick={() => onSelect(emoji)}>
      <Emoji className="w-4.5 h-4.5" shortcode={emoji} />
      <span>{emoji}</span>
    </Item>
  ));
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
  components,
  content,
  devEnabled,
  isOwnMessage,
  messageId,
  onAddReaction,
  reactionEmojis,
  onReact,
  showReactionItems = true,
  onSetEditing,
}: {
  components: MenuComponents;
  content: string;
  devEnabled: boolean;
  isOwnMessage: boolean;
  messageId: number;
  onAddReaction?: () => void | Promise<void>;
  reactionEmojis: string[];
  onReact: (emoji: string) => void;
  showReactionItems?: boolean;
  onSetEditing: (value: boolean) => void;
}) {
  const { Content, Group, Item, Separator, Sub, SubContent, SubTrigger } =
    components;

  const { deleteMessage, setReplyTo } = useChat();

  return (
    <Content>
      <Group>
        <Sub>
          <SubTrigger onClick={showReactionItems ? undefined : onAddReaction}>
            Add Reaction
          </SubTrigger>
          {showReactionItems && (
            <SubContent>
              <ReactionItems
                Item={Item}
                emojis={reactionEmojis}
                onSelect={onReact}
              />
            </SubContent>
          )}
        </Sub>
        <Item disabled className="flex justify-between">
          <p>Pin Message</p> <Pin />
        </Item>
        <Item
          className="flex justify-between"
          onClick={() => copyText(content)}
        >
          <p>Copy Raw</p> <Clipboard />
        </Item>
      </Group>
      <Separator />
      <Group>
        {isOwnMessage && (
          <Item
            className="flex justify-between"
            onClick={() => {
              onSetEditing(true);
            }}
          >
            <p>Edit Message</p> <Pen />
          </Item>
        )}
        <Item
          className="flex justify-between"
          onClick={() => {
            setReplyTo(messageId);
          }}
        >
          <p>Reply</p> <Reply />
        </Item>
        <Item disabled className="flex justify-between">
          <p>Forward</p> <Forward />
        </Item>
      </Group>
      {isOwnMessage && (
        <>
          <Separator />
          <Group>
            <Item
              variant="destructive"
              className="flex justify-between"
              onClick={() => deleteMessage(messageId)}
            >
              <p>Delete Message</p> <Trash />
            </Item>
          </Group>
        </>
      )}
      {devEnabled && (
        <>
          <Separator />
          <Group>
            <Item
              className="flex justify-between"
              onClick={() => copyText(String(messageId))}
            >
              <p>Copy ID</p> <Clipboard />
            </Item>
          </Group>
        </>
      )}
    </Content>
  );
}

type MessageMenuTarget = {
  element: HTMLDivElement;
  content: string;
  hideMiniMenu?: boolean;
  isOwnMessage: boolean;
  messageId: number;
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
  const { deleteMessage, setReplyTo } = useChat();
  const devEnabled = useMemo(
    () => Number(localStorage.getItem("log_level")) >= 3,
    [],
  );
  const [target, setTarget] = useState<MessageMenuTarget | null>(null);
  const [mainDrawerOpen, setMainDrawerOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [reactionDrawerOpen, setReactionDrawerOpen] = useState(false);
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
      contextMenuOpen ||
      mainDrawerOpen ||
      reactionDrawerOpen ||
      pickerOpen ||
      pickerClosing;
  }, [
    contextMenuOpen,
    mainDrawerOpen,
    reactionDrawerOpen,
    pickerOpen,
    pickerClosing,
  ]);
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
    setMainDrawerOpen(false);
    setReactionDrawerOpen(false);
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
    setReactionDrawerOpen(false);
    setPickerVisibility(false);
  }
  const mainDrawerComponents = useMemo(
    () =>
      getMobileMenuComponents({
        description: "Actions available for this message.",
        onClose: () => setMainDrawerOpen(false),
        title: "Message actions",
      }),
    [],
  );
  const reactionDrawerComponents = useMemo(
    () =>
      getMobileMenuComponents({
        description: "Choose a reaction to add to this message.",
        onClose: () => setReactionDrawerOpen(false),
        title: "Add reaction",
      }),
    [],
  );
  const content = target && (
    <MessageMenuContent
      components={isMobile ? mainDrawerComponents : desktopMenuComponents}
      content={target.content}
      devEnabled={devEnabled}
      isOwnMessage={target.isOwnMessage}
      messageId={target.messageId}
      onAddReaction={() => setReactionDrawerOpen(true)}
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
        <ContextMenu
          open={contextMenuOpen}
          onOpenChange={(open) => {
            if (isMobile) {
              setMainDrawerOpen(open);
              return;
            }
            setContextMenuOpen(open);
          }}
        >
          {children}
          {!isMobile && content}
          {!isMobile &&
            target &&
            !target.hideMiniMenu &&
            (hovered || contextMenuOpen || pickerOpen || pickerClosing) &&
            createPortal(
              <MiniMessageMenu
                fadeOut={fadeMiniMenu}
                isOwnMessage={target.isOwnMessage}
                onPointerEnter={() => menu.activate(target, true)}
                onPointerLeave={menu.leave}
                onDelete={() => deleteMessage(target.messageId)}
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
        <>
          <Drawer open={mainDrawerOpen} onOpenChange={setMainDrawerOpen}>
            {content}
          </Drawer>
          <Drawer
            open={reactionDrawerOpen}
            onOpenChange={setReactionDrawerOpen}
          >
            <DrawerContent>
              <DrawerTitle className="sr-only">Add reaction</DrawerTitle>
              <DrawerDescription className="sr-only">
                Choose a reaction to add to this message.
              </DrawerDescription>
              <div className="p-3!">
                <ReactionItems
                  Item={reactionDrawerComponents.Item}
                  emojis={menuReactions}
                  onSelect={selectReaction}
                />
              </div>
            </DrawerContent>
          </Drawer>
        </>
      )}
    </MessageMenuContext>
  );
}

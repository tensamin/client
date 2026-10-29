import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";

import InputComponent from "./components/input";
import Message from "./components/message";
import { useChat } from "./context";
import {
  PAGE_SIZE,
  FALLBACK_MESSAGE_HEIGHT,
  MESSAGES_PER_VIRTUAL_ROW,
  type LiveMessage,
  type RawMessage,
} from "./values";
import Wrapper from "@tensamin/identity/wrapper";
import { useMTP } from "@tensamin/mtp";
import { useTheme } from "@nonanium/ui";
import { GlobeOff, PartyPopper } from "lucide-react";
import { chatBackgroundStyle, useChatBackground } from "./backgrounds";
import { toast } from "@tensamin/shared/log";

function shouldFetchPreviousPage({
  entry,
  hasNextPage,
  isFetchingNextPage,
  userScrolledUp,
}: {
  entry: IntersectionObserverEntry | undefined;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  userScrolledUp: boolean;
}) {
  return [
    entry?.isIntersecting === true,
    userScrolledUp,
    hasNextPage,
    !isFetchingNextPage,
  ].every(Boolean);
}

function getMessageRenderKey(message: RawMessage | LiveMessage) {
  return "localId" in message ? message.localId : String(message.SendTime);
}

function isSameDay(first: number | Date, second: number | Date) {
  const firstDate = new Date(first);
  const secondDate = new Date(second);

  return (
    firstDate.getFullYear() === secondDate.getFullYear() &&
    firstDate.getMonth() === secondDate.getMonth() &&
    firstDate.getDate() === secondDate.getDate()
  );
}

function formatMessageDate(sendTime: number) {
  const date = new Date(sendTime);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (isSameDay(date, today)) {
    return "Today";
  }

  if (isSameDay(date, yesterday)) {
    return "Yesterday";
  }

  const day = String(date.getDate()).padStart(2, "0");
  const month = date.toLocaleString([], { month: "long" });
  return `${day} ${month} ${date.getFullYear()}`;
}

function DateSeparator({ label }: { label: string }) {
  return (
    <div className="my-3 flex w-full items-center gap-3 px-3">
      <div className="h-px flex-1 bg-border" />
      <span className="shrink-0 text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function NewMessagesSeparator() {
  return (
    <div className="my-3 flex w-full items-center gap-3 px-3">
      <div className="h-px flex-1 bg-(--destructive)" />
      <span className="shrink-0 text-xs font-medium text-destructive">
        New messages
      </span>
      <div className="h-px flex-1 bg-(--destructive)" />
    </div>
  );
}

function buildMessageChunks(
  messages: Array<RawMessage | LiveMessage>,
  keyPrefix: string,
  startOffset = 0,
  chunkSize = MESSAGES_PER_VIRTUAL_ROW,
) {
  const chunks: {
    key: string;
    messages: Array<RawMessage | LiveMessage>;
    startIndex: number;
  }[] = [];

  for (let end = messages.length; end > 0; end -= chunkSize) {
    const start = Math.max(0, end - chunkSize);
    const chunkMessages = messages.slice(start, end);
    const firstMessage = chunkMessages[0];

    if (firstMessage) {
      chunks.push({
        key: `${keyPrefix}-${getMessageRenderKey(firstMessage)}`,
        messages: chunkMessages,
        startIndex: startOffset + start,
      });
    }
  }

  return chunks;
}

/**
 * Renders the chat screen with virtualized history and live message updates.
 * @returns Chat screen JSX.
 */
export default function Screen() {
  const {
    getMessages,
    liveMessages,
    newMessageCount,
    newMessagesStart,
    setNewMessagesStart,
    userId,
    chatSecret,
    ownId,
    inputBoxRef,
    composerValue,
    setComposerValue,
  } = useChat();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const didInitialScrollRef = useRef(false);
  const userScrolledUpRef = useRef(false);
  const isAtBottomRef = useRef(true);
  const smoothScrollFrameRef = useRef<number | null>(null);
  const smoothScrollTargetRef = useRef(0);
  const hasNextPageRef = useRef(false);
  const isFetchingNextPageRef = useRef(false);
  const fetchNextPageRef = useRef<(() => void) | null>(null);
  const replyJumpLoadingRef = useRef(false);

  const [lastLiveMessageCount, setLastLiveMessageCount] = useState(0);
  const [didInitialScroll, setDidInitialScroll] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [composerHeight, setComposerHeight] = useState(0);
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null);
  const [pendingJump, setPendingJump] = useState<{
    sendTime: number;
    minimumLoaded: number;
  } | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<
    number | null
  >(null);
  const previousEditingMessageIdRef = useRef<number | null>(null);

  const hasValidChatUser = Number.isSafeInteger(userId) && userId > 0;
  const hasChatSecret = chatSecret !== null;
  const { background, imageUrl, animateImage } = useChatBackground(userId);
  const { resolvedPolarity } = useTheme();

  const { readyState, send } = useMTP();

  useEffect(() => {
    const previousEditingMessageId = previousEditingMessageIdRef.current;
    previousEditingMessageIdRef.current = editingMessageId;
    if (previousEditingMessageId === null || editingMessageId !== null) return;

    const frame = requestAnimationFrame(() => {
      inputBoxRef.current
        ?.querySelector<HTMLElement>(".cm-content")
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [editingMessageId, inputBoxRef]);

  const messagesQuery = useInfiniteQuery({
    queryKey: ["chat-messages", String(userId), hasChatSecret],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getMessages(PAGE_SIZE, Number(pageParam)),
    enabled: hasValidChatUser && hasChatSecret,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length < PAGE_SIZE && allPages.length > 1) {
        return undefined;
      }

      return allPages.reduce((count, page) => count + page.length, 0);
    },
  });
  const {
    fetchNextPage: fetchMessagesNextPage,
    hasNextPage: hasMessagesNextPage,
    isFetchingNextPage: isFetchingMessagesNextPage,
  } = messagesQuery;

  useEffect(() => {
    hasNextPageRef.current = hasMessagesNextPage;
    isFetchingNextPageRef.current = isFetchingMessagesNextPage;
    fetchNextPageRef.current = () => {
      void fetchMessagesNextPage();
    };
  }, [fetchMessagesNextPage, hasMessagesNextPage, isFetchingMessagesNextPage]);

  useEffect(() => {
    didInitialScrollRef.current = false;
    userScrolledUpRef.current = false;
    isAtBottomRef.current = true;
    setDidInitialScroll(false);
    setLastLiveMessageCount(0);
    setEditingMessageId(null);
    setPendingJump(null);
    setHighlightedMessageId(null);
  }, [userId]);

  const historicalMessages = useMemo(() => {
    const pages = messagesQuery.data?.pages ?? [];
    const seenSendTimes = new Set<number>();
    const dedupedMessages: RawMessage[] = [];

    for (const message of [...pages].reverse().flat()) {
      if (seenSendTimes.has(message.SendTime)) {
        continue;
      }

      seenSendTimes.add(message.SendTime);
      dedupedMessages.push(message);
    }

    return dedupedMessages;
  }, [messagesQuery.data]);

  const liveMessagesSnapshot = liveMessages();

  const liveWithoutDuplicates = useMemo(() => {
    const historicalSendTimes = new Set(
      historicalMessages.map((message) => message.SendTime),
    );

    return liveMessagesSnapshot.filter(
      (message) => !historicalSendTimes.has(message.SendTime),
    );
  }, [historicalMessages, liveMessagesSnapshot]);

  const messages = useMemo(() => {
    return [...historicalMessages, ...liveWithoutDuplicates].sort(
      (first, second) => first.SendTime - second.SendTime,
    );
  }, [historicalMessages, liveWithoutDuplicates]);

  const pendingNewMessagesStart = useMemo(() => {
    if (newMessagesStart !== null || newMessageCount === 0) return null;
    const incomingMessages = messages.filter(
      (message) => message.SenderId === userId,
    );
    if (incomingMessages.length >= newMessageCount) {
      return incomingMessages[incomingMessages.length - newMessageCount]
        ?.SendTime;
    }
    if (messagesQuery.hasNextPage === false) {
      return incomingMessages[0]?.SendTime ?? null;
    }
    return null;
  }, [
    messages,
    messagesQuery.hasNextPage,
    newMessageCount,
    newMessagesStart,
    userId,
  ]);

  useEffect(() => {
    if (pendingNewMessagesStart !== null) {
      setNewMessagesStart(userId, pendingNewMessagesStart);
    }
  }, [pendingNewMessagesStart, setNewMessagesStart, userId]);

  const messageChunks = useMemo(() => {
    return buildMessageChunks(messages, "messages", 0, 1);
  }, [messages]);

  const virtualRowCount = messageChunks.length;

  const getItemKey = useCallback(
    (index: number) => messageChunks[index]?.key ?? index,
    [messageChunks],
  );

  const estimateSize = useCallback(() => FALLBACK_MESSAGE_HEIGHT, []);

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: virtualRowCount,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize,
    overscan: 2,
    paddingStart: composerHeight + 20,
  });
  const totalSize = virtualizer.getTotalSize();
  const contentHeight = Math.max(totalSize, viewportHeight);

  const jumpToReply = useCallback(
    async (sendTime: number) => {
      if (replyJumpLoadingRef.current) return;
      if (messages.some((message) => message.SendTime === sendTime)) {
        setPendingJump({ sendTime, minimumLoaded: 0 });
        return;
      }

      replyJumpLoadingRef.current = true;
      try {
        const response = await send("MessageGet", {
          SendTime: sendTime,
          ChatPartnerId: userId,
        });
        const offset = response.data.Offset;
        if (
          offset === undefined ||
          !Number.isSafeInteger(offset) ||
          offset < 0
        ) {
          throw new Error("MessageGet omitted a valid Offset");
        }

        let loaded = new Set(
          (messagesQuery.data?.pages ?? [])
            .flat()
            .map((message) => message.SendTime),
        ).size;
        let hasNextPage = messagesQuery.hasNextPage;
        while (loaded <= offset) {
          if (!hasNextPage) {
            throw new Error("Message history ended before the reply target");
          }
          const result = await messagesQuery.fetchNextPage({
            cancelRefetch: false,
          });
          if (result.isError) throw result.error;
          loaded = new Set(
            (result.data?.pages ?? [])
              .flat()
              .map((message) => message.SendTime),
          ).size;
          hasNextPage = result.hasNextPage;
        }

        setPendingJump({ sendTime, minimumLoaded: offset + 1 });
      } catch (error) {
        toast("error", "Couldn't jump to replied message", String(error));
      } finally {
        replyJumpLoadingRef.current = false;
      }
    },
    [messages, messagesQuery, send, userId],
  );

  useEffect(() => {
    if (pendingJump === null) return;
    const chunkIndex = messageChunks.findIndex((chunk) =>
      chunk.messages.some(
        (message) => message.SendTime === pendingJump.sendTime,
      ),
    );
    if (chunkIndex === -1) {
      const loaded = new Set(
        (messagesQuery.data?.pages ?? [])
          .flat()
          .map((message) => message.SendTime),
      ).size;
      if (
        messagesQuery.isFetchingNextPage ||
        (loaded < pendingJump.minimumLoaded &&
          messagesQuery.hasNextPage !== false)
      ) {
        return;
      }

      setPendingJump(null);
      toast("error", "Couldn't jump to replied message");
      return;
    }

    virtualizer.scrollToIndex(chunkIndex, { align: "center" });
    setHighlightedMessageId(pendingJump.sendTime);
    setPendingJump(null);
  }, [messageChunks, messagesQuery, pendingJump, virtualizer]);

  useEffect(() => {
    if (highlightedMessageId === null) return;
    const timeout = window.setTimeout(
      () => setHighlightedMessageId(null),
      1600,
    );
    return () => window.clearTimeout(timeout);
  }, [highlightedMessageId]);

  const editLastMessage = useCallback(() => {
    if (editingMessageId !== null) return;
    const message = [...messages]
      .reverse()
      .find(
        (candidate) =>
          candidate.SenderId === ownId &&
          candidate.Content.length > 0 &&
          candidate.MessageState !== "awaiting" &&
          !("failed" in candidate && candidate.failed) &&
          !("decryptionFailed" in candidate && candidate.decryptionFailed),
      );
    if (!message) return;

    const chunkIndex = messageChunks.findIndex((chunk) =>
      chunk.messages.some(
        (candidate) => candidate.SendTime === message.SendTime,
      ),
    );
    const chunkIsRendered = virtualizer
      .getVirtualItems()
      .some(({ index }) => index === chunkIndex);
    if (chunkIndex >= 0 && !chunkIsRendered) {
      virtualizer.scrollToIndex(chunkIndex, { align: "center" });
    }
    setEditingMessageId(message.SendTime);
  }, [editingMessageId, messageChunks, messages, ownId, virtualizer]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }

    const updateViewportHeight = () => {
      setViewportHeight(element.clientHeight);
    };

    updateViewportHeight();

    const observer = new ResizeObserver(updateViewportHeight);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [readyState]);

  useLayoutEffect(() => {
    const element = composerRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }

    const updateComposerHeight = () => {
      setComposerHeight(element.getBoundingClientRect().height);
    };

    updateComposerHeight();

    const observer = new ResizeObserver(updateComposerHeight);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [readyState]);

  useLayoutEffect(() => {
    if (didInitialScrollRef.current || virtualRowCount === 0) {
      return;
    }

    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 0;
      }

      requestAnimationFrame(() => {
        didInitialScrollRef.current = true;
        setDidInitialScroll(true);
      });
    });
  }, [virtualizer, virtualRowCount]);

  useLayoutEffect(() => {
    const count = liveMessagesSnapshot.length;

    if (count > lastLiveMessageCount && isAtBottomRef.current) {
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = 0;
        }
      });
    }

    setLastLiveMessageCount(count);
  }, [
    lastLiveMessageCount,
    liveMessagesSnapshot.length,
    virtualRowCount,
    virtualizer,
  ]);

  useEffect(() => {
    const loadedIncomingMessages = messages.filter(
      (message) => message.SenderId === userId,
    ).length;
    if (
      newMessageCount > loadedIncomingMessages &&
      messagesQuery.hasNextPage &&
      !messagesQuery.isFetchingNextPage &&
      !replyJumpLoadingRef.current
    ) {
      void messagesQuery.fetchNextPage();
    }
  }, [messages, messagesQuery, newMessageCount, userId]);

  useEffect(() => {
    if (
      viewportHeight === 0 ||
      totalSize > viewportHeight ||
      messagesQuery.isFetchingNextPage ||
      !messagesQuery.hasNextPage ||
      replyJumpLoadingRef.current
    ) {
      return;
    }

    void messagesQuery.fetchNextPage();
  }, [didInitialScroll, messagesQuery, totalSize, viewportHeight]);

  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = topSentinelRef.current;

    if (!root || !sentinel || !didInitialScroll) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (
          shouldFetchPreviousPage({
            entry,
            hasNextPage: messagesQuery.hasNextPage,
            isFetchingNextPage: messagesQuery.isFetchingNextPage,
            userScrolledUp:
              userScrolledUpRef.current && !replyJumpLoadingRef.current,
          })
        ) {
          void messagesQuery.fetchNextPage();
        }
      },
      { root, rootMargin: "240px 0px 0px 0px" },
    );

    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
  }, [didInitialScroll, messagesQuery, virtualRowCount]);

  const handleContainerScroll = useCallback(() => {
    if (!scrollRef.current) {
      return;
    }

    isAtBottomRef.current = scrollRef.current.scrollTop <= 140;

    if (didInitialScrollRef.current && scrollRef.current.scrollTop > 140) {
      userScrolledUpRef.current = true;
    }
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    smoothScrollTargetRef.current = element.scrollTop;

    const animateScroll = () => {
      const distance = smoothScrollTargetRef.current - element.scrollTop;
      if (Math.abs(distance) < 0.5) {
        element.scrollTop = smoothScrollTargetRef.current;
        smoothScrollFrameRef.current = null;
        handleContainerScroll();
        return;
      }

      element.scrollTop += distance * 0.35;
      handleContainerScroll();
      smoothScrollFrameRef.current = requestAnimationFrame(animateScroll);
    };

    const fetchNextPageNearTop = (scrollTop: number, maxScrollTop: number) => {
      if (didInitialScrollRef.current && scrollTop > 140) {
        userScrolledUpRef.current = true;
      }

      if (
        scrollTop >= maxScrollTop - 240 &&
        userScrolledUpRef.current &&
        hasNextPageRef.current &&
        !isFetchingNextPageRef.current &&
        !replyJumpLoadingRef.current
      ) {
        fetchNextPageRef.current?.();
      }
    };

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (smoothScrollFrameRef.current === null) {
        smoothScrollTargetRef.current = element.scrollTop;
      }

      const maxScrollTop = Math.max(
        0,
        element.scrollHeight - element.clientHeight,
      );
      smoothScrollTargetRef.current = Math.min(
        Math.max(0, smoothScrollTargetRef.current - event.deltaY),
        maxScrollTop,
      );
      fetchNextPageNearTop(smoothScrollTargetRef.current, maxScrollTop);

      if (smoothScrollFrameRef.current === null) {
        smoothScrollFrameRef.current = requestAnimationFrame(animateScroll);
      }
    };

    element.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      element.removeEventListener("wheel", handleWheel);
      if (smoothScrollFrameRef.current !== null) {
        cancelAnimationFrame(smoothScrollFrameRef.current);
        smoothScrollFrameRef.current = null;
      }
    };
  }, [handleContainerScroll, readyState]);

  if (!hasValidChatUser) {
    return (
      <div className="w-full h-full flex flex-col gap-2 items-center justify-center">
        <p className="font-semibold text-xl">Invalid User</p>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
      {readyState === 0 ? (
        <div className="w-full h-full flex flex-col gap-10 justify-center items-center">
          <GlobeOff size={80} />
          <p className="text-muted-foreground text-lg w-80 text-center">
            You are not connected to an Omikron. Please check your internet
            connection and try again later
          </p>
        </div>
      ) : (
        <>
          <div
            aria-hidden="true"
            key={
              background?.kind === "image"
                ? imageUrl
                : JSON.stringify(background)
            }
            className={`pointer-events-none absolute inset-0 bg-background bg-cover bg-center ${
              animateImage
                ? "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500"
                : ""
            }`}
            style={{
              ...chatBackgroundStyle(background, imageUrl, resolvedPolarity),
              opacity: background
                ? resolvedPolarity === "dark"
                  ? 0.3
                  : 0.5
                : 1,
            }}
          />
          <div
            ref={scrollRef}
            id="chat_container"
            className="min-h-0 flex-1 overflow-y-auto"
            style={{
              overflowAnchor: "none",
              //paddingTop: "22px",
              transform: "scaleY(-1)",
            }}
            onScroll={handleContainerScroll}
          >
            <div
              className="relative w-full"
              style={{ height: `${contentHeight}px` }}
            >
              <div
                ref={topSentinelRef}
                className="absolute bottom-0 left-0 h-px w-full"
              />
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const chunkIndex = virtualRow.index;
                const chunk = messageChunks[chunkIndex];
                if (!chunk) {
                  return null;
                }

                return (
                  <div
                    key={chunk.key}
                    data-index={virtualRow.index}
                    className="flex flex-col"
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <div className="flex flex-col scale-y-[-1]">
                      {chunkIndex === messageChunks.length - 1 &&
                        messagesQuery.hasNextPage === false && (
                          <Wrapper
                            userId={userId}
                            fields={["Display"]}
                            loading={null}
                            component={(user) => (
                              <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-muted-foreground">
                                <PartyPopper className="size-8" />
                                <p>
                                  This is the start of your conversation with{" "}
                                  <span className="font-medium text-foreground">
                                    {user?.Display}
                                  </span>
                                  .
                                </p>
                              </div>
                            )}
                          />
                        )}
                      {chunk.messages.map((message, chunkMessageIndex) => {
                        const messageIndex =
                          chunk.startIndex + chunkMessageIndex;
                        const lastMessage = messages[messageIndex - 1];
                        const startsNewDay =
                          !lastMessage ||
                          !isSameDay(lastMessage.SendTime, message.SendTime);
                        const dateLabel = startsNewDay
                          ? formatMessageDate(message.SendTime)
                          : null;
                        const startsNewMessages =
                          message.SendTime === newMessagesStart;
                        const isGrouped =
                          lastMessage &&
                          !startsNewDay &&
                          !startsNewMessages &&
                          !message.ReplyId &&
                          lastMessage.SenderId === message.SenderId &&
                          message.SendTime - lastMessage.SendTime < 5 * 60_000;

                        return (
                          <Wrapper
                            key={getMessageRenderKey(message)}
                            userId={message.SenderId}
                            fields={["UserId", "Avatar", "Display"]}
                            loading={null}
                            component={(user) => (
                              <>
                                {dateLabel && (
                                  <DateSeparator label={dateLabel} />
                                )}
                                {startsNewMessages && <NewMessagesSeparator />}
                                <Message
                                  editing={
                                    editingMessageId === message.SendTime
                                  }
                                  grouped={isGrouped}
                                  highlighted={
                                    highlightedMessageId === message.SendTime
                                  }
                                  message={message}
                                  onReplyActivate={jumpToReply}
                                  onSetEditing={(editing) =>
                                    setEditingMessageId(
                                      editing ? message.SendTime : null,
                                    )
                                  }
                                  user={user}
                                />
                              </>
                            )}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div ref={composerRef} className="absolute inset-x-0 bottom-0 z-10">
            <InputComponent
              onEditLastMessage={editLastMessage}
              setValue={setComposerValue}
              value={composerValue}
            />
          </div>
        </>
      )}
    </div>
  );
}

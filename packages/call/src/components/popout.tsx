import { Participant, Track } from "livekit-client";
import VideoViewer from "./videoViewer";
import { useLocation } from "@tanstack/react-router";
import { getRoom, openCallPage, stopWatchingStream, useCall } from "../store";
import { useState, useRef, useEffect, useCallback } from "react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Card,
  cn,
  useIsMobile,
} from "@nonanium/ui";
import { ArrowLeft, ScreenShareOff } from "lucide-react";
import { useUserFields } from "@tensamin/identity/context";
import { useIsSpeaking, useLastSpeakingParticipantId } from "../speakingState";
import { getAverageImageColor } from "./participantCard";
import { getTrackPublicationBySource } from "../participants";

const USER_FIELDS = ["Avatar", "Display"] as const;

type Positions = "top-left" | "top-right" | "bottom-left" | "bottom-right";
type ResizeEdge =
  | "top"
  | "right"
  | "bottom"
  | "left"
  | "top-left"
  | "top-right"
  | "bottom-right"
  | "bottom-left";
type Point = {
  x: number;
  y: number;
};

const MARGIN = 40;
const MIN_SIZE = 240;
const MAX_SIZE = 1000;
const ASPECT_RATIO = 9 / 16;
const MOBILE_MARGIN = 16;
const MOBILE_PILL_WIDTH = 128;
const MOBILE_PILL_HEIGHT = 48;

function MobileCallPill({
  active,
  callId,
}: {
  active: boolean;
  callId: string;
}) {
  const lastSpeakingParticipantId = useLastSpeakingParticipantId();
  const isSpeaking = useIsSpeaking(lastSpeakingParticipantId ?? -1);
  const { data: lastSpeakingUser } = useUserFields(
    lastSpeakingParticipantId,
    USER_FIELDS,
  );
  const [avatarBackgroundColor, setAvatarBackgroundColor] = useState<
    string | undefined
  >(undefined);
  const safeAreaRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const initialCoords = {
    x: window.innerWidth - MOBILE_PILL_WIDTH - MOBILE_MARGIN,
    y: MOBILE_MARGIN,
  };
  const coordsRef = useRef<Point>(initialCoords);
  const dragOffsetRef = useRef<Point>({ x: 0, y: 0 });
  const dragStartRef = useRef<Point>({ x: 0, y: 0 });
  const movedRef = useRef(false);
  const [position, setPosition] = useState<Positions>("top-right");
  const [coords, setCoords] = useState(initialCoords);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (!lastSpeakingUser?.Avatar) {
      setAvatarBackgroundColor(undefined);
      return;
    }

    let mounted = true;

    void getAverageImageColor(lastSpeakingUser.Avatar).then((color) => {
      if (mounted) {
        setAvatarBackgroundColor(color);
      }
    });

    return () => {
      mounted = false;
    };
  }, [lastSpeakingUser?.Avatar]);

  const getSafeArea = useCallback(() => {
    const element = safeAreaRef.current;
    if (!element) return { top: 0, right: 0, bottom: 0, left: 0 };
    const style = getComputedStyle(element);
    return {
      top: parseFloat(style.paddingTop) || 0,
      right: parseFloat(style.paddingRight) || 0,
      bottom: parseFloat(style.paddingBottom) || 0,
      left: parseFloat(style.paddingLeft) || 0,
    };
  }, []);

  const getCoordsForPosition = useCallback(
    (nextPosition: Positions): Point => {
      const bounds = pillRef.current?.getBoundingClientRect();
      const width = bounds?.width ?? MOBILE_PILL_WIDTH;
      const height = bounds?.height ?? MOBILE_PILL_HEIGHT;
      const safeArea = getSafeArea();

      return {
        x: nextPosition.endsWith("right")
          ? window.innerWidth - safeArea.right - width - MOBILE_MARGIN
          : safeArea.left + MOBILE_MARGIN,
        y: nextPosition.startsWith("bottom")
          ? window.innerHeight - safeArea.bottom - height - MOBILE_MARGIN
          : safeArea.top + MOBILE_MARGIN,
      };
    },
    [getSafeArea],
  );

  const setCoordsSafe = useCallback((next: Point) => {
    coordsRef.current = next;
    setCoords(next);
  }, []);

  const snapToPosition = useCallback(
    (nextPosition: Positions) => {
      setPosition(nextPosition);
      setCoordsSafe(getCoordsForPosition(nextPosition));
    },
    [getCoordsForPosition, setCoordsSafe],
  );

  useEffect(() => {
    if (active && !isDragging) {
      snapToPosition(position);
    }
  }, [active, isDragging, position, snapToPosition]);

  useEffect(() => {
    if (!active) return;
    const handleResize = () => snapToPosition(position);
    const observer = new ResizeObserver(handleResize);
    if (safeAreaRef.current) observer.observe(safeAreaRef.current);
    if (pillRef.current) observer.observe(pillRef.current);

    window.addEventListener("resize", handleResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [active, position, snapToPosition]);

  if (!active) {
    return null;
  }

  return (
    <div
      ref={safeAreaRef}
      className="pointer-events-none fixed inset-0 z-200 pt-[var(--ui-safe-area-top)] pr-[var(--ui-safe-area-right)] pb-[var(--ui-safe-area-bottom)] pl-[var(--ui-safe-area-left)]"
    >
      <Card
        ref={pillRef}
        role="button"
        tabIndex={0}
        aria-label="Return to call"
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void openCallPage(callId);
          }
        }}
        onClick={() => {
          if (movedRef.current) {
            movedRef.current = false;
            return;
          }

          void openCallPage(callId);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;

          event.currentTarget.setPointerCapture(event.pointerId);
          dragOffsetRef.current = {
            x: event.clientX - coordsRef.current.x,
            y: event.clientY - coordsRef.current.y,
          };
          dragStartRef.current = { x: event.clientX, y: event.clientY };
          movedRef.current = false;
          setIsDragging(true);
        }}
        onPointerMove={(event) => {
          if (!isDragging) return;

          const bounds = pillRef.current?.getBoundingClientRect();
          const width = bounds?.width ?? MOBILE_PILL_WIDTH;
          const height = bounds?.height ?? MOBILE_PILL_HEIGHT;
          const safeArea = getSafeArea();
          const next = {
            x: Math.min(
              window.innerWidth - safeArea.right - width - MOBILE_MARGIN,
              Math.max(
                safeArea.left + MOBILE_MARGIN,
                event.clientX - dragOffsetRef.current.x,
              ),
            ),
            y: Math.min(
              window.innerHeight - safeArea.bottom - height - MOBILE_MARGIN,
              Math.max(
                safeArea.top + MOBILE_MARGIN,
                event.clientY - dragOffsetRef.current.y,
              ),
            ),
          };

          if (
            Math.abs(event.clientX - dragStartRef.current.x) > 3 ||
            Math.abs(event.clientY - dragStartRef.current.y) > 3
          ) {
            movedRef.current = true;
          }

          setCoordsSafe(next);
        }}
        onPointerUp={(event) => {
          if (!isDragging) return;

          const nextPosition = `${
            event.clientY < window.innerHeight / 2 ? "top" : "bottom"
          }-${event.clientX < window.innerWidth / 2 ? "left" : "right"}` as Positions;

          setIsDragging(false);
          snapToPosition(nextPosition);
        }}
        onPointerCancel={() => {
          setIsDragging(false);
          snapToPosition(position);
        }}
        className={cn(
          "pointer-events-auto fixed left-0 top-0 z-200 flex w-23 h-23! touch-none select-none shadow-xl rounded-2xl flex items-center justify-center",
          isSpeaking && "border-3! border-(--primary-foreground-alt)/75!",
          isDragging ? "cursor-grabbing" : "cursor-grab",
        )}
        style={{
          backgroundColor: avatarBackgroundColor,
          transform: `translate3d(${coords.x}px, ${coords.y}px, 0)`,
          transition: isDragging
            ? "none"
            : "transform 420ms cubic-bezier(0.34, 1.56, 0.64, 1)",
          willChange: "transform",
        }}
      >
        <Avatar className="size-14">
          <AvatarImage src={lastSpeakingUser?.Avatar} />
          <AvatarFallback className="text-lg">
            {lastSpeakingUser?.Display.slice(0, 2).toUpperCase() ?? "..."}
          </AvatarFallback>
        </Avatar>
      </Card>
    </div>
  );
}

export function Popout({ participant }: { participant: Participant }) {
  const callId = useCall((state) => state.callId);
  const screenSharePublication = getTrackPublicationBySource(
    participant,
    Track.Source.ScreenShare,
  );

  const popoutRef = useRef<HTMLDivElement>(null);
  const coordsRef = useRef<Point>({ x: MARGIN, y: MARGIN });
  const dragOffsetRef = useRef<Point>({ x: 0, y: 0 });
  const sizeRef = useRef(400);
  const hideOverlayTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const resizeRef = useRef<{
    size: number;
    clientX: number;
    clientY: number;
    edge: ResizeEdge;
  }>({ size: 400, clientX: 0, clientY: 0, edge: "right" });

  const [size, setSize] = useState(400);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isOverlayVisible, setIsOverlayVisible] = useState(false);
  const [position, setPosition] = useState<Positions>("top-left");
  const [coords, setCoords] = useState<Point>({ x: MARGIN, y: MARGIN });

  const setCoordsSafe = (next: Point) => {
    coordsRef.current = next;
    setCoords(next);
  };

  const setSizeSafe = (next: number) => {
    sizeRef.current = next;
    setSize(next);
  };

  const getMaxSize = useCallback(() => {
    const maxWidth = window.innerWidth - MARGIN * 2;
    const maxHeightWidth = (window.innerHeight - MARGIN * 2) / ASPECT_RATIO;

    return Math.max(MIN_SIZE, Math.min(MAX_SIZE, maxWidth, maxHeightWidth));
  }, []);

  const clampSize = useCallback(
    (nextSize: number) => {
      return Math.min(getMaxSize(), Math.max(MIN_SIZE, nextSize));
    },
    [getMaxSize],
  );

  const getPositionFromPoint = (
    clientX: number,
    clientY: number,
  ): Positions => {
    const height = window.innerHeight / 2 > clientY ? "top" : "bottom";
    const width = window.innerWidth / 2 > clientX ? "left" : "right";

    return `${height}-${width}` as Positions;
  };

  const getCoordsForPosition = useCallback(
    (nextPosition: Positions, nextSize = size): Point => {
      const width = nextSize;
      const height = nextSize * ASPECT_RATIO;

      return {
        x: nextPosition.endsWith("right")
          ? window.innerWidth - width - MARGIN
          : MARGIN,
        y: nextPosition.startsWith("bottom")
          ? window.innerHeight - height - MARGIN
          : MARGIN,
      };
    },
    [size],
  );

  useEffect(() => {
    if (isDragging) return;

    setCoordsSafe(getCoordsForPosition(position));
  }, [position, size, isDragging, getCoordsForPosition]);

  useEffect(() => {
    const handleResize = () => {
      if (isDragging) return;

      const nextSize = clampSize(size);

      setSizeSafe(nextSize);
      setCoordsSafe(getCoordsForPosition(position, nextSize));
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [position, size, isDragging, getCoordsForPosition, clampSize]);

  useEffect(() => {
    return () => {
      if (hideOverlayTimeoutRef.current) {
        clearTimeout(hideOverlayTimeoutRef.current);
      }
    };
  }, []);

  const scheduleOverlayHide = () => {
    if (hideOverlayTimeoutRef.current) {
      clearTimeout(hideOverlayTimeoutRef.current);
    }

    hideOverlayTimeoutRef.current = setTimeout(() => {
      setIsOverlayVisible(false);
      hideOverlayTimeoutRef.current = null;
    }, 3000);
  };

  const showOverlay = () => {
    setIsOverlayVisible(true);
    scheduleOverlayHide();
  };

  const hideOverlay = () => {
    if (hideOverlayTimeoutRef.current) {
      clearTimeout(hideOverlayTimeoutRef.current);
      hideOverlayTimeoutRef.current = null;
    }

    setIsOverlayVisible(false);
  };

  const getCornerResizeDelta = (
    horizontalDelta: number,
    verticalDelta: number,
  ) => {
    return Math.abs(horizontalDelta) > Math.abs(verticalDelta)
      ? horizontalDelta
      : verticalDelta;
  };

  const getResizeDelta = (e: React.PointerEvent, edge: ResizeEdge) => {
    switch (edge) {
      case "left":
        return resizeRef.current.clientX - e.clientX;
      case "right":
        return e.clientX - resizeRef.current.clientX;
      case "top":
        return (resizeRef.current.clientY - e.clientY) / ASPECT_RATIO;
      case "bottom":
        return (e.clientY - resizeRef.current.clientY) / ASPECT_RATIO;
      case "top-left":
        return getCornerResizeDelta(
          resizeRef.current.clientX - e.clientX,
          (resizeRef.current.clientY - e.clientY) / ASPECT_RATIO,
        );
      case "top-right":
        return getCornerResizeDelta(
          e.clientX - resizeRef.current.clientX,
          (resizeRef.current.clientY - e.clientY) / ASPECT_RATIO,
        );
      case "bottom-right":
        return getCornerResizeDelta(
          e.clientX - resizeRef.current.clientX,
          (e.clientY - resizeRef.current.clientY) / ASPECT_RATIO,
        );
      case "bottom-left":
        return getCornerResizeDelta(
          resizeRef.current.clientX - e.clientX,
          (e.clientY - resizeRef.current.clientY) / ASPECT_RATIO,
        );
    }
  };

  const startResize = (
    e: React.PointerEvent<HTMLDivElement>,
    edge: ResizeEdge,
  ) => {
    if (e.button !== 0) return;

    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);

    resizeRef.current = {
      size,
      clientX: e.clientX,
      clientY: e.clientY,
      edge,
    };

    setIsResizing(true);
  };

  const resizePopout = (e: React.PointerEvent) => {
    if (!isResizing) return;

    const nextSize = clampSize(
      resizeRef.current.size + getResizeDelta(e, resizeRef.current.edge),
    );

    setSizeSafe(nextSize);
    setCoordsSafe(getCoordsForPosition(position, nextSize));
  };

  const stopResize = (e: React.PointerEvent) => {
    if (!isResizing) return;

    e.stopPropagation();
    setIsResizing(false);
    setCoordsSafe(getCoordsForPosition(position, sizeRef.current));
  };

  const resizeEdgeClassName = "absolute z-10 bg-transparent";
  const resizeCornerClassName = "absolute z-20 h-4 w-4 bg-transparent";

  if (!screenSharePublication) {
    return null;
  }

  return (
    <div
      ref={popoutRef}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if (isResizing) return;

        e.currentTarget.setPointerCapture(e.pointerId);

        const current = coordsRef.current;

        dragOffsetRef.current = {
          x: e.clientX - current.x,
          y: e.clientY - current.y,
        };

        setIsDragging(true);
      }}
      onPointerMove={(e) => {
        if (!isDragging) return;

        setCoordsSafe({
          x: e.clientX - dragOffsetRef.current.x,
          y: e.clientY - dragOffsetRef.current.y,
        });
      }}
      onPointerUp={(e) => {
        if (!isDragging) return;

        const nextPosition = getPositionFromPoint(e.clientX, e.clientY);

        setPosition(nextPosition);
        setIsDragging(false);

        requestAnimationFrame(() => {
          setCoordsSafe(getCoordsForPosition(nextPosition));
        });
      }}
      onPointerCancel={() => {
        setIsDragging(false);

        requestAnimationFrame(() => {
          setCoordsSafe(getCoordsForPosition(position));
        });
      }}
      onMouseEnter={showOverlay}
      onMouseMove={showOverlay}
      onMouseLeave={hideOverlay}
      className={cn(
        "fixed left-0 top-0 aspect-video z-200 rounded-lg border-2 border-muted-foreground bg-black",
        "select-none touch-none",
        isDragging ? "cursor-grabbing" : "cursor-grab",
      )}
      style={{
        width: size,
        transform: `translate3d(${coords.x}px, ${coords.y}px, 0)`,
        transition:
          isDragging || isResizing
            ? "none"
            : "transform 420ms cubic-bezier(0.34, 1.56, 0.64, 1)",
        willChange: "transform",
      }}
    >
      <VideoViewer
        participantId={participant.identity}
        publication={screenSharePublication}
      />
      <div
        className={cn(
          "pointer-events-none absolute inset-0 z-40 transition-opacity duration-200",
          isOverlayVisible ? "opacity-100" : "opacity-0",
        )}
      >
        <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/55 to-transparent rounded-2xl" />
        <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/65 to-transparent rounded-2xl" />
      </div>
      <div
        className={cn(
          "absolute bottom-3 px-3 z-50 flex gap-2 transition-all duration-200 flex justify-between w-full",
          isOverlayVisible
            ? "opacity-100 translate-y-0 pointer-events-auto"
            : "opacity-0 translate-y-2 pointer-events-none",
        )}
      >
        <div className="bg-[#070707] h-10 rounded-lg">
          <Button
            className="w-full h-full border-0!"
            variant="outline"
            disabled={!callId}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (callId) void openCallPage(callId);
            }}
          >
            <ArrowLeft />
            Go Back
          </Button>
        </div>
        <div className="bg-[#070707] h-10 w-14 rounded-lg">
          <Button
            className="w-full h-full border-0!"
            variant="destructive"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              stopWatchingStream(Number(participant.identity ?? 0));
            }}
          >
            <ScreenShareOff style={{ scale: "115%" }} />
          </Button>
        </div>
      </div>
      <div
        className={cn(
          resizeEdgeClassName,
          "inset-x-4 -top-1 h-2 cursor-n-resize",
        )}
        onPointerDown={(e) => startResize(e, "top")}
        onPointerMove={resizePopout}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
      />
      <div
        className={cn(
          resizeEdgeClassName,
          "-right-1 inset-y-4 w-2 cursor-e-resize",
        )}
        onPointerDown={(e) => startResize(e, "right")}
        onPointerMove={resizePopout}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
      />
      <div
        className={cn(
          resizeEdgeClassName,
          "inset-x-4 -bottom-1 h-2 cursor-s-resize",
        )}
        onPointerDown={(e) => startResize(e, "bottom")}
        onPointerMove={resizePopout}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
      />
      <div
        className={cn(
          resizeEdgeClassName,
          "-left-1 inset-y-4 w-2 cursor-w-resize",
        )}
        onPointerDown={(e) => startResize(e, "left")}
        onPointerMove={resizePopout}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
      />
      <div
        className={cn(resizeCornerClassName, "-left-1 -top-1 cursor-nw-resize")}
        onPointerDown={(e) => startResize(e, "top-left")}
        onPointerMove={resizePopout}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
      />
      <div
        className={cn(
          resizeCornerClassName,
          "-right-1 -top-1 cursor-ne-resize",
        )}
        onPointerDown={(e) => startResize(e, "top-right")}
        onPointerMove={resizePopout}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
      />
      <div
        className={cn(
          resizeCornerClassName,
          "-bottom-1 -right-1 cursor-se-resize",
        )}
        onPointerDown={(e) => startResize(e, "bottom-right")}
        onPointerMove={resizePopout}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
      />
      <div
        className={cn(
          resizeCornerClassName,
          "-bottom-1 -left-1 cursor-sw-resize",
        )}
        onPointerDown={(e) => startResize(e, "bottom-left")}
        onPointerMove={resizePopout}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
      />
    </div>
  );
}

export default function Wrapper() {
  const room = getRoom();
  const { pathname } = useLocation();
  const isMobile = useIsMobile();
  const state = useCall((state) => state.state);
  const callId = useCall((state) => state.callId);
  const watchedStreamParticipantIds = useCall(
    (state) => state.watchedStreamParticipantIds,
  );
  const lastFocusedParticipantId = useCall(
    (state) => state.lastFocusedParticipantId,
  );
  const participant = room.getParticipantByIdentity(
    String(lastFocusedParticipantId),
  );

  if (isMobile) {
    return (
      <MobileCallPill
        active={!pathname.startsWith("/call") && state === "open"}
        callId={callId ?? ""}
      />
    );
  }

  if (!participant || !lastFocusedParticipantId) {
    return null;
  }

  const active =
    !pathname.startsWith("/call") &&
    state === "open" &&
    watchedStreamParticipantIds.includes(Number(participant.identity ?? 0));

  return active && <Popout participant={participant} />;
}

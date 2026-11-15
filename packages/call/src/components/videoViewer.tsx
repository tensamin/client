import { VideoTrack, useParticipantTracks } from "@livekit/components-react";
import { cn } from "@nonanium/ui";
import { TrackPublication } from "livekit-client";
import { Loader2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useCallActions } from "../store";

const MAX_ZOOM = 4;
const DRAG_THRESHOLD_PX = 3;
const WHEEL_ZOOM_RATE = Math.log(1.1) / 100;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function clampPan(viewport: HTMLElement, scale: number, x: number, y: number) {
  const maxX = (viewport.clientWidth * (scale - 1)) / 2;
  const maxY = (viewport.clientHeight * (scale - 1)) / 2;

  return {
    scale,
    x: clamp(x, -maxX, maxX),
    y: clamp(y, -maxY, maxY),
  };
}

export default function VideoViewer({
  className,
  fill = false,
  flush = false,
  publication,
  participantId,
  zoomable = false,
}: {
  className?: string;
  fill?: boolean;
  flush?: boolean;
  publication: TrackPublication;
  participantId: string;
  zoomable?: boolean;
}) {
  const { getRoom } = useCallActions();

  const room = getRoom();
  const tracks = useParticipantTracks([publication.source], {
    participantIdentity: participantId,
    room,
  });
  const trackRef = tracks[0];
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const transformRef = useRef({ scale: 1, x: 0, y: 0 });
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const setViewportNode = useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element;
    setViewport(element);
  }, []);

  const updateTransform = useCallback(
    (nextTransform: { scale: number; x: number; y: number }) => {
      transformRef.current = nextTransform;
      setTransform(nextTransform);
    },
    [],
  );

  const resetTransform = useCallback(() => {
    dragRef.current = null;
    suppressClickRef.current = false;
    setIsDragging(false);
    updateTransform({ scale: 1, x: 0, y: 0 });
  }, [updateTransform]);

  useEffect(() => {
    resetTransform();
  }, [participantId, publication, resetTransform, zoomable]);

  useEffect(() => {
    if (!zoomable || !viewport) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const deltaMultiplier =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? viewport.clientHeight
            : 1;
      const deltaY = event.deltaY * deltaMultiplier;
      if (deltaY === 0) return;

      const current = transformRef.current;
      const scale = clamp(
        current.scale * Math.exp(-deltaY * WHEEL_ZOOM_RATE),
        1,
        MAX_ZOOM,
      );

      if (scale === 1) {
        updateTransform({ scale: 1, x: 0, y: 0 });
        return;
      }

      const bounds = viewport.getBoundingClientRect();
      const pointerX = event.clientX - bounds.left - bounds.width / 2;
      const pointerY = event.clientY - bounds.top - bounds.height / 2;
      const scaleRatio = scale / current.scale;

      updateTransform(
        clampPan(
          viewport,
          scale,
          pointerX - (pointerX - current.x) * scaleRatio,
          pointerY - (pointerY - current.y) * scaleRatio,
        ),
      );
    };

    const resizeObserver = new ResizeObserver(() => {
      const current = transformRef.current;
      updateTransform(clampPan(viewport, current.scale, current.x, current.y));
    });

    viewport.addEventListener("wheel", onWheel, { passive: false });
    resizeObserver.observe(viewport);

    return () => {
      viewport.removeEventListener("wheel", onWheel);
      resizeObserver.disconnect();
    };
  }, [updateTransform, viewport, zoomable]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!zoomable || event.button !== 0 || transformRef.current.scale === 1) {
      return;
    }

    const current = transformRef.current;
    suppressClickRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: current.x,
      startY: current.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const viewport = viewportRef.current;
    if (!drag || !viewport || drag.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - drag.startClientX;
    const deltaY = event.clientY - drag.startClientY;
    drag.moved ||= Math.hypot(deltaX, deltaY) > DRAG_THRESHOLD_PX;
    if (!drag.moved) return;

    event.preventDefault();
    updateTransform(
      clampPan(
        viewport,
        transformRef.current.scale,
        drag.startX + deltaX,
        drag.startY + deltaY,
      ),
    );
  };

  const finishDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    suppressClickRef.current = drag.moved;
    dragRef.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  if (!trackRef) return <Loader2 className="animate-spin" />;

  const videoClassName = cn(
    fill ? "w-full h-full bg-black" : "w-full h-full aspect-video bg-black",
    flush ? "rounded-none" : "rounded-md",
    className,
  );

  if (!zoomable) {
    return <VideoTrack trackRef={trackRef} className={videoClassName} />;
  }

  return (
    <div
      ref={setViewportNode}
      onClickCapture={(event) => {
        if (!suppressClickRef.current) return;
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDragging}
      onPointerCancel={finishDragging}
      className={cn(
        "relative h-full w-full overflow-hidden select-none",
        transform.scale > 1 && (isDragging ? "cursor-grabbing" : "cursor-grab"),
        flush ? "rounded-none" : "rounded-md",
      )}
    >
      <VideoTrack
        trackRef={trackRef}
        className={videoClassName}
        style={{
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
          transformOrigin: "center",
        }}
      />
      <div
        role="status"
        aria-live="polite"
        aria-hidden={transform.scale === 1}
        className={cn(
          "pointer-events-none absolute right-3 bottom-3 z-20 rounded-full border border-white/10 bg-black/35 px-2 py-1 text-xs text-white/75 tabular-nums shadow-sm backdrop-blur-md transition-opacity duration-150",
          transform.scale === 1 ? "opacity-0" : "opacity-100",
        )}
      >
        {Math.round(transform.scale * 100)}%
      </div>
    </div>
  );
}

import { Text } from "@nonanium/ui/markdown";
import { useStorage } from "@tensamin/storage/context";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useIsMobile,
} from "@nonanium/ui";
import { toast } from "@tensamin/shared/log";
import {
  Check,
  Copy,
  ExternalLink,
  TriangleAlert,
  X,
  ZoomIn,
} from "lucide-react";
import {
  useCallback,
  useState,
  useMemo,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from "react";
import MediaSaveButton from "./mediaSaveButton";
import { useUserFields } from "@tensamin/identity/context";

const zoomLevels = [1, 1.5, 2, 3];
const maxMobileZoom = 4;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export default function Media({
  link,
  senderId,
  time,
}: {
  link: string;
  senderId: number;
  time: string;
}) {
  const { load } = useStorage();
  const isMobile = useIsMobile();

  const [trustedDomains, setTrustedDomains] = useState<string[]>([]);
  const [hidden, setHidden] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(0);
  const wheelDelta = useRef(0);
  const mobileViewportRef = useRef<HTMLDivElement>(null);
  const mobileImageRef = useRef<HTMLImageElement>(null);
  const mobilePointers = useRef(new Map<number, { x: number; y: number }>());
  const mobileGesture = useRef<
    | {
        type: "pan";
        pointerId: number;
        startPointer: { x: number; y: number };
        startTransform: { scale: number; x: number; y: number };
      }
    | {
        type: "pinch";
        startDistance: number;
        startMidpoint: { x: number; y: number };
        startTransform: { scale: number; x: number; y: number };
      }
    | null
  >(null);
  const mobileTransformRef = useRef({ scale: 1, x: 0, y: 0 });
  const [mobileTransform, setMobileTransform] = useState({
    scale: 1,
    x: 0,
    y: 0,
  });
  const hostname = useMemo(() => new URL(link).hostname, [link]);

  const { data: user } = useUserFields(senderId, ["Avatar", "Display"]);
  const avatar = user?.Avatar
    ? `data:image/webp;base64,${user.Avatar}`
    : undefined;

  useEffect(() => {
    load("chat_trusted_domains").then(setTrustedDomains);
  }, [load]);

  const changeZoom = (change: number) => {
    setZoomLevel((level) =>
      Math.max(0, Math.min(zoomLevels.length - 1, level + change)),
    );
  };

  const handleWheel = (event: WheelEvent) => {
    wheelDelta.current += event.deltaY;

    if (Math.abs(wheelDelta.current) < 50) return;

    changeZoom(wheelDelta.current < 0 ? 1 : -1);
    wheelDelta.current = 0;
  };

  const clampMobileTransform = useCallback(
    (transform: { scale: number; x: number; y: number }) => {
      const viewport = mobileViewportRef.current;
      const image = mobileImageRef.current;
      if (!viewport || !image || transform.scale === 1) {
        return { scale: 1, x: 0, y: 0 };
      }

      const maxX = Math.max(
        0,
        (image.clientWidth * transform.scale - viewport.clientWidth) / 2,
      );
      const maxY = Math.max(
        0,
        (image.clientHeight * transform.scale - viewport.clientHeight) / 2,
      );

      return {
        scale: transform.scale,
        x: clamp(transform.x, -maxX, maxX),
        y: clamp(transform.y, -maxY, maxY),
      };
    },
    [],
  );

  const updateMobileTransform = useCallback(
    (transform: { scale: number; x: number; y: number }) => {
      const nextTransform = clampMobileTransform(transform);
      mobileTransformRef.current = nextTransform;
      setMobileTransform(nextTransform);
    },
    [clampMobileTransform],
  );

  const resetMobileTransform = useCallback(() => {
    mobilePointers.current.clear();
    mobileGesture.current = null;
    mobileTransformRef.current = { scale: 1, x: 0, y: 0 };
    setMobileTransform({ scale: 1, x: 0, y: 0 });
  }, []);

  useEffect(() => {
    const viewport = mobileViewportRef.current;
    const image = mobileImageRef.current;
    if (!isMobile || !dialogOpen || !viewport || !image) return;

    const resizeObserver = new ResizeObserver(() => {
      updateMobileTransform(mobileTransformRef.current);
    });
    resizeObserver.observe(viewport);
    resizeObserver.observe(image);
    return () => resizeObserver.disconnect();
  }, [dialogOpen, isMobile, updateMobileTransform]);

  const mobilePoint = (clientX: number, clientY: number) => {
    const bounds = mobileViewportRef.current?.getBoundingClientRect();
    return bounds
      ? {
          x: clientX - bounds.left - bounds.width / 2,
          y: clientY - bounds.top - bounds.height / 2,
        }
      : { x: 0, y: 0 };
  };

  const startMobilePinch = () => {
    const [first, second] = [...mobilePointers.current.values()];
    if (!first || !second) return;

    mobileGesture.current = {
      type: "pinch",
      startDistance: Math.hypot(second.x - first.x, second.y - first.y),
      startMidpoint: {
        x: (first.x + second.x) / 2,
        y: (first.y + second.y) / 2,
      },
      startTransform: mobileTransformRef.current,
    };
  };

  const handleMobilePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const point = mobilePoint(event.clientX, event.clientY);
    mobilePointers.current.set(event.pointerId, point);
    event.currentTarget.setPointerCapture(event.pointerId);

    if (mobilePointers.current.size >= 2) {
      startMobilePinch();
    } else if (mobileTransformRef.current.scale > 1) {
      mobileGesture.current = {
        type: "pan",
        pointerId: event.pointerId,
        startPointer: point,
        startTransform: mobileTransformRef.current,
      };
    }
  };

  const handleMobilePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (!mobilePointers.current.has(event.pointerId)) return;

    const point = mobilePoint(event.clientX, event.clientY);
    mobilePointers.current.set(event.pointerId, point);
    const gesture = mobileGesture.current;
    if (!gesture) return;

    if (gesture.type === "pan") {
      if (gesture.pointerId !== event.pointerId) return;
      updateMobileTransform({
        ...gesture.startTransform,
        x: gesture.startTransform.x + point.x - gesture.startPointer.x,
        y: gesture.startTransform.y + point.y - gesture.startPointer.y,
      });
      return;
    }

    const [first, second] = [...mobilePointers.current.values()];
    if (!first || !second || gesture.startDistance === 0) return;

    const midpoint = {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
    };
    const scale = clamp(
      gesture.startTransform.scale *
        (Math.hypot(second.x - first.x, second.y - first.y) /
          gesture.startDistance),
      1,
      maxMobileZoom,
    );
    const scaleRatio = scale / gesture.startTransform.scale;
    updateMobileTransform({
      scale,
      x:
        midpoint.x -
        (gesture.startMidpoint.x - gesture.startTransform.x) * scaleRatio,
      y:
        midpoint.y -
        (gesture.startMidpoint.y - gesture.startTransform.y) * scaleRatio,
    });
  };

  const handleMobilePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    mobilePointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const [remaining] = [...mobilePointers.current.entries()];
    if (remaining && mobileTransformRef.current.scale > 1) {
      mobileGesture.current = {
        type: "pan",
        pointerId: remaining[0],
        startPointer: remaining[1],
        startTransform: mobileTransformRef.current,
      };
    } else {
      mobileGesture.current = null;
    }
  };

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let cancelled = false;

    if (copied) {
      setTimeout(() => {
        if (cancelled) return;
        setCopied(false);
      }, 1000);
    }

    return () => {
      cancelled = true;
    };
  }, [copied]);
  const copyImage = async () => {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        throw new Error("Image clipboard access is not supported.");
      }

      const image = (async () => {
        const response = await fetch(link);
        if (!response.ok) {
          throw new Error(`Failed to download image (${response.status}).`);
        }

        const blob = await response.blob();
        if (blob.type === "image/png") return blob;

        const bitmap = await createImageBitmap(blob);
        try {
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext("2d");

          if (!context) {
            throw new Error("Failed to prepare the image for copying.");
          }

          context.drawImage(bitmap, 0, 0);
          return await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              (convertedBlob) =>
                convertedBlob
                  ? resolve(convertedBlob)
                  : reject(new Error("Failed to convert the image to PNG.")),
              "image/png",
            );
          });
        } finally {
          bitmap.close();
        }
      })();

      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": image }),
      ]);
      setCopied(true);
    } catch (error) {
      toast("error", "Failed to copy image", String(error));
    }
  };

  return trustedDomains.includes(hostname) ? (
    <div className="group relative inline-block">
      {hidden ? (
        <Text value={link} />
      ) : (
        !isMobile && <MediaSaveButton className="top-2" url={link} />
      )}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setZoomLevel(0);
            wheelDelta.current = 0;
            resetMobileTransform();
          }
        }}
      >
        <DialogTrigger
          render={({ onClick }) => (
            <img
              onClick={onClick}
              src={link}
              hidden={hidden}
              onLoad={() => setHidden(false)}
              className="max-h-70 max-w-70 py-1 rounded-lg cursor-pointer"
            />
          )}
        />
        {isMobile ? (
          <DialogContent
            showCloseButton={false}
            className="inset-0! flex h-dvh! w-screen! max-h-none! max-w-none! translate-none! flex-col overflow-hidden! rounded-none! border-0! bg-background p-0! data-open:animate-none! data-closed:animate-none!"
          >
            <div className="flex shrink-0 items-center justify-between gap-3 px-[max(1rem,var(--ui-safe-area-right))] pt-[max(0.75rem,var(--ui-safe-area-top))] pb-3 pl-[max(1rem,var(--ui-safe-area-left))]">
              <div className="flex min-w-0 items-center gap-2">
                <Avatar className="size-10 shrink-0">
                  <AvatarImage src={avatar} />
                  <AvatarFallback className="text-lg">
                    {user?.Display.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="truncate font-semibold">{user?.Display}</p>
                  <p className="text-sm text-muted-foreground">{time}</p>
                </div>
              </div>
              <DialogClose
                render={({ onClick }) => (
                  <Button
                    aria-label="Close"
                    onClick={onClick}
                    className="h-10! w-10! shrink-0"
                    variant="ghost"
                  >
                    <X />
                  </Button>
                )}
              />
            </div>

            <div
              ref={mobileViewportRef}
              onPointerDown={handleMobilePointerDown}
              onPointerMove={handleMobilePointerMove}
              onPointerUp={handleMobilePointerEnd}
              onPointerCancel={handleMobilePointerEnd}
              className="relative flex min-h-0 flex-1 touch-none select-none items-center justify-center overflow-hidden"
            >
              <img
                ref={mobileImageRef}
                src={link}
                hidden={hidden}
                onLoad={() => setHidden(false)}
                draggable={false}
                style={{
                  transform: `translate3d(${mobileTransform.x}px, ${mobileTransform.y}px, 0) scale(${mobileTransform.scale})`,
                }}
                className="max-h-full max-w-full object-contain"
              />
            </div>

            <div className="flex shrink-0 justify-center px-[max(1rem,var(--ui-safe-area-right))] pt-3 pb-[max(0.75rem,var(--ui-safe-area-bottom))] pl-[max(1rem,var(--ui-safe-area-left))]">
              <div className="flex items-center gap-1 rounded-lg bg-card p-1">
                <MediaSaveButton className="static" url={link} />
                <Button
                  aria-label={copied ? "Copied" : "Copy image"}
                  onClick={copyImage}
                  className="h-10! w-10!"
                  variant="ghost"
                >
                  {copied ? <Check /> : <Copy />}
                </Button>
                <a href={link} target="_blank" rel="noreferrer">
                  <Button
                    aria-label="Open in browser"
                    className="h-10! w-10!"
                    variant="ghost"
                  >
                    <ExternalLink />
                  </Button>
                </a>
              </div>
            </div>
          </DialogContent>
        ) : (
          <DialogContent
            showCloseButton={false}
            onWheel={handleWheel}
            className="inset-0! h-dvh! w-screen! max-h-none! max-w-none! translate-none! overflow-hidden! rounded-none! border-0! bg-black/50 p-0!"
          >
            <div className="pointer-events-none relative z-10 flex h-full w-full items-start justify-between pt-[max(1.75rem,var(--ui-safe-area-top))] pr-[max(1.75rem,var(--ui-safe-area-right))] pb-[max(1.75rem,var(--ui-safe-area-bottom))] pl-[max(1.75rem,var(--ui-safe-area-left))]">
              <div
                className={`flex gap-2 items-center transition-opacity duration-200 ${zoomLevel === 0 ? "opacity-100" : "pointer-events-none opacity-0"}`}
                inert={zoomLevel !== 0}
              >
                <Avatar className="size-10">
                  <AvatarImage src={avatar} />
                  <AvatarFallback className="text-lg">
                    {user?.Display.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="flex flex-col">
                  <p className="text-lg font-semibold">{user?.Display}</p>
                  <p className="text-sm text-muted-foreground">{time}</p>
                </div>
              </div>
              <div className="flex gap-3 pointer-events-auto">
                <div
                  className={`flex ${zoomLevel === 0 ? "gap-1" : ""} bg-card rounded-lg p-1`}
                >
                  <Tooltip>
                    <TooltipTrigger
                      render={({ ref }) => (
                        <Button
                          ref={ref}
                          onClick={() =>
                            setZoomLevel(
                              (level) => (level + 1) % zoomLevels.length,
                            )
                          }
                          className="w-9! h-9!"
                          variant="ghost"
                        >
                          <ZoomIn />
                        </Button>
                      )}
                    />
                    <TooltipContent>Zoom {zoomLevel + 1}/4</TooltipContent>
                  </Tooltip>
                  <div
                    className={`flex overflow-hidden transition-[width,opacity] duration-200 ${zoomLevel === 0 ? "w-18 opacity-100" : "pointer-events-none w-0 opacity-0"}`}
                    inert={zoomLevel !== 0}
                  >
                    <Tooltip>
                      <TooltipTrigger
                        render={({ ref }) => (
                          <Button
                            ref={ref}
                            onClick={copyImage}
                            className="w-9! h-9!"
                            variant="ghost"
                          >
                            {copied ? <Check /> : <Copy />}
                          </Button>
                        )}
                      />
                      <TooltipContent>
                        {copied ? "Copied!" : "Copy image"}
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={({ ref }) => (
                          <a
                            ref={ref}
                            href={link}
                            target="_blank"
                            className="w-9! h-9!"
                          >
                            <Button className="w-9! h-9!" variant="ghost">
                              <ExternalLink />
                            </Button>
                          </a>
                        )}
                      />
                      <TooltipContent>Open in browser</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
                <div className="flex bg-card rounded-lg p-1">
                  <DialogClose
                    render={({ onClick }) => (
                      <Tooltip>
                        <TooltipTrigger
                          render={({ ref }) => (
                            <Button
                              ref={ref}
                              onClick={onClick}
                              className="w-9! h-9!"
                              variant="ghost"
                            >
                              <X />
                            </Button>
                          )}
                        />
                        <TooltipContent>Close</TooltipContent>
                      </Tooltip>
                    )}
                  />
                </div>
              </div>
            </div>
            <img
              src={link}
              hidden={hidden}
              onLoad={() => setHidden(false)}
              style={{
                transform: `translate(-50%, -50%) scale(${zoomLevels[zoomLevel]})`,
              }}
              className="h-[80vh] rounded-lg object-cover absolute top-1/2 left-1/2 transition-transform duration-200"
            />
          </DialogContent>
        )}
      </Dialog>
    </div>
  ) : (
    <div className="flex gap-1 items-center">
      <Tooltip>
        <TooltipTrigger
          render={<TriangleAlert className="size-4 stroke-yellow-400" />}
        />
        <TooltipContent>
          Link embeds can get your IP-Address! You can configure trusted domains
          in the settings.
        </TooltipContent>
      </Tooltip>
      <Text value={link} />
    </div>
  );
}

import { cn } from "@nonanium/ui";
import { AppWindow, Camera, MonitorUp } from "lucide-react";
import { useEffect, useRef } from "react";
import type { MediaShareSource } from "../mediaShare";

function SourceIcon({ source }: { source: MediaShareSource }) {
  const className = "size-8 text-muted-foreground";

  if (source.kind === "camera") return <Camera className={className} />;
  if (source.kind === "window") return <AppWindow className={className} />;
  return <MonitorUp className={className} />;
}

function VideoPreview({ stream }: { stream: MediaStream }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    void video.play().catch(() => undefined);

    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  return (
    <video
      ref={videoRef}
      muted
      autoPlay
      playsInline
      className="h-full w-full object-cover"
    />
  );
}

export default function MediaSourceCard({
  source,
  selected,
  previewStream,
  onSelect,
}: {
  source: MediaShareSource;
  selected: boolean;
  previewStream?: MediaStream | null;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "overflow-hidden rounded-xl border bg-card text-left transition-all",
        selected
          ? "border-4 border-(--primary)!"
          : "border-border hover:border-primary/50 hover:bg-muted/50",
      )}
    >
      <div className="flex aspect-video w-full items-center justify-center overflow-hidden bg-muted">
        {previewStream ? (
          <VideoPreview stream={previewStream} />
        ) : source.thumbnail ? (
          <img
            src={source.thumbnail}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <SourceIcon source={source} />
        )}
      </div>
    </button>
  );
}

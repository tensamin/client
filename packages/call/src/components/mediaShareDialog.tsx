import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@nonanium/ui";
import { toast } from "@tensamin/shared/log";
import { Loader2 } from "lucide-react";
import {
  getMediaShareAdapter,
  type MediaShareKind,
  type MediaShareSource,
} from "../mediaShare";
import { startCameraShare, startScreenShare } from "../store";
import MediaSourceCard from "./mediaSourceCard";

export default function MediaShareDialog({
  kind,
  open,
  onOpenChange,
  portalContainer,
  includePreview = true,
}: {
  kind: MediaShareKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  portalContainer?: HTMLElement;
  includePreview?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<MediaShareSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [cameraPreview, setCameraPreview] = useState<MediaStream | null>(null);
  const [cameraPreviewVersion, setCameraPreviewVersion] = useState(0);
  const cameraPreviewRef = useRef<MediaStream | null>(null);

  function stopCameraPreview() {
    cameraPreviewRef.current?.getTracks().forEach((track) => track.stop());
    cameraPreviewRef.current = null;
    setCameraPreview(null);
  }

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setSelectedSourceId(null);

    getMediaShareAdapter()
      .listSources(kind)
      .then((nextSources) => {
        if (!active) return;
        const availableSources =
          kind === "camera" && nextSources.length === 0
            ? [
                {
                  id: "__default_camera__",
                  kind: "camera" as const,
                  name: "Default camera",
                },
              ]
            : nextSources;
        setSources(availableSources);
        setSelectedSourceId(availableSources[0]?.id ?? null);
      })
      .catch((error) => {
        console.error("Failed to load media share sources", error);
        toast("error", "Failed to load media sources.");
      })
      .finally(() => active && setLoading(false));

    return () => {
      active = false;
    };
  }, [kind, open]);

  useEffect(() => {
    if (kind !== "camera" || !open || !selectedSourceId) {
      stopCameraPreview();
      return;
    }

    let active = true;
    stopCameraPreview();
    const sourceId =
      selectedSourceId === "__default_camera__" ? undefined : selectedSourceId;

    void navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: sourceId ? { deviceId: { exact: sourceId } } : true,
      })
      .then((stream) => {
        if (!active) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        cameraPreviewRef.current = stream;
        setCameraPreview(stream);
      })
      .catch((error) => {
        console.error("Failed to preview camera", error);
      });

    return () => {
      active = false;
      stopCameraPreview();
    };
  }, [cameraPreviewVersion, kind, open, selectedSourceId]);

  async function startSharing() {
    setLoading(true);
    try {
      if (kind === "camera") {
        stopCameraPreview();
        await startCameraShare(
          selectedSourceId === "__default_camera__"
            ? undefined
            : (selectedSourceId ?? undefined),
        );
      } else {
        await startScreenShare({
          sourceId: selectedSourceId ?? undefined,
          includePreview,
        });
      }
      onOpenChange(false);
    } catch (error) {
      console.error(`Failed to share ${kind}`, error);
      if (kind === "camera") {
        setCameraPreviewVersion((version) => version + 1);
      }
      toast(
        "error",
        error instanceof Error ? error.message : `Failed to share ${kind}.`,
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[90%] gap-0 overflow-hidden p-0"
        portalProps={{ container: portalContainer }}
      >
        <DialogHeader className="p-4 pb-3">
          <DialogTitle>
            {kind === "camera" ? "Share a camera" : "Share your screen"}
          </DialogTitle>
        </DialogHeader>

        <div className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto px-4 pb-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {sources.map((source) => {
              const selected = source.id === selectedSourceId;
              return (
                <MediaSourceCard
                  key={source.id}
                  source={source}
                  selected={selected}
                  previewStream={selected ? cameraPreview : null}
                  onSelect={() => setSelectedSourceId(source.id)}
                />
              );
            })}
          </div>

          {!loading && sources.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No {kind === "camera" ? "cameras" : "windows or displays"} found.
            </p>
          ) : null}

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading sources...
            </div>
          ) : null}
        </div>

        <DialogFooter className="m-0! p-2!">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={loading || sources.length === 0 || !selectedSourceId}
            onClick={startSharing}
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : null}
            Start sharing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

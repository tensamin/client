import {
  forwardRef,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type ComponentRef,
} from "react";
import {
  Button,
  Checkbox,
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  RadioGroupItem,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useIsMobile,
} from "@nonanium/ui";
import { Diamond, MonitorDot, ScreenShare } from "lucide-react";
import { toast } from "@tensamin/shared/log";
import { storageDefaults } from "@tensamin/shared/data";
import { useStorage } from "@tensamin/storage/context";
import { startScreenShare, stopScreenShare, useCall } from "../../store";
import { getMediaShareAdapter } from "../../mediaShare";
import MediaShareDialog from "../mediaShareDialog";

const MediaShareTrigger = forwardRef<
  ComponentRef<typeof Button>,
  Omit<ComponentPropsWithoutRef<typeof Button>, "variant"> & {
    isScreensharing: boolean;
    iconSize?: number;
  }
>(function MediaShareTrigger({ isScreensharing, iconSize, ...props }, ref) {
  return (
    <Button
      ref={ref}
      {...props}
      aria-label={isScreensharing ? "Screen sharing options" : "Share screen"}
      variant={isScreensharing ? "default" : "secondary"}
      className={`${props.className ?? ""} motion-safe:transition-colors motion-safe:duration-200`}
    >
      {isScreensharing ? (
        <MonitorDot style={{ scale: `${iconSize ? iconSize + 100 : 100}%` }} />
      ) : (
        <ScreenShare style={{ scale: `${iconSize ? iconSize + 100 : 100}%` }} />
      )}
    </Button>
  );
});

export default function MediaShareButton({
  className,
  iconSize,
  tooltip,
  defaultPortal,
}: {
  className?: string;
  iconSize?: number;
  tooltip?: string;
  defaultPortal?: boolean;
}) {
  const isScreensharing = useCall((state) => state.screenShareEnabled);
  const isMobile = useIsMobile();
  const screenShareSession = useCall((state) => state.screenShareSession);
  const screenRef = useCall((state) => state.screenRef);
  const [portalContainer, setPortalContainer] = useState<HTMLElement>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const storage = useStorage();
  const [resolution, setResolution] = useState(
    storageDefaults.call_screen_share_resolution,
  );
  const [frameRate, setFrameRate] = useState(
    storageDefaults.call_screen_share_frame_rate,
  );
  const [shareAudio, setShareAudio] = useState(
    storageDefaults.call_screen_share_audio,
  );
  const [canCaptureAudio, setCanCaptureAudio] = useState(true);
  const [includePreview, setIncludePreview] = useState(true);

  useEffect(() => {
    if (!defaultPortal) setPortalContainer(screenRef?.current ?? undefined);
  }, [screenRef, defaultPortal]);

  useEffect(() => {
    if (!menuOpen) return;
    void Promise.all([
      storage.load("call_screen_share_resolution"),
      storage.load("call_screen_share_frame_rate"),
      storage.load("call_screen_share_audio"),
      getMediaShareAdapter().getCapabilities(),
    ]).then(([nextResolution, nextFrameRate, nextShareAudio, capabilities]) => {
      setResolution(nextResolution);
      setFrameRate(nextFrameRate);
      setShareAudio(nextShareAudio);
      setCanCaptureAudio(capabilities.canShareScreenAudio);
    });
  }, [menuOpen, storage]);

  async function beginScreenShare() {
    try {
      const capabilities = await getMediaShareAdapter().getCapabilities();
      if (capabilities.screenPicker === "sources") {
        setDialogOpen(true);
      } else {
        await startScreenShare({
          includePreview,
          includeAudio: shareAudio,
          resolution,
          frameRate,
        });
      }
    } catch (error) {
      console.error("Failed to start screen sharing", error);
      toast(
        "error",
        error instanceof Error
          ? error.message
          : "Failed to start screen sharing.",
      );
    }
  }

  async function stop() {
    try {
      await stopScreenShare();
      setMenuOpen(false);
    } catch (error) {
      console.error("Failed to stop screen sharing", error);
      toast("error", "Failed to stop screen sharing.");
    }
  }

  const menuContent = (
    <>
      <div className="flex flex-col gap-2.5">
        <Label>Resolution</Label>
        <RadioGroup
          className="gap-1.5"
          name="screen-share-resolution"
          value={String(resolution)}
          onValueChange={(value) => {
            const next = Number(value);
            setResolution(next);
            void storage.save("call_screen_share_resolution", next);
          }}
        >
          {[720, 1080].map((value) => (
            <Label
              key={value}
              className="flex cursor-pointer items-center gap-2 rounded-md text-sm"
            >
              <RadioGroupItem value={String(value)} />
              {value}p
            </Label>
          ))}
          <Label className="text-muted-foreground flex cursor-not-allowed items-center gap-2 rounded-md text-sm">
            <RadioGroupItem value="1440" disabled />
            1440p <Diamond className="size-3 fill-current" />
          </Label>
        </RadioGroup>
      </div>
      <div className="flex flex-col gap-2.5">
        <Label>Frame rate</Label>
        <RadioGroup
          className="gap-1.5"
          name="screen-share-frame-rate"
          value={String(frameRate)}
          onValueChange={(value) => {
            const next = Number(value);
            setFrameRate(next);
            void storage.save("call_screen_share_frame_rate", next);
          }}
        >
          {[30, 60].map((value) => (
            <Label
              key={value}
              className="flex cursor-pointer items-center gap-2 rounded-md text-sm"
            >
              <RadioGroupItem value={String(value)} />
              {value} FPS
            </Label>
          ))}
          <Label className="text-muted-foreground flex cursor-not-allowed items-center gap-2 rounded-md text-sm">
            <RadioGroupItem value="120" disabled />
            120 FPS <Diamond className="size-3 fill-current" />
          </Label>
        </RadioGroup>
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Checkbox
            id="screen-share-audio"
            checked={shareAudio}
            disabled={
              !shareAudio &&
              (!canCaptureAudio ||
                (isScreensharing && !screenShareSession?.audioTrack))
            }
            onCheckedChange={(checked) => {
              const next = checked === true;
              setShareAudio(next);
              void storage.save("call_screen_share_audio", next);
            }}
          />
          <Label htmlFor="screen-share-audio">Share audio</Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="screen-share-preview"
            checked={includePreview}
            disabled={isScreensharing}
            onCheckedChange={(checked) => setIncludePreview(checked === true)}
          />
          <Label htmlFor="screen-share-preview">Share preview</Label>
        </div>
        {isScreensharing ? (
          <Button variant="destructive" onClick={() => void stop()}>
            Stop
          </Button>
        ) : (
          <Button
            onClick={() => {
              setMenuOpen(false);
              void beginScreenShare();
            }}
          >
            Start
          </Button>
        )}
      </div>
    </>
  );

  return (
    <>
      {isMobile ? (
        <Drawer open={menuOpen} onOpenChange={setMenuOpen}>
          <DrawerTrigger asChild>
            <MediaShareTrigger
              isScreensharing={isScreensharing}
              iconSize={iconSize}
              className={className}
            />
          </DrawerTrigger>
          <DrawerContent className="overflow-hidden">
            <DrawerHeader className="shrink-0 pb-0">
              <DrawerTitle>Share your screen</DrawerTitle>
            </DrawerHeader>
            <div className="flex min-h-0 flex-col gap-6 overflow-y-auto overscroll-contain p-4">
              {menuContent}
            </div>
          </DrawerContent>
        </Drawer>
      ) : (
        <Tooltip>
          <Popover onOpenChange={setMenuOpen} open={menuOpen}>
            <PopoverTrigger
              render={({ onClick }) =>
                tooltip ? (
                  <TooltipTrigger
                    render={({ ref }) => (
                      <MediaShareTrigger
                        ref={ref}
                        isScreensharing={isScreensharing}
                        iconSize={iconSize}
                        onClick={onClick}
                        className={className}
                      />
                    )}
                  />
                ) : (
                  <MediaShareTrigger
                    isScreensharing={isScreensharing}
                    iconSize={iconSize}
                    onClick={onClick}
                    className={className}
                  />
                )
              }
            />
            <PopoverContent
              className="flex w-35 flex-col gap-6"
              portalProps={{
                container: defaultPortal ? undefined : portalContainer,
              }}
            >
              {menuContent}
            </PopoverContent>
          </Popover>
          {tooltip ? (
            <TooltipContent
              portalProps={{
                container: defaultPortal ? undefined : portalContainer,
              }}
            >
              {tooltip}
            </TooltipContent>
          ) : null}
        </Tooltip>
      )}

      {dialogOpen ? (
        <MediaShareDialog
          kind="screen"
          open
          onOpenChange={setDialogOpen}
          portalContainer={portalContainer}
          includePreview={includePreview}
        />
      ) : null}
    </>
  );
}

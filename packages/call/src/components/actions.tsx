import {
  Card,
  CardContent,
  Button,
  Slider,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useIsMobile,
  cn,
} from "@nonanium/ui";
import { useEffect, useRef, useState } from "react";
import MuteButton from "./buttons/mute";
import MediaShareButton from "./buttons/mediaShare";
import CameraShareButton from "./buttons/cameraShare";
import LeaveButton from "./buttons/leave";
import {
  setCallIsPopout,
  setScreenShareVolume,
  setUsersInFocusedViewHidden,
  stopWatchingFocusedStream,
  triggerCallLayoutCalculation,
  useCall,
} from "../store";
import InviteButton from "./buttons/invite";
import {
  ChevronDown,
  ChevronUp,
  Maximize,
  Minimize,
  ScreenShareOff,
  SquareArrowOutDownLeft,
  SquareArrowOutUpRight,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useStorage } from "@tensamin/storage/context";

export default function Actions() {
  const isMobile = useIsMobile();
  const sharedClasses = isMobile
    ? "min-w-11 flex-1 h-11! px-0!"
    : "w-14! h-10!";
  const sharedIconSize = 15;
  const view = useCall((state) => state.view);
  const focusedParticipantId = useCall((state) => state.focusedParticipantId);
  const watchedStreamParticipantIds = useCall(
    (state) => state.watchedStreamParticipantIds,
  );
  const isWatchingFocusedStream =
    view === "focused" &&
    focusedParticipantId != null &&
    watchedStreamParticipantIds.includes(focusedParticipantId);

  const { load, save } = useStorage();
  const [ownId, setOwnId] = useState(0);
  const [screenShareVolume, setScreenShareVolumeState] = useState(100);
  const [screenShareMuted, setScreenShareMuted] = useState(false);
  const lastNonzeroScreenShareVolume = useRef(100);
  useEffect(() => {
    void Promise.all([load("user_id"), load("call_screen_share_volume")]).then(
      ([userId, volume]) => {
        setOwnId(userId);
        setScreenShareVolumeState(volume);
        if (volume > 0) lastNonzeroScreenShareVolume.current = volume;
      },
    );
  }, [load]);

  // Fullscreen stuff
  const callIsPopout = useCall((state) => state.callIsPopout);
  const callIsFullscreen = useCall((state) => state.callIsFullscreen);
  const focusedParticipantType = useCall(
    (state) => state.focusedParticipantType,
  );
  const activeScreenShareAudioParticipantIds = useCall(
    (state) => state.activeScreenShareAudioParticipantIds,
  );
  const showScreenShareVolume =
    isWatchingFocusedStream &&
    focusedParticipantType === "stream" &&
    focusedParticipantId != null &&
    focusedParticipantId !== ownId;
  const screenShareHasAudio =
    focusedParticipantId != null &&
    activeScreenShareAudioParticipantIds.includes(focusedParticipantId);

  useEffect(() => {
    setScreenShareMuted(false);
  }, [focusedParticipantId]);
  const screenRef = useCall((state) => state.screenRef);
  const [portalContainer, setPortalContainer] = useState<HTMLElement>();

  useEffect(() => {
    setPortalContainer(screenRef?.current ?? undefined);
  }, [screenRef]);

  const toggleFullscreen = async () => {
    const screen = screenRef?.current;
    const fullscreenDocument = screen?.ownerDocument ?? document;

    if (callIsFullscreen) {
      await fullscreenDocument.exitFullscreen().catch(() => undefined);
    } else {
      await screen?.requestFullscreen().catch(() => undefined);
    }

    triggerCallLayoutCalculation();
  };

  // Hide users in focused view
  const usersInFocusedViewHidden = useCall(
    (state) => state.usersInFocusedViewHidden,
  );

  return (
    <div
      className={cn(
        "w-full flex items-center",
        isMobile ? "justify-center" : "justify-between",
      )}
    >
      {!isMobile && (
        <div
          className={`${showScreenShareVolume ? "w-42" : "w-30"} flex justify-start`}
        >
          {view === "focused" && (
            <Tooltip>
              <TooltipTrigger
                render={({ ref, onClick }) => (
                  <Button
                    ref={ref as React.Ref<HTMLButtonElement>}
                    onClick={(event) => {
                      onClick?.(event);
                      setUsersInFocusedViewHidden(!usersInFocusedViewHidden);
                    }}
                    variant="ghost"
                    className="w-11 h-11! p-0! ml-3 text-foreground border-0!"
                  >
                    {usersInFocusedViewHidden ? (
                      <ChevronUp className="size-6" />
                    ) : (
                      <ChevronDown className="size-6" />
                    )}
                  </Button>
                )}
              />
              <TooltipContent portalProps={{ container: portalContainer }}>
                Hide users
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
      <Card className={cn("p-1.75", isMobile && "w-full min-w-0 max-w-sm")}>
        <CardContent
          className={cn("p-0! flex gap-1.75", isMobile && "flex-wrap")}
        >
          <MuteButton
            className={sharedClasses}
            iconSize={sharedIconSize}
            tooltip="Mute"
            portalContainer={portalContainer}
          />
          <MediaShareButton
            className={sharedClasses}
            iconSize={sharedIconSize}
            tooltip="Share screen"
          />
          <CameraShareButton
            className={sharedClasses}
            iconSize={sharedIconSize}
            tooltip="Camera"
            portalContainer={portalContainer}
          />
          <InviteButton
            className={sharedClasses}
            iconSize={sharedIconSize}
            tooltip="Invite"
          />
          {isWatchingFocusedStream && focusedParticipantId !== ownId ? (
            <Tooltip>
              <TooltipTrigger
                render={({ ref, onClick }) => (
                  <Button
                    ref={ref}
                    className={sharedClasses}
                    variant="destructive"
                    onClick={(event) => {
                      onClick?.(event);
                      stopWatchingFocusedStream();
                    }}
                  >
                    <ScreenShareOff
                      style={{
                        scale:
                          (sharedIconSize ? sharedIconSize + 100 : 100) + "%",
                      }}
                    />
                  </Button>
                )}
              />
              <TooltipContent portalProps={{ container: portalContainer }}>
                Stop watching
              </TooltipContent>
            </Tooltip>
          ) : (
            <LeaveButton
              className={sharedClasses}
              iconSize={sharedIconSize}
              tooltip="Leave"
              portalContainer={portalContainer}
            />
          )}
        </CardContent>
      </Card>
      {!isMobile && (
        <div
          className={`${showScreenShareVolume ? "w-42" : "w-30"} flex justify-end gap-1.5`}
        >
          {showScreenShareVolume ? (
            <div className="group relative flex items-center">
              <div className="invisible absolute right-0 bottom-full z-50 pb-1 opacity-0 transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
                <div className="bg-popover flex h-auto w-11 justify-center rounded-md border p-3 shadow-md">
                  <Slider
                    orientation="vertical"
                    min={0}
                    max={100}
                    step={1}
                    value={[screenShareVolume]}
                    disabled={!screenShareHasAudio}
                    onValueChange={(value) => {
                      const next =
                        typeof value === "number"
                          ? value
                          : (value[0] ?? screenShareVolume);
                      if (next > 0) {
                        lastNonzeroScreenShareVolume.current = next;
                      }
                      setScreenShareMuted(false);
                      setScreenShareVolumeState(next);
                      setScreenShareVolume(next);
                      void save("call_screen_share_volume", next);
                    }}
                  />
                </div>
              </div>
              <Button
                disabled={!screenShareHasAudio}
                variant="ghost"
                className="w-11 h-11! p-0! text-foreground border-0!"
                onClick={() => {
                  if (screenShareMuted) {
                    const restoredVolume = lastNonzeroScreenShareVolume.current;
                    setScreenShareMuted(false);
                    setScreenShareVolumeState(restoredVolume);
                    setScreenShareVolume(restoredVolume);
                  } else if (screenShareVolume === 0) {
                    const restoredVolume = lastNonzeroScreenShareVolume.current;
                    setScreenShareVolumeState(restoredVolume);
                    setScreenShareVolume(restoredVolume);
                    void save("call_screen_share_volume", restoredVolume);
                  } else {
                    lastNonzeroScreenShareVolume.current = screenShareVolume;
                    setScreenShareMuted(true);
                    setScreenShareVolumeState(0);
                    setScreenShareVolume(0);
                  }
                }}
              >
                {screenShareMuted || screenShareVolume === 0 ? (
                  <VolumeX className="size-6" />
                ) : (
                  <Volume2 className="size-6" />
                )}
              </Button>
            </div>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={({ ref, onClick }) => (
                <Button
                  ref={ref}
                  onClick={(event) => {
                    onClick?.(event);
                    setCallIsPopout(!callIsPopout);
                  }}
                  variant="ghost"
                  className="w-11 h-11! p-0! text-foreground border-0!"
                >
                  {callIsPopout ? (
                    <SquareArrowOutDownLeft className="size-6" />
                  ) : (
                    <SquareArrowOutUpRight className="size-6" />
                  )}
                </Button>
              )}
            />
            <TooltipContent portalProps={{ container: portalContainer }}>
              Popout
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={({ ref, onClick }) => (
                <Button
                  ref={ref}
                  onClick={(event) => {
                    onClick?.(event);
                    void toggleFullscreen();
                  }}
                  variant="ghost"
                  className="w-11 h-11! p-0! mr-3 text-foreground border-0!"
                >
                  {callIsFullscreen ? (
                    <Minimize className="size-6" />
                  ) : (
                    <Maximize className="size-6" />
                  )}
                </Button>
              )}
            />
            <TooltipContent portalProps={{ container: portalContainer }}>
              Fullscreen
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

import {
  Button,
  ContextMenu as UIContextMenu,
  ContextMenuTrigger,
  cn,
} from "@nonanium/ui";
import {
  focusParticipant,
  getRoomMetadata,
  setCallView,
  startWatchingStream,
  useCall,
} from "../../store";
import { Track, type Participant } from "livekit-client";
import { useEffect, useState } from "react";
import { type SelectedUser, useUserFields } from "@tensamin/identity/context";
import { useIsSpeaking } from "../../speakingState";
import VideoViewer from "../videoViewer";
import { HeadphoneOff, MicOff, Monitor, Plus, Shield } from "lucide-react";
import ContextMenu from "./contextMenu";
import { useStorage } from "@tensamin/storage/context";
import { getTrackPublicationBySource } from "../../participants";
import ParticipantCard, {
  ParticipantCardAvatar,
  ParticipantNameplate,
} from "../participantCard";

const USER_FIELDS = ["UserId", "Avatar", "Display"] as const;

function TransparentButton({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-6 items-center justify-center rounded-sm border border-white/15 bg-black/55 px-1.5 text-white">
      {children}
    </div>
  );
}

function Overlay({
  type,
  user,
  participant,
  transitionOnly = false,
}: {
  type: "user" | "stream";
  user: SelectedUser<typeof USER_FIELDS>;
  participant: Participant;
  transitionOnly?: boolean;
}) {
  const isAdmin = getRoomMetadata()?.admins.includes(user.UserId) === true;
  const isDeafened = participant.attributes["deafened"] === "true";

  return (
    <div
      className={cn(
        "flex h-auto w-fit max-w-full items-center gap-1 rounded-sm backdrop-blur-md",
        // Keep a destination for the focused overlay so it travels with its tile.
        transitionOnly && "pointer-events-none opacity-0",
      )}
      data-call-focused-overlay={transitionOnly ? "" : undefined}
      style={{
        viewTransitionName: `call-overlay-${type}-${user.UserId}`,
        viewTransitionClass: "call-overlay",
      }}
    >
      {type === "user" && (
        <>
          {!participant.isMicrophoneEnabled && (
            <TransparentButton>
              <MicOff className="size-3.5" />
            </TransparentButton>
          )}
          {isDeafened && (
            <TransparentButton>
              <HeadphoneOff className="size-3.5" />
            </TransparentButton>
          )}
          {isAdmin && (
            <TransparentButton>
              <Shield className="size-3.5" />
            </TransparentButton>
          )}
        </>
      )}
      {type === "stream" && (
        <TransparentButton>
          <Monitor className="size-3.5" />
        </TransparentButton>
      )}
      <ParticipantNameplate name={user.Display} />
    </div>
  );
}

export default function Base({
  participant,
  type,
  fill = false,
  flush = false,
  zoomable = false,
}: {
  participant: Participant | undefined;
  type: "user" | "stream";
  fill?: boolean;
  flush?: boolean;
  zoomable?: boolean;
}) {
  const { load } = useStorage();

  const focusedParticipantId = useCall((state) => state.focusedParticipantId);
  const view = useCall((state) => state.view);
  const participantId = Number(participant?.identity);
  const validParticipantId =
    participant && Number.isInteger(participantId) && participantId > 0
      ? participantId
      : null;
  const { data: user } = useUserFields(validParticipantId, USER_FIELDS);
  const isSpeaking = useIsSpeaking(user?.UserId ?? -1);
  const screenSharePublication = getTrackPublicationBySource(
    participant,
    Track.Source.ScreenShare,
  );
  const screenSharePreview = participant?.attributes["screenSharePreview"];
  const cameraPublication = getTrackPublicationBySource(
    participant,
    Track.Source.Camera,
  );
  const cameraDisabled = useCall((state) =>
    user ? state.disabledCameraParticipantIds.includes(user.UserId) : false,
  );

  const [ownId, setOwnId] = useState(0);
  useEffect(() => {
    load("user_id").then(setOwnId);
  }, [load]);

  if (!participant || !user) {
    return (
      <div
        className={`aspect-video w-full animate-pulse bg-muted ${
          flush ? "rounded-none" : "rounded-md"
        }`}
      />
    );
  }

  const onClick = () => {
    if (view === "grid") {
      focusParticipant(user.UserId, type);
    } else {
      if (user.UserId === focusedParticipantId) {
        setCallView("grid");
      } else {
        focusParticipant(user.UserId, type);
      }
    }
  };

  const showStream =
    screenSharePublication?.isSubscribed && screenSharePublication.track;

  const isFocusedInFocusedView =
    view === "focused" && user.UserId === focusedParticipantId;

  return (
    <UIContextMenu>
      <ContextMenuTrigger
        render={
          <div
            onClick={onClick}
            className={cn(
              "relative w-full",
              fill ? "h-full" : "aspect-video",
              flush && !fill && "border-x-0!",
              type === "user" &&
                isSpeaking &&
                "rounded-lg after:pointer-events-none after:absolute after:inset-0 after:z-30 after:rounded-lg after:border-4 after:border-(--primary-foreground-alt)/75",
            )}
          >
            <div
              className={cn(
                "z-20 absolute bottom-0 left-0 w-full h-full flex justify-start items-end p-2",
                zoomable && showStream && "pointer-events-none",
              )}
            >
              <>
                {type === "stream" && !showStream && (
                  <div className="absolute top-0 left-0 w-full h-full flex items-center justify-center gap-2">
                    <Button
                      variant="outline"
                      onClick={(event) => {
                        if (isFocusedInFocusedView) event.stopPropagation();
                        startWatchingStream(user.UserId);
                      }}
                    >
                      Watch Stream
                    </Button>
                    {!isFocusedInFocusedView && (
                      <Button
                        variant="outline"
                        onClick={(event) => {
                          event.stopPropagation();
                          startWatchingStream(user.UserId);
                        }}
                      >
                        <Plus className="w-8 h-8" />
                      </Button>
                    )}
                  </div>
                )}
                <Overlay
                  type={type}
                  user={user}
                  participant={participant}
                  transitionOnly={isFocusedInFocusedView}
                />
              </>
            </div>
            <ParticipantCard
              user={type === "user" ? user : undefined}
              fill={fill}
              flush={flush}
            >
              {/* Detect video / user and place here */}

              {type === "stream" &&
                (showStream ? (
                  <VideoViewer
                    fill={fill}
                    flush={flush}
                    participantId={participant.identity}
                    publication={screenSharePublication}
                    zoomable={zoomable}
                  />
                ) : screenSharePreview ? (
                  <div
                    className={`absolute inset-0 bg-muted h-full w-full object-cover ${
                      flush ? "rounded-none" : "rounded-sm"
                    }`}
                  >
                    <img
                      src={screenSharePreview}
                      className={`blur-sm h-full w-full object-cover opacity-50 ${
                        flush ? "rounded-none" : "rounded-sm"
                      }`}
                    />
                  </div>
                ) : null)}

              {type === "user" &&
                (cameraPublication?.track && !cameraDisabled ? (
                  <VideoViewer
                    fill={fill}
                    flush={flush}
                    participantId={participant.identity}
                    publication={cameraPublication}
                  />
                ) : (
                  <ParticipantCardAvatar user={user} />
                ))}
            </ParticipantCard>
          </div>
        }
      />
      <ContextMenu user={user} ownId={ownId} />
    </UIContextMenu>
  );
}

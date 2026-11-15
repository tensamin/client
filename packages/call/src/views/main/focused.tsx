import { useIsMobile } from "@nonanium/ui";
import { RoomEvent } from "livekit-client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Base from "../../components/modals/base";
import { useCall, useCallActions } from "../../store";

const SECONDARY_ROW_HEIGHT_PX = 180;
const STACK_GAP_PX = 12;

export default function View() {
  const { getRoom, setUsersInFocusedViewHidden } = useCallActions();

  const isMobile = useIsMobile();
  const room = getRoom();
  const layoutVersion = useCall((state) => state.layoutVersion);

  const usersInFocusedViewHidden = useCall(
    (state) => state.usersInFocusedViewHidden,
  );
  const callIsFullscreen = useCall((state) => state.callIsFullscreen);

  const focusedParticipantId = useCall((state) => state.focusedParticipantId);
  const focusedParticipantType = useCall(
    (state) => state.focusedParticipantType,
  );
  const activeScreenShareParticipantIds = useCall(
    (state) => state.activeScreenShareParticipantIds,
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusedTileRef = useRef<HTMLDivElement | null>(null);
  const [isFocusedTileFlush, setIsFocusedTileFlush] = useState(false);
  const [participantVersion, setParticipantVersion] = useState(0);

  useEffect(() => {
    if (isMobile) setUsersInFocusedViewHidden(true);
  }, [isMobile, setUsersInFocusedViewHidden]);

  useEffect(() => {
    const syncParticipants = () => {
      setParticipantVersion((version) => version + 1);
    };
    syncParticipants();
    room.on(RoomEvent.ParticipantConnected, syncParticipants);
    room.on(RoomEvent.ParticipantDisconnected, syncParticipants);
    room.on(RoomEvent.TrackPublished, syncParticipants);
    room.on(RoomEvent.TrackUnpublished, syncParticipants);
    room.on(RoomEvent.TrackSubscribed, syncParticipants);
    room.on(RoomEvent.TrackUnsubscribed, syncParticipants);
    room.on(RoomEvent.ParticipantAttributesChanged, syncParticipants);

    return () => {
      room.off(RoomEvent.ParticipantConnected, syncParticipants);
      room.off(RoomEvent.ParticipantDisconnected, syncParticipants);
      room.off(RoomEvent.TrackPublished, syncParticipants);
      room.off(RoomEvent.TrackUnpublished, syncParticipants);
      room.off(RoomEvent.TrackSubscribed, syncParticipants);
      room.off(RoomEvent.TrackUnsubscribed, syncParticipants);
      room.off(RoomEvent.ParticipantAttributesChanged, syncParticipants);
    };
  }, [room]);

  const users = useMemo(() => {
    const participants = [
      ...room.remoteParticipants.values(),
      room.localParticipant,
    ];

    return participants.filter((participant) => {
      const participantId = Number(participant.identity);
      return Number.isInteger(participantId) && participantId > 0;
    });
    // eslint-disable-next-line
  }, [participantVersion, room]);

  const userIds = useMemo(
    () => users.map((participant) => Number(participant.identity)),
    [users],
  );
  const activeScreenShareParticipantIdSet = useMemo(
    () => new Set(activeScreenShareParticipantIds),
    [activeScreenShareParticipantIds],
  );

  const tiles = useMemo(
    () => [
      ...activeScreenShareParticipantIds
        .filter((id) => id !== focusedParticipantId)
        .map((participantId) => ({
          key: `stream:${participantId}`,
          kind: "stream" as const,
          participantId,
        })),
      ...userIds
        .filter((id) => id !== focusedParticipantId)
        .filter((id) => !activeScreenShareParticipantIdSet.has(id))
        .map((participantId) => ({
          key: `user:${participantId}`,
          kind: "user" as const,
          participantId,
        })),
    ],
    [
      activeScreenShareParticipantIds,
      activeScreenShareParticipantIdSet,
      userIds,
      focusedParticipantId,
    ],
  );

  useLayoutEffect(() => {
    const container = containerRef.current;
    const focusedTile = focusedTileRef.current;

    if (!container || !focusedTile) {
      return;
    }

    let frameId = 0;

    const syncTileLayout = () => {
      const containerWidth = Math.floor(
        container.getBoundingClientRect().width,
      );
      const tileWidth = Math.floor(focusedTile.getBoundingClientRect().width);

      setIsFocusedTileFlush(Math.abs(containerWidth - tileWidth) <= 1);
    };

    const scheduleSyncTileLayout = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(syncTileLayout);
    };

    syncTileLayout();

    const observer = new ResizeObserver(() => {
      scheduleSyncTileLayout();
    });
    observer.observe(container);
    observer.observe(focusedTile);

    window.addEventListener("resize", scheduleSyncTileLayout);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", scheduleSyncTileLayout);
    };
  }, [
    layoutVersion,
    tiles.length,
    focusedParticipantId,
    usersInFocusedViewHidden,
  ]);

  if (focusedParticipantId == null) {
    return null;
  }

  function getParticipantById(participantId: number) {
    if (Number(room.localParticipant.identity) === participantId) {
      return room.localParticipant;
    }

    return room.getParticipantByIdentity(String(participantId));
  }

  const focusedParticipant = getParticipantById(focusedParticipantId);
  const focusedParticipantHasActiveScreenShare =
    activeScreenShareParticipantIdSet.has(focusedParticipantId);
  const focusedTileType: "user" | "stream" =
    focusedParticipantType === "stream" &&
    focusedParticipantHasActiveScreenShare
      ? "stream"
      : "user";
  const isImmersiveFocusedView = callIsFullscreen && usersInFocusedViewHidden;

  return (
    <div ref={containerRef} className="flex h-full w-full overflow-hidden">
      <div
        className="flex h-full w-full flex-col items-center overflow-hidden"
        style={{
          gap: tiles.length > 0 && !isImmersiveFocusedView ? STACK_GAP_PX : 0,
        }}
      >
        <div className="flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden">
          <div
            ref={focusedTileRef}
            style={{
              viewTransitionName: `call-${focusedTileType}-${focusedParticipantId}`,
            }}
            className={
              isImmersiveFocusedView
                ? "h-full w-full overflow-hidden"
                : "h-full max-w-full aspect-video overflow-hidden flex items-center"
            }
          >
            <Base
              fill={isImmersiveFocusedView}
              flush={isImmersiveFocusedView || isFocusedTileFlush}
              type={focusedTileType}
              participant={focusedParticipant}
              zoomable={!isMobile && focusedTileType === "stream"}
            />
          </div>
        </div>
        {tiles.length > 0 && (
          <div
            hidden={usersInFocusedViewHidden}
            className="w-full shrink-0 flex justify-center gap-2 overflow-x-auto"
            style={{ height: SECONDARY_ROW_HEIGHT_PX }}
          >
            {tiles.map((tile) => (
              <div
                key={tile.key}
                className="h-full shrink-0 aspect-video"
                style={{
                  viewTransitionName: `call-${tile.key.replace(":", "-")}`,
                }}
              >
                <Base
                  type={tile.kind}
                  participant={getParticipantById(tile.participantId)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

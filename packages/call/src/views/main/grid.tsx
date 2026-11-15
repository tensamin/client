import { cn, useIsMobile } from "@nonanium/ui";
import { RoomEvent } from "livekit-client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Base from "../../components/modals/base";
import { PreviewParticipant } from "../../components/participantCard";
import { useCall, useCallActions } from "../../store";

const TILE_ASPECT_RATIO = 16 / 9;
const GRID_GAP = 12;

type GridLayout = {
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  rowCounts: number[];
};

function buildBalancedRows(itemCount: number, rows: number) {
  if (itemCount === 0 || rows === 0) {
    return [];
  }

  const baseCount = Math.floor(itemCount / rows);
  const remainder = itemCount % rows;

  return Array.from(
    { length: rows },
    (_, index) => baseCount + (index < remainder ? 1 : 0),
  );
}

export function calculateOptimalGridLayout(
  containerWidth: number,
  containerHeight: number,
  itemCount: number,
  gap = GRID_GAP,
): GridLayout {
  if (containerWidth <= 0 || containerHeight <= 0 || itemCount <= 0) {
    return {
      columns: 0,
      rows: 0,
      tileWidth: 0,
      tileHeight: 0,
      rowCounts: [],
    };
  }

  let bestLayout: GridLayout = {
    columns: 1,
    rows: itemCount,
    tileWidth: 0,
    tileHeight: 0,
    rowCounts: Array.from({ length: itemCount }, () => 1),
  };

  for (let columns = 1; columns <= itemCount; columns++) {
    const rows = Math.ceil(itemCount / columns);
    const maxTileWidth =
      (containerWidth - gap * Math.max(columns - 1, 0)) / columns;
    const maxTileHeight =
      (containerHeight - gap * Math.max(rows - 1, 0)) / rows;
    const tileWidth = Math.min(maxTileWidth, maxTileHeight * TILE_ASPECT_RATIO);
    const tileHeight = tileWidth / TILE_ASPECT_RATIO;

    if (tileWidth <= 0 || tileHeight <= 0) {
      continue;
    }

    const currentArea = tileWidth * tileHeight;
    const bestArea = bestLayout.tileWidth * bestLayout.tileHeight;

    if (currentArea > bestArea) {
      bestLayout = {
        columns,
        rows,
        tileWidth,
        tileHeight,
        rowCounts: buildBalancedRows(itemCount, rows),
      };
    }
  }

  return bestLayout;
}

export default function View() {
  const { getRoom } = useCallActions();

  const room = getRoom();
  const layoutVersion = useCall((state) => state.layoutVersion);
  const activeScreenShareParticipantIds = useCall(
    (state) => state.activeScreenShareParticipantIds,
  );
  const currentCallData = useCall((state) => state.currentCallData);
  const callState = useCall((state) => state.state);
  const containerRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef(new Map<string, HTMLDivElement>());
  const previousTiles = useRef<Set<string> | null>(null);

  const [containerSize, setContainerSize] = useState(() => {
    const stage = document.querySelector<HTMLElement>("[data-call-stage]");
    const width = stage?.clientWidth ?? 0;
    const height = stage?.clientHeight ?? 0;
    const padding = matchMedia("(max-width: 767px)").matches ? 0 : 24;
    return {
      width: Math.max(0, width - 32 - padding),
      height: Math.max(0, height - 32 - padding),
    };
  });
  const [participantVersion, setParticipantVersion] = useState(0);

  useLayoutEffect(() => {
    const element = containerRef.current;

    if (!element) {
      return;
    }

    const syncContainerSize = () => {
      const { width, height } = element.getBoundingClientRect();
      const styles = getComputedStyle(element);
      setContainerSize({
        width:
          width -
          parseFloat(styles.paddingLeft) -
          parseFloat(styles.paddingRight),
        height:
          height -
          parseFloat(styles.paddingTop) -
          parseFloat(styles.paddingBottom),
      });
    };

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setContainerSize({ width, height });
    });

    syncContainerSize();
    observer.observe(element);

    return () => observer.disconnect();
  }, [layoutVersion]);

  useEffect(() => {
    const syncParticipants = () => {
      setParticipantVersion((version) => version + 1);
    };

    syncParticipants();

    room.on(RoomEvent.Connected, syncParticipants);
    room.on(RoomEvent.Disconnected, syncParticipants);
    room.on(RoomEvent.ParticipantConnected, syncParticipants);
    room.on(RoomEvent.ParticipantDisconnected, syncParticipants);
    room.on(RoomEvent.TrackPublished, syncParticipants);
    room.on(RoomEvent.TrackUnpublished, syncParticipants);
    room.on(RoomEvent.TrackSubscribed, syncParticipants);
    room.on(RoomEvent.TrackUnsubscribed, syncParticipants);
    room.on(RoomEvent.ParticipantAttributesChanged, syncParticipants);

    return () => {
      room.off(RoomEvent.Connected, syncParticipants);
      room.off(RoomEvent.Disconnected, syncParticipants);
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

  const userIds = useMemo(() => {
    const connectedIds = users.map((participant) =>
      Number(participant.identity),
    );
    if (currentCallData?.status !== "ready") return connectedIds;
    const connected = new Set(connectedIds);
    return [
      ...currentCallData.userIds.filter(
        (id) => callState !== "open" || connected.has(id),
      ),
      ...connectedIds.filter((id) => !currentCallData.userIds.includes(id)),
    ];
  }, [users, callState, currentCallData]);

  const layout = useMemo(
    () =>
      calculateOptimalGridLayout(
        containerSize.width,
        containerSize.height,
        activeScreenShareParticipantIds.length + userIds.length,
      ),
    [
      activeScreenShareParticipantIds.length,
      containerSize.height,
      containerSize.width,
      userIds.length,
    ],
  );

  const rows = useMemo(() => {
    let nextParticipant = 0;

    return layout.rowCounts.map((count, rowIndex) => {
      const participants = Array.from(
        { length: count },
        () => nextParticipant++,
      );
      return { rowIndex, participants };
    });
  }, [layout.rowCounts]);

  const tiles = useMemo(
    () => [
      ...activeScreenShareParticipantIds.map((participantId) => ({
        key: `stream:${participantId}`,
        kind: "stream" as const,
        participantId,
      })),
      ...userIds.map((participantId) => ({
        key: `user:${participantId}`,
        kind: "user" as const,
        participantId,
      })),
    ],
    [activeScreenShareParticipantIds, userIds],
  );

  useLayoutEffect(() => {
    const current = new Set(tiles.map((tile) => tile.key));
    if (
      previousTiles.current &&
      !document.documentElement.dataset.callTransition &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      for (const key of current) {
        if (!previousTiles.current.has(key)) {
          tileRefs.current.get(key)?.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 160,
            easing: "ease-out",
          });
        }
      }
    }
    previousTiles.current = current;
  }, [tiles]);

  function getParticipantById(participantId: number) {
    if (Number(room.localParticipant.identity) === participantId) {
      return room.localParticipant;
    }

    return room.getParticipantByIdentity(String(participantId));
  }

  const isMobile = useIsMobile();

  return (
    <div
      ref={containerRef}
      style={{
        height: "calc(100% - 2rem)",
        width: "calc(100% - 2rem)",
      }}
      className={cn("overflow-hidden", isMobile ? "" : "p-3")}
    >
      <div className="flex h-full w-full flex-col items-center justify-center gap-3">
        {rows.map((row) => (
          <div key={row.rowIndex} className="flex justify-center gap-3">
            {row.participants.map((userIndex) => {
              const tile = tiles[userIndex];

              if (!tile) {
                return null;
              }

              return (
                <div
                  key={tile.key}
                  ref={(element) => {
                    if (element) tileRefs.current.set(tile.key, element);
                    else tileRefs.current.delete(tile.key);
                  }}
                  className="flex items-center justify-center rounded-xl"
                  style={{
                    width: layout.tileWidth,
                    height: layout.tileHeight,
                    viewTransitionName: `call-${tile.key.replace(":", "-")}`,
                  }}
                >
                  {getParticipantById(tile.participantId) ? (
                    <Base
                      type={tile.kind}
                      participant={getParticipantById(tile.participantId)}
                    />
                  ) : tile.kind === "user" ? (
                    <PreviewParticipant userId={tile.participantId} />
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

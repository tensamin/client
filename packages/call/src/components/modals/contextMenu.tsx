import {
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  Slider,
} from "@nonanium/ui";
import { log, toast } from "@tensamin/shared/log";
import { useEffect, useState } from "react";
import { useCall, useCallActions } from "../../store";

function EmptyCheckboxIndicator({ checked }: { checked: boolean }) {
  if (checked) {
    return null;
  }

  return (
    <span className="pointer-events-none absolute right-2 size-4 rounded-[4px] border border-current opacity-70" />
  );
}

export default function ContextMenu({
  user,
  ownId,
}: {
  user: Readonly<{ UserId: number }>;
  ownId: number;
}) {
  const {
    disconnectUser,
    getParticipantVolume,
    getRoomMetadata,
    setParticipantCameraDisabled,
    setParticipantVolume,
    stopWatchingStream,
  } = useCallActions();

  const [muted, setMuted] = useState(false);
  const [soundboardMuted, setSoundboardMuted] = useState(false);
  const [serverDeafened, setServerDeafened] = useState(false);
  const [serverMuted, setServerMuted] = useState(false);
  const [volume, setVolume] = useState(() => getParticipantVolume(user.UserId));
  const isCallAdmin = getRoomMetadata().admins.includes(ownId);
  useEffect(() => {
    setVolume(getParticipantVolume(user.UserId));
  }, [user.UserId, getParticipantVolume]);
  const watchedStreamParticipantIds = useCall(
    (state) => state.watchedStreamParticipantIds,
  );
  const cameraDisabled = useCall((state) =>
    state.disabledCameraParticipantIds.includes(user.UserId),
  );

  return (
    <ContextMenuContent className="p-1">
      {watchedStreamParticipantIds.includes(user.UserId) &&
      user.UserId !== ownId ? (
        <ContextMenuItem
          variant="destructive"
          onClick={() => stopWatchingStream(user.UserId)}
        >
          Stop Watching
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem>Profile</ContextMenuItem>
      <ContextMenuItem>Change Nickname</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        onSelect={(e) => e.preventDefault()}
        className="flex flex-col items-start pb-2"
      >
        <p>Volume</p>
        <Slider
          min={0}
          max={100}
          step={1}
          value={[volume]}
          disabled={user.UserId === ownId}
          onValueChange={(value) => {
            const next = typeof value === "number" ? value : (value[0] ?? 100);
            setVolume(next);
            setParticipantVolume(user.UserId, next);
          }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        />
      </ContextMenuItem>
      <ContextMenuCheckboxItem
        checked={muted}
        onCheckedChange={setMuted}
        onSelect={(e) => e.preventDefault()}
        className="flex justify-between"
      >
        <p>Mute</p>
        <EmptyCheckboxIndicator checked={muted} />
      </ContextMenuCheckboxItem>
      <ContextMenuCheckboxItem
        checked={soundboardMuted}
        onCheckedChange={setSoundboardMuted}
        onSelect={(e) => e.preventDefault()}
        className="flex justify-between"
      >
        <p>Mute Soundboard</p>
        <EmptyCheckboxIndicator checked={soundboardMuted} />
      </ContextMenuCheckboxItem>
      {user.UserId !== ownId ? (
        <ContextMenuCheckboxItem
          checked={cameraDisabled}
          onCheckedChange={(checked) =>
            setParticipantCameraDisabled(user.UserId, checked)
          }
          onSelect={(e) => e.preventDefault()}
          className="flex justify-between"
        >
          <p>Disable camera</p>
          <EmptyCheckboxIndicator checked={cameraDisabled} />
        </ContextMenuCheckboxItem>
      ) : null}
      {isCallAdmin ? (
        <>
          <ContextMenuCheckboxItem
            checked={serverDeafened}
            onCheckedChange={setServerDeafened}
            onSelect={(e) => e.preventDefault()}
            className="flex justify-between text-destructive focus:text-destructive"
          >
            <p>Global Deaf</p>
            <EmptyCheckboxIndicator checked={serverDeafened} />
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={serverMuted}
            onCheckedChange={setServerMuted}
            onSelect={(e) => e.preventDefault()}
            className="flex justify-between text-destructive focus:text-destructive"
          >
            <p>Global Mute</p>
            <EmptyCheckboxIndicator checked={serverMuted} />
          </ContextMenuCheckboxItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => {
              void disconnectUser(user.UserId).catch((error) => {
                toast("error", "Failed to disconnect user.");
                log(1, "call", "red", "Failed to disconnect call user", error);
              });
            }}
          >
            Disconnect
          </ContextMenuItem>
        </>
      ) : null}
    </ContextMenuContent>
  );
}

import { log } from "@tensamin/shared/log";
import {
  Track,
  type Participant,
  type RemoteTrackPublication,
} from "livekit-client";
import { getTrackPublicationBySource } from "../participants";
import type { CallSession } from "./instance";
import type { RemoteVideoTrackSelector } from "./shared";
import {
  getParticipantId,
  watchedScreenShareParticipantIdsSchema,
} from "./shared";

// audio helpers
export function attachRemoteAudio(
  this: CallSession,
  trackSid: string,
  element: HTMLMediaElement,
) {
  const existingElement = this.remoteAudioElements.get(trackSid);
  if (existingElement) {
    existingElement.remove();
  }
  element.autoplay = true;
  element.style.display = "none";
  document.body.appendChild(element);
  this.remoteAudioElements.set(trackSid, element);
}

export function detachRemoteAudio(this: CallSession, trackSid: string) {
  const element = this.remoteAudioElements.get(trackSid);
  if (!element) {
    return;
  }
  element.remove();
  this.remoteAudioElements.delete(trackSid);
}

export function clearRemoteAudio(this: CallSession) {
  for (const trackSid of this.remoteAudioElements.keys()) {
    this.detachRemoteAudio(trackSid);
  }
}

export function getAllParticipants(this: CallSession): Participant[] {
  const room = this.getRoom();
  return [...room.remoteParticipants.values(), room.localParticipant];
}

export function getRemoteParticipant(this: CallSession, participantId: number) {
  return [...this.getRoom().remoteParticipants.values()].find(
    (participant) => getParticipantId(participant.identity) === participantId,
  );
}

export function getRemoteTrackPublications(
  this: CallSession,
  participantId: number,
) {
  return [
    ...(this.getRemoteParticipant(participantId)?.trackPublications.values() ??
      []),
  ] as RemoteTrackPublication[];
}

export function matchesRemoteTrackSelector(
  this: CallSession,
  publication: Pick<RemoteTrackPublication, "kind" | "source">,
  selector: RemoteVideoTrackSelector,
) {
  return publication.source === selector || publication.kind === selector;
}

export function syncRemoteParticipantTrackSubscriptions(
  this: CallSession,
  participantId: number,
) {
  const state = this.store.getState();
  const watchesScreen =
    state.watchedStreamParticipantIds.includes(participantId);
  const cameraDisabled =
    state.disabledCameraParticipantIds.includes(participantId);
  for (const publication of this.getRemoteTrackPublications(participantId)) {
    const subscribed =
      publication.source === Track.Source.Camera
        ? !cameraDisabled
        : publication.source === Track.Source.ScreenShare ||
            publication.source === Track.Source.ScreenShareAudio
          ? watchesScreen
          : publication.kind === Track.Kind.Audio;
    publication.setSubscribed(subscribed);
  }
}

export function syncAllRemoteTrackSubscriptions(this: CallSession) {
  for (const participant of this.getRoom().remoteParticipants.values()) {
    const participantId = getParticipantId(participant.identity);
    if (participantId != null) {
      this.syncRemoteParticipantTrackSubscriptions(participantId);
    }
  }
}

export function getActiveScreenShareParticipantIds(
  this: CallSession,
): number[] {
  return this.getAllParticipants()
    .map((participant) => ({
      participantId: getParticipantId(participant.identity),
      hasScreenShare:
        getTrackPublicationBySource(participant, Track.Source.ScreenShare) !=
        null,
    }))
    .filter(
      (
        entry,
      ): entry is {
        participantId: number;
        hasScreenShare: true;
      } => entry.participantId != null && entry.hasScreenShare,
    )
    .map((entry) => entry.participantId);
}

export function getScreenShareTrackForParticipant(
  this: CallSession,
  participantId: number,
) {
  const participant = this.getAllParticipants().find(
    (entry) => getParticipantId(entry.identity) === participantId,
  );
  return getTrackPublicationBySource(participant, Track.Source.ScreenShare)
    ?.track;
}

export function hasParticipant(this: CallSession, participantId: number) {
  return this.getAllParticipants().some(
    (participant) => getParticipantId(participant.identity) === participantId,
  );
}

export function publishWatchedScreenShareParticipantIds(this: CallSession) {
  const parsed = watchedScreenShareParticipantIdsSchema.safeParse(
    this.store.getState().watchedStreamParticipantIds,
  );
  if (!parsed.success) {
    log(
      1,
      "call",
      "red",
      "Invalid watched screen share participant IDs",
      parsed.error,
    );
    return;
  }
  const value = JSON.stringify(parsed.data);
  this.watchedScreenShareParticipantIdsUpdate =
    this.watchedScreenShareParticipantIdsUpdate
      .then(() =>
        this.updateLocalParticipantAttributes({
          watchedScreenShareParticipantIds: value,
        }),
      )
      .catch(() => undefined);
}

export function syncScreenShareParticipants(this: CallSession) {
  const activeScreenShareParticipantIds =
    this.getActiveScreenShareParticipantIds();
  const activeScreenShareAudioParticipantIds = this.getAllParticipants()
    .filter(
      (participant) =>
        getTrackPublicationBySource(participant, Track.Source.ScreenShareAudio)
          ?.track != null,
    )
    .map((participant) => getParticipantId(participant.identity))
    .filter((participantId): participantId is number => participantId != null);
  const state = this.store.getState();
  const watchedStreamParticipantIds = state.watchedStreamParticipantIds.filter(
    (participantId) => activeScreenShareParticipantIds.includes(participantId),
  );
  const pendingWatchedParticipantIds = watchedStreamParticipantIds.filter(
    (participantId) =>
      this.getScreenShareTrackForParticipant(participantId) == null,
  );
  const focusedParticipantId =
    state.focusedParticipantId != null &&
    (watchedStreamParticipantIds.includes(state.focusedParticipantId) ||
      this.hasParticipant(state.focusedParticipantId))
      ? state.focusedParticipantId
      : null;
  this.store.setState({
    activeScreenShareParticipantIds,
    activeScreenShareAudioParticipantIds,
    watchedStreamParticipantIds,
    pendingWatchedParticipantIds,
    focusedParticipantId,
    focusedParticipantType:
      focusedParticipantId == null ? null : state.focusedParticipantType,
    view:
      state.view === "focused" && focusedParticipantId == null
        ? "grid"
        : state.view,
  });
  if (
    watchedStreamParticipantIds.length !==
    state.watchedStreamParticipantIds.length
  ) {
    this.publishWatchedScreenShareParticipantIds();
  }
}

export function getRoomMetadata(this: CallSession) {
  const roomMetadata = this.getRoom().metadata;
  try {
    const data = JSON.parse(roomMetadata || '{"admins": []}');
    return data as {
      admins: number[];
    };
  } catch {
    return { admins: [] };
  }
}

// Sync local participant flags and screen-share derived state for the active call UI.
export function syncParticipantState(this: CallSession) {
  const state = this.store.getState();
  const { cameraSession, screenShareSession } = state;
  const room = this.getRoom();
  const isEncrypted =
    room.localParticipant.isE2EEEnabled && room.localParticipant.isEncrypted;
  const warnings = state.warnings.filter(
    (warning) => warning !== "The connected call is not encrypted.",
  );
  if (state.state === "open" && !isEncrypted) {
    warnings.push("The connected call is not encrypted.");
  }
  this.store.setState({
    micEnabled: room.localParticipant.isMicrophoneEnabled,
    cameraEnabled:
      cameraSession != null || room.localParticipant.isCameraEnabled,
    screenShareEnabled:
      screenShareSession != null || room.localParticipant.isScreenShareEnabled,
    isEncrypted,
    warnings,
  });
  this.syncScreenShareParticipants();
}

// Start tracking a participant's shared screen in the call UI.
export function startWatchingStream(this: CallSession, participantId: number) {
  const trackReady =
    this.getScreenShareTrackForParticipant(participantId) != null;
  const alreadyWatching = this.store
    .getState()
    .watchedStreamParticipantIds.includes(participantId);
  const localParticipantId = getParticipantId(
    this.getRoom().localParticipant.identity,
  );
  if (!alreadyWatching && participantId !== localParticipantId) {
    this.playCallEvent("stream_watch_start");
  }
  this.setParticipantTrackSubscribed(participantId, Track.Source.ScreenShare);
  this.setParticipantTrackSubscribed(
    participantId,
    Track.Source.ScreenShareAudio,
  );
  this.store.setState((state) => ({
    watchedStreamParticipantIds: state.watchedStreamParticipantIds.includes(
      participantId,
    )
      ? state.watchedStreamParticipantIds
      : [...state.watchedStreamParticipantIds, participantId],
    pendingWatchedParticipantIds: trackReady
      ? state.pendingWatchedParticipantIds.filter((id) => id !== participantId)
      : state.pendingWatchedParticipantIds.includes(participantId)
        ? state.pendingWatchedParticipantIds
        : [...state.pendingWatchedParticipantIds, participantId],
    focusedParticipantId: participantId,
    focusedParticipantType: "stream",
  }));
  this.publishWatchedScreenShareParticipantIds();
}

// Toggle remote track subscriptions using LiveKit's built-in publication API.
export function setParticipantTrackSubscribed(
  this: CallSession,
  participantId: number,
  selector: RemoteVideoTrackSelector,
  subscribed = true,
) {
  for (const publication of this.getRemoteTrackPublications(participantId)) {
    if (this.matchesRemoteTrackSelector(publication, selector)) {
      publication.setSubscribed(subscribed);
    }
  }
  this.syncParticipantState();
}

export function setParticipantCameraDisabled(
  this: CallSession,
  participantId: number,
  disabled: boolean,
) {
  this.store.setState((state) => ({
    disabledCameraParticipantIds: disabled
      ? state.disabledCameraParticipantIds.includes(participantId)
        ? state.disabledCameraParticipantIds
        : [...state.disabledCameraParticipantIds, participantId]
      : state.disabledCameraParticipantIds.filter((id) => id !== participantId),
  }));
  this.setParticipantTrackSubscribed(
    participantId,
    Track.Source.Camera,
    !disabled,
  );
}

export function getParticipantVolume(this: CallSession, participantId: number) {
  return this.participantVolumes.get(participantId) ?? 100;
}

export function setParticipantVolume(
  this: CallSession,
  participantId: number,
  volume: number,
) {
  const next = Math.max(0, Math.min(100, volume));
  this.participantVolumes.set(participantId, next);
  if (this.store.getState().deaf) return;
  this.getRoom()
    .remoteParticipants.get(String(participantId))
    ?.setVolume(next / 100, Track.Source.Microphone);
}

export function setScreenShareVolume(this: CallSession, volume: number) {
  const next = Math.max(0, Math.min(100, volume)) / 100;
  if (this.store.getState().deaf) return;
  this.getRoom().remoteParticipants.forEach((participant) => {
    participant.setVolume(next, Track.Source.ScreenShareAudio);
  });
}

// Focus a participant in the main call view even when they are not sharing a screen.
export function focusParticipant(
  this: CallSession,
  participantId: number,
  type: "user" | "stream" = "user",
) {
  this.updateCallView(
    () =>
      this.store.setState({
        focusedParticipantId: participantId,
        lastFocusedParticipantId: participantId,
        focusedParticipantType: type,
        view: "focused",
      }),
    "layout",
  );
}

// Stop tracking a participant's shared screen and clean up related UI state.
export function stopWatchingStream(this: CallSession, participantId: number) {
  const wasWatching = this.store
    .getState()
    .watchedStreamParticipantIds.includes(participantId);
  const localParticipantId = getParticipantId(
    this.getRoom().localParticipant.identity,
  );
  if (wasWatching && participantId !== localParticipantId) {
    this.playCallEvent("stream_watch_end");
  }
  this.setParticipantTrackSubscribed(
    participantId,
    Track.Source.ScreenShare,
    false,
  );
  this.setParticipantTrackSubscribed(
    participantId,
    Track.Source.ScreenShareAudio,
    false,
  );
  this.store.setState((state) => ({
    watchedStreamParticipantIds: state.watchedStreamParticipantIds.filter(
      (id) => id !== participantId,
    ),
    pendingWatchedParticipantIds: state.pendingWatchedParticipantIds.filter(
      (id) => id !== participantId,
    ),
    focusedParticipantId:
      state.focusedParticipantId === participantId
        ? null
        : state.focusedParticipantId,
    focusedParticipantType:
      state.focusedParticipantId === participantId
        ? null
        : state.focusedParticipantType,
    view:
      state.view === "focused" && state.focusedParticipantId === participantId
        ? "grid"
        : state.view,
  }));
  this.publishWatchedScreenShareParticipantIds();
}

// Exit focused screen-share mode for the currently highlighted participant.
export function stopWatchingFocusedStream(this: CallSession) {
  const focusedParticipantId = this.store.getState().focusedParticipantId;
  if (focusedParticipantId == null) {
    return;
  }
  this.stopWatchingStream(focusedParticipantId);
}

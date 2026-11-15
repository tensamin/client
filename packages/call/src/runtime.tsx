import { toast as persistentToast } from "@nonanium/ui";
import { useLocation } from "@tanstack/react-router";
import { log, toast } from "@tensamin/shared/log";
import { useStorage } from "@tensamin/storage/context";
import { DeepFilterNoiseFilterProcessor } from "deepfilternet3-noise-filter";
import {
  DisconnectReason,
  LocalAudioTrack,
  type LocalTrackPublication,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  RoomEvent,
  Track,
} from "livekit-client";
import { useEffect, useMemo, useRef } from "react";
import { getTrackPublicationBySource } from "./participants";

import { useCallSession } from "./context";
import { callSettingKeys, requireRuntime } from "./session/shared";

import type { CallSession } from "./session/instance";
import { getParticipantId, loadCallSettings } from "./session/shared";
function getNoiseFilterAssetBaseUrl() {
  if (window.location.protocol === "file:") {
    return new URL("./assets", document.baseURI).href.replace(/\/$/, "");
  }

  return "/assets";
}

// Attach the deep noise filter to the local microphone track when available.
async function ensureNoiseFilter(
  call: CallSession,
  noiseFilter: DeepFilterNoiseFilterProcessor,
): Promise<void> {
  const room = call.getRoom();
  const microphoneTrack = room.localParticipant.getTrackPublication(
    Track.Source.Microphone,
  )?.track;

  if (
    !(microphoneTrack instanceof LocalAudioTrack) ||
    microphoneTrack.getProcessor()
  ) {
    return;
  }

  await microphoneTrack.setProcessor(noiseFilter).catch((err) => {
    log(1, "call", "red", "Failed to enable noise filter", err);
  });

  if (room.state !== "connected") return;
  const participantId = getParticipantId(room.localParticipant.identity);

  if (participantId != null) {
    const processedTrack = microphoneTrack.mediaStreamTrack;
    call
      .getSpeakingDetector()
      .addTrack(participantId, processedTrack.clone(), processedTrack);
  }
}

export function useCallRuntime(navigateBackFromCall: () => void) {
  const call = useCallSession();
  const store = call.store;
  const {
    applyCallSettings,
    attachRemoteAudio,
    clearRemoteAudio,
    detachRemoteAudio,
    disconnect,
    getAllParticipants,
    getParticipantVolume,
    getRoom,
    loadCallData,
    pendingRemoteScreenShareEnds,
    playCallEvent,
    setCallIsFullscreen,
    stopWatchingStream,
    syncAllRemoteTrackSubscriptions,
    syncParticipantState,
    syncRemoteParticipantTrackSubscriptions,
    triggerCallLayoutCalculation,
    updateScreenShareCodecAndEncoderStatus,
    getSpeakingDetector,
  } = call;
  const { forgetSpeakingParticipant } = call.speaking;
  const { load, subscribe: subscribeStorage } = useStorage();
  const location = useLocation();
  const listenersRegistered = useRef(false);
  const noiseFilter = useMemo(
    () =>
      new DeepFilterNoiseFilterProcessor({
        enabled: true,
        enableNoiseReduction: true,
        noiseReductionLevel: 100,
        sampleRate: 48000,
        assetConfig: {
          cdnUrl: getNoiseFilterAssetBaseUrl(),
        },
      }),
    [],
  );

  useEffect(() => {
    let active = true;
    let generation = 0;
    const runtime = requireRuntime(store.getState().runtime);

    const refresh = async () => {
      const refreshGeneration = ++generation;
      const settings = await loadCallSettings(runtime);

      if (!active || refreshGeneration !== generation) return;
      const previous = call.currentCallSettings;
      await applyCallSettings(settings, previous, noiseFilter, runtime);
    };

    const unsubscribe = subscribeStorage((keys, bulk) => {
      if (bulk || keys.some((key) => callSettingKeys.includes(key as never))) {
        void refresh();
      }
    });
    const onDeviceChange = () => void refresh();
    navigator.mediaDevices?.addEventListener("devicechange", onDeviceChange);
    void refresh();

    return () => {
      active = false;
      generation += 1;
      unsubscribe();
      navigator.mediaDevices?.removeEventListener(
        "devicechange",
        onDeviceChange,
      );
    };
  }, [applyCallSettings, call, noiseFilter, subscribeStorage, store]);

  // fullscreen sync
  useEffect(() => {
    const handleFullscreenChange = () => {
      const screenRef = store.getState().screenRef;

      if (!screenRef?.current) return;

      if (screenRef.current === document.fullscreenElement) {
        setCallIsFullscreen(true);
      } else {
        setCallIsFullscreen(false);
      }

      triggerCallLayoutCalculation();
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);

    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, [setCallIsFullscreen, triggerCallLayoutCalculation, store]);

  // esc key listener
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        store.getState().callIsFullscreen &&
        location.pathname.startsWith("/call")
      ) {
        store.setState({ callIsFullscreen: false });
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [location.pathname, store]);

  // The room-listener effect must not re-register when the callback identity changes, so it reads the latest helper through a ref.
  const navigateBackFromCallRef = useRef(navigateBackFromCall);
  useEffect(() => {
    navigateBackFromCallRef.current = navigateBackFromCall;
  }, [navigateBackFromCall]);

  useEffect(
    () =>
      store.subscribe((state, previous) => {
        if (state.state === "closed" && previous.state !== "closed")
          navigateBackFromCallRef.current();
      }),
    [store],
  );

  // room setup
  useEffect(() => {
    if (listenersRegistered.current) {
      return;
    }

    listenersRegistered.current = true;
    let disposed = false;

    const onConnected = async () => {
      if (store.getState().state === "closing") return;
      store.setState({ state: "open" });
      playCallEvent("call_join");
      syncParticipantState();

      const detector = getSpeakingDetector();
      const localParticipantId = getParticipantId(
        room.localParticipant.identity,
      );

      if (localParticipantId != null) {
        detector.setLocalParticipantId(localParticipantId);
      }

      const [start, end] = await Promise.all([
        load("call_mute_range_start"),
        load("call_mute_range_end"),
      ]);

      if (disposed) return;
      detector.setGateThresholds(start, end);

      // Scan existing audio tracks for speaking detection
      for (const participant of getAllParticipants()) {
        const participantId = getParticipantId(participant.identity);

        if (participantId == null) continue;

        for (const publication of participant.trackPublications.values()) {
          if (
            publication.kind === Track.Kind.Audio &&
            publication.source === Track.Source.Microphone &&
            publication.track
          ) {
            const mediaTrack = publication.track.mediaStreamTrack;

            if (participant === room.localParticipant) {
              const clonedTrack = mediaTrack.clone();
              detector.addTrack(participantId, clonedTrack, mediaTrack);
            } else {
              detector.addTrack(participantId, mediaTrack);
            }
          }
        }
      }

      log(2, "call", "purple", "Connected to call", {
        callId: store.getState().callId,
      });
    };

    const onDisconnected = (reason?: DisconnectReason) => {
      playCallEvent("call_leave");
      const stateBeforeDisconnect = store.getState().state;

      if (
        reason === DisconnectReason.DUPLICATE_IDENTITY &&
        stateBeforeDisconnect !== "closing"
      ) {
        const toastId = persistentToast("Call moved to another client.", {
          description:
            "This client was disconnected because you joined the call elsewhere.",
          duration: Infinity,
          action: {
            label: "Dismiss",
            onClick: () => persistentToast.dismiss(toastId),
          },
        });
      }

      const droppedWhileActive = store.getState().callId != null;

      if (stateBeforeDisconnect !== "closing" && droppedWhileActive) {
        void disconnect().finally(() => navigateBackFromCallRef.current());
      } else if (stateBeforeDisconnect !== "closing") {
        store.setState({ state: "closed" });
        syncParticipantState();
      }

      log(2, "call", "purple", "Disconnected from call", {
        callId: store.getState().callId,
      });
    };

    const onParticipantConnected = () => {
      playCallEvent("call_join");
      syncAllRemoteTrackSubscriptions();
      syncParticipantState();
      // Keep the authoritative member list current for the invite picker.
      const activeCallId = store.getState().callId;

      if (activeCallId) {
        void loadCallData(
          activeCallId,
          store.getState().callRoute?.ownerOmikronId,
        );
      }
    };

    const onParticipantDisconnected = (participant: Participant) => {
      playCallEvent("call_leave");
      const participantId = getParticipantId(participant.identity);

      if (participantId != null) {
        stopWatchingStream(participantId);
        getSpeakingDetector().removeParticipant(participantId);
        forgetSpeakingParticipant(participantId);
      }

      syncParticipantState();
    };

    const onMediaDeviceFailure = (error: Error, kind?: MediaDeviceKind) => {
      log(1, "call", "red", "Media device failure", { error, kind });
      toast("error", "Media device failure. See console for details.");
    };

    const onEncryptionError = (error: Error) => {
      log(1, "call", "red", "Encryption error", { error });
      toast("error", "Error during call encryption. See console for details.");
    };

    const onParticipantStateChange = () => {
      syncParticipantState();
      void ensureNoiseFilter(call, noiseFilter);
    };

    const onLocalTrackPublished = (publication: LocalTrackPublication) => {
      if (publication.source === Track.Source.ScreenShare) {
        if (!call.mediaShareController?.reconfiguring)
          playCallEvent("stream_start_self");
        void updateScreenShareCodecAndEncoderStatus(publication);
        setTimeout(
          () => void updateScreenShareCodecAndEncoderStatus(publication),
          1000,
        );
      }

      if (
        publication.kind === Track.Kind.Audio &&
        publication.source === Track.Source.Microphone &&
        publication.track
      ) {
        const participantId = getParticipantId(room.localParticipant.identity);

        if (participantId != null) {
          const originalTrack = publication.track.mediaStreamTrack;
          const clonedTrack = originalTrack.clone();
          getSpeakingDetector().addTrack(
            participantId,
            clonedTrack,
            originalTrack,
          );
        }
      }

      syncParticipantState();
      void ensureNoiseFilter(call, noiseFilter);
    };

    const onLocalTrackUnpublished = (publication: LocalTrackPublication) => {
      if (publication.source === Track.Source.ScreenShare) {
        if (!call.mediaShareController?.reconfiguring)
          playCallEvent("stream_end_self");
      }

      if (
        publication.kind === Track.Kind.Audio &&
        publication.source === Track.Source.Microphone
      ) {
        const participantId = getParticipantId(room.localParticipant.identity);

        if (participantId != null) {
          getSpeakingDetector().removeParticipant(participantId);
        }
      }

      syncParticipantState();
    };

    const onTrackPublished = (
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (publication.source === Track.Source.ScreenShare) {
        const pendingEnd = pendingRemoteScreenShareEnds.get(
          participant.identity,
        );

        if (pendingEnd) {
          clearTimeout(pendingEnd);
          pendingRemoteScreenShareEnds.delete(participant.identity);
        } else {
          playCallEvent("stream_start_other");
        }
      }

      const participantId = getParticipantId(participant.identity);

      if (participantId != null) {
        syncRemoteParticipantTrackSubscriptions(participantId);
      }

      onParticipantStateChange();
    };

    const onTrackUnpublished = (
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (publication.source === Track.Source.ScreenShare) {
        const existing = pendingRemoteScreenShareEnds.get(participant.identity);

        if (existing) clearTimeout(existing);
        pendingRemoteScreenShareEnds.set(
          participant.identity,
          setTimeout(() => {
            pendingRemoteScreenShareEnds.delete(participant.identity);
            playCallEvent("stream_end_other");
          }, 1500),
        );
      }

      onParticipantStateChange();
    };

    const onTrackSubscribed = (
      track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (track.kind === "audio" && track.sid) {
        attachRemoteAudio(track.sid, track.attach());

        const participantId = getParticipantId(participant.identity);

        if (publication.source === Track.Source.ScreenShareAudio) {
          participant.setVolume(
            store.getState().deaf
              ? 0
              : call.currentCallSettings.call_screen_share_volume / 100,
            Track.Source.ScreenShareAudio,
          );
        }

        if (
          participantId != null &&
          publication.source === Track.Source.Microphone
        ) {
          participant.setVolume(
            store.getState().deaf
              ? 0
              : getParticipantVolume(participantId) / 100,
            Track.Source.Microphone,
          );
          getSpeakingDetector().addTrack(participantId, track.mediaStreamTrack);
        }
      }

      syncParticipantState();
    };

    const onTrackUnsubscribed = (
      track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: Participant,
    ) => {
      const participantId = getParticipantId(participant.identity);

      if (track.kind === "audio" && track.sid) {
        track.detach();
        detachRemoteAudio(track.sid);

        if (
          participantId != null &&
          publication.source === Track.Source.Microphone
        ) {
          getSpeakingDetector().removeParticipant(participantId);
        }
      }

      if (
        participantId != null &&
        getTrackPublicationBySource(participant, Track.Source.ScreenShare)
          ?.track == null
      ) {
        stopWatchingStream(participantId);
      }

      syncParticipantState();
    };

    const room = getRoom();
    room.on(RoomEvent.Connected, onConnected);
    room.on(RoomEvent.Reconnected, onConnected);
    room.on(RoomEvent.Disconnected, onDisconnected);
    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
    room.on(RoomEvent.TrackPublished, onTrackPublished);
    room.on(RoomEvent.TrackUnpublished, onTrackUnpublished);
    room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.on(RoomEvent.TrackMuted, onParticipantStateChange);
    room.on(RoomEvent.TrackUnmuted, onParticipantStateChange);
    room.on(RoomEvent.LocalTrackPublished, onLocalTrackPublished);
    room.on(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
    room.on(RoomEvent.MediaDevicesError, onMediaDeviceFailure);
    room.on(RoomEvent.EncryptionError, onEncryptionError);
    room.on(RoomEvent.ConnectionStateChanged, onParticipantStateChange);

    void ensureNoiseFilter(call, noiseFilter);
    syncParticipantState();
    if (room.state === "connected") void onConnected();

    return () => {
      disposed = true;
      room.off(RoomEvent.Connected, onConnected);
      room.off(RoomEvent.Reconnected, onConnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
      room.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
      room.off(RoomEvent.TrackPublished, onTrackPublished);
      room.off(RoomEvent.TrackUnpublished, onTrackUnpublished);
      room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
      room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      room.off(RoomEvent.TrackMuted, onParticipantStateChange);
      room.off(RoomEvent.TrackUnmuted, onParticipantStateChange);
      room.off(RoomEvent.LocalTrackPublished, onLocalTrackPublished);
      room.off(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
      room.off(RoomEvent.MediaDevicesError, onMediaDeviceFailure);
      room.off(RoomEvent.EncryptionError, onEncryptionError);
      room.off(RoomEvent.ConnectionStateChanged, onParticipantStateChange);
      clearRemoteAudio();

      for (const timeout of pendingRemoteScreenShareEnds.values()) {
        clearTimeout(timeout);
      }

      pendingRemoteScreenShareEnds.clear();
      listenersRegistered.current = false;
    };
  }, [
    attachRemoteAudio,
    call,
    clearRemoteAudio,
    detachRemoteAudio,
    disconnect,
    forgetSpeakingParticipant,
    getAllParticipants,
    getParticipantVolume,
    getRoom,
    getSpeakingDetector,
    load,
    loadCallData,
    noiseFilter,
    pendingRemoteScreenShareEnds,
    playCallEvent,
    stopWatchingStream,
    syncAllRemoteTrackSubscriptions,
    syncParticipantState,
    syncRemoteParticipantTrackSubscriptions,
    updateScreenShareCodecAndEncoderStatus,
    store,
  ]);
}

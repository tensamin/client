import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useMTP } from "@tensamin/mtp";
import { mtp } from "@tensamin/shared/data";
import { log, toast } from "@tensamin/shared/log";
import { useStorage } from "@tensamin/storage/context";
import { useSession } from "@tensamin/identity/session";
import { useUser } from "@tensamin/identity/context";
import { DeepFilterNoiseFilterProcessor } from "deepfilternet3-noise-filter";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  toast as persistentToast,
} from "@nonanium/ui";
import {
  LocalAudioTrack,
  DisconnectReason,
  type LocalTrackPublication,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  RoomEvent,
  Track,
} from "livekit-client";
import { isMediaShareReconfiguring } from "./mediaShare/controller";
import { getTrackPublicationBySource } from "./participants";
import { getSpeakingDetector } from "./speakingIndicator";
import { forgetSpeakingParticipant } from "./speakingState";
import InvitePopup from "./components/invitePopup";
import { useCall } from "./state";
import {
  applyCallSettings,
  attachRemoteAudio,
  callSettingKeys,
  clearRemoteAudio,
  currentCallSettings,
  detachRemoteAudio,
  disconnect,
  disposeCallRuntime,
  getAllParticipants,
  getParticipantId,
  getParticipantVolume,
  getRoom,
  loadCallData,
  loadCallSettings,
  pendingRemoteScreenShareEnds,
  playCallEvent,
  receiveCallInvite,
  requireRuntime,
  respondToCallInvite,
  respondToCallSwitch,
  setCallId,
  setCallIsFullscreen,
  setCallRuntime,
  stopCallJingle,
  stopWatchingStream,
  syncAllRemoteTrackSubscriptions,
  syncParticipantState,
  syncRemoteParticipantTrackSubscriptions,
  triggerCallLayoutCalculation,
  updateScreenShareCodecAndEncoderStatus,
} from "./callStore";

function getNoiseFilterAssetBaseUrl() {
  if (window.location.protocol === "file:") {
    return new URL("./assets", document.baseURI).href.replace(/\/$/, "");
  }

  return "/assets";
}

// Attach the deep noise filter to the local microphone track when available.
async function ensureNoiseFilter(
  noiseFilter: DeepFilterNoiseFilterProcessor,
): Promise<void> {
  const room = getRoom();
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
    getSpeakingDetector().addTrack(
      participantId,
      processedTrack.clone(),
      processedTrack,
    );
  }
}

// Register app-level call listeners and wire React dependencies into the store.
export function useInitializeCall() {
  const navigate = useNavigate();
  const router = useRouter();
  const location = useLocation();
  const returnTo = useRef("/");
  useEffect(() => {
    if (location.pathname !== "/call") returnTo.current = location.href;
  }, [location.href, location.pathname]);
  const { sendCallControl, subscribe, contextReady } = useMTP();
  const { load, save, subscribe: subscribeStorage } = useStorage();
  const { upsertCall, removeCall, calls } = useSession();
  const { get } = useUser();

  const callId = useCall((state) => state.callId);
  const view = useCall((state) => state.view);
  const incomingCallInvite = useCall((state) => state.incomingCallInvite);
  const pendingCallSwitch = useCall((state) => state.pendingCallSwitch);

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
    setCallRuntime({
      navigate,
      callControl: {
        request: (ownerOmikronId, type, data, options) =>
          sendCallControl(ownerOmikronId, type, data, options),
      },
      load,
      save,
      subscribeStorage,
      getPublicKey: (userId) =>
        get(userId, ["PublicKey"]).then((user) => user.PublicKey),
      upsertCall,
      removeCall,
    });
  }, [
    get,
    load,
    navigate,
    removeCall,
    save,
    sendCallControl,
    subscribeStorage,
    upsertCall,
  ]);

  useEffect(() => {
    let active = true;
    let generation = 0;
    const runtime = requireRuntime(useCall.getState().runtime);

    const refresh = async () => {
      const refreshGeneration = ++generation;
      const settings = await loadCallSettings(runtime);
      if (!active || refreshGeneration !== generation) return;
      const previous = currentCallSettings;
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
  }, [noiseFilter, subscribeStorage]);

  const setInvitePopupOpen = useCallback((open: boolean) => {
    if (!open) {
      stopCallJingle();
      useCall.setState({ incomingCallInvite: null });
    }
  }, []);

  // Return through the router so file-based and browser history behave alike.
  const navigateBackFromCall = useCallback(() => {
    if (router.state.location.pathname !== "/call") return;
    const state = useCall.getState().state;
    if (state === "encrypting" || state === "connecting") return;
    void router.navigate({ href: returnTo.current, replace: true });
  }, [router]);

  const respondToInvite = useCallback((accepted: boolean) => {
    void respondToCallInvite(accepted).catch((error) => {
      log(1, "call", "red", "Failed to join call", error);
    });
  }, []);

  // listen to call invites
  useEffect(() => {
    return subscribe("CallInvite", async ({ data }) => {
      await receiveCallInvite(data, Number(await load("user_id")));
    });
  }, [load, subscribe]);

  useEffect(
    () =>
      subscribe("CallEnded", ({ data }) => {
        const callId = mtp.CallEnded.response.parse(data).CallId;
        removeCall(callId);
        if (useCall.getState().callId === callId) {
          useCall.setState({ currentCallData: { status: "not-found" } });
          if (
            useCall.getState().state !== "closed" &&
            useCall.getState().state !== "closing"
          ) {
            void disconnect().then(navigateBackFromCall);
          } else if (
            useCall.getState().state === "closed" &&
            router.state.location.pathname === "/call"
          ) {
            navigateBackFromCall();
          }
        }
      }),
    [removeCall, navigateBackFromCall, router, subscribe],
  );

  // get callId from url
  useEffect(() => {
    if (!location.pathname.startsWith("/call")) {
      return;
    }

    const search = new URLSearchParams(location.searchStr);
    const routeCallId = search.get("id");

    if (routeCallId) {
      setCallId(routeCallId);
    }
  }, [location.pathname, location.searchStr]);

  // fullscreen sync
  useEffect(() => {
    const handleFullscreenChange = () => {
      const screenRef = useCall.getState().screenRef;
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
  }, []);

  // esc key listener
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        useCall.getState().callIsFullscreen &&
        location.pathname.startsWith("/call")
      ) {
        useCall.setState({ callIsFullscreen: false });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [location.pathname]);

  // The room-listener effect must not re-register when the callback identity
  // changes, so it reads the latest helper through a ref.
  const navigateBackFromCallRef = useRef(navigateBackFromCall);
  useEffect(() => {
    navigateBackFromCallRef.current = navigateBackFromCall;
  }, [navigateBackFromCall]);

  // room setup
  useEffect(() => {
    if (listenersRegistered.current) {
      return;
    }

    listenersRegistered.current = true;
    let disposed = false;

    const onConnected = async () => {
      if (useCall.getState().state === "closing") return;
      useCall.setState({ state: "open" });
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
        callId: useCall.getState().callId,
        callSecret: useCall.getState().callSecret,
      });
    };

    const onDisconnected = (reason?: DisconnectReason) => {
      stopCallJingle();
      playCallEvent("call_leave");
      const stateBeforeDisconnect = useCall.getState().state;
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
      const droppedWhileActive = useCall.getState().callId != null;
      if (stateBeforeDisconnect !== "closing" && droppedWhileActive) {
        void disconnect().finally(() => navigateBackFromCallRef.current());
      } else if (stateBeforeDisconnect !== "closing") {
        useCall.setState({ state: "closed" });
        syncParticipantState();
      }
      log(2, "call", "purple", "Disconnected from call", {
        callId: useCall.getState().callId,
        callSecret: useCall.getState().callSecret,
      });
    };

    const onParticipantConnected = () => {
      stopCallJingle();
      playCallEvent("call_join");
      syncAllRemoteTrackSubscriptions();
      syncParticipantState();
      // Keep the authoritative member list current for the invite picker.
      const activeCallId = useCall.getState().callId;
      if (activeCallId) {
        void loadCallData(
          activeCallId,
          useCall.getState().callRoute?.ownerOmikronId,
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
      void ensureNoiseFilter(noiseFilter);
    };

    const onLocalTrackPublished = (publication: LocalTrackPublication) => {
      if (publication.source === Track.Source.ScreenShare) {
        if (!isMediaShareReconfiguring()) playCallEvent("stream_start_self");
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
      void ensureNoiseFilter(noiseFilter);
    };

    const onLocalTrackUnpublished = (publication: LocalTrackPublication) => {
      if (publication.source === Track.Source.ScreenShare) {
        if (!isMediaShareReconfiguring()) playCallEvent("stream_end_self");
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
            useCall.getState().deaf
              ? 0
              : currentCallSettings.call_screen_share_volume / 100,
            Track.Source.ScreenShareAudio,
          );
        }
        if (
          participantId != null &&
          publication.source === Track.Source.Microphone
        ) {
          participant.setVolume(
            useCall.getState().deaf
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

    void ensureNoiseFilter(noiseFilter);
    syncParticipantState();

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
      void disposeCallRuntime().catch((error) =>
        log(1, "call", "red", "Call cleanup failed", error),
      );
    };
  }, [noiseFilter, load]);

  // fetch call data for preview page
  const previewOwner = calls.find((call) => call.CallId === callId)?.OmikronId;
  useEffect(() => {
    if (view !== "preview" || !callId || !contextReady) {
      return;
    }

    useCall.setState({
      callRoute:
        previewOwner == null
          ? null
          : { ownerOmikronId: previewOwner, livekitUrl: null },
    });
    void loadCallData(callId, previewOwner);
  }, [callId, view, contextReady, previewOwner]);

  return (
    <>
      {incomingCallInvite && (
        <InvitePopup
          open
          setOpen={setInvitePopupOpen}
          onAccept={respondToInvite}
          user={incomingCallInvite.senderId}
        />
      )}
      <AlertDialog
        open={pendingCallSwitch != null}
        onOpenChange={(open) => {
          if (!open) respondToCallSwitch(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch calls?</AlertDialogTitle>
            <AlertDialogDescription>
              Joining the other call will leave your current call.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => respondToCallSwitch(false)}>
              Stay in current call
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void respondToCallSwitch(true)?.catch((error) => {
                  log(1, "call", "red", "Failed to switch calls", error);
                });
              }}
            >
              Join other call
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

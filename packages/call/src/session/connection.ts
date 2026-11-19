import { log, toast } from "@tensamin/shared/log";
import { initialCallState } from "../state";
import type { CallSession } from "./instance";
import { loadCallSettings, requireRuntime } from "./shared";

// Connect to LiveKit, enable the microphone, and move the UI into the live call.
export async function connect(
  this: CallSession,
  callId: string,
  token: string,
  callEndpoint: string,
  attemptGeneration = this.callAttemptGeneration,
) {
  this.store.setState({
    state: "connecting",
    callId,
    livekitToken: token,
  });
  log(2, "call", "purple", "Connecting to call", {
    callId,
  });
  await this.getRoom()
    .connect(callEndpoint, token, {
      autoSubscribe: false,
    })
    .catch((error) => {
      if (attemptGeneration !== this.callAttemptGeneration) {
        return;
      }
      this.store.setState({ state: "closed", livekitToken: null });
      log(1, "call", "red", "Failed to connect to room", error);
      toast(
        "error",
        error instanceof Error ? error.message : "Failed to connect to call.",
      );
      throw error;
    });
  if (
    attemptGeneration !== this.callAttemptGeneration ||
    this.store.getState().callId !== callId
  ) {
    return;
  }
  this.syncAllRemoteTrackSubscriptions();
  const runtime = requireRuntime(this.store.getState().runtime);
  const settings = await loadCallSettings(runtime);
  if (attemptGeneration !== this.callAttemptGeneration) return;
  this.currentCallSettings = settings;
  await this.getRoom()
    .localParticipant.setMicrophoneEnabled(true, {
      deviceId: settings.call_microphone_device_id,
      noiseSuppression: false,
      autoGainControl: settings.call_automatic_gain_control,
      echoCancellation: settings.call_echo_cancellation,
      voiceIsolation: settings.call_voice_isolation,
    })
    .catch((error) => {
      log(1, "call", "red", "Failed to enable microphone", error);
      toast(
        "error",
        "Failed to enable microphone",
        error instanceof Error ? error.message : String(error),
      );
    });
  if (attemptGeneration !== this.callAttemptGeneration) {
    await this.getRoom().localParticipant.setMicrophoneEnabled(false);
    return;
  }
  this.syncParticipantState();
}

// Tear down the active call session and return the store to a closed state.
export async function disconnect(this: CallSession) {
  const attemptGeneration = ++this.callAttemptGeneration;
  this.store.setState({ state: "closing" });
  this.disposeSpeakingDetector();
  if (!this._room) {
    this.store.setState({
      ...initialCallState(),
      runtime: this.store.getState().runtime,
    });
    return;
  }
  if (this.getRoom().state === "connected") {
    await this.clearScreenSharePreview();
  }
  if (attemptGeneration !== this.callAttemptGeneration) return;
  try {
    await this.getMediaShareController().clearAll();
  } catch (error) {
    log(
      1,
      "call",
      "red",
      "Failed to clear screen share during disconnect",
      error,
    );
  }
  if (attemptGeneration !== this.callAttemptGeneration) return;
  this.store.setState({
    state: "closing",
    invitedUserId: null,
    callId: null,
    callCreatedAt: null,
    callRoute: null,
    callSecret: null,
    livekitToken: null,
    currentCallData: null,
    deaf: false,
    view: "preview",
    screenShareSession: null,
    cameraSession: null,
    cameraEnabled: false,
    disabledCameraParticipantIds: [],
    focusedParticipantId: null,
    focusedParticipantType: null,
    usersInFocusedViewHidden: false,
    watchedStreamParticipantIds: [],
    pendingWatchedParticipantIds: [],
    activeScreenShareParticipantIds: [],
    activeScreenShareAudioParticipantIds: [],
    callIsFullscreen: false,
    lastFocusedParticipantId: null,
    screenShareExpectedCodec: null,
    screenShareActiveCodec: null,
    warnings: [],
  });
  this.participantVolumes.clear();
  this.clearRemoteAudio();
  for (const timeout of this.pendingRemoteScreenShareEnds.values()) {
    clearTimeout(timeout);
  }
  this.pendingRemoteScreenShareEnds.clear();
  try {
    await this.getRoom().disconnect();
  } catch (error) {
    log(1, "call", "red", "Failed to disconnect from room", error);
  } finally {
    if (attemptGeneration === this.callAttemptGeneration) {
      this.store.setState({ state: "closed" });
      this.syncParticipantState();
    }
  }
}

export async function disposeCallRuntime(this: CallSession) {
  const runtime = this.store.getState().runtime;
  this.callSettingsGeneration += 1;
  this.latestCallDataRequest += 1;
  this.activeCallViewTransition?.skipTransition();
  if (
    this.store.getState().state !== "closed" ||
    this._room?.state === "connected"
  )
    await this.disconnect();
  this.disposeSpeakingDetector();
  this.clearRemoteAudio();
  for (const timeout of this.pendingRemoteScreenShareEnds.values())
    clearTimeout(timeout);
  this.pendingRemoteScreenShareEnds.clear();
  if (this.store.getState().runtime !== runtime) return;
  this.disposed = true;
  this.terminateE2EEWorker();
  this._room = null;
  this._keyProvider = null;
  this.mediaShareController = null;
  this.store.setState({ runtime: null });
}

// Leave by revoking this user's backend membership before closing local media.
export async function leaveCall(this: CallSession) {
  this.callAttemptGeneration += 1;
  const runtime = requireRuntime(this.store.getState().runtime);
  const { callId } = this.store.getState();
  this.store.setState({ state: "closing" });
  try {
    if (callId) {
      const ownUserId = Number(await runtime.load("user_id"));
      await runtime.callControl.request(
        this.callRouteOwner(),
        "CallDisconnectUser",
        {
          CallId: callId,
          UserId: ownUserId,
        },
      );
    }
  } finally {
    await this.disconnect();
  }
}

export async function disconnectUser(this: CallSession, userId: number) {
  const { callId } = this.store.getState();
  if (!callId) {
    throw new Error("Cannot disconnect a user without an active call.");
  }
  await requireRuntime(this.store.getState().runtime).callControl.request(
    this.callRouteOwner(),
    "CallDisconnectUser",
    { CallId: callId, UserId: userId },
  );
}

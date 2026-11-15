import { log, toast } from "@tensamin/shared/log";
import { DeepFilterNoiseFilterProcessor } from "deepfilternet3-noise-filter";
import { LocalAudioTrack, Room, Track } from "livekit-client";
import {
  resolveScreenShareCodec,
  type ScreenShareSettings,
} from "../mediaShare/controller";
import type { CallRuntime as Runtime } from "../state";
import type { CallSession } from "./instance";
import type { CallSettings } from "./shared";
import { canSwitchAudioOutput } from "./shared";

export async function switchCallDevice(
  this: CallSession,
  kind: "audioinput" | "audiooutput",
  deviceId: string,
) {
  const generation =
    kind === "audioinput"
      ? ++this.microphoneDeviceGeneration
      : this.microphoneDeviceGeneration;
  if (kind === "audioinput") this.latestMicrophoneDeviceId = deviceId;
  const switched = await this.getRoom().switchActiveDevice(kind, deviceId);
  if (!switched) return false;
  if (kind === "audioinput" && generation !== this.microphoneDeviceGeneration) {
    await this.getRoom().switchActiveDevice(
      kind,
      this.latestMicrophoneDeviceId,
    );
    return false;
  }
  return true;
}

export function updateProcessingWarnings(
  this: CallSession,
  settings: CallSettings,
) {
  const managed = new Set([
    "Automatic gain control may make the user extremely quiet on Linux.",
    "It is not recommended to use noise suppression and voice isolation together.",
  ]);
  const warnings = this.store
    .getState()
    .warnings.filter((warning) => !managed.has(warning));
  if (
    /Linux/i.test(navigator.userAgent) &&
    settings.call_automatic_gain_control
  ) {
    warnings.push(
      "Automatic gain control may make the user extremely quiet on Linux.",
    );
  }
  if (
    settings.call_noise_suppression_enabled &&
    settings.call_voice_isolation
  ) {
    warnings.push("DeepFilter and voice isolation are enabled together.");
  }
  this.store.setState({ warnings });
}

export async function applyMicrophoneSettings(
  this: CallSession,
  settings: CallSettings,
  previous: CallSettings,
  runtime: Runtime,
): Promise<CallSettings | null> {
  const microphoneTrack = this.getRoom().localParticipant.getTrackPublication(
    Track.Source.Microphone,
  )?.track;
  if (microphoneTrack instanceof LocalAudioTrack) {
    try {
      await microphoneTrack.applyConstraints({
        noiseSuppression: false,
        echoCancellation: settings.call_echo_cancellation,
        voiceIsolation: settings.call_voice_isolation,
        autoGainControl: settings.call_automatic_gain_control,
      });
    } catch (error) {
      log(1, "call", "red", "Failed to update microphone processing", error);
      toast("error", "Failed to update microphone processing.");
      await Promise.all(
        (
          [
            "call_echo_cancellation",
            "call_voice_isolation",
            "call_automatic_gain_control",
          ] as const
        ).map((key) =>
          settings[key] === previous[key]
            ? undefined
            : runtime.save(key, previous[key]),
        ),
      );
      return null;
    }
  }
  const deviceGeneration = ++this.microphoneDeviceGeneration;
  if (settings.call_microphone_device_id !== "default") {
    const devices = await Room.getLocalDevices("audioinput");
    if (deviceGeneration !== this.microphoneDeviceGeneration) return null;
    const available = devices.some(
      (device) => device.deviceId === settings.call_microphone_device_id,
    );
    if (!available) {
      await runtime.save("call_microphone_device_id", "default");
      settings = { ...settings, call_microphone_device_id: "default" };
    }
  }
  if (
    settings.call_microphone_device_id === previous.call_microphone_device_id ||
    !this.getRoom().localParticipant.isMicrophoneEnabled ||
    this.getRoom().getActiveDevice("audioinput") ===
      settings.call_microphone_device_id
  ) {
    return settings;
  }
  const requested = settings.call_microphone_device_id;
  this.latestMicrophoneDeviceId = requested;
  try {
    const switched = await this.getRoom().switchActiveDevice(
      "audioinput",
      requested,
    );
    if (!switched) throw new Error("Microphone switch was rejected.");
    if (deviceGeneration !== this.microphoneDeviceGeneration) {
      await this.getRoom().switchActiveDevice(
        "audioinput",
        this.latestMicrophoneDeviceId,
      );
      return null;
    }
  } catch (error) {
    if (deviceGeneration !== this.microphoneDeviceGeneration) return null;
    log(1, "call", "red", "Failed to switch microphone", error);
    toast("error", "Failed to switch microphone.");
    await runtime.save(
      "call_microphone_device_id",
      previous.call_microphone_device_id,
    );
    return null;
  }
  return settings;
}

export async function applySpeakerSettings(
  this: CallSession,
  settings: CallSettings,
  previous: CallSettings,
  runtime: Runtime,
): Promise<CallSettings | null> {
  if (!canSwitchAudioOutput()) return settings;
  if (settings.call_speaker_device_id !== "default") {
    const devices = await Room.getLocalDevices("audiooutput");
    const available = devices.some(
      (device) => device.deviceId === settings.call_speaker_device_id,
    );
    if (!available) {
      await runtime.save("call_speaker_device_id", "default");
      settings = { ...settings, call_speaker_device_id: "default" };
    }
  }
  if (
    settings.call_speaker_device_id === previous.call_speaker_device_id ||
    this.getRoom().getActiveDevice("audiooutput") ===
      settings.call_speaker_device_id
  ) {
    return settings;
  }
  try {
    const switched = await this.getRoom().switchActiveDevice(
      "audiooutput",
      settings.call_speaker_device_id,
    );
    if (!switched) throw new Error("Speaker switch was rejected.");
  } catch (error) {
    log(1, "call", "red", "Failed to switch speaker", error);
    toast("error", "Failed to switch speaker.");
    await runtime.save(
      "call_speaker_device_id",
      previous.call_speaker_device_id,
    );
    return null;
  }
  return settings;
}

export async function applyScreenShareSettings(
  this: CallSession,
  settings: CallSettings,
  previous: CallSettings,
  runtime: Runtime,
) {
  const shareSettings: ScreenShareSettings = {
    resolution: settings.call_screen_share_resolution,
    frameRate: settings.call_screen_share_frame_rate,
    includeAudio: settings.call_screen_share_audio,
    codec: settings.call_screen_share_codec,
  };
  this.store.setState({
    screenShareExpectedCodec: await resolveScreenShareCodec(shareSettings),
  });
  try {
    await this.getMediaShareController().reconfigureScreen(shareSettings);
    await this.updateScreenShareCodecAndEncoderStatus();
    return true;
  } catch (error) {
    log(1, "call", "red", "Failed to update screen share", error);
    toast("error", "Failed to update screen share settings.");
    await Promise.all(
      (
        [
          "call_screen_share_resolution",
          "call_screen_share_frame_rate",
          "call_screen_share_audio",
          "call_screen_share_codec",
        ] as const
      ).map((key) =>
        settings[key] === previous[key]
          ? undefined
          : runtime.save(key, previous[key]),
      ),
    );
    return false;
  }
}

export async function applyCallSettings(
  this: CallSession,
  settings: CallSettings,
  previous: CallSettings,
  noiseFilter: DeepFilterNoiseFilterProcessor,
  runtime: Runtime,
) {
  const generation = ++this.callSettingsGeneration;
  this.updateProcessingWarnings(settings);
  this.setScreenShareVolume(settings.call_screen_share_volume);
  noiseFilter.setSuppressionLevel(settings.call_noise_suppression_level);
  await noiseFilter.setEnabled(settings.call_noise_suppression_enabled);
  if (generation !== this.callSettingsGeneration) return;
  const detector = this.getSpeakingDetector();
  detector.setGateEnabled(settings.call_noise_gate_enabled);
  detector.setGateThresholds(
    settings.call_mute_range_start,
    settings.call_mute_range_end,
  );
  const microphoneSettings = await this.applyMicrophoneSettings(
    settings,
    previous,
    runtime,
  );
  if (!microphoneSettings || generation !== this.callSettingsGeneration) return;
  const appliedSettings = await this.applySpeakerSettings(
    microphoneSettings,
    previous,
    runtime,
  );
  if (!appliedSettings || generation !== this.callSettingsGeneration) return;
  if (
    !(await this.applyScreenShareSettings(appliedSettings, previous, runtime))
  ) {
    return;
  }
  if (generation !== this.callSettingsGeneration) return;
  this.currentCallSettings = appliedSettings;
}

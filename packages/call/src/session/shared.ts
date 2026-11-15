import { mtp, type Storage } from "@tensamin/shared/data";
import { Room, Track } from "livekit-client";
import { bytesToBase64 } from "mtp";
import z from "zod";
import { getSupportedScreenShareCodecs } from "../mediaShare/controller";
import type { CallRuntime as Runtime, WrappedCallSecret } from "../state";

export const callSettingKeys = [
  "call_microphone_device_id",
  "call_speaker_device_id",
  "call_noise_suppression_enabled",
  "call_noise_suppression_level",
  "call_echo_cancellation",
  "call_voice_isolation",
  "call_automatic_gain_control",
  "call_noise_gate_enabled",
  "call_event_sounds_enabled",
  "call_sound_volume",
  "call_screen_share_resolution",
  "call_screen_share_frame_rate",
  "call_screen_share_audio",
  "call_screen_share_volume",
  "call_screen_share_codec",
  "call_camera_resolution",
  "call_camera_frame_rate",
  "call_mute_range_start",
  "call_mute_range_end",
] as const satisfies readonly (keyof Storage)[];

export const CALL_SECRET_VERSION = 1;

export const SCREEN_SHARE_PREVIEW_MAX_WIDTH = 320;

export const SCREEN_SHARE_PREVIEW_MAX_HEIGHT = 180;

export const SCREEN_SHARE_PREVIEW_QUALITY = 0.7;

export const SCREEN_SHARE_PREVIEW_TIMEOUT_MS = 5000;

export const watchedScreenShareParticipantIdsSchema = z.array(
  z.number().int().positive(),
);

export function protocolBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

export function normalizeWrappedCallSecret(
  callSecret:
    WrappedCallSecret | ProtocolCallSecret | ProtocolCallSecretResponse,
): WrappedCallSecret {
  if ("secretId" in callSecret) {
    return callSecret;
  }

  return {
    secretId: callSecret.SecretId,
    versionNumber: callSecret.VersionNumber,
    encryptedSecret: callSecret.EncryptedSecret,
    kemCiphertext: callSecret.KemCiphertext,
    wrappingScheme: callSecret.WrappingScheme,
  };
}

export function protocolCallSecret(
  callSecret: WrappedCallSecret,
): ProtocolCallSecret {
  return {
    SecretId: callSecret.secretId,
    VersionNumber: callSecret.versionNumber,
    EncryptedSecret: protocolBytes(callSecret.encryptedSecret),
    KemCiphertext: protocolBytes(callSecret.kemCiphertext),
    WrappingScheme: callSecret.wrappingScheme,
  };
}

export function randomCallSecret(): string {
  return bytesToBase64(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

export function getParticipantId(identity: string | undefined): number | null {
  if (!identity) {
    return null;
  }

  const parsed = Number(identity);

  return Number.isFinite(parsed) ? parsed : null;
}

export function requireRuntime(runtime: Runtime | null): Runtime {
  if (!runtime) {
    throw new Error("Call store is not initialized");
  }

  return runtime;
}

export async function getCallDevices(kind: "audioinput" | "audiooutput") {
  return Room.getLocalDevices(kind);
}

export function canSwitchAudioOutput() {
  return "setSinkId" in HTMLMediaElement.prototype;
}

export function getSupportedCallScreenShareCodecs() {
  return getSupportedScreenShareCodecs();
}

export async function loadCallSettings(
  runtime: Runtime,
): Promise<CallSettings> {
  const values = await Promise.all(
    callSettingKeys.map((key) => runtime.load(key)),
  );

  return Object.fromEntries(
    callSettingKeys.map((key, index) => [key, values[index]]),
  ) as CallSettings;
}
export type ProtocolCallSecret = NonNullable<
  z.infer<typeof mtp.CallToken.request>["CallSecret"]
>;
export type ProtocolCallSecretResponse = NonNullable<
  z.infer<typeof mtp.CallInvite.response>["CallSecret"]
>;
export type RemoteVideoTrackSelector = Track.Kind | Track.Source;
export type CallSettings = Pick<Storage, (typeof callSettingKeys)[number]>;

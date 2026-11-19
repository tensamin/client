import { log } from "@tensamin/shared/log";
import { Track, type LocalTrackPublication } from "livekit-client";
import type { MediaShareRequest } from "../mediaShare";
import { createMediaShareController } from "../mediaShare/controller";
import { getTrackPublicationBySource } from "../participants";
import type { CallSession } from "./instance";
import {
  getParticipantId,
  loadCallSettings,
  requireRuntime,
  SCREEN_SHARE_PREVIEW_MAX_HEIGHT,
  SCREEN_SHARE_PREVIEW_MAX_WIDTH,
  SCREEN_SHARE_PREVIEW_QUALITY,
  SCREEN_SHARE_PREVIEW_TIMEOUT_MS,
} from "./shared";

export function getMediaShareController(this: CallSession) {
  if (!this.mediaShareController) {
    this.mediaShareController = createMediaShareController({
      room: this.getRoom(),
      getState: () => ({
        screenShareSession: this.store.getState().screenShareSession,
        cameraSession: this.store.getState().cameraSession,
      }),
      setState: (updater) => {
        this.store.setState((state) =>
          typeof updater === "function"
            ? updater({
                screenShareSession: state.screenShareSession,
                cameraSession: state.cameraSession,
              })
            : updater,
        );
      },
      getLocalParticipantId: () =>
        getParticipantId(this.getRoom().localParticipant.identity),
      startWatching: this.startWatchingStream,
      stopWatching: this.stopWatchingStream,
      syncParticipantState: this.syncParticipantState,
    });
  }
  return this.mediaShareController;
}

// Mute or restore incoming call audio for every remote participant.
export async function toggleDeaf(this: CallSession) {
  const nextDeaf = !this.store.getState().deaf;
  this.getRoom().remoteParticipants.forEach((participant) => {
    const participantId = getParticipantId(participant.identity);
    participant.setVolume(
      nextDeaf
        ? 0
        : participantId == null
          ? 1
          : this.getParticipantVolume(participantId) / 100,
      Track.Source.Microphone,
    );
    participant.setVolume(
      nextDeaf ? 0 : this.currentCallSettings.call_screen_share_volume / 100,
      Track.Source.ScreenShareAudio,
    );
  });
  if (nextDeaf && this.getRoom().localParticipant.isMicrophoneEnabled) {
    await this.toggleMute();
  }
  await this.updateLocalParticipantAttributes({
    deafened: nextDeaf ? "true" : "false",
  });
  this.getSpeakingDetector().setDeaf(nextDeaf);
  this.store.setState({ deaf: nextDeaf });
}

// Toggle the local microphone while keeping deaf/mute state consistent.
export async function toggleMute(this: CallSession) {
  const micEnabled = this.store.getState().micEnabled;
  if (!micEnabled && this.store.getState().deaf) {
    await this.toggleDeaf();
  }
  await this.getRoom().localParticipant.setMicrophoneEnabled(!micEnabled);
  this.syncParticipantState();
}

export async function startScreenShare(
  this: CallSession,
  {
    includePreview = true,
    ...request
  }: Omit<MediaShareRequest, "kind"> & {
    includePreview?: boolean;
  } = {},
) {
  await this.updateElectronExpectedEncoderWarning();
  const settings = await loadCallSettings(
    requireRuntime(this.store.getState().runtime),
  );
  if (!includePreview) await this.clearScreenSharePreview();
  await this.getMediaShareController().start({
    resolution: settings.call_screen_share_resolution,
    frameRate: settings.call_screen_share_frame_rate,
    includeAudio: settings.call_screen_share_audio,
    codec: settings.call_screen_share_codec,
    ...request,
    kind: "screen",
  });
  if (includePreview) await this.publishScreenSharePreview();
}

export async function startCameraShare(this: CallSession, sourceId?: string) {
  const settings = await loadCallSettings(
    requireRuntime(this.store.getState().runtime),
  );
  await this.getMediaShareController().start({
    kind: "camera",
    sourceId,
    resolution: settings.call_camera_resolution,
    frameRate: settings.call_camera_frame_rate,
  });
}

// Stop the local participant's active screen share and related previews.
export async function stopScreenShare(this: CallSession) {
  await this.getMediaShareController().stop("screen");
  await this.clearScreenSharePreview();
  this.store.setState({ screenShareActiveCodec: null });
}

export async function stopCameraShare(this: CallSession) {
  await this.getMediaShareController().stop("camera");
}

export function getLocalScreenShareTrack(
  this: CallSession,
): MediaStreamTrack | null {
  const track = getTrackPublicationBySource(
    this.getRoom().localParticipant,
    Track.Source.ScreenShare,
  )?.track;
  if (!track || track.kind !== Track.Kind.Video) {
    return null;
  }
  return track.mediaStreamTrack;
}

export async function updateLocalParticipantAttributes(
  this: CallSession,
  attributes: Record<string, string>,
) {
  log(2, "call", "purple", "Updating local participant attributes", {
    attributeKeys: Object.keys(attributes),
    screenSharePreviewLength: attributes.screenSharePreview?.length ?? 0,
  });
  await this.getRoom()
    .localParticipant.setAttributes(attributes)
    .catch((error) => {
      log(1, "call", "red", "Failed to update local participant attributes", {
        attributes: Object.keys(attributes),
        error,
      });
      throw error;
    });
  log(2, "call", "purple", "Updated local participant attributes", {
    attributeKeys: Object.keys(attributes),
    screenSharePreviewLength: attributes.screenSharePreview?.length ?? 0,
  });
}

export async function waitForScreenSharePreviewFrame(
  this: CallSession,
  video: HTMLVideoElement,
) {
  if (
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  ) {
    log(2, "call", "purple", "Screen share preview frame already ready", {
      readyState: video.readyState,
      width: video.videoWidth,
      height: video.videoHeight,
    });
    return;
  }
  log(2, "call", "purple", "Waiting for screen share preview frame", {
    readyState: video.readyState,
  });
  await new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for screen share preview frame."));
    }, SCREEN_SHARE_PREVIEW_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.onloadeddata = null;
      video.oncanplay = null;
      video.onerror = null;
    };
    const ready = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        log(2, "call", "purple", "Screen share preview frame became ready", {
          readyState: video.readyState,
          width: video.videoWidth,
          height: video.videoHeight,
        });
        cleanup();
        resolve();
      }
    };
    video.onloadeddata = ready;
    video.oncanplay = ready;
    video.onerror = () => {
      cleanup();
      reject(new Error("Failed to load screen share preview frame."));
    };
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(() => {
        ready();
      });
    }
    ready();
  });
}

export async function publishScreenSharePreview(this: CallSession) {
  const videoTrack = this.getLocalScreenShareTrack();
  if (!videoTrack) {
    log(
      2,
      "call",
      "purple",
      "Skipping screen share preview publish: no local video track",
    );
    return;
  }
  log(2, "call", "purple", "Publishing screen share preview", {
    trackId: videoTrack.id,
    readyState: videoTrack.readyState,
    muted: videoTrack.muted,
  });
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = new MediaStream([videoTrack]);
  try {
    await video.play().catch(() => undefined);
    log(2, "call", "purple", "Screen share preview video play attempted", {
      readyState: video.readyState,
    });
    await this.waitForScreenSharePreviewFrame(video);
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error("Screen share preview video has no dimensions.");
    }
    log(2, "call", "purple", "Capturing screen share preview frame", {
      width: video.videoWidth,
      height: video.videoHeight,
    });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Failed to create screen share preview canvas.");
    }
    canvas.width = SCREEN_SHARE_PREVIEW_MAX_WIDTH;
    canvas.height = SCREEN_SHARE_PREVIEW_MAX_HEIGHT;
    const scale = Math.min(
      canvas.width / video.videoWidth,
      canvas.height / video.videoHeight,
    );
    const drawWidth = Math.max(1, Math.round(video.videoWidth * scale));
    const drawHeight = Math.max(1, Math.round(video.videoHeight * scale));
    const x = Math.floor((canvas.width - drawWidth) / 2);
    const y = Math.floor((canvas.height - drawHeight) / 2);
    context.fillStyle = "#111111";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(video, x, y, drawWidth, drawHeight);
    const preview = canvas.toDataURL(
      "image/webp",
      SCREEN_SHARE_PREVIEW_QUALITY,
    );
    log(2, "call", "purple", "Generated screen share preview", {
      previewLength: preview.length,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    });
    await this.updateLocalParticipantAttributes({
      screenSharePreview: preview,
    });
    log(2, "call", "purple", "Published screen share preview");
  } catch (error) {
    log(1, "call", "red", "Failed to publish screen share preview", error);
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

export async function clearScreenSharePreview(this: CallSession) {
  log(2, "call", "purple", "Clearing screen share preview");
  await this.updateLocalParticipantAttributes({
    screenSharePreview: "",
  }).catch((error) => {
    log(1, "call", "red", "Failed to clear screen share preview", error);
  });
}

export async function updateScreenShareCodecAndEncoderStatus(
  this: CallSession,
  publication?: LocalTrackPublication,
) {
  const activePublication =
    publication ??
    this.getRoom().localParticipant.getTrackPublication(
      Track.Source.ScreenShare,
    );
  const report = await activePublication?.track?.getRTCStatsReport();
  if (!report) return;
  let codec: string | null = null;
  let softwareEncoder = false;
  let hardwareEncoder = false;
  report.forEach((stat) => {
    if (stat.type !== "outbound-rtp" || stat.kind !== "video") return;
    const codecStat = stat.codecId ? report.get(stat.codecId) : undefined;
    if (codecStat?.mimeType)
      codec = String(codecStat.mimeType).split("/").pop() ?? null;
    const implementation = String(
      (
        stat as RTCStats & {
          encoderImplementation?: string;
        }
      ).encoderImplementation ?? "",
    );
    if (/software|libvpx|openh264/i.test(implementation))
      softwareEncoder = true;
    if (
      (
        stat as RTCStats & {
          powerEfficientEncoder?: boolean;
        }
      ).powerEfficientEncoder === true ||
      (/hardware/i.test(implementation) && !softwareEncoder)
    ) {
      hardwareEncoder = true;
    }
  });
  this.store.setState({ screenShareActiveCodec: codec });
  const gpuStatus =
    await window.tensaminDesktop?.media?.getGpuFeatureStatus?.();
  if (!gpuStatus) return;
  const managed = new Set([
    "Hardware video encoding is unavailable.",
    "Hardware video encoding could not be verified.",
  ]);
  const warnings = this.store
    .getState()
    .warnings.filter((warning) => !managed.has(warning));
  if (softwareEncoder || gpuStatus.videoEncode !== "enabled") {
    warnings.push("Hardware video encoding is unavailable.");
  } else if (!hardwareEncoder) {
    warnings.push("Hardware video encoding could not be verified.");
  }
  this.store.setState({ warnings });
}

export async function updateElectronExpectedEncoderWarning(this: CallSession) {
  const gpuStatus =
    await window.tensaminDesktop?.media?.getGpuFeatureStatus?.();
  if (!gpuStatus) return;
  const managed = new Set([
    "Hardware video encoding is unavailable.",
    "Hardware video encoding could not be verified.",
  ]);
  const warnings = this.store
    .getState()
    .warnings.filter((warning) => !managed.has(warning));
  warnings.push(
    gpuStatus.videoEncode === "enabled"
      ? "Hardware video encoding could not be verified."
      : "Hardware video encoding is unavailable.",
  );
  this.store.setState({ warnings });
}

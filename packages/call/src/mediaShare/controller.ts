import { log } from "@tensamin/shared/log";
import {
  type LocalTrack,
  type LocalTrackPublication,
  LocalVideoTrack,
  Room,
  Track,
  type VideoCodec,
} from "livekit-client";
import {
  getMediaShareAdapter,
  type MediaShareKind,
  type MediaShareRequest,
  type MediaShareSession,
} from ".";

export type ScreenShareSettings = Required<
  Pick<MediaShareRequest, "resolution" | "frameRate" | "includeAudio" | "codec">
>;

export type LocalMediaShareSession = {
  capture: MediaShareSession;
  videoTrack: MediaStreamTrack | null;
  audioTrack: MediaStreamTrack | null;
  publishedTracks: Array<LocalTrack | MediaStreamTrack>;
  settings: ScreenShareSettings;
  reconfigurationGeneration: number;
};

type MediaShareStoreState = {
  screenShareSession: LocalMediaShareSession | null;
  cameraSession: LocalMediaShareSession | null;
};

const codecMimeTypes = {
  vp8: "video/VP8",
  vp9: "video/VP9",
  h264: "video/H264",
  av1: "video/AV1",
  h265: "video/H265",
} as const;

export function getSupportedScreenShareCodecs() {
  if (typeof RTCRtpSender === "undefined") return [];
  const capabilities = RTCRtpSender.getCapabilities?.("video");
  const mimeTypes = new Set(
    capabilities?.codecs.map((codec) => codec.mimeType.toLowerCase()) ?? [],
  );
  return (
    Object.keys(codecMimeTypes) as Array<keyof typeof codecMimeTypes>
  ).filter((codec) => mimeTypes.has(codecMimeTypes[codec].toLowerCase()));
}

async function isPowerEfficient(
  codec: keyof typeof codecMimeTypes,
  settings: ScreenShareSettings,
) {
  if (!navigator.mediaCapabilities?.encodingInfo) return false;
  try {
    const result = await navigator.mediaCapabilities.encodingInfo({
      type: "webrtc",
      video: {
        contentType: codecMimeTypes[codec],
        width: Math.round((settings.resolution * 16) / 9),
        height: settings.resolution,
        bitrate: 4_000_000,
        framerate: settings.frameRate,
      },
    } as MediaEncodingConfiguration);
    return result.supported && result.smooth && result.powerEfficient;
  } catch {
    return false;
  }
}

export async function resolveScreenShareCodec(settings: ScreenShareSettings) {
  const supported = getSupportedScreenShareCodecs();
  if (settings.codec !== "auto") {
    if (supported.includes(settings.codec)) return settings.codec;
    settings = { ...settings, codec: "auto" };
  }
  for (const codec of ["av1", "vp9", "h264"] as const) {
    if (
      supported.includes(codec) &&
      (await isPowerEfficient(codec, settings))
    ) {
      return codec;
    }
  }
  return "vp8";
}

export function createMediaShareController({
  room,
  getState,
  setState,
  getLocalParticipantId,
  startWatching,
  stopWatching,
  syncParticipantState,
}: {
  room: Room;
  getState: () => MediaShareStoreState;
  setState: (
    updater:
      | Partial<MediaShareStoreState>
      | ((state: MediaShareStoreState) => Partial<MediaShareStoreState>),
  ) => void;
  getLocalParticipantId: () => number | null;
  startWatching: (participantId: number) => void;
  stopWatching: (participantId: number) => void;
  syncParticipantState: () => void;
}) {
  let controlledReconfiguration = false;
  let queuedSettings: ScreenShareSettings | null = null;
  let reconfiguration: Promise<void> | null = null;

  function getSession(kind: MediaShareKind) {
    return kind === "screen"
      ? getState().screenShareSession
      : getState().cameraSession;
  }

  function setSession(
    kind: MediaShareKind,
    session: LocalMediaShareSession | null,
  ) {
    setState(
      kind === "screen"
        ? { screenShareSession: session }
        : { cameraSession: session },
    );
  }

  async function clearPublishedShare(kind: MediaShareKind) {
    const session = getSession(kind);
    if (!session) return;
    setSession(kind, null);
    await Promise.all(
      session.publishedTracks.map((track) =>
        room.localParticipant.unpublishTrack(track, true).catch((error) => {
          log(1, "call", "red", `Failed to unpublish ${kind} track`, error);
        }),
      ),
    );
    await session.capture.stop().catch((error) => {
      log(1, "call", "red", `Failed to stop ${kind} capture`, error);
    });
    if (kind === "screen") {
      const localParticipantId = getLocalParticipantId();
      if (localParticipantId != null) stopWatching(localParticipantId);
    }
  }

  async function publishVideo(
    track: MediaStreamTrack,
    kind: MediaShareKind,
    settings: ScreenShareSettings,
  ) {
    const codec = await resolveScreenShareCodec(settings);
    return room.localParticipant.publishTrack(track, {
      source:
        kind === "screen" ? Track.Source.ScreenShare : Track.Source.Camera,
      videoCodec: codec as VideoCodec,
      backupCodec: true,
    });
  }

  async function publishShare(
    kind: MediaShareKind,
    capture: MediaShareSession,
    settings: ScreenShareSettings,
  ) {
    const videoTrack =
      capture.tracks.find((track) => track.kind === "video") ?? null;
    const audioTrack =
      capture.tracks.find((track) => track.kind === "audio") ?? null;
    if (!videoTrack) {
      await capture.stop();
      throw new Error(`No ${kind} video track was created.`);
    }

    const publications: LocalTrackPublication[] = [];
    try {
      publications.push(await publishVideo(videoTrack, kind, settings));
      if (kind === "screen" && settings.includeAudio && audioTrack) {
        publications.push(
          await room.localParticipant.publishTrack(audioTrack, {
            source: Track.Source.ScreenShareAudio,
          }),
        );
      }
    } catch (error) {
      await Promise.all(
        publications.map((publication) =>
          publication.track
            ? room.localParticipant.unpublishTrack(publication.track, true)
            : undefined,
        ),
      );
      await capture.stop();
      throw error;
    }

    for (const track of capture.tracks) {
      track.addEventListener("ended", () => void stop(kind), { once: true });
    }

    setSession(kind, {
      capture,
      videoTrack,
      audioTrack,
      publishedTracks: publications.flatMap((publication) =>
        publication.track ? [publication.track] : [],
      ),
      settings,
      reconfigurationGeneration: 0,
    });
    syncParticipantState();
    if (kind === "screen") {
      const localParticipantId = getLocalParticipantId();
      if (localParticipantId != null) startWatching(localParticipantId);
    }
  }

  async function start(request: MediaShareRequest) {
    await clearPublishedShare(request.kind);
    const settings: ScreenShareSettings = {
      resolution: request.resolution ?? 1080,
      frameRate: request.frameRate ?? 30,
      includeAudio: request.includeAudio ?? false,
      codec: request.codec ?? "auto",
    };
    const capture = await getMediaShareAdapter().start(request);
    await publishShare(request.kind, capture, settings);
  }

  async function applyScreenSettings(settings: ScreenShareSettings) {
    const session = getSession("screen");
    if (!session?.videoTrack) return;
    const generation = ++session.reconfigurationGeneration;
    const oldSettings = session.settings;
    controlledReconfiguration = true;
    try {
      await session.videoTrack.applyConstraints({
        height: { ideal: settings.resolution },
        frameRate: { ideal: settings.frameRate },
      });
      if (generation !== session.reconfigurationGeneration) return;

      const publishedAudio = session.publishedTracks.find(
        (track) => track.kind === "audio",
      );
      if (settings.includeAudio && session.audioTrack && !publishedAudio) {
        const publication = await room.localParticipant.publishTrack(
          session.audioTrack,
          {
            source: Track.Source.ScreenShareAudio,
          },
        );
        if (publication.track) session.publishedTracks.push(publication.track);
      } else if (!settings.includeAudio && publishedAudio) {
        await room.localParticipant.unpublishTrack(publishedAudio, false);
        session.publishedTracks = session.publishedTracks.filter(
          (track) => track !== publishedAudio,
        );
      }

      const codecChanged =
        (await resolveScreenShareCodec(settings)) !==
        (await resolveScreenShareCodec(oldSettings));
      if (codecChanged) {
        const publishedVideo = session.publishedTracks.find(
          (track) => track.kind === "video",
        );
        if (publishedVideo) {
          await room.localParticipant.unpublishTrack(publishedVideo, false);
          const publication = await publishVideo(
            session.videoTrack,
            "screen",
            settings,
          );
          session.publishedTracks = session.publishedTracks.filter(
            (track) => track !== publishedVideo,
          );
          if (publication.track)
            session.publishedTracks.push(publication.track);
        }
      } else {
        const video = session.publishedTracks.find(
          (track): track is LocalVideoTrack => track instanceof LocalVideoTrack,
        );
        const sender = video?.sender;
        if (sender) {
          const parameters = sender.getParameters();
          parameters.encodings = parameters.encodings.map((encoding) => ({
            ...encoding,
            maxFramerate: settings.frameRate,
          }));
          try {
            await sender.setParameters(parameters);
          } catch {
            await room.localParticipant.unpublishTrack(video, false);
            const publication = await publishVideo(
              session.videoTrack,
              "screen",
              settings,
            );
            session.publishedTracks = session.publishedTracks.filter(
              (track) => track !== video,
            );
            if (publication.track)
              session.publishedTracks.push(publication.track);
          }
        }
      }
      if (generation === session.reconfigurationGeneration)
        session.settings = settings;
    } finally {
      controlledReconfiguration = false;
    }
  }

  function reconfigureScreen(settings: ScreenShareSettings) {
    queuedSettings = settings;
    if (!reconfiguration) {
      reconfiguration = (async () => {
        while (queuedSettings) {
          const next = queuedSettings;
          queuedSettings = null;
          await applyScreenSettings(next);
        }
      })().finally(() => {
        reconfiguration = null;
      });
    }
    return reconfiguration;
  }

  async function stop(kind: MediaShareKind) {
    await clearPublishedShare(kind);
    syncParticipantState();
  }

  async function clearAll() {
    await Promise.all([
      clearPublishedShare("screen"),
      clearPublishedShare("camera"),
    ]);
  }

  return {
    clearAll,
    reconfigureScreen,
    start,
    stop,
    get reconfiguring() {
      return controlledReconfiguration;
    },
  };
}

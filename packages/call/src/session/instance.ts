import { storageDefaults } from "@tensamin/shared/data";
import { ExternalE2EEKeyProvider, Room } from "livekit-client";
import { createMediaShareController } from "../mediaShare/controller";
import { SpeakingDetector } from "../speakingIndicator";
import { createSpeakingState } from "../speakingStore";
import type { CallRuntime as Runtime } from "../state";
import { createCallStore } from "../state";
import * as connection from "./connection";
import * as encryption from "./encryption";
import * as layout from "./layout";
import * as media from "./media";
import * as room from "./room";
import * as settings from "./settings";
import type { CallSettings } from "./shared";
import { callSettingKeys } from "./shared";
import * as subscriptions from "./subscriptions";

function createResources(runtime: Runtime) {
  const store = createCallStore(runtime);
  const speaking = createSpeakingState();
  let detector: SpeakingDetector | null = null;
  return {
    id: crypto.randomUUID(),
    disposed: false,
    store,
    speaking,
    getSpeakingDetector() {
      return (detector ??= new SpeakingDetector(speaking));
    },
    disposeSpeakingDetector() {
      detector?.dispose();
      detector = null;
    },
    _keyProvider: null as ExternalE2EEKeyProvider | null,
    _e2eeWorker: null as Worker | null,
    _room: null as Room | null,
    callAttemptGeneration: 0,
    microphoneDeviceGeneration: 0,
    latestMicrophoneDeviceId: storageDefaults.call_microphone_device_id,
    callSettingsGeneration: 0,
    participantVolumes: new Map<number, number>(),
    currentCallSettings: Object.fromEntries(
      callSettingKeys.map((key) => [key, storageDefaults[key]]),
    ) as CallSettings,
    remoteAudioElements: new Map<string, HTMLMediaElement>(),
    pendingRemoteScreenShareEnds: new Map<
      string,
      ReturnType<typeof setTimeout>
    >(),
    watchedScreenShareParticipantIdsUpdate: Promise.resolve(),
    activeCallViewTransition: null as ViewTransition | null,
    mediaShareController: null as ReturnType<
      typeof createMediaShareController
    > | null,
    latestCallDataRequest: 0,
  };
}
const actions = {
  ...room,
  ...subscriptions,
  ...layout,
  ...settings,
  ...connection,
  ...encryption,
  ...media,
};
export type CallSession = ReturnType<typeof createResources> & {
  [K in keyof typeof actions]: OmitThisParameter<(typeof actions)[K]>;
};
export function createCallSession(runtime: Runtime): CallSession {
  const session = Object.assign(createResources(runtime), actions);
  for (const name of Object.keys(actions) as (keyof typeof actions)[]) {
    Object.assign(session, { [name]: session[name].bind(session) });
  }
  return session;
}

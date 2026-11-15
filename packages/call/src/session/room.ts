import { log } from "@tensamin/shared/log";
import { playSound } from "@tensamin/shared/sounds";
import {
  ExternalE2EEKeyProvider,
  getLogger,
  Room,
  setLogExtension,
} from "livekit-client";
import type { CallSession } from "./instance";

setLogExtension(
  (level, message, context) =>
    context
      ? log(level, "livekit", "blue", message, context)
      : log(level, "livekit", "blue", message),
  getLogger("tensamin"),
);

export function getKeyProvider(this: CallSession): ExternalE2EEKeyProvider {
  if (!this._keyProvider) {
    this._keyProvider = new ExternalE2EEKeyProvider();
  }
  return this._keyProvider;
}

export function getE2EEWorker(this: CallSession): Worker {
  if (!this._e2eeWorker) {
    this._e2eeWorker = new Worker(
      new URL("livekit-client/e2ee-worker", import.meta.url),
    );
  }
  return this._e2eeWorker;
}

export function terminateE2EEWorker(this: CallSession) {
  this._e2eeWorker?.terminate();
  this._e2eeWorker = null;
}

export function getRoom(this: CallSession): Room {
  if (this.disposed) throw new Error("Call session has ended");
  if (!this._room) {
    this._room = new Room({
      dynacast: true,
      adaptiveStream: true,
      loggerName: "tensamin",
      encryption: {
        keyProvider: this.getKeyProvider(),
        worker: this.getE2EEWorker(),
      },
    });
  }
  return this._room;
}

export function playCallEvent(
  this: CallSession,
  sound: Parameters<typeof playSound>[0],
) {
  if (!this.currentCallSettings.call_event_sounds_enabled) return;
  playSound(sound, false, this.currentCallSettings.call_sound_volume / 100);
}

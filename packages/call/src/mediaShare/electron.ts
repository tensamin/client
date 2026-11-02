import type {} from "@tensamin/shared/desktopMedia";
import { BrowserMediaShareAdapter, listCameraSources } from "./browser";
import type {
  MediaShareCapabilities,
  MediaShareKind,
  MediaShareRequest,
  MediaShareSession,
  MediaShareSource,
} from "./types";

let capturePending = false;

export class ElectronMediaShareAdapter extends BrowserMediaShareAdapter {
  override async getCapabilities(): Promise<MediaShareCapabilities> {
    const capabilities =
      await window.tensaminDesktop?.media?.getScreenShareCapabilities?.();

    return {
      runtime: "electron",
      screenPicker: "sources",
      canShareScreenAudio: capabilities?.hasReliableSystemAudio ?? false,
      canSelectScreenAudioOutput:
        capabilities?.showAudioOutputSelector ?? false,
    };
  }

  override async listSources(
    kind: MediaShareKind,
  ): Promise<MediaShareSource[]> {
    if (kind === "camera") {
      return listCameraSources();
    }

    return (
      (await window.tensaminDesktop?.media?.listScreenShareSources?.()) ?? []
    );
  }

  override async start(request: MediaShareRequest): Promise<MediaShareSession> {
    if (request.kind === "camera") {
      return super.start(request);
    }

    if (!request.sourceId) {
      throw new Error("Choose a screen or window to share.");
    }

    const select = window.tensaminDesktop?.media?.selectScreenShareSource;
    if (!select) {
      throw new Error("Electron screen capture is unavailable.");
    }

    if (capturePending)
      throw new Error("A screen capture request is already pending.");
    capturePending = true;
    let selected = false;
    let started = false;
    try {
      selected = await select(request.sourceId);
      if (!selected) throw new Error("Screen capture selection was rejected.");
      const capture = await super.start({ ...request, sourceId: undefined });
      started = true;
      return capture;
    } finally {
      try {
        if (selected && !started) await select(null);
      } finally {
        capturePending = false;
      }
    }
  }
}

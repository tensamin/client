import type {} from "@tensamin/shared/desktopMedia";
import { BrowserMediaShareAdapter, listCameraSources } from "./browser";
import type {
  MediaShareCapabilities,
  MediaShareKind,
  MediaShareRequest,
  MediaShareSession,
  MediaShareSource,
} from "./types";

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

    await select(request.sourceId);
    return super.start({ ...request, sourceId: undefined });
  }
}

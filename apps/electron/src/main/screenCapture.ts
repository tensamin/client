import { desktopCapturer, ipcMain, session, type WebFrameMain } from "electron";
import { ipcChannels } from "../shared/ipc.js";

export function registerDisplayMediaHandler(
  isTrustedFrame: (frame: WebFrameMain) => boolean,
) {
  let pending: {
    frame: WebFrameMain;
    sourceId: string;
    consumed: boolean;
    clear: () => void;
  } | null = null;

  ipcMain.handle(
    ipcChannels.selectScreenShareSource,
    (event, sourceId: unknown) => {
      const frame = event.senderFrame;

      if (!frame || !isTrustedFrame(frame))
        throw new Error("Untrusted capture sender.");

      if (sourceId === null) {
        if (pending?.frame === frame) pending.clear();

        return true;
      }

      if (
        typeof sourceId !== "string" ||
        !sourceId.length ||
        sourceId.length > 256
      ) {
        throw new Error("Invalid screen share source id.");
      }

      if (pending)
        throw new Error("A screen capture request is already pending.");
      const selection = {
        frame,
        sourceId,
        consumed: false,
        clear: () => {
          if (pending === selection) pending = null;
          event.sender.removeListener("did-start-navigation", selection.clear);
          event.sender.removeListener("destroyed", selection.clear);
        },
      };
      pending = selection;
      event.sender.once("did-start-navigation", selection.clear);
      event.sender.once("destroyed", selection.clear);

      return true;
    },
  );

  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const selection = pending;

      if (
        !selection ||
        selection.consumed ||
        request.frame !== selection.frame ||
        !isTrustedFrame(selection.frame)
      ) {
        callback({});

        return;
      }

      // Claim before enumeration. A concurrent request cannot consume this consent.
      selection.consumed = true;
      let sources;

      try {
        sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 0, height: 0 },
        });
      } catch {
        selection.clear();
        callback({});

        return;
      }

      const valid =
        pending === selection &&
        request.frame === selection.frame &&
        isTrustedFrame(selection.frame);
      selection.clear();
      const video = valid
        ? sources.find((source) => source.id === selection.sourceId)
        : undefined;

      if (!video) {
        callback({});

        return;
      }

      callback(
        process.platform === "win32" && request.audioRequested
          ? { video, audio: "loopback" }
          : { video },
      );
    },
  );
}

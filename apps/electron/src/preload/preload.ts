import { contextBridge, ipcRenderer } from "electron";
import {
  ipcChannels,
  type DesktopCallStatus,
  type DesktopGlobalHotkeyBinding,
  type DesktopScreenShareSource,
  secureStorageLimits,
} from "../shared/ipc.js";

function windowAction(channel: string) {
  return () => ipcRenderer.invoke(channel);
}

function validKey(key: string) {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    Buffer.byteLength(key, "utf8") <= secureStorageLimits.maxKeyBytes
  );
}

const desktopApi = {
  deepLinks: {
    onOpened: (callback: (url: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, url: unknown) => {
        if (typeof url === "string") callback(url);
      };
      ipcRenderer.on(ipcChannels.deepLinkOpened, listener);
      return () =>
        ipcRenderer.removeListener(ipcChannels.deepLinkOpened, listener);
    },
  },
  media: {
    listScreenShareSources: () =>
      ipcRenderer.invoke(ipcChannels.listScreenShareSources),
    listScreenShareAudioOutputs: () =>
      ipcRenderer.invoke(ipcChannels.listScreenShareAudioOutputs),
    getScreenShareCapabilities: () =>
      ipcRenderer.invoke(ipcChannels.getScreenShareCapabilities),
    getGpuFeatureStatus: () =>
      ipcRenderer.invoke(ipcChannels.getGpuFeatureStatus),
    selectScreenShareSource: (sourceId: DesktopScreenShareSource["id"]) => {
      if (typeof sourceId !== "string" || sourceId.length === 0) {
        return Promise.reject(new Error("Invalid screen share source id."));
      }

      return ipcRenderer.invoke(ipcChannels.selectScreenShareSource, sourceId);
    },
  },
  app: {
    getVersion: () => ipcRenderer.invoke(ipcChannels.getVersion),
  },
  call: {
    setStatus: (status: DesktopCallStatus) => {
      if (
        typeof status?.inCall !== "boolean" ||
        typeof status?.speaking !== "boolean" ||
        (status.iconDataUrl !== undefined &&
          (typeof status.iconDataUrl !== "string" ||
            !status.iconDataUrl.startsWith("data:image/png;base64,")))
      ) {
        return Promise.reject(new Error("Invalid call status."));
      }

      return ipcRenderer.invoke(ipcChannels.setCallStatus, status);
    },
  },
  hotkeys: {
    setBindings: (bindings: DesktopGlobalHotkeyBinding[]) =>
      ipcRenderer.invoke(ipcChannels.setGlobalHotkeyBindings, bindings),
    setSuspended: (suspended: boolean) =>
      typeof suspended === "boolean"
        ? ipcRenderer.invoke(ipcChannels.setGlobalHotkeysSuspended, suspended)
        : Promise.reject(new Error("Invalid hotkey suspension state.")),
    onTriggered: (callback: (id: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, id: unknown) => {
        if (typeof id === "string") callback(id);
      };
      ipcRenderer.on(ipcChannels.globalHotkeyTriggered, listener);
      return () => {
        ipcRenderer.removeListener(ipcChannels.globalHotkeyTriggered, listener);
      };
    },
  },
  secureStorage: {
    getStatus: () => ipcRenderer.invoke(ipcChannels.getSecureStorageStatus),
    load: (key: string) =>
      validKey(key)
        ? ipcRenderer.invoke(ipcChannels.loadSecureStorage, key)
        : Promise.reject(new Error("Invalid secure storage key.")),
    save: (key: string, value: string) =>
      validKey(key) &&
      typeof value === "string" &&
      Buffer.byteLength(value, "utf8") <= secureStorageLimits.maxValueBytes
        ? ipcRenderer.invoke(ipcChannels.saveSecureStorage, key, value)
        : Promise.reject(new Error("Invalid secure storage key or value.")),
    delete: (key: string) =>
      validKey(key)
        ? ipcRenderer.invoke(ipcChannels.deleteSecureStorage, key)
        : Promise.reject(new Error("Invalid secure storage key.")),
    clear: () => ipcRenderer.invoke(ipcChannels.clearSecureStorage),
  },
  window: {
    minimize: () => windowAction(ipcChannels.minimizeWindow),
    maximize: () => windowAction(ipcChannels.maximizeWindow),
    close: () => windowAction(ipcChannels.closeWindow),
  },
};

contextBridge.exposeInMainWorld("tensaminDesktop", desktopApi);
contextBridge.exposeInMainWorld(
  "tensaminShowWindowControls",
  process.env.TENSAMIN_HIDE_CONTROLS == null,
);

export type TensaminDesktopApi = typeof desktopApi;

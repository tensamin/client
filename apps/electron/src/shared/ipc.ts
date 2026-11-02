export type DesktopScreenShareSource = {
  id: string;
  kind: "screen" | "window";
  name: string;
  subtitle?: string | null;
  thumbnail?: string | null;
};

export type DesktopScreenShareAudioOutput = {
  id: string;
  name: string;
  isDefault: boolean;
};

export type DesktopScreenShareCapabilities = {
  runtime: "electron";
  platform: "linux" | "macos" | "windows" | "other";
  showAudioOutputSelector: boolean;
  showAudioSwitch: boolean;
  hasReliableSystemAudio: boolean;
};

export type DesktopCallStatus = {
  inCall: boolean;
  speaking: boolean;
  iconDataUrl?: string;
};

export type DesktopSecureStorageStatus = {
  available: boolean;
  backend: string | null;
};

export type DesktopGlobalHotkeyBinding = {
  id: string;
  accelerator: string;
};

export const secureStorageLimits = {
  maxKeyBytes: 256,
  maxValueBytes: 1024 * 1024,
} as const;

export const ipcChannels = {
  listScreenShareSources: "desktopMedia:listScreenShareSources",
  listScreenShareAudioOutputs: "desktopMedia:listScreenShareAudioOutputs",
  getScreenShareCapabilities: "desktopMedia:getScreenShareCapabilities",
  getGpuFeatureStatus: "desktopMedia:getGpuFeatureStatus",
  selectScreenShareSource: "desktopMedia:selectScreenShareSource",
  minimizeWindow: "window:minimize",
  maximizeWindow: "window:maximize",
  closeWindow: "window:close",
  getVersion: "app:getVersion",
  setCallStatus: "call:setStatus",
  getSecureStorageStatus: "secureStorage:getStatus",
  loadSecureStorage: "secureStorage:load",
  saveSecureStorage: "secureStorage:save",
  deleteSecureStorage: "secureStorage:delete",
  clearSecureStorage: "secureStorage:clear",
  setGlobalHotkeyBindings: "hotkeys:setBindings",
  setGlobalHotkeysSuspended: "hotkeys:setSuspended",
  globalHotkeyTriggered: "hotkeys:triggered",
  deepLinkOpened: "deepLink:opened",
} as const;

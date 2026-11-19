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
  runtime?: "electron" | "tauri";
  platform: "linux" | "macos" | "windows" | "other";
  showAudioOutputSelector: boolean;
  showAudioSwitch: boolean;
  hasReliableSystemAudio: boolean;
};

declare global {
  interface Window {
    tensaminDesktop?: {
      app?: { getDiagnostics?: () => Promise<Record<string, unknown>> };
      deepLinks?: {
        onOpened?: (callback: (url: string) => void) => () => void;
      };
      media?: {
        getScreenShareCapabilities?: () => Promise<DesktopScreenShareCapabilities>;
        getGpuFeatureStatus?: () => Promise<{ videoEncode: string }>;
        listScreenShareSources?: () => Promise<DesktopScreenShareSource[]>;
        listScreenShareAudioOutputs?: () => Promise<
          DesktopScreenShareAudioOutput[]
        >;
        selectScreenShareSource?: (sourceId: string | null) => Promise<boolean>;
      };
      call?: {
        setStatus?: (status: {
          inCall: boolean;
          speaking: boolean;
          iconDataUrl?: string;
        }) => Promise<void>;
      };
      hotkeys?: {
        setBindings?: (
          bindings: Array<{ id: string; accelerator: string }>,
        ) => Promise<Record<string, boolean>>;
        setSuspended?: (suspended: boolean) => Promise<Record<string, boolean>>;
        onTriggered?: (callback: (id: string) => void) => () => void;
      };
      secureStorage?: {
        getStatus?: () => Promise<{
          available: boolean;
          backend: string | null;
        }>;
        load?: (key: string) => Promise<string | null>;
        getOrCreate?: (key: string, candidate: string) => Promise<string>;
        save?: (key: string, value: string) => Promise<void>;
        delete?: (key: string) => Promise<void>;
        clear?: () => Promise<void>;
      };
    };
  }
}

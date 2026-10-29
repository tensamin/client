import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  session,
  shell,
} from "electron";
import {
  ipcChannels,
  type DesktopCallStatus,
  type DesktopGlobalHotkeyBinding,
  type DesktopScreenShareAudioOutput,
  type DesktopScreenShareCapabilities,
} from "../shared/ipc.js";
import { initTray, setTrayCallStatus } from "./tray.js";
import {
  clearSecureStorage,
  deleteSecureStorage,
  getSecureStorageStatus,
  loadSecureStorage,
  saveSecureStorage,
} from "./secureStorage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const verbose = process.argv.includes("--verbose");
let mainWindow: BrowserWindow | null = null;
let selectedScreenShareSourceId: string | null = null;
let globalHotkeyBindings: DesktopGlobalHotkeyBinding[] = [];
let globalHotkeysSuspended = false;
const pendingDeepLinks: string[] = [];

const channelConfig = JSON.parse(
  readFileSync(
    app.isPackaged
      ? join(process.resourcesPath, "icons", "channel.json")
      : resolve(__dirname, "../../build/icons/channel.json"),
    "utf8",
  ),
) as { channel: string; appId: string; productName: string };
app.setName(channelConfig.productName);
app.setAppUserModelId(channelConfig.appId);
app.setPath(
  "userData",
  join(
    app.getPath("appData"),
    channelConfig.channel === "stable"
      ? "tensamin"
      : `tensamin-${channelConfig.channel}`,
    "electron",
  ),
);
app.setAsDefaultProtocolClient("tensamin");

function openDeepLink(value: string) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "tensamin:" ||
      !["authorize", "chat"].includes(url.hostname)
    )
      return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(ipcChannels.deepLinkOpened, value);
      mainWindow.show();
      mainWindow.focus();
    } else {
      pendingDeepLinks.push(value);
    }
  } catch {
    return;
  }
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
app.on("second-instance", (_event, argv) => {
  argv.filter((value) => value.startsWith("tensamin://")).forEach(openDeepLink);
});
app.on("open-url", (event, url) => {
  event.preventDefault();
  openDeepLink(url);
});

if (verbose) {
  app.commandLine.appendSwitch("enable-logging", "stderr");
  app.commandLine.appendSwitch("v", "1");
  app.commandLine.appendSwitch("log-level", "0");
}

if (
  process.platform === "linux" &&
  !app.commandLine.hasSwitch("password-store")
) {
  app.commandLine.appendSwitch("password-store", "gnome-libsecret");
}

if (
  process.platform === "linux" &&
  process.env.XDG_SESSION_TYPE === "wayland"
) {
  app.commandLine.appendSwitch("enable-features", "GlobalShortcutsPortal");
}

if (
  process.platform === "linux" &&
  process.env.XDG_SESSION_TYPE === "wayland" &&
  !process.env.TENSAMIN_ENABLE_VULKAN
) {
  app.commandLine.appendSwitch("disable-features", "Vulkan");
}

function verboseLog(...args: unknown[]) {
  if (verbose) {
    console.log("[tensamin:electron]", ...args);
  }
}

function getRendererIndex() {
  if (!app.isPackaged) {
    return resolve(__dirname, "../../../web/dist/index.html");
  }

  return join(process.resourcesPath, "web", "index.html");
}

function getWindowIcon() {
  if (process.platform === "darwin") return undefined;
  if (app.isPackaged) return join(process.resourcesPath, "icons", "icon.png");
  return resolve(__dirname, "../../build/icons/icon.png");
}

function getPlatform(): DesktopScreenShareCapabilities["platform"] {
  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "other";
}

function getScreenShareCapabilities(): DesktopScreenShareCapabilities {
  const platform = getPlatform();

  return {
    runtime: "electron",
    platform,
    showAudioOutputSelector: platform === "linux",
    showAudioSwitch: platform === "windows" || platform === "macos",
    hasReliableSystemAudio: platform === "windows",
  };
}

function execJson(command: string, args: string[]) {
  verboseLog("exec", command, args.join(" "));

  return new Promise<unknown>((resolvePromise, reject) => {
    execFile(command, args, { timeout: 3000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }

      resolvePromise(JSON.parse(stdout));
    });
  });
}

async function listAudioOutputs(): Promise<DesktopScreenShareAudioOutput[]> {
  verboseLog("listAudioOutputs", { platform: process.platform });

  if (process.platform !== "linux") return [];

  const sinks = await execJson("pactl", ["--format=json", "list", "sinks"]);
  if (!Array.isArray(sinks)) return [];

  return sinks
    .map((sink) => {
      if (!sink || typeof sink !== "object") return null;
      const record = sink as Record<string, unknown>;
      const id = record.index == null ? undefined : String(record.index);
      const name =
        typeof record.description === "string" ? record.description : id;
      if (!id || !name) return null;
      return { id, name, isDefault: false };
    })
    .filter(
      (output): output is DesktopScreenShareAudioOutput => output != null,
    );
}

async function listScreenShareSources() {
  verboseLog("listScreenShareSources");

  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });

  return sources.map((source) => ({
    id: source.id,
    kind: source.id.startsWith("screen:") ? "screen" : "window",
    name: source.name,
    subtitle: source.id,
    thumbnail: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
  }));
}

function registerDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      verboseLog("display media request", { selectedScreenShareSourceId });

      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 0, height: 0 },
      });

      const selected = sources.find(
        (source) => source.id === selectedScreenShareSourceId,
      );
      selectedScreenShareSourceId = null;
      const video = selected ?? sources[0];

      if (!video) {
        callback({});
        return;
      }

      if (process.platform === "win32") {
        callback({ video, audio: "loopback" });
        return;
      }

      callback({ video });
    },
  );
}

function registerMediaPermissionHandler() {
  const isTrustedRenderer = (url: string) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "file:";
    } catch {
      return false;
    }
  };

  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) =>
      permission === "media" && isTrustedRenderer(requestingOrigin),
  );
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      callback(
        permission === "media" && isTrustedRenderer(details.requestingUrl),
      );
    },
  );
}

function registerIpc() {
  verboseLog("registering ipc handlers");

  ipcMain.handle(ipcChannels.listScreenShareSources, (event) => {
    assertTrustedRenderer(event);
    return listScreenShareSources();
  });
  ipcMain.handle(ipcChannels.listScreenShareAudioOutputs, (event) => {
    assertTrustedRenderer(event);
    return listAudioOutputs();
  });
  ipcMain.handle(ipcChannels.getScreenShareCapabilities, (event) => {
    assertTrustedRenderer(event);
    return getScreenShareCapabilities();
  });
  ipcMain.handle(ipcChannels.getGpuFeatureStatus, (event) => {
    assertTrustedRenderer(event);
    return { videoEncode: app.getGPUFeatureStatus().video_encode };
  });
  ipcMain.handle(
    ipcChannels.selectScreenShareSource,
    (event, sourceId: unknown) => {
      assertTrustedRenderer(event);
      if (
        typeof sourceId !== "string" ||
        sourceId.length === 0 ||
        sourceId.length > 256
      ) {
        throw new Error("Invalid screen share source id.");
      }

      selectedScreenShareSourceId = sourceId;
      verboseLog("selected screen share source", sourceId);
      return true;
    },
  );
  ipcMain.handle(ipcChannels.getVersion, (event) => {
    assertTrustedRenderer(event);
    return app.getVersion();
  });
  ipcMain.handle(ipcChannels.getSecureStorageStatus, (event) => {
    assertTrustedRenderer(event);
    return getSecureStorageStatus();
  });
  ipcMain.handle(ipcChannels.loadSecureStorage, (event, key: unknown) => {
    assertTrustedRenderer(event);
    return loadSecureStorage(key);
  });
  ipcMain.handle(
    ipcChannels.saveSecureStorage,
    (event, key: unknown, value: unknown) => {
      assertTrustedRenderer(event);
      return saveSecureStorage(key, value);
    },
  );
  ipcMain.handle(ipcChannels.deleteSecureStorage, (event, key: unknown) => {
    assertTrustedRenderer(event);
    return deleteSecureStorage(key);
  });
  ipcMain.handle(ipcChannels.clearSecureStorage, (event) => {
    assertTrustedRenderer(event);
    return clearSecureStorage();
  });
  ipcMain.handle(
    ipcChannels.setGlobalHotkeyBindings,
    (event, bindings: unknown) => {
      assertTrustedRenderer(event);
      return setGlobalHotkeyBindings(bindings);
    },
  );
  ipcMain.handle(
    ipcChannels.setGlobalHotkeysSuspended,
    (event, suspended: unknown) => {
      assertTrustedRenderer(event);
      if (typeof suspended !== "boolean") {
        throw new Error("Invalid hotkey suspension state.");
      }
      globalHotkeysSuspended = suspended;
      return applyGlobalHotkeyBindings();
    },
  );
  ipcMain.handle(ipcChannels.setCallStatus, (event, status: unknown) => {
    assertTrustedRenderer(event);
    if (
      typeof status !== "object" ||
      status === null ||
      typeof (status as DesktopCallStatus).inCall !== "boolean" ||
      typeof (status as DesktopCallStatus).speaking !== "boolean" ||
      ((status as DesktopCallStatus).iconDataUrl !== undefined &&
        (typeof (status as DesktopCallStatus).iconDataUrl !== "string" ||
          !(status as DesktopCallStatus).iconDataUrl?.startsWith(
            "data:image/png;base64,",
          ) ||
          (status as DesktopCallStatus).iconDataUrl!.length > 16_384))
    ) {
      throw new Error("Invalid call status.");
    }

    const { inCall, iconDataUrl } = status as DesktopCallStatus;
    setTrayCallStatus(inCall, iconDataUrl);
  });
  ipcMain.handle(ipcChannels.minimizeWindow, (event) => {
    assertTrustedRenderer(event);
    verboseLog("window:minimize");
    mainWindow?.minimize();
  });
  ipcMain.handle(ipcChannels.maximizeWindow, (event) => {
    assertTrustedRenderer(event);
    verboseLog("window:maximize");
    if (!mainWindow) return;

    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
      return;
    }

    mainWindow.maximize();
  });
  ipcMain.handle(ipcChannels.closeWindow, (event) => {
    assertTrustedRenderer(event);
    verboseLog("window:close");
    mainWindow?.close();
  });
}

function assertTrustedRenderer(event: Electron.IpcMainInvokeEvent) {
  const target = mainWindow;
  if (
    !target ||
    target.isDestroyed() ||
    event.sender !== target.webContents ||
    event.senderFrame !== target.webContents.mainFrame
  ) {
    throw new Error("Untrusted IPC sender.");
  }

  try {
    if (fileURLToPath(event.senderFrame.url) === getRendererIndex()) return;
  } catch {
    // Fall through to the rejection below.
  }
  throw new Error("Untrusted IPC sender.");
}

function validGlobalHotkeyBindings(
  value: unknown,
): value is DesktopGlobalHotkeyBinding[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every(
      (binding) =>
        binding &&
        typeof binding === "object" &&
        typeof (binding as DesktopGlobalHotkeyBinding).id === "string" &&
        /^[a-z0-9.-]+$/i.test((binding as DesktopGlobalHotkeyBinding).id) &&
        (binding as DesktopGlobalHotkeyBinding).id.length > 0 &&
        (binding as DesktopGlobalHotkeyBinding).id.length <= 128 &&
        typeof (binding as DesktopGlobalHotkeyBinding).accelerator ===
          "string" &&
        (binding as DesktopGlobalHotkeyBinding).accelerator.length > 0 &&
        (binding as DesktopGlobalHotkeyBinding).accelerator.length <= 128,
    )
  );
}

function applyGlobalHotkeyBindings() {
  globalShortcut.unregisterAll();
  const statuses = Object.fromEntries(
    globalHotkeyBindings.map(({ id }) => [id, false]),
  );
  if (globalHotkeysSuspended) return statuses;

  const grouped = new Map<string, string[]>();
  for (const { id, accelerator } of globalHotkeyBindings) {
    const ids = grouped.get(accelerator) ?? [];
    ids.push(id);
    grouped.set(accelerator, ids);
  }

  for (const [accelerator, ids] of grouped) {
    let registered = false;
    try {
      registered = globalShortcut.register(accelerator, () => {
        const target = mainWindow;
        if (!target || target.isDestroyed()) return;
        ids.forEach((id) =>
          target.webContents.send(ipcChannels.globalHotkeyTriggered, id),
        );
      });
    } catch (error) {
      console.error("Failed to register global hotkey", accelerator, error);
    }
    ids.forEach((id) => {
      statuses[id] = registered;
    });
  }

  return statuses;
}

function setGlobalHotkeyBindings(bindings: unknown) {
  if (!validGlobalHotkeyBindings(bindings)) {
    throw new Error("Invalid global hotkey bindings.");
  }
  globalHotkeyBindings = bindings;
  return applyGlobalHotkeyBindings();
}

async function createWindow() {
  const rendererIndex = getRendererIndex();
  verboseLog("creating main window", {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    rendererIndex,
    argv: process.argv,
  });

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Tensamin",
    icon: getWindowIcon(),
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    const protocol = new URL(url).protocol;
    if (["https:", "http:", "mailto:", "tensamin:"].includes(protocol)) {
      void shell.openExternal(url);
    }
  });
  mainWindow.webContents.on("will-redirect", (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    verboseLog("blocked window open", url);
    const protocol = new URL(url).protocol;
    if (["https:", "http:", "mailto:", "tensamin:"].includes(protocol)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  if (verbose) {
    mainWindow.webContents.on(
      "console-message",
      (_event, level, message, line, sourceId) => {
        const target = level >= 2 ? console.error : console.log;
        target("[tensamin:renderer]", message, { level, line, sourceId });
      },
    );

    mainWindow.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL) => {
        console.error("[tensamin:electron] renderer failed to load", {
          errorCode,
          errorDescription,
          validatedURL,
        });
      },
    );

    mainWindow.webContents.on("did-finish-load", () => {
      verboseLog("renderer finished loading", mainWindow?.webContents.getURL());
    });

    mainWindow.webContents.on("render-process-gone", (_event, details) => {
      console.error("[tensamin:electron] renderer process gone", details);
    });

    mainWindow.on("unresponsive", () => {
      console.error("[tensamin:electron] main window became unresponsive");
    });
  }

  await mainWindow.loadFile(rendererIndex);
  pendingDeepLinks.splice(0).forEach(openDeepLink);
}

app.on("window-all-closed", () => {
  verboseLog("window-all-closed");
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  verboseLog("activate");
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

if (verbose) {
  process.on("uncaughtException", (error) => {
    console.error("[tensamin:electron] uncaught exception", error);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[tensamin:electron] unhandled rejection", reason);
  });
}

async function start() {
  verboseLog("waiting for app readiness");
  await app.whenReady();
  verboseLog("app ready");
  registerIpc();
  registerDisplayMediaHandler();
  registerMediaPermissionHandler();
  initTray(() => mainWindow);
  await createWindow();
  process.argv
    .filter((value) => value.startsWith("tensamin://"))
    .forEach(openDeepLink);
}

void start().catch((error) => {
  console.error("[tensamin:electron] failed to start", error);
  app.exit(1);
});

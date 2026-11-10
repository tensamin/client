// @vitest-environment jsdom
/// <reference types="node" />
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MTPClient } from "mtp";
import { encryptChatText } from "@tensamin/crypto/chatSecret";
import { clearDatabaseStore } from "@tensamin/shared/indexedDb";
import { setPlatformVisible } from "@tensamin/shared/focus";
import Provider from "./context";

const mocks = vi.hoisted(() => ({
  account: "account-a",
  native: false,
  path: "/",
  userId: 0,
  send: vi.fn(),
  secret: vi.fn(),
  presentation: vi.fn(),
  toast: vi.fn(),
  sound: vi.fn(),
  invoke: vi.fn(),
  subscribe: vi.fn(),
  navigate: vi.fn(),
  mark: vi.fn(),
  move: vi.fn(),
  setNotifications: vi.fn(),
  subscriptions: new Map<string, (message: unknown) => void>(),
  nativeEvents: new Map<string, (message: { payload: unknown }) => void>(),
  client: {},
  contacts: [] as {
    UserId: number;
    Principal: string;
    notifications: number;
    LastMessageAt: number;
  }[],
}));
vi.mock("@tensamin/mtp", () => ({
  useMTP: () => ({
    accountKey: mocks.account,
    client: mocks.client,
    send: mocks.send,
    subscribe: mocks.subscribe,
    identified: true,
  }),
}));
vi.mock("@tensamin/identity/context", () => ({
  useUser: () => ({ getPresentation: mocks.presentation }),
}));
vi.mock("@tensamin/chat/context", () => ({
  useChat: () => ({
    getChatSecret: mocks.secret,
    markMessagesAsNew: mocks.mark,
    newMessageCount: 0,
    userId: mocks.userId,
  }),
}));
vi.mock("@tensamin/identity/session", () => ({
  useSession: () => ({
    contacts: mocks.contacts,
    moveUserIdToTop: mocks.move,
    setNotifications: mocks.setNotifications,
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ pathname: mocks.path }),
  useNavigate: () => mocks.navigate,
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => mocks.native,
  invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (
    type: string,
    handler: (event: { payload: unknown }) => void,
  ) => {
    mocks.nativeEvents.set(type, handler);

    return () => mocks.nativeEvents.delete(type);
  },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@tensamin/shared/log", () => ({ log: vi.fn() }));
vi.mock("@tensamin/shared/sounds", () => ({ playSound: mocks.sound }));

const principal = JSON.stringify({
  authority: "omega-key:" + "b".repeat(64),
  user_id: 2,
});
const secret = new Uint8Array(32).fill(17);
const alerts: { title: string; options: NotificationOptions }[] = [];
let content: string, root: Root;
let shown: () => void;
let permission: NotificationPermission = "granted";
const permissionRequest = vi.fn(async () => "denied" as NotificationPermission);
class NotificationBoundary {
  static get permission() {
    return permission;
  }
  static requestPermission = permissionRequest;
  onclick?: () => void;
  constructor(title: string, options: NotificationOptions) {
    alerts.push({ title, options });
    shown?.();
  }
  close() {}
}
beforeAll(async () => {
  await MTPClient.init({
    module_or_path: readFileSync(
      resolve("apps/web/node_modules/.vite/mtp/mtp_wasm_bg.wasm"),
    ),
  });
  content = await encryptChatText(secret, "decrypted preview", 1);
});
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("structuredClone", (value: unknown) => value);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", NotificationBoundary);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  setPlatformVisible(true);
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (_key: string, operation: () => Promise<unknown>) =>
        operation(),
    },
  });
  await clearDatabaseStore("cache");
  alerts.length = 0;
  permission = "granted";
  mocks.account = "account-a";
  mocks.native = false;
  mocks.path = "/";
  mocks.userId = 0;
  mocks.contacts = [];
  mocks.subscribe.mockImplementation(
    (type: string, handler: (message: unknown) => void) => {
      mocks.subscriptions.set(type, handler);

      return () => mocks.subscriptions.delete(type);
    },
  );
  mocks.send.mockReset().mockImplementation(async (_type, data) => ({
    type: "MessageGet",
    data: {
      Message: {
        Principal: data.Principal,
        RelayMessageId: data.RelayMessageId,
        SenderId: 2,
        SendTime: 10,
        VersionNumber: 1,
        Content: content,
      },
    },
  }));
  mocks.secret.mockReset().mockResolvedValue(secret);
  mocks.presentation
    .mockReset()
    .mockResolvedValue({ Principal: principal, Display: "Verified sender" });
  mocks.invoke.mockReset().mockResolvedValue(false);
  mocks.toast.mockReset();
  mocks.sound.mockReset();
  permissionRequest.mockClear();
  root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(<Provider>app</Provider>);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function incoming(id = "one") {
  mocks.subscriptions.get("MessageLive")?.({
    data: {
      SenderId: 2,
      Message: { Principal: principal, RelayMessageId: id, SendTime: 10 },
    },
  });
}

async function display() {
  const done = new Promise<void>((resolve) => {
    shown = resolve;
  });
  await act(async () => {
    incoming();
    await vi.advanceTimersByTimeAsync(200);
    await done;
  });
  await vi.waitFor(() => expect(mocks.sound).toHaveBeenCalledTimes(1));
}

it("keeps the verified sender name and real decrypted message preview", async () => {
  await display();
  expect(alerts).toEqual([
    {
      title: "Verified sender",
      options: expect.objectContaining({
        body: "decrypted preview",
        silent: true,
      }),
    },
  ]);
  expect(mocks.send).toHaveBeenCalledWith("MessageGet", {
    Principal: principal,
    RelayMessageId: "one",
  });
});

it("keeps a browser alert pending when the tab becomes hidden during debounce", async () => {
  const done = new Promise<void>((resolve) => {
    shown = resolve;
  });
  await act(async () => {
    incoming();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
    await done;
  });
  expect(alerts[0].options.body).toBe("decrypted preview");
});

it("does not cache a hidden undecided permission result or ignore a later permission grant", async () => {
  permission = "default";
  await act(async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    incoming("hidden-undecided");
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(permissionRequest).not.toHaveBeenCalled();
  expect(alerts).toEqual([]);
  await act(async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    incoming("visible-prompt");
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(permissionRequest).toHaveBeenCalledTimes(1);
  permission = "granted";
  const shownAfterGrant = new Promise<void>((resolve) => {
    shown = resolve;
  });
  await act(async () => {
    incoming("after-grant");
    await vi.advanceTimersByTimeAsync(200);
    await shownAfterGrant;
  });
  expect(alerts[0].options.body).toBe("decrypted preview");
  expect(permissionRequest).toHaveBeenCalledTimes(1);
});

it("does not turn a suppressed historical delivery into a fresh notification", async () => {
  await act(async () => {
    mocks.subscriptions.get("MessageLive")?.({
      data: {
        suppressNotification: true,
        SenderId: 2,
        Message: {
          Principal: principal,
          RelayMessageId: "historical",
          SendTime: 1,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(mocks.send).not.toHaveBeenCalled();
  expect(alerts).toEqual([]);
  expect(mocks.sound).not.toHaveBeenCalled();
});
it("shows a generic alert instead of losing a message when its key lookup fails", async () => {
  mocks.secret.mockRejectedValue(new Error("key unavailable"));
  await display();
  expect(alerts[0].options.body).toBe("New encrypted message");
});
it("rechecks the viewed conversation after asynchronous preparation", async () => {
  let finish!: (value: { Principal: string; Display: string }) => void;
  mocks.presentation.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => {
    incoming();
    await vi.advanceTimersByTimeAsync(200);
  });
  mocks.path = "/chat";
  mocks.userId = 2;
  mocks.contacts = [
    { UserId: 2, Principal: principal, notifications: 0, LastMessageAt: 10 },
  ];
  await act(async () => {
    root.render(<Provider>app</Provider>);
  });
  await act(async () => {
    finish({ Principal: principal, Display: "Verified sender" });
  });
  expect(alerts).toEqual([]);
  expect(mocks.sound).not.toHaveBeenCalled();
});
it("drops stale account preparation and does not notify merely because cached state rerendered", async () => {
  let finish!: (value: { Principal: string; Display: string }) => void;
  mocks.presentation.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => {
    incoming();
    await vi.advanceTimersByTimeAsync(200);
  });
  mocks.account = "account-b";
  await act(async () => {
    root.render(<Provider>cached history</Provider>);
  });
  await act(async () => {
    finish({ Principal: principal, Display: "Old account sender" });
  });
  expect(alerts).toEqual([]);
  expect(mocks.sound).not.toHaveBeenCalled();
});
it("uses one native notification receipt across a foreground/background handoff", async () => {
  await act(async () => {
    root.render(null);
  });
  mocks.native = true;
  await act(async () => {
    root.render(<Provider>app</Provider>);
  });
  let finish!: (value: { Principal: string; Display: string }) => void;
  mocks.presentation.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => {
    mocks.nativeEvents.get("tensamin://notification")?.({
      payload: {
        account: mocks.account,
        signer: principal,
        relayId: "native-one",
        kind: "MessageSend",
        time: 10,
        order: 1,
      },
    });
    await vi.advanceTimersByTimeAsync(200);
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await act(async () => {
    finish({ Principal: principal, Display: "Verified sender" });
  });
  expect(mocks.invoke).toHaveBeenCalledWith(
    "mtp_set_notification_owner",
    expect.objectContaining({ account: "account-a", ready: false }),
  );
  expect(
    mocks.invoke.mock.calls.some(
      ([command]) => command === "mtp_post_message_notification",
    ),
  ).toBe(false);
  expect(alerts).toEqual([]);
  expect(mocks.toast).not.toHaveBeenCalled();
});

it("leaves native alert sounds to the platform instead of playing a second renderer sound", async () => {
  await act(async () => {
    root.render(null);
  });
  mocks.native = true;
  mocks.invoke.mockResolvedValue(true);
  await act(async () => {
    root.render(<Provider>app</Provider>);
  });
  await act(async () => {
    mocks.nativeEvents.get("tensamin://notification")?.({
      payload: {
        account: mocks.account,
        signer: principal,
        relayId: "native-sound",
        kind: "MessageSend",
        time: 10,
        order: 2,
      },
    });
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(mocks.invoke).toHaveBeenCalledWith(
    "mtp_post_message_notification",
    expect.objectContaining({ relayId: "native-sound" }),
  );
  expect(mocks.sound).not.toHaveBeenCalled();
});

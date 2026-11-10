// @vitest-environment jsdom
/// <reference types="node" />
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { act, useContext, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { clearDatabaseStore } from "@tensamin/shared/indexedDb";
import { setPlatformVisible } from "@tensamin/shared/focus";
import {
  subscribeNotificationHints,
  type NotificationHint,
} from "@tensamin/shared/notification";
import { MTPContext, type MTPContextType } from "./mtpContext";
import { RendererProvider } from "./rendererProvider";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  invoke: vi.fn(),
  load: vi.fn(),
  storageSubscribe: vi.fn(() => () => {}),
  events: new Map<string, (event: unknown) => void>(),
}));
vi.mock("mtp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("mtp")>()),
  MTPClient: { create: mocks.create },
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (type: string, callback: (event: unknown) => void) => {
    mocks.events.set(type, callback);

    return () => mocks.events.delete(type);
  },
}));
vi.mock("@tensamin/storage/context", () => ({
  useStorage: () => ({ load: mocks.load, subscribe: mocks.storageSubscribe }),
}));
vi.mock("@tensamin/shared/log", () => ({ log: vi.fn(), logMTP: vi.fn() }));
vi.mock("@nonanium/ui", () => ({
  toast: { dismiss: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

it("attaches to authenticated native transport without a native account snapshot, and catches up only when visible", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // JSDOM omits Node's structuredClone. CryptoKey is an opaque storage-boundary value here.
  vi.stubGlobal("structuredClone", (value: unknown) => value);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _name: string,
        _options: unknown,
        operation: () => Promise<unknown>,
      ) => operation(),
    },
  });
  setPlatformVisible(true);
  await clearDatabaseStore("cache");
  mocks.events.clear();
  mocks.load
    .mockReset()
    .mockRejectedValue(
      new Error(
        "Native attachment must not depend on renderer credential copies",
      ),
    );
  const nativeStatus = { generation: 7, readyState: 2, identified: true };
  mocks.invoke.mockImplementation(async (command) => {
    if (command === "mtp_restore_credentials") return true;

    if (command === "mtp_has_credentials") return true;

    if (command === "mtp_refresh_identity") return;

    if (command === "mtp_credential_metadata")
      return {
        userId: 1,
        omegaUrl: "https://omega.example/",
        credentialSha256: "c".repeat(64),
      };

    if (command === "mtp_frontend_options")
      return { url: "https://native.example", hostPublicKey: [1, 2, 3] };

    if (command === "mtp_status") return nativeStatus;

    if (command === "mtp_pending_calls") return [];

    if (command === "mtp_dismiss_call_invite") return;

    if (command === "mtp_call_invite_handled") return true;

    if (command === "mtp_set_ui_visible") return;

    if (command === "plugin:mtp|mtp_set_background_enabled") return;

    throw new Error(`Obsolete native application state command: ${command}`);
  });
  const scope = {
    principal: { authority: "omega-key:" + "a".repeat(64), user_id: 1 },
    device_id: "123",
    authorization_generation: 1,
    schema: "tensamin-account-sync:v1",
    dictionary: "b".repeat(64),
  };
  const operations: string[] = [];
  const connect = vi.fn(async () => {});
  const request = vi.fn(async (type: string, data: { Json?: Uint8Array }) => {
    operations.push(type);

    if (type === "GetChats")
      return { type, data: { Calls: [], PresenceSnapshotComplete: false } };

    if (type === "GetCommunities") return { type, data: { Communities: [] } };

    if (type !== "AccountStateRequest")
      throw new Error(`Unexpected metadata request: ${type}`);
    const operation = JSON.parse(new TextDecoder().decode(data.Json));

    if (operation.operation === "discover") {
      scope.device_id = operation.device_id;

      return { type: "AccountStateSnapshot", data: { state: "scope", scope } };
    }

    if (operation.operation === "snapshot")
      return {
        type: "AccountStateSnapshot",
        data: {
          state: "snapshot",
          scope,
          head: 0,
          floor: 0,
          page_id: "00000000-0000-4000-8000-000000000001",
          next: null,
          records: [],
        },
      };

    if (operation.operation === "delta")
      return {
        type: "AccountStateSnapshot",
        data: {
          state: "delta",
          scope,
          head: 0,
          floor: 0,
          page_id: "00000000-0000-4000-8000-000000000001",
          next: null,
          events: [],
        },
      };

    if (operation.operation === "acknowledge")
      return {
        type: "AccountStateSnapshot",
        data: { state: "acknowledged", cursor: operation.cursor },
      };

    throw new Error(
      `Unexpected synchronization operation: ${operation.operation}`,
    );
  });
  const subscriptions = new Map<string, (message: unknown) => void>();
  const callEvents: unknown[] = [];
  const client = {
    state: 2,
    dictionaryIdentity: { version: "1.1", fingerprint: scope.dictionary },
    connect,
    request,
    disconnect: vi.fn(() => {
      client.state = 0;
      subscriptions.clear();
    }),
    subscribe: vi.fn((type: string, handler: (message: unknown) => void) => {
      subscriptions.set(type, handler);

      return () => {
        if (subscriptions.get(type) === handler) subscriptions.delete(type);
      };
    }),
  };
  connect.mockImplementation(async () => {
    client.state = 2;
  });
  mocks.create.mockReset().mockResolvedValue(client);
  let observed: MTPContextType | undefined;

  function Consumer() {
    const context = useContext(MTPContext)!;
    const { subscribe } = context;
    useEffect(() => {
      observed = context;
    }, [context]);
    useEffect(
      () =>
        subscribe("CallEnded", (message) => {
          callEvents.push(message);
        }),
      [subscribe],
    );

    return null;
  }

  const root = createRoot(document.createElement("div"));
  const hints: NotificationHint[] = [];
  const stopHints = subscribeNotificationHints((hint) => {
    hints.push(hint);
  });

  try {
    await act(async () => {
      root.render(
        <RendererProvider>
          <Consumer />
        </RendererProvider>,
      );
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(observed?.identified).toBe(true);
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeName: "mtp:credentials",
        url: "https://native.example",
      }),
    );
    expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("credentials");
    expect(operations).toEqual([]);
    expect(mocks.load).not.toHaveBeenCalled();
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(observed?.clientState?.callsAndCommunitiesLoaded).toBe(true);
    });
    expect(operations).toContain("AccountStateRequest");
    expect(operations).not.toContain("FileChangesGet");
    expect(operations).not.toContain("FileGetManifest");
    await observed!.dismissCallInvite("dismissed-call");
    expect(await observed!.isCallInviteHandled("dismissed-call")).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("mtp_dismiss_call_invite", {
      callId: "dismissed-call",
      generation: 7,
      credentialSha256: "c".repeat(64),
    });
    mocks.events.get("tensamin://notification")?.({
      payload: {
        account: JSON.stringify([
          scope.principal,
          scope.authorization_generation,
        ]),
        signer: JSON.stringify(scope.principal),
        relayId: "file-hint",
        kind: "FileShareOffered",
        time: 123,
        order: 4,
      },
    });
    expect(hints[hints.length - 1]).toMatchObject({
      relayId: "file-hint",
      time: 123,
      order: 4,
    });
    const ended = { type: "CallEnded", data: { CallId: "resumed-call" } };
    await act(async () => {
      subscriptions.get("CallEnded")?.(ended);
    });
    expect(callEvents).toEqual([ended]);
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(subscriptions.size).toBe(0);
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(subscriptions.has("CallEnded")).toBe(true);
    });
    await act(async () => {
      subscriptions.get("CallEnded")?.(ended);
    });
    expect(callEvents).toEqual([ended, ended]);
  } finally {
    stopHints();
    await act(async () => root.unmount());
  }
});

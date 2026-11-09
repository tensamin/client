// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { FilesProvider, useFiles } from "./filesRuntime";
import { setPlatformVisible } from "@tensamin/shared/focus";

const mocks = vi.hoisted(() => ({
  contextReady: true,
  identified: true,
  send: vi.fn(),
  relay: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  load: vi.fn(async () => "AQ=="),
  ownIota: vi.fn(),
  create: vi.fn(),
  resolve: vi.fn(async () => ({ publicKeys: [new Uint8Array([1])] })),
  client: { dictionaryIdentity: { version: "1", fingerprint: "a".repeat(64) } },
  scope: {
    principal: { authority: "omega-key:" + "a".repeat(64), user_id: 1 },
    dictionary: "a".repeat(64),
  },
}));
vi.mock("@tensamin/mtp", () => ({
  useMTP: () => ({
    accountKey: "test-files",
    clientState: { Scope: mocks.scope },
    client: mocks.client,
    contextReady: mocks.contextReady,
    identified: mocks.identified,
    send: mocks.send,
    sendSealedRelay: mocks.relay,
    subscribe: mocks.subscribe,
  }),
}));
vi.mock("@tensamin/storage/context", () => ({
  useStorage: () => ({ load: mocks.load }),
}));
vi.mock("@tensamin/identity/context", () => ({
  useUser: () => ({ getRelayIota: mocks.ownIota }),
}));
vi.mock("@tensamin/files/service", () => ({ createFileService: mocks.create }));
vi.mock("@tensamin/mtp/principalProof", () => ({
  createPrincipalProofResolver: () => mocks.resolve,
}));
vi.mock("@tensamin/mtp/principalRelay", () => ({
  createPrincipalRelaySender: () => mocks.relay,
}));
vi.mock("mtp", async (original) => ({
  ...(await original<typeof import("mtp")>()),
  crypto: { sha256: () => new Uint8Array(32) },
  raw: {
    WasmKeyring: {
      from_bytes: () => ({
        public_key_bundle: () => ({
          to_bytes: () => new Uint8Array([1]),
          free() {},
        }),
        free() {},
      }),
    },
  },
}));
afterEach(() => vi.unstubAllGlobals());

it("keeps the requested file runtime alive during a temporary native view detach", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  setPlatformVisible(true);
  mocks.create.mockReset().mockReturnValue({});
  mocks.contextReady = true;
  mocks.identified = true;
  let files: ReturnType<typeof useFiles> | undefined;
  function Consumer() {
    const current = useFiles();
    useEffect(() => {
      files = current;
    }, [current]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => {
      root.render(
        <FilesProvider>
          <Consumer />
        </FilesProvider>,
      );
    });
    expect(mocks.create).not.toHaveBeenCalled();
    await act(async () => {
      files!.start();
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(files?.service).toBeDefined();
    });
    const signal = mocks.create.mock.calls[0][0].signal as AbortSignal;
    const original = files!.service;
    mocks.contextReady = false;
    await act(async () => {
      setPlatformVisible(false);
      root.render(
        <FilesProvider>
          <Consumer />
        </FilesProvider>,
      );
    });
    expect(signal.aborted).toBe(false);
    expect(files?.service).toBe(original);
    mocks.contextReady = true;
    await act(async () => {
      setPlatformVisible(true);
      root.render(
        <FilesProvider>
          <Consumer />
        </FilesProvider>,
      );
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(files?.service).toBe(original);
    mocks.identified = false;
    await act(async () => {
      root.render(
        <FilesProvider>
          <Consumer />
        </FilesProvider>,
      );
    });
    expect(signal.aborted).toBe(true);
  } finally {
    await act(async () => root.unmount());
    setPlatformVisible(true);
  }
});

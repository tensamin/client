import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFileCommands } from "./commands";
import type { BoundSendFn } from "@tensamin/mtp";
import {
  clearDatabaseStore,
  getDatabaseEntry,
  setDatabaseEntry,
} from "@tensamin/shared/indexedDb";
import { encodeSecureValue } from "@tensamin/storage/secure";

beforeEach(async () => {
  await clearDatabaseStore("cache");
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _key: string,
        _options: unknown,
        action: () => Promise<unknown>,
      ) => action(),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
const controller = () => new AbortController();
const command = (
  accountKey: string,
  send: ReturnType<typeof vi.fn<BoundSendFn>>,
  signal = controller().signal,
) => createFileCommands({ accountKey, send: send as BoundSendFn, signal });

it("replays the original persisted mutation after a lost reply, without regenerating its bytes", async () => {
  const send = vi
    .fn<BoundSendFn>()
    .mockRejectedValueOnce(new Error("lost reply"))
    .mockResolvedValue({
      type: "FileFolderPut",
      data: { Json: '{"ok":true}' },
    });
  const first = command("account-a", send);
  await expect(
    first.run("folder", "FileFolderPut", async () => ({ nonce: "original" })),
  ).rejects.toThrow("lost reply");
  await expect(
    first.run("folder", "FileFolderPut", async () => ({
      nonce: "replacement",
    })),
  ).rejects.toThrow("pending");
  await command("account-a", send).resume("folder");
  expect(send.mock.calls.map((call) => call.slice(0, 2))).toEqual([
    ["FileFolderPut", { Json: '{"nonce":"original"}' }],
    ["FileFolderPut", { Json: '{"nonce":"original"}' }],
  ]);
  expect(await first.pending()).toEqual([]);
});

it("retains uncertain responses but clears a definitive authorization rejection", async () => {
  const uncertain = vi
    .fn<BoundSendFn>()
    .mockResolvedValue({ type: "ErrorInternal", data: {} });
  const first = command("account-a", uncertain);
  await expect(
    first.run("folder", "FileFolderDelete", async () => ({ id: "folder" })),
  ).rejects.toThrow();
  expect(await first.pending()).toHaveLength(1);
  const rejected = vi
    .fn<BoundSendFn>()
    .mockResolvedValue({ type: "ErrorNotAuthenticated", data: {} });
  await expect(
    command("account-a", rejected).resume("folder"),
  ).rejects.toThrow();
  expect(await first.pending()).toEqual([]);
});

it("does not send a transplanted encrypted command from another account", async () => {
  const send = vi.fn<BoundSendFn>();
  await setDatabaseEntry(
    "cache",
    "file-command:v1:account-b:folder",
    await encodeSecureValue({
      account_key: "account-a",
      resource: "folder",
      type: "FileFolderDelete",
      request: "{}",
      state: "ready",
    }),
  );
  await expect(command("account-b", send).resume("folder")).rejects.toThrow(
    "another scope",
  );
  expect(send).not.toHaveBeenCalled();
  expect(
    await getDatabaseEntry("cache", "file-command:v1:account-b:folder"),
  ).toBeDefined();
});

it("account cancellation keeps an uncertain released mutation recoverable", async () => {
  const active = controller();
  const send = vi.fn<BoundSendFn>().mockImplementationOnce(async () => {
    active.abort(new Error("account changed"));

    throw new Error("lost reply");
  });
  await expect(
    command("account-a", send, active.signal).run(
      "folder",
      "FileFolderDelete",
      async () => ({}),
    ),
  ).rejects.toThrow("account changed");
  expect(
    await getDatabaseEntry("cache", "file-command:v1:account-a:folder"),
  ).toBeDefined();
});

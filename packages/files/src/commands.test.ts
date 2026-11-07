import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BoundSendFn } from "@tensamin/mtp";
import { decodeSecureValue, isSecureEnvelope } from "@tensamin/storage/secure";
import { createFileCommands } from "./commands";

const database = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  write: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@tensamin/shared/indexedDb", () => ({
  getDatabaseEntry: async (store: string, key: string) =>
    database.values.get(`${store}:${key}`),
  getOrCreateDatabaseEntry: async (
    store: string,
    key: string,
    value: unknown,
  ) => {
    const id = `${store}:${key}`;
    if (!database.values.has(id)) database.values.set(id, value);
    return database.values.get(id);
  },
  setDatabaseEntry: async (store: string, key: string, value: unknown) => {
    await database.write();
    database.values.set(`${store}:${key}`, value);
  },
  deleteDatabaseEntry: async (store: string, key: string) => {
    await database.remove();
    database.values.delete(`${store}:${key}`);
  },
  listDatabaseEntries: async (store: string, prefix: string) =>
    [...database.values]
      .filter(([key]) => key.startsWith(`${store}:${prefix}`))
      .map(([key, value]) => [key.slice(store.length + 1), value]),
}));

const accountKey = "fixture-account-generation";
const resource = "folder:fixture-folder";
const storageKey = `cache:file-command:v1:${accountKey}:${resource}`;
const body = {
  folder_id: "fixture-folder",
  revision: 1n,
  encrypted_name: Uint8Array.of(1, 2, 255),
};
const response = { type: "FileFolderPut", data: { Json: '{"ok":true}' } };

function setup() {
  const controller = new AbortController();
  const send = vi.fn<
    (type: string, data: { Json: string }) => Promise<typeof response>
  >(async () => response);
  const commands = createFileCommands({
    accountKey,
    send: send as unknown as BoundSendFn,
    signal: controller.signal,
  });
  return { commands, send, controller };
}
beforeEach(() => {
  for (const key of database.values.keys())
    if (key.startsWith("cache:")) database.values.delete(key);
  database.write.mockReset();
  database.remove.mockReset();
  vi.stubGlobal("indexedDB", {});
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _key: string,
        _options: unknown,
        operation: () => Promise<unknown>,
      ) => operation(),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("persists the exact encrypted mutation body before sending", async () => {
  const { commands, send } = setup();
  send.mockImplementationOnce(async (type, request) => {
    const stored = database.values.get(storageKey);
    expect(isSecureEnvelope(stored)).toBe(true);
    expect(await decodeSecureValue(stored)).toMatchObject({
      account_key: accountKey,
      resource,
      type,
      request: request.Json,
      state: "ready",
    });
    expect(request.Json).toBe(
      '{"folder_id":"fixture-folder","revision":1,"encrypted_name":[1,2,255]}',
    );
    return response;
  });
  await commands.run(resource, "FileFolderPut", async () => body);
  expect(database.values.has(storageKey)).toBe(false);
});

it("replays identical ciphertext after a lost reply and blocks replacement nonce generation", async () => {
  const first = setup();
  first.send.mockRejectedValueOnce(new Error("Reply lost"));
  await expect(
    first.commands.run(resource, "FileFolderPut", async () => body),
  ).rejects.toThrow("Reply lost");
  expect(await first.commands.pending()).toEqual([
    { resource, type: "FileFolderPut", state: "ready" },
  ]);
  const restored = setup();
  const prepare = vi.fn(async () => body);
  await expect(
    restored.commands.run(resource, "FileFolderPut", prepare),
  ).rejects.toThrow("pending file command");
  expect(prepare).not.toHaveBeenCalled();
  await restored.commands.resume(resource);
  expect(restored.send.mock.calls[0]).toEqual(first.send.mock.calls[0]);
  expect(database.values.has(storageKey)).toBe(false);
});

it("resumes acknowledged cleanup without sending the mutation again", async () => {
  const first = setup();
  database.remove.mockRejectedValueOnce(new Error("Cleanup interrupted"));
  await expect(
    first.commands.run(resource, "FileFolderPut", async () => body),
  ).rejects.toThrow("Cleanup interrupted");
  expect(
    await decodeSecureValue(database.values.get(storageKey)),
  ).toMatchObject({ state: "completed" });
  const restored = setup();
  await restored.commands.resume(resource);
  expect(restored.send).not.toHaveBeenCalled();
  expect(database.values.has(storageKey)).toBe(false);
});

it("does not send without persistence and fences account cancellation after persistence", async () => {
  const unavailable = setup();
  database.write.mockRejectedValueOnce(new Error("Storage unavailable"));
  await expect(
    unavailable.commands.run(resource, "FileFolderPut", async () => body),
  ).rejects.toThrow("Storage unavailable");
  expect(unavailable.send).not.toHaveBeenCalled();
  const cancelled = setup();
  database.write.mockImplementationOnce(async () =>
    cancelled.controller.abort(new Error("Account replaced")),
  );
  await expect(
    cancelled.commands.run(resource, "FileFolderPut", async () => body),
  ).rejects.toThrow("Account replaced");
  expect(cancelled.send).not.toHaveBeenCalled();
  expect(database.values.has(storageKey)).toBe(true);
});

it("refuses relocated intent records and retains contradictory acknowledgements", async () => {
  const first = setup();
  first.send.mockResolvedValueOnce({
    type: "FileFolderPut",
    data: { Json: '{"ok":false}' },
  });
  await expect(
    first.commands.run(resource, "FileFolderPut", async () => body),
  ).rejects.toThrow();
  const stored = database.values.get(storageKey);
  database.values.delete(storageKey);
  database.values.set(`${storageKey}:other`, stored);
  const restored = setup();
  await expect(restored.commands.resume(`${resource}:other`)).rejects.toThrow(
    "another scope or resource",
  );
  expect(restored.send).not.toHaveBeenCalled();
});

it("retains unknown state and clears only a resolved or superseded intent without replaying it", async () => {
  for (const outcome of ["resolved", "superseded"] as const) {
    const first = setup();
    first.send.mockRejectedValueOnce(new Error("Reply lost"));
    await expect(
      first.commands.run(resource, "FileFolderPut", async () => body),
    ).rejects.toThrow("Reply lost");
    const restored = setup();
    const inspect = vi.fn(async () => "unknown" as const);
    await expect(
      restored.commands.reconcile(resource, inspect),
    ).resolves.toEqual({ type: "FileFolderPut", outcome: "unknown" });
    expect(database.values.has(storageKey)).toBe(true);
    await expect(
      restored.commands.reconcile(resource, async () => outcome),
    ).resolves.toEqual({ type: "FileFolderPut", outcome });
    expect(database.values.has(storageKey)).toBe(false);
    expect(restored.send).not.toHaveBeenCalled();
  }
});

it("preserves a superseded outcome across interrupted cleanup", async () => {
  const first = setup();
  first.send.mockRejectedValueOnce(new Error("Reply lost"));
  await expect(
    first.commands.run(resource, "FileFolderPut", async () => body),
  ).rejects.toThrow();
  database.remove.mockRejectedValueOnce(new Error("Cleanup interrupted"));
  await expect(
    first.commands.reconcile(resource, async () => "superseded"),
  ).rejects.toThrow("Cleanup interrupted");
  expect(
    await decodeSecureValue(database.values.get(storageKey)),
  ).toMatchObject({ state: "superseded" });
  const restored = setup();
  await expect(restored.commands.resume(resource)).resolves.toEqual({
    type: "FileFolderPut",
    outcome: "superseded",
  });
  expect(restored.send).not.toHaveBeenCalled();
});

it("does not discard intent when state inspection fails or the account changes", async () => {
  const first = setup();
  first.send.mockRejectedValueOnce(new Error("Reply lost"));
  await expect(
    first.commands.run(resource, "FileFolderPut", async () => body),
  ).rejects.toThrow();
  const restored = setup();
  await expect(
    restored.commands.reconcile(resource, async () => {
      throw new Error("State unavailable");
    }),
  ).rejects.toThrow("State unavailable");
  expect(database.values.has(storageKey)).toBe(true);
  await expect(
    restored.commands.reconcile(resource, async () => {
      restored.controller.abort(new Error("Account replaced"));
      return "resolved";
    }),
  ).rejects.toThrow("Account replaced");
  expect(database.values.has(storageKey)).toBe(true);
  expect(restored.send).not.toHaveBeenCalled();
});

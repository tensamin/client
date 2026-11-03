import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { base64ToBytes, MTPProtocolError } from "mtp";
import { decodeSecureValue, isSecureEnvelope } from "@tensamin/storage/secure";
import { createPasswordMutations } from "./mutations";
import { PROTECTION_PURPOSE } from "../protection";

const database = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  write: vi.fn(),
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
    database.values.delete(`${store}:${key}`);
  },
}));

const binding = JSON.stringify([
  `omega-key:${"a".repeat(64)}#7`,
  11,
  "account-key",
  1,
]);
const storageKey = `cache:password-mutation:v1:${binding}`;
const command = Uint8Array.of(1, 2, 3, 4);
const digest = new Uint8Array(32).fill(7);
const response = {
  type: "PasswordEnrollmentStatus",
  id: 42,
  data: {},
  raw: new Uint8Array(),
};
const rpc: Parameters<typeof createPasswordMutations>[0]["rpc"] = {
  send: {
    receiverId: 11n,
    recipients: [],
    signaturePurpose: PROTECTION_PURPOSE.passwordManagementSignature,
    encryptionPurpose: PROTECTION_PURPOSE.passwordManagementEncryption,
    signatureSuite: "dual",
  },
  open: {
    recipient: { id: 7n, keyring: Uint8Array.of(1) },
    expectedSignerId: 11n,
    expectedReceiverId: 7n,
    resolveSignerPublicKeys: () => [],
    signaturePurpose: PROTECTION_PURPOSE.passwordResponseSignature,
    encryptionPurpose: PROTECTION_PURPOSE.passwordResponseEncryption,
    signaturePolicy: "dual",
  },
};

function setup(signal?: AbortSignal) {
  const opened = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    type: "PasswordEnrollmentStatus",
    data: { Enabled: true, Status: "committed", Sha256: digest },
  }));
  const send = vi.fn();
  const requestRaw = vi.fn(async () => response);
  const requestProtected = vi.fn(async (_type, _data, _options, request) => {
    await request.beforeSend(command);
    await send();
    return response;
  });
  const client = {
    dictionaryIdentity: { version: "1.1" },
    requestProtected,
    requestRaw,
    openProtected: opened,
    preparedRequestDigest: () => digest,
  } as unknown as Parameters<typeof createPasswordMutations>[0]["client"];
  const mutations = createPasswordMutations({
    client,
    binding,
    receiverId: 11n,
    rpc,
    signal,
  });
  return { client, mutations, opened, requestRaw, requestProtected, send };
}

beforeEach(() => {
  for (const key of database.values.keys())
    if (key.startsWith("cache:")) database.values.delete(key);
  database.write.mockReset();
  // The storage I/O is isolated, but the secure-value codec uses real WebCrypto.
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

it("keeps the exact command in a real encrypted envelope before transmission", async () => {
  const { mutations, send } = setup();
  send.mockImplementation(async () => {
    const stored = database.values.get(storageKey);
    expect(isSecureEnvelope(stored)).toBe(true);
    const pending = (await decodeSecureValue(stored)) as {
      command: string;
      digest: string;
      binding: string;
    };
    expect(base64ToBytes(pending.command)).toEqual(command);
    expect(base64ToBytes(pending.digest)).toEqual(digest);
    expect(pending.binding).toBe(binding);
    expect(JSON.stringify(stored)).not.toContain('"command"');
  });
  await expect(
    mutations.withLock(() => mutations.mutate("PasswordEnrollmentFinish", {})),
  ).resolves.toBe(true);
  expect(send).toHaveBeenCalledOnce();
  expect(database.values.has(storageKey)).toBe(false);
});

it("does not transmit when persistence fails", async () => {
  const { mutations, send } = setup();
  database.write.mockRejectedValueOnce(new Error("Storage unavailable"));
  await expect(
    mutations.mutate("PasswordEnrollmentFinish", {}),
  ).rejects.toThrow("Storage unavailable");
  expect(send).not.toHaveBeenCalled();
  expect(database.values.has(storageKey)).toBe(false);
});

it("reconciles a lost reply by querying the original command, not replaying its mutation", async () => {
  const { mutations, send, requestProtected } = setup();
  send.mockRejectedValueOnce(new Error("Reply lost"));
  await expect(
    mutations.mutate("PasswordEnrollmentFinish", {}),
  ).rejects.toThrow("Reply lost");
  expect(database.values.has(storageKey)).toBe(true);
  const restored = setup();
  await expect(
    restored.mutations.withLock(() => restored.mutations.reconcile()),
  ).resolves.toBe(true);
  expect(restored.requestRaw).toHaveBeenCalledExactlyOnceWith(
    "PasswordEnrollmentStatus",
    { SecurePayload: command, Version: "1.1" },
    { receiver: 11n, responseType: "PasswordEnrollmentStatus" },
  );
  expect(restored.requestProtected).not.toHaveBeenCalled();
  expect(requestProtected).toHaveBeenCalledOnce();
  expect(database.values.has(storageKey)).toBe(false);
});

it("retains unknown outcomes and refuses a new mutation", async () => {
  const first = setup();
  first.send.mockRejectedValueOnce(new Error("Reply lost"));
  await expect(
    first.mutations.mutate("PasswordEnrollmentFinish", {}),
  ).rejects.toThrow();
  const restored = setup();
  restored.opened.mockResolvedValueOnce({
    type: "ErrorInternal",
    data: { ErrorType: "unknown_outcome" },
  });
  await expect(restored.mutations.reconcile()).rejects.toBeInstanceOf(
    MTPProtocolError,
  );
  expect(database.values.has(storageKey)).toBe(true);
  await expect(
    restored.mutations.mutate("PasswordEnrollmentDisable", {}),
  ).rejects.toMatchObject({ code: "unknown_outcome" });
  expect(restored.requestProtected).not.toHaveBeenCalled();
});

it("does not accept an unrelated digest, contradictory result or invalid protected response", async () => {
  const first = setup();
  first.send.mockRejectedValueOnce(new Error("Reply lost"));
  await expect(
    first.mutations.mutate("PasswordEnrollmentFinish", {}),
  ).rejects.toThrow();
  for (const data of [
    { Enabled: true, Status: "committed", Sha256: new Uint8Array(32) },
    { Enabled: false, Status: "committed", Sha256: digest },
    { Enabled: true, Status: "unknown", Sha256: digest },
  ]) {
    const restored = setup();
    restored.opened.mockResolvedValueOnce({
      type: "PasswordEnrollmentStatus",
      data,
    });
    await expect(restored.mutations.reconcile()).rejects.toThrow();
    expect(database.values.has(storageKey)).toBe(true);
  }
  const restored = setup();
  restored.opened.mockRejectedValueOnce(new Error("Signature rejected"));
  await expect(restored.mutations.reconcile()).rejects.toThrow(
    "Signature rejected",
  );
  expect(database.values.has(storageKey)).toBe(true);
});

it("rejects a relocated encrypted intent and fences a cancelled account before sending", async () => {
  const first = setup();
  first.send.mockRejectedValueOnce(new Error("Reply lost"));
  await expect(
    first.mutations.mutate("PasswordEnrollmentFinish", {}),
  ).rejects.toThrow();
  const relocated = database.values.get(storageKey);
  database.values.delete(storageKey);
  const otherBinding = `${binding}:other-generation`;
  database.values.set(`cache:password-mutation:v1:${otherBinding}`, relocated);
  const restored = setup();
  const other = createPasswordMutations({
    client: restored.client,
    binding: otherBinding,
    receiverId: 11n,
    rpc,
  });
  await expect(other.reconcile()).rejects.toThrow("another scope");
  expect(restored.requestRaw).not.toHaveBeenCalled();
  const controller = new AbortController();
  const cancelled = setup(controller.signal);
  database.write.mockImplementationOnce(async () =>
    controller.abort(new Error("Account replaced")),
  );
  await expect(
    cancelled.mutations.mutate("PasswordEnrollmentFinish", {}),
  ).rejects.toThrow("Account replaced");
  expect(cancelled.send).not.toHaveBeenCalled();
  expect(database.values.has(storageKey)).toBe(false);
});

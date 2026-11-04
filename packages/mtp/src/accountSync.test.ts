import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncScope } from "@tensamin/shared/accountSync";

const database = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@tensamin/shared/indexedDb", () => ({
  getDatabaseEntry: async (store: string, key: string) =>
    structuredClone(database.get(`${store}:${key}`)),
  setDatabaseEntry: async (store: string, key: string, value: unknown) => {
    database.set(`${store}:${key}`, structuredClone(value));
  },
  getOrCreateDatabaseEntry: async (
    store: string,
    key: string,
    value: unknown,
  ) => {
    const id = `${store}:${key}`;
    if (!database.has(id)) database.set(id, structuredClone(value));
    return structuredClone(database.get(id));
  },
}));

const scope: SyncScope = {
  principal: { authority: `omega-key:${"a".repeat(64)}`, user_id: 7 },
  device_id: "device-one",
  authorization_generation: 3,
  schema: "tensamin-account-sync:v1",
  dictionary: "b".repeat(64),
};
const credential = {
  userId: 7,
  keyring: "AQID",
  deviceId: scope.device_id,
  omegaUrl: "https://omega.invalid/",
};

beforeEach(() => {
  vi.resetModules();
  database.clear();
  vi.stubGlobal("indexedDB", {});
  vi.stubGlobal("window", {});
});
afterEach(() => vi.unstubAllGlobals());

async function seed() {
  const cache = await import("./accountSync");
  const binding = await cache.accountCacheBinding(credential);
  await cache.persistAccountSnapshot(scope, 17, []);
  await cache.persistAccountScope(binding, scope);
  return { cache, binding };
}

describe("authoritative account runtime loading", () => {
  it("loads calls and communities separately from the durable account journal", async () => {
    const cache = await import("./accountSync");
    const state = cache.projectAccountState(scope, 17, []);
    const request = vi
      .fn<Parameters<typeof cache.loadAccountRuntime>[1]["request"]>()
      .mockResolvedValueOnce({
        type: "GetChats",
        data: {
          Calls: [
            {
              CallId: "call-one",
              OmikronId: 12,
              CallMembers: [7, 9],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        type: "GetCommunities",
        data: {
          Communities: [
            {
              CommunityAddress: "community-one",
              CommunityTitle: "A community",
              Position: "a0",
            },
          ],
        },
      });
    const loaded = await cache.loadAccountRuntime(state, {
      request: request as Parameters<
        typeof cache.loadAccountRuntime
      >[1]["request"],
    });
    expect(loaded.Calls).toHaveLength(1);
    expect(loaded.Communities[0].CommunityTitle).toBe("A community");
    expect(loaded.callsAndCommunitiesLoaded).toBe(true);
    expect(state.callsAndCommunitiesLoaded).toBe(false);
    expect(state.Calls).toEqual([]);
    expect(request.mock.calls.map(([type]) => type)).toEqual([
      "GetChats",
      "GetCommunities",
    ]);
    expect(database.size).toBe(0);
  });

  it("does not publish an empty successful replacement when an owner rejects a read", async () => {
    const cache = await import("./accountSync");
    const state = cache.projectAccountState(scope, 17, []);
    const request = vi
      .fn<Parameters<typeof cache.loadAccountRuntime>[1]["request"]>()
      .mockResolvedValueOnce({ type: "ErrorInternal", data: {} })
      .mockResolvedValueOnce({
        type: "GetCommunities",
        data: { Communities: [] },
      });
    await expect(
      cache.loadAccountRuntime(state, {
        request: request as Parameters<
          typeof cache.loadAccountRuntime
        >[1]["request"],
      }),
    ).rejects.toThrow("unavailable");
    expect(state.callsAndCommunitiesLoaded).toBe(false);
  });

  it("requires explicit authoritative arrays rather than defaulting omitted domains", async () => {
    const { mtp } = await import("@tensamin/shared/data");
    expect(mtp.GetChats.response.safeParse({}).success).toBe(false);
    expect(mtp.GetCommunities.response.safeParse({}).success).toBe(false);
    expect(mtp.GetChats.response.parse({ Calls: [] })).toEqual({ Calls: [] });
    expect(mtp.GetCommunities.response.parse({ Communities: [] })).toEqual({
      Communities: [],
    });
  });
});

describe("credential-bound offline account selection", () => {
  it("restores the last authenticated scope from durable encrypted storage after a fresh module lifetime", async () => {
    const { binding } = await seed();
    vi.resetModules();
    const cache = await import("./accountSync");
    const active = await cache.accountCacheBinding(credential);
    expect(active).toEqual(binding);
    const state = await cache.loadOfflineAccountState(active);
    expect(state).toMatchObject({
      Scope: scope,
      VersionNumber: 17,
      Contacts: [],
    });
    expect(
      [...database.keys()].filter((key) => key.includes("account-sync:")),
    ).toHaveLength(1);
  });

  it.each([
    { keyring: "BAUG" },
    { userId: 8 },
    { deviceId: "device-two" },
    { omegaUrl: "https://other-omega.invalid/" },
  ])(
    "does not select a cache for replaced credentials or namespace %j",
    async (replacement) => {
      const { cache } = await seed();
      const active = await cache.accountCacheBinding({
        ...credential,
        ...replacement,
      });
      await expect(cache.loadOfflineAccountState(active)).resolves.toBeNull();
    },
  );

  it("rejects a valid encrypted locator copied into another credential's index", async () => {
    const { cache } = await seed();
    const locator = [...database.entries()].find(([key]) =>
      key.includes("account-scope:v1:"),
    )!;
    const other = await cache.accountCacheBinding({
      ...credential,
      keyring: "BAUG",
    });
    database.set(`cache:account-scope:v1:${JSON.stringify(other)}`, locator[1]);
    await expect(cache.loadOfflineAccountState(other)).resolves.toBeNull();
  });

  it("does not persist an authenticated scope under a different account or device", async () => {
    const { cache, binding } = await seed();
    for (const different of [
      { ...scope, device_id: "other-device" },
      { ...scope, principal: { ...scope.principal, user_id: 8 } },
    ]) {
      await expect(
        cache.persistAccountScope(binding, different),
      ).rejects.toThrow("does not match");
    }
  });

  it("does not invent state after missing snapshots, corrupt ciphertext or a missing master key", async () => {
    const { cache, binding } = await seed();
    const snapshotKey = [...database.keys()].find((key) =>
      key.includes("account-sync:"),
    )!;
    const snapshot = database.get(snapshotKey);
    database.delete(snapshotKey);
    await expect(cache.loadOfflineAccountState(binding)).resolves.toBeNull();
    database.set(snapshotKey, snapshot);
    const locatorKey = [...database.keys()].find((key) =>
      key.includes("account-scope:v1:"),
    )!;
    const locator = database.get(locatorKey) as { data: string };
    database.set(locatorKey, { ...locator, data: "AAAA" });
    await expect(cache.loadOfflineAccountState(binding)).resolves.toBeNull();
    database.set(locatorKey, locator);
    database.delete("keys:master-v1");
    vi.resetModules();
    await expect(
      (await import("./accountSync")).loadOfflineAccountState(binding),
    ).resolves.toBeNull();
  });

  it("rejects plaintext locators and leaves recovery evidence unchanged", async () => {
    const { cache, binding } = await seed();
    const key = [...database.keys()].find((entry) =>
      entry.includes("account-scope:v1:"),
    )!;
    const plaintext = { binding, scope };
    database.set(key, plaintext);
    await expect(cache.loadOfflineAccountState(binding)).resolves.toBeNull();
    expect(database.get(key)).toEqual(plaintext);
  });
});

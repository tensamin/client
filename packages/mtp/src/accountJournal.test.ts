import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { SyncRecord, SyncScope } from "@tensamin/shared/accountSync";

const fixture = vi.hoisted(() => ({
  database: new Map<string, unknown>(),
  failCommit: false,
  largestRead: 0,
}));
vi.mock("@tensamin/shared/indexedDb", () => ({
  getDatabaseEntry: async (store: string, key: string) =>
    structuredClone(fixture.database.get(`${store}:${key}`)),
  getOrCreateDatabaseEntry: async (
    store: string,
    key: string,
    value: unknown,
  ) => {
    const id = `${store}:${key}`;
    if (!fixture.database.has(id))
      fixture.database.set(id, structuredClone(value));
    return structuredClone(fixture.database.get(id));
  },
  setDatabaseEntries: async (
    store: string,
    values: [string, unknown][],
    signal: AbortSignal,
    deleted: string[] = [],
  ) => {
    signal.throwIfAborted();
    if (fixture.failCommit) throw new Error("transaction refused");
    for (const [key, value] of values)
      fixture.database.set(`${store}:${key}`, structuredClone(value));
    for (const key of deleted) fixture.database.delete(`${store}:${key}`);
  },
  readDatabasePage: async (
    store: string,
    prefix: string,
    after: string | undefined,
    limit = 16,
  ) => {
    const page = [...fixture.database]
      .filter(
        ([key]) =>
          key.startsWith(`${store}:${prefix}`) &&
          (after === undefined || key > `${store}:${after}`),
      )
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, limit)
      .map(([key, value]) => [
        key.slice(store.length + 1),
        structuredClone(value),
      ]);
    fixture.largestRead = Math.max(fixture.largestRead, page.length);
    return page;
  },
  deleteDatabasePrefix: async (store: string, prefix: string) => {
    for (const key of fixture.database.keys())
      if (key.startsWith(`${store}:${prefix}`)) fixture.database.delete(key);
  },
}));

const scope: SyncScope = {
  principal: { authority: `omega-key:${"a".repeat(64)}`, user_id: 7 },
  device_id: "journal-device",
  authorization_generation: 3,
  schema: "tensamin-account-sync:v1",
  dictionary: "b".repeat(64),
};
const record = (id: number): SyncRecord => ({
  entity: "setting",
  key: String(id),
  value: { name: `private-setting-${id}`, payload: "private-profile" },
});
const signal = () => new AbortController().signal;

beforeEach(() => {
  vi.resetModules();
  fixture.database.clear();
  fixture.failCommit = false;
  fixture.largestRead = 0;
  vi.stubGlobal("indexedDB", {});
  vi.stubGlobal("window", {});
});
afterEach(() => vi.unstubAllGlobals());

describe("incremental encrypted account journal", () => {
  it("refuses a staging header transplanted into the active header slot", async () => {
    const { AccountJournal } = await import("./accountJournal");
    await AccountJournal.begin(scope, signal());
    const staged = [...fixture.database.entries()].find(
      ([key]) =>
        key.startsWith("cache:account-journal:v1:") && key.endsWith(":staging"),
    )!;
    fixture.database.set(staged[0].slice(0, -":staging".length), staged[1]);
    await expect(AccountJournal.load(scope)).rejects.toThrow("scope changed");
  });
  it("projects bounded incoming and outgoing previews without deleting durable history", async () => {
    const { AccountJournal } = await import("./accountJournal");
    const { projectAccountJournal, projectNativeAccountState } =
      await import("./accountSync");
    const journal = await AccountJournal.begin(scope, signal());
    const contact: SyncRecord = {
      entity: "contact",
      key: "1",
      value: {
        principal_handle: "42",
        principal_handle_identity: {
          authority: `omega-key:${"c".repeat(64)}`,
          user_id: 9,
        },
        last_message_at: "100",
        created_at: "0",
        notifications: "0",
      },
    };
    await journal.append([contact], signal());
    const messages: SyncRecord[] = Array.from({ length: 100 }, (_, index) => ({
      entity: "message",
      key: String(index),
      value: {
        external_principal: "42",
        content: "AQID",
        message_time: String(index),
        sent_by_self: index % 2 ? "1" : "0",
        message_state: "sent",
        key_version: "1",
        edited_count: "0",
        reactions: [],
      },
    }));
    await journal.append(messages, signal());
    await journal.commit(100, signal());
    const state = await projectAccountJournal(journal);
    expect(state.messageHistoryComplete).toBe(false);
    expect(state.Messages).toHaveLength(30);
    expect(state.Contacts[0].Messages).toEqual(state.Messages);
    expect(state.Messages[0].SenderId).toBe(7);
    expect(state.Messages[1].SenderId).toBe(42);
    expect(state.Messages[29].SendTime).toBe(70);
    expect(
      projectNativeAccountState({
        scope,
        head: 100,
        records: [contact, ...messages],
      }),
    ).toEqual(state);
    let durable = 0;
    for await (const record of journal.records("message")) {
      expect(record.entity).toBe("message");
      durable++;
    }
    expect(durable).toBe(100);
  });
  it("activates only a complete generation and reads encrypted records in bounded batches", async () => {
    const { AccountJournal } = await import("./accountJournal");
    const journal = await AccountJournal.begin(scope, signal());
    for (let page = 0; page < 4; page++)
      await journal.append(
        Array.from({ length: 128 }, (_, i) => record(page * 128 + i)),
        signal(),
      );
    expect(await AccountJournal.load(scope)).toBeNull();
    await journal.commit(19, signal());
    const loaded = (await AccountJournal.load(scope))!;
    let count = 0;
    for await (const value of loaded.records()) {
      expect(value.value.payload).toBe("private-profile");
      count++;
    }
    expect(count).toBe(512);
    expect(fixture.largestRead).toBeLessThanOrEqual(16);
    expect(loaded.head).toBe(19);
    expect(JSON.stringify([...fixture.database.values()])).not.toContain(
      "private-profile",
    );
    await expect(loaded.discard()).rejects.toThrow("active");
  });

  it("keeps the old committed winner after a failed replacement and cleans interrupted staging", async () => {
    const { AccountJournal } = await import("./accountJournal");
    const old = await AccountJournal.begin(scope, signal());
    await old.append([record(1)], signal());
    await old.commit(5, signal());
    const staged = await AccountJournal.begin(scope, signal());
    await staged.append([record(2)], signal());
    fixture.failCommit = true;
    await expect(staged.commit(9, signal())).rejects.toThrow("refused");
    fixture.failCommit = false;
    expect((await AccountJournal.load(scope))?.generation).toBe(old.generation);
    const replacement = await AccountJournal.begin(scope, signal());
    let orphanCount = 0;
    for await (const record of staged.records()) {
      expect(record.entity).toBe("setting");
      orphanCount++;
    }
    expect(orphanCount).toBe(0);
    await replacement.append([record(3)], signal());
    await replacement.commit(10, signal());
    // Simulate restart after activation but before explicit old-generation cleanup.
    await AccountJournal.load(scope);
    let retiredCount = 0;
    for await (const record of old.records()) {
      expect(record.entity).toBe("setting");
      retiredCount++;
    }
    expect(retiredCount).toBe(0);
    const records = [];
    for await (const value of (await AccountJournal.load(scope))!.records())
      records.push(value);
    expect(records).toEqual([record(3)]);
  });

  it("commits contiguous-page changes with their checkpoint and retains the final winner for repeated keys", async () => {
    const { AccountJournal } = await import("./accountJournal");
    const journal = await AccountJournal.begin(scope, signal());
    await journal.append([record(1), record(2)], signal());
    await journal.commit(5, signal());
    const changes = [
      { entity: "setting" as const, key: "1", record: record(1) },
      { entity: "setting" as const, key: "1", record: null },
      { entity: "setting" as const, key: "3", record: record(3) },
    ];
    fixture.failCommit = true;
    await expect(journal.apply(changes, 8, signal())).rejects.toThrow(
      "refused",
    );
    fixture.failCommit = false;
    expect((await AccountJournal.load(scope))?.head).toBe(5);
    await journal.apply(changes, 8, signal());
    const loaded = (await AccountJournal.load(scope))!;
    expect(loaded.head).toBe(8);
    const keys = [];
    for await (const value of loaded.records()) keys.push(value.key);
    expect(keys.sort()).toEqual(["2", "3"]);
  });

  it("rejects duplicate records, transplanted ciphertext and aborted writes", async () => {
    const { AccountJournal } = await import("./accountJournal");
    const journal = await AccountJournal.begin(scope, signal());
    await journal.append([record(1), record(2)], signal());
    await expect(journal.append([record(1)], signal())).rejects.toThrow(
      "Duplicate",
    );
    const aborted = new AbortController();
    aborted.abort();
    await expect(journal.append([record(3)], aborted.signal)).rejects.toThrow();
    await journal.commit(2, signal());
    const rows = [...fixture.database.entries()].filter(([key]) =>
      key.includes(":setting:"),
    );
    fixture.database.set(rows[1][0], rows[0][1]);
    await expect(
      (async () => {
        for await (const record of journal.records()) {
          expect(record.entity).toBe("setting");
        }
      })(),
    ).rejects.toThrow("binding");
  });
});

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { AccountJournal } from "./accountJournal";
import {
  clearDatabaseStore,
  getDatabaseEntry,
  listDatabaseEntries,
  setDatabaseEntry,
} from "@tensamin/shared/indexedDb";
import { decodeSecureValue, encodeSecureValue } from "@tensamin/storage/secure";
import type { SyncRecord, SyncScope } from "@tensamin/shared/accountSync";
import { encodePrincipal } from "@tensamin/shared/principal";
import { projectAccountJournal } from "./accountSync";

const authority = "omega-key:" + "a".repeat(64);
const owner = { authority, user_id: 1 };
const peer = { authority, user_id: 2 };
const other = { authority, user_id: 3 };
const scope: SyncScope = {
  principal: owner,
  device_id: "test-device",
  authorization_generation: 1,
  schema: "tensamin-account-sync:v1",
  dictionary: "a".repeat(64),
};
const signal = new AbortController().signal;
function message(key: string, principal = peer, content = "AQ=="): SyncRecord {
  return {
    entity: "message",
    key,
    value: {
      external_principal_identity: principal,
      external_principal: String(principal.user_id),
      relay_message_id: `relay-${key}`,
      relay_signer_principal_identity: principal,
      content,
      message_time: String(Number(key) || 1),
      history_deleted: "0",
      deleted_by_external: "0",
      sent_by_self: "0",
      message_state: "received",
      key_version: "1",
      edited_count: "0",
      reply_to: null,
      reactions: [],
    },
  };
}
async function collect(journal: AccountJournal, principal = peer) {
  const records: SyncRecord[] = [];
  for await (const record of journal.conversationRecords(
    encodePrincipal(principal),
  ))
    records.push(record);
  return records;
}
beforeEach(async () => {
  await clearDatabaseStore("cache");
});

describe("encrypted conversation journal", () => {
  it("retains the saved body through server pruning, metadata updates and snapshot replacement, but not explicit deletion", async () => {
    const journal = await AccountJournal.begin(scope, signal);
    const body = message("one");
    await journal.append([body], signal);
    await journal.commit(1, signal);
    const pruned: SyncRecord = {
      ...body,
      value: {
        ...body.value,
        history_deleted: "1",
        delivery_pruned: "1",
        content: undefined,
        message_state: "read",
      },
    };
    await journal.apply(
      [{ entity: "message", key: body.key, record: pruned }],
      2,
      signal,
    );
    expect((await collect(journal))[0].value).toMatchObject({
      content: "AQ==",
      message_state: "read",
      history_deleted: "0",
    });
    const replacement = await AccountJournal.begin(scope, signal);
    await replacement.append([pruned], signal);
    await replacement.commit(2, signal);
    expect((await collect(replacement))[0].value.content).toBe("AQ==");
    await replacement.apply(
      [{ entity: "message", key: body.key, record: null }],
      3,
      signal,
    );
    expect(await collect(replacement)).toEqual([]);
  });

  it("keeps an edit followed by pruning in the same page and never resurrects a deleted body", async () => {
    const journal = await AccountJournal.begin(scope, signal);
    await journal.append([message("one")], signal);
    await journal.commit(1, signal);
    const edited = {
      ...message("one", peer, "Ag=="),
      value: { ...message("one", peer, "Ag==").value, edited_count: "1" },
    };
    const pruned = {
      ...edited,
      value: {
        ...edited.value,
        history_deleted: "1",
        delivery_pruned: "1",
        content: undefined,
      },
    };
    await journal.apply(
      [
        { entity: "message", key: "one", record: edited },
        { entity: "message", key: "one", record: pruned },
      ],
      3,
      signal,
    );
    expect((await collect(journal))[0].value.content).toBe("Ag==");
    await journal.apply(
      [
        { entity: "message", key: "one", record: null },
        { entity: "message", key: "one", record: pruned },
      ],
      5,
      signal,
    );
    expect((await collect(journal))[0].value.content).toBeUndefined();
    expect((await projectAccountJournal(journal)).Messages).toEqual([]);
  });
  it("keeps the latest thirty undeleted messages for the selected conversation", async () => {
    const journal = await AccountJournal.begin(scope, signal);
    const contact: SyncRecord = {
      entity: "contact",
      key: encodePrincipal(peer),
      value: {
        principal_handle: "2",
        principal_handle_identity: peer,
        last_message_at: "40",
        created_at: "1",
        notifications: "0",
      },
    };
    await journal.append(
      [
        contact,
        ...Array.from({ length: 40 }, (_, index) => message(String(index + 1))),
      ],
      signal,
    );
    await journal.commit(40, signal);
    await journal.apply(
      [
        {
          entity: "message",
          key: "40",
          record: {
            ...message("40"),
            value: {
              ...message("40").value,
              history_deleted: "1",
              content: undefined,
            },
          },
        },
      ],
      41,
      signal,
    );
    const state = await projectAccountJournal(journal, encodePrincipal(peer));
    expect(
      state.Contacts[0].Messages.map((message) => message.SendTime),
    ).toEqual(Array.from({ length: 30 }, (_, index) => 39 - index));
  });
  it("reads no unrelated message ciphertext and keeps the index out of projection records", async () => {
    const journal = await AccountJournal.begin(scope, signal);
    await journal.append([message("mine"), message("other", other)], signal);
    await journal.commit(2, signal);
    const entries = await listDatabaseEntries("cache", "account-journal:v2:");
    for (const [key, stored] of entries) {
      const value = (await decodeSecureValue(stored)) as {
        record?: SyncRecord;
      };
      if (value.record?.key === "other")
        await setDatabaseEntry("cache", key, { corrupt: true });
    }
    expect((await collect(journal)).map((record) => record.key)).toEqual([
      "mine",
    ]);
    await expect(projectAccountJournal(journal)).rejects.toThrow(
      "not encrypted",
    );
  });

  it("updates and removes index entries atomically with the checkpoint", async () => {
    const journal = await AccountJournal.begin(scope, signal);
    await journal.append([message("one")], signal);
    await journal.commit(1, signal);
    await journal.apply(
      [
        {
          entity: "message",
          key: "one",
          record: message("one", other, "Ag=="),
        },
      ],
      2,
      signal,
    );
    expect(await collect(journal)).toEqual([]);
    expect((await collect(journal, other))[0].value.content).toBe("Ag==");
    expect((await AccountJournal.load(scope))?.head).toBe(2);
    await journal.apply(
      [{ entity: "message", key: "one", record: null }],
      3,
      signal,
    );
    expect(await collect(journal, other)).toEqual([]);
    expect((await AccountJournal.load(scope))?.head).toBe(3);
  });

  it("does not advance records, index or checkpoint after cancellation", async () => {
    const journal = await AccountJournal.begin(scope, signal);
    await journal.append([message("one")], signal);
    await journal.commit(1, signal);
    const controller = new AbortController();
    controller.abort(new Error("hidden"));
    await expect(
      journal.apply(
        [{ entity: "message", key: "one", record: null }],
        2,
        controller.signal,
      ),
    ).rejects.toThrow("hidden");
    expect((await collect(journal))[0].key).toBe("one");
    expect((await AccountJournal.load(scope))?.head).toBe(1);
  });

  it("rejects swapped index targets even when each envelope is valid", async () => {
    const journal = await AccountJournal.begin(scope, signal);
    await journal.append([message("one"), message("two", other)], signal);
    await journal.commit(2, signal);
    const entries = await listDatabaseEntries("cache", "account-journal:v2:");
    const indexes = entries.filter(([key]) => key.includes(":conversation:"));
    const decoded = await Promise.all(
      indexes.map(
        async ([key, stored]) =>
          [key, await decodeSecureValue(stored)] as const,
      ),
    );
    for (let index = 0; index < 2; index++) {
      const [key, value] = decoded[index];
      const replacement = {
        ...(value as object),
        target: (decoded[1 - index][1] as { target: string }).target,
      };
      await setDatabaseEntry(
        "cache",
        key,
        await encodeSecureValue(replacement),
      );
    }
    await expect(collect(journal, peer)).rejects.toThrow("target changed");
  });

  it("never exposes a partially staged snapshot or another account's index", async () => {
    const first = await AccountJournal.begin(scope, signal);
    await first.append([message("old")], signal);
    await first.commit(1, signal);
    const replacement = await AccountJournal.begin(scope, signal);
    await replacement.append([message("new")], signal);
    expect((await collect((await AccountJournal.load(scope))!))[0].key).toBe(
      "old",
    );
    await replacement.commit(2, signal);
    expect((await collect((await AccountJournal.load(scope))!))[0].key).toBe(
      "new",
    );
    expect(
      await AccountJournal.load({ ...scope, authorization_generation: 2 }),
    ).toBeNull();
    expect(await getDatabaseEntry("cache", "unrelated")).toBeUndefined();
  });
});

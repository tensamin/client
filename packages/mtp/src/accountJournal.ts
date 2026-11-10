import { z } from "zod";
import {
  syncRecord,
  syncScope,
  type SyncRecord,
  type SyncScope,
} from "@tensamin/shared/accountSync";
import {
  deleteDatabasePrefix,
  getDatabaseEntry,
  readDatabasePage,
  setDatabaseEntries,
} from "@tensamin/shared/indexedDb";
import {
  decodeSecureValue,
  encodeSecureValue,
  isSecureEnvelope,
} from "@tensamin/storage/secure";
import {
  encodePrincipal,
  principalSchema,
  parsePrincipal,
} from "@tensamin/shared/principal";

const header = z.strictObject({
  key: z.string(),
  scope: syncScope,
  generation: z.uuid(),
  head: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  retired_generation: z.uuid().optional(),
});

function headerKey(scope: SyncScope) {
  return `account-journal:v2:${JSON.stringify(syncScope.parse(scope))}`;
}

function prefix(scope: SyncScope, generation: string) {
  return `${headerKey(scope)}:${generation}:`;
}

async function recordKey(record: Pick<SyncRecord, "entity" | "key">) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([record.entity, record.key])),
  );

  return `${record.entity}:${[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function conversationPrefix(
  scope: SyncScope,
  generation: string,
  principal: string,
) {
  parsePrincipal(principal);

  return (
    prefix(scope, generation) +
    "conversation:" +
    (await recordKey({ entity: "message", key: principal })) +
    ":"
  );
}

async function messageIndexKey(
  scope: SyncScope,
  generation: string,
  record: SyncRecord,
) {
  if (record.entity !== "message") return null;
  const principal = encodePrincipal(
    principalSchema.parse(record.value.external_principal_identity),
  );

  return (
    (await conversationPrefix(scope, generation, principal)) +
    (await recordKey(record))
  );
}

function retainBody(record: SyncRecord, previous?: SyncRecord): SyncRecord {
  if (
    record.entity !== "message" ||
    record.value.delivery_pruned !== "1" ||
    record.value.history_deleted !== "1" ||
    typeof record.value.content === "string" ||
    record.value.deleted_by_external === "1" ||
    !previous ||
    previous.value.history_deleted === "1" ||
    previous.value.deleted_by_external === "1"
  )
    return record;
  const identity = [
    "relay_message_id",
    "relay_signer_principal_identity",
    "external_principal_identity",
    "key_version",
    "edited_count",
  ];

  if (
    typeof previous.value.relay_message_id !== "string" ||
    typeof previous.value.content !== "string" ||
    identity.some(
      (field) =>
        JSON.stringify(record.value[field]) !==
        JSON.stringify(previous.value[field]),
    )
  )
    return record;

  return {
    ...record,
    value: {
      ...record.value,
      history_deleted: "0",
      content: previous.value.content,
    },
  };
}

export class AccountJournal {
  readonly scope: SyncScope;
  readonly generation: string;
  head: number;
  private staging: boolean;

  private constructor(
    scope: SyncScope,
    generation: string,
    head: number,
    staging = false,
  ) {
    this.scope = scope;
    this.generation = generation;
    this.head = head;
    this.staging = staging;
  }

  static async load(scope: SyncScope) {
    const stored = await getDatabaseEntry("cache", headerKey(scope));

    if (stored === undefined) return null;
    let parsed: z.output<typeof header>;

    try {
      if (!isSecureEnvelope(stored)) return null;
      parsed = header.parse(await decodeSecureValue(stored));
    } catch {
      return null;
    }

    if (
      parsed.key !== headerKey(scope) ||
      JSON.stringify(parsed.scope) !== JSON.stringify(scope)
    )
      return null;

    if (parsed.retired_generation) {
      if (parsed.retired_generation === parsed.generation) return null;
      // Keep the cleanup identity in the committed header so a crash between activation and reclamation cannot orphan the previous generation.
      await deleteDatabasePrefix(
        "cache",
        prefix(scope, parsed.retired_generation),
      );
    }

    return new AccountJournal(scope, parsed.generation, parsed.head);
  }

  static async begin(scope: SyncScope, signal: AbortSignal) {
    scope = syncScope.parse(scope);
    const stagingKey = `${headerKey(scope)}:staging`;
    const active = await AccountJournal.load(scope);
    const generations = new Set<string>();
    const accountPrefix = `${headerKey(scope)}:`;
    let after: string | undefined;

    for (;;) {
      signal.throwIfAborted();
      const page = await readDatabasePage("cache", accountPrefix, after);

      if (!page.length) break;

      for (const [key] of page) {
        const generation = key.slice(accountPrefix.length).split(":")[0];

        if (
          z.uuid().safeParse(generation).success &&
          generation !== active?.generation
        )
          generations.add(generation);
      }

      after = page[page.length - 1][0];
    }

    for (const generation of generations) {
      signal.throwIfAborted();
      await deleteDatabasePrefix("cache", prefix(scope, generation));
    }

    const journal = new AccountJournal(scope, crypto.randomUUID(), 0, true);
    await setDatabaseEntries(
      "cache",
      [
        [
          stagingKey,
          await encodeSecureValue({
            key: stagingKey,
            scope,
            generation: journal.generation,
            head: 0,
          }),
        ],
      ],
      signal,
    );

    return journal;
  }

  async append(records: SyncRecord[], signal: AbortSignal) {
    if (!this.staging) throw new Error("No account snapshot is staged");

    if (
      records.length > 128 ||
      new TextEncoder().encode(JSON.stringify(records)).byteLength > 1024 * 1024
    )
      throw new Error("Account journal page is too large");
    const values: [string, unknown][] = [];
    const active = records.some(
      (record) => record.value.delivery_pruned === "1",
    )
      ? await AccountJournal.load(this.scope)
      : null;

    for (const input of records) {
      signal.throwIfAborted();
      let record = syncRecord.parse(input);

      if (record.value.delivery_pruned === "1" && active) {
        const oldKey =
          prefix(this.scope, active.generation) + (await recordKey(record));
        const old = await getDatabaseEntry("cache", oldKey);

        if (old !== undefined)
          record = retainBody(record, await active.decodeRecord(oldKey, old));
      }

      const key =
        prefix(this.scope, this.generation) + (await recordKey(record));

      if (
        (await getDatabaseEntry("cache", key)) !== undefined ||
        values.some(([existing]) => existing === key)
      )
        throw new Error("Duplicate account snapshot record");
      values.push([key, await encodeSecureValue({ key, record })]);
      const index = await messageIndexKey(this.scope, this.generation, record);

      if (index)
        values.push([
          index,
          await encodeSecureValue({ key: index, target: key }),
        ]);
    }

    await setDatabaseEntries("cache", values, signal);
  }

  async apply(
    changes: {
      entity: SyncRecord["entity"];
      key: string;
      record: SyncRecord | null;
    }[],
    sequence: number,
    signal: AbortSignal,
  ) {
    if (
      this.staging ||
      changes.length > 128 ||
      new TextEncoder().encode(JSON.stringify(changes)).byteLength >
        1024 * 1024 ||
      !Number.isSafeInteger(sequence) ||
      sequence < this.head
    )
      throw new Error("Invalid account journal delta");
    const winners = new Map<string, SyncRecord | null>();
    const previousIndexes = new Map<string, string>();

    for (const change of changes) {
      signal.throwIfAborted();
      const key =
        prefix(this.scope, this.generation) + (await recordKey(change));

      if (change.record) {
        syncRecord.parse(change.record);

        if (
          change.record.entity !== change.entity ||
          change.record.key !== change.key
        )
          throw new Error("Account delta key changed");
      }

      if (!winners.has(key)) {
        const stored = await getDatabaseEntry("cache", key);
        const old =
          stored === undefined ? null : await this.decodeRecord(key, stored);

        if (old) {
          const index = await messageIndexKey(this.scope, this.generation, old);

          if (index) previousIndexes.set(key, index);
        }

        winners.set(key, old);
      }

      winners.set(
        key,
        change.record
          ? retainBody(change.record, winners.get(key) ?? undefined)
          : null,
      );
    }

    const values: [string, unknown][] = [];
    const deleted: string[] = [];

    for (const [key, record] of winners) {
      signal.throwIfAborted();
      const previousIndex = previousIndexes.get(key);

      if (previousIndex) deleted.push(previousIndex);

      if (record) {
        values.push([key, await encodeSecureValue({ key, record })]);
        const index = await messageIndexKey(
          this.scope,
          this.generation,
          record,
        );

        if (index) {
          const stale = deleted.indexOf(index);

          if (stale !== -1) deleted.splice(stale, 1);
          values.push([
            index,
            await encodeSecureValue({ key: index, target: key }),
          ]);
        }
      } else deleted.push(key);
    }

    values.push([
      headerKey(this.scope),
      await encodeSecureValue({
        key: headerKey(this.scope),
        scope: this.scope,
        generation: this.generation,
        head: sequence,
      }),
    ]);
    await setDatabaseEntries("cache", values, signal, deleted);
    this.head = sequence;
  }

  async commit(head: number, signal: AbortSignal) {
    if (head < this.head)
      throw new Error("Account journal checkpoint moved backwards");
    const previous = this.staging
      ? await AccountJournal.load(this.scope)
      : null;
    const metadata = header.parse({
      key: headerKey(this.scope),
      scope: this.scope,
      generation: this.generation,
      head,
      retired_generation: previous?.generation,
    });
    await setDatabaseEntries(
      "cache",
      [[headerKey(this.scope), await encodeSecureValue(metadata)]],
      signal,
      this.staging ? [`${headerKey(this.scope)}:staging`] : [],
    );
    this.head = head;
    this.staging = false;
  }

  private async decodeRecord(key: string, stored: unknown) {
    if (!isSecureEnvelope(stored))
      throw new Error("Account journal record is not encrypted");
    const decoded = z
      .strictObject({ key: z.string(), record: syncRecord })
      .parse(await decodeSecureValue(stored));

    if (
      decoded.key !== key ||
      key !==
        prefix(this.scope, this.generation) + (await recordKey(decoded.record))
    )
      throw new Error("Account journal record binding changed");

    return decoded.record;
  }

  async *conversationRecords(
    principal: string,
    signal?: AbortSignal,
  ): AsyncGenerator<SyncRecord> {
    const keyPrefix = await conversationPrefix(
      this.scope,
      this.generation,
      principal,
    );
    let after: string | undefined;

    for (;;) {
      signal?.throwIfAborted();
      const page = await readDatabasePage("cache", keyPrefix, after);

      if (!page.length) return;

      for (const [key, stored] of page) {
        signal?.throwIfAborted();

        if (!isSecureEnvelope(stored))
          throw new Error("Account message index is not encrypted");
        const entry = z
          .strictObject({ key: z.string(), target: z.string() })
          .parse(await decodeSecureValue(stored));

        if (entry.key !== key)
          throw new Error("Account message index binding changed");
        const record = await this.decodeRecord(
          entry.target,
          await getDatabaseEntry("cache", entry.target),
        );

        if (
          (await messageIndexKey(this.scope, this.generation, record)) !== key
        )
          throw new Error("Account message index target changed");
        yield record;
      }

      after = page[page.length - 1][0];
    }
  }

  async *records(
    entity?: SyncRecord["entity"],
    signal?: AbortSignal,
  ): AsyncGenerator<SyncRecord> {
    const keyPrefix =
      prefix(this.scope, this.generation) + (entity ? `${entity}:` : "");
    let after: string | undefined;

    for (;;) {
      signal?.throwIfAborted();
      const page = await readDatabasePage("cache", keyPrefix, after);

      if (!page.length) return;

      for (const [key, stored] of page) {
        signal?.throwIfAborted();

        if (
          key.startsWith(prefix(this.scope, this.generation) + "conversation:")
        )
          continue;
        yield await this.decodeRecord(key, stored);
      }

      after = page[page.length - 1][0];
    }
  }

  async discard() {
    const active = await AccountJournal.load(this.scope);

    if (active?.generation === this.generation)
      throw new Error("Cannot discard the active account journal");
    await deleteDatabasePrefix("cache", prefix(this.scope, this.generation));
  }
}

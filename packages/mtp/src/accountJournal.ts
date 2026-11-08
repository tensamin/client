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

const header = z.strictObject({
  key: z.string(),
  scope: syncScope,
  generation: z.uuid(),
  head: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  retired_generation: z.uuid().optional(),
});

function headerKey(scope: SyncScope) {
  return `account-journal:v1:${JSON.stringify(syncScope.parse(scope))}`;
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
      // Keep the cleanup identity in the committed header so a crash between
      // activation and reclamation cannot orphan the previous generation.
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
    for (const record of records) {
      signal.throwIfAborted();
      syncRecord.parse(record);
      const key =
        prefix(this.scope, this.generation) + (await recordKey(record));
      if (
        (await getDatabaseEntry("cache", key)) !== undefined ||
        values.some(([existing]) => existing === key)
      )
        throw new Error("Duplicate account snapshot record");
      values.push([key, await encodeSecureValue({ key, record })]);
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
    for (const change of changes) {
      const key =
        prefix(this.scope, this.generation) + (await recordKey(change));
      winners.set(key, change.record);
    }
    const values: [string, unknown][] = [];
    const deleted: string[] = [];
    for (const [key, record] of winners) {
      signal.throwIfAborted();
      if (record) {
        syncRecord.parse(record);
        if (
          key !==
          prefix(this.scope, this.generation) + (await recordKey(record))
        )
          throw new Error("Account delta key changed");
        values.push([key, await encodeSecureValue({ key, record })]);
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

  async *records(entity?: SyncRecord["entity"]): AsyncGenerator<SyncRecord> {
    const keyPrefix =
      prefix(this.scope, this.generation) + (entity ? `${entity}:` : "");
    let after: string | undefined;
    for (;;) {
      const page = await readDatabasePage("cache", keyPrefix, after);
      if (!page.length) return;
      for (const [key, stored] of page) {
        if (!isSecureEnvelope(stored))
          throw new Error("Account journal record is not encrypted");
        const decoded = z
          .strictObject({ key: z.string(), record: syncRecord })
          .parse(await decodeSecureValue(stored));
        if (
          decoded.key !== key ||
          key !==
            prefix(this.scope, this.generation) +
              (await recordKey(decoded.record))
        )
          throw new Error("Account journal record binding changed");
        yield decoded.record;
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

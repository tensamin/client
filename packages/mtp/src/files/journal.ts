import { z } from "zod";
import {
  deriveChatId,
  encodePrincipal,
  wirePrincipalSchema,
  type WirePrincipal,
} from "@tensamin/shared/principal";
import { parseExactJson, stringifyExactJson } from "@tensamin/shared/exactJson";
import {
  getDatabaseEntry,
  setDatabaseEntries,
} from "@tensamin/shared/indexedDb";
import {
  decodeSecureValue,
  encodeSecureValue,
  isSecureEnvelope,
} from "@tensamin/storage/secure";
import {
  fileKeySchema,
  type FileKey,
  type FileAuthor,
} from "@tensamin/crypto/file";
import {
  fileFolderContextSchema,
  filePlacementContextSchema,
} from "@tensamin/crypto/fileMetadata";
import {
  verifyFileShareOffer,
  verifyFileShareRevoke,
} from "@tensamin/crypto/fileSharing";
import {
  fileBytes,
  wireFileManifest,
  wireFileShareOffer,
  wireFileShareRevoke,
} from "./protocol";

const sequence = z
  .bigint()
  .nonnegative()
  .max((1n << 63n) - 1n);
const deletedEntry = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  expected_revision: sequence.refine((value) => value > 0n),
});
const event = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("folder"),
    payload: fileFolderContextSchema.extend({ encrypted_name: fileBytes }),
    sequence,
  }),
  z.strictObject({
    kind: z.literal("placement"),
    payload: filePlacementContextSchema.extend({
      encrypted_metadata: fileBytes,
    }),
    sequence,
  }),
  z.strictObject({
    kind: z.literal("folder_deleted"),
    payload: deletedEntry,
    sequence,
  }),
  z.strictObject({
    kind: z.literal("placement_deleted"),
    payload: deletedEntry,
    sequence,
  }),
  z.strictObject({
    kind: z.enum(["version", "key_envelope"]),
    payload: wireFileManifest,
    sequence,
  }),
  z.strictObject({
    kind: z.literal("metadata"),
    payload: z.strictObject({
      manifest: wireFileManifest,
      metadata_revision: sequence.refine((value) => value > 0n),
    }),
    sequence,
  }),
  z.strictObject({
    kind: z.literal("share_offered"),
    payload: wireFileShareOffer,
    sequence,
  }),
  z.strictObject({
    kind: z.literal("share_revoked"),
    payload: wireFileShareRevoke,
    sequence,
  }),
  z.strictObject({
    kind: z.literal("file_deleted"),
    payload: z.strictObject({
      origin: wirePrincipalSchema,
      file_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    }),
    sequence,
  }),
  z.strictObject({
    kind: z.enum([
      "replica_transferring",
      "replica_cancelled",
      "replica_ready",
      "replica_failed",
      "replica_expired",
    ]),
    payload: fileKeySchema,
    sequence,
  }),
]);

export const fileChangesPageSchema = z.strictObject({
  events: z.array(event).max(64),
  next: sequence,
  upper: sequence,
  more: z.boolean(),
});
const checkpointSchema = z.strictObject({
  after: sequence,
  upper: sequence.nullable(),
});

export function createFileJournal({
  accountKey,
  account,
  signal,
  fetch,
  resolveAuthor,
}: {
  accountKey: string;
  account: WirePrincipal;
  signal: AbortSignal;
  fetch: (
    after: bigint,
    upper: bigint | null,
  ) => Promise<z.output<typeof fileChangesPageSchema>>;
  resolveAuthor: (
    principal: WirePrincipal,
    signingPublicKey?: string,
  ) => Promise<FileAuthor>;
}) {
  // Version 2 also commits the per-file latest-version index. Replaying the
  // durable server journal initializes it without trusting an older cursor.
  const prefix = `file-journal:v2:${accountKey}:`;
  const checkpointKey = `${prefix}cursor`;
  const latestKey = (origin: WirePrincipal, fileId: string) =>
    `${prefix}latest:${stringifyExactJson([wirePrincipalSchema.parse(origin), fileKeySchema.shape.file_id.parse(fileId)])}`;
  const grantId = (key: FileKey, recipient: WirePrincipal, chatId: string) =>
    `${prefix}grant:${stringifyExactJson([fileKeySchema.parse(key), wirePrincipalSchema.parse(recipient), chatId])}`;

  async function read(key: string) {
    const stored = await getDatabaseEntry("cache", key);
    if (stored === undefined) return undefined;
    if (!isSecureEnvelope(stored))
      throw new Error("File journal is not protected");
    const record = z
      .strictObject({
        account_key: z.string(),
        key: z.string(),
        text: z.string(),
      })
      .parse(await decodeSecureValue(stored));
    if (record.account_key !== accountKey || record.key !== key)
      throw new Error("File journal record belongs to another scope");
    return record.text;
  }

  function versionReference(
    text: string,
    origin: WirePrincipal,
    fileId: string,
  ) {
    const key = fileKeySchema.parse(parseExactJson(text));
    if (
      encodePrincipal(key.origin) !== encodePrincipal(origin) ||
      key.file_id !== fileId
    )
      throw new Error("File version index belongs to another resource");
    return key;
  }

  let synchronizing: Promise<bigint> | undefined;
  function synchronize() {
    signal.throwIfAborted();
    synchronizing ??= synchronizeLocked().finally(() => {
      synchronizing = undefined;
    });
    return synchronizing;
  }

  async function synchronizeLocked() {
    signal.throwIfAborted();
    if (!navigator.locks)
      throw new Error("File synchronization requires Web Locks");
    return navigator.locks.request(checkpointKey, { signal }, async () => {
      const stored = await read(checkpointKey);
      let checkpoint =
        stored === undefined
          ? { after: 0n, upper: null }
          : checkpointSchema.parse(parseExactJson(stored));
      for (;;) {
        signal.throwIfAborted();
        const page = await fetch(checkpoint.after, checkpoint.upper);
        if (
          page.upper < checkpoint.after ||
          (checkpoint.upper !== null && page.upper !== checkpoint.upper)
        )
          throw new Error("File journal boundary changed");
        let after = checkpoint.after;
        const updates = new Map<string, string>();
        for (const item of page.events) {
          if (item.sequence <= after || item.sequence > page.upper)
            throw new Error("File journal is out of order");
          after = item.sequence;
          let key: string;
          if (item.kind === "share_offered" || item.kind === "share_revoked") {
            const payload = item.payload;
            const file =
              item.kind === "share_offered"
                ? item.payload.manifest.key
                : item.payload.key;
            const recipient =
              item.kind === "share_offered"
                ? item.payload.manifest.envelope.recipient
                : item.payload.recipient;
            if (
              encodePrincipal(file.origin) !== encodePrincipal(account) &&
              encodePrincipal(recipient) !== encodePrincipal(account)
            )
              throw new Error("File journal share is outside this account");
            const author = await resolveAuthor(
              file.origin,
              payload.signing_public_key,
            );
            const expected = {
              author,
              recipient,
              chatId: deriveChatId(file.origin, recipient),
            };
            // Historical replay authenticates expired offers too. Live access
            // separately enforces expiry and the latest signed revision fence.
            if (item.kind === "share_offered")
              verifyFileShareOffer(item.payload, { ...expected, now: 0n });
            else verifyFileShareRevoke(item.payload, expected);
            key = grantId(file, recipient, payload.chat_id);
            const previous = updates.get(key) ?? (await read(key));
            if (previous !== undefined) {
              const old = event.parse(parseExactJson(previous));
              if (old.kind !== "share_offered" && old.kind !== "share_revoked")
                throw new Error("File grant fence is invalid");
              if (old.payload.grant_revision > payload.grant_revision) continue;
              if (
                old.payload.grant_revision === payload.grant_revision &&
                stringifyExactJson(old.payload) !== stringifyExactJson(payload)
              )
                throw new Error(
                  "File grant revision contains conflicting signed operations",
                );
            }
          } else if (item.kind === "folder" || item.kind === "folder_deleted") {
            key = `${prefix}folder:${item.kind === "folder" ? item.payload.folder_id : item.payload.id}`;
          } else if (
            item.kind === "placement" ||
            item.kind === "placement_deleted"
          ) {
            key = `${prefix}placement:${item.kind === "placement" ? item.payload.placement_id : item.payload.id}`;
          } else if (
            item.kind === "version" ||
            item.kind === "key_envelope" ||
            item.kind === "metadata"
          ) {
            const file =
              item.kind === "metadata"
                ? item.payload.manifest.key
                : item.payload.key;
            key = `${prefix}version:${stringifyExactJson(file)}`;
          } else if (item.kind === "file_deleted") {
            key = `${prefix}deleted:${stringifyExactJson(item.payload)}`;
          } else {
            key = `${prefix}replica:${stringifyExactJson(item.payload)}`;
          }
          updates.set(key, stringifyExactJson(item));
          const version =
            item.kind === "share_offered"
              ? item.payload.manifest.key
              : item.kind === "version" || item.kind === "key_envelope"
                ? item.payload.key
                : item.kind === "metadata"
                  ? item.payload.manifest.key
                  : undefined;
          if (version) {
            const indexKey = latestKey(version.origin, version.file_id);
            const previous = updates.get(indexKey) ?? (await read(indexKey));
            const old =
              previous === undefined
                ? undefined
                : versionReference(previous, version.origin, version.file_id);
            if (!old || old.version <= version.version)
              updates.set(indexKey, stringifyExactJson(version));
          }
        }
        if (
          page.next < after ||
          page.next > page.upper ||
          (page.more && (page.events.length === 0 || page.next !== after)) ||
          (!page.more && page.next !== page.upper)
        )
          throw new Error("File journal cursor does not match its page");
        checkpoint = { after: page.next, upper: page.more ? page.upper : null };
        updates.set(checkpointKey, stringifyExactJson(checkpoint));
        const encrypted = await Promise.all(
          [...updates].map(
            async ([key, value]) =>
              [
                key,
                await encodeSecureValue({
                  account_key: accountKey,
                  key,
                  text: value,
                }),
              ] as const,
          ),
        );
        await setDatabaseEntries("cache", encrypted, signal);
        if (!page.more) return checkpoint.after;
      }
    });
  }

  return {
    synchronize,
    async latestVersion(origin: WirePrincipal, fileId: string) {
      signal.throwIfAborted();
      const stored = await read(latestKey(origin, fileId));
      signal.throwIfAborted();
      if (stored === undefined) return undefined;
      return versionReference(stored, origin, fileId);
    },
    async deleted(origin: WirePrincipal, fileId: string) {
      origin = wirePrincipalSchema.parse(origin);
      fileId = fileKeySchema.shape.file_id.parse(fileId);
      signal.throwIfAborted();
      const stored = await read(
        `${prefix}deleted:${stringifyExactJson({ origin, file_id: fileId })}`,
      );
      signal.throwIfAborted();
      if (stored === undefined) return false;
      const value = event.parse(parseExactJson(stored));
      if (
        value.kind !== "file_deleted" ||
        encodePrincipal(value.payload.origin) !== encodePrincipal(origin) ||
        value.payload.file_id !== fileId
      )
        throw new Error("File deletion record belongs to another resource");
      return true;
    },
    async folder(id: string) {
      signal.throwIfAborted();
      const stored = await read(`${prefix}folder:${id}`);
      signal.throwIfAborted();
      if (stored === undefined) return undefined;
      const value = event.parse(parseExactJson(stored));
      if (value.kind !== "folder" && value.kind !== "folder_deleted")
        throw new Error("File folder journal record is invalid");
      return value;
    },
    async placement(id: string) {
      signal.throwIfAborted();
      const stored = await read(`${prefix}placement:${id}`);
      signal.throwIfAborted();
      if (stored === undefined) return undefined;
      const value = event.parse(parseExactJson(stored));
      if (value.kind !== "placement" && value.kind !== "placement_deleted")
        throw new Error("File placement journal record is invalid");
      return value;
    },
    async grant(key: FileKey, recipient: WirePrincipal) {
      signal.throwIfAborted();
      const stored = await read(
        grantId(key, recipient, deriveChatId(key.origin, recipient)),
      );
      signal.throwIfAborted();
      if (stored === undefined) return undefined;
      const value = event.parse(parseExactJson(stored));
      if (value.kind !== "share_offered" && value.kind !== "share_revoked")
        throw new Error("File grant fence is invalid");
      return value;
    },
  };
}

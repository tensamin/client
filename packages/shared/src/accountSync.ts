import { z } from "zod";
import { principalSchema } from "./principal";
import { getOrCreateDatabaseEntry } from "./indexedDb";

export const credentialMetadata = z.strictObject({
  userId: principalSchema.shape.user_id,
  omegaUrl: z.url(),
  credentialSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export async function getSyncDeviceId() {
  return z
    .uuid()
    .parse(
      await getOrCreateDatabaseEntry(
        "storage",
        "account-sync-device:v2",
        crypto.randomUUID(),
      ),
    );
}
export const ACCOUNT_MESSAGE_PREVIEW_LIMIT = 30;

export const syncScope = z.strictObject({
  principal: principalSchema,
  device_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_.:-]+$/),
  authorization_generation: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  schema: z.literal("tensamin-account-sync:v1"),
  dictionary: z.string().regex(/^[a-f0-9]{64}$/),
});

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pageToken = z.strictObject({ id: z.uuid(), offset: sequence });
export const syncRecord = z.strictObject({
  entity: z.enum([
    "message",
    "contact",
    "setting",
    "user_blob",
    "user_asset",
    "chat_secret",
    "blocked_user",
    "receipt_policy",
    "message_storage_policy",
  ]),
  key: z.string(),
  value: z.record(z.string(), z.unknown()),
});
export const syncEvent = z.strictObject({
  sequence,
  event_id: z.string().min(1),
  entity: syncRecord.shape.entity,
  key: z.string(),
  operation: z.enum(["upsert", "delete"]),
  record: syncRecord.nullable(),
});
export const syncResponse = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("scope"), scope: syncScope }),
  z.strictObject({
    state: z.literal("snapshot"),
    scope: syncScope,
    head: sequence,
    floor: sequence,
    page_id: z.uuid(),
    next: pageToken.nullable(),
    records: z.array(syncRecord).max(128),
  }),
  z.strictObject({
    state: z.literal("delta"),
    scope: syncScope,
    head: sequence,
    floor: sequence,
    page_id: z.uuid(),
    next: pageToken.nullable(),
    events: z.array(syncEvent).max(128),
  }),
  z.strictObject({
    state: z.literal("acknowledged"),
    cursor: z.strictObject({ scope: syncScope, sequence }),
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    error: z.enum([
      "snapshot_required",
      "identity_changed",
      "retryable",
      "unauthorized",
      "invalid_request",
      "capacity",
    ]),
  }),
]);

export type SyncScope = z.infer<typeof syncScope>;
export type SyncRecord = z.infer<typeof syncRecord>;

import { z } from "zod";

export const syncScope = z.strictObject({
  principal: z.strictObject({
    authority: z
      .string()
      .regex(/^(omega-key:|authority:iota:v1:)[a-f0-9]{64}$/),
    user_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
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

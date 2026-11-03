import { z } from "zod";
import { parseExactJson, stringifyExactJson } from "@tensamin/shared/exactJson";
import { fileEnvelopeSchema, fileManifestSchema } from "@tensamin/crypto/file";
import {
  fileShareOfferSchema,
  fileShareRevokeSchema,
} from "@tensamin/crypto/fileSharing";
import {
  fileFolderContextSchema,
  filePlacementContextSchema,
} from "@tensamin/crypto/fileMetadata";

const byte = z.bigint().min(0n).max(255n).transform(Number);
export const fileBytes = z
  .array(byte)
  .max(16384)
  .transform((value) => new Uint8Array(value));
export const wireFileEnvelope = fileEnvelopeSchema
  .extend({ kem_ciphertext: fileBytes, encrypted_dek: fileBytes })
  .transform((value) => fileEnvelopeSchema.parse(value));
export const wireFileManifest = fileManifestSchema
  .extend({
    ciphertext_sha256: fileBytes,
    manifest_ciphertext: fileBytes,
    envelope: wireFileEnvelope,
  })
  .transform((value) => fileManifestSchema.parse(value));
export const wireFileShareOffer = fileShareOfferSchema
  .extend({ manifest: wireFileManifest, signature: fileBytes })
  .transform((value) => fileShareOfferSchema.parse(value));
export const wireFileShareRevoke = fileShareRevokeSchema
  .extend({ signature: fileBytes })
  .transform((value) => fileShareRevokeSchema.parse(value));

export const wireFileFolder = fileFolderContextSchema.extend({
  encrypted_name: fileBytes,
});
export const wireFilePlacement = filePlacementContextSchema.extend({
  encrypted_metadata: fileBytes,
});

export const fileManifestResponse = z.strictObject({
  manifest: wireFileManifest,
  proof: wireFileShareOffer.nullable(),
  metadata_revision: z
    .bigint()
    .min(1n)
    .max((1n << 63n) - 1n),
  asset_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .nullable(),
  state: z.enum(["pending", "ready", "transferring", "failed"]),
  transfer: z
    .strictObject({
      offset: z.bigint().nonnegative(),
      attempts: z.bigint().nonnegative(),
      error: z.string().nullable(),
      next_attempt_at: z.bigint().nonnegative(),
    })
    .nullable(),
  reserved_bytes: z.bigint().nonnegative(),
});

export function encodeFileRequest(value: unknown): string {
  const text = stringifyExactJson(value);
  if (new TextEncoder().encode(text).length > 192 * 1024)
    throw new Error("File request exceeds the control limit");
  return text;
}

export function decodeFileResponse<T>(text: string, schema: z.ZodType<T>): T {
  if (new TextEncoder().encode(text).length > 192 * 1024)
    throw new Error("File response exceeds the control limit");
  return schema.parse(parseExactJson(text));
}

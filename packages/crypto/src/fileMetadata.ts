import { crypto, raw } from "mtp";
import { z } from "zod";
import {
  wirePrincipalSchema,
  type WirePrincipal,
} from "@tensamin/shared/principal";
import { fileNameSchema } from "./file";
import { parseExactJson } from "@tensamin/shared/exactJson";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = z
  .bigint()
  .min(1n)
  .max((1n << 63n) - 1n);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const fileFolderContextSchema = z.strictObject({
  folder_id: id,
  parent_folder_id: id,
  revision,
});

export const filePlacementContextSchema = z.strictObject({
  placement_id: id,
  origin: wirePrincipalSchema,
  file_id: id,
  folder_id: z.union([
    id,
    z.string().regex(/^chat:principal:[A-Za-z0-9_-]{1,1000}$/),
  ]),
  hidden: z.boolean(),
  revision,
});

const placementMetadata = z.strictObject({
  filename: fileNameSchema.optional(),
});

// The recoverable account keyring is the root, never a per-file DEK or a chat
// epoch. Domain separation keeps this key distinct from content and profile keys.
export function deriveFileAccountMetadataKey(
  keyring: Uint8Array,
  account: WirePrincipal,
): Uint8Array {
  account = wirePrincipalSchema.parse(account);
  const parsed = raw.WasmKeyring.from_bytes(keyring);
  try {
    const canonical = parsed.try_to_bytes();
    try {
      const context = encoder.encode(
        JSON.stringify([
          "tensamin-file-account-metadata-key-v1",
          account.authority,
          account.user_id.toString(),
        ]),
      );
      return crypto.deriveEncryptionKey(
        canonical,
        crypto.sha256(context),
        encoder.encode("tensamin-file-account-metadata-key-v1"),
      );
    } finally {
      canonical.fill(0);
    }
  } finally {
    parsed.free();
  }
}

function folderAad(
  account: WirePrincipal,
  context: z.output<typeof fileFolderContextSchema>,
) {
  account = wirePrincipalSchema.parse(account);
  context = fileFolderContextSchema.parse(context);
  return encoder.encode(
    JSON.stringify([
      "tensamin-file-folder-v1",
      account.authority,
      account.user_id.toString(),
      context.folder_id,
      context.parent_folder_id,
      context.revision.toString(),
    ]),
  );
}

function placementAad(
  account: WirePrincipal,
  context: z.output<typeof filePlacementContextSchema>,
) {
  account = wirePrincipalSchema.parse(account);
  context = filePlacementContextSchema.parse(context);
  return encoder.encode(
    JSON.stringify([
      "tensamin-file-placement-v1",
      account.authority,
      account.user_id.toString(),
      context.placement_id,
      context.origin.authority,
      context.origin.user_id.toString(),
      context.file_id,
      context.folder_id,
      context.hidden,
      context.revision.toString(),
    ]),
  );
}

function validateKey(key: Uint8Array) {
  if (key.length !== 32) throw new Error("Invalid account metadata key length");
}

export async function encryptFileFolderName({
  key,
  account,
  folder,
  name,
}: {
  key: Uint8Array;
  account: WirePrincipal;
  folder: z.output<typeof fileFolderContextSchema>;
  name: string;
}): Promise<Uint8Array> {
  validateKey(key);
  const plaintext = encoder.encode(fileNameSchema.parse(name));
  try {
    return await crypto.encrypt(key, plaintext, folderAad(account, folder));
  } finally {
    plaintext.fill(0);
  }
}

export async function decryptFileFolderName({
  key,
  account,
  folder,
  ciphertext,
}: {
  key: Uint8Array;
  account: WirePrincipal;
  folder: z.output<typeof fileFolderContextSchema>;
  ciphertext: Uint8Array;
}): Promise<string> {
  validateKey(key);
  if (ciphertext.length > 16384)
    throw new Error("Encrypted folder name is too large");
  const plaintext = await crypto.decrypt(
    key,
    ciphertext,
    folderAad(account, folder),
  );
  try {
    return fileNameSchema.parse(decoder.decode(plaintext));
  } finally {
    plaintext.fill(0);
  }
}

export async function encryptFilePlacementMetadata({
  key,
  account,
  placement,
  metadata,
}: {
  key: Uint8Array;
  account: WirePrincipal;
  placement: z.output<typeof filePlacementContextSchema>;
  metadata: z.output<typeof placementMetadata>;
}): Promise<Uint8Array> {
  validateKey(key);
  const plaintext = encoder.encode(
    JSON.stringify(placementMetadata.parse(metadata)),
  );
  try {
    return await crypto.encrypt(
      key,
      plaintext,
      placementAad(account, placement),
    );
  } finally {
    plaintext.fill(0);
  }
}

export async function decryptFilePlacementMetadata({
  key,
  account,
  placement,
  ciphertext,
}: {
  key: Uint8Array;
  account: WirePrincipal;
  placement: z.output<typeof filePlacementContextSchema>;
  ciphertext: Uint8Array;
}): Promise<z.output<typeof placementMetadata>> {
  validateKey(key);
  if (ciphertext.length > 16384)
    throw new Error("Encrypted placement metadata is too large");
  const plaintext = await crypto.decrypt(
    key,
    ciphertext,
    placementAad(account, placement),
  );
  try {
    const text = decoder.decode(plaintext);
    return placementMetadata.parse(parseExactJson(text));
  } finally {
    plaintext.fill(0);
  }
}

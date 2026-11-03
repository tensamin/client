import { sha256 } from "@noble/hashes/sha2.js";
import {
  encodePrincipal,
  wirePrincipalSchema,
  type WirePrincipal,
} from "@tensamin/shared/principal";
import { parseExactJson } from "@tensamin/shared/exactJson";
import { base64ToBytes, bytesToBase64, crypto, raw } from "mtp";
import { z } from "zod";

export const FILE_CHUNK_BYTES = 65536;
export const FILE_RECORD_BYTES = 24 + FILE_CHUNK_BYTES + 16;
const MAX_I64 = (1n << 63n) - 1n;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) <= MAX_I64);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

function containsControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export const fileKeySchema = z.strictObject({
  origin: wirePrincipalSchema,
  file_id: identifier,
  version: z.bigint().min(1n).max(MAX_I64),
});

export const fileEnvelopeSchema = z.strictObject({
  recipient: wirePrincipalSchema,
  key_id: identifier,
  wrapping_scheme: z.literal("tensamin-file-dek-kem-v1"),
  kem_ciphertext: z
    .instanceof(Uint8Array<ArrayBufferLike>)
    .refine((value) => value.length > 0 && value.length <= 4096),
  encrypted_dek: z
    .instanceof(Uint8Array<ArrayBufferLike>)
    .refine((value) => value.length === 72),
});

export const fileManifestSchema = z.strictObject({
  key: fileKeySchema,
  ciphertext_sha256: z
    .instanceof(Uint8Array<ArrayBufferLike>)
    .refine((value) => value.length === 32),
  ciphertext_size: z
    .bigint()
    .min(1n)
    .max(MAX_I64)
    .refine((value) => value % BigInt(FILE_RECORD_BYTES) === 0n),
  crypto_format: z.literal("tensamin-file-chunks-v1"),
  manifest_ciphertext: z
    .instanceof(Uint8Array<ArrayBufferLike>)
    .refine((value) => value.length > 40 && value.length <= 16384),
  envelope: fileEnvelopeSchema,
});

export const fileNameSchema = z
  .string()
  .min(1)
  .refine(
    (name) =>
      encoder.encode(name).length <= 255 &&
      !containsControlCharacters(name) &&
      !/[/\\:*?"<>|]/.test(name) &&
      !/[. ]$/.test(name) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name),
  );

const metadataSchema = z.strictObject({
  filename: fileNameSchema,
  mime_type: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => !containsControlCharacters(value)),
  plaintext_size: decimal,
  chunk_bytes: z.literal("65536"),
  chunk_count: decimal.refine((value) => BigInt(value) > 0n),
  plaintext_sha256: digest.optional(),
  created_at: decimal.optional(),
  updated_at: decimal.optional(),
});

const signedMetadataSchema = metadataSchema.extend({
  ciphertext_sha256: digest,
  dek_commitment: digest,
  owner_signing_key_id: digest,
  owner_signature: z.base64(),
});

export type FileKey = z.output<typeof fileKeySchema>;
export type FileEnvelope = z.output<typeof fileEnvelopeSchema>;
export type FileManifest = z.output<typeof fileManifestSchema>;
export type FileMetadata = z.output<typeof metadataSchema>;
export type FileAuthor = {
  principal: WirePrincipal;
  publicKeys: readonly Uint8Array[];
};

// Writes must consume/copy their input before resolving and remain private until
// commit. The storage owner must also fence
// commit to its account generation. Aborted stages must never become exports.
export type FileStage = {
  write(chunk: Uint8Array): Promise<void>;
  commit(): Promise<void>;
  abort(): Promise<void>;
};

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function context(key: FileKey): Uint8Array {
  return encoder.encode(
    JSON.stringify([
      "tensamin-file-v1",
      key.origin.authority,
      key.origin.user_id.toString(),
      key.file_id,
      key.version.toString(),
    ]),
  );
}

function chunkContext(
  key: FileKey,
  index: bigint,
  metadata: FileMetadata,
): Uint8Array {
  return encoder.encode(
    JSON.stringify([
      "tensamin-file-chunk-v1",
      key.origin.authority,
      key.origin.user_id.toString(),
      key.file_id,
      key.version.toString(),
      index.toString(),
      metadata.plaintext_size,
      metadata.chunk_count,
    ]),
  );
}

function wrappingContext(
  key: FileKey,
  recipient: WirePrincipal,
  keyId: string,
): Uint8Array {
  return encoder.encode(
    JSON.stringify([
      "tensamin-file-dek-kem-v1",
      key.origin.authority,
      key.origin.user_id.toString(),
      key.file_id,
      key.version.toString(),
      recipient.authority,
      recipient.user_id.toString(),
      keyId,
    ]),
  );
}

function ownerProof(
  key: FileKey,
  metadata: Omit<z.output<typeof signedMetadataSchema>, "owner_signature">,
): Uint8Array {
  return encoder.encode(
    JSON.stringify([
      "tensamin-file-owner-v1",
      decoder.decode(context(key)),
      metadata.filename,
      metadata.mime_type,
      metadata.plaintext_size,
      metadata.chunk_bytes,
      metadata.chunk_count,
      metadata.plaintext_sha256 ?? null,
      metadata.created_at ?? null,
      metadata.updated_at ?? null,
      metadata.ciphertext_sha256,
      metadata.dek_commitment,
      metadata.owner_signing_key_id,
    ]),
  );
}

function contentKey(
  dek: Uint8Array,
  key: FileKey,
  purpose: "content" | "manifest",
): Uint8Array {
  if (dek.length !== 32) throw new Error("Invalid file key length");
  return crypto.deriveEncryptionKey(
    dek,
    crypto.sha256(context(key)),
    encoder.encode(`tensamin-file-${purpose}-v1`),
  );
}

function publicBundle(keyring: Uint8Array): Uint8Array {
  const keys = raw.WasmKeyring.from_bytes(keyring);
  try {
    const bundle = keys.public_key_bundle();
    try {
      return bundle.to_bytes();
    } finally {
      bundle.free();
    }
  } finally {
    keys.free();
  }
}

function validateLayout(metadata: FileMetadata, size: bigint) {
  const length = BigInt(metadata.plaintext_size);
  const expected = length === 0n ? 1n : (length + 65535n) / 65536n;
  if (
    size > MAX_I64 ||
    BigInt(metadata.chunk_count) !== expected ||
    size !== expected * BigInt(FILE_RECORD_BYTES)
  ) {
    throw new Error("File size and chunk count do not match");
  }
}

export async function wrapFileKey({
  key,
  dek,
  recipient,
  keyId,
  publicKey,
}: {
  key: FileKey;
  dek: Uint8Array;
  recipient: WirePrincipal;
  keyId: string;
  publicKey: Uint8Array;
}): Promise<FileEnvelope> {
  key = fileKeySchema.parse(key);
  recipient = wirePrincipalSchema.parse(recipient);
  identifier.parse(keyId);
  if (dek.length !== 32) throw new Error("Invalid file key length");
  const encapsulated = crypto.encapsulate(
    crypto.publicKeyBundleToKeys(publicKey).kemPublicKey,
  );
  const shared = encapsulated.shared_secret;
  try {
    const aad = wrappingContext(key, recipient, keyId);
    const wrappingKey = crypto.deriveEncryptionKey(
      shared,
      crypto.sha256(aad),
      encoder.encode("tensamin-file-dek-kem-v1"),
    );
    try {
      return fileEnvelopeSchema.parse({
        recipient,
        key_id: keyId,
        wrapping_scheme: "tensamin-file-dek-kem-v1",
        kem_ciphertext: encapsulated.ciphertext,
        encrypted_dek: await crypto.encrypt(wrappingKey, dek, aad),
      });
    } finally {
      wrappingKey.fill(0);
    }
  } finally {
    shared.fill(0);
    encapsulated.free();
  }
}

export async function unwrapFileKey({
  key,
  envelope,
  recipient,
  keyId,
  keyring,
}: {
  key: FileKey;
  envelope: FileEnvelope;
  recipient: WirePrincipal;
  keyId: string;
  keyring: Uint8Array;
}): Promise<Uint8Array> {
  key = fileKeySchema.parse(key);
  envelope = fileEnvelopeSchema.parse(envelope);
  if (
    encodePrincipal(envelope.recipient) !== encodePrincipal(recipient) ||
    envelope.key_id !== keyId
  ) {
    throw new Error("File envelope does not match the selected account key");
  }
  const keys = crypto.keyringToKeys(keyring);
  try {
    const shared = crypto.decapsulate(
      keys.kemSecretKey,
      envelope.kem_ciphertext,
    );
    try {
      const aad = wrappingContext(key, envelope.recipient, keyId);
      const wrappingKey = crypto.deriveEncryptionKey(
        shared,
        crypto.sha256(aad),
        encoder.encode("tensamin-file-dek-kem-v1"),
      );
      try {
        const dek = await crypto.decrypt(
          wrappingKey,
          envelope.encrypted_dek,
          aad,
        );
        if (dek.length !== 32) {
          dek.fill(0);
          throw new Error("Invalid unwrapped file key length");
        }
        return dek;
      } finally {
        wrappingKey.fill(0);
      }
    } finally {
      shared.fill(0);
    }
  } finally {
    keys.kemSecretKey.fill(0);
    keys.sigClSecretKey.fill(0);
    keys.sigPqSecretKey.fill(0);
  }
}

export async function encryptFileManifest({
  key,
  dek,
  metadata,
  ciphertextHash,
  ciphertextSize,
  authorKeyring,
  authorPublicKey,
}: {
  key: FileKey;
  dek: Uint8Array;
  metadata: FileMetadata;
  ciphertextHash: Uint8Array;
  ciphertextSize: bigint;
  authorKeyring: Uint8Array;
  authorPublicKey: Uint8Array;
}): Promise<Uint8Array> {
  key = fileKeySchema.parse(key);
  metadata = metadataSchema.parse(metadata);
  validateLayout(metadata, ciphertextSize);
  if (
    ciphertextHash.length !== 32 ||
    hex(publicBundle(authorKeyring)) !== hex(authorPublicKey)
  ) {
    throw new Error("File author key does not match the authenticated bundle");
  }
  const unsigned = {
    ...metadata,
    ciphertext_sha256: hex(ciphertextHash),
    dek_commitment: hex(crypto.sha256(dek)),
    owner_signing_key_id: hex(crypto.sha256(authorPublicKey)),
  };
  const body = encoder.encode(
    JSON.stringify({
      ...unsigned,
      owner_signature: bytesToBase64(
        crypto.signDual(authorKeyring, ownerProof(key, unsigned)),
      ),
    }),
  );
  const manifestKey = contentKey(dek, key, "manifest");
  try {
    const sealed = await crypto.encrypt(manifestKey, body, context(key));
    if (sealed.length > 16384)
      throw new Error("Encrypted file manifest is too large");
    return sealed;
  } finally {
    body.fill(0);
    manifestKey.fill(0);
  }
}

export async function openFileManifest({
  manifest,
  dek,
  author,
}: {
  manifest: FileManifest;
  dek: Uint8Array;
  author: FileAuthor;
}): Promise<FileMetadata> {
  manifest = fileManifestSchema.parse(manifest);
  if (
    encodePrincipal(author.principal) !== encodePrincipal(manifest.key.origin)
  ) {
    throw new Error("File author principal does not match");
  }
  const manifestKey = contentKey(dek, manifest.key, "manifest");
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await crypto.decrypt(
      manifestKey,
      manifest.manifest_ciphertext,
      context(manifest.key),
    );
    const text = decoder.decode(plaintext);
    const body = signedMetadataSchema.parse(parseExactJson(text));
    const signingKey = author.publicKeys.find(
      (key) => hex(crypto.sha256(key)) === body.owner_signing_key_id,
    );
    validateLayout(body, manifest.ciphertext_size);
    if (
      body.ciphertext_sha256 !== hex(manifest.ciphertext_sha256) ||
      body.dek_commitment !== hex(crypto.sha256(dek)) ||
      !signingKey
    ) {
      throw new Error("File manifest commitments do not match");
    }
    crypto.verifyDual(
      signingKey,
      ownerProof(manifest.key, body),
      base64ToBytes(body.owner_signature),
    );
    const {
      filename,
      mime_type,
      plaintext_size,
      chunk_bytes,
      chunk_count,
      plaintext_sha256,
      created_at,
      updated_at,
    } = body;
    return {
      filename,
      mime_type,
      plaintext_size,
      chunk_bytes,
      chunk_count,
      plaintext_sha256,
      created_at,
      updated_at,
    };
  } finally {
    plaintext?.fill(0);
    manifestKey.fill(0);
  }
}

export async function encryptFileVersion({
  key,
  file,
  filename,
  mimeType,
  owner,
  stage,
  signal,
}: {
  key: FileKey;
  file: Blob;
  filename: string;
  mimeType: string;
  owner: {
    principal: WirePrincipal;
    keyId: string;
    keyring: Uint8Array;
    publicKey: Uint8Array;
  };
  stage: FileStage;
  signal?: AbortSignal;
}): Promise<FileManifest> {
  const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const ciphertextHash = sha256.create();
  const plaintextHash = sha256.create();
  let encryptionKey: Uint8Array | undefined;
  try {
    signal?.throwIfAborted();
    key = fileKeySchema.parse(key);
    if (
      encodePrincipal(key.origin) !== encodePrincipal(owner.principal) ||
      !Number.isSafeInteger(file.size)
    ) {
      throw new Error("File does not belong to the selected author");
    }
    const metadata = metadataSchema.parse({
      filename,
      mime_type: mimeType,
      plaintext_size: file.size.toString(),
      chunk_bytes: "65536",
      chunk_count: Math.max(
        1,
        Math.ceil(file.size / FILE_CHUNK_BYTES),
      ).toString(),
    });
    encryptionKey = contentKey(dek, key, "content");
    for (let index = 0n; index < BigInt(metadata.chunk_count); index++) {
      signal?.throwIfAborted();
      const start = Number(index * BigInt(FILE_CHUNK_BYTES));
      const plaintext = new Uint8Array(
        await file.slice(start, start + FILE_CHUNK_BYTES).arrayBuffer(),
      );
      const padded = new Uint8Array(FILE_CHUNK_BYTES);
      try {
        padded.set(plaintext);
        plaintextHash.update(plaintext);
        const record = await crypto.encrypt(
          encryptionKey,
          padded,
          chunkContext(key, index, metadata),
        );
        ciphertextHash.update(record);
        await stage.write(record);
      } finally {
        plaintext.fill(0);
        padded.fill(0);
      }
    }
    metadata.plaintext_sha256 = hex(plaintextHash.digest());
    const size = BigInt(metadata.chunk_count) * BigInt(FILE_RECORD_BYTES);
    const hash = ciphertextHash.digest();
    const manifest = fileManifestSchema.parse({
      key,
      crypto_format: "tensamin-file-chunks-v1",
      ciphertext_size: size,
      ciphertext_sha256: hash,
      manifest_ciphertext: await encryptFileManifest({
        key,
        dek,
        metadata,
        ciphertextHash: hash,
        ciphertextSize: size,
        authorKeyring: owner.keyring,
        authorPublicKey: owner.publicKey,
      }),
      envelope: await wrapFileKey({
        key,
        dek,
        recipient: owner.principal,
        keyId: owner.keyId,
        publicKey: owner.publicKey,
      }),
    });
    signal?.throwIfAborted();
    await stage.commit();
    return manifest;
  } catch (error) {
    try {
      await stage.abort();
    } catch {
      /* Preserve the original failure. */
    }
    throw error;
  } finally {
    encryptionKey?.fill(0);
    dek.fill(0);
    ciphertextHash.destroy();
    plaintextHash.destroy();
  }
}

export async function decryptFileVersion({
  manifest,
  ciphertext,
  recipient,
  author,
  stage,
  signal,
}: {
  manifest: FileManifest;
  ciphertext: Blob;
  recipient: { principal: WirePrincipal; keyId: string; keyring: Uint8Array };
  author: FileAuthor;
  stage: FileStage;
  signal?: AbortSignal;
}): Promise<FileMetadata> {
  let dek: Uint8Array | undefined;
  let encryptionKey: Uint8Array | undefined;
  const ciphertextHash = sha256.create();
  const plaintextHash = sha256.create();
  try {
    signal?.throwIfAborted();
    manifest = fileManifestSchema.parse(manifest);
    if (
      !Number.isSafeInteger(ciphertext.size) ||
      BigInt(ciphertext.size) !== manifest.ciphertext_size
    ) {
      throw new Error("Ciphertext size does not match the manifest");
    }
    dek = await unwrapFileKey({
      key: manifest.key,
      envelope: manifest.envelope,
      recipient: recipient.principal,
      keyId: recipient.keyId,
      keyring: recipient.keyring,
    });
    const metadata = await openFileManifest({ manifest, dek, author });
    encryptionKey = contentKey(dek, manifest.key, "content");
    const chunks = BigInt(metadata.chunk_count);
    for (let index = 0n; index < chunks; index++) {
      signal?.throwIfAborted();
      const start = Number(index * BigInt(FILE_RECORD_BYTES));
      const record = new Uint8Array(
        await ciphertext.slice(start, start + FILE_RECORD_BYTES).arrayBuffer(),
      );
      ciphertextHash.update(record);
      const plaintext = await crypto.decrypt(
        encryptionKey,
        record,
        chunkContext(manifest.key, index, metadata),
      );
      try {
        if (plaintext.length !== FILE_CHUNK_BYTES)
          throw new Error("Invalid file chunk length");
        const remaining =
          BigInt(metadata.plaintext_size) - index * BigInt(FILE_CHUNK_BYTES);
        const length = Number(
          remaining < BigInt(FILE_CHUNK_BYTES)
            ? remaining
            : BigInt(FILE_CHUNK_BYTES),
        );
        if (plaintext.subarray(length).some((byte) => byte !== 0))
          throw new Error("Invalid final file padding");
        const content = plaintext.subarray(0, length);
        plaintextHash.update(content);
        await stage.write(content);
      } finally {
        plaintext.fill(0);
      }
    }
    if (
      hex(ciphertextHash.digest()) !== hex(manifest.ciphertext_sha256) ||
      (metadata.plaintext_sha256 &&
        hex(plaintextHash.digest()) !== metadata.plaintext_sha256)
    ) {
      throw new Error("File content digest does not match");
    }
    signal?.throwIfAborted();
    await stage.commit();
    return metadata;
  } catch (error) {
    try {
      await stage.abort();
    } catch {
      /* Preserve the original failure. */
    }
    throw error;
  } finally {
    encryptionKey?.fill(0);
    dek?.fill(0);
    ciphertextHash.destroy();
    plaintextHash.destroy();
  }
}

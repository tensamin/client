import { bytesToBase64, crypto } from "mtp";
import { z } from "zod";
import {
  deriveChatId,
  encodePrincipal,
  wirePrincipalSchema,
  type WirePrincipal,
} from "@tensamin/shared/principal";
import {
  fileKeySchema,
  fileManifestSchema,
  type FileKey,
  type FileManifest,
  type FileAuthor,
} from "./file";

const revision = z
  .bigint()
  .min(1n)
  .max((1n << 63n) - 1n);
const signer = {
  chat_id: z.string().min(1).max(1024),
  grant_revision: revision,
  signing_public_key: z.base64(),
  signature: z.instanceof(Uint8Array<ArrayBufferLike>),
};

export const fileShareOfferSchema = z.strictObject({
  ...signer,
  manifest: fileManifestSchema,
  expires_at: revision,
});

export const fileShareRevokeSchema = z.strictObject({
  ...signer,
  key: fileKeySchema,
  recipient: wirePrincipalSchema,
});

export type FileShareOffer = z.output<typeof fileShareOfferSchema>;
export type FileShareRevoke = z.output<typeof fileShareRevokeSchema>;

const encoder = new TextEncoder();

// These arrays must match Tau's ShareOffer/ShareRevoke::signing_bytes exactly.
export function fileShareOfferSigningBytes(offer: FileShareOffer): Uint8Array {
  const { manifest: m } = offer;

  return encoder.encode(
    JSON.stringify([
      "tensamin-file-share-v1",
      m.key.origin.authority,
      m.key.origin.user_id.toString(),
      m.key.file_id,
      m.key.version.toString(),
      Array.from(m.ciphertext_sha256),
      m.ciphertext_size.toString(),
      m.crypto_format,
      Array.from(m.manifest_ciphertext),
      m.envelope.recipient.authority,
      m.envelope.recipient.user_id.toString(),
      m.envelope.key_id,
      m.envelope.wrapping_scheme,
      Array.from(m.envelope.kem_ciphertext),
      Array.from(m.envelope.encrypted_dek),
      offer.chat_id,
      offer.grant_revision.toString(),
      offer.expires_at.toString(),
      offer.signing_public_key,
    ]),
  );
}

export function fileShareRevokeSigningBytes(
  revoke: FileShareRevoke,
): Uint8Array {
  return encoder.encode(
    JSON.stringify([
      "tensamin-file-revoke-v1",
      revoke.key.origin.authority,
      revoke.key.origin.user_id.toString(),
      revoke.key.file_id,
      revoke.key.version.toString(),
      revoke.recipient.authority,
      revoke.recipient.user_id.toString(),
      revoke.chat_id,
      revoke.grant_revision.toString(),
      revoke.signing_public_key,
    ]),
  );
}

export function signFileShareOffer({
  manifest,
  grantRevision,
  expiresAt,
  author,
}: {
  manifest: FileManifest;
  grantRevision: bigint;
  expiresAt: bigint;
  author: {
    principal: WirePrincipal;
    keyring: Uint8Array;
    publicKey: Uint8Array;
  };
}): FileShareOffer {
  const offer = fileShareOfferSchema.parse({
    manifest,
    chat_id: deriveChatId(author.principal, manifest.envelope.recipient),
    grant_revision: grantRevision,
    expires_at: expiresAt,
    signing_public_key: bytesToBase64(author.publicKey),
    signature: new Uint8Array(),
  });

  if (
    encodePrincipal(offer.manifest.key.origin) !==
    encodePrincipal(author.principal)
  ) {
    throw new Error("Only the file author can sign a share");
  }

  const bytes = fileShareOfferSigningBytes(offer);
  offer.signature = crypto.signDual(author.keyring, bytes);
  crypto.verifyDual(author.publicKey, bytes, offer.signature);

  return offer;
}

export function signFileShareRevoke({
  key,
  recipient,
  grantRevision,
  author,
}: {
  key: FileKey;
  recipient: WirePrincipal;
  grantRevision: bigint;
  author: {
    principal: WirePrincipal;
    keyring: Uint8Array;
    publicKey: Uint8Array;
  };
}): FileShareRevoke {
  const revoke = fileShareRevokeSchema.parse({
    key,
    recipient,
    chat_id: deriveChatId(author.principal, recipient),
    grant_revision: grantRevision,
    signing_public_key: bytesToBase64(author.publicKey),
    signature: new Uint8Array(),
  });

  if (
    encodePrincipal(revoke.key.origin) !== encodePrincipal(author.principal)
  ) {
    throw new Error("Only the file author can revoke a share");
  }

  const bytes = fileShareRevokeSigningBytes(revoke);
  revoke.signature = crypto.signDual(author.keyring, bytes);
  crypto.verifyDual(author.publicKey, bytes, revoke.signature);

  return revoke;
}

function verifyBinding(
  key: FileKey,
  recipient: WirePrincipal,
  chatId: string,
  signingPublicKey: string,
  expected: {
    author: FileAuthor;
    recipient: WirePrincipal;
    chatId: string;
  },
) {
  if (
    encodePrincipal(key.origin) !==
      encodePrincipal(expected.author.principal) ||
    encodePrincipal(recipient) !== encodePrincipal(expected.recipient) ||
    chatId !== expected.chatId ||
    chatId !== deriveChatId(key.origin, recipient)
  ) {
    throw new Error(
      "File share does not match the authenticated author, recipient and chat",
    );
  }

  const publicKey = expected.author.publicKeys.find(
    (key) => bytesToBase64(key) === signingPublicKey,
  );

  if (!publicKey)
    throw new Error(
      "File share signing key is not authenticated for its author",
    );

  return publicKey;
}

export function verifyFileShareOffer(
  value: unknown,
  expected: {
    author: FileAuthor;
    recipient: WirePrincipal;
    chatId: string;
    now: bigint;
  },
): FileShareOffer {
  const offer = fileShareOfferSchema.parse(value);
  const publicKey = verifyBinding(
    offer.manifest.key,
    offer.manifest.envelope.recipient,
    offer.chat_id,
    offer.signing_public_key,
    expected,
  );

  if (offer.expires_at <= expected.now)
    throw new Error("File share has expired");
  crypto.verifyDual(
    publicKey,
    fileShareOfferSigningBytes(offer),
    offer.signature,
  );

  return offer;
}

export function verifyFileShareRevoke(
  value: unknown,
  expected: {
    author: FileAuthor;
    recipient: WirePrincipal;
    chatId: string;
  },
): FileShareRevoke {
  const revoke = fileShareRevokeSchema.parse(value);
  const publicKey = verifyBinding(
    revoke.key,
    revoke.recipient,
    revoke.chat_id,
    revoke.signing_public_key,
    expected,
  );
  crypto.verifyDual(
    publicKey,
    fileShareRevokeSigningBytes(revoke),
    revoke.signature,
  );

  return revoke;
}

import { base64ToBytes, crypto } from "mtp";
import * as mtpRaw from "mtp/raw";
import { parseTuFileContent } from "@tensamin/storage/credentials";
import { CredentialVerificationError } from "./errors";

export function serializeTuCredential({
  userId,
  privateKey,
  domain,
}: {
  userId: number;
  privateKey: string;
  domain: string | null;
}): string {
  const identity = domain ? `${userId}@${domain}` : `${userId}`;
  return `${identity}::${privateKey}`;
}

export function omegaHostOf(omegaOrigin: string): string {
  return new URL(omegaOrigin).hostname;
}

export function canonicalPublicKeyBundle(base64: string): Uint8Array {
  let parsed: mtpRaw.WasmPublicKeyBundle;
  try {
    parsed = mtpRaw.WasmPublicKeyBundle.from_bytes(base64ToBytes(base64));
  } catch {
    throw new CredentialVerificationError("Malformed public key bundle");
  }
  try {
    return parsed.try_to_bytes();
  } finally {
    parsed.free();
  }
}

function keyringPublicKeyBundle(keyring: Uint8Array): Uint8Array {
  let parsed: mtpRaw.WasmKeyring;
  try {
    parsed = mtpRaw.WasmKeyring.from_bytes(keyring);
  } catch {
    throw new CredentialVerificationError("Malformed MTP keyring");
  }
  try {
    const bundle = parsed.public_key_bundle();
    try {
      return bundle.try_to_bytes();
    } finally {
      bundle.free();
    }
  } finally {
    parsed.free();
  }
}

function assertSameBytes(
  actual: Uint8Array,
  expected: Uint8Array,
  message: string,
) {
  if (
    actual.byteLength !== expected.byteLength ||
    !actual.every((byte, index) => byte === expected[index])
  ) {
    throw new CredentialVerificationError(message);
  }
}

function decodeStrictUtf8(content: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new CredentialVerificationError(
      "Recovered credential is not valid UTF-8",
    );
  }
}

export type RecoveredCredential = {
  content: string;
  userId: number;
  keyring: Uint8Array;
  publicKeyBundle: Uint8Array;
};

/**
 * Field checks every received `ProvisioningCredential` payload must pass
 * before decryption: matching active session, expected method, expected
 * account, and well-shaped byte fields.
 */
export function requireProvisioningCredentialFields(
  data: unknown,
  expected: {
    uuid: string;
    method: string;
    userId: number;
    iotaId: number;
  },
): { encryptedCredential: Uint8Array; fingerprint: Uint8Array } {
  const payload = (data ?? {}) as Record<string, unknown>;
  if (
    payload.Uuid !== expected.uuid ||
    payload.ProvisioningMethod !== expected.method ||
    payload.UserId !== expected.userId ||
    payload.IotaId !== expected.iotaId ||
    !(payload.EncryptedCredential instanceof Uint8Array) ||
    !(payload.Sha256 instanceof Uint8Array) ||
    payload.Sha256.byteLength !== 32
  ) {
    throw new CredentialVerificationError(
      "Provisioning credential does not match the active session",
    );
  }
  return {
    encryptedCredential: payload.EncryptedCredential,
    fingerprint: payload.Sha256,
  };
}

export function validateRecoveredCredential({
  content,
  expectedUserId,
  omegaHost,
  expectedPublicKey,
  fingerprint,
}: {
  content: string | Uint8Array;
  expectedUserId: number;
  omegaHost: string;
  expectedPublicKey: string;
  fingerprint?: Uint8Array;
}): RecoveredCredential {
  const text =
    typeof content === "string" ? content : decodeStrictUtf8(content);
  let parsed: ReturnType<typeof parseTuFileContent>;
  try {
    parsed = parseTuFileContent(text);
  } catch {
    throw new CredentialVerificationError(
      "Recovered credential is not a parsable .tu credential",
    );
  }
  if (parsed.userId !== expectedUserId) {
    throw new CredentialVerificationError(
      "Recovered credential belongs to a different account",
    );
  }
  if (!parsed.domain || parsed.domain !== omegaHost) {
    throw new CredentialVerificationError(
      "Recovered credential domain does not match the account's Omega",
    );
  }
  let keyring: Uint8Array;
  try {
    keyring = base64ToBytes(parsed.privateKey);
    crypto.keyringToKeys(keyring);
  } catch {
    throw new CredentialVerificationError(
      "Recovered credential contains an invalid keyring",
    );
  }
  const bundle = keyringPublicKeyBundle(keyring);
  assertSameBytes(
    bundle,
    canonicalPublicKeyBundle(expectedPublicKey),
    "Recovered credential key does not match the account key on Omega",
  );
  if (fingerprint) {
    assertSameBytes(
      crypto.sha256(bundle),
      fingerprint,
      "Account key fingerprint mismatch",
    );
  }
  return {
    content: serializeTuCredential({
      userId: parsed.userId,
      privateKey: parsed.privateKey,
      domain: parsed.domain,
    }),
    userId: parsed.userId,
    keyring,
    publicKeyBundle: bundle,
  };
}

export function fingerprintOf(publicKeyBundle: Uint8Array): Uint8Array {
  return crypto.sha256(publicKeyBundle);
}

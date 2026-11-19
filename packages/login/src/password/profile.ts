import { CipherSuiteId, getSuite } from "@structured-id/opaque";
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { argon2id } from "@noble/hashes/argon2.js";
import { extract } from "@noble/hashes/hkdf.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8Bytes, uuidBytes, writeUintBE } from "../bytes";

export const suite = getSuite(CipherSuiteId.RISTRETTO255_SHA512);
const serverDomain = utf8Bytes("tensamin:iota-password\0");
const contextDomain = utf8Bytes("tensamin:password-provisioning\0");
const deriveInfo = utf8Bytes("OPAQUE-DeriveDiffieHellmanKeyPair");
const deriveDst = utf8Bytes("DeriveKeyPairOPRFV1-\x00-ristretto255-SHA512");

export type LoginBinding = {
  principal: string;
  iotaId: number;
  sessionId: string;
  contactKeySha256: Uint8Array;
};

export function serverIdentifier(iotaId: number): Uint8Array {
  if (!Number.isSafeInteger(iotaId))
    throw new RangeError("Iota ID must be a safe integer");
  const output = new Uint8Array(serverDomain.length + 8);
  output.set(serverDomain);
  new DataView(output.buffer).setBigInt64(
    serverDomain.length,
    BigInt(iotaId),
    false,
  );
  return output;
}

export function buildLoginContext(binding: LoginBinding): Uint8Array {
  if (binding.contactKeySha256.length !== 32)
    throw new RangeError("Contact fingerprint must contain 32 bytes");
  const principal = utf8Bytes(binding.principal);
  return concatBytes(
    contextDomain,
    writeUintBE(principal.length, 4),
    principal,
    serverIdentifier(binding.iotaId).slice(serverDomain.length),
    uuidBytes(binding.sessionId),
    binding.contactKeySha256,
  );
}

/** Persistent Argon2id v0x13 parameters; output length equals input length. */
function stretchPassword(input: Uint8Array): Uint8Array {
  return argon2id(input, new Uint8Array(16), {
    m: 19456,
    t: 2,
    p: 1,
    dkLen: input.length,
  });
}

export function randomizedPassword(oprfOutput: Uint8Array): Uint8Array {
  const hardened = stretchPassword(oprfOutput);
  const ikm = concatBytes(oprfOutput, hardened);
  try {
    return extract(sha512, ikm);
  } finally {
    for (const secret of [hardened, ikm, oprfOutput]) secret.fill(0);
  }
}

/** RFC 9497 DeriveKeyPair with opaque-ke's application-specific info. */
export function deriveKeyPairFromSeed(seed: Uint8Array) {
  const input = concatBytes(
    seed,
    writeUintBE(deriveInfo.length, 2),
    deriveInfo,
    Uint8Array.of(0),
  );
  try {
    for (let counter = 0; counter <= 255; counter++) {
      input[input.length - 1] = counter;
      const scalar = ristretto255_hasher.hashToScalar(input, {
        DST: deriveDst,
      });
      if (scalar === 0n) continue;
      // structured-id's GroupOps interprets scalars big-endian internally;
      // public keys use the standard compressed Ristretto wire encoding.
      let value = scalar;
      const secretKey = new Uint8Array(32);
      for (let index = 31; index >= 0; index--) {
        secretKey[index] = Number(value & 255n);
        value >>= 8n;
      }
      return {
        secretKey,
        publicKey: ristretto255.Point.BASE.multiply(scalar).toBytes(),
      };
    }
    throw new Error("DeriveKeyPair failed");
  } finally {
    input.fill(0);
    seed.fill(0);
  }
}

import { crypto } from "mtp";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const CALL_SECRET_WRAPPING_SCHEME =
  "mtp-call-secret-kem-chacha20poly1305-hkdf-sha256-v1";

const CALL_SECRET_SALT = textEncoder.encode("tensamin-call-secret-v1");

export function deriveCallSecretId(callId: string): string {
  return `call:${callId}:main`;
}

export function kemPublicKeyFromPublicKeyBundle(publicKey: string): Uint8Array {
  return crypto.publicKeyBundleToKeys({ value: publicKey, encoding: "base64" })
    .kemPublicKey;
}

export async function wrapCallSecret(args: {
  callSecret: string;
  recipientKemPublicKey: Uint8Array;
  callId: string;
  secretId: string;
  version: number;
}): Promise<{
  encryptedSecret: Uint8Array;
  kemCiphertext: Uint8Array;
  wrappingScheme: string;
}> {
  const enc = crypto.encapsulate(args.recipientKemPublicKey);
  try {
    const wrappingKey = deriveWrappingKey({
      sharedSecret: enc.shared_secret,
      callId: args.callId,
      secretId: args.secretId,
      version: args.version,
    });

    try {
      return {
        encryptedSecret: await crypto.encrypt(
          wrappingKey,
          textEncoder.encode(args.callSecret),
        ),
        kemCiphertext: enc.ciphertext,
        wrappingScheme: CALL_SECRET_WRAPPING_SCHEME,
      };
    } finally {
      wrappingKey.fill(0);
    }
  } finally {
    enc.shared_secret.fill(0);
  }
}

export async function unwrapCallSecret(args: {
  encryptedSecret: Uint8Array;
  kemCiphertext: Uint8Array;
  keyring: string;
  callId: string;
  secretId: string;
  version: number;
  wrappingScheme: string;
}): Promise<string> {
  if (args.wrappingScheme !== CALL_SECRET_WRAPPING_SCHEME) {
    throw new Error(
      `Unsupported call secret wrapping scheme: ${args.wrappingScheme}`,
    );
  }

  const ownKeys = crypto.keyringToKeys({
    value: args.keyring,
    encoding: "base64",
  });
  const sharedSecret = crypto.decapsulate(
    ownKeys.kemSecretKey,
    args.kemCiphertext,
  );

  try {
    const wrappingKey = deriveWrappingKey({
      sharedSecret,
      callId: args.callId,
      secretId: args.secretId,
      version: args.version,
    });

    try {
      return textDecoder.decode(
        await crypto.decrypt(wrappingKey, args.encryptedSecret),
      );
    } finally {
      wrappingKey.fill(0);
    }
  } finally {
    sharedSecret.fill(0);
  }
}

function deriveWrappingKey(args: {
  sharedSecret: Uint8Array;
  callId: string;
  secretId: string;
  version: number;
}): Uint8Array {
  return crypto.deriveEncryptionKey(
    args.sharedSecret,
    CALL_SECRET_SALT,
    textEncoder.encode(`${args.callId}:${args.secretId}:${args.version}`),
  );
}

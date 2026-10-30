import { base64ToBytes, bytesToBase64, crypto } from "mtp";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const CHAT_SECRET_WRAPPING_SCHEME =
  "mtp-chat-secret-kem-chacha20poly1305-hkdf-sha256-v1";

const CHAT_SECRET_SALT = textEncoder.encode("tensamin-chat-secret-v1");
const CHAT_MESSAGE_SALT = textEncoder.encode("tensamin-chat-message-v1");

export function deriveChatSecretId(chatId: string): string {
  return `chat:${chatId}:main`;
}

export function randomChatSecret(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

export function ownKemPublicKeyFromKeyring(keyring: string): Uint8Array {
  return crypto.keyringToKeys({ value: keyring, encoding: "base64" })
    .kemPublicKey;
}

export function kemPublicKeyFromPublicKeyBundle(publicKey: string): Uint8Array {
  return crypto.publicKeyBundleToKeys({ value: publicKey, encoding: "base64" })
    .kemPublicKey;
}

export async function wrapChatSecret(args: {
  chatSecret: Uint8Array;
  recipientKemPublicKey: Uint8Array;
  chatId: string;
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
      chatId: args.chatId,
      secretId: args.secretId,
      version: args.version,
    });

    try {
      return {
        encryptedSecret: await crypto.encrypt(wrappingKey, args.chatSecret),
        kemCiphertext: enc.ciphertext,
        wrappingScheme: CHAT_SECRET_WRAPPING_SCHEME,
      };
    } finally {
      wrappingKey.fill(0);
    }
  } finally {
    enc.shared_secret.fill(0);
  }
}

export async function unwrapChatSecret(args: {
  encryptedSecret: Uint8Array;
  kemCiphertext: Uint8Array;
  keyring: string;
  chatId: string;
  secretId: string;
  version: number;
  wrappingScheme: string;
}): Promise<Uint8Array> {
  if (args.wrappingScheme !== CHAT_SECRET_WRAPPING_SCHEME) {
    throw new Error(
      `Unsupported chat secret wrapping scheme: ${args.wrappingScheme}`,
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
      chatId: args.chatId,
      secretId: args.secretId,
      version: args.version,
    });

    try {
      return await crypto.decrypt(wrappingKey, args.encryptedSecret);
    } finally {
      wrappingKey.fill(0);
    }
  } finally {
    sharedSecret.fill(0);
  }
}

export async function encryptChatText(
  chatSecret: Uint8Array,
  plaintext: string,
  version = 1,
): Promise<string> {
  const key = deriveMessageKey(chatSecret, version);
  try {
    return bytesToBase64(
      await crypto.encrypt(key, textEncoder.encode(plaintext)),
    );
  } finally {
    key.fill(0);
  }
}

export async function decryptChatText(
  chatSecret: Uint8Array,
  ciphertext: string,
  version = 1,
): Promise<string> {
  const key = deriveMessageKey(chatSecret, version);
  try {
    return textDecoder.decode(
      await crypto.decrypt(key, base64ToBytes(ciphertext)),
    );
  } finally {
    key.fill(0);
  }
}

function deriveWrappingKey(args: {
  sharedSecret: Uint8Array;
  chatId: string;
  secretId: string;
  version: number;
}): Uint8Array {
  return crypto.deriveEncryptionKey(
    args.sharedSecret,
    CHAT_SECRET_SALT,
    textEncoder.encode(`${args.chatId}:${args.secretId}:${args.version}`),
  );
}

function deriveMessageKey(chatSecret: Uint8Array, version: number): Uint8Array {
  return crypto.deriveEncryptionKey(
    chatSecret,
    CHAT_MESSAGE_SALT,
    textEncoder.encode(
      version === 1 ? "message-content" : `message-content:${version}`,
    ),
  );
}

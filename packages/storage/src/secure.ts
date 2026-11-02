import type {} from "@tensamin/shared/desktopMedia";
import { isTauri } from "@tauri-apps/api/core";
import { getDatabaseEntry, setDatabaseEntry } from "@tensamin/shared/indexedDb";

export type SecureStorageStatus = {
  backend:
    "electron-keyring" | "application-storage" | "webcrypto" | "indexeddb";
  secure: boolean;
  reason?: string;
};

type SecureEnvelope = {
  __tensaminSecure: 1;
  version: 1;
  iv: string;
  data: string;
};

const MASTER_KEY_NAME = "master-v1";
let keyPromise: Promise<CryptoKey | null> | undefined;

function bytesToBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function loadBrowserKey() {
  const existing = await getDatabaseEntry<CryptoKey>("keys", MASTER_KEY_NAME);
  if (existing) return existing;

  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  await setDatabaseEntry("keys", MASTER_KEY_NAME, key);
  return key;
}

async function loadElectronKey() {
  const storage = window.tensaminDesktop?.secureStorage;
  if (!storage?.getStatus || !storage.load || !storage.save) return null;
  const status = await storage.getStatus();
  if (!status.available) return null;

  let encoded = await storage.load(MASTER_KEY_NAME);
  if (encoded === null) {
    encoded = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
    await storage.save(MASTER_KEY_NAME, encoded);
  }
  return crypto.subtle.importKey(
    "raw",
    base64ToBytes(encoded),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

async function getKey() {
  keyPromise ??= (async () => {
    if (!globalThis.crypto?.subtle || typeof indexedDB === "undefined") {
      return null;
    }
    if (
      typeof window !== "undefined" &&
      window.tensaminDesktop?.secureStorage
    ) {
      return loadElectronKey();
    }
    return loadBrowserKey();
  })().catch(() => null);
  return keyPromise;
}

export function isSecureEnvelope(value: unknown): value is SecureEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<SecureEnvelope>;
  return (
    envelope.__tensaminSecure === 1 &&
    envelope.version === 1 &&
    typeof envelope.iv === "string" &&
    typeof envelope.data === "string"
  );
}

export async function encodeSecureValue(value: unknown): Promise<unknown> {
  if (isTauri()) return value;
  const key = await getKey();
  if (!key) return value;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );
  return {
    __tensaminSecure: 1,
    version: 1,
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encrypted)),
  } satisfies SecureEnvelope;
}

export async function decodeSecureValue(value: unknown): Promise<unknown> {
  if (!isSecureEnvelope(value)) return value;
  const key = await getKey();
  if (!key) throw new Error("Secure storage key is unavailable.");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(value.iv) },
    key,
    base64ToBytes(value.data),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
}

export async function getSecureStorageStatus(): Promise<SecureStorageStatus> {
  const desktop =
    typeof window === "undefined"
      ? undefined
      : window.tensaminDesktop?.secureStorage;
  if (desktop?.getStatus) {
    const status = await desktop.getStatus();
    if (status.available) return { backend: "electron-keyring", secure: true };
    return {
      backend: "indexeddb",
      secure: false,
      reason:
        status.backend === "basic_text"
          ? "The operating system keyring is unavailable."
          : "Electron secure storage is unavailable.",
    };
  }
  if (isTauri()) return { backend: "application-storage", secure: true };
  return (await getKey())
    ? { backend: "webcrypto", secure: true }
    : {
        backend: "indexeddb",
        secure: false,
        reason: "This browser cannot protect local credentials with WebCrypto.",
      };
}

export const secureValueCodec = {
  encode: encodeSecureValue,
  decode: decodeSecureValue,
};

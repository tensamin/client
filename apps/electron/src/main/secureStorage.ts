import { app, safeStorage } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  secureStorageLimits,
  type DesktopSecureStorageStatus,
} from "../shared/ipc.js";

type StoredValues = Record<string, string>;

let pendingWrite = Promise.resolve();

function storagePath() {
  return join(app.getPath("userData"), "secure-storage.json");
}

function validateKey(key: unknown): asserts key is string {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    Buffer.byteLength(key, "utf8") > secureStorageLimits.maxKeyBytes
  ) {
    throw new Error("Invalid secure storage key.");
  }
}

function validateValue(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > secureStorageLimits.maxValueBytes
  ) {
    throw new Error("Invalid secure storage value.");
  }
}

export function getSecureStorageStatus(): DesktopSecureStorageStatus {
  const backend =
    process.platform === "linux"
      ? safeStorage.getSelectedStorageBackend()
      : process.platform === "darwin"
        ? "keychain"
        : process.platform === "win32"
          ? "dpapi"
          : null;

  return {
    available:
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" || backend !== "basic_text"),
    backend,
  };
}

function requireAvailable() {
  if (!getSecureStorageStatus().available) {
    throw new Error("Secure storage is unavailable.");
  }
}

async function readValues(): Promise<StoredValues> {
  try {
    const parsed: unknown = JSON.parse(await readFile(storagePath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid secure storage data.");
    }

    const values = parsed as Record<string, unknown>;
    if (Object.values(values).some((value) => typeof value !== "string")) {
      throw new Error("Invalid secure storage data.");
    }
    return values as StoredValues;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeValues(values: StoredValues) {
  const path = storagePath();
  const temporaryPath = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, JSON.stringify(values), { mode: 0o600 });
  await rename(temporaryPath, path);
}

function mutateValues(mutation: (values: StoredValues) => void) {
  const operation = pendingWrite.then(async () => {
    const values = await readValues();
    mutation(values);
    await writeValues(values);
  });
  pendingWrite = operation.catch(() => undefined);
  return operation;
}

export async function loadSecureStorage(key: unknown): Promise<string | null> {
  requireAvailable();
  validateKey(key);
  await pendingWrite;
  const encrypted = (await readValues())[key];
  if (encrypted === undefined) return null;
  return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
}

export function saveSecureStorage(key: unknown, value: unknown) {
  requireAvailable();
  validateKey(key);
  validateValue(value);
  const encrypted = safeStorage.encryptString(value).toString("base64");
  return mutateValues((values) => {
    values[key] = encrypted;
  });
}

export function deleteSecureStorage(key: unknown) {
  requireAvailable();
  validateKey(key);
  return mutateValues((values) => {
    delete values[key];
  });
}

export function clearSecureStorage() {
  requireAvailable();
  return mutateValues((values) => {
    for (const key of Object.keys(values)) delete values[key];
  });
}

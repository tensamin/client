import { app, safeStorage } from "electron";
import { mkdir, open, readFile, rename } from "node:fs/promises";
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
  const file = await open(temporaryPath, "w", 0o600);

  try {
    await file.writeFile(JSON.stringify(values));
    await file.sync();
  } finally {
    await file.close();
  }

  await rename(temporaryPath, path);

  if (process.platform !== "win32") {
    const directory = await open(dirname(path), "r");

    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

function accessValues<T>(operation: (values: StoredValues) => Promise<T>) {
  const pending = pendingWrite.then(async () => {
    const values = await readValues();

    return operation(values);
  });
  pendingWrite = pending.then(
    () => undefined,
    () => undefined,
  );

  return pending;
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

  return accessValues(async (values) => {
    values[key] = encrypted;
    await writeValues(values);
  });
}

export function getOrCreateSecureStorage(key: unknown, candidate: unknown) {
  requireAvailable();
  validateKey(key);
  validateValue(candidate);

  return accessValues(async (values) => {
    const existing = values[key];

    if (existing !== undefined) {
      return safeStorage.decryptString(Buffer.from(existing, "base64"));
    }

    values[key] = safeStorage.encryptString(candidate).toString("base64");
    await writeValues(values);

    return candidate;
  });
}

export function deleteSecureStorage(key: unknown) {
  requireAvailable();
  validateKey(key);

  return accessValues(async (values) => {
    delete values[key];
    await writeValues(values);
  });
}

export function clearSecureStorage() {
  requireAvailable();

  return accessValues(async (values) => {
    for (const key of Object.keys(values)) delete values[key];
    await writeValues(values);
  });
}

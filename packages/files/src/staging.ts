import type { FileStage } from "@tensamin/crypto/file";
import { z } from "zod";
import { isTauri } from "@tauri-apps/api/core";
import {
  createNativeStage,
  loadNativeStage,
  removeNativeStage,
} from "./nativeStaging";

export async function accountDirectory(
  accountKey: string,
  signal: AbortSignal,
  purpose: "ciphertext" | "output" = "ciphertext",
) {
  signal.throwIfAborted();

  if (!navigator.storage?.getDirectory)
    throw new Error("This platform cannot stage encrypted files privately");
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accountKey)),
  );
  const directory = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle(
    `tensamin-files-${purpose === "output" ? "output-" : ""}${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    { create: true },
  );
  signal.throwIfAborted();

  return directory;
}

export async function createCiphertextStage(
  accountKey: string,
  signal: AbortSignal,
  existingId?: string,
) {
  if (isTauri())
    return createNativeStage(accountKey, signal, "ciphertext", existingId);
  const directory = await accountDirectory(accountKey, signal);
  const id = existingId ? z.uuid().parse(existingId) : crypto.randomUUID();
  const file = await directory.getFileHandle(id, { create: !existingId });
  let offset = (await file.getFile()).size;
  let state: "writing" | "committed" | "aborted" = "writing";
  let writer: FileSystemWritableFileStream | undefined;
  let checkpointAt = Math.max(8 * 1024 * 1024, offset * 2);
  async function flush() {
    const active = writer;
    writer = undefined;
    if (!active) return;
    try {
      await active.close();
    } catch (error) {
      await active.abort().catch(() => undefined);
      throw error;
    }
  }
  const stage: FileStage = {
    async write(bytes) {
      signal.throwIfAborted();

      if (state !== "writing") throw new Error("File staging is closed");
      if (!writer) {
        writer = await file.createWritable({ keepExistingData: offset > 0 });
        await writer.seek(offset);
      }
      await writer.write(new Uint8Array(bytes));
      offset += bytes.length;
      // Geometric checkpoints preserve crash-recovery prefixes with linear total copying.
      if (offset >= checkpointAt) {
        await flush();
        checkpointAt = offset * 2;
      }

      signal.throwIfAborted();
    },
    async commit() {
      signal.throwIfAborted();

      if (state !== "writing") throw new Error("File staging is closed");
      await flush();
      signal.throwIfAborted();
      state = "committed";
    },
    async abort() {
      if (state === "aborted") return;
      state = "aborted";
      if (writer) {
        const active = writer;
        writer = undefined;
        await active.abort().catch(() => undefined);
      }
      await directory.removeEntry(id);
    },
  };

  return {
    id,
    get size() {
      return offset;
    },
    stage,
    suspend: flush,
    async file() {
      signal.throwIfAborted();

      if (state !== "committed")
        throw new Error("File staging has not committed");
      const content = await file.getFile();
      signal.throwIfAborted();

      return content;
    },
  };
}

export async function loadCiphertextStage(
  accountKey: string,
  id: string,
  signal: AbortSignal,
) {
  if (isTauri()) return loadNativeStage(accountKey, id, signal);
  z.uuid().parse(id);
  const directory = await accountDirectory(accountKey, signal);
  const file = await (await directory.getFileHandle(id)).getFile();
  signal.throwIfAborted();

  return file;
}

export async function removeCiphertextStage(accountKey: string, id: string) {
  if (isTauri()) return removeNativeStage(accountKey, id);
  z.uuid().parse(id);
  const directory = await accountDirectory(
    accountKey,
    new AbortController().signal,
  );

  try {
    await directory.removeEntry(id);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError"))
      throw error;
  }
}

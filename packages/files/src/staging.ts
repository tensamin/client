import type { FileStage } from "@tensamin/crypto/file";
import { z } from "zod";

async function accountDirectory(accountKey: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!navigator.storage?.getDirectory)
    throw new Error("This platform cannot stage encrypted files privately");
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accountKey)),
  );
  const directory = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle(
    `tensamin-files-${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    { create: true },
  );
  signal.throwIfAborted();
  return directory;
}

export async function createCiphertextStage(
  accountKey: string,
  signal: AbortSignal,
) {
  const directory = await accountDirectory(accountKey, signal);
  const id = crypto.randomUUID();
  const file = await directory.getFileHandle(id, { create: true });
  const writer = await file.createWritable();
  let state: "writing" | "committed" | "aborted" = "writing";
  const stage: FileStage = {
    async write(bytes) {
      signal.throwIfAborted();
      if (state !== "writing") throw new Error("File staging is closed");
      await writer.write(new Uint8Array(bytes));
      signal.throwIfAborted();
    },
    async commit() {
      signal.throwIfAborted();
      if (state !== "writing") throw new Error("File staging is closed");
      await writer.close();
      signal.throwIfAborted();
      state = "committed";
    },
    async abort() {
      if (state === "aborted") return;
      const writing = state === "writing";
      state = "aborted";
      try {
        if (writing) await writer.abort();
      } finally {
        await directory.removeEntry(id);
      }
    },
  };
  return {
    id,
    stage,
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
  z.uuid().parse(id);
  const directory = await accountDirectory(accountKey, signal);
  const file = await (await directory.getFileHandle(id)).getFile();
  signal.throwIfAborted();
  return file;
}

export async function removeCiphertextStage(accountKey: string, id: string) {
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

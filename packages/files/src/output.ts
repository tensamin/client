import { isTauri } from "@tauri-apps/api/core";
import type { FileStage } from "@tensamin/crypto/file";
import { z } from "zod";
import { accountDirectory } from "./staging";
import { createNativeStage } from "./nativeStaging";

export async function createFileOutput(
  accountKey: string,
  signal: AbortSignal,
) {
  if (isTauri()) {
    const native = await createNativeStage(accountKey, signal, "plaintext");
    return {
      kind: "native" as const,
      stage: native.stage,
      file: native.file,
      save: native.save,
      abort: native.stage.abort,
    };
  }
  signal.throwIfAborted();
  if (!navigator.locks)
    throw new Error("Private file output requires Web Locks");
  const directory = await accountDirectory(accountKey, signal, "output");
  const remove = async (id: string) => {
    try {
      await directory.removeEntry(id);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError"))
        throw error;
    }
  };
  // A crashed tab releases its Web Lock. Only unowned output files are removed;
  // ciphertext uploads live in a different directory and are never scavenged here.
  for await (const [name, handle] of directory.entries()) {
    signal.throwIfAborted();
    if (handle.kind !== "file" || !z.uuid().safeParse(name).success) continue;
    await navigator.locks.request(
      `file-output:${accountKey}:${name}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) return;
        await remove(name);
      },
    );
  }
  const id = crypto.randomUUID();
  let release!: () => void;
  let acquired!: () => void;
  let rejected!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    acquired = resolve;
    rejected = reject;
  });
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lease = navigator.locks.request(
    `file-output:${accountKey}:${id}`,
    { signal },
    async () => {
      acquired();
      await closed;
    },
  );
  void lease.catch(rejected);
  await ready;
  signal.addEventListener("abort", release, { once: true });
  let created = false;
  try {
    signal.throwIfAborted();
    const handle = await directory.getFileHandle(id, { create: true });
    created = true;
    const writer = await handle.createWritable();
    let state: "writing" | "committed" | "aborted" = "writing";
    const stage: FileStage = {
      async write(bytes) {
        signal.throwIfAborted();
        if (state !== "writing")
          throw new Error("Private file output is closed");
        await writer.write(new Uint8Array(bytes));
        signal.throwIfAborted();
      },
      async commit() {
        signal.throwIfAborted();
        if (state !== "writing")
          throw new Error("Private file output is closed");
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
          try {
            await remove(id);
            created = false;
          } finally {
            signal.removeEventListener("abort", release);
            release();
            await lease;
          }
        }
      },
    };
    if (signal.aborted) {
      await stage.abort();
      signal.throwIfAborted();
    }
    return {
      kind: "browser" as const,
      stage,
      abort: stage.abort,
      async file() {
        signal.throwIfAborted();
        if (state !== "committed")
          throw new Error("File output has not passed verification");
        const file = await handle.getFile();
        signal.throwIfAborted();
        return file;
      },
    };
  } catch (error) {
    try {
      if (created) await remove(id);
    } finally {
      signal.removeEventListener("abort", release);
      release();
      await lease;
    }
    throw error;
  }
}

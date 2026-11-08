import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { FileSource, FileStage } from "@tensamin/crypto/file";

const info = z.strictObject({
  id: z.uuid(),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  committed: z.boolean(),
});

export function nativeStageSource(
  accountKey: string,
  id: string,
  size: number,
  signal: AbortSignal,
): FileSource {
  z.uuid().parse(id);
  return {
    size,
    slice(start, end) {
      const offset = Math.max(0, Math.min(size, start));
      const amount = Math.max(0, Math.min(size, end) - offset);
      return {
        async arrayBuffer() {
          signal.throwIfAborted();
          if (
            !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(amount) ||
            amount > 256 * 1024
          )
            throw new Error("Private file read exceeds its range budget");
          const bytes = z
            .array(z.number().int().min(0).max(255))
            .max(256 * 1024)
            .parse(
              await invoke("file_stage_read", {
                accountKey,
                id,
                offset,
                amount,
              }),
            );
          signal.throwIfAborted();
          if (bytes.length !== amount)
            throw new Error("Private file range is incomplete");
          return Uint8Array.from(bytes).buffer;
        },
      };
    },
  };
}

export async function createNativeStage(
  accountKey: string,
  signal: AbortSignal,
  purpose: "ciphertext" | "plaintext" | "download",
) {
  signal.throwIfAborted();
  const created = info.parse(
    await invoke("file_stage_create", { accountKey, purpose }),
  );
  let offset = 0;
  let state: "writing" | "committed" | "aborted" = "writing";
  const stage: FileStage = {
    async write(bytes) {
      signal.throwIfAborted();
      if (state !== "writing") throw new Error("Private file stage is closed");
      if (bytes.length > 256 * 1024)
        throw new Error("Private file write exceeds its chunk budget");
      const next = z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .parse(
          await invoke("file_stage_append", {
            accountKey,
            id: created.id,
            offset,
            bytes: Array.from(bytes),
          }),
        );
      signal.throwIfAborted();
      if (next !== offset + bytes.length)
        throw new Error("Private file write acknowledgement changed");
      offset = next;
    },
    async commit() {
      signal.throwIfAborted();
      if (state !== "writing") throw new Error("Private file stage is closed");
      const size = z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .parse(
          await invoke("file_stage_commit", {
            accountKey,
            id: created.id,
          }),
        );
      signal.throwIfAborted();
      if (size !== offset) throw new Error("Private file commit size changed");
      state = "committed";
    },
    async abort() {
      if (state === "aborted") return;
      await invoke("file_stage_remove", { accountKey, id: created.id });
      state = "aborted";
    },
  };
  try {
    signal.throwIfAborted();
  } catch (error) {
    await stage.abort();
    throw error;
  }
  return {
    id: created.id,
    stage,
    async file() {
      signal.throwIfAborted();
      if (state !== "committed" || purpose === "plaintext")
        throw new Error("Private ciphertext stage has not committed");
      return nativeStageSource(accountKey, created.id, offset, signal);
    },
    async save(filename: string) {
      signal.throwIfAborted();
      if (state !== "committed" || purpose !== "plaintext")
        throw new Error("File output has not passed verification");
      const saved = await invoke<boolean>("file_stage_export", {
        accountKey,
        id: created.id,
        filename,
      });
      signal.throwIfAborted();
      if (saved) state = "aborted";
      return saved;
    },
  };
}

export async function loadNativeStage(
  accountKey: string,
  id: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  z.uuid().parse(id);
  const loaded = info.parse(
    await invoke("file_stage_info", { accountKey, id }),
  );
  signal.throwIfAborted();
  if (loaded.id !== id || !loaded.committed)
    throw new Error("Pending ciphertext is not committed");
  return nativeStageSource(accountKey, id, loaded.size, signal);
}

export async function removeNativeStage(accountKey: string, id: string) {
  z.uuid().parse(id);
  await invoke("file_stage_remove", { accountKey, id });
}

import {
  decryptFileVersion,
  fileKeySchema,
  type FileKey,
  type FileStage,
} from "@tensamin/crypto/file";
import type { ProtocolMessage } from "@tensamin/mtp";
import {
  encodeFileRequest,
  fileManifestResponse,
} from "@tensamin/mtp/files/protocol";
import { createFileAuthorResolver } from "@tensamin/mtp/fileSigningKey";
import { waitForForeground } from "@tensamin/shared/focus";
import { log } from "@tensamin/shared/log";
import {
  deleteDatabaseEntry,
  getDatabaseEntry,
  listDatabaseEntries,
  setDatabaseEntry,
} from "@tensamin/shared/indexedDb";
import {
  decodeSecureValue,
  encodeSecureValue,
  isSecureEnvelope,
} from "@tensamin/storage/secure";
import { z } from "zod";
import { createCiphertextStage, removeCiphertextStage } from "./staging";
import type { FileTransferContext } from "./types";

export function createFileDownload({
  accountKey,
  account,
  owner,
  send,
  signal,
  onProgress,
  manifest,
  fileAuthor,
}: FileTransferContext & {
  manifest: (key: FileKey) => Promise<z.output<typeof fileManifestResponse>>;
  fileAuthor: ReturnType<typeof createFileAuthorResolver>;
}) {
  const downloadPrefix = `file-download:v1:${accountKey}:`;
  const checkpointSchema = z.strictObject({
    account: z.literal(accountKey),
    descriptor: z.string(),
    stage_id: z.uuid(),
  });

  async function readDownloadCheckpoint(key: string) {
    const saved = await getDatabaseEntry("cache", key);

    if (saved === undefined) return;

    if (isSecureEnvelope(saved)) {
      try {
        return checkpointSchema.parse(await decodeSecureValue(saved));
      } catch (error) {
        signal.throwIfAborted();
        const corrupt =
          error instanceof z.ZodError ||
          error instanceof SyntaxError ||
          (error instanceof DOMException &&
            ["OperationError", "InvalidCharacterError", "DataError"].includes(
              error.name,
            ));

        if (!corrupt) throw error;
      }
    }

    // The record is unusable, but its stage ID is not trusted enough to delete bytes. Key-access failures are not corruption and propagate above without deleting it.
    await deleteDatabaseEntry("cache", key);
  }

  async function prepareDownloadStage(
    checkpointKey: string,
    descriptor: string,
    size: number,
  ) {
    // Retain at most 16 download checkpoints per account. Per-file locks protect active and paused downloads; upload intents are outside this inventory.
    return navigator.locks.request(
      `${downloadPrefix}budget`,
      { signal },
      async () => {
        const entries = await listDatabaseEntries("cache", downloadPrefix);
        let count = entries.length;

        if (!entries.some(([key]) => key === checkpointKey)) {
          for (const [key] of entries) {
            if (count < 16) break;
            const removed = await navigator.locks.request(
              key,
              { ifAvailable: true },
              async (lock) => {
                signal.throwIfAborted();

                if (!lock) return false;
                const checkpoint = await readDownloadCheckpoint(key);

                if (checkpoint) {
                  await removeCiphertextStage(accountKey, checkpoint.stage_id);
                  await deleteDatabaseEntry("cache", key);
                }

                return true;
              },
            );

            if (removed) count--;
          }

          if (count >= 16) throw new Error("Too many active downloads");
        }

        const checkpoint = await readDownloadCheckpoint(checkpointKey);
        let existingId: string | undefined;

        if (checkpoint) {
          if (checkpoint.descriptor === descriptor)
            existingId = checkpoint.stage_id;
          else {
            await removeCiphertextStage(accountKey, checkpoint.stage_id);
            await deleteDatabaseEntry("cache", checkpointKey);
          }
        }

        let staged:
          Awaited<ReturnType<typeof createCiphertextStage>> | undefined;

        if (existingId) {
          try {
            staged = await createCiphertextStage(
              accountKey,
              signal,
              existingId,
            );
          } catch (error) {
            signal.throwIfAborted();

            if (!(
              error instanceof DOMException && error.name === "NotFoundError"
            ))
              throw error;
            await deleteDatabaseEntry("cache", checkpointKey);
          }

          if (
            staged &&
            (staged.size > size ||
              (staged.size !== size && staged.size % (256 * 1024) !== 0))
          ) {
            await staged.stage.abort();
            staged = undefined;
            await deleteDatabaseEntry("cache", checkpointKey);
          }
        }

        staged ??= await createCiphertextStage(accountKey, signal);

        try {
          await setDatabaseEntry(
            "cache",
            checkpointKey,
            await encodeSecureValue({
              account: accountKey,
              descriptor,
              stage_id: staged.id,
            }),
          );
        } catch (error) {
          await staged.stage.abort();

          throw error;
        }

        return staged;
      },
    );
  }

  return async function download(key: FileKey, stage: FileStage) {
    if (!navigator.locks)
      throw new Error("Download recovery requires Web Locks");
    const checkpointKey = `${downloadPrefix}${encodeFileRequest(fileKeySchema.parse(key))}`;

    return navigator.locks.request(checkpointKey, { signal }, async () => {
      let staged: Awaited<ReturnType<typeof createCiphertextStage>> | undefined;
      let retained = false;

      try {
        const response = await manifest(key);

        if (response.state !== "ready" || response.asset_id === null)
          throw new Error("This file's local encrypted replica is not ready");
        const author = await fileAuthor(response.manifest.key.origin);
        signal.throwIfAborted();
        const size = Number(response.manifest.ciphertext_size);

        if (!Number.isSafeInteger(size))
          throw new Error("File size exceeds this platform's range");
        const descriptor = encodeFileRequest({
          key: response.manifest.key,
          asset_id: response.asset_id,
          size: response.manifest.ciphertext_size,
          sha256: response.manifest.ciphertext_sha256,
        });
        staged = await prepareDownloadStage(checkpointKey, descriptor, size);
        retained = true;
        onProgress?.({
          phase: "downloading",
          bytes: BigInt(staged.size),
          total: response.manifest.ciphertext_size,
        });

        for (let offset: number = staged.size; offset < size;) {
          const amount: number = Math.min(256 * 1024, size - offset);
          const chunk: ProtocolMessage<"UserAssetGetChunk"> = await send(
            "UserAssetGetChunk",
            {
              AssetId: response.asset_id,
              Offset: offset,
              Amount: amount,
            },
          );
          signal.throwIfAborted();

          if (
            chunk.type !== "UserAssetGetChunk" ||
            chunk.data.AssetId !== response.asset_id ||
            chunk.data.Offset !== offset ||
            chunk.data.Size !== size ||
            chunk.data.Blob.length !== amount ||
            !chunk.data.Sha256.every(
              (byte, index) =>
                byte === response.manifest.ciphertext_sha256[index],
            )
          )
            throw new Error(
              "File download range does not match its authenticated descriptor",
            );
          await staged.stage.write(chunk.data.Blob);
          offset += amount;
          onProgress?.({
            phase: "downloading",
            bytes: BigInt(offset),
            total: response.manifest.ciphertext_size,
          });
        }

        await staged.stage.commit();
        const ciphertext = await staged.file();
        onProgress?.({
          phase: "verifying",
          bytes: 0n,
          total: response.manifest.ciphertext_size,
        });
        const result = await decryptFileVersion({
          manifest: response.manifest,
          ciphertext,
          recipient: { principal: account, ...owner },
          author,
          stage: {
            ...stage,
            async write(bytes) {
              await waitForForeground(signal);
              await stage.write(bytes);
            },
          },
          signal,
        }).catch(async (error: unknown) => {
          if (!signal.aborted) {
            retained = false;
            await deleteDatabaseEntry("cache", checkpointKey);
          }

          throw error;
        });
        retained = false;
        await deleteDatabaseEntry("cache", checkpointKey);

        return result;
      } catch (error) {
        try {
          await stage.abort();
        } catch {
          /* Preserve the operation's original failure. */
        }

        throw error;
      } finally {
        if (staged && !retained) await staged.stage.abort();
        else if (staged && "suspend" in staged)
          await staged
            .suspend()
            .catch((error: unknown) =>
              log(
                1,
                "files",
                "yellow",
                "Could not retain the latest encrypted download checkpoint",
                error,
              ),
            );
      }
    });
  };
}

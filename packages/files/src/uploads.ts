import {
  encryptFile,
  FILE_CHUNK_BYTES,
  FILE_RECORD_BYTES,
  fileNameSchema,
} from "@tensamin/crypto/file";
import {
  encryptFilePlacementMetadata,
  filePlacementContextSchema,
} from "@tensamin/crypto/fileMetadata";
import {
  encodeFileRequest,
  wireFileManifest,
  wireFilePlacement,
} from "@tensamin/mtp/files/protocol";
import { parseExactJson } from "@tensamin/shared/exactJson";
import { waitForForeground } from "@tensamin/shared/focus";
import {
  deleteDatabaseEntry,
  getDatabaseEntry,
  listDatabaseEntries,
  setDatabaseEntry,
} from "@tensamin/shared/indexedDb";
import { encodePrincipal } from "@tensamin/shared/principal";
import {
  decodeSecureValue,
  encodeSecureValue,
  isSecureEnvelope,
} from "@tensamin/storage/secure";
import { z } from "zod";
import {
  createCiphertextStage,
  loadCiphertextStage,
  removeCiphertextStage,
} from "./staging";
import { createFileRequest, fileOk as ok } from "./transport";
import type { FileTransferContext } from "./types";

const uploadStatus = z.strictObject({
  upload_id: z.uuid(),
  asset_id: z.uuid(),
  size: z.bigint().positive(),
  sha256: z
    .array(z.bigint().min(0n).max(255n))
    .length(32)
    .transform((bytes) => new Uint8Array(bytes.map(Number))),
  offset: z.bigint().nonnegative(),
  state: z.enum(["uploading", "committed"]),
});
const uploadIdentity = {
  account_key: z.string(),
  stage_id: z.uuid(),
  upload_id: z.uuid(),
  filename: fileNameSchema.optional(),
};
const pendingUpload = z.discriminatedUnion("state", [
  z.strictObject({ ...uploadIdentity, state: z.literal("encrypting") }),
  z.strictObject({
    ...uploadIdentity,
    state: z.enum(["ready", "completed"]),
    asset_id: z.uuid(),
    manifest_json: z.string(),
    placement_json: z.string().nullable(),
  }),
]);

export function createFileUploads({
  accountKey,
  account,
  owner,
  send,
  signal,
  onProgress,
  metadataKey,
  request,
}: FileTransferContext & {
  metadataKey: Uint8Array;
  request: ReturnType<typeof createFileRequest>;
}) {
  const prefix = `file-upload:v1:${accountKey}:`;

  async function resumeLocked(uploadId: string) {
    signal.throwIfAborted();
    const stored = await getDatabaseEntry("cache", `${prefix}${uploadId}`);

    if (!isSecureEnvelope(stored))
      throw new Error("Protected pending file upload is unavailable");
    const intent = pendingUpload.parse(await decodeSecureValue(stored));

    if (intent.upload_id !== uploadId || intent.account_key !== accountKey)
      throw new Error("Pending file upload identity does not match");

    if (intent.state === "encrypting") {
      await removeCiphertextStage(accountKey, intent.stage_id);
      await deleteDatabaseEntry("cache", `${prefix}${uploadId}`);

      throw new Error(
        "File encryption was interrupted. Select the original file again.",
      );
    }

    const manifest = wireFileManifest.parse(
      parseExactJson(intent.manifest_json),
    );

    if (
      encodePrincipal(manifest.key.origin) !== encodePrincipal(account) ||
      encodePrincipal(manifest.envelope.recipient) !== encodePrincipal(account)
    )
      throw new Error("Pending file upload belongs to another account");

    if (intent.state === "completed") {
      await removeCiphertextStage(accountKey, intent.stage_id);
      await deleteDatabaseEntry("cache", `${prefix}${uploadId}`);

      return manifest;
    }

    const status = await request(
      "FileUploadStart",
      {
        upload_id: uploadId,
        asset_id: intent.asset_id,
        size: manifest.ciphertext_size,
        sha256: manifest.ciphertext_sha256,
      },
      uploadStatus,
    );

    if (
      status.upload_id !== uploadId ||
      status.asset_id !== intent.asset_id ||
      status.size !== manifest.ciphertext_size ||
      !status.sha256.every(
        (byte, index) => byte === manifest.ciphertext_sha256[index],
      ) ||
      status.offset > status.size ||
      (status.state === "committed" && status.offset !== status.size)
    )
      throw new Error("Upload status does not match the staged file");
    let offset = Number(status.offset);

    if (!Number.isSafeInteger(offset))
      throw new Error("Upload offset exceeds this platform's file range");

    if (status.state !== "committed") {
      onProgress?.({
        phase: "uploading",
        bytes: status.offset,
        total: status.size,
      });
      const file = await loadCiphertextStage(
        accountKey,
        intent.stage_id,
        signal,
      );

      if (BigInt(file.size) !== manifest.ciphertext_size)
        throw new Error("Pending ciphertext size does not match");
      while (offset < file.size) {
        signal.throwIfAborted();
        const chunk = new Uint8Array(
          await file.slice(offset, offset + 256 * 1024).arrayBuffer(),
        );
        const response = await send("UserAssetUploadChunk", {
          UploadId: uploadId,
          Offset: offset,
          Blob: chunk,
        });
        signal.throwIfAborted();

        if (
          response.type !== "UserAssetUploadChunk" ||
          response.data.UploadId !== uploadId ||
          response.data.AssetId !== intent.asset_id ||
          response.data.Offset !== offset + chunk.length ||
          response.data.Size !== file.size ||
          !response.data.Sha256.every(
            (byte, index) => byte === manifest.ciphertext_sha256[index],
          )
        )
          throw new Error("Upload chunk acknowledgement does not match");
        offset = response.data.Offset;
        onProgress?.({
          phase: "uploading",
          bytes: BigInt(offset),
          total: status.size,
        });
      }

      const committed = await send("UserAssetUploadCommit", {
        UploadId: uploadId,
      });
      signal.throwIfAborted();

      if (
        committed.type !== "UserAssetUploadCommit" ||
        committed.data.AssetId !== intent.asset_id ||
        committed.data.Size !== file.size ||
        !committed.data.Sha256.every(
          (byte, index) => byte === manifest.ciphertext_sha256[index],
        )
      )
        throw new Error("Upload commit does not match the staged file");
    }

    onProgress?.({
      phase: "publishing",
      bytes: status.size,
      total: status.size,
    });
    await request(
      "FilePublish",
      {
        manifest,
        asset_id: intent.asset_id,
      },
      ok,
    );

    // Keep the intent until publication is acknowledged so a lost reply resumes the same file and bytes.
    if (intent.placement_json !== null) {
      const placement = wireFilePlacement.parse(
        parseExactJson(intent.placement_json),
      );

      if (
        encodePrincipal(placement.origin) !== encodePrincipal(account) ||
        placement.file_id !== manifest.key.file_id
      )
        throw new Error("Pending placement belongs to another file");
      await request("FilePlacementPut", placement, ok);
    }

    await setDatabaseEntry(
      "cache",
      `${prefix}${uploadId}`,
      await encodeSecureValue({ ...intent, state: "completed" }),
    );
    await removeCiphertextStage(accountKey, intent.stage_id);
    await deleteDatabaseEntry("cache", `${prefix}${uploadId}`);

    return manifest;
  }

  async function resume(uploadId: string) {
    signal.throwIfAborted();
    z.uuid().parse(uploadId);

    if (!navigator.locks)
      throw new Error("File upload recovery requires Web Locks");

    return navigator.locks.request(`${prefix}${uploadId}`, { signal }, () =>
      resumeLocked(uploadId),
    );
  }

  return {
    resume,
    async pending() {
      signal.throwIfAborted();
      const entries = await listDatabaseEntries("cache", prefix);
      signal.throwIfAborted();

      return Promise.all(
        entries.map(async ([key, stored]) => {
          const id = z.uuid().parse(key.slice(prefix.length));

          if (!isSecureEnvelope(stored))
            throw new Error("Protected pending file upload is unavailable");
          const intent = pendingUpload.parse(await decodeSecureValue(stored));

          if (intent.upload_id !== id || intent.account_key !== accountKey)
            throw new Error("Pending file upload identity does not match");

          return { id, filename: intent.filename };
        }),
      );
    },

    async upload({
      file,
      filename,
      mimeType,
      folderId = "private",
      onPrepared,
    }: {
      file: Blob;
      filename: string;
      mimeType: string;
      folderId?: string;
      onPrepared?: (uploadId: string) => void;
    }) {
      const key = {
        origin: account,
        file_id: crypto.randomUUID(),
        version: 1n,
      };
      signal.throwIfAborted();

      if (!navigator.locks)
        throw new Error("File upload recovery requires Web Locks");
      filename = fileNameSchema.parse(filename);
      const uploadId = crypto.randomUUID();

      return navigator.locks.request(
        `${prefix}${uploadId}`,
        { signal },
        async () => {
          const staged = await createCiphertextStage(accountKey, signal);
          let retained = false;

          try {
            await setDatabaseEntry(
              "cache",
              `${prefix}${uploadId}`,
              await encodeSecureValue({
                state: "encrypting",
                account_key: accountKey,
                stage_id: staged.id,
                upload_id: uploadId,
                filename,
              }),
            );
            let encryptedBytes = 0n;
            const encryptedTotal =
              BigInt(Math.max(1, Math.ceil(file.size / FILE_CHUNK_BYTES))) *
              BigInt(FILE_RECORD_BYTES);
            onProgress?.({
              phase: "encrypting",
              bytes: 0n,
              total: encryptedTotal,
            });
            const manifest = await encryptFile({
              key,
              file,
              filename,
              mimeType,
              owner: { ...owner, principal: account },
              stage: {
                ...staged.stage,
                async write(bytes) {
                  await waitForForeground(signal);
                  await staged.stage.write(bytes);
                  encryptedBytes += BigInt(bytes.length);
                  onProgress?.({
                    phase: "encrypting",
                    bytes: encryptedBytes,
                    total: encryptedTotal,
                  });
                },
              },
              signal,
            });
            const placement = filePlacementContextSchema.parse({
              placement_id: crypto.randomUUID(),
              origin: account,
              file_id: key.file_id,
              folder_id: folderId,
              hidden: false,
              revision: 1n,
            });
            const intent = pendingUpload.parse({
              state: "ready",
              account_key: accountKey,
              stage_id: staged.id,
              upload_id: uploadId,
              filename,
              asset_id: crypto.randomUUID(),
              manifest_json: encodeFileRequest(manifest),
              placement_json: encodeFileRequest({
                ...placement,
                encrypted_metadata: await encryptFilePlacementMetadata({
                  key: metadataKey,
                  account,
                  placement,
                  metadata: {},
                }),
              }),
            });
            signal.throwIfAborted();
            await setDatabaseEntry(
              "cache",
              `${prefix}${uploadId}`,
              await encodeSecureValue(intent),
            );
            retained = true;
            onPrepared?.(uploadId);
            signal.throwIfAborted();

            return await resumeLocked(uploadId);
          } finally {
            if (!retained) {
              await staged.stage.abort();
              await deleteDatabaseEntry("cache", `${prefix}${uploadId}`);
            }
          }
        },
      );
    },
  };
}

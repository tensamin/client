import { z } from "zod";
import { createPrincipalProofResolver } from "@tensamin/mtp/principalProof";
import { createFileAuthorResolver } from "@tensamin/mtp/fileSigningKey";
import type { BoundSendFn, ProtocolMessage } from "@tensamin/mtp";
import { requireRelaySuccess } from "@tensamin/mtp/relayResult";
import type { PrincipalRelaySend } from "@tensamin/mtp/principalRelay";
import {
  deriveChatId,
  encodePrincipal,
  parsePrincipal,
  type WirePrincipal,
} from "@tensamin/shared/principal";
import { parseExactJson } from "@tensamin/shared/exactJson";
import {
  getDatabaseEntry,
  setDatabaseEntry,
  deleteDatabaseEntry,
  listDatabaseEntries,
} from "@tensamin/shared/indexedDb";
import {
  encodeSecureValue,
  decodeSecureValue,
  isSecureEnvelope,
} from "@tensamin/storage/secure";
import {
  fileShareOfferSchema,
  fileShareRevokeSchema,
  signFileShareOffer,
  signFileShareRevoke,
  verifyFileShareOffer,
} from "@tensamin/crypto/fileSharing";
import {
  encryptFileVersion,
  encryptFileManifest,
  decryptFileVersion,
  openFileManifest,
  unwrapFileKey,
  wrapFileKey,
  fileKeySchema,
  type FileKey,
  type FileAuthor,
  type FileStage,
} from "@tensamin/crypto/file";
import {
  decodeFileResponse,
  encodeFileRequest,
  wireFileManifest,
  fileManifestResponse,
  wireFilePlacement,
  wireFileFolder,
  wireFileShareGrant,
  wireFileEnvelope,
  fileBytes,
} from "@tensamin/mtp/files/protocol";
import {
  deriveFileAccountMetadataKey,
  encryptFilePlacementMetadata,
  filePlacementContextSchema,
  fileFolderContextSchema,
  encryptFileFolderName,
  decryptFileFolderName,
  decryptFilePlacementMetadata,
} from "@tensamin/crypto/fileMetadata";
import {
  createCiphertextStage,
  loadCiphertextStage,
  removeCiphertextStage,
} from "./staging";
import {
  createFileJournal,
  fileChangesPageSchema,
} from "@tensamin/mtp/files/journal";
import { createFileCommands } from "./commands";
import { bytesToBase64 } from "mtp";

const ok = z.strictObject({ ok: z.literal(true) });
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

export function createFileService({
  accountKey,
  account,
  owner,
  send,
  sendRelay,
  signal,
  resolveAuthor,
  resolveActive = createPrincipalProofResolver({ accountKey, send, signal }),
}: {
  accountKey: string;
  account: WirePrincipal;
  owner: { keyId: string; keyring: Uint8Array; publicKey: Uint8Array };
  send: BoundSendFn;
  sendRelay: PrincipalRelaySend;
  signal: AbortSignal;
  resolveAuthor?: (principal: WirePrincipal) => Promise<FileAuthor>;
  resolveActive?: ReturnType<typeof createPrincipalProofResolver>;
}) {
  signal.throwIfAborted();
  const fileAuthor = createFileAuthorResolver({ send, signal, resolveAuthor });
  const metadataKey = deriveFileAccountMetadataKey(owner.keyring, account);
  signal.addEventListener("abort", () => metadataKey.fill(0), { once: true });
  const prefix = `file-upload:v1:${accountKey}:`;
  const commands = createFileCommands({ accountKey, send, signal });
  async function request<T>(
    type:
      | "FileUploadStart"
      | "FileVersionPublish"
      | "FileGetManifest"
      | "FileReplicaAccept"
      | "FileReplicaCancel"
      | "FileChangesGet"
      | "FilePlacementPut"
      | "FileFolderPut"
      | "FileFolderDelete"
      | "FilePlacementDelete"
      | "FileListPage",
    body: unknown,
    schema: z.ZodType<T>,
  ) {
    signal.throwIfAborted();
    const response = await send(type, { Json: encodeFileRequest(body) });
    signal.throwIfAborted();
    if (response.type !== type)
      throw new Error(`File operation failed: ${response.type}`);
    return decodeFileResponse(response.data.Json, schema);
  }

  const journal = createFileJournal({
    accountKey,
    account,
    signal,
    resolveAuthor: (principal, signingPublicKey) =>
      fileAuthor(principal, signingPublicKey),
    fetch: (after, upper) =>
      request("FileChangesGet", { after, upper }, fileChangesPageSchema),
  });

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
    const file = await loadCiphertextStage(accountKey, intent.stage_id, signal);
    if (BigInt(file.size) !== manifest.ciphertext_size)
      throw new Error("Pending ciphertext size does not match");
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
      status.offset > status.size
    )
      throw new Error("Upload status does not match the staged file");
    let offset = Number(status.offset);
    if (!Number.isSafeInteger(offset))
      throw new Error("Upload offset exceeds this platform's file range");
    if (status.state !== "committed") {
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
    await request(
      "FileVersionPublish",
      {
        manifest,
        asset_id: intent.asset_id,
        expected_predecessor: manifest.key.version - 1n,
      },
      ok,
    );
    // Publication is idempotent. Keep the intent until it is acknowledged, so a
    // lost reply resumes the same version and bytes rather than creating another.
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

  async function manifest(key: FileKey) {
    key = fileKeySchema.parse(key);
    await journal.synchronize();
    const response = await request(
      "FileGetManifest",
      key,
      fileManifestResponse,
    );
    if (
      encodeFileRequest(response.manifest.key) !== encodeFileRequest(key) ||
      encodePrincipal(response.manifest.envelope.recipient) !==
        encodePrincipal(account)
    )
      throw new Error(
        "File manifest does not match the requested account and version",
      );
    if (encodePrincipal(key.origin) !== encodePrincipal(account)) {
      if (!response.proof)
        throw new Error("Received file has no signed share proof");
      const author = await fileAuthor(
        key.origin,
        response.proof.signing_public_key,
      );
      signal.throwIfAborted();
      const proof = verifyFileShareOffer(response.proof, {
        author,
        recipient: account,
        chatId: deriveChatId(key.origin, account),
        now: BigInt(Date.now()),
      });
      const fence = await journal.grant(key, account);
      if (
        fence &&
        (fence.payload.grant_revision > proof.grant_revision ||
          (fence.kind === "share_revoked" &&
            fence.payload.grant_revision >= proof.grant_revision))
      )
        throw new Error("File share proof has been superseded or revoked");
      // This account may have replaced its own envelope after key rotation. The
      // author's immutable content descriptor must still match the signed offer.
      if (
        encodeFileRequest({
          ...proof.manifest,
          envelope: response.manifest.envelope,
        }) !== encodeFileRequest(response.manifest)
      )
        throw new Error(
          "File descriptor does not match its signed share proof",
        );
    }
    return response;
  }

  return {
    synchronize: journal.synchronize,
    pendingCommands: commands.pending,
    resumeCommand: commands.resume,
    reconcileCommand(resource: string) {
      return commands.reconcile(resource, async (type, text) => {
        if (type === "FileFolderPut" || type === "FileFolderDelete") {
          await journal.synchronize();
          const desired =
            type === "FileFolderPut"
              ? decodeFileResponse(text, wireFileFolder)
              : decodeFileResponse(
                  text,
                  z.strictObject({
                    id: fileFolderContextSchema.shape.folder_id,
                    expected_revision: fileFolderContextSchema.shape.revision,
                  }),
                );
          const current = await journal.folder(
            "folder_id" in desired ? desired.folder_id : desired.id,
          );
          if (!current) return "unknown";
          if (current.kind === "folder_deleted")
            return type === "FileFolderDelete" ? "resolved" : "superseded";
          const { encrypted_name, ...folder } = current.payload;
          await decryptFileFolderName({
            key: metadataKey,
            account,
            folder,
            ciphertext: encrypted_name,
          });
          if ("folder_id" in desired) {
            if (
              encodeFileRequest(current.payload) === encodeFileRequest(desired)
            )
              return "resolved";
            return folder.revision >= desired.revision
              ? "superseded"
              : "unknown";
          }
          return folder.revision > desired.expected_revision
            ? "superseded"
            : "unknown";
        }
        if (type === "FilePlacementPut" || type === "FilePlacementDelete") {
          await journal.synchronize();
          const desired =
            type === "FilePlacementPut"
              ? decodeFileResponse(text, wireFilePlacement)
              : decodeFileResponse(
                  text,
                  z.strictObject({
                    id: filePlacementContextSchema.shape.placement_id,
                    expected_revision:
                      filePlacementContextSchema.shape.revision,
                  }),
                );
          const current = await journal.placement(
            "placement_id" in desired ? desired.placement_id : desired.id,
          );
          if (!current) return "unknown";
          if (current.kind === "placement_deleted")
            return type === "FilePlacementDelete" ? "resolved" : "superseded";
          const { encrypted_metadata, ...placement } = current.payload;
          await decryptFilePlacementMetadata({
            key: metadataKey,
            account,
            placement,
            ciphertext: encrypted_metadata,
          });
          if ("placement_id" in desired) {
            if (
              encodeFileRequest(current.payload) === encodeFileRequest(desired)
            )
              return "resolved";
            return placement.revision >= desired.revision
              ? "superseded"
              : "unknown";
          }
          return placement.revision > desired.expected_revision
            ? "superseded"
            : "unknown";
        }
        if (type === "FileKeyEnvelopePut") {
          const desired = decodeFileResponse(
            text,
            z.strictObject({
              key: fileKeySchema,
              expected_key_id: z.string(),
              envelope: wireFileEnvelope,
            }),
          );
          const current = await manifest(desired.key);
          if (
            encodeFileRequest(current.manifest.envelope) ===
            encodeFileRequest(desired.envelope)
          )
            return "resolved";
          // This only classifies the pending mutation. It does not prove that
          // the replacement envelope opens or permit deleting an old keyring.
          return current.manifest.envelope.key_id !== desired.expected_key_id
            ? "superseded"
            : "unknown";
        }
        const desired = decodeFileResponse(
          text,
          z.strictObject({
            key: fileKeySchema,
            expected_revision: fileManifestResponse.shape.metadata_revision,
            manifest_ciphertext: fileBytes,
          }),
        );
        const current = await manifest(desired.key);
        const author = await fileAuthor(desired.key.origin);
        const dek = await unwrapFileKey({
          key: desired.key,
          envelope: current.manifest.envelope,
          recipient: account,
          keyId: owner.keyId,
          keyring: owner.keyring,
        });
        try {
          await openFileManifest({ manifest: current.manifest, dek, author });
        } finally {
          dek.fill(0);
        }
        if (
          encodeFileRequest(current.manifest.manifest_ciphertext) ===
          encodeFileRequest(desired.manifest_ciphertext)
        )
          return "resolved";
        return current.metadata_revision > desired.expected_revision
          ? "superseded"
          : "unknown";
      });
    },
    async folders(parentFolderId = "private", after = 0n) {
      const page = await request(
        "FileListPage",
        { namespace: "folders", folder_id: parentFolderId, after },
        z.strictObject({
          items: z.array(wireFileFolder).max(64),
          next: z.bigint().positive().nullable(),
        }),
      );
      const items = await Promise.all(
        page.items.map(async ({ encrypted_name, ...folder }) => {
          if (folder.parent_folder_id !== parentFolderId)
            throw new Error("Folder listing contains another parent");
          const name = await decryptFileFolderName({
            key: metadataKey,
            account,
            folder,
            ciphertext: encrypted_name,
          });
          signal.throwIfAborted();
          return { ...folder, name };
        }),
      );
      return { items, next: page.next };
    },
    async putFolder({
      name,
      folderId = crypto.randomUUID(),
      parentFolderId = "private",
      revision = 1n,
    }: {
      name: string;
      folderId?: string;
      parentFolderId?: string;
      revision?: bigint;
    }) {
      const folder = fileFolderContextSchema.parse({
        folder_id: folderId,
        parent_folder_id: parentFolderId,
        revision,
      });
      await commands.run(
        `folder:${folder.folder_id}`,
        "FileFolderPut",
        async () => ({
          ...folder,
          encrypted_name: await encryptFileFolderName({
            key: metadataKey,
            account,
            folder,
            name,
          }),
        }),
      );
      return { ...folder, name };
    },
    async deleteFolder(folderId: string, expectedRevision: bigint) {
      await commands.run(
        `folder:${fileFolderContextSchema.shape.folder_id.parse(folderId)}`,
        "FileFolderDelete",
        async () => ({
          id: fileFolderContextSchema.shape.folder_id.parse(folderId),
          expected_revision:
            fileFolderContextSchema.shape.revision.parse(expectedRevision),
        }),
      );
    },
    async placements(folderId = "private", after = 0n) {
      const page = await request(
        "FileListPage",
        { namespace: "private", folder_id: folderId, after },
        z.strictObject({
          items: z.array(wireFilePlacement).max(64),
          next: z.bigint().positive().nullable(),
        }),
      );
      const items = await Promise.all(
        page.items.map(async ({ encrypted_metadata, ...placement }) => {
          if (placement.folder_id !== folderId)
            throw new Error("Placement listing contains another folder");
          const metadata = await decryptFilePlacementMetadata({
            key: metadataKey,
            account,
            placement,
            ciphertext: encrypted_metadata,
          });
          signal.throwIfAborted();
          return { ...placement, metadata };
        }),
      );
      return { items, next: page.next };
    },
    async putPlacement(
      placement: z.output<typeof filePlacementContextSchema>,
      metadata: { filename?: string } = {},
    ) {
      placement = filePlacementContextSchema.parse(placement);
      await commands.run(
        `placement:${placement.placement_id}`,
        "FilePlacementPut",
        async () => ({
          ...placement,
          encrypted_metadata: await encryptFilePlacementMetadata({
            key: metadataKey,
            account,
            placement,
            metadata,
          }),
        }),
      );
      return { ...placement, metadata };
    },
    async deletePlacement(placementId: string, expectedRevision: bigint) {
      await commands.run(
        `placement:${filePlacementContextSchema.shape.placement_id.parse(placementId)}`,
        "FilePlacementDelete",
        async () => ({
          id: filePlacementContextSchema.shape.placement_id.parse(placementId),
          expected_revision:
            filePlacementContextSchema.shape.revision.parse(expectedRevision),
        }),
      );
    },
    async versions(fileId: string, origin = account, after = 0n) {
      origin = fileKeySchema.shape.origin.parse(origin);
      fileId = fileKeySchema.shape.file_id.parse(fileId);
      const page = await request(
        "FileListPage",
        { namespace: "versions", folder_id: fileId, origin, after },
        z.strictObject({
          items: z.array(wireFileManifest).max(64),
          next: z.bigint().positive().nullable(),
        }),
      );
      for (const item of page.items)
        if (
          item.key.file_id !== fileId ||
          encodePrincipal(item.key.origin) !== encodePrincipal(origin)
        )
          throw new Error("Version listing contains another file");
      return page;
    },
    async shares(fileId: string, origin = account, after = 0n) {
      origin = fileKeySchema.shape.origin.parse(origin);
      fileId = fileKeySchema.shape.file_id.parse(fileId);
      const page = await request(
        "FileListPage",
        { namespace: "shares", folder_id: fileId, origin, after },
        z.strictObject({
          items: z.array(wireFileShareGrant).max(64),
          next: z.bigint().positive().nullable(),
        }),
      );
      for (const grant of page.items) {
        if (
          grant.key.file_id !== fileId ||
          encodePrincipal(grant.key.origin) !== encodePrincipal(origin) ||
          grant.chat_id !== deriveChatId(grant.key.origin, grant.recipient)
        )
          throw new Error(
            "Share listing contains another file or conversation",
          );
      }
      return page;
    },
    resume,
    async pending() {
      signal.throwIfAborted();
      const entries = await listDatabaseEntries("cache", prefix);
      signal.throwIfAborted();
      return entries.map(([key]) => z.uuid().parse(key.slice(prefix.length)));
    },
    async upload({
      file,
      filename,
      mimeType,
      key = { origin: account, file_id: crypto.randomUUID(), version: 1n },
      folderId = "private",
    }: {
      file: Blob;
      filename: string;
      mimeType: string;
      key?: FileKey;
      folderId?: string;
    }) {
      signal.throwIfAborted();
      if (!navigator.locks)
        throw new Error("File upload recovery requires Web Locks");
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
              }),
            );
            const manifest = await encryptFileVersion({
              key,
              file,
              filename,
              mimeType,
              owner: { ...owner, principal: account },
              stage: staged.stage,
              signal,
            });
            const placement =
              key.version === 1n
                ? filePlacementContextSchema.parse({
                    placement_id: crypto.randomUUID(),
                    origin: account,
                    file_id: key.file_id,
                    folder_id: folderId,
                    hidden: false,
                    revision: 1n,
                  })
                : null;
            const intent = pendingUpload.parse({
              state: "ready",
              account_key: accountKey,
              stage_id: staged.id,
              upload_id: uploadId,
              asset_id: crypto.randomUUID(),
              manifest_json: encodeFileRequest(manifest),
              placement_json:
                placement === null
                  ? null
                  : encodeFileRequest({
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
    manifest,
    async share({
      key,
      recipient,
      grantRevision,
      expiresAt,
    }: {
      key: FileKey;
      recipient: { principal: WirePrincipal; keyId: string };
      grantRevision: bigint;
      expiresAt: bigint;
    }) {
      signal.throwIfAborted();
      key = fileKeySchema.parse(key);
      const target = fileKeySchema.shape.origin.parse(recipient.principal);
      const peer = parsePrincipal(encodePrincipal(target));
      fileShareOfferSchema.shape.grant_revision.parse(grantRevision);
      fileShareOfferSchema.shape.expires_at.parse(expiresAt);
      if (
        encodePrincipal(key.origin) !== encodePrincipal(account) ||
        encodePrincipal(target) === encodePrincipal(account)
      )
        throw new Error(
          "Only the author can share a file with another principal",
        );
      if (expiresAt <= BigInt(Date.now()))
        throw new Error("File share expiry must be in the future");
      const [response, author, self, verifiedRecipient] = await Promise.all([
        manifest(key),
        fileAuthor(key.origin),
        resolveActive(account),
        resolveActive(target),
      ]);
      signal.throwIfAborted();
      if (
        encodePrincipal(self.principal) !== encodePrincipal(account) ||
        !self.publicKeys.some(
          (key) => bytesToBase64(key) === bytesToBase64(owner.publicKey),
        )
      )
        throw new Error(
          "Current file signing key is not active for the author",
        );
      if (
        encodePrincipal(verifiedRecipient.principal) !==
          encodePrincipal(target) ||
        verifiedRecipient.publicKeys.length !== 1
      )
        throw new Error(
          "File recipient must have exactly one authenticated active key",
        );
      const dek = await unwrapFileKey({
        key,
        envelope: response.manifest.envelope,
        recipient: account,
        keyId: owner.keyId,
        keyring: owner.keyring,
      });
      try {
        await openFileManifest({ manifest: response.manifest, dek, author });
        const envelope = await wrapFileKey({
          key,
          dek,
          recipient: target,
          keyId: recipient.keyId,
          publicKey: verifiedRecipient.publicKeys[0],
        });
        const offer = signFileShareOffer({
          manifest: { ...response.manifest, envelope },
          grantRevision,
          expiresAt,
          author: { principal: account, ...owner },
        });
        signal.throwIfAborted();
        if (expiresAt <= BigInt(Date.now()))
          throw new Error("File share expired during preparation");
        requireRelaySuccess(
          await sendRelay(peer, "FileShareOffered", {
            Json: encodeFileRequest(offer),
          }),
        );
        signal.throwIfAborted();
        return offer;
      } finally {
        dek.fill(0);
      }
    },
    async revoke({
      key,
      recipient,
      grantRevision,
    }: {
      key: FileKey;
      recipient: WirePrincipal;
      grantRevision: bigint;
    }) {
      signal.throwIfAborted();
      key = fileKeySchema.parse(key);
      recipient = fileKeySchema.shape.origin.parse(recipient);
      const peer = parsePrincipal(encodePrincipal(recipient));
      fileShareRevokeSchema.shape.grant_revision.parse(grantRevision);
      if (
        encodePrincipal(key.origin) !== encodePrincipal(account) ||
        encodePrincipal(recipient) === encodePrincipal(account)
      )
        throw new Error(
          "Only the author can revoke a file grant to another principal",
        );
      const self = await resolveActive(account);
      signal.throwIfAborted();
      if (
        encodePrincipal(self.principal) !== encodePrincipal(account) ||
        !self.publicKeys.some(
          (key) => bytesToBase64(key) === bytesToBase64(owner.publicKey),
        )
      )
        throw new Error(
          "Current file signing key is not active for the author",
        );
      const revoke = signFileShareRevoke({
        key,
        recipient,
        grantRevision,
        author: { principal: account, ...owner },
      });
      requireRelaySuccess(
        await sendRelay(peer, "FileShareRevoked", {
          Json: encodeFileRequest(revoke),
        }),
      );
      signal.throwIfAborted();
      return revoke;
    },
    async rename(key: FileKey, filename: string) {
      key = fileKeySchema.parse(key);
      if (encodePrincipal(key.origin) !== encodePrincipal(account))
        throw new Error("Only the author can rename a file manifest");
      await commands.run(
        `metadata:${encodeFileRequest(key)}`,
        "FileMetadataPut",
        async () => {
          const response = await manifest(key);
          const [author, active] = await Promise.all([
            fileAuthor(key.origin),
            resolveActive(account),
          ]);
          if (
            encodePrincipal(active.principal) !== encodePrincipal(account) ||
            !active.publicKeys.some(
              (key) => bytesToBase64(key) === bytesToBase64(owner.publicKey),
            )
          )
            throw new Error(
              "Current file signing key is not authenticated for the author",
            );
          const dek = await unwrapFileKey({
            key,
            envelope: response.manifest.envelope,
            recipient: account,
            keyId: owner.keyId,
            keyring: owner.keyring,
          });
          try {
            const metadata = await openFileManifest({
              manifest: response.manifest,
              dek,
              author,
            });
            const manifest_ciphertext = await encryptFileManifest({
              key,
              dek,
              metadata: {
                ...metadata,
                filename,
                updated_at: Date.now().toString(),
              },
              ciphertextHash: response.manifest.ciphertext_sha256,
              ciphertextSize: response.manifest.ciphertext_size,
              authorKeyring: owner.keyring,
              authorPublicKey: owner.publicKey,
            });
            return {
              key,
              expected_revision: response.metadata_revision,
              manifest_ciphertext,
            };
          } finally {
            dek.fill(0);
          }
        },
      );
    },
    async rewrap(
      key: FileKey,
      target: { keyId: string; publicKey: Uint8Array },
    ) {
      key = fileKeySchema.parse(key);
      target = {
        keyId: target.keyId,
        publicKey: new Uint8Array(target.publicKey),
      };
      await commands.run(
        `envelope:${encodeFileRequest(key)}`,
        "FileKeyEnvelopePut",
        async () => {
          const response = await manifest(key);
          const [author, recipient] = await Promise.all([
            fileAuthor(key.origin),
            resolveActive(account),
          ]);
          if (
            encodePrincipal(recipient.principal) !== encodePrincipal(account) ||
            !recipient.publicKeys.some(
              (key) => bytesToBase64(key) === bytesToBase64(target.publicKey),
            )
          )
            throw new Error(
              "Replacement file key is not authenticated for this account",
            );
          const dek = await unwrapFileKey({
            key,
            envelope: response.manifest.envelope,
            recipient: account,
            keyId: owner.keyId,
            keyring: owner.keyring,
          });
          try {
            await openFileManifest({
              manifest: response.manifest,
              dek,
              author,
            });
            return {
              key,
              expected_key_id: response.manifest.envelope.key_id,
              envelope: await wrapFileKey({
                key,
                dek,
                recipient: account,
                keyId: target.keyId,
                publicKey: target.publicKey,
              }),
            };
          } finally {
            dek.fill(0);
          }
        },
      );
    },
    async metadata(key: FileKey) {
      const response = await manifest(key);
      const author = await fileAuthor(response.manifest.key.origin);
      signal.throwIfAborted();
      const dek = await unwrapFileKey({
        key: response.manifest.key,
        envelope: response.manifest.envelope,
        recipient: account,
        keyId: owner.keyId,
        keyring: owner.keyring,
      });
      try {
        const metadata = await openFileManifest({
          manifest: response.manifest,
          dek,
          author,
        });
        signal.throwIfAborted();
        return metadata;
      } finally {
        dek.fill(0);
      }
    },
    async download(key: FileKey, stage: FileStage) {
      let staged: Awaited<ReturnType<typeof createCiphertextStage>> | undefined;
      try {
        const response = await manifest(key);
        if (response.state !== "ready" || response.asset_id === null)
          throw new Error("This file's local encrypted replica is not ready");
        const author = await fileAuthor(response.manifest.key.origin);
        signal.throwIfAborted();
        const size = Number(response.manifest.ciphertext_size);
        if (!Number.isSafeInteger(size))
          throw new Error("File size exceeds this platform's range");
        staged = await createCiphertextStage(accountKey, signal);
        for (let offset: number = 0; offset < size;) {
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
        }
        await staged.stage.commit();
        const ciphertext = await staged.file();
        return await decryptFileVersion({
          manifest: response.manifest,
          ciphertext,
          recipient: { principal: account, ...owner },
          author,
          stage,
          signal,
        });
      } catch (error) {
        try {
          await stage.abort();
        } catch {
          /* Preserve the operation's original failure. */
        }
        throw error;
      } finally {
        if (staged) await staged.stage.abort();
      }
    },
    async accept(key: FileKey) {
      await manifest(key);
      await request("FileReplicaAccept", fileKeySchema.parse(key), ok);
    },
    async cancel(key: FileKey) {
      await request("FileReplicaCancel", fileKeySchema.parse(key), ok);
    },
  };
}

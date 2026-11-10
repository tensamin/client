import {
  fileKeySchema,
  openFileManifest,
  unwrapFileKey,
  type FileAuthor,
  type FileKey,
} from "@tensamin/crypto/file";
import {
  decryptFileFolderName,
  decryptFilePlacementMetadata,
  deriveFileAccountMetadataKey,
  encryptFileFolderName,
  encryptFilePlacementMetadata,
  fileFolderContextSchema,
  filePlacementContextSchema,
} from "@tensamin/crypto/fileMetadata";
import type { BoundSendFn } from "@tensamin/mtp";
import {
  createFileJournal,
  fileChangesPageSchema,
} from "@tensamin/mtp/files/journal";
import {
  decodeFileResponse,
  encodeFileRequest,
  fileBytes,
  fileManifestResponse,
  wireFileEnvelope,
  wireFileFolder,
  wireFileManifest,
  wireFilePlacement,
  wireFileShareGrant,
} from "@tensamin/mtp/files/protocol";
import { createFileAuthorResolver } from "@tensamin/mtp/fileSigningKey";
import { createPrincipalProofResolver } from "@tensamin/mtp/principalProof";
import type { PrincipalRelaySend } from "@tensamin/mtp/principalRelay";
import { waitForForeground } from "@tensamin/shared/focus";
import {
  deriveChatId,
  encodePrincipal,
  type WirePrincipal,
} from "@tensamin/shared/principal";
import { z } from "zod";
import { createFileCommands } from "./commands";
import { createFileDownload } from "./downloads";
import { createFileMetadata } from "./metadata";
import { createFileSharing } from "./sharing";
import { createFileRequest, fileOk as ok } from "./transport";
import type { FileTransferContext } from "./types";
import { createFileUploads } from "./uploads";

export function createFileService({
  accountKey,
  account,
  owner,
  send: transport,
  sendRelay: relayTransport,
  signal,
  onProgress,
  resolveAuthor,
  resolveActive,
}: FileTransferContext & {
  sendRelay: PrincipalRelaySend;
  resolveAuthor?: (principal: WirePrincipal) => Promise<FileAuthor>;
  resolveActive?: ReturnType<typeof createPrincipalProofResolver>;
}) {
  const send: BoundSendFn = async (...args) => {
    await waitForForeground(signal);

    return transport(...args);
  };

  const sendRelay: PrincipalRelaySend = async (...args) => {
    await waitForForeground(signal);

    return relayTransport(...args);
  };

  resolveActive ??= createPrincipalProofResolver({ accountKey, send, signal });
  signal.throwIfAborted();
  const fileAuthor = createFileAuthorResolver({ send, signal, resolveAuthor });
  const metadataKey = deriveFileAccountMetadataKey(owner.keyring, account);
  signal.addEventListener("abort", () => metadataKey.fill(0), { once: true });
  const request = createFileRequest({ send, signal });

  const commands = createFileCommands({ accountKey, send, signal });
  const journal = createFileJournal({
    accountKey,
    account,
    signal,
    resolveAuthor: (principal, signingPublicKey) =>
      fileAuthor(principal, signingPublicKey),
    fetch: (after, upper) =>
      request("FileChangesGet", { after, upper }, fileChangesPageSchema),
  });

  const metadata = createFileMetadata({
    account,
    owner,
    signal,
    journal,
    fileAuthor,
    resolveActive,
    commands,
    request,
  });
  const { manifest } = metadata;

  const sharing = createFileSharing({
    account,
    owner,
    signal,
    fileAuthor,
    resolveActive,
    manifest,
    sendRelay,
  });

  const uploads = createFileUploads({
    accountKey,
    account,
    owner,
    send,
    signal,
    onProgress,
    metadataKey,
    request,
  });

  const download = createFileDownload({
    accountKey,
    account,
    owner,
    send,
    signal,
    onProgress,
    manifest,
    fileAuthor,
  });

  const service = {
    ...uploads,
    ...metadata,
    ...sharing,
    download,
    async latestVersion(...args: Parameters<typeof journal.latestVersion>) {
      await journal.synchronize();

      return journal.latestVersion(...args);
    },
    synchronize: journal.synchronize,
    pendingCommands: commands.pending,
    resumeCommand: commands.resume,
    reconcileCommand(resource: string) {
      return commands.reconcile(resource, async (type, text) => {
        if (type === "FileDelete") {
          const desired = decodeFileResponse(
            text,
            z.strictObject({ file_id: fileKeySchema.shape.file_id }),
          );
          await journal.synchronize();

          return (await journal.deleted(account, desired.file_id))
            ? "resolved"
            : "unknown";
        }

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

          // This only classifies the pending mutation. It does not prove that the replacement envelope opens or permit deleting an old keyring.
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
    async chat(peer: WirePrincipal, after = 0n) {
      peer = fileKeySchema.shape.origin.parse(peer);
      const chatId = deriveChatId(account, peer);
      const page = await request(
        "FileListPage",
        {
          namespace: `chat:${chatId}`,
          folder_id: "private",
          after,
        },
        z.strictObject({
          items: z.array(wireFileManifest).max(64),
          next: z.bigint().positive().nullable(),
        }),
      );

      for (const item of page.items)
        if (deriveChatId(item.key.origin, item.envelope.recipient) !== chatId)
          throw new Error("Chat file listing contains another conversation");

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
    async deleteFile(fileId: string): Promise<void> {
      fileId = fileKeySchema.shape.file_id.parse(fileId);
      let after = 0n;

      for (;;) {
        const page = await service.shares(fileId, account, after);

        for (const grant of page.items) {
          if (
            (grant.state === "offered" || grant.state === "accepted") &&
            grant.expires_at > BigInt(Date.now())
          )
            await service.revoke({
              key: grant.key,
              recipient: grant.recipient,
              grantRevision: grant.grant_revision + 1n,
            });
        }

        if (page.next === null) break;

        if (page.next <= after)
          throw new Error("File grant listing did not advance");
        after = page.next;
      }

      // Iota checks active grants again in its deletion transaction. A concurrent new grant therefore refuses deletion rather than bypassing revocation.
      await commands.run(`file:${fileId}`, "FileDelete", async () => ({
        file_id: fileId,
      }));
    },
    async accept(key: FileKey) {
      // The authoritative acceptance transaction validates the stored grant. A cancelled replica may reject manifest reads until it is reaccepted.
      await request("FileReplicaAccept", fileKeySchema.parse(key), ok);
    },
    async cancel(key: FileKey) {
      await request("FileReplicaCancel", fileKeySchema.parse(key), ok);
    },
  };

  return service;
}

import {
  encryptFileManifest,
  fileKeySchema,
  openFileManifest,
  unwrapFileKey,
  wrapFileKey,
  type FileKey,
} from "@tensamin/crypto/file";
import { verifyFileShareOffer } from "@tensamin/crypto/fileSharing";
import { createFileJournal } from "@tensamin/mtp/files/journal";
import {
  encodeFileRequest,
  fileManifestResponse,
} from "@tensamin/mtp/files/protocol";
import { createFileAuthorResolver } from "@tensamin/mtp/fileSigningKey";
import { createPrincipalProofResolver } from "@tensamin/mtp/principalProof";
import { deriveChatId, encodePrincipal } from "@tensamin/shared/principal";
import { bytesToBase64 } from "mtp";
import { createFileCommands } from "./commands";
import { createFileRequest } from "./transport";
import type { FileTransferContext } from "./types";

export function createFileMetadata({
  account,
  owner,
  signal,
  journal,
  fileAuthor,
  resolveActive,
  commands,
  request,
}: Pick<FileTransferContext, "account" | "owner" | "signal"> & {
  journal: ReturnType<typeof createFileJournal>;
  fileAuthor: ReturnType<typeof createFileAuthorResolver>;
  resolveActive: ReturnType<typeof createPrincipalProofResolver>;
  commands: ReturnType<typeof createFileCommands>;
  request: ReturnType<typeof createFileRequest>;
}) {
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

      if (
        fence?.kind === "share_offered" &&
        fence.payload.grant_revision === proof.grant_revision &&
        encodeFileRequest(fence.payload) !== encodeFileRequest(proof)
      )
        throw new Error(
          "File share revision contains conflicting signed offers",
        );

      // This account may have replaced its own envelope after key rotation. The author's immutable content descriptor must still match the signed offer.
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
    manifest,
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
  };
}

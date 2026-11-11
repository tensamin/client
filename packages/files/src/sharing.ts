import {
  fileKeySchema,
  openFileManifest,
  unwrapFileKey,
  wrapFileKey,
  type FileKey,
} from "@tensamin/crypto/file";
import {
  fileShareOfferSchema,
  fileShareRevokeSchema,
  signFileShareOffer,
  signFileShareRevoke,
} from "@tensamin/crypto/fileSharing";
import { encodeFileRequest } from "@tensamin/mtp/files/protocol";
import { createFileAuthorResolver } from "@tensamin/mtp/fileSigningKey";
import { createPrincipalProofResolver } from "@tensamin/mtp/principalProof";
import type { PrincipalRelaySend } from "@tensamin/mtp/principalRelay";
import { requireRelaySuccess } from "@tensamin/mtp/relayResult";
import {
  encodePrincipal,
  parsePrincipal,
  type WirePrincipal,
} from "@tensamin/shared/principal";
import { bytesToBase64, crypto as mtpCrypto } from "mtp";
import { createFileMetadata } from "./metadata";
import type { FileTransferContext } from "./types";

export function createFileSharing({
  account,
  owner,
  signal,
  fileAuthor,
  resolveActive,
  manifest,
  sendRelay,
}: Pick<FileTransferContext, "account" | "owner" | "signal"> & {
  fileAuthor: ReturnType<typeof createFileAuthorResolver>;
  resolveActive: ReturnType<typeof createPrincipalProofResolver>;
  manifest: ReturnType<typeof createFileMetadata>["manifest"];
  sendRelay: PrincipalRelaySend;
}) {
  return {
    async share({
      key,
      recipient,
      grantRevision,
      expiresAt,
    }: {
      key: FileKey;
      recipient: WirePrincipal;
      grantRevision: bigint;
      expiresAt: bigint;
    }) {
      signal.throwIfAborted();
      key = fileKeySchema.parse(key);
      const target = fileKeySchema.shape.origin.parse(recipient);
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
          keyId: Array.from(
            mtpCrypto.sha256(verifiedRecipient.publicKeys[0]),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join(""),
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
  };
}

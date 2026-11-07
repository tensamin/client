import {
  fileSigningKeyId,
  verifyFileSigningKeyProof,
} from "@tensamin/crypto/fileSigningKey";
import {
  encodePrincipal,
  wirePrincipalSchema,
  type WirePrincipal,
} from "@tensamin/shared/principal";
import type { BoundSendFn } from "./mtpContext";
import type { FileAuthor } from "@tensamin/crypto/file";
import { base64ToBytes, bytesToBase64, crypto } from "mtp";

export function createFileSigningKeyResolver({
  send,
  signal,
}: {
  send: BoundSendFn;
  signal: AbortSignal;
}) {
  return async (principal: WirePrincipal, keyId: string) => {
    principal = wirePrincipalSchema.parse(principal);
    keyId = fileSigningKeyId.parse(keyId);
    signal.throwIfAborted();
    const response = await send("UserResolve", {
      UserAddress: encodePrincipal(principal),
      Json: JSON.stringify({ file_signing_key: keyId }),
    });
    signal.throwIfAborted();
    if (
      response.type !== "UserResolved" ||
      response.data.Principal !== encodePrincipal(principal) ||
      response.data.AuthorityId !== principal.authority ||
      BigInt(response.data.UserId) !== principal.user_id ||
      !response.data.Json
    )
      throw new Error("Historical file signing key evidence is unavailable");
    return verifyFileSigningKeyProof(response.data.Json, principal, keyId);
  };
}

export function createFileAuthorResolver({
  send,
  signal,
  resolveAuthor,
}: {
  send: BoundSendFn;
  signal: AbortSignal;
  resolveAuthor?: (principal: WirePrincipal) => Promise<FileAuthor>;
}) {
  const resolveKey = createFileSigningKeyResolver({ send, signal });
  return async (
    principal: WirePrincipal,
    signingPublicKey?: string,
  ): Promise<FileAuthor> => {
    signal.throwIfAborted();
    const author = resolveAuthor
      ? await resolveAuthor(principal)
      : {
          principal,
          publicKeys: [],
          resolveFileSigningKey: (keyId: string) =>
            resolveKey(principal, keyId),
        };
    if (
      !signingPublicKey ||
      author.publicKeys.some((key) => bytesToBase64(key) === signingPublicKey)
    )
      return author;
    const keyId = Array.from(
      crypto.sha256(base64ToBytes(signingPublicKey)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const key = await resolveKey(principal, keyId);
    if (bytesToBase64(key) !== signingPublicKey)
      throw new Error("Historical file signing key does not match its proof");
    return { ...author, publicKeys: [...author.publicKeys, key] };
  };
}

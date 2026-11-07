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

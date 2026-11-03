import { createCache } from "@tensamin/cache";
import { verifyPrincipalProof } from "@tensamin/crypto/principalProof";
import type { BoundSendFn } from "@tensamin/mtp";
import {
  encodePrincipal,
  type WirePrincipal,
} from "@tensamin/shared/principal";
import { secureValueCodec } from "@tensamin/storage/secure";

export function createPrincipalProofResolver({
  accountKey,
  send,
  signal,
}: {
  accountKey: string;
  send: BoundSendFn;
  signal: AbortSignal;
}) {
  const cache = createCache(accountKey, { codec: secureValueCodec });
  return async (principal: WirePrincipal) => {
    signal.throwIfAborted();
    const canonical = encodePrincipal(principal);
    if (!navigator.locks)
      throw new Error("Identity revision pinning requires Web Locks");
    return navigator.locks.request(
      `identity-proof:v1:${accountKey}:${canonical}`,
      { signal },
      async () => {
        const previous = await cache.identities.get(canonical);
        if (previous && previous.Principal !== canonical)
          throw new Error("Cached identity proof belongs to another principal");
        signal.throwIfAborted();
        const response = await send("UserResolve", {
          UserAddress: canonical,
          Json: '{"principal_proof":1}',
        });
        signal.throwIfAborted();
        if (
          response.type !== "UserResolved" ||
          response.data.Principal !== canonical ||
          response.data.AuthorityId !== principal.authority ||
          BigInt(response.data.UserId) !== principal.user_id ||
          !response.data.Json
        )
          throw new Error(
            "Principal resolution did not return the requested identity proof",
          );
        const verified = verifyPrincipalProof(response.data.Json, {
          principal,
          homePublicKey: response.data.PublicKey,
          minimumRevision: previous ? BigInt(previous.Revision) : undefined,
          now: BigInt(Date.now()),
        });
        if (response.data.NodeId !== verified.home)
          throw new Error("Principal resolution returned a contradictory home");
        signal.throwIfAborted();
        await cache.identities.put({
          Principal: canonical,
          Json: response.data.Json,
          PublicKey: response.data.PublicKey,
          Revision: verified.revision.toString(),
        });
        signal.throwIfAborted();
        return verified;
      },
    );
  };
}

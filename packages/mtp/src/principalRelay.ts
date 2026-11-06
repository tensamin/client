import {
  bytesToBase64,
  encodeMTPRelayTarget,
  type MTPDataValueInput,
} from "mtp";
import {
  encodePrincipal,
  principalSchema,
  type Principal,
} from "@tensamin/shared/principal";
import type { createPrincipalProofResolver } from "./principalProof";
import type { SealedRelayResult, SealedRelaySend } from "./mtpContext";

export type PrincipalRelaySend = (
  peer: Principal,
  type: string,
  data: Record<string, MTPDataValueInput>,
) => Promise<SealedRelayResult>;

export function createPrincipalRelaySender({
  owner,
  dictionary,
  resolve,
  ownIota,
  send,
  signal,
}: {
  owner: Principal;
  dictionary: { version: string; fingerprint: string };
  resolve: ReturnType<typeof createPrincipalProofResolver>;
  ownIota: () => Promise<{ IotaId: number; PublicKey: string }>;
  send: SealedRelaySend;
  signal: AbortSignal;
}): PrincipalRelaySend {
  owner = principalSchema.parse(owner);
  return async (peer, type, data) => {
    signal.throwIfAborted();
    peer = principalSchema.parse(peer);
    if (encodePrincipal(peer) === encodePrincipal(owner))
      throw new Error("A principal relay requires a different recipient");
    const [self, recipient, route] = await Promise.all([
      resolve({ ...owner, user_id: BigInt(owner.user_id) }),
      resolve({ ...peer, user_id: BigInt(peer.user_id) }),
      ownIota(),
    ]);
    signal.throwIfAborted();
    if (
      encodePrincipal(self.principal) !== encodePrincipal(owner) ||
      encodePrincipal(recipient.principal) !== encodePrincipal(peer)
    )
      throw new Error("Relay proof belongs to another principal");
    if (self.publicKeys.length !== 1 || recipient.publicKeys.length !== 1)
      throw new Error("Relay participants must have exactly one active key");
    encodeMTPRelayTarget({ kind: "iota", id: route.IotaId });
    if (route.PublicKey !== bytesToBase64(self.homePublicKey))
      throw new Error(
        "Relay route does not match the authenticated sender home",
      );
    const recipients = [
      self.homePublicKey,
      recipient.homePublicKey,
      recipient.publicKeys[0],
    ].map((value) => ({
      value: bytesToBase64(value),
      encoding: "base64" as const,
    }));
    return send(type, data, {
      nextHop: { kind: "iota", id: route.IotaId },
      finalRecipientId: peer.user_id,
      metadata: new TextEncoder().encode(
        JSON.stringify({
          signer: owner,
          recipient: peer,
          destination: recipient.home,
          type_map_version: dictionary.version,
          type_map_fingerprint: dictionary.fingerprint,
        }),
      ),
      metadataRecipients: recipients,
      contentRecipients: recipients,
    });
  };
}

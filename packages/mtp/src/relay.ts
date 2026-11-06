import { z } from "zod";
import type { MTPClient } from "mtp";
import { mtp as mtpSchemas } from "@tensamin/shared/data";
import {
  encodePrincipal,
  parsePrincipal,
  parseWirePrincipal,
  principalSchema,
} from "@tensamin/shared/principal";
import type { ProtocolMessage } from "./mtpContext";
import { createPrincipalProofResolver } from "./principalProof";

export const relayMetadata = z
  .object({
    signer: principalSchema,
    recipient: principalSchema,
    destination: z.string().regex(/^iota:v1:[a-f0-9]{64}$/),
    type_map_version: z.string().min(1),
    type_map_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

type AccountState = ProtocolMessage<"AccountStateSnapshot">["data"];
function signerCandidates(state: AccountState, userId: bigint) {
  if (!state.Scope) throw new Error("Account scope is unavailable");
  const principals = new Set([
    encodePrincipal(state.Scope.principal),
    ...state.Contacts.flatMap((contact) =>
      contact.Principal ? [contact.Principal] : [],
    ),
  ]);
  return [...principals].filter(
    (principal) => BigInt(parsePrincipal(principal).user_id) === userId,
  );
}

/** Authenticate application relays, synchronize their committed effects, then acknowledge. */
export function subscribeCommittedRelays(
  client: MTPClient<typeof mtpSchemas>,
  refresh: () => Promise<AccountState>,
) {
  let active = true;
  const controller = new AbortController();
  const resolvePrincipal = async (principal: string, state: AccountState) => {
    if (!state.Scope) throw new Error("Account scope is unavailable");
    const resolve = createPrincipalProofResolver({
      accountKey: JSON.stringify([
        state.Scope.principal,
        state.Scope.authorization_generation,
      ]),
      send: client.request.bind(client),
      signal: controller.signal,
    });
    return (await resolve(parseWirePrincipal(principal))).publicKeys;
  };
  const resolveSignerPublicKeys = async (signerId: bigint) => {
    if (signerId > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Relay signer ID exceeds the client integer range");
    }
    const state = await refresh();
    if (!active) throw new Error("Relay subscription was disposed");
    const candidates = signerCandidates(state, signerId);
    if (!candidates.length)
      throw new Error("Relay signer is not in the account scope");
    return (
      await Promise.all(
        candidates.map((principal) => resolvePrincipal(principal, state)),
      )
    ).flat();
  };
  const unsubscribe = client.subscribeRelayMetadata(
    async (verified, frame) => {
      const state = await refresh();
      if (!active || frame.id === undefined) return;
      if (!state.Scope) throw new Error("Account scope is unavailable");
      const scope = state.Scope;
      if (
        !(verified.metadata instanceof Uint8Array) ||
        verified.metadata.byteLength > 2048
      ) {
        throw new Error(
          "Authenticated relay omitted bounded canonical metadata",
        );
      }
      const encoded = new TextDecoder("utf-8", { fatal: true }).decode(
        verified.metadata,
      );
      const metadata = relayMetadata.parse(JSON.parse(encoded));
      if (
        JSON.stringify(metadata) !== encoded ||
        encodePrincipal(metadata.signer) === encodePrincipal(metadata.recipient)
      ) {
        throw new Error(
          "Authenticated relay routing metadata is not canonical",
        );
      }
      if (
        metadata.recipient.authority !== scope.principal.authority ||
        metadata.recipient.user_id !== scope.principal.user_id ||
        metadata.type_map_fingerprint !== scope.dictionary ||
        metadata.type_map_version !== client.dictionaryIdentity?.version
      ) {
        throw new Error("Authenticated relay metadata is outside this account");
      }
      if (
        verified.signerId !== BigInt(metadata.signer.user_id) ||
        verified.finalRecipientId !== BigInt(scope.principal.user_id)
      ) {
        throw new Error("Authenticated relay participant ID is invalid");
      }
      const signer = encodePrincipal(metadata.signer);
      const keys = await resolvePrincipal(signer, state);
      if (
        !keys.some(
          (key) =>
            key.length === verified.matchedSignerPublicKey.length &&
            key.every(
              (byte, index) => byte === verified.matchedSignerPublicKey[index],
            ),
        )
      ) {
        throw new Error(
          "Authenticated relay key does not belong to its canonical signer",
        );
      }
      const content = await client.openRelayContent(verified, {
        expectedSignerId: metadata.signer.user_id,
        expectedFinalRecipientId: scope.principal.user_id,
        resolveSignerPublicKeys: async () => keys,
        signaturePolicy: "dual",
      });
      if (
        ![
          "SetChatSecret",
          "AddConversation",
          "MessageSend",
          "MessageEdit",
          "MessageDelete",
          "MessageReactionAdd",
          "MessageReactionRemove",
          "MessageState",
        ].includes(content.type)
      ) {
        throw new Error("Unsupported authenticated relay operation");
      }
      const applied = await refresh();
      if (!active) return;
      if (JSON.stringify(applied.Scope) !== JSON.stringify(scope)) {
        throw new Error("Account scope changed during relay application");
      }
      await client.send(
        "Success",
        {
          RelayMessageId: verified.messageId.toString(),
          Principal: JSON.stringify(metadata.signer),
        },
        { id: frame.id },
      );
    },
    {
      resolveSignerPublicKeys,
      // Redelivery is expected after a lost acknowledgement. Sync application is
      // idempotent, so every authenticated retry must reach the acknowledgement path.
      replayGuard: { accept: () => true },
      signaturePolicy: "dual",
    },
  );
  return () => {
    active = false;
    controller.abort();
    unsubscribe();
  };
}

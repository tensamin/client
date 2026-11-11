import { z } from "zod";
import type { MTPClient } from "mtp";
import { mtp as mtpSchemas, type AccountSnapshot } from "@tensamin/shared/data";
import {
  encodePrincipal,
  parsePrincipal,
  parseWirePrincipal,
  principalSchema,
} from "@tensamin/shared/principal";
import { createPrincipalProofResolver } from "./principalProof";
import { createFileAuthorResolver } from "./fileSigningKey";
import {
  decodeFileResponse,
  wireFileShareOffer,
  wireFileShareRevoke,
} from "./files/protocol";
import {
  verifyFileShareOffer,
  verifyFileShareRevoke,
} from "@tensamin/crypto/fileSharing";
import { deriveChatId } from "@tensamin/shared/principal";
import { publishNotificationHint } from "@tensamin/shared/notification";

export const relayMetadata = z
  .object({
    signer: principalSchema,
    recipient: principalSchema,
    destination: z.string().regex(/^iota:v1:[a-f0-9]{64}$/),
    type_map_version: z.string().min(1),
    type_map_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

function signerCandidates(state: AccountSnapshot, userId: bigint) {
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

/** Receipt is not a durable application cursor. Foreground catch-up has its own owner. */
export function subscribeCommittedRelays(
  client: MTPClient<typeof mtpSchemas>,
  refresh: () => Promise<AccountSnapshot>,
  changed: () => void,
) {
  let active = true;
  const controller = new AbortController();
  const resolvePrincipal = async (
    principal: string,
    state: AccountSnapshot,
  ) => {
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
          "FileShareOffered",
          "FileShareRevoked",
        ].includes(content.type)
      ) {
        throw new Error("Unsupported authenticated relay operation");
      }

      if (
        content.type === "FileShareOffered" ||
        content.type === "FileShareRevoked"
      ) {
        const data = content.data;

        if (
          !data ||
          typeof data !== "object" ||
          !("Json" in data) ||
          typeof data.Json !== "string"
        )
          throw new Error("File relay omitted its signed operation");
        const recipient = {
          ...scope.principal,
          user_id: BigInt(scope.principal.user_id),
        };
        const authorPrincipal = {
          ...metadata.signer,
          user_id: BigInt(metadata.signer.user_id),
        };
        const authorResolver = createFileAuthorResolver({
          send: client.request.bind(client),
          signal: controller.signal,
        });
        const payload =
          content.type === "FileShareOffered"
            ? decodeFileResponse(data.Json, wireFileShareOffer)
            : decodeFileResponse(data.Json, wireFileShareRevoke);
        const author = await authorResolver(
          authorPrincipal,
          payload.signing_public_key,
        );
        const expected = {
          author,
          recipient,
          chatId: deriveChatId(authorPrincipal, recipient),
        };

        if ("manifest" in payload)
          verifyFileShareOffer(payload, { ...expected, now: 0n });
        else verifyFileShareRevoke(payload, expected);
      }

      const applied = await refresh();

      if (!active) return;

      if (JSON.stringify(applied.Scope) !== JSON.stringify(scope)) {
        throw new Error("Account scope changed during relay application");
      }

      const relayMessageId = `mtp-sealed-v1:${verified.messageId}`;

      await client.send(
        "Success",
        {
          RelayMessageId: relayMessageId,
          Status: "notification",
          Principal: JSON.stringify(metadata.signer),
        },
        { id: frame.id },
      );

      if (!active) return;

      if (
        content.type === "MessageSend" ||
        content.type === "FileShareOffered" ||
        content.type === "FileShareRevoked"
      ) {
        const time =
          content.data &&
          typeof content.data === "object" &&
          "SendTime" in content.data &&
          typeof content.data.SendTime === "number"
            ? content.data.SendTime
            : Date.now();
        publishNotificationHint({
          account: JSON.stringify([
            scope.principal,
            scope.authorization_generation,
          ]),
          signer,
          relayId: relayMessageId,
          kind: content.type,
          time,
        });
      }

      if (
        content.type !== "FileShareOffered" &&
        content.type !== "FileShareRevoked"
      )
        changed();
    },
    {
      resolveSignerPublicKeys,
      // Redelivery is expected after a lost acknowledgement. Sync application is idempotent, so every authenticated retry must reach the acknowledgement path.
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

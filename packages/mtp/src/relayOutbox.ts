import { z } from "zod";
import {
  base64ToBytes,
  bytesToBase64,
  MTPProtocolError,
  type MTPClient,
  type MTPDataValueInput,
} from "mtp";
import { syncScope, type SyncScope } from "@tensamin/shared/accountSync";
import {
  deleteDatabaseEntry,
  getDatabaseEntry,
  readDatabasePage,
  setDatabaseEntry,
} from "@tensamin/shared/indexedDb";
import {
  decodeSecureValue,
  encodeSecureValue,
  isSecureEnvelope,
} from "@tensamin/storage/secure";
import type { SealedRelayOptions, SealedRelayResult } from "./mtpContext";
import { relayMetadata } from "./relay";
import { isDefinitiveProtocolRejection } from "./relayResult";

const intent = z.strictObject({
  scope: syncScope,
  resource: z.string().regex(/^[a-f0-9]{64}$/),
  type: z.string().min(1),
  frame: z.base64(),
  state: z.enum(["ready", "accepted"]),
});

export type RelayOutboxClient = {
  dictionaryIdentity: MTPClient["dictionaryIdentity"];
  requestSealedRelay: (
    type: string,
    data: MTPDataValueInput,
    options: SealedRelayOptions & { signatureSuite: "dual" },
    request: { beforeSend: (frame: Uint8Array) => void | Promise<void> },
  ) => Promise<{ type: string; data: unknown }>;
  requestPrepared: (
    frame: Uint8Array,
    request: { beforeSend: (frame: Uint8Array) => void | Promise<void> },
  ) => Promise<{ type: string; data: unknown }>;
};

export function createRelayOutbox({
  scope,
  client,
  isCurrent,
}: {
  scope: SyncScope;
  client: RelayOutboxClient;
  isCurrent: () => boolean;
}) {
  scope = syncScope.parse(scope);
  // A dictionary or authorization change must not hide an unresolved command and allow the same resource to acquire a freshly signed replacement.
  const prefix = `relay-outbox:v1:${JSON.stringify({ principal: scope.principal, device_id: scope.device_id })}:`;
  const current = () => {
    if (!isCurrent())
      throw new Error("Account connection changed during outgoing relay");
  };

  async function read(resource: string) {
    const stored = await getDatabaseEntry("cache", prefix + resource);
    current();

    if (stored === undefined) return null;

    if (!isSecureEnvelope(stored))
      throw new Error("Outgoing relay is not protected");
    const command = intent.parse(await decodeSecureValue(stored));

    if (
      command.resource !== resource ||
      JSON.stringify(command.scope.principal) !==
        JSON.stringify(scope.principal) ||
      command.scope.device_id !== scope.device_id
    )
      throw new Error("Outgoing relay belongs to another scope or resource");
    current();

    return command;
  }

  async function accepted(command: z.infer<typeof intent>) {
    current();
    await setDatabaseEntry(
      "cache",
      prefix + command.resource,
      await encodeSecureValue({ ...command, state: "accepted" }),
    );
    current();
    await deleteDatabaseEntry("cache", prefix + command.resource);
  }

  async function request(
    resource: string,
    send: () => ReturnType<RelayOutboxClient["requestPrepared"]>,
  ) {
    try {
      const response = await send();
      current();

      if (isDefinitiveProtocolRejection(response))
        await deleteDatabaseEntry("cache", prefix + resource);

      return response;
    } catch (error) {
      current();

      if (
        error instanceof MTPProtocolError &&
        isDefinitiveProtocolRejection(error)
      )
        await deleteDatabaseEntry("cache", prefix + resource);

      throw error;
    }
  }

  async function lock<T>(resource: string, run: () => Promise<T>) {
    current();

    if (!navigator.locks)
      throw new Error("Durable outgoing relays require Web Locks");

    return navigator.locks.request(prefix + resource, async () => {
      current();

      return run();
    });
  }

  return {
    async send(
      type: string,
      data: MTPDataValueInput,
      options: SealedRelayOptions,
    ): Promise<SealedRelayResult> {
      current();

      if (
        !(options.metadata instanceof Uint8Array) ||
        options.metadata.length > 2048
      )
        throw new Error("Outgoing relay requires bounded canonical metadata");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        options.metadata,
      );
      const metadata = relayMetadata.parse(JSON.parse(text));

      if (
        JSON.stringify(metadata) !== text ||
        JSON.stringify(metadata.signer) !== JSON.stringify(scope.principal) ||
        metadata.recipient.user_id !== options.finalRecipientId ||
        metadata.type_map_fingerprint !== scope.dictionary ||
        client.dictionaryIdentity?.fingerprint !== scope.dictionary ||
        client.dictionaryIdentity.version !== metadata.type_map_version ||
        JSON.stringify(metadata.recipient) === JSON.stringify(scope.principal)
      )
        throw new Error(
          "Outgoing relay metadata is outside this account scope",
        );
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([type, metadata.recipient])),
      );
      const resource = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");

      return lock(resource, async () => {
        const previous = await read(resource);

        if (previous?.state === "ready") {
          if (JSON.stringify(previous.scope) !== JSON.stringify(scope))
            throw new Error(
              "Pending outgoing relay belongs to a different account session",
            );
          const response = await request(resource, () =>
            client.requestPrepared(base64ToBytes(previous.frame), {
              beforeSend: current,
            }),
          );
          current();

          if (response.type === "Success") await accepted(previous);
          else {
            throw new Error(
              `Previous outgoing relay was rejected: ${response.type}`,
            );
          }
        } else if (previous)
          await deleteDatabaseEntry("cache", prefix + resource);
        let prepared: z.infer<typeof intent> | undefined;
        const response = await request(resource, () =>
          client.requestSealedRelay(
            type,
            data,
            { ...options, signatureSuite: "dual" },
            {
              beforeSend: async (frame) => {
                current();
                prepared = {
                  scope,
                  resource,
                  type,
                  frame: bytesToBase64(frame),
                  state: "ready",
                };
                await setDatabaseEntry(
                  "cache",
                  prefix + resource,
                  await encodeSecureValue(prepared),
                );
                current();
              },
            },
          ),
        );
        current();

        if (!prepared)
          throw new Error("Outgoing relay was sent without a durable command");

        if (response.type === "Success") await accepted(prepared);

        return {
          type: response.type,
          data: response.data as Record<string, unknown>,
        };
      });
    },
    async resume(onFailure: (type: string) => void, signal: AbortSignal) {
      const recovering = () => {
        signal.throwIfAborted();
        current();
      };

      let after: string | undefined;

      for (;;) {
        recovering();
        // A relay may contain a large encrypted body. Read only one at a time.
        const page = await readDatabasePage("cache", prefix, after, 1);

        if (!page.length) return;
        const key = page[0][0];
        const resource = key.slice(prefix.length);
        await lock(resource, async () => {
          const command = await read(resource);

          if (!command) return;

          try {
            if (command.state === "ready") {
              if (JSON.stringify(command.scope) !== JSON.stringify(scope)) {
                onFailure(command.type);

                return;
              }

              const response = await request(resource, () =>
                client.requestPrepared(base64ToBytes(command.frame), {
                  beforeSend: recovering,
                }),
              );
              recovering();

              if (response.type !== "Success") {
                onFailure(command.type);

                return;
              }

              await accepted(command);
            } else await deleteDatabaseEntry("cache", key);
          } catch {
            recovering();
            onFailure(command.type);
          }
        });
        after = key;
      }
    },
  };
}

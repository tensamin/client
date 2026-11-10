import { z } from "zod";
import { MTPProtocolError } from "mtp";
import { isDefinitiveProtocolRejection } from "@tensamin/mtp/relayResult";
import type { BoundSendFn } from "@tensamin/mtp";
import {
  deleteDatabaseEntry,
  getDatabaseEntry,
  listDatabaseEntries,
  setDatabaseEntry,
} from "@tensamin/shared/indexedDb";
import {
  decodeSecureValue,
  encodeSecureValue,
  isSecureEnvelope,
} from "@tensamin/storage/secure";
import {
  decodeFileResponse,
  encodeFileRequest,
} from "@tensamin/mtp/files/protocol";

const commandSchema = z.strictObject({
  account_key: z.string(),
  resource: z.string().min(1),
  type: z.enum([
    "FileFolderPut",
    "FileFolderDelete",
    "FilePlacementPut",
    "FilePlacementDelete",
    "FileMetadataPut",
    "FileKeyEnvelopePut",
    "FileDelete",
  ]),
  request: z.string(),
  state: z.enum(["ready", "completed", "superseded"]),
});

export function createFileCommands({
  accountKey,
  send,
  signal,
}: {
  accountKey: string;
  send: BoundSendFn;
  signal: AbortSignal;
}) {
  const prefix = `file-command:v1:${accountKey}:`;

  async function read(resource: string) {
    const stored = await getDatabaseEntry("cache", `${prefix}${resource}`);
    signal.throwIfAborted();

    if (stored === undefined) return undefined;

    if (!isSecureEnvelope(stored))
      throw new Error("Pending file command is not protected");
    const command = commandSchema.parse(await decodeSecureValue(stored));
    signal.throwIfAborted();

    if (command.account_key !== accountKey || command.resource !== resource)
      throw new Error(
        "Pending file command belongs to another scope or resource",
      );

    return command;
  }

  async function finish(command: z.output<typeof commandSchema>) {
    signal.throwIfAborted();
    const key = `${prefix}${command.resource}`;

    if (command.state === "ready") {
      const response = await send(command.type, {
        Json: command.request,
      }).catch(async (error: unknown) => {
        signal.throwIfAborted();

        if (
          error instanceof MTPProtocolError &&
          isDefinitiveProtocolRejection(error)
        )
          await deleteDatabaseEntry("cache", key);

        throw error;
      });
      signal.throwIfAborted();

      if (response.type !== command.type) {
        if (isDefinitiveProtocolRejection(response))
          await deleteDatabaseEntry("cache", key);

        throw new Error(`File command failed: ${response.type}`);
      }

      decodeFileResponse(
        response.data.Json,
        z.strictObject({ ok: z.literal(true) }),
      );
      await setDatabaseEntry(
        "cache",
        key,
        await encodeSecureValue({ ...command, state: "completed" }),
      );
      signal.throwIfAborted();
    }

    await deleteDatabaseEntry("cache", key);
    signal.throwIfAborted();

    return {
      type: command.type,
      outcome: command.state === "superseded" ? "superseded" : "resolved",
    } as const;
  }

  function lock<T>(resource: string, operation: () => Promise<T>) {
    signal.throwIfAborted();

    if (!navigator.locks)
      throw new Error("File command recovery requires Web Locks");

    return navigator.locks.request(
      `${prefix}${resource}`,
      { signal },
      operation,
    );
  }

  return {
    run(
      resource: string,
      type: z.output<typeof commandSchema>["type"],
      prepare: () => Promise<unknown>,
    ) {
      return lock(resource, async () => {
        const previous = await read(resource);

        if (previous?.state === "ready")
          throw new Error(
            "Resolve the pending file command before replacing it",
          );

        if (previous) await finish(previous);
        const request = encodeFileRequest(await prepare());
        signal.throwIfAborted();
        const command = commandSchema.parse({
          account_key: accountKey,
          resource,
          type,
          request,
          state: "ready",
        });
        await setDatabaseEntry(
          "cache",
          `${prefix}${resource}`,
          await encodeSecureValue(command),
        );
        signal.throwIfAborted();

        return finish(command);
      });
    },
    resume(resource: string) {
      return lock(resource, async () => {
        const command = await read(resource);

        if (!command) throw new Error("Pending file command is unavailable");

        // These endpoints accept exact replays without applying a second mutation. Regenerating encryption nonces would instead create a different command.
        return finish(command);
      });
    },
    reconcile(
      resource: string,
      inspect: (
        type: z.output<typeof commandSchema>["type"],
        request: string,
      ) => Promise<"resolved" | "superseded" | "unknown">,
    ) {
      return lock(resource, async () => {
        const command = await read(resource);

        if (!command) throw new Error("Pending file command is unavailable");

        if (command.state !== "ready") return finish(command);
        const outcome = await inspect(command.type, command.request);
        signal.throwIfAborted();

        if (outcome === "unknown")
          return { type: command.type, outcome } as const;
        const resolved = {
          ...command,
          state: outcome === "resolved" ? "completed" : "superseded",
        } as const;
        await setDatabaseEntry(
          "cache",
          `${prefix}${resource}`,
          await encodeSecureValue(resolved),
        );
        signal.throwIfAborted();

        return finish(resolved);
      });
    },
    async pending() {
      signal.throwIfAborted();
      const entries = await listDatabaseEntries("cache", prefix);
      const pending = [];

      for (const [key] of entries) {
        const resource = key.slice(prefix.length);
        try {
          const command = await read(resource);
          if (command)
            pending.push({
              resource: command.resource,
              type: command.type,
              state: command.state,
            });
        } catch (error) {
          signal.throwIfAborted();
          pending.push({
            resource,
            type: "unreadable" as const,
            state: "unreadable" as const,
            error: String(error),
          });
        }
      }

      return pending;
    },
  };
}

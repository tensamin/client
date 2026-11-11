import type { SyncScope } from "@tensamin/shared/accountSync";
import type { BoundSendFn } from "../mtpContext";
import { createFileAuthorResolver } from "../fileSigningKey";
import { createFileJournal, fileChangesPageSchema } from "./journal";
import { decodeFileResponse, encodeFileRequest } from "./protocol";

export function createAccountFileJournal(
  scope: SyncScope,
  send: BoundSendFn,
  signal: AbortSignal,
) {
  return createFileJournal({
    accountKey: JSON.stringify([
      scope.principal,
      scope.authorization_generation,
    ]),
    account: { ...scope.principal, user_id: BigInt(scope.principal.user_id) },
    signal,
    resolveAuthor: createFileAuthorResolver({ send, signal }),
    fetch: async (after, upper) => {
      signal.throwIfAborted();
      const response = await send("FileChangesGet", {
        Json: encodeFileRequest({ after, upper }),
      });
      signal.throwIfAborted();

      if (response.type !== "FileChangesGet")
        throw new Error("File journal synchronization is unavailable");

      return decodeFileResponse(response.data.Json, fileChangesPageSchema);
    },
  });
}

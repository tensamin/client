import type { BoundSendFn } from "@tensamin/mtp";
import {
  decodeFileResponse,
  encodeFileRequest,
} from "@tensamin/mtp/files/protocol";
import { z } from "zod";

export const fileOk = z.strictObject({ ok: z.literal(true) });

export function createFileRequest({
  send,
  signal,
}: {
  send: BoundSendFn;
  signal: AbortSignal;
}) {
  return async function request<T>(
    type:
      | "FileUploadStart"
      | "FileVersionPublish"
      | "FileGetManifest"
      | "FileReplicaAccept"
      | "FileReplicaCancel"
      | "FileChangesGet"
      | "FilePlacementPut"
      | "FileFolderPut"
      | "FileFolderDelete"
      | "FilePlacementDelete"
      | "FileListPage",
    body: unknown,
    schema: z.ZodType<T>,
  ) {
    signal.throwIfAborted();
    const response = await send(type, { Json: encodeFileRequest(body) });
    signal.throwIfAborted();

    if (response.type !== type)
      throw new Error(`File operation failed: ${response.type}`);

    return decodeFileResponse(response.data.Json, schema);
  };
}

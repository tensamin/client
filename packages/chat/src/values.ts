import { z } from "zod";
import type { ReactNode } from "react";
import { mtp } from "@tensamin/shared/data";
import { ACCOUNT_MESSAGE_PREVIEW_LIMIT } from "@tensamin/shared/accountSync";
import type { FileKey } from "@tensamin/crypto/file";

export type RawMessages = z.infer<typeof mtp.MessagesGet.response>["Messages"];

export type RawMessage = RawMessages[number] & {
  decryptionFailed?: boolean;
};

export type LiveMessage = RawMessage & {
  failed?: boolean;
  localId: string;
};

export type ComposerAttachments = {
  count: number;
  busy: boolean;
  unavailableReason?: string;
  onSendingChange(sending: boolean): void;
  prepare: () => Promise<
    | {
        references: string[];
        files: { key: FileKey; expiresAt: bigint }[];
        complete(): void;
      }
    | undefined
  >;
};

export type EditAttachments = ComposerAttachments & {
  action(kept: number): ReactNode;
  discard(): void;
};

export const PAGE_SIZE = ACCOUNT_MESSAGE_PREVIEW_LIMIT;
export const FALLBACK_MESSAGE_HEIGHT = 28;
export const MESSAGES_PER_VIRTUAL_ROW = 30;

import type { z } from "zod";
import type { ReactNode } from "react";
import type { Message } from "@tensamin/shared/data";
import { ACCOUNT_MESSAGE_PREVIEW_LIMIT } from "@tensamin/shared/accountSync";
import type { FileKey } from "@tensamin/crypto/file";

export type EncryptedMessage = z.infer<typeof Message>;

export type RawMessage = Omit<EncryptedMessage, "Content" | "Files"> & {
  Content: string;
  Files: (Omit<EncryptedMessage["Files"][number], "Content"> & {
    Content: string;
  })[];
  decryptionFailed?: boolean;
};

export type RawMessages = RawMessage[];

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

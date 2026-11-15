import { z } from "zod";
import type { ReactNode } from "react";
import { mtp } from "@tensamin/shared/data";
import { ACCOUNT_MESSAGE_PREVIEW_LIMIT } from "@tensamin/shared/accountSync";

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
  prepare: (content: string) => Promise<
    | {
        content: string;
        complete(): void;
        settle(update: (content: string) => Promise<void>): Promise<void>;
      }
    | undefined
  >;
};

export type ChatAttachmentRenderer = ((
  content: string,
  principal: string | undefined,
  renderBody: (body: string) => ReactNode,
) => ReactNode) & {
  renderLink?: (url: string, principal: string | undefined) => ReactNode;
};

export const PAGE_SIZE = ACCOUNT_MESSAGE_PREVIEW_LIMIT;
export const FALLBACK_MESSAGE_HEIGHT = 28;
export const MESSAGES_PER_VIRTUAL_ROW = 30;

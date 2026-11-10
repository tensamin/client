import type { BoundSendFn } from "@tensamin/mtp";
import type { WirePrincipal } from "@tensamin/shared/principal";

export interface FileTransferContext {
  accountKey: string;
  account: WirePrincipal;
  owner: { keyId: string; keyring: Uint8Array; publicKey: Uint8Array };
  send: BoundSendFn;
  signal: AbortSignal;
  onProgress?: (progress: {
    phase:
      "encrypting" | "uploading" | "publishing" | "downloading" | "verifying";
    bytes: bigint;
    total: bigint;
  }) => void;
}

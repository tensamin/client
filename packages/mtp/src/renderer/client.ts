import { mtp as mtpSchemas } from "@tensamin/shared/data";
import { log } from "@tensamin/shared/log";
import { MTPClient } from "mtp";

export function createBrowserClient(
  options: Omit<Parameters<typeof MTPClient.create>[0], "schemas">,
) {
  return MTPClient.create({
    ...options,
    schemas: mtpSchemas,
    throwProtocolErrors: true,
    onValidationError: (error) => {
      log(1, "mtp", "red", "Failed to validate push message", {
        phase: error.phase,
        messageType: error.messageType,
      });
    },
  });
}

export type BrowserMtpClient = Awaited<ReturnType<typeof createBrowserClient>>;

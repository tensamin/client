import { logMTP } from "@tensamin/shared/log";
import { base64ToBytes } from "mtp";

import { createBrowserClient, type BrowserMtpClient } from "./client";
import type { RendererState } from "./state";

export function createCallOwnerRequest(
  activeClient: BrowserMtpClient,
  identity: NonNullable<RendererState["credentials"]>["identity"],
  userId: number,
  primaryOmikronId: number | undefined,
  ownerClients: Map<number, BrowserMtpClient>,
  omegaBaseUrl: string,
  signal: AbortSignal,
): RendererState["callControlRequestRef"]["current"] {
  return "keyring" in identity
    ? async (ownerOmikronId, type, data, options) => {
        if (ownerOmikronId == null || ownerOmikronId === primaryOmikronId) {
          return activeClient.request(type, data, options);
        }

        let ownerClient = ownerClients.get(ownerOmikronId);

        if (!ownerClient) {
          const response = await fetch(
            new URL(`api/get/omikron/${ownerOmikronId}`, omegaBaseUrl),
            {
              signal: signal,
            },
          );

          if (!response.ok) {
            throw new Error(
              `Call owner discovery failed: HTTP ${response.status}`,
            );
          }

          const owner = (await response.json()) as {
            id: number;
            ip_address: string;
            port: number;
            public_key: string;
          };

          if (
            owner.id !== ownerOmikronId ||
            !owner.ip_address ||
            !owner.port ||
            !owner.public_key
          ) {
            throw new Error("Call owner discovery returned an invalid Omikron");
          }

          ownerClient = await createBrowserClient({
            url: `https://${owner.ip_address}:${owner.port}`,
            credentials: {
              clientId: userId,
              keyring: base64ToBytes(identity.keyring),
            },
            hostPublicKey: {
              value: owner.public_key,
              encoding: "base64",
            },
            descriptor: "client-call-control",
            pings: true,
            securityProfile: { protectedSignatureSuite: "dual" },
            logger: logMTP,
          });

          try {
            await ownerClient.auth();
          } catch (error) {
            ownerClient.disconnect();

            throw error;
          }

          ownerClients.set(ownerOmikronId, ownerClient);
        }

        return ownerClient.request(type, data, options);
      }
    : null;
}

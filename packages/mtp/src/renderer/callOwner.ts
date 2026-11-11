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
  if (!("keyring" in identity)) return null;
  const keyring = identity.keyring;
  const pendingOwners = new Map<number, Promise<BrowserMtpClient>>();

  async function connectOwner(ownerOmikronId: number) {
    signal.throwIfAborted();
    const response = await fetch(
      new URL(`api/get/omikron/${ownerOmikronId}`, omegaBaseUrl),
      { signal },
    );
    if (!response.ok)
      throw new Error(`Call owner discovery failed: HTTP ${response.status}`);
    const owner = (await response.json()) as {
      id: number;
      ip_address: string;
      port: number;
      public_key: string;
    };
    signal.throwIfAborted();
    if (
      owner.id !== ownerOmikronId ||
      !owner.ip_address ||
      !owner.port ||
      !owner.public_key
    )
      throw new Error("Call owner discovery returned an invalid Omikron");

    const client = await createBrowserClient({
      url: `https://${owner.ip_address}:${owner.port}`,
      credentials: { clientId: userId, keyring: base64ToBytes(keyring) },
      hostPublicKey: { value: owner.public_key, encoding: "base64" },
      descriptor: "client-call-control",
      pings: true,
      securityProfile: { protectedSignatureSuite: "dual" },
      logger: logMTP,
    });
    const disconnect = () => client.disconnect();
    signal.addEventListener("abort", disconnect, { once: true });
    try {
      signal.throwIfAborted();
      await client.auth();
      signal.throwIfAborted();
      ownerClients.set(ownerOmikronId, client);
      return client;
    } catch (error) {
      client.disconnect();
      throw error;
    } finally {
      signal.removeEventListener("abort", disconnect);
    }
  }

  return async (ownerOmikronId, type, data, options) => {
    signal.throwIfAborted();
    if (ownerOmikronId == null || ownerOmikronId === primaryOmikronId)
      return activeClient.request(type, data, options);

    let ownerClient = ownerClients.get(ownerOmikronId);
    if (!ownerClient) {
      let pending = pendingOwners.get(ownerOmikronId);
      if (!pending) {
        pending = connectOwner(ownerOmikronId).finally(() =>
          pendingOwners.delete(ownerOmikronId),
        );
        pendingOwners.set(ownerOmikronId, pending);
      }
      ownerClient = await pending;
    }
    signal.throwIfAborted();
    return ownerClient.request(type, data, options);
  };
}

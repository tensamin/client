import { invoke, isTauri } from "@tauri-apps/api/core";
import { log } from "@tensamin/shared/log";

import { DISCOVERY_TIMEOUT } from "../values";

import { createBrowserClient } from "./client";
import type { RendererState } from "./state";

export async function resolveEndpoint(
  credentials: NonNullable<RendererState["credentials"]>,
  signal: AbortSignal,
  nativeGenerationRef: RendererState["nativeGenerationRef"],
) {
  const { userId } = credentials;
  const omegaBaseUrl = credentials.omegaUrl.replace(/\/+$/, "") + "/";
  const forcedOmikronUrl = credentials.forcedUrl;
  const forcedOmikronPublicKey = credentials.forcedKey;
  let url: string;
  let omikronPublicKey: string | number[];
  let nativeOptions: Partial<
    Omit<
      Parameters<typeof createBrowserClient>[0],
      "credentials" | "hostPublicKey"
    >
  > = {};
  let primaryOmikronId: number | undefined;

  if (isTauri()) {
    await invoke("mtp_restore_credentials");
    await invoke("plugin:mtp|mtp_set_background_enabled", {
      enabled: true,
    });
    const options = await invoke<
      typeof nativeOptions & { url: string; hostPublicKey: number[] }
    >("mtp_frontend_options");
    const { hostPublicKey, ...rest } = options;
    nativeOptions = rest;
    const snapshot = await invoke<{ generation: number }>("mtp_status");
    nativeGenerationRef.current = snapshot.generation;
    url = options.url;
    omikronPublicKey = hostPublicKey;
  } else if (forcedOmikronUrl && forcedOmikronPublicKey) {
    url = forcedOmikronUrl;
    omikronPublicKey = forcedOmikronPublicKey;
  } else {
    log(2, "mtp", "purple", "Fetching Omikron data.");
    const data = await fetch(
      new URL(`api/get/user/${userId}/omikron`, omegaBaseUrl),
      {
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(DISCOVERY_TIMEOUT),
        ]),
      },
    );

    if (data.status === 404) {
      throw new Error("No Omikron assignment is currently available");
    }

    if (!data.ok)
      throw new Error(`Omikron discovery failed: HTTP ${data.status}`);
    const omikronData = (await data.json()) as {
      id: number;
      ip_address: string;
      port: number;
      public_key: string;
    };

    if (
      !omikronData.ip_address ||
      !omikronData.port ||
      !omikronData.id ||
      !omikronData.public_key
    ) {
      throw new Error("Invalid Omikron data");
    }

    url = `https://${omikronData.ip_address}:${omikronData.port}`;
    omikronPublicKey = omikronData.public_key;
    primaryOmikronId = omikronData.id;
  }

  if (!url || !omikronPublicKey) {
    throw new Error("Missing Omikron URL or Public Key");
  }

  return { url, omikronPublicKey, nativeOptions, primaryOmikronId };
}

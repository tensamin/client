import { invoke, isTauri } from "@tauri-apps/api/core";

import type { StorageContextValue } from "./context";

export function normalizeHttpsUrl(value: string, label: string) {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || !url.hostname) {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain credentials`);
  }
  return url;
}

export async function persistNativeMtpConfig({
  storage,
  userId,
  keyring,
  omegaUrl,
}: {
  storage: Pick<StorageContextValue, "load">;
  userId: number;
  keyring: string;
  omegaUrl?: string;
}) {
  if (!isTauri()) return;
  const [storedOmegaUrl, forcedOmikronUrl, forcedOmikronPublicKey] =
    await Promise.all([
      omegaUrl ?? storage.load("omega_url"),
      storage.load("forced_omikron_url"),
      storage.load("forced_omikron_public_key"),
    ]);
  await invoke("mtp_store_credentials", {
    config: {
      userId,
      keyring,
      omegaUrl: storedOmegaUrl,
      forcedOmikronUrl,
      forcedOmikronPublicKey,
    },
  });
  // Connect through the plugin command so Android's encrypted durable store
  // is written before provisioning reports successful local persistence.
  // The native backend has already initialized the imported identity.
  const connected = await invoke<boolean>("plugin:mtp|mtp_status", {
    name: "mtp:credentials",
  });
  if (!connected) {
    await invoke("plugin:mtp|mtp_connect", {
      name: "mtp:credentials",
      mode: "auth",
    });
  }
}

export function parseTuFileContent(rawFileContent: string): {
  userId: number;
  privateKey: string;
  domain: string | null;
} {
  const content = rawFileContent.trim();
  const separator = content.indexOf("::");
  if (separator <= 0 || separator !== content.lastIndexOf("::")) {
    throw new Error("Invalid file");
  }

  const identity = content.slice(0, separator);
  const privateKey = content.slice(separator + 2).trim();
  const [userIdValue, domain, ...extraDomainParts] = identity.split("@");
  const userId = Number(userIdValue);
  if (
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    !privateKey ||
    extraDomainParts.length > 0 ||
    (identity.includes("@") && !domain)
  ) {
    throw new Error("Invalid file");
  }

  return { userId, privateKey, domain: domain ?? null };
}

export async function persistMtpCredentials({
  storage,
  userId,
  keyring,
  domain,
}: {
  storage: Pick<StorageContextValue, "load" | "save">;
  userId: number;
  keyring: string;
  domain?: string | null;
}) {
  const omegaUrl = domain
    ? `https://${domain}/`
    : await storage.load("omega_url");
  if (domain) await storage.save("omega_url", omegaUrl);
  await persistNativeMtpConfig({ storage, userId, keyring, omegaUrl });

  await storage.save("mtp_keyring", keyring, { secure: true });
  await storage.save("session_id", Date.now());
  await storage.save("user_id", userId);
}

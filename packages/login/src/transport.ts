import { ConnectionState, MTPClient, bytesToBase64 } from "mtp";
import { invoke, isTauri } from "@tauri-apps/api/core";
import * as mtpRaw from "mtp/raw";
import { mtp as appSchemas } from "@tensamin/shared/data";
import { provisioning } from "@tensamin/shared/data";
import { logMTP } from "@tensamin/shared/log";
import { ProvisioningUnavailableError } from "./errors";
import { DUAL_SIGNATURE_SUITE, PROVISIONING_DESCRIPTOR } from "./protection";
import type { ProvisioningLifecycle } from "./events";

export const provisioningRegistry = { ...appSchemas, ...provisioning } as const;

export type ProvisioningClient = MTPClient<typeof provisioningRegistry>;

export type ProvisioningOmikron = { id: number; url: string };

export type ProvisioningConnection = {
  client: ProvisioningClient;
  keyring: Uint8Array;
  publicKeyBundle: Uint8Array;
  publicKeyBase64: string;
  omikron: ProvisioningOmikron;
  disconnect(): void;
};

function temporaryPublicKeyBundle(keyring: Uint8Array): Uint8Array {
  let parsed: mtpRaw.WasmKeyring;

  try {
    parsed = mtpRaw.WasmKeyring.from_bytes(keyring);
  } catch {
    throw new ProvisioningUnavailableError(
      "Failed to derive the temporary provisioning key",
    );
  }

  try {
    const bundle = parsed.public_key_bundle();

    try {
      return bundle.try_to_bytes();
    } finally {
      bundle.free();
    }
  } finally {
    parsed.free();
  }
}

/** Open a short-lived unauthenticated provisioning connection with a freshly generated temporary keyring, pinned to the Omikron host key obtained from Omega. Never call `client.auth()` on this connection. */
export async function connectProvisioningClient({
  omikron,
  signal,
}: {
  omikron: ProvisioningOmikron & { publicKey: string };
  signal?: AbortSignal;
}): Promise<ProvisioningConnection> {
  await MTPClient.init();
  const native = isTauri() && /Android/i.test(navigator.userAgent);
  const keyring = native
    ? new Uint8Array()
    : MTPClient.crypto.generateKeyring();
  let publicKeyBundle = native
    ? new Uint8Array()
    : temporaryPublicKeyBundle(keyring);
  let client: ProvisioningClient | null = null;

  try {
    client = await MTPClient.create({
      url: omikron.url,
      descriptor: PROVISIONING_DESCRIPTOR,
      credentials: native ? null : { clientId: null, keyring },
      hostPublicKey: { value: omikron.publicKey, encoding: "base64" },
      schemas: provisioningRegistry,
      throwProtocolErrors: true,
      securityProfile: {
        protectedSignatureSuite: DUAL_SIGNATURE_SUITE,
        protectedSignaturePolicy: DUAL_SIGNATURE_SUITE,
      },
      logger: logMTP,
    });
    await (signal
      ? raceAbort(client.connectUnauthenticated(), signal)
      : client.connectUnauthenticated());

    if (native) {
      const identity = client.nativeIdentity;

      if (!identity)
        throw new Error("Native provisioning identity unavailable");
      publicKeyBundle = identity.publicKeys;
    }
  } catch (error) {
    const name = client?.nativeIdentity?.name;
    client?.disconnect();

    if (name)
      await invoke("plugin:mtp|mtp_clear_credentials", { name }).catch(
        () => {},
      );
    keyring.fill(0);

    throw new ProvisioningUnavailableError(
      `Could not reach the provisioning Omikron: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    client,
    keyring,
    publicKeyBundle,
    publicKeyBase64: bytesToBase64(publicKeyBundle),
    omikron: { id: omikron.id, url: omikron.url },
    disconnect: () => {
      const name = client?.nativeIdentity?.name;
      client?.disconnect();

      if (name)
        void invoke("plugin:mtp|mtp_clear_credentials", { name }).catch(
          () => {},
        );
    },
  };
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProvisioningUnavailableError("Provisioning was cancelled"));

      return;
    }

    const onAbort = () =>
      reject(new ProvisioningUnavailableError("Provisioning was cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Shared teardown for protocol sessions: zeroize the temporary keyring, disconnect, and mark the lifecycle terminal when not completed. */
export function releaseProvisioningConnection(
  connection: ProvisioningConnection,
  lifecycle: ProvisioningLifecycle,
): void {
  if (lifecycle.state !== "completed") lifecycle.fail("disposed");
  connection.keyring.fill(0);
  connection.disconnect();
}

/** Track transport loss and aborts for the full protocol lifetime. */
export function trackProvisioningLifecycle(
  connection: ProvisioningConnection,
  lifecycle: ProvisioningLifecycle,
  sessionUuid: () => string | null,
  signal?: AbortSignal,
): void {
  let checking = false;
  const abort = () => lifecycle.fail("cancelled");
  const timer = setInterval(() => {
    if (lifecycle.state === "completed") {
      clearInterval(timer);
      signal?.removeEventListener("abort", abort);

      return;
    }

    if (checking) return;
    checking = true;
    const native = connection.client.nativeIdentity;
    const status = native
      ? invoke<boolean>("plugin:mtp|mtp_status", { name: native.name })
      : Promise.resolve(connection.client.state === ConnectionState.Connected);
    void status
      .then(
        (connected) => {
          if (!connected) lifecycle.fail("connection-lost");
        },
        (error: unknown) => lifecycle.fail("connection-lost", error),
      )
      .finally(() => {
        checking = false;
      });
  }, 1_000);
  signal?.addEventListener("abort", abort, { once: true });
  lifecycle.onTerminal(() => {
    clearInterval(timer);
    signal?.removeEventListener("abort", abort);
    const uuid = sessionUuid();

    if (uuid) {
      // Cancellation is sent once, with a short deadline, preserving the cause.
      void connection.client
        .request("ProvisioningCancel", { Uuid: uuid }, { timeoutMs: 1_000 })
        .catch(() => {})
        .finally(() => connection.disconnect());
    } else connection.disconnect();
  });

  if (signal?.aborted) abort();
}

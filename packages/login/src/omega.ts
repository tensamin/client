import { z } from "zod";
import { ProvisioningUnavailableError } from "./errors";
import { canonicalPublicKeyBundle } from "./credential";
import { AccountVerificationError } from "./errors";

const omegaAccountSchema = z.object({
  username: z.string().min(1).max(15),
  public_key: z.base64(),
  user_id: z.number().int().positive(),
  iota_id: z.number().int().positive(),
  principal: z.string().min(1),
});

const omegaIotaSchema = z.object({
  public_key: z.base64(),
});

const omegaOmikronSchema = z.object({
  id: z.number().int().positive(),
  ip_address: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  public_key: z.base64(),
});

export type OmegaAccount = z.infer<typeof omegaAccountSchema>;
export type OmegaIota = z.infer<typeof omegaIotaSchema>;
export type OmegaOmikron = z.infer<typeof omegaOmikronSchema>;

const DISCOVERY_TIMEOUT_MS = 15_000;

export function normalizeOmegaOrigin(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "https:" || !url.hostname) {
    throw new ProvisioningUnavailableError("Omega origin must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProvisioningUnavailableError("Invalid Omega origin");
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}/`;
}

export function omikronEndpointUrl(omikron: {
  ip_address: string;
  port: number;
}): string {
  const host = omikron.ip_address.includes(":")
    ? `[${omikron.ip_address}]`
    : omikron.ip_address;
  return `https://${host}:${omikron.port}`;
}

async function fetchValidated<T>(
  omega: string,
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(path, normalizeOmegaOrigin(omega)), {
      signal: signal ?? AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch {
    throw new ProvisioningUnavailableError(`Omega is unreachable (${path})`);
  }
  if (response.status === 404) throw new NotFoundError(path);
  if (!response.ok) {
    throw new ProvisioningUnavailableError(
      `Omega discovery failed (${path}): HTTP ${response.status}`,
    );
  }
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new ProvisioningUnavailableError(
      `Omega returned invalid discovery data (${path})`,
    );
  }
  return parsed.data;
}

export class NotFoundError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Omega has no entry for ${path}`);
    this.name = "NotFoundError";
    this.path = path;
  }
}

export function fetchAccountIdentity(
  omega: string,
  username: string,
  signal?: AbortSignal,
): Promise<OmegaAccount> {
  return fetchValidated(
    omega,
    `api/get/id/${encodeURIComponent(username)}`,
    omegaAccountSchema,
    signal,
  );
}

export function fetchIotaIdentity(
  omega: string,
  iotaId: number,
  signal?: AbortSignal,
): Promise<OmegaIota> {
  return fetchValidated(
    omega,
    `api/get/iota/${iotaId}`,
    omegaIotaSchema,
    signal,
  );
}

export function fetchAccountOmikron(
  omega: string,
  iotaId: number,
  signal?: AbortSignal,
): Promise<OmegaOmikron> {
  return fetchValidated(
    omega,
    `api/get/iota/${iotaId}/omikron`,
    omegaOmikronSchema,
    signal,
  );
}

export function fetchLiveOmikron(
  omega: string,
  signal?: AbortSignal,
): Promise<OmegaOmikron> {
  return fetchValidated(omega, "api/get/omikron", omegaOmikronSchema, signal);
}

export type AccountBinding = {
  Uuid: string;
  UserId: number;
  Username: string;
  IotaId: number;
  Principal: string;
  PublicKey: string;
};

/**
 * Omikron account-binding events are never authoritative on their own.
 * Re-resolve the account through Omega and compare every identity field,
 * preferring canonical public-key byte comparison over raw base64.
 */
export async function verifyAccountBinding({
  omega,
  binding,
  expectedUuid,
}: {
  omega: string;
  binding: AccountBinding;
  expectedUuid: string;
}): Promise<OmegaAccount> {
  if (binding.Uuid !== expectedUuid) {
    throw new AccountVerificationError(
      "Account binding belongs to a different session",
    );
  }
  const account = await fetchAccountIdentity(omega, binding.Username).catch(
    () => {
      throw new AccountVerificationError(
        "Bound account could not be resolved through Omega",
      );
    },
  );
  if (
    binding.UserId !== account.user_id ||
    binding.IotaId !== account.iota_id ||
    binding.Principal !== account.principal ||
    !canonicalBundleEquals(binding.PublicKey, account.public_key)
  ) {
    throw new AccountVerificationError(
      "Account binding does not match the Omega identity",
    );
  }
  return account;
}

function canonicalBundleEquals(a: string, b: string): boolean {
  const left = canonicalPublicKeyBundle(a);
  const right = canonicalPublicKeyBundle(b);
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

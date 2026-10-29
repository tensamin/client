import { bytesToBase64 } from "mtp";
import * as mtpRaw from "mtp/raw";

export type InvitationTarget = {
  credential: string;
  invitationId: number;
  iotaId: number;
};

export type InvitationDecision =
  | { kind: "wait" }
  | { kind: "activate"; challenge: bigint }
  | { kind: "revoked" }
  | { kind: "expired" };

export function registrationStatusDecision(
  data: Record<string, unknown>,
): InvitationDecision {
  switch (data.InvitationState) {
    case "provisioning":
      return { kind: "wait" };
    case "redeemed":
      if (data.ServerNonce === undefined) {
        throw new Error("Redeemed invitation has no activation challenge.");
      }
      return {
        kind: "activate",
        challenge: BigInt(data.ServerNonce as bigint | number | string),
      };
    case "revoked":
      return { kind: "revoked" };
    case "expired":
      return { kind: "expired" };
    default:
      throw new Error(
        "The registration service returned an unexpected invitation state.",
      );
  }
}

export function parseRawToken(value: string): InvitationTarget | null {
  const parts = value.trim().split("::");
  if (parts.length !== 5 || parts[0] !== "tinv1" || parts[1] !== "o") {
    return null;
  }
  const iotaId = Number(parts[2]);
  const invitationId = Number(parts[3]);
  if (
    !Number.isSafeInteger(iotaId) ||
    iotaId <= 0 ||
    !Number.isSafeInteger(invitationId) ||
    invitationId <= 0 ||
    !parts[4]
  ) {
    return null;
  }
  return { credential: value.trim(), invitationId, iotaId };
}

export function targetFromFragment(fragment: string): InvitationTarget | null {
  const params = new URLSearchParams(
    fragment.includes("?")
      ? fragment.slice(fragment.indexOf("?") + 1)
      : fragment,
  );
  const credential = params.get("invitation");
  const invitationId = Number(params.get("invitation_id"));
  const iotaId = Number(params.get("iota_id"));
  if (
    !credential ||
    !Number.isSafeInteger(invitationId) ||
    invitationId <= 0 ||
    !Number.isSafeInteger(iotaId) ||
    iotaId <= 0
  ) {
    return null;
  }
  return { credential, invitationId, iotaId };
}

export function activationPayload(
  target: InvitationTarget,
  userId: number,
  nonce: bigint,
) {
  const prefix = new TextEncoder().encode("tensamin:invitation-activate:v1\0");
  const output = new Uint8Array(prefix.length + 32);
  output.set(prefix);
  const view = new DataView(output.buffer);
  view.setBigInt64(prefix.length, BigInt(userId));
  view.setBigInt64(prefix.length + 8, BigInt(target.iotaId));
  view.setBigInt64(prefix.length + 16, BigInt(target.invitationId));
  view.setBigUint64(prefix.length + 24, nonce);
  return output;
}

export function invitationPublicKeyBundle(keyring: Uint8Array): Uint8Array {
  const parsed = mtpRaw.WasmKeyring.from_bytes(keyring);
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

export function responseData(data: unknown): Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("The registration service returned malformed data.");
  }
  return data as Record<string, unknown>;
}

export function saveKeyringFile(keyring: Uint8Array) {
  const blob = new Blob([bytesToBase64(keyring)], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "tensamin-keyring.txt";
  anchor.click();
  URL.revokeObjectURL(url);
}

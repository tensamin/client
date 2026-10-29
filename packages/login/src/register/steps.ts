import * as mtpRaw from "mtp/raw";
import {
  activationPayload,
  registrationStatusDecision,
  responseData,
  type InvitationTarget,
} from "./invitation";
import type {
  PendingInvitationRegistration,
  RegistrationClient,
} from "./registration";

export async function resolveOmikron(
  omegaBaseUrl: string,
  iotaId: number,
): Promise<{ url: string; publicKey: string }> {
  const discovery = await fetch(
    `${omegaBaseUrl}api/get/registration-omikron/${iotaId}`,
  );
  if (!discovery.ok) {
    throw new Error("No Omikron is available for registration.");
  }
  const omikron = (await discovery.json()) as {
    ip_address?: string;
    port?: number;
    public_key?: string;
  };
  if (!omikron.ip_address || !omikron.port || !omikron.public_key) {
    throw new Error("Omega returned invalid Omikron connection data.");
  }
  return {
    url: `https://${omikron.ip_address}:${omikron.port}`,
    publicKey: omikron.public_key,
  };
}

export async function redeemInvitation({
  client,
  target,
  username,
  registration,
  publicKeyBase64,
}: {
  client: RegistrationClient;
  target: InvitationTarget;
  username: string;
  registration: PendingInvitationRegistration;
  publicKeyBase64: string;
}): Promise<number> {
  const response = await client.request("RedeemUserInvitation", {
    InvitationAuthority: "omega",
    InvitationId: target.invitationId,
    IotaId: target.iotaId,
    InvitationToken: target.credential,
    Username: username,
    PublicKey: publicKeyBase64,
    ResetToken: registration.resetToken,
    ...(registration.invitationPassword
      ? { InvitationPassword: registration.invitationPassword }
      : {}),
  });
  const userId = Number(responseData(response.data).UserId);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("Omega did not return the new account ID.");
  }
  return userId;
}

export async function awaitProvisionedInvitation({
  client,
  target,
  onAbandoned,
}: {
  client: RegistrationClient;
  target: InvitationTarget;
  onAbandoned: () => Promise<void>;
}): Promise<bigint> {
  for (;;) {
    const status = await client.request("GetUserInvitationStatus", {
      InvitationId: target.invitationId,
      IotaId: target.iotaId,
    });
    const decision = registrationStatusDecision(responseData(status.data));
    if (decision.kind === "wait") {
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      continue;
    }
    if (decision.kind === "activate") return decision.challenge;
    await onAbandoned();
    throw new Error(
      decision.kind === "revoked"
        ? "This invitation was revoked."
        : "This invitation expired.",
    );
  }
}

export async function activateAccount({
  client,
  target,
  userId,
  challenge,
  keyring,
}: {
  client: RegistrationClient;
  target: InvitationTarget;
  userId: number;
  challenge: bigint;
  keyring: Uint8Array;
}): Promise<void> {
  const payload = activationPayload(target, userId, challenge);
  const signed = mtpRaw.sign_data_value_with_keyring(
    mtpRaw.encode_data_value(payload),
    BigInt(userId),
    0x71,
    keyring,
    mtpRaw.mtp_protection_signature_suite_dual(),
  );
  await client.request("RegisteringClientAuthenticate", {
    UserId: userId,
    ServerNonce: challenge,
    Signed: signed,
  });
}

import { MTPClient, MTPProtocolError, base64ToBytes, bytesToBase64 } from "mtp";
import {
  invitationPublicKeyBundle,
  parseRawToken,
  type InvitationTarget,
} from "./invitation";
import {
  activateAccount,
  awaitProvisionedInvitation,
  redeemInvitation,
  resolveOmikron,
} from "./steps";

export type PendingInvitationRegistration = {
  target: InvitationTarget;
  username: string;
  invitationPassword: string;
  keyring: string;
  resetToken: string;
  userId?: number;
};

export type RegistrationClient = Awaited<ReturnType<typeof MTPClient.create>>;

function isActivationRouteUnavailable(error: unknown): boolean {
  return (
    error instanceof MTPProtocolError &&
    error.errorType === "activation_route_unavailable"
  );
}

type RegistrationPlan = {
  username: string;
  target: InvitationTarget;
  omegaBaseUrl: string;
  registration: PendingInvitationRegistration;
};

export async function planRegistration({
  load,
  credential,
  initialTarget,
  pending,
  requestedUsername,
  password,
}: {
  load: (key: "omega_url") => Promise<string>;
  credential: string;
  initialTarget: InvitationTarget | null;
  pending: PendingInvitationRegistration | null;
  requestedUsername: string;
  password: string;
}): Promise<RegistrationPlan> {
  const username = pending?.userId ? pending.username : requestedUsername;
  const target = pending?.target ?? initialTarget ?? parseRawToken(credential);
  if (!target) {
    throw new Error(
      "Use a complete invitation link or a valid raw invitation token.",
    );
  }
  if (!/^[a-z0-9]{1,15}$/.test(username)) {
    throw new Error("Usernames use 1 to 15 lowercase letters or numbers.");
  }
  const omegaUrl = await load("omega_url");
  const omegaBaseUrl = omegaUrl.endsWith("/") ? omegaUrl : `${omegaUrl}/`;
  if (!pending?.userId) {
    const availability = await fetch(
      `${omegaBaseUrl}api/get/id/${encodeURIComponent(username)}`,
    );
    if (availability.ok) throw new Error("That username is already taken.");
    if (availability.status !== 404) {
      throw new Error("Username availability could not be checked.");
    }
  }
  const registration: PendingInvitationRegistration = pending?.userId
    ? pending
    : {
        target,
        username,
        invitationPassword: password,
        keyring: "",
        resetToken: "",
      };
  return { username, target, omegaBaseUrl, registration };
}

export async function persistPending({
  save,
  plan,
  privateKeyring,
  resetToken,
}: {
  save: (
    key: "mtp_keyring" | "pending_invitation_registration",
    value: string,
    options?: { secure: boolean },
  ) => Promise<void>;
  plan: RegistrationPlan;
  privateKeyring: Uint8Array;
  resetToken: string;
}) {
  plan.registration.keyring = bytesToBase64(privateKeyring);
  plan.registration.resetToken = resetToken;
  await save(
    "pending_invitation_registration",
    JSON.stringify(plan.registration),
    { secure: true },
  );
  await save("mtp_keyring", bytesToBase64(privateKeyring), { secure: true });
}

/**
 * One full provisioning attempt: pick a live registration Omikron, redeem
 * the invitation, wait for the Iota, and activate the new account. Returns
 * `"retry"` when the Iota moved and the attempt should restart.
 */
export async function runProvisioningAttempt({
  plan,
  privateKeyring,
  save,
  setMessage,
}: {
  plan: RegistrationPlan;
  privateKeyring: Uint8Array;
  save: (
    key: "mtp_keyring" | "pending_invitation_registration",
    value: string,
    options?: { secure: boolean },
  ) => Promise<void>;
  setMessage: (message: string) => void;
}): Promise<{ kind: "done"; userId: number } | { kind: "retry" }> {
  const { target, username, omegaBaseUrl, registration } = plan;
  setMessage(
    registration.userId
      ? "Resuming account creation…"
      : "Creating your account…",
  );
  const omikron = await resolveOmikron(omegaBaseUrl, target.iotaId);
  const client = await MTPClient.create({
    url: omikron.url,
    descriptor: "registering-client",
    credentials: { clientId: null, keyring: privateKeyring },
    hostPublicKey: { value: omikron.publicKey, encoding: "base64" },
    throwProtocolErrors: true,
  });
  try {
    await client.connectUnauthenticated();
    const userId = await redeemInvitation({
      client,
      target,
      username,
      registration,
      publicKeyBase64: bytesToBase64(invitationPublicKeyBundle(privateKeyring)),
    });
    registration.userId = userId;
    await save(
      "pending_invitation_registration",
      JSON.stringify(registration),
      { secure: true },
    );
    setMessage("Waiting for the Iota to provision your account…");
    const challenge = await awaitProvisionedInvitation({
      client,
      target,
      onAbandoned: async () => {
        await save("pending_invitation_registration", "", { secure: true });
      },
    });
    setMessage("Verifying your new account key…");
    await activateAccount({
      client,
      target,
      userId,
      challenge,
      keyring: privateKeyring,
    });
    return { kind: "done", userId };
  } catch (caught) {
    client.disconnect();
    if (!isActivationRouteUnavailable(caught)) throw caught;
    setMessage("The Iota moved; reconnecting through its current Omikron…");
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    return { kind: "retry" };
  }
}

export async function restorePendingRegistration(
  load: (key: "pending_invitation_registration") => Promise<string>,
): Promise<{
  pending: PendingInvitationRegistration;
  keyring: Uint8Array;
  resetToken: string;
} | null> {
  const savedPending = await load("pending_invitation_registration");
  if (!savedPending) return null;
  try {
    const parsed = JSON.parse(savedPending) as PendingInvitationRegistration;
    const target = parseRawToken(parsed.target.credential) ?? parsed.target;
    if (target.invitationId > 0 && target.iotaId > 0) {
      return {
        pending: { ...parsed, target },
        keyring: base64ToBytes(parsed.keyring),
        resetToken: parsed.resetToken,
      };
    }
  } catch {
    // Invalid persisted state is replaced only after loading has completed.
  }
  return null;
}

import { base64ToBytes, crypto, requestProtected } from "mtp";
import type { MTPProtectedTransport } from "mtp";
import type { StorageContextValue } from "@tensamin/storage/context";
import { utf8Bytes, zeroBytes } from "../bytes";
import { DUAL_SIGNATURE_SUITE, PROTECTION_PURPOSE } from "../protection";
import {
  fetchAccountIdentity,
  fetchIotaIdentity,
  normalizeOmegaOrigin,
} from "../omega";
import {
  canonicalPublicKeyBundle,
  omegaHostOf,
  serializeTuCredential,
  validateRecoveredCredential,
} from "../credential";
import { ProvisioningUnavailableError } from "../errors";
import { encryptCredential, type CredentialBinding } from "./envelope";
import { startRegistration } from "./opaque";
import { provisioning } from "@tensamin/shared/data";

// Management commands are signed by the account key and encrypted to the
// Iota; responses are signed by the Iota and encrypted to the account key.
// All failures surface as ErrorInvalidData with the request id.
const MANAGEMENT_ERROR_TYPES = ["ErrorInvalidData"] as const;

type ManagementAccount = {
  userId: number;
  identity: CredentialBinding;
  keyring: Uint8Array;
  keyringBase64: string;
  omegaHost: string;
  iotaId: number;
  iotaBundle: Uint8Array;
};

async function loadManagementAccount({
  username,
  storage,
  omegaOrigin: omegaInput,
}: {
  username: string;
  storage: Pick<StorageContextValue, "load">;
  omegaOrigin?: string;
}): Promise<ManagementAccount> {
  const omega = normalizeOmegaOrigin(
    omegaInput ?? (await storage.load("omega_url")),
  );
  const account = await fetchAccountIdentity(omega, username);
  const iota = await fetchIotaIdentity(omega, account.iota_id);
  const keyringBase64 = await storage.load("mtp_keyring");
  // Before provisioning the permanent credential, the local keyring must
  // still match Omega (same verification as recovered credentials).
  validateRecoveredCredential({
    content: serializeTuCredential({
      userId: account.user_id,
      privateKey: keyringBase64,
      domain: omegaHostOf(omega),
    }),
    expectedUserId: account.user_id,
    omegaHost: omegaHostOf(omega),
    expectedPublicKey: account.public_key,
  });
  return {
    userId: account.user_id,
    identity: {
      principal: account.principal,
      iotaId: account.iota_id,
      accountPublicKeySha256: crypto.sha256(
        canonicalPublicKeyBundle(account.public_key),
      ),
    },
    keyring: base64ToBytes(keyringBase64),
    keyringBase64,
    omegaHost: omegaHostOf(omega),
    iotaId: account.iota_id,
    iotaBundle: canonicalPublicKeyBundle(iota.public_key),
  };
}

function managementRpcOptions(account: ManagementAccount) {
  return {
    send: {
      receiverId: BigInt(account.iotaId),
      identity: { signerId: account.userId, keyring: account.keyring },
      recipients: [account.iotaBundle],
      signaturePurpose: PROTECTION_PURPOSE.passwordManagementSignature,
      encryptionPurpose: PROTECTION_PURPOSE.passwordManagementEncryption,
      signatureSuite: DUAL_SIGNATURE_SUITE,
    },
    open: {
      recipient: { id: BigInt(account.userId), keyring: account.keyring },
      expectedSignerId: BigInt(account.iotaId),
      expectedReceiverId: BigInt(account.userId),
      resolveSignerPublicKeys: () => [account.iotaBundle],
      signaturePurpose: PROTECTION_PURPOSE.passwordResponseSignature,
      encryptionPurpose: PROTECTION_PURPOSE.passwordResponseEncryption,
      signaturePolicy: DUAL_SIGNATURE_SUITE,
    },
    errorTypes: MANAGEMENT_ERROR_TYPES,
  };
}

export async function enrollPassword({
  client,
  username,
  password,
  storage,
  omegaOrigin,
}: {
  client: MTPProtectedTransport;
  username: string;
  password: Uint8Array;
  storage: Pick<StorageContextValue, "load">;
  omegaOrigin?: string;
}): Promise<{ enabled: true }> {
  const account = await loadManagementAccount({
    username,
    storage,
    omegaOrigin,
  });
  const rpc = managementRpcOptions(account);
  const registration = startRegistration(password);
  let exportKey: Uint8Array | null = null;
  let plaintext: Uint8Array | null = null;
  try {
    const startResponse = await requestProtected(
      client,
      "PasswordEnrollmentStart",
      { OpaqueMessage: registration.request },
      { ...rpc, responseType: "PasswordEnrollmentResponse" },
    );
    if (startResponse.type !== "PasswordEnrollmentResponse")
      throw new ProvisioningUnavailableError("Unexpected enrollment response");
    const startData = provisioning.PasswordEnrollmentResponse.response.parse(
      startResponse.data,
    );
    const enrollmentUuid = startData.Uuid;
    const finished = registration.finish(
      startData.OpaqueMessage,
      account.identity.principal,
      account.identity.iotaId,
    );
    exportKey = finished.exportKey;
    plaintext = utf8Bytes(
      serializeTuCredential({
        userId: account.userId,
        privateKey: account.keyringBase64,
        domain: account.omegaHost,
      }),
    );
    const envelope = encryptCredential(exportKey, account.identity, plaintext);
    zeroBytes(exportKey);
    zeroBytes(plaintext);
    const status = await requestProtected(
      client,
      "PasswordEnrollmentFinish",
      {
        Uuid: enrollmentUuid,
        OpaqueMessage: finished.record,
        EncryptedCredential: envelope,
      },
      { ...rpc, responseType: "PasswordEnrollmentStatus" },
    );
    if (
      status.type !== "PasswordEnrollmentStatus" ||
      !provisioning.PasswordEnrollmentStatus.response.parse(status.data).Enabled
    ) {
      throw new ProvisioningUnavailableError(
        "The Iota did not enable password login",
      );
    }
    return { enabled: true };
  } finally {
    registration.dispose();
    if (exportKey) zeroBytes(exportKey);
    if (plaintext) zeroBytes(plaintext);
  }
}

export async function passwordEnrollmentStatus({
  client,
  username,
  storage,
  omegaOrigin,
}: {
  client: MTPProtectedTransport;
  username: string;
  storage: Pick<StorageContextValue, "load">;
  omegaOrigin?: string;
}): Promise<boolean> {
  const account = await loadManagementAccount({
    username,
    storage,
    omegaOrigin,
  });
  const status = await requestProtected(
    client,
    "PasswordEnrollmentStatus",
    {},
    managementRpcOptions(account),
  );
  if (status.type !== "PasswordEnrollmentStatus")
    throw new ProvisioningUnavailableError(
      "Unexpected password status response",
    );
  return provisioning.PasswordEnrollmentStatus.response.parse(status.data)
    .Enabled;
}

export async function disablePasswordLogin({
  client,
  username,
  storage,
  omegaOrigin,
}: {
  client: MTPProtectedTransport;
  username: string;
  storage: Pick<StorageContextValue, "load">;
  omegaOrigin?: string;
}): Promise<void> {
  const account = await loadManagementAccount({
    username,
    storage,
    omegaOrigin,
  });
  // The Iota answers disable with a PasswordEnrollmentStatus frame.
  const response = await requestProtected(
    client,
    "PasswordEnrollmentDisable",
    {},
    {
      ...managementRpcOptions(account),
      responseType: "PasswordEnrollmentStatus",
    },
  );
  if (
    response.type !== "PasswordEnrollmentStatus" ||
    provisioning.PasswordEnrollmentStatus.response.parse(response.data).Enabled
  ) {
    throw new ProvisioningUnavailableError(
      "The Iota did not disable password login",
    );
  }
}

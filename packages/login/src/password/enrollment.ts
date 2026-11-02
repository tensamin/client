import { crypto, requestProtected } from "mtp";
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
import {
  CredentialVerificationError,
  ProvisioningUnavailableError,
} from "../errors";
import { encryptCredential, type CredentialBinding } from "./envelope";
import { startRegistration } from "./opaque";
import { provisioning } from "@tensamin/shared/data";
import { parsePrincipal } from "@tensamin/shared/principal";
import { passwordRequestFailure } from "./failure";

// Management commands are signed by the account key and encrypted to the
// Iota; responses are signed by the Iota and encrypted to the account key.
const MANAGEMENT_ERROR_TYPES = [
  "ErrorInvalidData",
  "ErrorNotAuthenticated",
  "ErrorInternal",
] as const;

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
  principal,
  storage,
  omegaOrigin: omegaInput,
  signal,
}: {
  username: string;
  principal: string;
  storage: Pick<StorageContextValue, "load">;
  omegaOrigin?: string;
  signal?: AbortSignal;
}): Promise<ManagementAccount> {
  const omega = normalizeOmegaOrigin(
    omegaInput ?? (await storage.load("omega_url")),
  );
  signal?.throwIfAborted();
  const account = await fetchAccountIdentity(omega, username, signal);
  const expected = parsePrincipal(principal);
  if (
    account.principal !== `${expected.authority}#${expected.user_id}` ||
    account.user_id !== expected.user_id
  ) {
    throw new CredentialVerificationError(
      "Password management discovery returned a different principal",
    );
  }
  const iota = await fetchIotaIdentity(omega, account.iota_id, signal);
  const iotaBundle = canonicalPublicKeyBundle(iota.public_key);
  const keyringBase64 = await storage.load("mtp_keyring");
  signal?.throwIfAborted();
  // Before provisioning the permanent credential, the local keyring must
  // still match Omega (same verification as recovered credentials).
  const recovered = validateRecoveredCredential({
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
      accountPublicKeySha256: crypto.sha256(recovered.publicKeyBundle),
    },
    keyring: recovered.keyring,
    keyringBase64,
    omegaHost: omegaHostOf(omega),
    iotaId: account.iota_id,
    iotaBundle,
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
  principal,
  password,
  storage,
  omegaOrigin,
  signal,
}: {
  client: MTPProtectedTransport;
  username: string;
  principal: string;
  password: Uint8Array;
  storage: Pick<StorageContextValue, "load">;
  omegaOrigin?: string;
  signal?: AbortSignal;
}): Promise<{ enabled: true }> {
  const account = await loadManagementAccount({
    username,
    principal,
    storage,
    omegaOrigin,
    signal,
  });
  const rpc = managementRpcOptions(account);
  let registration: ReturnType<typeof startRegistration> | undefined;
  let exportKey: Uint8Array | null = null;
  let plaintext: Uint8Array | null = null;
  try {
    signal?.throwIfAborted();
    registration = startRegistration(password);
    const startResponse = await requestProtected(
      client,
      "PasswordEnrollmentStart",
      { OpaqueMessage: registration.request },
      { ...rpc, responseType: "PasswordEnrollmentResponse" },
    );
    signal?.throwIfAborted();
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
    signal?.throwIfAborted();
    if (
      status.type !== "PasswordEnrollmentStatus" ||
      !provisioning.PasswordEnrollmentStatus.response.parse(status.data).Enabled
    ) {
      throw new ProvisioningUnavailableError(
        "The Iota did not enable password login",
      );
    }
    return { enabled: true };
  } catch (error) {
    throw passwordRequestFailure(error);
  } finally {
    registration?.dispose();
    zeroBytes(account.keyring);
    if (exportKey) zeroBytes(exportKey);
    if (plaintext) zeroBytes(plaintext);
  }
}

export async function passwordEnrollmentStatus({
  client,
  username,
  principal,
  storage,
  omegaOrigin,
  signal,
}: {
  client: MTPProtectedTransport;
  username: string;
  principal: string;
  storage: Pick<StorageContextValue, "load">;
  omegaOrigin?: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const account = await loadManagementAccount({
    username,
    principal,
    storage,
    omegaOrigin,
    signal,
  });
  try {
    signal?.throwIfAborted();
    const status = await requestProtected(
      client,
      "PasswordEnrollmentStatus",
      {},
      managementRpcOptions(account),
    );
    signal?.throwIfAborted();
    if (status.type !== "PasswordEnrollmentStatus")
      throw new ProvisioningUnavailableError(
        "Unexpected password status response",
      );
    return provisioning.PasswordEnrollmentStatus.response.parse(status.data)
      .Enabled;
  } catch (error) {
    throw passwordRequestFailure(error);
  } finally {
    zeroBytes(account.keyring);
  }
}

export async function disablePasswordLogin({
  client,
  username,
  principal,
  storage,
  omegaOrigin,
  signal,
}: {
  client: MTPProtectedTransport;
  username: string;
  principal: string;
  storage: Pick<StorageContextValue, "load">;
  omegaOrigin?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const account = await loadManagementAccount({
    username,
    principal,
    storage,
    omegaOrigin,
    signal,
  });
  try {
    signal?.throwIfAborted();
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
    signal?.throwIfAborted();
    if (
      response.type !== "PasswordEnrollmentStatus" ||
      provisioning.PasswordEnrollmentStatus.response.parse(response.data)
        .Enabled
    ) {
      throw new ProvisioningUnavailableError(
        "The Iota did not disable password login",
      );
    }
  } catch (error) {
    throw passwordRequestFailure(error);
  } finally {
    zeroBytes(account.keyring);
  }
}

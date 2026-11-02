import { bytesToBase64, MTPClient } from "mtp";
import type { MTPVerifiedProtectedMessage } from "mtp";
import { crypto } from "mtp";
import { persistMtpCredentials } from "@tensamin/storage/credentials";
import type { StorageContextValue } from "@tensamin/storage/context";
import { zeroBytes } from "../bytes";
import { DUAL_SIGNATURE_SUITE, PROTECTION_PURPOSE } from "../protection";
import {
  fetchAccountIdentity,
  fetchAccountOmikron,
  fetchIotaIdentity,
  normalizeOmegaOrigin,
  omikronEndpointUrl,
} from "../omega";
import {
  connectProvisioningClient,
  type ProvisioningConnection,
} from "../transport";
import {
  DEFAULT_EVENT_TIMEOUT_MS,
  OperationTimeoutError,
  ProvisioningLifecycle,
} from "../events";
import { AuthenticationFailedError } from "../errors";
import {
  canonicalPublicKeyBundle,
  omegaHostOf,
  requireProvisioningCredentialFields,
  validateRecoveredCredential,
} from "../credential";
import { decryptCredential, type CredentialBinding } from "./envelope";
import { startLogin, type LoginBinding, type LoginClient } from "./opaque";

export type PasswordLoginResult = { userId: number };

let nextFinishRequestId = 1;

export async function loginWithPassword({
  username,
  password,
  omegaOrigin: omegaInput,
  storage,
}: {
  username: string;
  password: Uint8Array;
  omegaOrigin?: string;
  storage: Pick<StorageContextValue, "load" | "save">;
}): Promise<PasswordLoginResult> {
  await MTPClient.init();
  const omega = normalizeOmegaOrigin(
    omegaInput ?? (await storage.load("omega_url")),
  );
  // Unknown accounts are indistinguishable from wrong passwords.
  const account = await fetchAccountIdentity(omega, username).catch(
    () => new AuthenticationFailedError(),
  );
  if (account instanceof AuthenticationFailedError) throw account;
  const [iota, omikron] = await Promise.all([
    fetchIotaIdentity(omega, account.iota_id),
    fetchAccountOmikron(omega, account.iota_id),
  ]);
  const accountBinding: CredentialBinding = {
    principal: account.principal,
    iotaId: account.iota_id,
    accountPublicKeySha256: crypto.sha256(
      canonicalPublicKeyBundle(account.public_key),
    ),
  };
  const connection = await connectProvisioningClient({
    omikron: {
      id: omikron.id,
      url: omikronEndpointUrl(omikron),
      publicKey: omikron.public_key,
    },
  });
  const lifecycle = new ProvisioningLifecycle();
  let login: LoginClient | null = null;
  let finish: ReturnType<LoginClient["finish"]> | null = null;
  let sessionUuid: string | null = null;
  let decrypted: Uint8Array | null = null;
  let recoveredKeyring: Uint8Array | null = null;
  try {
    login = startLogin(password);
    const created = await createPasswordSession(
      connection,
      lifecycle,
      account.user_id,
    );
    sessionUuid = created.data.Uuid;
    lifecycle.markActive();

    // A wrong password fails inside finish before any finalization message
    // exists; never fabricate or send a KE3 afterwards.
    let ke2;
    try {
      // Omikron enriches the Iota-bound copy with the binding fields from
      // the session; the client only identifies the session.
      ke2 = await connection.client.request("PasswordProvisioningStart", {
        Uuid: sessionUuid,
        OpaqueMessage: login.request,
      });
    } catch (error) {
      // Password login disabled and equivalent server refusals collapse
      // into the same client-facing authentication failure.
      lifecycle.fail("start-rejected", error);
      throw new AuthenticationFailedError();
    }
    if (ke2.data.Uuid !== sessionUuid) {
      lifecycle.fail("start-mismatch");
      throw new AuthenticationFailedError();
    }
    const loginBinding: LoginBinding = {
      principal: account.principal,
      iotaId: account.iota_id,
      sessionId: sessionUuid,
      contactKeySha256: crypto.sha256(connection.publicKeyBundle),
    };
    let ke3: Uint8Array;
    try {
      finish = login.finish(ke2.data.OpaqueMessage, loginBinding);
      ke3 = finish.finalization;
    } catch {
      throw new AuthenticationFailedError();
    }

    const credentialFrame = await receiveProvisioningCredential(
      connection,
      lifecycle,
      {
        sessionUuid,
        participantId: created.data.ProvisioningParticipantId,
        iotaId: account.iota_id,
        contactKeyring: connection.keyring,
        iotaBundle: canonicalPublicKeyBundle(iota.public_key),
      },
      ke3,
    );
    lifecycle.markCredentialReceived();

    const { encryptedCredential, fingerprint } =
      requireProvisioningCredentialFields(credentialFrame.data, {
        uuid: sessionUuid,
        method: "password",
        userId: account.user_id,
        iotaId: account.iota_id,
      });
    decrypted = decryptCredential(
      finish.exportKey,
      accountBinding,
      encryptedCredential,
    );
    const recovered = validateRecoveredCredential({
      content: decrypted,
      expectedUserId: account.user_id,
      omegaHost: omegaHostOf(omega),
      expectedPublicKey: account.public_key,
      fingerprint,
    });
    recoveredKeyring = recovered.keyring;

    // Persist before signaling completion; if only completion fails, the
    // local credential stays and completion remains cleanup.
    await persistMtpCredentials({
      storage,
      userId: recovered.userId,
      keyring: bytesToBase64(recovered.keyring),
      domain: omegaHostOf(omega),
    });
    lifecycle.markCompleted();

    await connection.client
      .request("ProvisioningComplete", { Uuid: sessionUuid })
      .catch(() => {
        /* completion is cleanup after successful persistence */
      });
    return { userId: recovered.userId };
  } catch (error) {
    cancelBestEffort(connection, lifecycle, sessionUuid);
    lifecycle.fail("failure", error);
    throw error;
  } finally {
    login?.dispose();
    finish?.exportKey.fill(0);
    if (decrypted) zeroBytes(decrypted);
    recoveredKeyring?.fill(0);
    zeroBytes(connection.keyring);
    connection.disconnect();
  }
}

async function createPasswordSession(
  connection: ProvisioningConnection,
  lifecycle: ProvisioningLifecycle,
  userId: number,
) {
  lifecycle.assertActive("ProvisioningCreate");
  try {
    const created = await connection.client.request("ProvisioningCreate", {
      ProvisioningMethod: "password",
      ProvisioningRole: "contact",
      PublicKey: connection.publicKeyBase64,
      UserId: userId,
    });
    if (
      created.data.ProvisioningMethod !== "password" ||
      created.data.ProvisioningRole !== "contact"
    ) {
      throw new AuthenticationFailedError();
    }
    return created;
  } catch (error) {
    lifecycle.fail("create-rejected", error);
    throw new AuthenticationFailedError();
  }
}

/**
 * Send KE3 and require the protected `ProvisioningCredential`. Omikron
 * forwards the Iota's protected frame with the request id; it is signed by
 * the Iota and encrypted to the temporary Contact key.
 */
async function receiveProvisioningCredential(
  connection: ProvisioningConnection,
  lifecycle: ProvisioningLifecycle,
  binding: {
    sessionUuid: string;
    participantId: number;
    iotaId: number;
    contactKeyring: Uint8Array;
    iotaBundle: Uint8Array;
  },
  ke3: Uint8Array,
): Promise<MTPVerifiedProtectedMessage> {
  lifecycle.assertActive("PasswordProvisioningFinish");
  return new Promise<MTPVerifiedProtectedMessage>((resolve, reject) => {
    const unsubscribers: (() => void)[] = [];
    let settled = false;
    const finishSettle = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      settle();
    };
    const fail = (error: Error) => {
      lifecycle.fail("credential-failed", error);
      finishSettle(() => reject(error));
    };
    const timer = setTimeout(
      () => fail(new OperationTimeoutError("ProvisioningCredential")),
      DEFAULT_EVENT_TIMEOUT_MS,
    );
    const finishRequestId = nextFinishRequestId++;
    unsubscribers.push(
      connection.client.subscribe("ErrorNotAuthenticated", (message) => {
        if (message.id === undefined || message.id === finishRequestId) {
          fail(new AuthenticationFailedError());
        }
      }),
    );
    const request = connection.client
      .request(
        // Omikron enriches the Iota-bound copy with the binding fields from
        // the session; the client only identifies the session.
        "PasswordProvisioningFinish",
        {
          Uuid: binding.sessionUuid,
          OpaqueMessage: ke3,
        },
        // The protected credential frame carries the request id; the
        // router must consume it as this request's response.
        { responseType: "ProvisioningCredential", id: finishRequestId },
      )
      .then((frame) =>
        connection.client.openProtected(
          // Parsed frames always carry their raw wire bytes.
          frame.raw as Uint8Array,
          {
            recipient: binding.contactKeyring.length
              ? {
                  id: BigInt(binding.participantId),
                  keyring: binding.contactKeyring,
                }
              : undefined,
            expectedSignerId: BigInt(binding.iotaId),
            expectedReceiverId: BigInt(binding.participantId),
            resolveSignerPublicKeys: () => [binding.iotaBundle],
            signaturePurpose:
              PROTECTION_PURPOSE.provisioningCredentialSignature,
            encryptionPurpose:
              PROTECTION_PURPOSE.provisioningCredentialEncryption,
            signaturePolicy: DUAL_SIGNATURE_SUITE,
          },
        ),
      );
    request.then(
      (message) => finishSettle(() => resolve(message)),
      (error: unknown) => {
        fail(
          error instanceof OperationTimeoutError
            ? error
            : new AuthenticationFailedError(),
        );
      },
    );
  });
}

function cancelBestEffort(
  connection: ProvisioningConnection,
  lifecycle: ProvisioningLifecycle,
  sessionUuid: string | null,
) {
  if (!sessionUuid) return;
  if (lifecycle.state === "terminal" || lifecycle.state === "completed") return;
  void connection.client
    .send("ProvisioningCancel", { Uuid: sessionUuid })
    .catch(() => {
      /* best-effort; never replaces the original error */
    });
}

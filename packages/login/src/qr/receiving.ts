import { bytesToBase64, type ParsedFrame } from "mtp";
import type { StorageContextValue } from "@tensamin/storage/context";
import { persistMtpCredentials } from "@tensamin/storage/credentials";
import { ProvisioningLifecycle, withEventDeadline } from "../events";
import type { ProvisioningClient } from "../transport";
import { omegaHostOf, type RecoveredCredential } from "../credential";
import {
  verifyAccountBinding,
  type AccountBinding,
  type OmegaAccount,
} from "../omega";
import { openProvisioningCredential } from "./credential";

/**
 * Contact-side receiving half shared by both QR modes: subscribes to
 * account binding, raw credential frames, and cancellation, keeps raw
 * credential frames queued until account identity verification completed,
 * then opens and validates them.
 */
export class ContactCredentialReceiver {
  readonly #client: ProvisioningClient;
  readonly #lifecycle: ProvisioningLifecycle;
  readonly #sessionUuid: string;
  readonly #contactKeyring: Uint8Array;
  readonly #bindingTimeoutMs: number;
  readonly #contactParticipantId: number;
  readonly #unsubscribers: (() => void)[] = [];
  readonly #pendingFrames: ParsedFrame[] = [];
  readonly #frameWaiters: ((frame: ParsedFrame) => void)[] = [];
  #binding: Promise<AccountBinding>;
  #resolveBinding: ((binding: AccountBinding) => void) | null = null;
  #verifiedBinding: Promise<OmegaAccount> | null = null;
  #credential: Promise<RecoveredCredential> | null = null;
  #recovered: RecoveredCredential | null = null;

  constructor({
    client,
    lifecycle,
    sessionUuid,
    contactParticipantId,
    contactKeyring,
    bindingTimeoutMs = 30_000,
  }: {
    client: ProvisioningClient;
    lifecycle: ProvisioningLifecycle;
    sessionUuid: string;
    contactParticipantId: number;
    contactKeyring: Uint8Array;
    bindingTimeoutMs?: number;
  }) {
    this.#client = client;
    this.#lifecycle = lifecycle;
    this.#sessionUuid = sessionUuid;
    this.#contactParticipantId = contactParticipantId;
    this.#contactKeyring = contactKeyring;
    this.#bindingTimeoutMs = bindingTimeoutMs;
    this.#binding = new Promise<AccountBinding>((resolve) => {
      this.#resolveBinding = resolve;
    });
  }

  /** Install subscriptions before the peer can race ahead. */
  install(): void {
    this.#unsubscribers.push(
      this.#client.subscribe("ProvisioningAccountBound", (message) => {
        if (message.data.Uuid !== this.#sessionUuid) return;
        this.#resolveBinding?.(message.data);
      }),
      this.#client.subscribe("ProvisioningCancel", (message) => {
        if (message.data.Uuid === this.#sessionUuid) {
          this.#lifecycle.fail("cancelled");
        }
      }),
      this.#client.subscribeRaw("ProvisioningCredential", (frame) => {
        this.#enqueueFrame(frame as ParsedFrame);
      }),
    );
  }

  async awaitVerifiedBinding(omega: string): Promise<OmegaAccount> {
    this.#verifiedBinding ??= this.#verifyBinding(omega);
    return this.#verifiedBinding;
  }

  async #verifyBinding(omega: string): Promise<OmegaAccount> {
    this.#lifecycle.assertActive("ProvisioningAccountBound wait");
    const binding = await withEventDeadline(
      this.#binding,
      this.#lifecycle,
      "ProvisioningAccountBound",
      this.#bindingTimeoutMs,
    );
    try {
      const account = await verifyAccountBinding({
        omega,
        binding,
        expectedUuid: this.#sessionUuid,
      });
      this.#lifecycle.assertActive("ProvisioningAccountBound verification");
      return account;
    } catch (error) {
      this.#lifecycle.fail("invalid-binding", error);
      throw error;
    }
  }

  /**
   * Drain queued raw credential frames, then wait for further frames until
   * one validates against the independently resolved account identity.
   */
  async awaitRecoveredCredential({
    omega,
    account,
    method,
  }: {
    omega: string;
    account: OmegaAccount;
    method: string;
  }): Promise<RecoveredCredential> {
    this.#credential ??= this.#recover(omega, account, method);
    return this.#credential;
  }

  async #recover(
    omega: string,
    account: OmegaAccount,
    method: string,
  ): Promise<RecoveredCredential> {
    if (this.#contactParticipantId === 0) {
      throw this.#lifecycle.fail("contact-participant-id-unavailable");
    }
    this.#lifecycle.assertActive("ProvisioningCredential wait");
    const raced = await withEventDeadline(
      this.#nextFrame(),
      this.#lifecycle,
      "ProvisioningCredential",
    );
    try {
      const recovered = await openProvisioningCredential({
        client: this.#client,
        frame: raced,
        contactParticipantId: this.#contactParticipantId,
        contactKeyring: this.#contactKeyring,
        expected: {
          uuid: this.#sessionUuid,
          method,
          account,
          omegaHost: omegaHostOf(omega),
        },
      });
      try {
        this.#lifecycle.markCredentialReceived();
      } catch (error) {
        recovered.keyring.fill(0);
        throw error;
      }
      this.#recovered = recovered;
      return recovered;
    } catch (error) {
      this.#lifecycle.fail("credential-verification-failed", error);
      throw error;
    }
  }

  /**
   * Persist before signaling completion. If persistence succeeds but the
   * remote completion fails, the local credential stays; completion is
   * cleanup at that point.
   */
  async persistAndComplete({
    storage,
    recovered,
    omega,
  }: {
    storage: Pick<StorageContextValue, "load" | "save">;
    recovered: RecoveredCredential;
    omega: string;
  }): Promise<void> {
    this.#lifecycle.assertActive("Credential persistence");
    await persistMtpCredentials({
      storage,
      userId: recovered.userId,
      keyring: bytesToBase64(recovered.keyring),
      domain: omegaHostOf(omega),
    });
    this.#lifecycle.markCompleted();
    await this.#client
      .request("ProvisioningComplete", { Uuid: this.#sessionUuid })
      .catch(() => {
        /* best-effort cleanup */
      });
  }

  dispose(): void {
    if (this.#lifecycle.state !== "completed") this.#lifecycle.fail("disposed");
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    this.#pendingFrames.length = 0;
    this.#frameWaiters.length = 0;
    this.#recovered?.keyring.fill(0);
  }

  #enqueueFrame(frame: ParsedFrame): void {
    if (
      this.#lifecycle.state === "terminal" ||
      this.#lifecycle.state === "completed"
    )
      return;
    if (this.#pendingFrames.length >= 4) {
      this.#lifecycle.fail("credential-queue-overflow");
      return;
    }
    const waiter = this.#frameWaiters.shift();
    if (waiter) waiter(frame);
    else this.#pendingFrames.push(frame);
  }

  #nextFrame(): Promise<ParsedFrame> {
    const queued = this.#pendingFrames.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<ParsedFrame>((resolve) => {
      this.#frameWaiters.push(resolve);
    });
  }
}

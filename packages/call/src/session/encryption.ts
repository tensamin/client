import {
  deriveCallSecretId,
  kemPublicKeyFromPublicKeyBundle,
  unwrapCallSecret,
  wrapCallSecret,
} from "@tensamin/crypto/callSecret";
import { mtp } from "@tensamin/shared/data";
import { log, toast } from "@tensamin/shared/log";
import { MTPProtocolError } from "mtp";
import type { CallRuntime as Runtime, WrappedCallSecret } from "../state";
import type { CallSession } from "./instance";
import type { ProtocolCallSecret, ProtocolCallSecretResponse } from "./shared";
import {
  CALL_SECRET_VERSION,
  normalizeWrappedCallSecret,
  protocolBytes,
  protocolCallSecret,
  randomCallSecret,
  requireRuntime,
} from "./shared";

// Request the LiveKit token that authorizes this client to join a call.
export async function getCallToken(
  this: CallSession,
  callId: string,
  callSecret?: ProtocolCallSecret,
  ownerOmikronId?: number,
) {
  const response = await requireRuntime(this.store.getState().runtime)
    .callControl.request(ownerOmikronId, "CallToken", {
      CallId: callId,
      ...(callSecret ? { CallSecret: callSecret } : {}),
    })
    .catch((err) => {
      log(1, "call", "red", "Failed to get call token", err);
      throw err;
    });
  return mtp.CallToken.response.parse(response.data);
}

export async function wrapCallSecretForUser(
  this: CallSession,
  userId: number,
  callId: string,
  callSecret: string,
): Promise<ProtocolCallSecret> {
  const remotePublicKey = await requireRuntime(
    this.store.getState().runtime,
  ).getPublicKey(userId);
  const secretId = deriveCallSecretId(callId);
  const wrapped = await wrapCallSecret({
    callSecret,
    recipientKemPublicKey: kemPublicKeyFromPublicKeyBundle(remotePublicKey),
    callId,
    secretId,
    version: CALL_SECRET_VERSION,
  });
  return {
    SecretId: secretId,
    VersionNumber: CALL_SECRET_VERSION,
    EncryptedSecret: protocolBytes(wrapped.encryptedSecret),
    KemCiphertext: protocolBytes(wrapped.kemCiphertext),
    WrappingScheme: wrapped.wrappingScheme,
  };
}

// Encrypt the active call secret for a recipient and send the call invite.
export async function sendCallInvite(this: CallSession, userId: number) {
  const runtime = requireRuntime(this.store.getState().runtime);
  const { callId, callSecret } = this.store.getState();
  if (!callId || !callSecret) {
    throw new Error("Cannot send call invite without an active call.");
  }
  this.store.setState({ invitedUserId: userId });
  try {
    const response = await runtime.callControl.request(
      this.store.getState().callRoute?.ownerOmikronId,
      "CallInvite",
      {
        ReceiverId: userId,
        CallId: callId,
        CallSecret: await this.wrapCallSecretForUser(
          userId,
          callId,
          callSecret,
        ),
      },
      { timeoutMs: 70000 },
    );
    if (response.type.startsWith("Error")) {
      throw new Error(`Call invitation failed: ${response.type}`);
    }
    mtp.CallInvite.response.parse(response.data);
  } finally {
    if (this.store.getState().invitedUserId === userId) {
      this.store.setState({ invitedUserId: null });
    }
  }
}

export function isCurrentCallAttempt(
  this: CallSession,
  attemptGeneration: number,
) {
  return attemptGeneration === this.callAttemptGeneration;
}

export async function enableCallEncryption(
  this: CallSession,
  callSecret: string,
  attemptGeneration: number,
) {
  await this.getKeyProvider().setKey(callSecret);
  if (!this.isCurrentCallAttempt(attemptGeneration)) return false;
  await this.getRoom().setE2EEEnabled(true);
  if (!this.isCurrentCallAttempt(attemptGeneration)) return false;
  this.store.setState({ callSecret });
  return true;
}

export async function prepareCallEncryption(
  this: CallSession,
  runtime: Runtime,
  attemptGeneration: number,
  callId: string,
  existingCallId: string | undefined,
  callSecret:
    | WrappedCallSecret
    | ProtocolCallSecret
    | ProtocolCallSecretResponse
    | undefined,
): Promise<{
  cancelled: boolean;
  creatorEnvelope?: ProtocolCallSecret;
}> {
  if (callSecret) {
    if (!existingCallId) {
      throw new Error("Cannot unwrap call secret without a call id");
    }
    const wrappedCallSecret = normalizeWrappedCallSecret(callSecret);
    const decryptedSecret = await unwrapCallSecret({
      encryptedSecret: wrappedCallSecret.encryptedSecret,
      kemCiphertext: wrappedCallSecret.kemCiphertext,
      keyring: String(await runtime.load("mtp_keyring")),
      callId: existingCallId,
      secretId: wrappedCallSecret.secretId,
      version: wrappedCallSecret.versionNumber,
      wrappingScheme: wrappedCallSecret.wrappingScheme,
    });
    if (!this.isCurrentCallAttempt(attemptGeneration))
      return { cancelled: true };
    return {
      cancelled: !(await this.enableCallEncryption(
        decryptedSecret,
        attemptGeneration,
      )),
    };
  }
  const random = randomCallSecret();
  if (!(await this.enableCallEncryption(random, attemptGeneration))) {
    return { cancelled: true };
  }
  const ownUserId = Number(await runtime.load("user_id"));
  if (!this.isCurrentCallAttempt(attemptGeneration)) return { cancelled: true };
  const creatorEnvelope = await this.wrapCallSecretForUser(
    ownUserId,
    callId,
    random,
  );
  return {
    cancelled: !this.isCurrentCallAttempt(attemptGeneration),
    creatorEnvelope,
  };
}

export async function connectPreparedCall(
  this: CallSession,
  callId: string,
  token: Awaited<ReturnType<typeof this.getCallToken>>,
  ownerOmikronId: number | undefined,
  attemptGeneration: number,
) {
  if (ownerOmikronId != null && token.OmikronId !== ownerOmikronId) {
    throw new Error(
      `Call owner mismatch: expected ${ownerOmikronId}, received ${token.OmikronId}`,
    );
  }
  if (!token.CallEndpoint) {
    throw new Error("CallToken response did not include a LiveKit endpoint.");
  }
  const onCallPage =
    typeof window !== "undefined" &&
    (window.location.pathname === "/call" ||
      window.location.hash.startsWith("#/call"));
  const finishTransition = this.updateCallView(
    () =>
      this.store.setState({
        view: "grid",
        callCreatedAt: token.CreatedAt ?? null,
        callRoute: {
          ownerOmikronId: token.OmikronId,
          livekitUrl: token.CallEndpoint,
        },
        livekitToken: token.CallToken,
      }),
    "join",
  );
  await finishTransition;
  if (!onCallPage) await this.openCallPage(callId);
  if (!this.isCurrentCallAttempt(attemptGeneration)) return false;
  await this.connect(
    callId,
    token.CallToken,
    token.CallEndpoint,
    attemptGeneration,
  );
  return this.isCurrentCallAttempt(attemptGeneration);
}

export async function sendInitialCallInvite(this: CallSession, userId: number) {
  try {
    await this.sendCallInvite(userId);
  } catch (error) {
    toast(
      "error",
      error instanceof Error
        ? `Call invitation unavailable: ${error.message}`
        : "Call invitation unavailable.",
    );
    log(1, "call", "red", "Failed to send call invite", error);
  }
}

// Prepare encryption and join or create a call with another user.
export async function joinCall(
  this: CallSession,
  userId: number,
  callSecret?:
    WrappedCallSecret | ProtocolCallSecret | ProtocolCallSecretResponse,
  existingCallId?: string,
  sendInvite = true,
  ownerOmikronId?: number,
) {
  const active = this.store.getState();
  if (
    active.state === "closing" ||
    active.state === "connecting" ||
    active.state === "encrypting"
  )
    return;
  if (
    existingCallId &&
    active.callId === existingCallId &&
    active.state !== "closed"
  ) {
    await this.openCallPage(existingCallId);
    return;
  }
  const runtime = requireRuntime(this.store.getState().runtime);
  const attemptGeneration = ++this.callAttemptGeneration;
  this.store.setState({ state: "encrypting" });
  log(2, "call", "purple", "Call creation initialised");
  const isNewCall = !callSecret && !existingCallId;
  try {
    const reservation = isNewCall
      ? mtp.CallReserve.response.parse(
          (await runtime.callControl.request(undefined, "CallReserve", {}))
            .data,
        )
      : null;
    if (!this.isCurrentCallAttempt(attemptGeneration)) return;
    const finalId = existingCallId || reservation!.CallId;
    this.store.setState({
      invitedUserId: sendInvite && !existingCallId ? userId : null,
      callId: finalId,
      callRoute:
        ownerOmikronId != null ? { ownerOmikronId, livekitUrl: null } : null,
    });
    const { cancelled, creatorEnvelope } = await this.prepareCallEncryption(
      runtime,
      attemptGeneration,
      finalId,
      existingCallId,
      callSecret,
    );
    if (cancelled) return;
    const token = creatorEnvelope
      ? mtp.CallActivate.response.parse(
          (
            await runtime.callControl.request(
              reservation!.OmikronId,
              "CallActivate",
              {
                CallId: finalId,
                CallSecret: creatorEnvelope,
              },
            )
          ).data,
        )
      : await this.getCallToken(finalId, undefined, ownerOmikronId);
    if (!this.isCurrentCallAttempt(attemptGeneration)) return;
    if (
      !(await this.connectPreparedCall(
        finalId,
        token,
        ownerOmikronId ?? reservation?.OmikronId,
        attemptGeneration,
      ))
    ) {
      return;
    }
    if (existingCallId && callSecret) {
      const preview = this.store.getState().currentCallData;
      runtime.upsertCall({
        CallId: finalId,
        OmikronId: token.OmikronId,
        CallSecret: protocolCallSecret(normalizeWrappedCallSecret(callSecret)),
        CallMembers: preview?.status === "ready" ? preview.userIds : [userId],
        CallInvited: false,
      });
    }
    if (isNewCall && creatorEnvelope) {
      runtime.upsertCall({
        CallId: finalId,
        OmikronId: token.OmikronId,
        CallSecret: creatorEnvelope,
        CallMembers: [Number(await runtime.load("user_id"))],
        CallInvited: false,
        CreatedAt: token.CreatedAt,
      });
    }
    if (isNewCall && sendInvite) {
      await this.sendInitialCallInvite(userId);
    }
    // Adopt the server-verified member list for the invite picker.
    void this.loadCallData(finalId, token.OmikronId);
  } catch (err) {
    if (!this.isCurrentCallAttempt(attemptGeneration)) return;
    log(1, "call", "red", "Failed to join call", err);
    await this.disconnect();
    throw err;
  }
}

export async function loadCallData(
  this: CallSession,
  callId: string,
  ownerOmikronId?: number,
) {
  const request = ++this.latestCallDataRequest;
  const call = this.store.getState();
  if (call.currentCallData?.status !== "ready" || call.callId !== callId) {
    this.setCurrentCallData({ status: "loading" });
  }
  try {
    const response = await requireRuntime(
      this.store.getState().runtime,
    ).callControl.request(ownerOmikronId, "CallData", { CallId: callId });
    if (
      request !== this.latestCallDataRequest ||
      this.store.getState().callId !== callId
    )
      return;
    const parsed = mtp.CallData.response.parse(response.data);
    this.setCurrentCallData({
      status: "ready",
      userIds: parsed.UserIds,
      createdAt: parsed.CreatedAt,
      callSecret: normalizeWrappedCallSecret(parsed.CallSecret),
    });
    this.store.setState({ callCreatedAt: parsed.CreatedAt });
  } catch (error) {
    if (
      request !== this.latestCallDataRequest ||
      this.store.getState().callId !== callId
    )
      return;
    if (error instanceof MTPProtocolError) {
      if (error.type === "ErrorNotFound") {
        this.setCurrentCallData({ status: "not-found" });
        return;
      }
      if (error.type === "ErrorNotAuthenticated") {
        this.setCurrentCallData({ status: "forbidden" });
        return;
      }
    }
    log(1, "call", "red", "Failed to get call data", {
      callId,
      error,
    });
    this.setCurrentCallData({
      status: "error",
      message:
        error instanceof Error ? error.message : "Failed to load call data.",
    });
  }
}

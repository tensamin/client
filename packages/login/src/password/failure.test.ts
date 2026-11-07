import { describe, expect, it } from "vitest";
import { MTPProtocolError } from "mtp";
import {
  AuthenticationFailedError,
  CredentialVerificationError,
  ProvisioningUnavailableError,
} from "../errors";
import { PasswordServiceError, passwordRequestFailure } from "./failure";

function remoteFailure(code: string, retryable: boolean, type: string) {
  return new MTPProtocolError({
    type,
    id: 17,
    raw: new Uint8Array(),
    data: {
      ErrorType: code,
      Json: new TextEncoder().encode(JSON.stringify({ code, retryable })),
    },
  });
}

describe("Tau password failure decoding", () => {
  it.each([
    ["invalid_request", false, "ErrorInvalidData"],
    ["expired", false, "ErrorInvalidData"],
    ["cancelled", false, "ErrorInvalidData"],
    ["conflict", false, "ErrorInvalidData"],
    ["dependency_unavailable", true, "ErrorInternal"],
    ["rate_limited", true, "ErrorInternal"],
    ["unknown_outcome", true, "ErrorInternal"],
  ] as const)("retains %s and its retry policy", (code, retryable, type) => {
    const result = passwordRequestFailure(remoteFailure(code, retryable, type));
    expect(result).toBeInstanceOf(PasswordServiceError);
    expect(result).toMatchObject({ code, retryable });
    expect(result).not.toBeInstanceOf(AuthenticationFailedError);
  });

  it("keeps unauthorized indistinguishable from other invalid credentials", () => {
    const result = passwordRequestFailure(
      remoteFailure("unauthorized", false, "ErrorNotAuthenticated"),
    );
    expect(result).toBeInstanceOf(AuthenticationFailedError);
    expect((result as Error).message).toBe(
      new AuthenticationFailedError().message,
    );
  });

  it("rejects inconsistent outer type, error code and retry policy", () => {
    for (const error of [
      remoteFailure("unauthorized", true, "ErrorNotAuthenticated"),
      remoteFailure("dependency_unavailable", true, "ErrorNotAuthenticated"),
      remoteFailure("future_code", true, "ErrorInternal"),
    ]) {
      expect(passwordRequestFailure(error)).toBeInstanceOf(
        CredentialVerificationError,
      );
    }
  });

  it("does not relabel network or signature failures as invalid credentials", () => {
    for (const error of [
      new TypeError("Network unavailable"),
      new Error("Signature verification failed"),
    ]) {
      expect(passwordRequestFailure(error)).toBe(error);
    }
    const unavailable = new MTPProtocolError({
      type: "ErrorNoIota",
      data: {},
      raw: new Uint8Array(),
    });
    expect(passwordRequestFailure(unavailable)).toBeInstanceOf(
      ProvisioningUnavailableError,
    );
  });

  it("rejects unknown payload fields and oversized error data", () => {
    for (const Json of [
      new Uint8Array(1025),
      new TextEncoder().encode(
        '{"code":"conflict","retryable":false,"extra":true}',
      ),
    ]) {
      const error = new MTPProtocolError({
        type: "ErrorInvalidData",
        raw: new Uint8Array(),
        data: { ErrorType: "conflict", Json },
      });
      expect(passwordRequestFailure(error)).toBeInstanceOf(
        CredentialVerificationError,
      );
    }
  });
});

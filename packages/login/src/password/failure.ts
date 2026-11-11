import { MTPProtocolError } from "mtp";
import { z } from "zod";
import {
  AuthenticationFailedError,
  CredentialVerificationError,
  ProvisioningUnavailableError,
} from "../errors";

// This is Tau's password::Failure contract, not a classification of passwords or account existence inferred from network errors.
const failure = z.strictObject({
  code: z.enum([
    "invalid_request",
    "unauthorized",
    "expired",
    "cancelled",
    "conflict",
    "dependency_unavailable",
    "rate_limited",
    "unknown_outcome",
  ]),
  retryable: z.boolean(),
});

export class PasswordServiceError extends Error {
  readonly code: z.infer<typeof failure>["code"];
  readonly retryable: boolean;

  constructor(code: z.infer<typeof failure>["code"]) {
    const messages = {
      invalid_request: "The password service rejected an invalid request.",
      unauthorized: "Authentication failed",
      expired: "The password session expired. Start again.",
      cancelled: "The password session was cancelled.",
      conflict:
        "Password settings changed during this request. Check their status before retrying.",
      dependency_unavailable: "The password service is currently unavailable.",
      rate_limited: "Too many password requests. Try again later.",
      unknown_outcome:
        "The password service could not confirm the request outcome.",
    };
    super(messages[code]);
    this.name = "PasswordServiceError";
    this.code = code;
    this.retryable = [
      "dependency_unavailable",
      "rate_limited",
      "unknown_outcome",
    ].includes(code);
  }
}

export function passwordRequestFailure(error: unknown): unknown {
  if (!(error instanceof MTPProtocolError)) return error;
  const outer = z
    .strictObject({
      ErrorType: z.string(),
      Json: z
        .instanceof(Uint8Array)
        .refine((bytes) => bytes.byteLength <= 1024),
      Sha256: z
        .instanceof(Uint8Array)
        .refine((bytes) => bytes.byteLength === 32)
        .optional(),
    })
    .safeParse(error.frame.data);

  if (!outer.success) {
    if (!z.strictObject({}).safeParse(error.frame.data).success) {
      return new CredentialVerificationError(
        "The password service returned an invalid error response.",
      );
    }

    if (error.type === "ErrorNotAuthenticated")
      return new AuthenticationFailedError();

    if (error.type === "ErrorNoIota" || error.type === "ErrorInternal") {
      return new ProvisioningUnavailableError(
        "The password service is currently unavailable.",
      );
    }

    return new CredentialVerificationError(
      "The password service returned an invalid error response.",
    );
  }

  try {
    const fields = failure.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(outer.data.Json),
      ),
    );
    const decoded = new PasswordServiceError(fields.code);
    const type =
      fields.code === "unauthorized"
        ? "ErrorNotAuthenticated"
        : decoded.retryable
          ? "ErrorInternal"
          : "ErrorInvalidData";

    if (
      outer.data.ErrorType !== fields.code ||
      fields.retryable !== decoded.retryable ||
      error.type !== type
    ) {
      throw new Error("Password failure fields do not match");
    }

    return fields.code === "unauthorized"
      ? new AuthenticationFailedError()
      : decoded;
  } catch {
    return new CredentialVerificationError(
      "The password service returned an invalid error response.",
    );
  }
}

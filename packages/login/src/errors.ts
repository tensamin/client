export class ProvisioningUnavailableError extends Error {
  constructor(message = "Provisioning is currently unavailable") {
    super(message);
    this.name = "ProvisioningUnavailableError";
  }
}

export class AuthenticationFailedError extends Error {
  constructor(message = "Authentication failed") {
    super(message);
    this.name = "AuthenticationFailedError";
  }
}

export class SessionTerminatedError extends Error {
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? `Provisioning session terminated: ${reason}`);
    this.name = "SessionTerminatedError";
    this.reason = reason;
  }
}

export class PeerVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerVerificationError";
  }
}

export class AccountVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountVerificationError";
  }
}

export class CredentialVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialVerificationError";
  }
}

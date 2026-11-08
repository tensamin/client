import type { SealedRelayResult } from "./mtpContext";

export function isDefinitiveProtocolRejection(response: {
  type: string;
}): boolean {
  // ErrorInternal and transport failures can follow a committed mutation.
  return [
    "ErrorInvalidData",
    "ErrorNotFound",
    "ErrorNoIota",
    "ErrorNotAuthenticated",
  ].includes(response.type);
}

export class RelayRejectedError extends Error {
  public readonly responseType: string;

  constructor(responseType: string) {
    super(`Relay rejected with ${responseType}`);
    this.responseType = responseType;
    this.name = "RelayRejectedError";
  }
}

export function requireRelaySuccess(response: SealedRelayResult): void {
  if (response.type !== "Success") {
    throw new RelayRejectedError(response.type);
  }
}

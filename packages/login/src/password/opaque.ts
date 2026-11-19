import {
  CurveId,
  clientAkeStart,
  deserializeKE2,
  serializeKE1,
  oprfBlind,
  oprfFinalize,
  recover,
  store,
  unmaskResponse,
} from "@structured-id/opaque";
import { expand } from "@noble/hashes/hkdf.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { finishAke } from "./ake";
import { concatBytes, utf8Bytes, zeroBytes } from "../bytes";
import {
  suite as SUITE,
  deriveKeyPairFromSeed,
  randomizedPassword,
  serverIdentifier,
  buildLoginContext,
  type LoginBinding,
} from "./profile";
export type { LoginBinding } from "./profile";

/**
 * Profile-1 OPAQUE client, matching the shared Rust implementation
 * (opaque-ke 4.0.1: Ristretto255 OPRF, TripleDH with SHA-512, Argon2id
 * 19 MiB / 2 / 1 with a zero 16-byte salt and output length equal to the
 * input length). Passwords and protocol values stay Uint8Array end to end.
 */

function maskingKeyOf(randomized: Uint8Array): Uint8Array {
  return expand(
    sha512,
    randomized,
    utf8Bytes("MaskingKey"),
    SUITE.oprfOutputSize,
  );
}

export type RegistrationClient = {
  readonly request: Uint8Array;
  finish(
    response: Uint8Array,
    principal: string,
    iotaId: number,
  ): { record: Uint8Array; exportKey: Uint8Array };
  dispose(): void;
};

export function startRegistration(password: Uint8Array): RegistrationClient {
  password = password.slice();
  const { blind, blindedElement } = oprfBlind(CurveId.RISTRETTO255, password);
  let disposed = false;
  return {
    request: blindedElement,
    finish(response, principal, iotaId) {
      if (disposed)
        throw new Error("registration state already consumed or disposed");
      disposed = true;
      let randomized: Uint8Array | undefined;
      try {
        if (response.length !== 64)
          throw new Error("Invalid registration response length");
        if (
          response
            .slice(0, 32)
            .every((byte, index) => byte === blindedElement[index])
        )
          throw new Error("Reflected OPRF response");
        const evaluatedElement = response.slice(0, SUITE.elementSize);
        const serverPublicKey = response.slice(
          SUITE.elementSize,
          SUITE.elementSize * 2,
        );
        const oprfOutput = oprfFinalize(
          CurveId.RISTRETTO255,
          password,
          blind,
          evaluatedElement,
        );
        randomized = randomizedPassword(oprfOutput);
        const result = store(
          randomized,
          serverPublicKey,
          deriveKeyPairFromSeed,
          SUITE,
          serverIdentifier(iotaId),
          utf8Bytes(principal),
        );
        const record = concatBytes(
          result.clientPublicKey,
          result.maskingKey,
          result.envelope.nonce,
          result.envelope.authTag,
        );
        result.maskingKey.fill(0);
        return { record, exportKey: result.exportKey };
      } finally {
        randomized?.fill(0);
        zeroBytes(blind);
        zeroBytes(password);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      zeroBytes(blind);
      zeroBytes(password);
    },
  };
}

export type LoginClient = {
  readonly request: Uint8Array;
  finish(
    response: Uint8Array,
    binding: LoginBinding,
  ): { finalization: Uint8Array; exportKey: Uint8Array };
  dispose(): void;
};

export function startLogin(password: Uint8Array): LoginClient {
  password = password.slice();
  const { blind, blindedElement } = oprfBlind(CurveId.RISTRETTO255, password);
  const ake = clientAkeStart(blindedElement, SUITE);
  const ke1Bytes = serializeKE1(ake.ke1);
  let disposed = false;
  return {
    request: ke1Bytes,
    finish(response, binding) {
      if (disposed) throw new Error("login state already consumed or disposed");
      disposed = true;
      let randomized: Uint8Array | undefined;
      let maskingKey: Uint8Array | undefined;
      let recovered: ReturnType<typeof recover> | undefined;
      let succeeded = false;
      try {
        const serverIdentity = serverIdentifier(binding.iotaId);
        const clientIdentity = utf8Bytes(binding.principal);
        if (response.length !== 320) throw new Error("Invalid KE2 length");
        if (
          response
            .slice(0, 32)
            .every((byte, index) => byte === blindedElement[index])
        )
          throw new Error("Reflected OPRF response");
        const ke2 = deserializeKE2(response, SUITE);
        const evaluatedElement = ke2.credentialResponse.slice(
          0,
          SUITE.elementSize,
        );
        const oprfOutput = oprfFinalize(
          CurveId.RISTRETTO255,
          password,
          blind,
          evaluatedElement,
        );
        randomized = randomizedPassword(oprfOutput);
        maskingKey = maskingKeyOf(randomized);
        const maskingNonce = ke2.credentialResponse.slice(
          SUITE.elementSize,
          SUITE.elementSize + SUITE.nonceSize,
        );
        const maskedResponse = ke2.credentialResponse.slice(
          SUITE.elementSize + SUITE.nonceSize,
        );
        const { serverPublicKey, envelope } = unmaskResponse(
          maskingKey,
          maskingNonce,
          maskedResponse,
          SUITE,
        );
        recovered = recover(
          randomized,
          serverPublicKey,
          envelope,
          deriveKeyPairFromSeed,
          SUITE,
          serverIdentity,
          clientIdentity,
        );
        const ke3 = finishAke(
          recovered.clientSecretKey,
          serverPublicKey,
          ke2,
          {
            clientSecretKeyshare: ake.state.clientSecretKeyshare,
            clientNonce: ake.state.clientNonce,
            ke1Serialized: ke1Bytes,
          },
          clientIdentity,
          serverIdentity,
          buildLoginContext(binding),
        );
        succeeded = true;
        return { finalization: ke3, exportKey: recovered.exportKey };
      } finally {
        randomized?.fill(0);
        maskingKey?.fill(0);
        recovered?.clientSecretKey.fill(0);
        if (!succeeded) recovered?.exportKey.fill(0);
        ake.state.clientSecretKeyshare.fill(0);
        zeroBytes(blind);
        zeroBytes(password);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      zeroBytes(blind);
      zeroBytes(password);
      ake.state.clientSecretKeyshare.fill(0);
    },
  };
}

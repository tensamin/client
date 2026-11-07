/// <reference types="node" />
import { readFileSync } from "node:fs";
import { beforeAll, expect, it } from "vitest";
import { initSync } from "mtp/raw";
import { bytesToBase64, crypto, raw } from "mtp";
import { stringifyExactJson } from "@tensamin/shared/exactJson";
import { verifyFileSigningKeyProof } from "./fileSigningKey";
import { verifyPrincipalProof } from "./principalProof";

beforeAll(() =>
  initSync({
    module: readFileSync(
      new URL(
        "../../bindings/wasm/pkg/mtp_wasm_bg.wasm",
        import.meta.resolve("mtp"),
      ),
    ),
  }),
);
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
function bundle(keyring: Uint8Array) {
  const keys = raw.WasmKeyring.from_bytes(keyring);
  const bundle = keys.public_key_bundle();
  try {
    return bundle.to_bytes();
  } finally {
    bundle.free();
    keys.free();
  }
}

it("verifies bounded historical file evidence without granting active relay authorization", () => {
  const authority = crypto.generateKeyring();
  const user = crypto.generateKeyring();
  try {
    const authorityKey = bundle(authority);
    const userKey = bundle(user);
    const principal = {
      authority: `omega-key:${hex(crypto.sha256(authorityKey))}`,
      user_id: 9223372036854775807n,
    };
    const keyId = hex(crypto.sha256(userKey));
    const proof = {
      version: 1n,
      principal,
      authority_kind: "omega",
      key_id: keyId,
      public_key: bytesToBase64(userKey),
      authority_public_key: bytesToBase64(authorityKey),
      authority_signature: "",
    };
    const signingBytes = new TextEncoder().encode(
      JSON.stringify([
        "tensamin-file-signing-key:v1",
        principal.authority,
        principal.user_id.toString(),
        "omega",
        keyId,
        proof.public_key,
      ]),
    );
    const signature = crypto.signDual(authority, signingBytes);
    proof.authority_signature = bytesToBase64(signature);
    expect(
      verifyFileSigningKeyProof(stringifyExactJson(proof), principal, keyId),
    ).toEqual(userKey);
    expect(() =>
      verifyPrincipalProof(stringifyExactJson(proof), {
        principal,
        homePublicKey: proof.authority_public_key,
        now: 200n,
      }),
    ).toThrow();
    for (const offset of [0, 64]) {
      const damaged = signature.slice();
      damaged[offset] ^= 1;
      expect(() =>
        verifyFileSigningKeyProof(
          stringifyExactJson({
            ...proof,
            authority_signature: bytesToBase64(damaged),
          }),
          principal,
          keyId,
        ),
      ).toThrow();
    }
    for (const changed of [
      { version: 2n },
      { authority_kind: "iota" },
      { public_key: proof.authority_public_key },
      { principal: { ...principal, user_id: principal.user_id - 1n } },
      { authority_public_key: proof.public_key },
    ])
      expect(() =>
        verifyFileSigningKeyProof(
          stringifyExactJson({ ...proof, ...changed }),
          principal,
          keyId,
        ),
      ).toThrow();
    expect(() =>
      verifyFileSigningKeyProof(" ".repeat(256 * 1024 + 1), principal, keyId),
    ).toThrow("byte limit");
  } finally {
    authority.fill(0);
    user.fill(0);
  }
});

/// <reference types="node" />
import { readFileSync } from "node:fs";
import { beforeAll, expect, it } from "vitest";
import { initSync } from "mtp/raw";
import { base64ToBytes, bytesToBase64, crypto, raw } from "mtp";
import { parseExactJson, stringifyExactJson } from "@tensamin/shared/exactJson";
import {
  principalDescriptorSigningBytes,
  verifyPrincipalProof,
} from "./principalProof";

const fixture = parseExactJson(
  readFileSync(
    new URL("./fixtures/principal-proof-rust.json", import.meta.url),
    "utf8",
  ),
) as {
  proof: {
    descriptor: Parameters<typeof principalDescriptorSigningBytes>[0];
    authority_public_key: string;
  };
  home_public_key: string;
};
const json = stringifyExactJson(fixture.proof);
const principal = {
  authority: fixture.proof.descriptor.principal.authority,
  user_id: 9223372036854775807n,
};
const expected = {
  principal,
  homePublicKey: fixture.home_public_key,
  now: 200n,
  minimumRevision: 4n,
};

beforeAll(() => {
  initSync({
    module: readFileSync(
      new URL(
        "../../bindings/wasm/pkg/mtp_wasm_bg.wasm",
        import.meta.resolve("mtp"),
      ),
    ),
  });
});

it("verifies Rust's dual-signed descriptor and both historical keys at the i64 boundary", () => {
  const result = verifyPrincipalProof(json, expected);
  expect(result.principal).toEqual(principal);
  expect(result.revision).toBe(4n);
  expect(result.publicKeys).toHaveLength(2);
  expect(result.username).toBe("alice");
  expect(result.displayName).toBe("Alice 雪");
});

it("rejects mismatched pins, subject, home key, rollback and expired or future proofs", () => {
  for (const changed of [
    { principal: { ...principal, user_id: principal.user_id - 1n } },
    { principal: { ...principal, authority: `omega-key:${"a".repeat(64)}` } },
    {
      homePublicKey: fixture.proof.authority_public_key,
    },
    { minimumRevision: 5n },
    { now: 500n },
    { now: 99n },
  ])
    expect(() =>
      verifyPrincipalProof(json, { ...expected, ...changed }),
    ).toThrow();
});

it("rejects either damaged signature and signed-field substitutions", () => {
  const proof = parseExactJson(json) as { descriptor: Record<string, unknown> };
  for (const changed of [
    { username: "mallory" },
    { display_name: "Mallory" },
    { revision: 5n },
    { issued_at: 101n },
    { valid_until: 501n },
    { public_keys: [...(proof.descriptor.public_keys as string[])].reverse() },
    { home: { iota: `iota:v1:${"a".repeat(64)}` } },
  ])
    expect(() =>
      verifyPrincipalProof(
        stringifyExactJson({
          ...proof,
          descriptor: { ...proof.descriptor, ...changed },
        }),
        expected,
      ),
    ).toThrow();
  const signature = base64ToBytes(
    proof.descriptor.authority_signature as string,
  );
  for (const offset of [0, 64]) {
    const damaged = signature.slice();
    damaged[offset] ^= 1;
    expect(() =>
      verifyPrincipalProof(
        stringifyExactJson({
          ...proof,
          descriptor: {
            ...proof.descriptor,
            authority_signature: bytesToBase64(damaged),
          },
        }),
        expected,
      ),
    ).toThrow();
  }
  expect(() =>
    verifyPrincipalProof(
      json.replace('"revision":4', '"revision":4,"revision":4'),
      expected,
    ),
  ).toThrow();
  expect(() =>
    verifyPrincipalProof(" ".repeat(256 * 1024 + 1), expected),
  ).toThrow();
});

it("verifies a direct Iota proof only when the authority also owns its signed home", () => {
  const keyring = crypto.generateKeyring();
  const keys = raw.WasmKeyring.from_bytes(keyring);
  const bundle = keys.public_key_bundle();
  try {
    const publicKey = bundle.to_bytes();
    const fingerprint = Array.from(crypto.sha256(publicKey), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    // Reuse Rust's signed shape, then sign the direct-Iota variant with a real key.
    const proof = parseExactJson(json) as {
      descriptor: Parameters<typeof principalDescriptorSigningBytes>[0];
      authority_public_key: string;
    };
    proof.authority_public_key = bytesToBase64(publicKey);
    proof.descriptor.principal.authority = `authority:iota:v1:${fingerprint}`;
    proof.descriptor.authority_kind = "iota";
    proof.descriptor.home.iota = `iota:v1:${fingerprint}`;
    proof.descriptor.authority_signature = bytesToBase64(
      crypto.signDual(
        keyring,
        principalDescriptorSigningBytes(proof.descriptor),
      ),
    );
    expect(
      verifyPrincipalProof(stringifyExactJson(proof), {
        ...expected,
        principal: proof.descriptor.principal,
        homePublicKey: proof.authority_public_key,
      }).home,
    ).toBe(proof.descriptor.home.iota);
  } finally {
    bundle.free();
    keys.free();
    keyring.fill(0);
  }
});

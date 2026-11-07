import { expect, it } from "vitest";
import {
  decodeFileResponse,
  encodeFileRequest,
  wireFileManifest,
  wireFileShareOffer,
} from "./protocol";

const principal = {
  authority: `omega-key:${"a".repeat(64)}`,
  user_id: 9223372036854775807n,
};
const manifest = {
  key: { origin: principal, file_id: "fixture", version: 9223372036854775807n },
  ciphertext_sha256: new Uint8Array(32).fill(7),
  ciphertext_size: 65576n,
  crypto_format: "tensamin-file-chunks-v1" as const,
  manifest_ciphertext: new Uint8Array(41).fill(8),
  envelope: {
    recipient: principal,
    key_id: "fixture-key",
    wrapping_scheme: "tensamin-file-dek-kem-v1" as const,
    kem_ciphertext: new Uint8Array([0, 1, 255]),
    encrypted_dek: new Uint8Array(72).fill(9),
  },
};

it("round-trips exact Rust-compatible integers and byte arrays without floating-point IDs", () => {
  const text = encodeFileRequest(manifest);
  expect(text).toContain('"user_id":9223372036854775807');
  expect(text).toContain('"version":9223372036854775807');
  expect(text).toContain('"kem_ciphertext":[0,1,255]');
  expect(decodeFileResponse(text, wireFileManifest)).toEqual(manifest);
  const offer = {
    manifest,
    chat_id: "fixture",
    grant_revision: 9223372036854775807n,
    expires_at: 9223372036854775807n,
    signing_public_key: "AQ==",
    signature: new Uint8Array([0, 1, 255]),
  };
  expect(
    decodeFileResponse(encodeFileRequest(offer), wireFileShareOffer),
  ).toEqual(offer);
});

it("rejects malformed sizes, bytes, identities and duplicate fields before use", () => {
  for (const value of [
    { ...manifest, ciphertext_sha256: [256, ...new Array(31).fill(0)] },
    { ...manifest, ciphertext_sha256: [0, ...new Array(30).fill(0)] },
    { ...manifest, ciphertext_size: 65575n },
    { ...manifest, key: { ...manifest.key, version: 0n } },
    {
      ...manifest,
      key: {
        ...manifest.key,
        origin: { ...principal, user_id: 9223372036854775808n },
      },
    },
    { ...manifest, envelope: { ...manifest.envelope, encrypted_dek: [0] } },
    { ...manifest, extra: "not in the contract" },
  ])
    expect(() =>
      decodeFileResponse(encodeFileRequest(value), wireFileManifest),
    ).toThrow();
  const duplicate = encodeFileRequest(manifest).replace(
    '"file_id":"fixture"',
    '"file_id":"fixture","file_id":"fixture"',
  );
  expect(() => decodeFileResponse(duplicate, wireFileManifest)).toThrow();
  expect(() =>
    decodeFileResponse(
      encodeFileRequest(manifest).replace(
        '"version":9223372036854775807',
        '"version":1e3',
      ),
      wireFileManifest,
    ),
  ).toThrow();
});

it("bounds control messages by UTF-8 bytes rather than JavaScript characters", () => {
  expect(() => encodeFileRequest({ text: "ü".repeat(100000) })).toThrow(
    "control limit",
  );
  expect(() =>
    decodeFileResponse(`{"text":"${"ü".repeat(100000)}"}`, wireFileManifest),
  ).toThrow("control limit");
});

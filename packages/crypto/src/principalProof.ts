import { base64ToBytes, bytesToBase64, crypto, raw } from "mtp";
import { z } from "zod";
import { parseExactJson } from "@tensamin/shared/exactJson";
import {
  encodePrincipal,
  wirePrincipalSchema,
  type WirePrincipal,
} from "@tensamin/shared/principal";

const i64 = z
  .bigint()
  .min(-(1n << 63n))
  .max((1n << 63n) - 1n);
const nodeId = z.string().regex(/^iota:v1:[a-f0-9]{64}$/);
const descriptorSchema = z.strictObject({
  version: z.literal(1n),
  principal: wirePrincipalSchema,
  authority_kind: z.enum(["omega", "iota"]),
  username: z.string().nullable().optional(),
  display_name: z.string().nullable().optional(),
  public_keys: z.array(z.base64()).min(1),
  home: z.strictObject({ iota: nodeId }),
  revision: i64.refine((value) => value > 0n),
  valid_until: i64.nullable().optional(),
  issued_at: i64.refine((value) => value >= 0n),
  authority_signature: z.base64(),
  home_node: z.unknown().optional(),
});
const proofSchema = z.strictObject({
  descriptor: descriptorSchema,
  authority_public_key: z.base64(),
});
const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export function canonicalBundle(value: string): Uint8Array {
  const bundle = raw.WasmPublicKeyBundle.from_bytes(base64ToBytes(value));

  try {
    const bytes = bundle.to_bytes();

    if (bytesToBase64(bytes) !== value)
      throw new Error("Noncanonical identity public key");

    return bytes;
  } finally {
    bundle.free();
  }
}

export function principalDescriptorSigningBytes(
  descriptor: z.output<typeof descriptorSchema>,
): Uint8Array {
  const parts: Uint8Array[] = [
    encoder.encode("tensamin-principal-descriptor:v1"),
  ];
  const tag = (value: number) => parts.push(Uint8Array.of(value));
  const number = (value: bigint, width: 4 | 8) => {
    const bytes = new Uint8Array(width);
    const view = new DataView(bytes.buffer);

    if (width === 4) view.setUint32(0, Number(value));
    else view.setBigInt64(0, value);
    parts.push(bytes);
  };

  const bytes = (value: Uint8Array) => {
    number(BigInt(value.length), 4);
    parts.push(value);
  };

  const text = (value: string) => bytes(encoder.encode(value));
  const optionalText = (value: string | null | undefined) => {
    tag(value == null ? 0 : 1);

    if (value != null) text(value);
  };

  text(descriptor.principal.authority);
  number(descriptor.principal.user_id, 8);
  tag(descriptor.authority_kind === "iota" ? 1 : 2);
  optionalText(descriptor.username);
  optionalText(descriptor.display_name);
  number(descriptor.revision, 8);
  tag(descriptor.valid_until == null ? 0 : 1);

  if (descriptor.valid_until != null) number(descriptor.valid_until, 8);
  number(descriptor.issued_at, 8);
  tag(1);
  text(descriptor.home.iota);
  number(BigInt(descriptor.public_keys.length), 4);

  for (const key of descriptor.public_keys) bytes(canonicalBundle(key));
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

/** The caller supplies an already trusted canonical principal and revision floor. */
export function verifyPrincipalProof(
  json: string,
  expected: {
    principal: WirePrincipal;
    homePublicKey: string;
    now: bigint;
    minimumRevision?: bigint;
  },
) {
  if (encoder.encode(json).length > 256 * 1024)
    throw new Error("Identity proof exceeds its byte limit");
  const { descriptor, authority_public_key } = proofSchema.parse(
    parseExactJson(json),
  );
  const authorityKey = canonicalBundle(authority_public_key);
  const fingerprint = hex(crypto.sha256(authorityKey));
  const authority = `${descriptor.authority_kind === "omega" ? "omega-key:" : "authority:iota:v1:"}${fingerprint}`;

  if (
    encodePrincipal(descriptor.principal) !==
      encodePrincipal(expected.principal) ||
    authority !== expected.principal.authority ||
    descriptor.issued_at > expected.now ||
    descriptor.revision < (expected.minimumRevision ?? 1n) ||
    (descriptor.valid_until != null &&
      (descriptor.valid_until <= expected.now ||
        descriptor.valid_until <= descriptor.issued_at)) ||
    (descriptor.authority_kind === "omega" && descriptor.valid_until == null)
  ) {
    throw new Error(
      "Identity proof does not match the trusted principal or freshness bounds",
    );
  }

  const homePublicKey = canonicalBundle(expected.homePublicKey);
  const home = `iota:v1:${hex(crypto.sha256(homePublicKey))}`;

  if (
    descriptor.home.iota !== home ||
    (descriptor.authority_kind === "iota" && home !== `iota:v1:${fingerprint}`)
  ) {
    throw new Error("Identity proof does not bind the supplied home key");
  }

  crypto.verifyDual(
    authorityKey,
    principalDescriptorSigningBytes(descriptor),
    base64ToBytes(descriptor.authority_signature),
  );

  return {
    principal: descriptor.principal,
    publicKeys: descriptor.public_keys.map(canonicalBundle),
    revision: descriptor.revision,
    validUntil: descriptor.valid_until,
    home,
    homePublicKey,
    username: descriptor.username,
    displayName: descriptor.display_name,
  };
}

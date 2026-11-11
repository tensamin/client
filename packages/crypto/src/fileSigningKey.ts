import { base64ToBytes, crypto } from "mtp";
import { z } from "zod";
import {
  encodePrincipal,
  wirePrincipalSchema,
  type WirePrincipal,
} from "@tensamin/shared/principal";
import { parseExactJson } from "@tensamin/shared/exactJson";
import { canonicalBundle } from "./principalProof";

export const fileSigningKeyId = z.string().regex(/^[a-f0-9]{64}$/);
const proofSchema = z.strictObject({
  version: z.literal(1n),
  principal: wirePrincipalSchema,
  authority_kind: z.enum(["omega", "iota"]),
  key_id: fileSigningKeyId,
  public_key: z.base64(),
  authority_public_key: z.base64(),
  authority_signature: z.base64(),
});
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Attests historical file-signing association only, never active relay authority. */
export function verifyFileSigningKeyProof(
  json: string,
  principal: WirePrincipal,
  keyId: string,
) {
  principal = wirePrincipalSchema.parse(principal);
  keyId = fileSigningKeyId.parse(keyId);

  if (new TextEncoder().encode(json).length > 256 * 1024)
    throw new Error("File signing key proof exceeds its byte limit");
  const proof = proofSchema.parse(parseExactJson(json));
  const authorityKey = canonicalBundle(proof.authority_public_key);
  const publicKey = canonicalBundle(proof.public_key);
  const authority = `${proof.authority_kind === "omega" ? "omega-key:" : "authority:iota:v1:"}${hex(crypto.sha256(authorityKey))}`;

  if (
    authority !== principal.authority ||
    encodePrincipal(proof.principal) !== encodePrincipal(principal) ||
    proof.key_id !== keyId ||
    hex(crypto.sha256(publicKey)) !== keyId
  )
    throw new Error(
      "File signing key proof does not match its authority, principal and key",
    );
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      "tensamin-file-signing-key:v1",
      principal.authority,
      principal.user_id.toString(),
      proof.authority_kind,
      keyId,
      proof.public_key,
    ]),
  );
  crypto.verifyDual(
    authorityKey,
    bytes,
    base64ToBytes(proof.authority_signature),
  );

  return publicKey;
}

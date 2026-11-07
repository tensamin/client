/// <reference types="node" />
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { initSync } from "mtp/raw";
import { base64ToBytes, bytesToBase64, crypto, raw } from "mtp";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  decryptFileVersion,
  encryptFileManifest,
  encryptFileVersion,
  FILE_CHUNK_BYTES,
  FILE_RECORD_BYTES,
  openFileManifest,
  unwrapFileKey,
  wrapFileKey,
  type FileKey,
} from "./file";
import {
  signFileShareOffer,
  signFileShareRevoke,
  verifyFileShareOffer,
  verifyFileShareRevoke,
  fileShareOfferSigningBytes,
  fileShareRevokeSigningBytes,
} from "./fileSharing";
import { deriveChatId } from "@tensamin/shared/principal";
import {
  deriveFileAccountMetadataKey,
  encryptFileFolderName,
  decryptFileFolderName,
  encryptFilePlacementMetadata,
  decryptFilePlacementMetadata,
} from "./fileMetadata";

const encoder = new TextEncoder();
const principal = {
  authority: `omega-key:${"a".repeat(64)}`,
  user_id: 9223372036854775806n,
};
const peerPrincipal = { ...principal, user_id: 9223372036854775807n };
const key: FileKey = {
  origin: principal,
  file_id: "fixture-file",
  version: 9223372036854775807n,
};

it("matches Tau's detached file signature golden hashes at the i64 boundary", () => {
  const origin = {
    authority: `omega-key:${"a".repeat(64)}`,
    user_id: 9223372036854775806n,
  };
  const recipient = {
    authority: `omega-key:${"b".repeat(64)}`,
    user_id: 9223372036854775807n,
  };
  const key = { origin, file_id: "golden-file", version: 9223372036854775807n };
  const manifest = {
    key,
    ciphertext_sha256: new Uint8Array(32).fill(7),
    ciphertext_size: 65576n,
    crypto_format: "tensamin-file-chunks-v1" as const,
    manifest_ciphertext: new Uint8Array(41).fill(8),
    envelope: {
      recipient,
      key_id: "recipient-key",
      wrapping_scheme: "tensamin-file-dek-kem-v1" as const,
      kem_ciphertext: new Uint8Array([0, 1, 255]),
      encrypted_dek: new Uint8Array(72).fill(9),
    },
  };
  const offer = {
    manifest,
    chat_id: "fixture-chat",
    grant_revision: 9223372036854775806n,
    expires_at: 9223372036854775807n,
    signing_public_key: "AQ==",
    signature: new Uint8Array(),
  };
  expect(
    Buffer.from(sha256(fileShareOfferSigningBytes(offer))).toString("hex"),
  ).toBe("0352ed5f8541ecf28befb368399dc9c9b44b8ca80aa8dc984b41b7316bfd55a4");
  const revoke = {
    key,
    recipient,
    chat_id: "fixture-chat",
    grant_revision: 9223372036854775807n,
    signing_public_key: "AQ==",
    signature: new Uint8Array(),
  };
  expect(
    Buffer.from(sha256(fileShareRevokeSigningBytes(revoke))).toString("hex"),
  ).toBe("6c55f0ecadce8ad636214ddf95c4da3dcd88f8f55375f37239225c08fab2a7a7");
});
let owner: {
  principal: typeof principal;
  keyId: string;
  keyring: Uint8Array;
  publicKey: Uint8Array;
  publicKeys: readonly Uint8Array[];
};
let peer: typeof owner;

function bundle(keyring: Uint8Array): Uint8Array {
  const keys = raw.WasmKeyring.from_bytes(keyring);
  try {
    const publicKey = keys.public_key_bundle();
    try {
      return publicKey.to_bytes();
    } finally {
      publicKey.free();
    }
  } finally {
    keys.free();
  }
}

beforeAll(() => {
  initSync({
    module: readFileSync(
      new URL(
        "../../bindings/wasm/pkg/mtp_wasm_bg.wasm",
        import.meta.resolve("mtp"),
      ),
    ),
  });
  const ownerKey = crypto.generateKeyring();
  const peerKey = crypto.generateKeyring();
  owner = {
    principal,
    keyId: "owner-key",
    keyring: ownerKey,
    publicKey: bundle(ownerKey),
    publicKeys: [bundle(ownerKey)],
  };
  peer = {
    principal: peerPrincipal,
    keyId: "peer-key",
    keyring: peerKey,
    publicKey: bundle(peerKey),
    publicKeys: [bundle(peerKey)],
  };
});

afterAll(() => {
  owner?.keyring.fill(0);
  peer?.keyring.fill(0);
});

it("keeps private folder and placement metadata account-bound across moves and revisions", async () => {
  const metadataKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const folder = {
    folder_id: "folder-a",
    parent_folder_id: "private",
    revision: 9223372036854775807n,
  };
  const placement = {
    placement_id: "placement-a",
    origin: peerPrincipal,
    file_id: "fixture-file",
    folder_id: "folder-a",
    hidden: false,
    revision: 9223372036854775807n,
  };
  try {
    const ciphertext = await encryptFileFolderName({
      key: metadataKey,
      account: principal,
      folder,
      name: "Private documents",
    });
    await expect(
      decryptFileFolderName({
        key: metadataKey,
        account: principal,
        folder,
        ciphertext,
      }),
    ).resolves.toBe("Private documents");
    const aad = encoder.encode(
      JSON.stringify([
        "tensamin-file-folder-v1",
        principal.authority,
        "9223372036854775806",
        "folder-a",
        "private",
        "9223372036854775807",
      ]),
    );
    expect(
      new TextDecoder().decode(
        xchacha20poly1305(metadataKey, ciphertext.subarray(0, 24), aad).decrypt(
          ciphertext.subarray(24),
        ),
      ),
    ).toBe("Private documents");
    for (const changed of [
      { account: peerPrincipal },
      { folder: { ...folder, folder_id: "folder-b" } },
      { folder: { ...folder, parent_folder_id: "folder-b" } },
      { folder: { ...folder, revision: folder.revision - 1n } },
    ])
      await expect(
        decryptFileFolderName({
          key: metadataKey,
          account: principal,
          folder,
          ciphertext,
          ...changed,
        }),
      ).rejects.toBeDefined();
    for (const metadata of [{}, { filename: "Local override.txt" }]) {
      const ciphertext = await encryptFilePlacementMetadata({
        key: metadataKey,
        account: principal,
        placement,
        metadata,
      });
      await expect(
        decryptFilePlacementMetadata({
          key: metadataKey,
          account: principal,
          placement,
          ciphertext,
        }),
      ).resolves.toEqual(metadata);
      const aad = encoder.encode(
        JSON.stringify([
          "tensamin-file-placement-v1",
          principal.authority,
          "9223372036854775806",
          "placement-a",
          peerPrincipal.authority,
          "9223372036854775807",
          "fixture-file",
          "folder-a",
          false,
          "9223372036854775807",
        ]),
      );
      expect(
        JSON.parse(
          new TextDecoder().decode(
            xchacha20poly1305(
              metadataKey,
              ciphertext.subarray(0, 24),
              aad,
            ).decrypt(ciphertext.subarray(24)),
          ),
        ),
      ).toEqual(metadata);
      for (const changed of [
        { account: peerPrincipal },
        { placement: { ...placement, placement_id: "placement-b" } },
        { placement: { ...placement, origin: principal } },
        { placement: { ...placement, file_id: "other-file" } },
        { placement: { ...placement, folder_id: "private" } },
        { placement: { ...placement, hidden: true } },
        { placement: { ...placement, revision: placement.revision - 1n } },
      ])
        await expect(
          decryptFilePlacementMetadata({
            key: metadataKey,
            account: principal,
            placement,
            ciphertext,
            ...changed,
          }),
        ).rejects.toBeDefined();
    }
  } finally {
    metadataKey.fill(0);
  }
});

it("recovers a domain-separated metadata key from the same account keyring", () => {
  const derived = deriveFileAccountMetadataKey(owner.keyring, principal);
  const restored = deriveFileAccountMetadataKey(
    new Uint8Array(owner.keyring),
    principal,
  );
  const otherAccount = deriveFileAccountMetadataKey(
    owner.keyring,
    peerPrincipal,
  );
  const otherKeyring = deriveFileAccountMetadataKey(peer.keyring, principal);
  const parsed = raw.WasmKeyring.from_bytes(owner.keyring);
  try {
    const canonical = parsed.try_to_bytes();
    try {
      const context = encoder.encode(
        JSON.stringify([
          "tensamin-file-account-metadata-key-v1",
          principal.authority,
          "9223372036854775806",
        ]),
      );
      expect(derived).toEqual(
        hkdf(
          sha256,
          canonical,
          sha256(context),
          encoder.encode("tensamin-file-account-metadata-key-v1"),
          32,
        ),
      );
    } finally {
      canonical.fill(0);
    }
    expect(derived).toEqual(restored);
    expect(derived).not.toEqual(otherAccount);
    expect(derived).not.toEqual(otherKeyring);
    expect(owner.keyring.some((byte) => byte !== 0)).toBe(true);
    expect(() =>
      deriveFileAccountMetadataKey(new Uint8Array(), principal),
    ).toThrow();
  } finally {
    parsed.free();
    derived.fill(0);
    restored.fill(0);
    otherAccount.fill(0);
    otherKeyring.fill(0);
  }
});

it("binds signed shares and revocations to independently authenticated participants and exact descriptors", async () => {
  const file = await encrypted(1);
  const dek = await unwrapFileKey({
    key,
    envelope: file.manifest.envelope,
    recipient: owner.principal,
    keyId: owner.keyId,
    keyring: owner.keyring,
  });
  try {
    const envelope = await wrapFileKey({
      key,
      dek,
      recipient: peer.principal,
      keyId: peer.keyId,
      publicKey: peer.publicKey,
    });
    const manifest = { ...file.manifest, envelope };
    const offer = signFileShareOffer({
      manifest,
      grantRevision: 9223372036854775806n,
      expiresAt: 9223372036854775807n,
      author: owner,
    });
    const expected = {
      author: owner,
      recipient: peer.principal,
      chatId: deriveChatId(principal, peerPrincipal),
      now: 1n,
    };
    expect(verifyFileShareOffer(offer, expected)).toEqual(offer);
    for (const changed of [
      { ...offer, expires_at: offer.expires_at - 1n },
      { ...offer, grant_revision: offer.grant_revision - 1n },
      {
        ...offer,
        manifest: { ...manifest, key: { ...key, version: key.version - 1n } },
      },
      {
        ...offer,
        manifest: {
          ...manifest,
          ciphertext_size: manifest.ciphertext_size * 2n,
        },
      },
      {
        ...offer,
        manifest: {
          ...manifest,
          envelope: { ...envelope, key_id: "other-key" },
        },
      },
      {
        ...offer,
        manifest: { ...manifest, manifest_ciphertext: new Uint8Array(41) },
      },
    ])
      expect(() => verifyFileShareOffer(changed, expected)).toThrow();
    for (const changed of [
      { ...expected, author: { ...owner, publicKeys: peer.publicKeys } },
      { ...expected, author: peer },
      { ...expected, recipient: principal },
      { ...expected, chatId: "different-chat" },
      { ...expected, now: offer.expires_at },
    ])
      expect(() => verifyFileShareOffer(offer, changed)).toThrow();
    for (const offset of [0, 64]) {
      const signature = offer.signature.slice();
      signature[offset] ^= 1;
      expect(() =>
        verifyFileShareOffer({ ...offer, signature }, expected),
      ).toThrow();
    }
    const revoke = signFileShareRevoke({
      key,
      recipient: peer.principal,
      grantRevision: 9223372036854775807n,
      author: owner,
    });
    expect(verifyFileShareRevoke(revoke, expected)).toEqual(revoke);
    expect(() =>
      verifyFileShareRevoke(
        { ...revoke, grant_revision: revoke.grant_revision - 1n },
        expected,
      ),
    ).toThrow();
    expect(() =>
      verifyFileShareRevoke({ ...revoke, recipient: principal }, expected),
    ).toThrow();
    expect(() =>
      signFileShareOffer({
        manifest,
        grantRevision: 1n,
        expiresAt: 2n,
        author: peer,
      }),
    ).toThrow();
    expect(() =>
      signFileShareRevoke({
        key,
        recipient: peer.principal,
        grantRevision: 1n,
        author: peer,
      }),
    ).toThrow();
    expect(() =>
      signFileShareOffer({
        manifest,
        grantRevision: 1n,
        expiresAt: 2n,
        author: { ...owner, keyring: peer.keyring },
      }),
    ).toThrow();
  } finally {
    dek.fill(0);
  }
});

function privateStage() {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  return {
    chunks,
    write: vi.fn(async (chunk: Uint8Array) => {
      chunks.push(new Uint8Array(chunk));
    }),
    commit: vi.fn(async () => {}),
    abort: vi.fn(async () => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    }),
  };
}

async function encrypted(size = 65537) {
  const plaintext = Uint8Array.from(
    { length: size },
    (_, index) => (index * 13 + 7) & 255,
  );
  const stage = privateStage();
  const manifest = await encryptFileVersion({
    key,
    file: new Blob([plaintext]),
    filename: "fixture.txt",
    mimeType: "text/plain",
    owner,
    stage,
  });
  expect(stage.commit).toHaveBeenCalledOnce();
  expect(stage.abort).not.toHaveBeenCalled();
  return { plaintext, ciphertext: new Blob(stage.chunks), manifest };
}

it("resolves only the committed manifest signing key and rejects a substituted historical bundle", async () => {
  const { manifest } = await encrypted();
  const dek = await unwrapFileKey({
    key,
    envelope: manifest.envelope,
    recipient: principal,
    keyId: owner.keyId,
    keyring: owner.keyring,
  });
  const keyId = Buffer.from(sha256(owner.publicKey)).toString("hex");
  const resolveFileSigningKey = vi.fn(async () => owner.publicKey);
  try {
    expect(
      (
        await openFileManifest({
          manifest,
          dek,
          author: { principal, publicKeys: [], resolveFileSigningKey },
        })
      ).filename,
    ).toBe("fixture.txt");
    expect(resolveFileSigningKey).toHaveBeenCalledExactlyOnceWith(keyId);
    resolveFileSigningKey.mockResolvedValue(peer.publicKey);
    await expect(
      openFileManifest({
        manifest,
        dek,
        author: { principal, publicKeys: [], resolveFileSigningKey },
      }),
    ).rejects.toThrow("commitments");
  } finally {
    dek.fill(0);
  }
});

function referenceKeys(dek: Uint8Array) {
  const context = encoder.encode(
    JSON.stringify([
      "tensamin-file-v1",
      principal.authority,
      "9223372036854775806",
      "fixture-file",
      "9223372036854775807",
    ]),
  );
  return {
    context,
    content: hkdf(
      sha256,
      dek,
      sha256(context),
      encoder.encode("tensamin-file-content-v1"),
      32,
    ),
    manifest: hkdf(
      sha256,
      dek,
      sha256(context),
      encoder.encode("tensamin-file-manifest-v1"),
      32,
    ),
  };
}

for (const size of [0, 1, 65535, 65536, 65537, 131080]) {
  it(`authenticates and exports the ${size}-byte boundary with bounded records`, async () => {
    const file = await encrypted(size);
    const expectedChunks = Math.max(1, Math.ceil(size / FILE_CHUNK_BYTES));
    expect(file.ciphertext.size).toBe(expectedChunks * FILE_RECORD_BYTES);
    const stage = privateStage();
    const metadata = await decryptFileVersion({
      ...file,
      recipient: owner,
      author: owner,
      stage,
    });
    expect(metadata).toMatchObject({
      filename: "fixture.txt",
      plaintext_size: size.toString(),
      chunk_count: expectedChunks.toString(),
    });
    expect(new Uint8Array(await new Blob(stage.chunks).arrayBuffer())).toEqual(
      file.plaintext,
    );
    expect(stage.commit).toHaveBeenCalledOnce();
    expect(stage.abort).not.toHaveBeenCalled();
    expect(
      stage.chunks.every((chunk) => chunk.length <= FILE_CHUNK_BYTES),
    ).toBe(true);
  });
}

it("matches an independent HKDF/XChaCha implementation and exact decimal-string AAD", async () => {
  const file = await encrypted(1);
  const dek = await unwrapFileKey({
    key,
    envelope: file.manifest.envelope,
    recipient: owner.principal,
    keyId: owner.keyId,
    keyring: owner.keyring,
  });
  const reference = referenceKeys(dek);
  try {
    const bytes = new Uint8Array(await file.ciphertext.arrayBuffer());
    const aad = encoder.encode(
      JSON.stringify([
        "tensamin-file-chunk-v1",
        principal.authority,
        "9223372036854775806",
        "fixture-file",
        "9223372036854775807",
        "0",
        "1",
        "1",
      ]),
    );
    const plaintext = xchacha20poly1305(
      reference.content,
      bytes.subarray(0, 24),
      aad,
    ).decrypt(bytes.subarray(24));
    expect(plaintext[0]).toBe(file.plaintext[0]);
    expect(plaintext.length).toBe(65536);
    expect(plaintext.subarray(1).every((byte) => byte === 0)).toBe(true);
    const sealed = file.manifest.manifest_ciphertext;
    const metadata = JSON.parse(
      new TextDecoder().decode(
        xchacha20poly1305(
          reference.manifest,
          sealed.subarray(0, 24),
          reference.context,
        ).decrypt(sealed.subarray(24)),
      ),
    );
    expect(metadata.chunk_bytes).toBe("65536");
    expect(metadata.plaintext_size).toBe("1");
    expect(metadata.owner_signing_key_id).toBe(
      Buffer.from(sha256(owner.publicKey)).toString("hex"),
    );
    const proof = encoder.encode(
      JSON.stringify([
        "tensamin-file-owner-v1",
        new TextDecoder().decode(reference.context),
        "fixture.txt",
        "text/plain",
        "1",
        "65536",
        "1",
        Buffer.from(sha256(file.plaintext)).toString("hex"),
        null,
        null,
        Buffer.from(sha256(bytes)).toString("hex"),
        Buffer.from(sha256(dek)).toString("hex"),
        Buffer.from(sha256(owner.publicKey)).toString("hex"),
      ]),
    );
    crypto.verifyDual(
      owner.publicKey,
      proof,
      base64ToBytes(metadata.owner_signature),
    );
    expect(file.manifest.ciphertext_sha256).toEqual(sha256(bytes));
    plaintext.fill(0);
  } finally {
    dek.fill(0);
    reference.content.fill(0);
    reference.manifest.fill(0);
  }
});

it("rewraps one DEK for a verified recipient without changing ciphertext", async () => {
  const file = await encrypted();
  const dek = await unwrapFileKey({
    key,
    envelope: file.manifest.envelope,
    recipient: owner.principal,
    keyId: owner.keyId,
    keyring: owner.keyring,
  });
  try {
    const envelope = await wrapFileKey({
      key,
      dek,
      recipient: peer.principal,
      keyId: peer.keyId,
      publicKey: peer.publicKey,
    });
    const stage = privateStage();
    await decryptFileVersion({
      ...file,
      manifest: { ...file.manifest, envelope },
      recipient: peer,
      author: owner,
      stage,
    });
    expect(new Uint8Array(await new Blob(stage.chunks).arrayBuffer())).toEqual(
      file.plaintext,
    );
    expect(stage.commit).toHaveBeenCalledOnce();
    for (const change of [
      { recipient: owner.principal },
      { keyId: "different-key" },
      { keyring: owner.keyring },
      { key: { ...key, file_id: "other-file" } },
      { key: { ...key, version: key.version - 1n } },
    ]) {
      await expect(
        unwrapFileKey({
          key,
          envelope,
          recipient: peer.principal,
          keyId: peer.keyId,
          keyring: peer.keyring,
          ...change,
        }),
      ).rejects.toBeDefined();
    }
  } finally {
    dek.fill(0);
  }
});

it("verifies an old manifest and a newly signed share against authenticated key history", async () => {
  const file = await encrypted(1);
  const keyring = crypto.generateKeyring();
  const rotated = { ...owner, keyring, publicKey: bundle(keyring) };
  const history = {
    principal,
    publicKeys: [rotated.publicKey, owner.publicKey],
  };
  const dek = await unwrapFileKey({
    key,
    envelope: file.manifest.envelope,
    recipient: principal,
    keyId: owner.keyId,
    keyring: owner.keyring,
  });
  try {
    const envelope = await wrapFileKey({
      key,
      dek,
      recipient: peer.principal,
      keyId: peer.keyId,
      publicKey: peer.publicKey,
    });
    const manifest = { ...file.manifest, envelope };
    const offer = signFileShareOffer({
      manifest,
      grantRevision: 1n,
      expiresAt: 100n,
      author: rotated,
    });
    const expected = {
      author: history,
      recipient: peer.principal,
      chatId: deriveChatId(principal, peer.principal),
      now: 1n,
    };
    expect(verifyFileShareOffer(offer, expected)).toEqual(offer);
    const stage = privateStage();
    await decryptFileVersion({
      ...file,
      manifest,
      recipient: peer,
      author: history,
      stage,
    });
    expect(new Uint8Array(await new Blob(stage.chunks).arrayBuffer())).toEqual(
      file.plaintext,
    );
    expect(stage.commit).toHaveBeenCalledOnce();
    expect(() =>
      verifyFileShareOffer(offer, { ...expected, author: owner }),
    ).toThrow();
    await expect(
      openFileManifest({
        manifest,
        dek,
        author: { principal, publicKeys: [rotated.publicKey] },
      }),
    ).rejects.toThrow();
  } finally {
    dek.fill(0);
    keyring.fill(0);
  }
});

it("rejects truncation, trailing bytes and tampering without publishing staged plaintext", async () => {
  const file = await encrypted();
  const bytes = new Uint8Array(await file.ciphertext.arrayBuffer());
  const variants = [bytes.slice(0, -1), new Uint8Array([...bytes, 0])];
  for (const offset of [0, 24, FILE_RECORD_BYTES - 1, bytes.length - 1]) {
    const tampered = bytes.slice();
    tampered[offset] ^= 1;
    variants.push(tampered);
  }
  for (const variant of variants) {
    const stage = privateStage();
    await expect(
      decryptFileVersion({
        ...file,
        ciphertext: new Blob([variant]),
        recipient: owner,
        author: owner,
        stage,
      }),
    ).rejects.toBeDefined();
    expect(stage.commit).not.toHaveBeenCalled();
    expect(stage.abort).toHaveBeenCalledOnce();
    expect(stage.chunks).toHaveLength(0);
  }
});

it("checks the signed ciphertext digest even when a recipient forges a valid chunk tag", async () => {
  const file = await encrypted(1);
  const dek = await unwrapFileKey({
    key,
    envelope: file.manifest.envelope,
    recipient: owner.principal,
    keyId: owner.keyId,
    keyring: owner.keyring,
  });
  const reference = referenceKeys(dek);
  try {
    const altered = new Uint8Array(65536);
    altered[0] = file.plaintext[0] ^ 1;
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(24));
    const aad = encoder.encode(
      JSON.stringify([
        "tensamin-file-chunk-v1",
        principal.authority,
        "9223372036854775806",
        "fixture-file",
        "9223372036854775807",
        "0",
        "1",
        "1",
      ]),
    );
    const record = new Uint8Array([
      ...nonce,
      ...xchacha20poly1305(reference.content, nonce, aad).encrypt(altered),
    ]);
    const stage = privateStage();
    await expect(
      decryptFileVersion({
        ...file,
        ciphertext: new Blob([record]),
        recipient: owner,
        author: owner,
        stage,
      }),
    ).rejects.toThrow("digest");
    expect(stage.write).toHaveBeenCalledOnce();
    expect(stage.commit).not.toHaveBeenCalled();
    expect(stage.chunks).toHaveLength(0);
    altered.fill(0);
  } finally {
    dek.fill(0);
    reference.content.fill(0);
    reference.manifest.fill(0);
  }
});

it("rejects authenticated nonzero padding even with a valid updated owner proof and hash", async () => {
  const file = await encrypted(1);
  const dek = await unwrapFileKey({
    key,
    envelope: file.manifest.envelope,
    recipient: owner.principal,
    keyId: owner.keyId,
    keyring: owner.keyring,
  });
  const reference = referenceKeys(dek);
  try {
    const metadata = await openFileManifest({
      manifest: file.manifest,
      dek,
      author: owner,
    });
    const padded = new Uint8Array(65536);
    padded[0] = file.plaintext[0];
    padded[65535] = 1;
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(24));
    const aad = encoder.encode(
      JSON.stringify([
        "tensamin-file-chunk-v1",
        principal.authority,
        "9223372036854775806",
        "fixture-file",
        "9223372036854775807",
        "0",
        "1",
        "1",
      ]),
    );
    const record = new Uint8Array([
      ...nonce,
      ...xchacha20poly1305(reference.content, nonce, aad).encrypt(padded),
    ]);
    const hash = sha256(record);
    const manifest = {
      ...file.manifest,
      ciphertext_sha256: hash,
      manifest_ciphertext: await encryptFileManifest({
        key,
        dek,
        metadata,
        ciphertextHash: hash,
        ciphertextSize: BigInt(record.length),
        authorKeyring: owner.keyring,
        authorPublicKey: owner.publicKey,
      }),
    };
    const stage = privateStage();
    await expect(
      decryptFileVersion({
        manifest,
        ciphertext: new Blob([record]),
        recipient: owner,
        author: owner,
        stage,
      }),
    ).rejects.toThrow("padding");
    expect(stage.commit).not.toHaveBeenCalled();
    expect(stage.chunks).toHaveLength(0);
    padded.fill(0);
  } finally {
    dek.fill(0);
    reference.content.fill(0);
    reference.manifest.fill(0);
  }
});

it("rejects duplicate or unknown manifest fields rather than silently normalizing them", async () => {
  const file = await encrypted(1);
  const dek = await unwrapFileKey({
    key,
    envelope: file.manifest.envelope,
    recipient: owner.principal,
    keyId: owner.keyId,
    keyring: owner.keyring,
  });
  const reference = referenceKeys(dek);
  try {
    const sealed = file.manifest.manifest_ciphertext;
    const body = new TextDecoder().decode(
      xchacha20poly1305(
        reference.manifest,
        sealed.subarray(0, 24),
        reference.context,
      ).decrypt(sealed.subarray(24)),
    );
    for (const changed of [
      body.replace('{"filename":', '{"filename":"fixture.txt","filename":'),
      `${body.slice(0, -1)},"unknown":"field"}`,
    ]) {
      const nonce = globalThis.crypto.getRandomValues(new Uint8Array(24));
      const encrypted = xchacha20poly1305(
        reference.manifest,
        nonce,
        reference.context,
      ).encrypt(encoder.encode(changed));
      await expect(
        openFileManifest({
          manifest: {
            ...file.manifest,
            manifest_ciphertext: new Uint8Array([...nonce, ...encrypted]),
          },
          dek,
          author: owner,
        }),
      ).rejects.toBeDefined();
    }
  } finally {
    dek.fill(0);
    reference.content.fill(0);
    reference.manifest.fill(0);
  }
});

it("rejects recipient-authenticated metadata changes and either damaged owner signature", async () => {
  const file = await encrypted(1);
  const dek = await unwrapFileKey({
    key,
    envelope: file.manifest.envelope,
    recipient: owner.principal,
    keyId: owner.keyId,
    keyring: owner.keyring,
  });
  const reference = referenceKeys(dek);
  try {
    const sealed = file.manifest.manifest_ciphertext;
    const body = JSON.parse(
      new TextDecoder().decode(
        xchacha20poly1305(
          reference.manifest,
          sealed.subarray(0, 24),
          reference.context,
        ).decrypt(sealed.subarray(24)),
      ),
    );
    const changedBodies = [{ ...body, filename: "forged.txt" }];
    for (const offset of [0, 64]) {
      const signature = base64ToBytes(body.owner_signature);
      signature[offset] ^= 1;
      changedBodies.push({
        ...body,
        owner_signature: bytesToBase64(signature),
      });
    }
    for (const changed of changedBodies) {
      const nonce = globalThis.crypto.getRandomValues(new Uint8Array(24));
      const encrypted = xchacha20poly1305(
        reference.manifest,
        nonce,
        reference.context,
      ).encrypt(encoder.encode(JSON.stringify(changed)));
      const stage = privateStage();
      await expect(
        decryptFileVersion({
          ...file,
          manifest: {
            ...file.manifest,
            manifest_ciphertext: new Uint8Array([...nonce, ...encrypted]),
          },
          recipient: owner,
          author: owner,
          stage,
        }),
      ).rejects.toBeDefined();
      expect(stage.write).not.toHaveBeenCalled();
      expect(stage.commit).not.toHaveBeenCalled();
      expect(stage.abort).toHaveBeenCalledOnce();
    }
  } finally {
    dek.fill(0);
    reference.content.fill(0);
    reference.manifest.fill(0);
  }
});

it("accepts authenticated JSON whitespace and escaped keys but rejects escaped duplicates", async () => {
  const file = await encrypted(1);
  const dek = await unwrapFileKey({
    key,
    envelope: file.manifest.envelope,
    recipient: owner.principal,
    keyId: owner.keyId,
    keyring: owner.keyring,
  });
  const reference = referenceKeys(dek);
  try {
    const sealed = file.manifest.manifest_ciphertext;
    const body = JSON.parse(
      new TextDecoder().decode(
        xchacha20poly1305(
          reference.manifest,
          sealed.subarray(0, 24),
          reference.context,
        ).decrypt(sealed.subarray(24)),
      ),
    );
    const text = JSON.stringify(body, null, 2).replace(
      '"filename"',
      '"file\\u006eame"',
    );
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(24));
    const encrypted = xchacha20poly1305(
      reference.manifest,
      nonce,
      reference.context,
    ).encrypt(encoder.encode(text));
    await expect(
      openFileManifest({
        manifest: {
          ...file.manifest,
          manifest_ciphertext: new Uint8Array([...nonce, ...encrypted]),
        },
        dek,
        author: owner,
      }),
    ).resolves.toMatchObject({ filename: "fixture.txt" });
    const duplicate = text.replace(
      '"file\\u006eame"',
      '"filename":"fixture.txt", "file\\u006eame"',
    );
    const nextNonce = globalThis.crypto.getRandomValues(new Uint8Array(24));
    const duplicateEncrypted = xchacha20poly1305(
      reference.manifest,
      nextNonce,
      reference.context,
    ).encrypt(encoder.encode(duplicate));
    await expect(
      openFileManifest({
        manifest: {
          ...file.manifest,
          manifest_ciphertext: new Uint8Array([
            ...nextNonce,
            ...duplicateEncrypted,
          ]),
        },
        dek,
        author: owner,
      }),
    ).rejects.toThrow("Duplicate");
  } finally {
    dek.fill(0);
    reference.content.fill(0);
    reference.manifest.fill(0);
  }
});

it("does not let public KEM keys substitute an attacker's file for the authenticated author", async () => {
  const file = await encrypted(1);
  const attackerKey = crypto.generateKeyring();
  const attacker = {
    ...owner,
    keyring: attackerKey,
    publicKey: bundle(attackerKey),
  };
  const encryptedStage = privateStage();
  let dek: Uint8Array | undefined;
  try {
    const forged = await encryptFileVersion({
      key,
      file: new Blob(["forged"]),
      filename: "fixture.txt",
      mimeType: "text/plain",
      owner: attacker,
      stage: encryptedStage,
    });
    dek = await unwrapFileKey({
      key,
      envelope: forged.envelope,
      recipient: principal,
      keyId: owner.keyId,
      keyring: attackerKey,
    });
    const envelope = await wrapFileKey({
      key,
      dek,
      recipient: principal,
      keyId: owner.keyId,
      publicKey: owner.publicKey,
    });
    const stage = privateStage();
    await expect(
      decryptFileVersion({
        manifest: { ...forged, envelope },
        ciphertext: new Blob(encryptedStage.chunks),
        recipient: owner,
        author: owner,
        stage,
      }),
    ).rejects.toThrow("commitments");
    expect(stage.write).not.toHaveBeenCalled();
    expect(stage.commit).not.toHaveBeenCalled();
    expect(stage.abort).toHaveBeenCalledOnce();
    await expect(
      openFileManifest({ manifest: file.manifest, dek, author: owner }),
    ).rejects.toBeDefined();
  } finally {
    attackerKey.fill(0);
    dek?.fill(0);
  }
});

it("cancels private staging before export and rejects unsafe export names", async () => {
  const file = await encrypted();
  const controller = new AbortController();
  const stage = privateStage();
  stage.write.mockImplementation(async (chunk) => {
    stage.chunks.push(new Uint8Array(chunk));
    controller.abort(new Error("cancelled fixture"));
  });
  await expect(
    decryptFileVersion({
      ...file,
      recipient: owner,
      author: owner,
      stage,
      signal: controller.signal,
    }),
  ).rejects.toThrow("cancelled fixture");
  expect(stage.commit).not.toHaveBeenCalled();
  expect(stage.abort).toHaveBeenCalledOnce();
  expect(stage.chunks).toHaveLength(0);
  for (const filename of [
    "../outside",
    "a\\b",
    "CON.txt",
    "trailing.",
    "nul\0byte",
  ]) {
    const rejectedStage = privateStage();
    await expect(
      encryptFileVersion({
        key,
        file: new Blob(["x"]),
        filename,
        mimeType: "text/plain",
        owner,
        stage: rejectedStage,
      }),
    ).rejects.toBeDefined();
    expect(rejectedStage.write).not.toHaveBeenCalled();
    expect(rejectedStage.commit).not.toHaveBeenCalled();
  }
});

/// <reference types="node" />
import { readFileSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
  it,
  vi,
} from "vitest";
import { initSync } from "mtp/raw";
import { bytesToBase64, crypto, raw } from "mtp";
import { z } from "zod";
import type { BoundSendFn } from "@tensamin/mtp";
import type { PrincipalRelaySend } from "@tensamin/mtp/principalRelay";
import type { createPrincipalProofResolver } from "@tensamin/mtp/principalProof";
import {
  verifyFileShareOffer,
  verifyFileShareRevoke,
} from "@tensamin/crypto/fileSharing";
import type { WirePrincipal } from "@tensamin/shared/principal";
import { deriveChatId } from "@tensamin/shared/principal";
import {
  encryptFileVersion,
  decryptFileVersion,
  openFileManifest,
  unwrapFileKey,
  wrapFileKey,
  fileKeySchema,
  type FileStage,
} from "@tensamin/crypto/file";
import { createFileService } from "./service";
import { encryptFileManifest } from "@tensamin/crypto/file";
import {
  deriveFileAccountMetadataKey,
  encryptFileFolderName,
  encryptFilePlacementMetadata,
} from "@tensamin/crypto/fileMetadata";
import {
  encodeFileRequest,
  decodeFileResponse,
  fileBytes,
  wireFileManifest,
  wireFileShareOffer,
  wireFileShareRevoke,
} from "./protocol";

const io = vi.hoisted(() => ({
  remove: vi.fn(),
  output: [] as Uint8Array<ArrayBuffer>[],
  records: new Map<string, unknown>(),
  write: vi.fn(),
  folder: vi.fn(),
  placement: vi.fn(),
  synchronize: vi.fn(),
}));
vi.mock("@tensamin/shared/indexedDb", () => ({
  getDatabaseEntry: async (store: string, key: string) =>
    io.records.get(`${store}:${key}`),
  getOrCreateDatabaseEntry: async (
    store: string,
    key: string,
    value: unknown,
  ) => {
    const id = `${store}:${key}`;
    if (!io.records.has(id)) io.records.set(id, value);
    return io.records.get(id);
  },
  setDatabaseEntry: async (store: string, key: string, value: unknown) => {
    await io.write();
    io.records.set(`${store}:${key}`, value);
  },
  deleteDatabaseEntry: async (store: string, key: string) => {
    io.records.delete(`${store}:${key}`);
  },
  listDatabaseEntries: async () => [],
}));
vi.mock("./staging", () => ({
  createCiphertextStage: async () => {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    return {
      id: "fixture-stage",
      stage: {
        write: async (bytes: Uint8Array) => {
          chunks.push(bytes.slice());
        },
        commit: async () => {},
        abort: io.remove,
      },
      file: async () => new Blob(chunks),
    };
  },
}));
vi.mock("./journal", () => ({
  createFileJournal: () => ({
    synchronize: io.synchronize,
    grant: async () => undefined,
    folder: io.folder,
    placement: io.placement,
  }),
}));

const principal = { authority: `omega-key:${"a".repeat(64)}`, user_id: 7n };
const key = { origin: principal, file_id: "fixture-file", version: 1n };
const assetId = "6a34654a-d9d2-4c7b-a6d2-a16ba6aa5781";
let keyring: Uint8Array;
let publicKey: Uint8Array;
let manifest: Awaited<ReturnType<typeof encryptFileVersion>>;
let ciphertext: Uint8Array;
const plaintext = new Uint8Array(300_000).fill(42);

beforeAll(async () => {
  initSync({
    module: readFileSync(
      new URL(
        "../../bindings/wasm/pkg/mtp_wasm_bg.wasm",
        import.meta.resolve("mtp"),
      ),
    ),
  });
  keyring = crypto.generateKeyring();
  const keys = raw.WasmKeyring.from_bytes(keyring);
  const bundle = keys.public_key_bundle();
  try {
    publicKey = bundle.to_bytes();
  } finally {
    bundle.free();
    keys.free();
  }
  const records: Uint8Array<ArrayBuffer>[] = [];
  manifest = await encryptFileVersion({
    key,
    file: new Blob([plaintext]),
    filename: "example.bin",
    mimeType: "application/octet-stream",
    owner: { principal, keyId: "owner-key", keyring, publicKey },
    stage: {
      write: async (bytes) => {
        records.push(bytes.slice());
      },
      commit: async () => {},
      abort: async () => {},
    },
  });
  ciphertext = new Uint8Array(await new Blob(records).arrayBuffer());
});
afterAll(() => keyring.fill(0));
beforeEach(() => {
  io.remove.mockReset();
  io.output = [];
  io.write.mockReset();
  io.folder.mockReset();
  io.placement.mockReset();
  io.synchronize.mockReset();
  for (const key of io.records.keys())
    if (key.startsWith("cache:")) io.records.delete(key);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("indexedDB", {});
});
afterEach(() => vi.unstubAllGlobals());

function enableCommandLocks() {
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _key: string,
        _options: unknown,
        operation: () => Promise<unknown>,
      ) => operation(),
    },
  });
}

function activeProof(who: WirePrincipal, publicKeys = [publicKey]) {
  return {
    principal: who,
    publicKeys,
    revision: 1n,
    validUntil: BigInt(Date.now() + 60_000),
    home: `iota:v1:${"a".repeat(64)}`,
    homePublicKey: publicKey,
    username: undefined,
    displayName: undefined,
  };
}

function setup(
  publicKeys = [publicKey],
  ownerKeys = { keyId: "owner-key", keyring, publicKey },
) {
  const controller = new AbortController();
  const current = { manifest, metadata_revision: 1n };
  const mutation = vi.fn(async () => ({ Json: '{"ok":true}' }));
  const range = vi.fn(async (offset: number, amount: number) => ({
    AssetId: assetId,
    Size: ciphertext.length,
    Offset: offset,
    Sha256: manifest.ciphertext_sha256,
    Blob: ciphertext.slice(offset, offset + amount),
  }));
  const send = vi.fn(
    async (
      type: string,
      data: { Offset?: number; Amount?: number; Json?: string },
    ) => {
      if (type === "FileGetManifest")
        return {
          type,
          data: {
            Json: encodeFileRequest({
              manifest: current.manifest,
              proof: null,
              metadata_revision: current.metadata_revision,
              asset_id: assetId,
              state: "ready",
              transfer: null,
              reserved_bytes: 0n,
            }),
          },
        };
      if (
        type === "UserAssetGetChunk" &&
        typeof data.Offset === "number" &&
        typeof data.Amount === "number"
      )
        return { type, data: await range(data.Offset, data.Amount) };
      if (
        [
          "FileMetadataPut",
          "FileKeyEnvelopePut",
          "FileFolderPut",
          "FileFolderDelete",
          "FilePlacementPut",
          "FilePlacementDelete",
        ].includes(type)
      )
        return { type, data: await mutation() };
      throw new Error(`Unexpected request: ${type}`);
    },
  );
  const sendRelay = vi
    .fn<PrincipalRelaySend>()
    .mockResolvedValue({ type: "Success", data: {} });
  const resolveActive = vi.fn<ReturnType<typeof createPrincipalProofResolver>>(
    async (who) => activeProof(who),
  );
  const service = createFileService({
    accountKey: "fixture-account",
    account: principal,
    owner: ownerKeys,
    send: send as unknown as BoundSendFn,
    sendRelay,
    signal: controller.signal,
    resolveAuthor: async () => ({ principal, publicKeys }),
    resolveActive,
  });
  const stage: FileStage = {
    write: vi.fn(async (bytes: Uint8Array) => {
      io.output.push(bytes.slice());
    }),
    commit: vi.fn(async () => {}),
    abort: vi.fn(async () => {
      io.output = [];
    }),
  };
  return {
    service,
    stage,
    range,
    send,
    controller,
    current,
    mutation,
    sendRelay,
    resolveActive,
  };
}

it("shares the unchanged ciphertext descriptor with a verified recipient envelope and dual-signed grant", async () => {
  const { service, send, sendRelay, resolveActive } = setup();
  const recipient = { authority: `omega-key:${"b".repeat(64)}`, user_id: 7n };
  const recipientKeys = crypto.generateKeyring();
  const keys = raw.WasmKeyring.from_bytes(recipientKeys);
  const bundle = keys.public_key_bundle();
  const recipientPublicKey = bundle.to_bytes();
  bundle.free();
  keys.free();
  resolveActive.mockImplementation(async (who) =>
    activeProof(who, [
      who.authority === recipient.authority ? recipientPublicKey : publicKey,
    ]),
  );
  try {
    const offer = await service.share({
      key,
      recipient: { principal: recipient, keyId: "recipient-key" },
      grantRevision: 2n,
      expiresAt: BigInt(Date.now() + 60_000),
    });
    expect(sendRelay).toHaveBeenCalledOnce();
    const [peer, type, body] = sendRelay.mock.calls[0];
    expect(peer).toEqual({ ...recipient, user_id: 7 });
    expect(type).toBe("FileShareOffered");
    const decoded = decodeFileResponse(body.Json as string, wireFileShareOffer);
    verifyFileShareOffer(decoded, {
      author: { principal, publicKeys: [publicKey] },
      recipient,
      chatId: offer.chat_id,
      now: BigInt(Date.now()),
    });
    expect(decoded.manifest.manifest_ciphertext).toEqual(
      manifest.manifest_ciphertext,
    );
    expect(decoded.manifest.ciphertext_sha256).toEqual(
      manifest.ciphertext_sha256,
    );
    expect(decoded.manifest.ciphertext_size).toBe(manifest.ciphertext_size);
    const dek = await unwrapFileKey({
      key,
      envelope: decoded.manifest.envelope,
      recipient,
      keyId: "recipient-key",
      keyring: recipientKeys,
    });
    try {
      expect(
        (
          await openFileManifest({
            manifest: decoded.manifest,
            dek,
            author: { principal, publicKeys: [publicKey] },
          })
        ).filename,
      ).toBe("example.bin");
    } finally {
      dek.fill(0);
    }
    expect(send.mock.calls.map(([type]) => type)).toEqual(["FileGetManifest"]);
  } finally {
    recipientKeys.fill(0);
  }
});

it("refuses sharing from historical signing evidence alone and does not trust mismatched recipient proofs", async () => {
  const recipient = { authority: `omega-key:${"b".repeat(64)}`, user_id: 9n };
  const request = {
    key,
    recipient: { principal: recipient, keyId: "recipient-key" },
    grantRevision: 2n,
    expiresAt: BigInt(Date.now() + 60_000),
  };
  const retired = setup();
  retired.resolveActive.mockImplementation(async (who) => activeProof(who, []));
  await expect(retired.service.share(request)).rejects.toThrow("not active");
  expect(retired.sendRelay).not.toHaveBeenCalled();
  const foreign = setup();
  foreign.resolveActive.mockImplementation(async () => activeProof(principal));
  await expect(foreign.service.share(request)).rejects.toThrow(
    "authenticated active key",
  );
  expect(foreign.sendRelay).not.toHaveBeenCalled();
});

it("can share historically signed content using a different currently active grant-signing key", async () => {
  const currentKeyring = crypto.generateKeyring();
  const keys = raw.WasmKeyring.from_bytes(currentKeyring);
  const bundle = keys.public_key_bundle();
  const currentPublicKey = bundle.to_bytes();
  bundle.free();
  keys.free();
  const recipient = { authority: `omega-key:${"b".repeat(64)}`, user_id: 9n };
  const { service, current, resolveActive } = setup([publicKey], {
    keyId: "current-owner",
    keyring: currentKeyring,
    publicKey: currentPublicKey,
  });
  const dek = await unwrapFileKey({
    key,
    envelope: manifest.envelope,
    recipient: principal,
    keyId: "owner-key",
    keyring,
  });
  try {
    current.manifest = {
      ...manifest,
      envelope: await wrapFileKey({
        key,
        dek,
        recipient: principal,
        keyId: "current-owner",
        publicKey: currentPublicKey,
      }),
    };
    resolveActive.mockImplementation(async (who) =>
      activeProof(who, [
        who.authority === principal.authority ? currentPublicKey : publicKey,
      ]),
    );
    const offer = await service.share({
      key,
      recipient: { principal: recipient, keyId: "recipient-key" },
      grantRevision: 4n,
      expiresAt: BigInt(Date.now() + 60_000),
    });
    expect(offer.signing_public_key).toBe(bytesToBase64(currentPublicKey));
    verifyFileShareOffer(offer, {
      author: { principal, publicKeys: [currentPublicKey] },
      recipient,
      chatId: offer.chat_id,
      now: BigInt(Date.now()),
    });
    expect(offer.manifest.manifest_ciphertext).toEqual(
      manifest.manifest_ciphertext,
    );
    const recipientDek = await unwrapFileKey({
      key,
      envelope: offer.manifest.envelope,
      recipient,
      keyId: "recipient-key",
      keyring,
    });
    try {
      expect(
        (
          await openFileManifest({
            manifest: offer.manifest,
            dek: recipientDek,
            author: { principal, publicKeys: [publicKey] },
          })
        ).filename,
      ).toBe("example.bin");
    } finally {
      recipientDek.fill(0);
    }
  } finally {
    dek.fill(0);
    currentKeyring.fill(0);
  }
});

it("does not authorize a metadata signature with historical evidence for a retired owner key", async () => {
  enableCommandLocks();
  const { service, resolveActive, mutation } = setup([publicKey]);
  resolveActive.mockImplementation(async (who) => activeProof(who, []));
  await expect(service.rename(key, "replacement.bin")).rejects.toThrow(
    "not authenticated",
  );
  expect(mutation).not.toHaveBeenCalled();
});

it("rejects expired grants and received-file resharing before transmission", async () => {
  const { service, send, sendRelay } = setup();
  const recipient = {
    principal: { authority: `omega-key:${"b".repeat(64)}`, user_id: 9n },
    keyId: "recipient-key",
  };
  await expect(
    service.share({ key, recipient, grantRevision: 1n, expiresAt: 1n }),
  ).rejects.toThrow("future");
  await expect(
    service.share({
      key: { ...key, origin: recipient.principal },
      recipient,
      grantRevision: 1n,
      expiresAt: BigInt(Date.now() + 60_000),
    }),
  ).rejects.toThrow("Only the author");
  expect(send).not.toHaveBeenCalled();
  expect(sendRelay).not.toHaveBeenCalled();
});

it("revokes the exact version and canonical recipient without downloading or re-encrypting content", async () => {
  const { service, send, sendRelay } = setup();
  const recipient = { authority: `omega-key:${"b".repeat(64)}`, user_id: 7n };
  const revoke = await service.revoke({ key, recipient, grantRevision: 3n });
  const [peer, type, body] = sendRelay.mock.calls[0];
  expect(peer).toEqual({ ...recipient, user_id: 7 });
  expect(type).toBe("FileShareRevoked");
  const decoded = decodeFileResponse(body.Json as string, wireFileShareRevoke);
  verifyFileShareRevoke(decoded, {
    author: { principal, publicKeys: [publicKey] },
    recipient,
    chatId: revoke.chat_id,
  });
  expect(decoded.key).toEqual(key);
  expect(decoded.grant_revision).toBe(3n);
  expect(send).not.toHaveBeenCalled();
  sendRelay.mockResolvedValueOnce({ type: "ErrorInternal", data: {} });
  await expect(
    service.revoke({ key, recipient, grantRevision: 4n }),
  ).rejects.toThrow("Relay rejected");
});

it("lists grant revisions across versions without losing canonical recipients or revocation tombstones", async () => {
  const { service, send } = setup();
  const recipient = { authority: `omega-key:${"b".repeat(64)}`, user_id: 7n };
  const grant = {
    key,
    recipient,
    chat_id: deriveChatId(principal, recipient),
    grant_revision: 3n,
    state: "revoked",
    expires_at: 0n,
  };
  const grants = [
    grant,
    {
      ...grant,
      key: { ...key, version: 2n },
      grant_revision: 4n,
      state: "accepted",
      expires_at: BigInt(Date.now() + 60_000),
    },
  ];
  send.mockResolvedValueOnce({
    type: "FileListPage",
    data: { Json: encodeFileRequest({ items: grants, next: 19n }) },
  });
  expect(await service.shares(key.file_id, principal, 7n)).toEqual({
    items: grants,
    next: 19n,
  });
  expect(send).toHaveBeenCalledExactlyOnceWith("FileListPage", {
    Json: encodeFileRequest({
      namespace: "shares",
      folder_id: key.file_id,
      origin: principal,
      after: 7n,
    }),
  });
});

it("rejects grant pages that substitute a file, authority or conversation", async () => {
  const { service, send } = setup();
  const recipient = { authority: `omega-key:${"b".repeat(64)}`, user_id: 7n };
  const grant = {
    key,
    recipient,
    chat_id: deriveChatId(principal, recipient),
    grant_revision: 3n,
    state: "offered",
    expires_at: 1n,
  };
  for (const other of [
    { ...grant, key: { ...key, file_id: "another-file" } },
    { ...grant, key: { ...key, origin: recipient } },
    { ...grant, chat_id: "another-conversation" },
  ]) {
    send.mockResolvedValueOnce({
      type: "FileListPage",
      data: { Json: encodeFileRequest({ items: [other], next: null }) },
    });
    await expect(service.shares(key.file_id)).rejects.toThrow(
      "another file or conversation",
    );
  }
});

it("reconciles lost metadata replies only against a verified current manifest without replay", async () => {
  enableCommandLocks();
  for (const outcome of ["resolved", "superseded"] as const) {
    const { service, send, current, mutation } = setup();
    mutation.mockRejectedValueOnce(new Error("Reply lost"));
    await expect(service.rename(key, "desired.bin")).rejects.toThrow(
      "Reply lost",
    );
    const resource = `metadata:${encodeFileRequest(key)}`;
    await expect(service.reconcileCommand(resource)).resolves.toMatchObject({
      outcome: "unknown",
    });
    const json = send.mock.calls.find(
      ([type]) => type === "FileMetadataPut",
    )?.[1].Json;
    if (!json) throw new Error("Missing metadata command");
    const desired = decodeFileResponse(
      json,
      z.strictObject({
        key: fileKeySchema,
        expected_revision: z.bigint(),
        manifest_ciphertext: fileBytes,
      }),
    );
    if (outcome === "resolved")
      current.manifest = {
        ...manifest,
        manifest_ciphertext: desired.manifest_ciphertext,
      };
    else {
      const dek = await unwrapFileKey({
        key,
        envelope: manifest.envelope,
        recipient: principal,
        keyId: "owner-key",
        keyring,
      });
      try {
        const metadata = await openFileManifest({
          manifest,
          dek,
          author: { principal, publicKeys: [publicKey] },
        });
        current.manifest = {
          ...manifest,
          manifest_ciphertext: await encryptFileManifest({
            key,
            dek,
            metadata: { ...metadata, filename: "winner.bin" },
            ciphertextHash: manifest.ciphertext_sha256,
            ciphertextSize: manifest.ciphertext_size,
            authorKeyring: keyring,
            authorPublicKey: publicKey,
          }),
        };
      } finally {
        dek.fill(0);
      }
    }
    current.metadata_revision = 2n;
    await expect(service.reconcileCommand(resource)).resolves.toMatchObject({
      outcome,
    });
    expect(mutation).toHaveBeenCalledOnce();
    await expect(service.resumeCommand(resource)).rejects.toThrow(
      "unavailable",
    );
  }
});

it("retains metadata intent when the newer manifest cannot authenticate", async () => {
  enableCommandLocks();
  const { service, current, mutation } = setup();
  mutation.mockRejectedValueOnce(new Error("Reply lost"));
  await expect(service.rename(key, "desired.bin")).rejects.toThrow();
  current.manifest = {
    ...manifest,
    manifest_ciphertext: new Uint8Array(manifest.manifest_ciphertext),
  };
  current.manifest.manifest_ciphertext[0] ^= 1;
  current.metadata_revision = 2n;
  await expect(
    service.reconcileCommand(`metadata:${encodeFileRequest(key)}`),
  ).rejects.toThrow();
  await expect(service.rename(key, "replacement.bin")).rejects.toThrow(
    "pending file command",
  );
  expect(mutation).toHaveBeenCalledOnce();
});

it("reconciles deleted folder and placement tombstones without replaying deletion", async () => {
  enableCommandLocks();
  for (const kind of ["folder", "placement"] as const) {
    const { service, mutation } = setup();
    const id = `${kind}-fixture`;
    mutation.mockRejectedValueOnce(new Error("Reply lost"));
    await expect(
      kind === "folder"
        ? service.deleteFolder(id, 1n)
        : service.deletePlacement(id, 1n),
    ).rejects.toThrow("Reply lost");
    const getter = kind === "folder" ? io.folder : io.placement;
    await expect(
      service.reconcileCommand(`${kind}:${id}`),
    ).resolves.toMatchObject({ outcome: "unknown" });
    getter.mockResolvedValueOnce({
      kind: `${kind}_deleted`,
      payload: { id, expected_revision: 1n },
    });
    await expect(
      service.reconcileCommand(`${kind}:${id}`),
    ).resolves.toMatchObject({ outcome: "resolved" });
    expect(mutation).toHaveBeenCalledOnce();
  }
});

it("authenticates synchronized folder and placement winners before clearing superseded intent", async () => {
  enableCommandLocks();
  const metadataKey = deriveFileAccountMetadataKey(keyring, principal);
  try {
    for (const kind of ["folder", "placement"] as const) {
      const { service, mutation } = setup();
      mutation.mockRejectedValueOnce(new Error("Reply lost"));
      const folder = {
        folder_id: "folder-fixture",
        parent_folder_id: "private",
        revision: 1n,
      };
      const placement = {
        placement_id: "placement-fixture",
        origin: principal,
        file_id: key.file_id,
        folder_id: "private",
        hidden: false,
        revision: 1n,
      };
      await expect(
        kind === "folder"
          ? service.putFolder({ folderId: folder.folder_id, name: "desired" })
          : service.putPlacement(placement, { filename: "desired.bin" }),
      ).rejects.toThrow("Reply lost");
      const resource =
        kind === "folder"
          ? `folder:${folder.folder_id}`
          : `placement:${placement.placement_id}`;
      const getter = kind === "folder" ? io.folder : io.placement;
      await expect(service.reconcileCommand(resource)).resolves.toMatchObject({
        outcome: "unknown",
      });
      const context =
        kind === "folder"
          ? { ...folder, revision: 2n }
          : { ...placement, revision: 2n };
      const encrypted =
        kind === "folder"
          ? await encryptFileFolderName({
              key: metadataKey,
              account: principal,
              folder: { ...folder, revision: 2n },
              name: "winner",
            })
          : await encryptFilePlacementMetadata({
              key: metadataKey,
              account: principal,
              placement: { ...placement, revision: 2n },
              metadata: { filename: "winner.bin" },
            });
      const field = kind === "folder" ? "encrypted_name" : "encrypted_metadata";
      const tampered = new Uint8Array(encrypted);
      tampered[0] ^= 1;
      getter.mockResolvedValueOnce({
        kind,
        payload: { ...context, [field]: tampered },
      });
      await expect(service.reconcileCommand(resource)).rejects.toThrow();
      getter.mockResolvedValueOnce({
        kind,
        payload: { ...context, [field]: encrypted },
      });
      await expect(service.reconcileCommand(resource)).resolves.toMatchObject({
        outcome: "superseded",
      });
      expect(mutation).toHaveBeenCalledOnce();
    }
  } finally {
    metadataKey.fill(0);
  }
});

it("downloads bounded account-local ciphertext ranges and commits only verified plaintext", async () => {
  const { service, stage, range } = setup();
  const metadata = await service.download(key, stage);
  expect(metadata.filename).toBe("example.bin");
  expect(range.mock.calls.map(([, amount]) => amount)).toEqual([
    256 * 1024,
    ciphertext.length - 256 * 1024,
  ]);
  expect(new Uint8Array(await new Blob(io.output).arrayBuffer())).toEqual(
    plaintext,
  );
  expect(stage.commit).toHaveBeenCalledOnce();
  expect(stage.abort).not.toHaveBeenCalled();
  expect(io.remove).toHaveBeenCalledOnce();
});

it("closes the private stage when secure intent persistence is unavailable before encryption", async () => {
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _key: string,
        _options: unknown,
        operation: () => Promise<unknown>,
      ) => operation(),
    },
  });
  io.write.mockRejectedValueOnce(new Error("Storage unavailable"));
  const { service, send } = setup();
  await expect(
    service.upload({
      file: new Blob([plaintext]),
      filename: "example.bin",
      mimeType: "application/octet-stream",
    }),
  ).rejects.toThrow("Storage unavailable");
  expect(send).not.toHaveBeenCalled();
  expect(io.remove).toHaveBeenCalledOnce();
});

it("rejects wrong range identities, offsets, sizes, hashes and short bodies before plaintext export", async () => {
  for (const changed of [
    { AssetId: "other-asset" },
    { Offset: 1 },
    { Size: ciphertext.length + 1 },
    { Sha256: new Uint8Array(32) },
    { Blob: ciphertext.slice(0, 1) },
  ]) {
    io.remove.mockClear();
    const { service, stage, range } = setup();
    range.mockResolvedValueOnce({
      AssetId: assetId,
      Size: ciphertext.length,
      Offset: 0,
      Sha256: manifest.ciphertext_sha256,
      Blob: ciphertext.slice(0, 256 * 1024),
      ...changed,
    });
    await expect(service.download(key, stage)).rejects.toThrow(
      "range does not match",
    );
    expect(stage.write).not.toHaveBeenCalled();
    expect(stage.commit).not.toHaveBeenCalled();
    expect(stage.abort).toHaveBeenCalled();
    expect(io.remove).toHaveBeenCalledOnce();
  }
});

it("rejects tampered content even when the asset server repeats the expected checksum", async () => {
  const { service, stage, range } = setup();
  const damaged = ciphertext.slice(0, 256 * 1024);
  damaged[100] ^= 1;
  range.mockResolvedValueOnce({
    AssetId: assetId,
    Size: ciphertext.length,
    Offset: 0,
    Sha256: manifest.ciphertext_sha256,
    Blob: damaged,
  });
  await expect(service.download(key, stage)).rejects.toThrow();
  expect(stage.commit).not.toHaveBeenCalled();
  expect(io.output).toEqual([]);
  expect(io.remove).toHaveBeenCalledOnce();
});

it("fences a replaced account during download and cleans up without committing", async () => {
  const { service, stage, range, controller } = setup();
  range.mockImplementationOnce(async (offset, amount) => {
    controller.abort(new Error("Account replaced"));
    return {
      AssetId: assetId,
      Size: ciphertext.length,
      Offset: offset,
      Sha256: manifest.ciphertext_sha256,
      Blob: ciphertext.slice(offset, offset + amount),
    };
  });
  await expect(service.download(key, stage)).rejects.toThrow(
    "Account replaced",
  );
  expect(stage.commit).not.toHaveBeenCalled();
  expect(io.remove).toHaveBeenCalledOnce();
});

it("renames by signing a fresh manifest without reading or re-encrypting content", async () => {
  vi.stubGlobal("indexedDB", {});
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _key: string,
        _options: unknown,
        operation: () => Promise<unknown>,
      ) => operation(),
    },
  });
  const { service, send, range, stage } = setup();
  await service.rename(key, "renamed.bin");
  const json = send.mock.calls.find(([type]) => type === "FileMetadataPut")?.[1]
    .Json;
  if (!json) throw new Error("Metadata mutation was not sent");
  const mutation = decodeFileResponse(
    json,
    z.strictObject({
      key: fileKeySchema,
      expected_revision: z.bigint(),
      manifest_ciphertext: fileBytes,
    }),
  );
  expect(mutation.key).toEqual(key);
  expect(mutation.expected_revision).toBe(1n);
  expect(mutation.manifest_ciphertext).not.toEqual(
    manifest.manifest_ciphertext,
  );
  const metadata = await decryptFileVersion({
    manifest: {
      ...manifest,
      manifest_ciphertext: mutation.manifest_ciphertext,
    },
    ciphertext: new Blob([new Uint8Array(ciphertext)]),
    recipient: { principal, keyId: "owner-key", keyring },
    author: { principal, publicKeys: [publicKey] },
    stage,
  });
  expect(metadata.filename).toBe("renamed.bin");
  expect(new Uint8Array(await new Blob(io.output).arrayBuffer())).toEqual(
    plaintext,
  );
  expect(range).not.toHaveBeenCalled();
  expect(send.mock.calls.map(([type]) => type)).toEqual([
    "FileGetManifest",
    "FileMetadataPut",
  ]);
});

it("rewraps the same DEK only to an independently authenticated replacement account key", async () => {
  vi.stubGlobal("indexedDB", {});
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _key: string,
        _options: unknown,
        operation: () => Promise<unknown>,
      ) => operation(),
    },
  });
  const rotatedKeyring = crypto.generateKeyring();
  const keys = raw.WasmKeyring.from_bytes(rotatedKeyring);
  const bundle = keys.public_key_bundle();
  try {
    const target = { keyId: "rotated-owner-key", publicKey: bundle.to_bytes() };
    const untrusted = setup();
    await expect(untrusted.service.rewrap(key, target)).rejects.toThrow(
      "not authenticated",
    );
    expect(untrusted.send.mock.calls.map(([type]) => type)).toEqual([
      "FileGetManifest",
    ]);
    const { service, send, range, resolveActive } = setup([publicKey]);
    resolveActive.mockImplementation(async (who) =>
      activeProof(who, [target.publicKey]),
    );
    await service.rewrap(key, target);
    const json = send.mock.calls.find(
      ([type]) => type === "FileKeyEnvelopePut",
    )?.[1].Json;
    if (!json) throw new Error("Key-envelope mutation was not sent");
    const mutation = decodeFileResponse(
      json,
      z.strictObject({
        key: fileKeySchema,
        expected_key_id: z.string(),
        envelope: z.unknown(),
      }),
    );
    expect(mutation.expected_key_id).toBe("owner-key");
    const replacement = decodeFileResponse(
      encodeFileRequest({ ...manifest, envelope: mutation.envelope }),
      wireFileManifest,
    );
    const dek = await unwrapFileKey({
      key,
      envelope: replacement.envelope,
      recipient: principal,
      keyId: target.keyId,
      keyring: rotatedKeyring,
    });
    try {
      const metadata = await openFileManifest({
        manifest: replacement,
        dek,
        author: { principal, publicKeys: [publicKey] },
      });
      expect(metadata.filename).toBe("example.bin");
      expect(replacement.manifest_ciphertext).toEqual(
        manifest.manifest_ciphertext,
      );
      expect(replacement.ciphertext_sha256).toEqual(manifest.ciphertext_sha256);
      expect(range).not.toHaveBeenCalled();
    } finally {
      dek.fill(0);
    }
    const recovery = setup([publicKey]);
    recovery.resolveActive.mockImplementation(async (who) =>
      activeProof(who, [target.publicKey]),
    );
    recovery.mutation.mockRejectedValueOnce(new Error("Reply lost"));
    await expect(recovery.service.rewrap(key, target)).rejects.toThrow(
      "Reply lost",
    );
    const resource = `envelope:${encodeFileRequest(key)}`;
    await expect(
      recovery.service.reconcileCommand(resource),
    ).resolves.toMatchObject({ outcome: "unknown" });
    const prepared = recovery.send.mock.calls.find(
      ([type]) => type === "FileKeyEnvelopePut",
    )?.[1].Json;
    if (!prepared) throw new Error("Missing envelope command");
    const desired = decodeFileResponse(
      prepared,
      z.strictObject({
        key: fileKeySchema,
        expected_key_id: z.string(),
        envelope: z.unknown(),
      }),
    );
    recovery.current.manifest = decodeFileResponse(
      encodeFileRequest({ ...manifest, envelope: desired.envelope }),
      wireFileManifest,
    );
    await expect(
      recovery.service.reconcileCommand(resource),
    ).resolves.toMatchObject({ outcome: "resolved" });
    expect(recovery.mutation).toHaveBeenCalledOnce();
  } finally {
    bundle.free();
    keys.free();
    rotatedKeyring.fill(0);
  }
});

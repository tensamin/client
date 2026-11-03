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
import { crypto, raw } from "mtp";
import type { BoundSendFn } from "@tensamin/mtp";
import { encryptFileVersion, type FileStage } from "@tensamin/crypto/file";
import { createFileService } from "./service";
import { encodeFileRequest } from "./protocol";

const io = vi.hoisted(() => ({
  remove: vi.fn(),
  output: [] as Uint8Array<ArrayBuffer>[],
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
    synchronize: async () => {},
    grant: async () => undefined,
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
  vi.stubGlobal("navigator", {});
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const controller = new AbortController();
  const range = vi.fn(async (offset: number, amount: number) => ({
    AssetId: assetId,
    Size: ciphertext.length,
    Offset: offset,
    Sha256: manifest.ciphertext_sha256,
    Blob: ciphertext.slice(offset, offset + amount),
  }));
  const send = vi.fn(
    async (type: string, data: { Offset: number; Amount: number }) => {
      if (type === "FileGetManifest")
        return {
          type,
          data: {
            Json: encodeFileRequest({
              manifest,
              proof: null,
              metadata_revision: 1n,
              asset_id: assetId,
              state: "ready",
              transfer: null,
              reserved_bytes: 0n,
            }),
          },
        };
      if (type === "UserAssetGetChunk")
        return { type, data: await range(data.Offset, data.Amount) };
      throw new Error(`Unexpected request: ${type}`);
    },
  );
  const service = createFileService({
    accountKey: "fixture-account",
    account: principal,
    owner: { keyId: "owner-key", keyring, publicKey },
    send: send as unknown as BoundSendFn,
    signal: controller.signal,
    resolveAuthor: async () => ({ principal, publicKeys: [publicKey] }),
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
  return { service, stage, range, send, controller };
}

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
  vi.stubGlobal("indexedDB", undefined);
  const { service, send } = setup();
  await expect(
    service.upload({
      file: new Blob([plaintext]),
      filename: "example.bin",
      mimeType: "application/octet-stream",
    }),
  ).rejects.toThrow();
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

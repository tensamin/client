/// <reference types="node" />
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MTPClient, crypto as mtpCrypto, raw } from "mtp";
import { encryptFileVersion, type FileStage } from "@tensamin/crypto/file";
import { clearDatabaseStore } from "@tensamin/shared/indexedDb";
import { setPlatformVisible } from "@tensamin/shared/focus";
import { encodeFileRequest } from "@tensamin/mtp/files/protocol";
import type { BoundSendFn } from "@tensamin/mtp";
import { createFileService } from "./service";

const account = { authority: "omega-key:" + "a".repeat(64), user_id: 1n };
const key = { origin: account, file_id: "resume-file", version: 1n };
const plaintext = new Uint8Array(400_000).fill(37);
let owner: { keyId: string; keyring: Uint8Array; publicKey: Uint8Array };
let manifest: Awaited<ReturnType<typeof encryptFileVersion>>;
let ciphertext: Uint8Array;
let documentEvents: EventTarget;
beforeAll(async () => {
  await MTPClient.init({
    module_or_path: readFileSync(
      new URL(
        "../../../apps/web/node_modules/.vite/mtp/mtp_wasm_bg.wasm",
        import.meta.url,
      ),
    ),
  });
  const keyring = mtpCrypto.generateKeyring();
  const keys = raw.WasmKeyring.from_bytes(keyring);
  const bundle = keys.public_key_bundle();
  const publicKey = bundle.to_bytes();
  bundle.free();
  keys.free();
  owner = { keyId: "owner-key", keyring, publicKey };
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  manifest = await encryptFileVersion({
    key,
    file: new Blob([plaintext]),
    filename: "resume.bin",
    mimeType: "application/octet-stream",
    owner: { ...owner, principal: account },
    stage: {
      async write(bytes) {
        chunks.push(bytes.slice());
      },
      async commit() {},
      async abort() {
        throw new Error("Unexpected encryption abort");
      },
    },
  });
  ciphertext = new Uint8Array(await new Blob(chunks).arrayBuffer());
});

beforeEach(async () => {
  await clearDatabaseStore("cache");
  const directories = new Map<string, Map<string, Uint8Array>>();
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _name: string,
        options: unknown,
        operation?: () => Promise<unknown>,
      ) => (operation ?? (options as () => Promise<unknown>))(),
    },
    storage: {
      getDirectory: async () => ({
        getDirectoryHandle: async (name: string) => {
          let files = directories.get(name);
          if (!files) {
            files = new Map();
            directories.set(name, files);
          }
          return {
            async getFileHandle(id: string, options: { create?: boolean }) {
              if (!files.has(id)) {
                if (!options.create)
                  throw new DOMException("missing", "NotFoundError");
                files.set(id, new Uint8Array());
              }
              return {
                getFile: async () => new Blob([new Uint8Array(files.get(id)!)]),
                async createWritable(
                  options: { keepExistingData?: boolean } = {},
                ) {
                  let bytes = options.keepExistingData
                    ? files.get(id)!.slice()
                    : new Uint8Array();
                  let offset = 0;
                  return {
                    async seek(next: number) {
                      offset = next;
                    },
                    async write(value: Uint8Array) {
                      const next = new Uint8Array(
                        Math.max(bytes.length, offset + value.length),
                      );
                      next.set(bytes);
                      next.set(value, offset);
                      bytes = next;
                      offset += value.length;
                    },
                    async close() {
                      files.set(id, bytes);
                    },
                    async abort() {},
                  };
                },
              };
            },
            async removeEntry(id: string) {
              files.delete(id);
            },
          };
        },
      }),
    },
  });
  documentEvents = new EventTarget();
  Object.defineProperty(documentEvents, "visibilityState", {
    value: "visible",
    writable: true,
  });
  vi.stubGlobal("document", documentEvents);
  vi.stubGlobal("window", new EventTarget());
  setPlatformVisible(true);
});
afterEach(() => vi.unstubAllGlobals());

function output() {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let committed = false;
  const stage: FileStage = {
    async write(bytes) {
      chunks.push(bytes.slice());
    },
    async commit() {
      committed = true;
    },
    async abort() {
      chunks.length = 0;
      committed = false;
    },
  };
  return {
    stage,
    bytes: async () => new Uint8Array(await new Blob(chunks).arrayBuffer()),
    committed: () => committed,
  };
}
function transport(chunk: (offset: number) => void, authorized = true) {
  return vi.fn<BoundSendFn>().mockImplementation(async (type, data) => {
    if (type === "FileChangesGet")
      return {
        type,
        data: {
          Json: encodeFileRequest({
            events: [],
            next: 0n,
            upper: 0n,
            more: false,
          }),
        },
      };
    if (type === "FileGetManifest")
      return authorized
        ? {
            type,
            data: {
              Json: encodeFileRequest({
                manifest,
                proof: null,
                metadata_revision: 1n,
                asset_id: "asset",
                state: "ready",
                transfer: null,
                reserved_bytes: 0n,
              }),
            },
          }
        : { type: "ErrorNotAuthenticated", data: {} };
    if (
      type === "UserAssetGetChunk" &&
      data &&
      "Offset" in data &&
      "Amount" in data
    ) {
      const offset = Number(data.Offset),
        amount = Number(data.Amount);
      chunk(offset);
      return {
        type,
        data: {
          AssetId: "asset",
          Offset: offset,
          Size: ciphertext.length,
          Sha256: manifest.ciphertext_sha256,
          Blob: ciphertext.slice(offset, offset + amount),
        },
      };
    }
    throw new Error(`Unexpected application synchronization: ${type}`);
  });
}
function service(
  send: ReturnType<typeof transport>,
  onProgress?: Parameters<typeof createFileService>[0]["onProgress"],
) {
  return createFileService({
    accountKey: "download-owner",
    account,
    owner,
    send: send as BoundSendFn,
    sendRelay: async () => {
      throw new Error("Unexpected relay");
    },
    signal: new AbortController().signal,
    resolveAuthor: async () => ({
      principal: account,
      publicKeys: [owner.publicKey],
    }),
    onProgress,
  });
}

it("resumes only the missing ciphertext ranges after an interrupted request and verifies the final plaintext", async () => {
  const send = transport((offset) => {
    if (offset === 256 * 1024) throw new Error("interrupted");
  });
  const first = service(send);
  expect(send).not.toHaveBeenCalled();
  const failed = output();
  await expect(first.download(key, failed.stage)).rejects.toThrow(
    "interrupted",
  );
  expect(failed.committed()).toBe(false);
  const offsets: number[] = [];
  const resumed = service(transport((offset) => offsets.push(offset)));
  const saved = output();
  expect((await resumed.download(key, saved.stage)).filename).toBe(
    "resume.bin",
  );
  expect(offsets[0]).toBe(256 * 1024);
  expect(saved.committed()).toBe(true);
  expect(await saved.bytes()).toEqual(plaintext);
});

it("finishes only the current bounded range when hidden, then resumes on visibility", async () => {
  const offsets: number[] = [];
  let savedPrefix!: () => void;
  const checkpoint = new Promise<void>((resolve) => {
    savedPrefix = resolve;
  });
  const send = transport((offset) => {
    offsets.push(offset);
    if (offset === 0) {
      Object.defineProperty(documentEvents, "visibilityState", {
        value: "hidden",
        writable: true,
      });
      documentEvents.dispatchEvent(new Event("visibilitychange"));
    }
  });
  const download = service(send, (progress) => {
    if (progress.phase === "downloading" && progress.bytes === 256n * 1024n)
      savedPrefix();
  });
  const saved = output();
  const pending = download.download(key, saved.stage);
  await checkpoint;
  expect(offsets).toEqual([0]);
  expect(saved.committed()).toBe(false);
  Object.defineProperty(documentEvents, "visibilityState", {
    value: "visible",
    writable: true,
  });
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  await pending;
  expect(saved.committed()).toBe(true);
  expect(await saved.bytes()).toEqual(plaintext);
});

it("rechecks current authorization before resuming saved ciphertext", async () => {
  await expect(
    service(
      transport((offset) => {
        if (offset > 0) throw new Error("interrupted");
      }),
    ).download(key, output().stage),
  ).rejects.toThrow("interrupted");
  const offsets: number[] = [];
  const saved = output();
  await expect(
    service(transport((offset) => offsets.push(offset), false)).download(
      key,
      saved.stage,
    ),
  ).rejects.toThrow("ErrorNotAuthenticated");
  expect(offsets).toEqual([]);
  expect(saved.committed()).toBe(false);
  expect(await saved.bytes()).toHaveLength(0);
});

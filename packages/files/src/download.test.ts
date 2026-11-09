/// <reference types="node" />
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MTPClient, crypto as mtpCrypto, raw } from "mtp";
import { encryptFileVersion, type FileStage } from "@tensamin/crypto/file";
import {
  clearDatabaseStore,
  getDatabaseEntry,
  listDatabaseEntries,
  setDatabaseEntry,
} from "@tensamin/shared/indexedDb";
import { encodeSecureValue, isSecureEnvelope } from "@tensamin/storage/secure";
import * as secure from "@tensamin/storage/secure";
import { createCiphertextStage } from "./staging";
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
let directories: Map<string, Map<string, Uint8Array>>;
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
  directories = new Map();
  const held = new Map<string, Promise<void>>();
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        name: string,
        options:
          | { ifAvailable?: boolean }
          | ((lock: object | null) => Promise<unknown>),
        operation?: (lock: object | null) => Promise<unknown>,
      ) => {
        const action =
          operation ?? (options as (lock: object | null) => Promise<unknown>);
        if (
          typeof options !== "function" &&
          options.ifAvailable &&
          held.has(name)
        )
          return action(null);
        while (held.has(name)) await held.get(name);
        let release!: () => void;
        held.set(
          name,
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        );
        try {
          return await action({ name });
        } finally {
          held.delete(name);
          release();
        }
      },
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

it("loads the version index on demand before looking up an existing server file", async () => {
  const send = transport(() => {
    throw new Error("Unexpected file content request");
  });
  send.mockImplementationOnce(async () => ({
    type: "FileChangesGet",
    data: {
      Json: encodeFileRequest({
        events: [{ kind: "version", payload: manifest, sequence: 1n }],
        next: 1n,
        upper: 1n,
        more: false,
      }),
    },
  }));
  const files = service(send);
  expect(send).not.toHaveBeenCalled();
  expect(await files.latestVersion(account, key.file_id)).toEqual(key);
  expect(send.mock.calls.map(([type]) => type)).toEqual(["FileChangesGet"]);
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

it.each(["missing", "misaligned"])(
  "restarts a %s checkpoint stage without wedging future downloads",
  async (kind) => {
    await expect(
      service(
        transport((offset) => {
          if (offset > 0) throw new Error("interrupted");
        }),
      ).download(key, output().stage),
    ).rejects.toThrow("interrupted");
    for (const files of directories.values()) {
      for (const id of files.keys()) {
        if (kind === "missing") files.delete(id);
        else files.set(id, new Uint8Array(1));
      }
    }
    const offsets: number[] = [];
    const saved = output();
    await service(transport((offset) => offsets.push(offset))).download(
      key,
      saved.stage,
    );
    expect(offsets[0]).toBe(0);
    expect(saved.committed()).toBe(true);
    expect(await saved.bytes()).toEqual(plaintext);
  },
);

async function seedDownloads() {
  const ids: string[] = [];
  for (let index = 0; index < 16; index++) {
    const stage = await createCiphertextStage(
      "download-owner",
      new AbortController().signal,
    );
    ids.push(stage.id);
    await setDatabaseEntry(
      "cache",
      `file-download:v1:download-owner:old-${index}`,
      await encodeSecureValue({
        account: "download-owner",
        descriptor: "old",
        stage_id: stage.id,
      }),
    );
  }
  return ids;
}

it("bounds abandoned downloads without evicting active downloads or uploads", async () => {
  const upload = await createCiphertextStage(
    "download-owner",
    new AbortController().signal,
  );
  await upload.stage.write(new Uint8Array([7]));
  await upload.stage.commit();
  const ids = await seedDownloads();
  let release!: () => void, ready!: () => void;
  const held = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const active = navigator.locks.request(
    "file-download:v1:download-owner:old-0",
    async () => {
      ready();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  );
  await held;
  try {
    await expect(
      service(
        transport(() => {
          throw new Error("interrupted");
        }),
      ).download(key, output().stage),
    ).rejects.toThrow("interrupted");
    expect(
      await listDatabaseEntries("cache", "file-download:v1:download-owner:"),
    ).toHaveLength(16);
    expect([...directories.values()].some((files) => files.has(ids[0]))).toBe(
      true,
    );
    expect(
      [...directories.values()].some((files) => files.has(upload.id)),
    ).toBe(true);
    expect([...directories.values()].some((files) => files.has(ids[1]))).toBe(
      false,
    );
  } finally {
    release();
    await active;
  }
});

it("evicts an unreadable checkpoint without trusting its stage pointer", async () => {
  const ids = await seedDownloads();
  const checkpointKey = "file-download:v1:download-owner:old-0";
  const saved = await getDatabaseEntry("cache", checkpointKey);
  if (!isSecureEnvelope(saved))
    throw new Error("Expected an encrypted checkpoint");
  await setDatabaseEntry("cache", checkpointKey, {
    ...saved,
    data: (saved.data[0] === "A" ? "B" : "A") + saved.data.slice(1),
  });
  await expect(
    service(
      transport(() => {
        throw new Error("interrupted");
      }),
    ).download(key, output().stage),
  ).rejects.toThrow("interrupted");
  expect(await getDatabaseEntry("cache", checkpointKey)).toBeUndefined();
  expect(
    await listDatabaseEntries("cache", "file-download:v1:download-owner:"),
  ).toHaveLength(16);
  expect([...directories.values()].some((files) => files.has(ids[0]))).toBe(
    true,
  );
});

it("preserves checkpoints when their secure key is temporarily unavailable", async () => {
  await seedDownloads();
  const checkpointKey = "file-download:v1:download-owner:old-0";
  const saved = await getDatabaseEntry("cache", checkpointKey);
  if (!isSecureEnvelope(saved))
    throw new Error("Expected an encrypted checkpoint");
  const decode = secure.decodeSecureValue;
  const unavailable = vi
    .spyOn(secure, "decodeSecureValue")
    .mockImplementation(async (value) => {
      if (isSecureEnvelope(value) && value.data === saved.data)
        throw new Error("Secure storage key is unavailable.");
      return decode(value);
    });
  try {
    await expect(
      service(
        transport(() => {
          throw new Error("Unexpected content request");
        }),
      ).download(key, output().stage),
    ).rejects.toThrow("Secure storage key is unavailable");
    expect(await getDatabaseEntry("cache", checkpointKey)).toEqual(saved);
    expect(
      await listDatabaseEntries("cache", "file-download:v1:download-owner:"),
    ).toHaveLength(16);
  } finally {
    unavailable.mockRestore();
  }
});

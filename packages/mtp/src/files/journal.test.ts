/// <reference types="node" />
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { initSync } from "mtp/raw";
import { crypto, raw } from "mtp";
import {
  signFileShareOffer,
  signFileShareRevoke,
} from "@tensamin/crypto/fileSharing";
import { createFileJournal } from "./journal";

const io = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  refuse: false,
}));
vi.mock("@tensamin/shared/indexedDb", () => ({
  getDatabaseEntry: async (store: string, key: string) =>
    structuredClone(io.records.get(`${store}:${key}`)),
  getOrCreateDatabaseEntry: async (
    store: string,
    key: string,
    value: unknown,
  ) => {
    const id = `${store}:${key}`;
    if (!io.records.has(id)) io.records.set(id, structuredClone(value));
    return structuredClone(io.records.get(id));
  },
  setDatabaseEntries: async (
    store: string,
    values: readonly (readonly [string, unknown])[],
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    if (io.refuse) throw new Error("transaction refused");
    for (const [key, value] of values)
      io.records.set(`${store}:${key}`, structuredClone(value));
  },
}));
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
beforeEach(() => {
  io.records.clear();
  io.refuse = false;
  vi.stubGlobal("indexedDB", {});
  vi.stubGlobal("window", { crypto: globalThis.crypto });
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _key: string,
        _options: unknown,
        run: () => Promise<unknown>,
      ) => run(),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const keyring = crypto.generateKeyring();
  const keys = raw.WasmKeyring.from_bytes(keyring);
  const bundle = keys.public_key_bundle();
  const publicKey = bundle.to_bytes();
  bundle.free();
  keys.free();
  const principal = { authority: `omega-key:${"a".repeat(64)}`, user_id: 7n };
  const account = { authority: `omega-key:${"b".repeat(64)}`, user_id: 7n };
  const key = { origin: principal, file_id: "file-one", version: 1n };
  const manifest = {
    key,
    ciphertext_sha256: new Uint8Array(32),
    ciphertext_size: 65576n,
    crypto_format: "tensamin-file-chunks-v1" as const,
    manifest_ciphertext: new Uint8Array(41),
    envelope: {
      recipient: account,
      key_id: "recipient-key",
      wrapping_scheme: "tensamin-file-dek-kem-v1" as const,
      kem_ciphertext: Uint8Array.of(1),
      encrypted_dek: new Uint8Array(72),
    },
  };
  const offer = signFileShareOffer({
    manifest,
    grantRevision: 1n,
    expiresAt: 1n,
    author: { principal, keyring, publicKey },
  });
  const revoke = signFileShareRevoke({
    key,
    recipient: account,
    grantRevision: 2n,
    author: { principal, keyring, publicKey },
  });
  const first = {
    kind: "share_offered" as const,
    sequence: 1n,
    payload: offer,
  };
  const second = {
    kind: "share_revoked" as const,
    sequence: 2n,
    payload: revoke,
  };
  const fetch = vi.fn<Parameters<typeof createFileJournal>[0]["fetch"]>();
  const make = (accountKey = "account-one") =>
    createFileJournal({
      accountKey,
      account,
      signal: new AbortController().signal,
      fetch,
      resolveAuthor: async () => ({ principal, publicKeys: [publicKey] }),
    });
  return {
    keyring,
    publicKey,
    key,
    account,
    offer,
    revoke,
    first,
    second,
    fetch,
    make,
  };
}

it("commits signed grants with their checkpoint and resumes pinned pages after a fresh consumer lifetime", async () => {
  const f = fixture();
  try {
    f.fetch
      .mockResolvedValueOnce({
        events: [f.first],
        next: 1n,
        upper: 2n,
        more: true,
      })
      .mockRejectedValueOnce(new Error("connection lost"));
    await expect(f.make().synchronize()).rejects.toThrow("connection lost");
    expect((await f.make().grant(f.key, f.account))?.kind).toBe(
      "share_offered",
    );
    f.fetch.mockResolvedValueOnce({
      events: [f.second],
      next: 2n,
      upper: 2n,
      more: false,
    });
    expect(await f.make().synchronize()).toBe(2n);
    expect(f.fetch.mock.lastCall).toEqual([1n, 2n]);
    expect((await f.make().grant(f.key, f.account))?.kind).toBe(
      "share_revoked",
    );
    expect(
      await f.make("other-account").grant(f.key, f.account),
    ).toBeUndefined();
    expect(JSON.stringify([...io.records.values()])).not.toContain(
      "share_revoked",
    );
  } finally {
    f.keyring.fill(0);
  }
});

it("never advances its cursor or grants when the atomic page write fails", async () => {
  const f = fixture();
  try {
    f.fetch.mockResolvedValue({
      events: [f.first],
      next: 1n,
      upper: 1n,
      more: false,
    });
    io.refuse = true;
    await expect(f.make().synchronize()).rejects.toThrow("transaction refused");
    expect(await f.make().grant(f.key, f.account)).toBeUndefined();
    io.refuse = false;
    await f.make().synchronize();
    expect(f.fetch.mock.lastCall).toEqual([0n, null]);
    expect(
      (await f.make().grant(f.key, f.account))?.payload.grant_revision,
    ).toBe(1n);
  } finally {
    f.keyring.fill(0);
  }
});

it("rejects damaged signatures and equal-revision offer/revoke conflicts before committing", async () => {
  const f = fixture();
  try {
    const damaged = f.offer.signature.slice();
    damaged[64] ^= 1;
    f.fetch.mockResolvedValueOnce({
      events: [{ ...f.first, payload: { ...f.offer, signature: damaged } }],
      next: 1n,
      upper: 1n,
      more: false,
    });
    await expect(f.make().synchronize()).rejects.toThrow();
    expect(await f.make().grant(f.key, f.account)).toBeUndefined();
    f.fetch.mockResolvedValueOnce({
      events: [f.first],
      next: 1n,
      upper: 1n,
      more: false,
    });
    await f.make().synchronize();
    const revoke = signFileShareRevoke({
      key: f.key,
      recipient: f.account,
      grantRevision: 1n,
      author: {
        principal: f.key.origin,
        keyring: f.keyring,
        publicKey: f.publicKey,
      },
    });
    f.fetch.mockResolvedValueOnce({
      events: [{ kind: "share_revoked", sequence: 2n, payload: revoke }],
      next: 2n,
      upper: 2n,
      more: false,
    });
    await expect(f.make().synchronize()).rejects.toThrow(
      "conflicting signed operations",
    );
    expect((await f.make().grant(f.key, f.account))?.kind).toBe(
      "share_offered",
    );
  } finally {
    f.keyring.fill(0);
  }
});

/// <reference types="node" />
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncScope } from "@tensamin/shared/accountSync";
import type { SealedRelayOptions } from "./mtpContext";
import type { RelayOutboxClient } from "./relayOutbox";

const fixture = vi.hoisted(() => ({
  database: new Map<string, unknown>(),
  failWrite: false,
  failDelete: false,
  reads: [] as number[],
}));
vi.mock("@tensamin/shared/indexedDb", () => ({
  getDatabaseEntry: async (store: string, key: string) =>
    structuredClone(fixture.database.get(`${store}:${key}`)),
  getOrCreateDatabaseEntry: async (
    store: string,
    key: string,
    candidate: unknown,
  ) => {
    const id = `${store}:${key}`;
    if (!fixture.database.has(id))
      fixture.database.set(id, structuredClone(candidate));
    return structuredClone(fixture.database.get(id));
  },
  setDatabaseEntry: async (store: string, key: string, value: unknown) => {
    if (fixture.failWrite) throw new Error("write refused");
    fixture.database.set(`${store}:${key}`, structuredClone(value));
  },
  deleteDatabaseEntry: async (store: string, key: string) => {
    if (fixture.failDelete) throw new Error("delete refused");
    fixture.database.delete(`${store}:${key}`);
  },
  readDatabasePage: async (
    store: string,
    prefix: string,
    after: string | undefined,
    limit: number,
  ) => {
    fixture.reads.push(limit);
    return [...fixture.database]
      .filter(
        ([key]) =>
          key.startsWith(`${store}:${prefix}`) &&
          (after === undefined || key > `${store}:${after}`),
      )
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, limit)
      .map(([key, value]) => [
        key.slice(store.length + 1),
        structuredClone(value),
      ]);
  },
}));

const scope: SyncScope = {
  principal: { authority: `omega-key:${"a".repeat(64)}`, user_id: 7 },
  device_id: "outbox-device",
  authorization_generation: 3,
  schema: "tensamin-account-sync:v1",
  dictionary: "b".repeat(64),
};
function options(
  authority = `omega-key:${"c".repeat(64)}`,
): SealedRelayOptions {
  return {
    nextHop: { kind: "iota", id: 12 },
    finalRecipientId: 9,
    metadataRecipients: [],
    contentRecipients: [],
    metadata: new TextEncoder().encode(
      JSON.stringify({
        signer: scope.principal,
        recipient: { authority, user_id: 9 },
        destination: `iota:v1:${"d".repeat(64)}`,
        type_map_version: "1.1",
        type_map_fingerprint: scope.dictionary,
      }),
    ),
  };
}
const frame = new Uint8Array([1, 2, 3, 4, 5]);

beforeEach(() => {
  vi.resetModules();
  fixture.database.clear();
  fixture.failWrite = false;
  fixture.failDelete = false;
  fixture.reads = [];
  vi.stubGlobal("indexedDB", {});
  vi.stubGlobal("window", { crypto: globalThis.crypto });
  const locks = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", {
    locks: {
      request: (key: string, run: () => Promise<unknown>) => {
        const result = (locks.get(key) ?? Promise.resolve())
          .catch(() => undefined)
          .then(run);
        locks.set(key, result);
        return result;
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

async function transport() {
  const { createRelayOutbox } = await import("./relayOutbox");
  let active = true;
  let lost = false;
  let response = "Success";
  const sent: Uint8Array[] = [];
  const client = {
    dictionaryIdentity: { version: "1.1", fingerprint: scope.dictionary },
    requestSealedRelay: vi.fn<RelayOutboxClient["requestSealedRelay"]>(
      async (_type, _data, _options, request) => {
        await request.beforeSend(frame.slice());
        sent.push(frame.slice());
        if (lost) throw new Error("reply lost");
        return { type: response, data: {} };
      },
    ),
    requestPrepared: vi.fn<RelayOutboxClient["requestPrepared"]>(
      async (bytes, request) => {
        await request.beforeSend(bytes.slice());
        sent.push(bytes.slice());
        if (lost) throw new Error("reply lost");
        return { type: response, data: {} };
      },
    ),
  };
  const make = (owner = scope) =>
    createRelayOutbox({
      scope: owner,
      client,
      isCurrent: () => active,
    });
  return {
    make,
    client,
    sent,
    active: (value: boolean) => {
      active = value;
    },
    lost: (value: boolean) => {
      lost = value;
    },
    response: (value: string) => {
      response = value;
    },
  };
}

describe("durable sealed relay outbox", () => {
  it("re-correlates a real dual-signed WASM relay without changing its message identity", async () => {
    const { initSync } = await import("mtp/raw");
    initSync({
      module: readFileSync(
        new URL(
          "../../bindings/wasm/pkg/mtp_wasm_bg.wasm",
          import.meta.resolve("mtp"),
        ),
      ),
    });
    const sdk = await import("mtp");
    const { createRelayOutbox } = await import("./relayOutbox");
    const sender = sdk.crypto.generateKeyring();
    const recipient = sdk.crypto.generateKeyring();
    const bundle = (keyring: Uint8Array) => {
      const keys = sdk.raw.WasmKeyring.from_bytes(keyring);
      const publicKey = keys.public_key_bundle();
      try {
        return publicKey.to_bytes();
      } finally {
        publicKey.free();
        keys.free();
      }
    };
    const senderKey = bundle(sender);
    const recipientKey = bundle(recipient);
    const client = await sdk.MTPClient.create({
      url: "https://example.invalid",
      pings: false,
      credentials: { clientId: 7, keyring: sender },
      securityProfile: { protectedSignatureSuite: "dual" },
    });
    // The transport is isolated, but use the actual compiled protocol identity.
    vi.spyOn(client, "dictionaryIdentity", "get").mockReturnValue(
      sdk.raw.compiled_dictionary_identity(),
    );
    const actualScope = {
      ...scope,
      dictionary: client.dictionaryIdentity!.fingerprint,
    };
    const relayOptions = options();
    const metadata = JSON.parse(
      new TextDecoder().decode(relayOptions.metadata as Uint8Array),
    );
    metadata.type_map_version = client.dictionaryIdentity!.version;
    metadata.type_map_fingerprint = actualScope.dictionary;
    relayOptions.metadata = new TextEncoder().encode(JSON.stringify(metadata));
    relayOptions.metadataRecipients = [
      { encoding: "base64", value: sdk.bytesToBase64(recipientKey) },
    ];
    relayOptions.contentRecipients = [
      { encoding: "base64", value: sdk.bytesToBase64(recipientKey) },
    ];
    const sent: Uint8Array[] = [];
    let lost = true;
    client.raw.client.request = async (bytes) => {
      sent.push(bytes.slice());
      if (lost) throw new Error("reply lost");
      return sdk.codec.decode(sdk.codec.encode("Success", {}));
    };
    try {
      await expect(
        createRelayOutbox({
          scope: actualScope,
          client,
          isCurrent: () => true,
        }).send(
          "ProtectedMessage",
          { ExampleType: "private-content" },
          relayOptions,
        ),
      ).rejects.toThrow("reply lost");
      lost = false;
      await createRelayOutbox({
        scope: actualScope,
        client,
        isCurrent: () => true,
      }).resume(vi.fn(), new AbortController().signal);
      expect(sent).toHaveLength(2);
      const first = sdk.codec.decode(sent[0]);
      const second = sdk.codec.decode(sent[1]);
      expect(second.id).not.toBe(first.id);
      expect(second.data).toEqual(first.data);
      const identities = [];
      for (const frame of [first, second]) {
        const verification = {
          recipient: { id: 9, keyring: recipient },
          expectedSignerId: 7,
          resolveSignerPublicKeys: () => [senderKey],
          signaturePolicy: "dual" as const,
          replayGuard: { accept: () => true },
        };
        const opened = await client.openRelayMetadata(frame, verification);
        try {
          const content = await client.openRelayContent(opened, verification);
          expect(content.type).toBe("ProtectedMessage");
          expect(content.data).toEqual({ ExampleType: "private-content" });
          identities.push([opened.messageId, opened.createdAt]);
        } finally {
          opened.dispose();
        }
      }
      expect(identities[1]).toEqual(identities[0]);
    } finally {
      sender.fill(0);
      recipient.fill(0);
      client.disconnect();
    }
  });
  it("refuses transmission when persistence fails", async () => {
    const runtime = await transport();
    fixture.failWrite = true;
    await expect(
      runtime
        .make()
        .send("MessageSend", { Content: "private-content" }, options()),
    ).rejects.toThrow("write refused");
    expect(runtime.sent).toHaveLength(0);
  });

  it("does not hide or reauthorize an unknown command after an authorization change", async () => {
    const runtime = await transport();
    runtime.lost(true);
    await expect(
      runtime.make().send("MessageSend", {}, options()),
    ).rejects.toThrow("reply lost");
    const replacement = runtime.make({ ...scope, authorization_generation: 4 });
    const report = vi.fn();
    await replacement.resume(report, new AbortController().signal);
    expect(report).toHaveBeenCalledWith("MessageSend");
    expect(runtime.client.requestPrepared).not.toHaveBeenCalled();
    await expect(
      replacement.send("MessageSend", {}, options()),
    ).rejects.toThrow("still pending");
    expect(runtime.client.requestSealedRelay).toHaveBeenCalledTimes(1);
  });

  it("cancels recovery without sending or discarding its retained command", async () => {
    const runtime = await transport();
    runtime.lost(true);
    await expect(
      runtime.make().send("MessageSend", {}, options()),
    ).rejects.toThrow("reply lost");
    const controller = new AbortController();
    controller.abort();
    await expect(
      runtime.make().resume(vi.fn(), controller.signal),
    ).rejects.toThrow();
    expect(runtime.client.requestPrepared).not.toHaveBeenCalled();
    await expect(
      runtime.make().send("MessageSend", {}, options()),
    ).rejects.toThrow("still pending");
  });

  it("retains an uncertain command, blocks replacement, and reuses its bytes after restart", async () => {
    const runtime = await transport();
    runtime.lost(true);
    await expect(
      runtime
        .make()
        .send("MessageSend", { Content: "private-content" }, options()),
    ).rejects.toThrow("reply lost");
    await expect(
      runtime.make().send("MessageSend", { Content: "replacement" }, options()),
    ).rejects.toThrow("still pending");
    expect(runtime.client.requestSealedRelay).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...fixture.database.values()])).not.toContain(
      "private-content",
    );
    runtime.lost(false);
    await runtime.make().resume(() => {
      throw new Error("unexpected failure");
    }, new AbortController().signal);
    expect(runtime.client.requestPrepared).toHaveBeenCalledTimes(1);
    expect(runtime.sent).toEqual([frame, frame]);
    expect(
      [...fixture.database.keys()].filter((key) =>
        key.includes("relay-outbox"),
      ),
    ).toEqual([]);
    expect(fixture.reads.every((limit) => limit === 1)).toBe(true);
  });

  it("never sends again when acknowledgement cleanup was interrupted", async () => {
    const runtime = await transport();
    fixture.failDelete = true;
    await expect(
      runtime.make().send("MessageDelete", {}, options()),
    ).rejects.toThrow("delete refused");
    fixture.failDelete = false;
    await runtime.make().resume(() => {
      throw new Error("unexpected failure");
    }, new AbortController().signal);
    expect(runtime.sent).toHaveLength(1);
    expect(runtime.client.requestPrepared).not.toHaveBeenCalled();
  });

  it("keeps rejected or unavailable outcomes without silently creating a replacement", async () => {
    const runtime = await transport();
    runtime.response("ErrorInternal");
    expect(
      (await runtime.make().send("FileShareOffered", {}, options())).type,
    ).toBe("ErrorInternal");
    const report = vi.fn();
    await runtime.make().resume(report, new AbortController().signal);
    expect(report).toHaveBeenCalledWith("FileShareOffered");
    await expect(
      runtime.make().send("FileShareOffered", {}, options()),
    ).rejects.toThrow("still pending");
  });

  it("isolates equal numeric recipients across authorities and refuses transplanted commands", async () => {
    const runtime = await transport();
    runtime.lost(true);
    await expect(
      runtime.make().send("MessageSend", {}, options()),
    ).rejects.toThrow("reply lost");
    await expect(
      runtime
        .make()
        .send("MessageSend", {}, options(`omega-key:${"e".repeat(64)}`)),
    ).rejects.toThrow("reply lost");
    expect(runtime.client.requestSealedRelay).toHaveBeenCalledTimes(2);
    const record = [...fixture.database.entries()].find(([key]) =>
      key.includes("relay-outbox"),
    )!;
    const other = { ...scope, principal: { ...scope.principal, user_id: 8 } };
    fixture.database.set(
      record[0].replace(
        JSON.stringify(scope.principal),
        JSON.stringify(other.principal),
      ),
      record[1],
    );
    await expect(
      runtime.make(other).resume(vi.fn(), new AbortController().signal),
    ).rejects.toThrow("another scope");
  });

  it("fences a replaced account before network transmission and rejects foreign signer metadata", async () => {
    const runtime = await transport();
    runtime.active(false);
    await expect(
      runtime.make().send("MessageSend", {}, options()),
    ).rejects.toThrow("connection changed");
    expect(runtime.sent).toHaveLength(0);
    runtime.active(true);
    await expect(
      runtime
        .make({ ...scope, principal: { ...scope.principal, user_id: 8 } })
        .send("MessageSend", {}, options()),
    ).rejects.toThrow("outside this account");
  });
});

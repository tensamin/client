/// <reference types="node" />
import { readFileSync } from "node:fs";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { initSync } from "mtp/raw";
import { bytesToBase64, crypto } from "mtp";
import { deriveChatId, encodePrincipal } from "@tensamin/shared/principal";
import {
  deriveChatSecretId,
  ownKemPublicKeyFromKeyring,
  wrapChatSecret,
} from "@tensamin/crypto/chatSecret";
import { ConversationSecrets } from "./chatSecret";

const database = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@tensamin/shared/indexedDb", () => ({
  getDatabaseEntry: async (store: string, key: string) =>
    structuredClone(database.get(`${store}:${key}`)),
  setDatabaseEntry: async (store: string, key: string, value: unknown) => {
    database.set(`${store}:${key}`, structuredClone(value));
  },
  getOrCreateDatabaseEntry: async (
    store: string,
    key: string,
    value: unknown,
  ) => {
    const id = `${store}:${key}`;
    if (!database.has(id)) database.set(id, structuredClone(value));
    return structuredClone(database.get(id));
  },
}));

const owner = { authority: `omega-key:${"a".repeat(64)}`, user_id: 7 };
const peer = { authority: `omega-key:${"b".repeat(64)}`, user_id: 7 };
const chat = deriveChatId(owner, peer);
const cacheScope = JSON.stringify([owner, 3]);
let keyring: string;
let first: Awaited<ReturnType<typeof envelope>>;
let second: Awaited<ReturnType<typeof envelope>>;

async function envelope(version: number, value: number) {
  const wrapped = await wrapChatSecret({
    chatSecret: new Uint8Array(32).fill(value),
    recipientKemPublicKey: ownKemPublicKeyFromKeyring(keyring),
    chatId: chat,
    secretId: deriveChatSecretId(chat),
    version,
  });
  return {
    type: "ChatSecretResponse",
    data: {
      UserId: encodePrincipal(owner),
      ChatId: chat,
      SecretId: deriveChatSecretId(chat),
      VersionNumber: version,
      EncryptedSecret: wrapped.encryptedSecret,
      KemCiphertext: wrapped.kemCiphertext,
      WrappingScheme: wrapped.wrappingScheme,
      CreatedAt: 1,
      UpdatedAt: 1,
    },
  };
}

beforeAll(async () => {
  initSync({
    module: readFileSync(
      new URL(
        "../../bindings/wasm/pkg/mtp_wasm_bg.wasm",
        import.meta.resolve("mtp"),
      ),
    ),
  });
  keyring = bytesToBase64(crypto.generateKeyring());
  first = await envelope(1, 11);
  second = await envelope(2, 22);
});
beforeEach(() => {
  for (const key of database.keys())
    if (key.startsWith("cache:")) database.delete(key);
  vi.stubGlobal("indexedDB", {});
  vi.stubGlobal("window", {});
});
afterEach(() => vi.unstubAllGlobals());

function service(
  online: boolean,
  request = vi.fn().mockResolvedValue(second),
  namespace = cacheScope,
) {
  const propose = vi
    .fn()
    .mockRejectedValue(new Error("Unexpected offline proposal"));
  const kemKeys = vi
    .fn()
    .mockRejectedValue(new Error("Unexpected offline key discovery"));
  const secrets = new ConversationSecrets({
    owner,
    cacheScope: namespace,
    online,
    keyring: async () => keyring,
    request,
    propose,
    kemKeys,
  });
  secrets.updateCommittedEpochs([{ chatId: chat, version: 2 }]);
  return { secrets, request, propose, kemKeys };
}

describe("offline committed chat envelopes", () => {
  it("restores exact historical and current committed epochs in a fresh service without networking", async () => {
    const online = service(
      true,
      vi
        .fn()
        .mockImplementation(async (read) =>
          read.VersionNumber === 1 ? first : second,
        ),
    );
    const current = await online.secrets.ensure(peer);
    await online.secrets.read(peer, 1);
    online.secrets.close();
    if (current.kind === "ready")
      expect(current.value).toEqual(new Uint8Array(32));
    const offline = service(false);
    expect(await offline.secrets.ensure(peer)).toMatchObject({
      kind: "ready",
      version: 2,
      value: new Uint8Array(32).fill(22),
    });
    expect(await offline.secrets.read(peer, 1)).toMatchObject({
      kind: "ready",
      version: 1,
      value: new Uint8Array(32).fill(11),
    });
    expect(await offline.secrets.read(peer, 3)).toMatchObject({
      kind: "retryable",
      reason: "offline_epoch_unavailable",
    });
    expect(offline.request).not.toHaveBeenCalled();
    expect(offline.propose).not.toHaveBeenCalled();
    expect(offline.kemKeys).not.toHaveBeenCalled();
    offline.secrets.close();
  });

  it("does not substitute a lower epoch when the synchronized current epoch lacks an envelope", async () => {
    const online = service(true, vi.fn().mockResolvedValue(first));
    await online.secrets.read(peer, 1);
    online.secrets.close();
    const offline = service(false);
    expect(await offline.secrets.ensure(peer)).toMatchObject({
      kind: "retryable",
      reason: "offline_epoch_unavailable",
    });
    expect(offline.propose).not.toHaveBeenCalled();
    offline.secrets.close();
  });

  it("never lets saved envelopes override a new authoritative pending response", async () => {
    const online = service(true);
    await online.secrets.ensure(peer);
    online.secrets.close();
    const pending = service(
      true,
      vi.fn().mockResolvedValue({
        type: "ErrorInvalidData",
        data: {
          ErrorType: "pending",
          Json: new TextEncoder().encode(
            '{"state":"pending","retryable":true}',
          ),
        },
      }),
    );
    expect(await pending.secrets.ensure(peer)).toEqual({ kind: "pending" });
    expect(pending.request).toHaveBeenCalledOnce();
    expect(pending.propose).not.toHaveBeenCalled();
    pending.secrets.close();
  });

  it("does not use saved envelopes in another authorization generation", async () => {
    const online = service(true);
    await online.secrets.ensure(peer);
    online.secrets.close();
    const offline = service(false, undefined, JSON.stringify([owner, 4]));
    expect(await offline.secrets.ensure(peer)).toMatchObject({
      kind: "retryable",
      reason: "offline_epoch_unavailable",
    });
    offline.secrets.close();
  });

  it("checks the canonical owner/pair even when a valid encrypted entry is moved", async () => {
    const online = service(true);
    await online.secrets.ensure(peer);
    online.secrets.close();
    const other = { authority: `omega-key:${"c".repeat(64)}`, user_id: 7 };
    const otherChat = deriveChatId(owner, other);
    const originalKey = `cache:${JSON.stringify(["chat-secret-envelope:v1", cacheScope, chat, 2])}`;
    const movedKey = `cache:${JSON.stringify(["chat-secret-envelope:v1", cacheScope, otherChat, 2])}`;
    database.set(movedKey, database.get(originalKey));
    const offline = service(false);
    await expect(offline.secrets.read(other, 2)).rejects.toThrow(
      "does not match",
    );
    expect(offline.propose).not.toHaveBeenCalled();
    offline.secrets.close();
  });
});

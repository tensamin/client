/// <reference types="node" />
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { initSync } from "mtp/raw";
import { bytesToBase64, crypto } from "mtp";
import { deriveChatId, encodePrincipal } from "@tensamin/shared/principal";
import {
  CHAT_SECRET_WRAPPING_SCHEME,
  deriveChatSecretId,
  ownKemPublicKeyFromKeyring,
  wrapChatSecret,
} from "@tensamin/crypto/chatSecret";
import { ConversationSecrets, decodeSecretRead } from "./chatSecret";

const owner = { authority: `omega-key:${"a".repeat(64)}`, user_id: 42 };
const peer = { authority: `omega-key:${"b".repeat(64)}`, user_id: 42 };
const chat = deriveChatId(owner, peer);
const request = {
  UserId: encodePrincipal(owner),
  ChatId: chat,
  SecretId: deriveChatSecretId(chat),
};
const absent = {
  type: "ErrorNotSet",
  data: {
    ErrorType: "no_such_conversation",
    Json: new TextEncoder().encode(
      '{"retryable":false,"state":"no_such_conversation"}',
    ),
  },
};

beforeAll(() => {
  initSync({
    module: readFileSync(
      new URL(
        "../../bindings/wasm/pkg/mtp_wasm_bg.wasm",
        import.meta.resolve("mtp"),
      ),
    ),
  });
});

describe("committed owner envelopes", () => {
  it("rejects mismatched owner, pair, epoch, wrapping scheme and malformed bytes before decapsulation", () => {
    const data = {
      ...request,
      VersionNumber: 3,
      WrappingScheme: CHAT_SECRET_WRAPPING_SCHEME,
      EncryptedSecret: new Uint8Array([1]),
      KemCiphertext: new Uint8Array([2]),
      CreatedAt: 1,
      UpdatedAt: 2,
    };
    expect(
      decodeSecretRead(
        { type: "ChatSecretResponse", data },
        { ...request, VersionNumber: 3 },
      ).kind,
    ).toBe("envelope");
    for (const change of [
      { UserId: encodePrincipal(peer) },
      { ChatId: "42:43" },
      { SecretId: "other" },
      { VersionNumber: 4 },
      { VersionNumber: Number.MAX_SAFE_INTEGER + 1 },
      { WrappingScheme: "other" },
      { EncryptedSecret: [1] },
      { KemCiphertext: "Ag==" },
      { CreatedAt: -1 },
      { UpdatedAt: 0 },
    ]) {
      expect(() =>
        decodeSecretRead(
          { type: "ChatSecretResponse", data: { ...data, ...change } },
          { ...request, VersionNumber: 3 },
        ),
      ).toThrow();
    }
  });

  it("does not interpret a generic or inconsistent error as permission to create an epoch", () => {
    expect(decodeSecretRead(absent, request)).toMatchObject({
      kind: "unavailable",
      state: "no_such_conversation",
    });
    for (const response of [
      { type: "ErrorNotSet", data: {} },
      { ...absent, type: "Success" },
      { ...absent, data: { ...absent.data, ErrorType: "epoch_unavailable" } },
    ]) {
      expect(() => decodeSecretRead(response, request)).toThrow();
    }
  });
});

it("uses the committed winner after concurrent initialization, preserves historical epochs and clears keys on close", async () => {
  const keyring = bytesToBase64(crypto.generateKeyring());
  const kem = ownKemPublicKeyFromKeyring(keyring);
  const winningKey = new Uint8Array(32).fill(17);
  const historicalKey = new Uint8Array(32).fill(9);
  const envelope = async (value: Uint8Array, version: number) => {
    const wrapped = await wrapChatSecret({
      chatSecret: value,
      recipientKemPublicKey: kem,
      chatId: chat,
      secretId: request.SecretId,
      version,
    });
    return {
      type: "ChatSecretResponse",
      data: {
        ...request,
        VersionNumber: version,
        EncryptedSecret: wrapped.encryptedSecret,
        KemCiphertext: wrapped.kemCiphertext,
        WrappingScheme: wrapped.wrappingScheme,
        CreatedAt: 1,
        UpdatedAt: 1,
      },
    };
  };
  const winner = await envelope(winningKey, 2);
  const historical = await envelope(historicalKey, 1);
  let committed = false;
  let proposals = 0;
  const service = new ConversationSecrets({
    owner,
    keyring: async () => keyring,
    request: async (read) =>
      read.VersionNumber === 1 ? historical : committed ? winner : absent,
    kemKeys: async () => [kem, kem],
    propose: async (_peer, proposal) => {
      proposals++;
      expect(proposal.Recipients.map((copy) => copy.UserId)).toEqual([
        encodePrincipal(owner),
        encodePrincipal(peer),
      ]);
      expect(proposal.ChatId).toBe(chat);
      expect(proposal).not.toHaveProperty("CreatedAt");
      committed = true;
      return { type: "ErrorInvalidData", data: { Status: "rejected" } };
    },
  });
  const [first, second] = await Promise.all([
    service.ensure(peer),
    service.ensure(peer),
  ]);
  expect(proposals).toBe(1);
  expect(first).toBe(second);
  expect(first).toEqual({ kind: "ready", version: 2, value: winningKey });
  const old = await service.read(peer, 1);
  expect(old).toEqual({ kind: "ready", version: 1, value: historicalKey });
  service.close();
  if (first.kind === "ready" && old.kind === "ready") {
    expect([...first.value, ...old.value].every((byte) => byte === 0)).toBe(
      true,
    );
  } else throw new Error("Expected both committed epochs");
  await expect(service.read(peer, 1)).rejects.toThrow("closed");
});

it("does not replace a missing historical epoch or turn a send receipt into a usable key", async () => {
  const keyring = bytesToBase64(crypto.generateKeyring());
  const kem = ownKemPublicKeyFromKeyring(keyring);
  let proposals = 0;
  const service = new ConversationSecrets({
    owner,
    keyring: async () => keyring,
    request: async () => absent,
    kemKeys: async () => [kem, kem],
    propose: async () => {
      proposals++;
      return { type: "Success", data: {} };
    },
  });
  expect(await service.read(peer, 7)).toEqual({
    kind: "terminal",
    reason: "epoch_unavailable",
  });
  expect(proposals).toBe(0);
  expect(await service.ensure(peer)).toEqual({ kind: "pending" });
  service.close();
});

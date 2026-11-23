import { assert, beforeAll, describe, expect, it, vi } from "vitest";
import { codec } from "mtp";
import { messageBodyBytes, mtp } from "@tensamin/shared/data";
import { initMtpForTest } from "../../../utils/test/mtpWasm";
import { decryptChatText, encryptChatText } from "./chatSecret";

vi.mock("./messageCodec", async () => {
  const { encodeMessagePayload, decodeMessagePayload } =
    await import("./messagePayload");
  return {
    encodeMessageText: encodeMessagePayload,
    decodeMessageText: decodeMessagePayload,
  };
});

const secret = new Uint8Array(32).fill(9);
beforeAll(initMtpForTest);

describe("binary message transport through the Rust codec", () => {
  it("carries compressed ciphertext as MTP bytes and decrypts it after decoding", async () => {
    const text = `Grüße 🌅 ${"release notes for the dev rollout. ".repeat(200)}`;
    const Content = await encryptChatText(secret, text, 3);
    const Files = [
      { Content: await encryptChatText(secret, '{"name":"a.txt"}', 3) },
      {
        Content: await encryptChatText(secret, '{"name":"b.txt"}', 3),
        Status: "uploading" as const,
      },
    ];

    const frame = codec.encode("MessageSend", {
      Content,
      Files,
      ReceiverId: 2,
      SendTime: 1,
      VersionNumber: 3,
    });
    const decoded = mtp.MessageSend.request.parse(codec.decode(frame).data);

    assert(decoded.Content instanceof Uint8Array);
    expect(decoded.Files).toEqual(Files);
    expect(await decryptChatText(secret, decoded.Content, 3)).toBe(text);
    expect(Content.length).toBeLessThan(new TextEncoder().encode(text).length);
  });

  it("measures the message body exactly as the Rust encoder frames it", async () => {
    const Content = await encryptChatText(secret, "size check", 1);
    const Files = [
      { Content: crypto.getRandomValues(new Uint8Array(77)) },
      {
        Content: crypto.getRandomValues(new Uint8Array(5)),
        Status: "failed" as const,
      },
    ];
    const base = codec.encode("MessageSend", { SendTime: 1 }).length;
    const full = codec.encode("MessageSend", {
      Content,
      Files,
      SendTime: 1,
    }).length;
    const contentOnly = codec.encode("MessageSend", {
      Content,
      SendTime: 1,
    }).length;

    // The frame already has a payload container, so only the field bytes differ.
    expect(full - base).toBe(messageBodyBytes(Content, Files) - 3);
    expect(contentOnly - base).toBe(messageBodyBytes(Content, []) - 3);
  });
});

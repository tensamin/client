import brotliModule from "brotli-wasm";
import { describe, expect, it } from "vitest";
import {
  InvalidMessagePayloadError,
  MAX_MESSAGE_TEXT_BYTES,
  MessageTooLargeError,
  decodeMessagePayload,
  encodeMessagePayload,
} from "./messagePayload";

const brotli = await brotliModule;

function payload(flag: number, length: number[], data: Uint8Array) {
  return Uint8Array.from([flag, ...length, ...data]);
}

describe("message payload", () => {
  it.each([
    ["empty", ""],
    ["short", "hey, are you around later?"],
    ["unicode", "Grüße 🌅 日本語 \u{1F468}‍\u{1F469}‍\u{1F467} ﻿bom"],
    ["repetitive", "status update: all good. ".repeat(2000)],
  ])("round trips %s text", async (_, text) => {
    expect(await decodeMessagePayload(await encodeMessagePayload(text))).toBe(
      text,
    );
  });

  it("keeps raw bytes when compression does not help", async () => {
    const text = "ok";
    const encoded = await encodeMessagePayload(text);

    expect([...encoded]).toEqual([0, 2, 0x6f, 0x6b]);
  });

  it("compresses repetitive text", async () => {
    const text = "a".repeat(10_000);
    const encoded = await encodeMessagePayload(text);

    expect(encoded[0]).toBe(1);
    expect(encoded.length).toBeLessThan(100);
  });

  it("never stores more than the raw bytes and header", async () => {
    const random = crypto.getRandomValues(new Uint8Array(4096));
    const text = Array.from(random, (byte) =>
      String.fromCharCode(0x21 + (byte % 90)),
    ).join("");
    const encoded = await encodeMessagePayload(text);

    expect(encoded.length).toBeLessThanOrEqual(1 + 2 + 4096);
    expect(await decodeMessagePayload(encoded)).toBe(text);
  });

  it("accepts text at the size limit and rejects one byte more", async () => {
    const limit = "x".repeat(MAX_MESSAGE_TEXT_BYTES);

    expect(await decodeMessagePayload(await encodeMessagePayload(limit))).toBe(
      limit,
    );
    await expect(encodeMessagePayload(`${limit}x`)).rejects.toBeInstanceOf(
      MessageTooLargeError,
    );
  });

  it.each([
    ["empty payload", new Uint8Array()],
    ["unknown flag", payload(2, [1], Uint8Array.of(0x61))],
    ["missing length", Uint8Array.of(0)],
    ["unterminated length", Uint8Array.of(0, 0x80, 0x80, 0x80)],
    ["non-minimal length", payload(0, [0x81, 0], Uint8Array.of(0x61))],
    ["raw length mismatch", payload(0, [2], Uint8Array.of(0x61))],
    ["invalid UTF-8", payload(0, [2], Uint8Array.of(0xc3, 0x28))],
    ["empty compressed data", payload(1, [1], new Uint8Array())],
    ["garbage compressed data", payload(1, [4], Uint8Array.of(1, 2, 3, 4))],
  ])("rejects %s", async (_, value) => {
    await expect(decodeMessagePayload(value)).rejects.toBeInstanceOf(
      InvalidMessagePayloadError,
    );
  });

  it("rejects a declared length above the limit before decompressing", async () => {
    const value = payload(1, [0x81, 0x80, 0x10], Uint8Array.of(1));

    await expect(decodeMessagePayload(value)).rejects.toThrow(
      "Declared message length too large",
    );
  });

  it("stops a decompression bomb at the declared length", async () => {
    const bomb = brotli.compress(new Uint8Array(64 * 1024 * 1024), {
      quality: 5,
    });

    expect(bomb.length).toBeLessThan(32 * 1024);
    const started = performance.now();

    await expect(
      decodeMessagePayload(payload(1, [0x80, 0x08], bomb)),
    ).rejects.toThrow("Message exceeds declared length");
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("rejects compressed data shorter than declared or with trailing bytes", async () => {
    const data = brotli.compress(new TextEncoder().encode("hello hello"), {
      quality: 11,
    });

    await expect(
      decodeMessagePayload(payload(1, [12], data)),
    ).rejects.toBeInstanceOf(InvalidMessagePayloadError);
    await expect(
      decodeMessagePayload(payload(1, [11], Uint8Array.of(...data, 0))),
    ).rejects.toBeInstanceOf(InvalidMessagePayloadError);
    expect(await decodeMessagePayload(payload(1, [11], data))).toBe(
      "hello hello",
    );
  });
});

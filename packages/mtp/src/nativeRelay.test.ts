import { beforeEach, expect, it, vi } from "vitest";
import type { MTPClient } from "mtp";
import { createNativeRelayClient } from "./nativeRelay";

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), decode: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("mtp", async (original) => ({
  ...(await original<typeof import("mtp")>()),
  decode: bridge.decode,
}));

beforeEach(() => {
  vi.resetAllMocks();
  bridge.invoke.mockImplementation(async (command) =>
    command === "mtp_prepare_sealed_relay" ? [1, 2, 255] : [9, 8],
  );
  bridge.decode.mockReturnValue({ type: "Success", data: {} });
});
function setup() {
  const active = {
    authenticated: true,
    generation: 3,
    client: {
      dictionaryIdentity: { version: "1.1", fingerprint: "a".repeat(64) },
    } as MTPClient | null,
  };
  const client = createNativeRelayClient({ session: () => active });
  return { active, client };
}
const options = {
  nextHop: { kind: "iota" as const, id: 12 },
  finalRecipientId: 9,
  metadataRecipients: [],
  contentRecipients: [],
  metadata: Uint8Array.of(1, 255),
  signatureSuite: "dual" as const,
};

it("persists the native prepared frame before the generation-fenced transmission", async () => {
  const { client } = setup();
  const beforeSend = vi.fn(async (frame: Uint8Array) => {
    expect(frame).toEqual(Uint8Array.of(1, 2, 255));
    expect(bridge.invoke.mock.calls.map(([command]) => command)).toEqual([
      "mtp_prepare_sealed_relay",
    ]);
    frame.fill(0);
  });
  expect(
    await client.requestSealedRelay(
      "MessageSend",
      { Content: Uint8Array.of(2, 255) },
      options,
      { beforeSend },
    ),
  ).toEqual({ type: "Success", data: {} });
  expect(bridge.invoke).toHaveBeenNthCalledWith(1, "mtp_prepare_sealed_relay", {
    generation: 3,
    dictionaryFingerprint: "a".repeat(64),
    request: {
      typeName: "MessageSend",
      data: { Content: [2, 255] },
      nextHop: options.nextHop,
      finalRecipientId: 9,
      metadataRecipients: [],
      contentRecipients: [],
      metadata: [1, 255],
    },
  });
  expect(bridge.invoke).toHaveBeenNthCalledWith(2, "mtp_send_prepared_relay", {
    generation: 3,
    dictionaryFingerprint: "a".repeat(64),
    frame: [1, 2, 255],
  });
  expect(bridge.decode).toHaveBeenCalledWith(Uint8Array.of(9, 8));
});

it("does not rebuild a retained relay during recovery", async () => {
  const { client } = setup();
  const beforeSend = vi.fn();
  await client.requestPrepared(Uint8Array.of(1, 2, 255), { beforeSend });
  expect(bridge.invoke.mock.calls.map(([command]) => command)).toEqual([
    "mtp_send_prepared_relay",
  ]);
  expect(beforeSend).toHaveBeenCalledWith(Uint8Array.of(1, 2, 255));
});

it("never transmits when persistence fails or the account changes before release", async () => {
  const { client, active } = setup();
  await expect(
    client.requestSealedRelay("MessageSend", {}, options, {
      beforeSend: () => {
        throw new Error("storage refused");
      },
    }),
  ).rejects.toThrow("storage refused");
  expect(bridge.invoke.mock.calls.map(([command]) => command)).toEqual([
    "mtp_prepare_sealed_relay",
  ]);
  await expect(
    client.requestPrepared(Uint8Array.of(1), {
      beforeSend: () => {
        active.generation++;
      },
    }),
  ).rejects.toThrow("session changed");
  expect(bridge.invoke).toHaveBeenCalledTimes(1);
});

it("rejects replies from a replaced native generation", async () => {
  const { client, active } = setup();
  bridge.invoke.mockImplementationOnce(async () => {
    active.generation++;
    return [9, 8];
  });
  await expect(
    client.requestPrepared(Uint8Array.of(1), { beforeSend: vi.fn() }),
  ).rejects.toThrow("session changed");
  expect(bridge.decode).not.toHaveBeenCalled();
});

import { beforeEach, expect, it, vi } from "vitest";
import type { MTPClient, ParsedFrame } from "mtp";
import { mtp as schemas } from "@tensamin/shared/data";
import type { BoundSendFn } from "./mtpContext";
import { createNativeCallControl } from "./nativeCallControl";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  encode: vi.fn(),
  decode: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("mtp", async (original) => ({
  ...(await original<typeof import("mtp")>()),
  encode: bridge.encode,
  decode: bridge.decode,
}));

const fingerprint = "a".repeat(64);
const response: ParsedFrame = {
  type: "CallToken",
  id: 17,
  data: {
    CallToken: "token-fixture",
    CallEndpoint: "wss://owner.example.org",
    OmikronId: 42,
  },
  raw: Uint8Array.of(9, 8, 7),
};
beforeEach(() => {
  vi.resetAllMocks();
  bridge.encode.mockReturnValue(Uint8Array.of(1, 2, 255));
  bridge.decode.mockReturnValue(response);
  bridge.invoke.mockResolvedValue([9, 8, 7]);
});

function setup() {
  const active = {
    authenticated: true,
    generation: 3,
    client: { dictionaryIdentity: { fingerprint } } as MTPClient<
      typeof schemas
    > | null,
  };
  const send = vi.fn<BoundSendFn>();
  const request = createNativeCallControl({ send, session: () => active });
  return { active, send, request };
}

it("leaves unspecified owners on the ordinary authenticated sender", async () => {
  const { send, request } = setup();
  send.mockResolvedValue(response);
  expect(await request(undefined, "CallToken", { CallId: "fixture" })).toBe(
    response,
  );
  expect(send).toHaveBeenCalledExactlyOnceWith(
    "CallToken",
    { CallId: "fixture" },
    undefined,
  );
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it("routes explicit owners through native discovery with the current dictionary and binary frame", async () => {
  const { send, request } = setup();
  const secret = {
    SecretId: "secret-fixture",
    VersionNumber: 1,
    EncryptedSecret: Uint8Array.of(0, 255),
    KemCiphertext: Uint8Array.of(255, 0),
    WrappingScheme: "fixture",
  };
  const beforeSend = vi.fn(async (bytes) => {
    expect(bytes).toEqual(Uint8Array.of(1, 2, 255));
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
  expect(
    await request(
      42,
      "CallToken",
      { CallId: "fixture", CallSecret: secret },
      { timeoutMs: 5000, beforeSend },
    ),
  ).toMatchObject(response);
  expect(bridge.encode.mock.calls[0][1]).toEqual({
    CallId: "fixture",
    CallSecret: secret,
  });
  expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith(
    "mtp_send_call_control",
    {
      ownerOmikronId: 42,
      generation: 3,
      dictionaryFingerprint: fingerprint,
      frame: [1, 2, 255],
      timeoutMs: 5000,
      responseType: undefined,
    },
  );
  expect(send).not.toHaveBeenCalled();
});

it("rejects invalid owners, non-call operations and malformed requests without network I/O", async () => {
  const { request } = setup();
  for (const owner of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])
    await expect(
      request(owner, "CallToken", { CallId: "fixture" }),
    ).rejects.toThrow("positive safe integer");
  await expect(request(42, "CallToken", {})).rejects.toThrow(
    "request validation",
  );
  await expect(
    request(42, "UserResolve", { UserAddress: "fixture" }),
  ).rejects.toThrow("call request");
  await expect(
    request(42, "CallToken", { CallId: "fixture" }, { timeoutMs: 0 }),
  ).rejects.toThrow("timeout");
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it("retains SDK response validation and protocol error behavior", async () => {
  const { request } = setup();
  bridge.decode.mockReturnValueOnce({ ...response, data: { OmikronId: 42 } });
  await expect(request(42, "CallToken", { CallId: "fixture" })).rejects.toThrow(
    "response validation",
  );
  bridge.decode.mockReturnValueOnce({
    ...response,
    type: "Error",
    data: { ErrorType: "Forbidden" },
  });
  await expect(request(42, "CallToken", { CallId: "fixture" })).rejects.toThrow(
    "Forbidden",
  );
});

it("prevents transmission when persistence rejects or the account changes before release", async () => {
  const { request, active } = setup();
  await expect(
    request(
      42,
      "CallToken",
      { CallId: "fixture" },
      {
        beforeSend: async () => {
          throw new Error("Storage unavailable");
        },
      },
    ),
  ).rejects.toThrow("Storage unavailable");
  await expect(
    request(
      42,
      "CallToken",
      { CallId: "fixture" },
      {
        beforeSend: async () => {
          active.generation++;
        },
      },
    ),
  ).rejects.toThrow("session changed");
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it("rejects stale owner replies and never falls back to the primary route", async () => {
  const { request, active, send } = setup();
  bridge.invoke.mockRejectedValueOnce(new Error("Owner unavailable"));
  await expect(request(42, "CallToken", { CallId: "fixture" })).rejects.toThrow(
    "Owner unavailable",
  );
  bridge.invoke.mockImplementationOnce(async () => {
    active.client = null;
    return [9, 8, 7];
  });
  await expect(request(42, "CallToken", { CallId: "fixture" })).rejects.toThrow(
    "session changed",
  );
  expect(send).not.toHaveBeenCalled();
});

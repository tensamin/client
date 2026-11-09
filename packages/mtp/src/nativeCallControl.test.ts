/// <reference types="node" />
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MTPClient, raw, encode, decode } from "mtp";
import { createNativeCallControl } from "./nativeCallControl";
import type { BoundSendFn } from "./mtpContext";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeAll(async () => {
  await MTPClient.init({
    module_or_path: readFileSync(
      new URL(
        "../../../apps/web/node_modules/.vite/mtp/mtp_wasm_bg.wasm",
        import.meta.url,
      ),
    ),
  });
});
beforeEach(() => vi.mocked(invoke).mockReset());

function connection() {
  const client = { dictionaryIdentity: raw.compiled_dictionary_identity() };
  const state = { authenticated: true, generation: 7, client };
  const send =
    vi.fn<(...args: Parameters<BoundSendFn>) => ReturnType<BoundSendFn>>();
  return {
    state,
    send,
    request: createNativeCallControl({ send, session: () => state }),
  };
}

it("routes call setup to the authoritative owner without history synchronization", async () => {
  const active = connection();
  vi.mocked(invoke).mockImplementationOnce(async (command, args) => {
    expect(command).toBe("mtp_send_call_control");
    expect(args).toMatchObject({
      ownerOmikronId: 9,
      generation: 7,
      dictionaryFingerprint: active.state.client.dictionaryIdentity.fingerprint,
    });
    expect(
      decode(Uint8Array.from((args as { frame: number[] }).frame)).type,
    ).toBe("CallReserve");
    return Array.from(
      encode("CallReserve", { CallId: "call-1", OmikronId: 9 }),
    );
  });
  const result = await active.request(9, "CallReserve", {});
  expect(result.data).toEqual({ CallId: "call-1", OmikronId: 9 });
  expect(active.send).not.toHaveBeenCalled();
});

it("rejects unauthorized call setup and does not report success", async () => {
  const active = connection();
  vi.mocked(invoke).mockResolvedValueOnce(
    Array.from(encode("ErrorNotAuthenticated", {})),
  );
  await expect(active.request(9, "CallReserve", {})).rejects.toThrow();
});

it("fences a stale setup result after account replacement", async () => {
  const active = connection();
  vi.mocked(invoke).mockImplementationOnce(async () => {
    active.state.generation++;
    return Array.from(
      encode("CallReserve", { CallId: "old-call", OmikronId: 9 }),
    );
  });
  await expect(active.request(9, "CallReserve", {})).rejects.toThrow(
    "session changed",
  );
});

it("does not send a cancelled setup or a wrong-account operation", async () => {
  const active = connection();
  await expect(
    active.request(
      9,
      "CallReserve",
      {},
      {
        beforeSend: async () => {
          active.state.authenticated = false;
        },
      },
    ),
  ).rejects.toThrow("session changed");
  expect(invoke).not.toHaveBeenCalled();
  await expect(active.request(9, "CallReserve", {})).rejects.toThrow(
    "not authenticated",
  );
  await expect(
    active.request(9, "MessageGet", { SendTime: 1 }),
  ).rejects.toThrow("call request");
});

it("allows call teardown while metadata synchronization is suspended", async () => {
  const active = connection();
  vi.mocked(invoke).mockResolvedValueOnce(Array.from(encode("EndCall", {})));
  expect((await active.request(9, "EndCall", { CallId: "call-1" })).type).toBe(
    "EndCall",
  );
  expect(invoke).toHaveBeenCalledTimes(1);
});

/// <reference types="node" />
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { initSync } from "mtp/raw";
import type { BoundSendFn } from "./mtpContext";
import { parseExactJson, stringifyExactJson } from "@tensamin/shared/exactJson";
import { encodePrincipal } from "@tensamin/shared/principal";
import { createPrincipalProofResolver } from "./principalProof";

const io = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  put: vi.fn(),
}));
vi.mock("@tensamin/cache", () => ({
  createCache: (account: string) => ({
    identities: {
      get: async (principal: string) =>
        io.records.get(`${account}:${principal}`),
      put: async (proof: { Principal: string }) => {
        await io.put(proof);
        io.records.set(`${account}:${proof.Principal}`, proof);
      },
    },
  }),
}));
const fixture = parseExactJson(
  readFileSync(
    new URL(
      "../../crypto/src/fixtures/principal-proof-rust.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  proof: {
    descriptor: {
      principal: { authority: string; user_id: bigint };
      home: { iota: string };
    };
  };
  home_public_key: string;
};
const principal = fixture.proof.descriptor.principal;
const canonical = encodePrincipal(principal);
const accountKey = "fixture-authorization-generation";
const cacheKey = `${accountKey}:${canonical}`;
const response = {
  type: "UserResolved",
  data: {
    Principal: canonical,
    UserId: principal.user_id,
    AuthorityId: principal.authority,
    NodeId: fixture.proof.descriptor.home.iota,
    PublicKey: fixture.home_public_key,
    Json: stringifyExactJson(fixture.proof),
    SigningKeys: ["untrusted-key-list"],
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
beforeEach(() => {
  io.records.clear();
  io.put.mockReset();
  vi.spyOn(Date, "now").mockReturnValue(200);
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _key: string,
        _options: unknown,
        operation: () => Promise<unknown>,
      ) => operation(),
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  const controller = new AbortController();
  const send = vi.fn(async () => response);
  const resolve = createPrincipalProofResolver({
    accountKey,
    send: send as unknown as BoundSendFn,
    signal: controller.signal,
  });
  return { resolve, send, controller };
}

it("returns authority-authenticated history, not Iota's asserted signing-key list", async () => {
  const { resolve, send } = setup();
  const result = await resolve(principal);
  expect(result.publicKeys).toHaveLength(2);
  expect(result.publicKeys.every((key) => key.length > 1)).toBe(true);
  expect(send).toHaveBeenCalledExactlyOnceWith("UserResolve", {
    UserAddress: canonical,
    Json: '{"principal_proof":1}',
  });
  expect(io.records.get(cacheKey)).toMatchObject({
    Principal: canonical,
    Revision: "4",
  });
});

it("pins the committed revision across resolver recreation and refuses rollback", async () => {
  await setup().resolve(principal);
  io.records.set(cacheKey, { Principal: canonical, Revision: "5" });
  io.put.mockClear();
  await expect(setup().resolve(principal)).rejects.toThrow("freshness bounds");
  expect(io.put).not.toHaveBeenCalled();
  expect(io.records.get(cacheKey)).toMatchObject({ Revision: "5" });
});

it("does not accept a missing proof or contradictory response identity", async () => {
  for (const changed of [
    { Json: undefined },
    { Principal: "another-principal" },
    { UserId: 8n },
    { AuthorityId: `omega-key:${"a".repeat(64)}` },
    { NodeId: `iota:v1:${"a".repeat(64)}` },
  ]) {
    const { resolve, send } = setup();
    send.mockResolvedValueOnce({
      ...response,
      data: { ...response.data, ...changed },
    } as typeof response);
    await expect(resolve(principal)).rejects.toThrow();
    expect(io.put).not.toHaveBeenCalled();
  }
});

it("does not release a verified result until its revision pin persists", async () => {
  io.put.mockRejectedValueOnce(new Error("Storage unavailable"));
  await expect(setup().resolve(principal)).rejects.toThrow(
    "Storage unavailable",
  );
  expect(io.records.has(cacheKey)).toBe(false);
});

it("fences account replacement during resolution and refuses a relocated revision pin", async () => {
  const { resolve, send, controller } = setup();
  send.mockImplementationOnce(async () => {
    controller.abort(new Error("Account replaced"));
    return response;
  });
  await expect(resolve(principal)).rejects.toThrow("Account replaced");
  expect(io.put).not.toHaveBeenCalled();
  io.records.set(cacheKey, { Principal: "another-principal", Revision: "4" });
  const restored = setup();
  await expect(restored.resolve(principal)).rejects.toThrow(
    "another principal",
  );
  expect(restored.send).not.toHaveBeenCalled();
});

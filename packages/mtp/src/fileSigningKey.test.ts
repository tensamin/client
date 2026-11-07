import { beforeEach, expect, it, vi } from "vitest";
import type { BoundSendFn } from "./mtpContext";
import { createFileSigningKeyResolver } from "./fileSigningKey";

const verify = vi.hoisted(() => vi.fn());
vi.mock("@tensamin/crypto/fileSigningKey", async (original) => ({
  ...(await original<typeof import("@tensamin/crypto/fileSigningKey")>()),
  verifyFileSigningKeyProof: verify,
}));
const principal = { authority: `omega-key:${"a".repeat(64)}`, user_id: 7n };
const keyId = "b".repeat(64);
beforeEach(() => vi.resetAllMocks());

it("uses a distinct exact-key selector and only returns independently verified historical bytes", async () => {
  const send = vi
    .fn()
    .mockResolvedValue({
      type: "UserResolved",
      data: {
        Principal: JSON.stringify({ ...principal, user_id: 7 }),
        AuthorityId: principal.authority,
        UserId: 7,
        Json: "proof",
      },
    });
  verify.mockReturnValue(Uint8Array.of(1, 2, 3));
  const resolver = createFileSigningKeyResolver({
    send: send as BoundSendFn,
    signal: new AbortController().signal,
  });
  expect(await resolver(principal, keyId)).toEqual(Uint8Array.of(1, 2, 3));
  expect(send).toHaveBeenCalledExactlyOnceWith("UserResolve", {
    UserAddress: JSON.stringify({ ...principal, user_id: 7 }),
    Json: JSON.stringify({ file_signing_key: keyId }),
  });
  expect(verify).toHaveBeenCalledExactlyOnceWith("proof", principal, keyId);
});

it("fails on rejection or cancellation without returning asserted server keys", async () => {
  const controller = new AbortController();
  const send = vi.fn().mockResolvedValue({ type: "ErrorNotFound", data: {} });
  const resolver = createFileSigningKeyResolver({
    send: send as BoundSendFn,
    signal: controller.signal,
  });
  await expect(resolver(principal, keyId)).rejects.toThrow("unavailable");
  controller.abort();
  await expect(resolver(principal, keyId)).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(1);
  expect(verify).not.toHaveBeenCalled();
});

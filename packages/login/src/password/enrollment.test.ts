import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageContextValue } from "@tensamin/storage/context";
import {
  disablePasswordLogin,
  enrollPassword,
  passwordEnrollmentStatus,
  type PasswordManagementClient,
} from "./enrollment";
import { ProvisioningUnavailableError } from "../errors";
import { PasswordServiceError } from "./failure";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  verify: vi.fn(),
  registration: vi.fn(),
  finish: vi.fn(),
  dispose: vi.fn(),
  reconcile: vi.fn(),
  mutations: vi.fn(),
}));
vi.mock("mtp", async (original) => {
  const actual = await original<typeof import("mtp")>();
  return {
    ...actual,
    requestProtected: mocks.request,
    crypto: { ...actual.crypto, sha256: () => new Uint8Array(32) },
  };
});
vi.mock("../omega", async (original) => ({
  ...(await original<typeof import("../omega")>()),
  fetchAccountIdentity: async () => ({
    user_id: 7,
    iota_id: 1,
    principal: `omega-key:${"a".repeat(64)}#7`,
    public_key: "AQ==",
  }),
  fetchIotaIdentity: async () => ({ public_key: "AQ==" }),
}));
vi.mock("../credential", async (original) => ({
  ...(await original<typeof import("../credential")>()),
  canonicalPublicKeyBundle: () => Uint8Array.of(1),
  validateRecoveredCredential: mocks.verify,
}));
vi.mock("./opaque", () => ({ startRegistration: mocks.registration }));
vi.mock("./envelope", () => ({ encryptCredential: () => Uint8Array.of(9) }));
vi.mock("./mutations", () => ({ createPasswordMutations: mocks.mutations }));

let keyring: Uint8Array;
let exportKey: Uint8Array;
const principal = JSON.stringify({
  authority: `omega-key:${"a".repeat(64)}`,
  user_id: 7,
});
const storage = { load: async () => "encoded-account-key" } as unknown as Pick<
  StorageContextValue,
  "load"
>;
const options = {
  client: {} as PasswordManagementClient,
  authorizationGeneration: 1,
  username: "alice",
  principal,
  storage,
  omegaOrigin: "https://omega.invalid/",
};
beforeEach(() => {
  vi.resetAllMocks();
  keyring = Uint8Array.of(1, 2, 3);
  exportKey = Uint8Array.of(4, 5, 6);
  mocks.verify.mockReturnValue({ keyring, publicKeyBundle: Uint8Array.of(1) });
  mocks.finish.mockReturnValue({ exportKey, record: Uint8Array.of(8) });
  mocks.registration.mockReturnValue({
    request: Uint8Array.of(7),
    finish: mocks.finish,
    dispose: mocks.dispose,
  });
  mocks.mutations.mockImplementation(({ client, rpc }) => ({
    withLock: (operation: () => Promise<unknown>) => operation(),
    reconcile: mocks.reconcile,
    mutate: async (type: string, data: unknown) => {
      const response = await mocks.request(client, type, data, {
        ...rpc,
        responseType: "PasswordEnrollmentStatus",
      });
      return response.data.Enabled;
    },
  }));
});

describe("password management key lifecycle", () => {
  it("does not start a replacement enrollment while an earlier outcome remains unknown", async () => {
    mocks.reconcile.mockRejectedValueOnce(
      new PasswordServiceError("unknown_outcome"),
    );
    await expect(
      enrollPassword({ ...options, password: Uint8Array.of(1) }),
    ).rejects.toMatchObject({ code: "unknown_outcome" });
    expect(mocks.registration).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(keyring).toEqual(new Uint8Array(3));
    expect(JSON.parse(mocks.mutations.mock.calls[0][0].binding).at(-1)).toBe(1);
  });
  it("does not load keys or send a command for an already cancelled account lifetime", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Account replaced"));
    await expect(
      passwordEnrollmentStatus({ ...options, signal: controller.signal }),
    ).rejects.toThrow("Account replaced");
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("does not finish enrollment after the owning account is replaced during start", async () => {
    const controller = new AbortController();
    mocks.request.mockImplementationOnce(async () => {
      controller.abort(new Error("Account replaced"));
      return {
        type: "PasswordEnrollmentResponse",
        data: {
          Uuid: "00000000-0000-4000-8000-000000000001",
          OpaqueMessage: Uint8Array.of(2),
        },
      };
    });
    await expect(
      enrollPassword({
        ...options,
        password: Uint8Array.of(1),
        signal: controller.signal,
      }),
    ).rejects.toThrow("Account replaced");
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(keyring).toEqual(new Uint8Array(3));
  });

  it.each(["status", "disable"] as const)(
    "does not return a late %s result to a replacement account",
    async (action) => {
      const controller = new AbortController();
      mocks.request.mockImplementationOnce(async () => {
        controller.abort(new Error("Account replaced"));
        return { type: "PasswordEnrollmentStatus", data: { Enabled: false } };
      });
      const invoke =
        action === "status" ? passwordEnrollmentStatus : disablePasswordLogin;
      await expect(
        invoke({ ...options, signal: controller.signal }),
      ).rejects.toThrow("Account replaced");
      expect(keyring).toEqual(new Uint8Array(3));
    },
  );

  it("rejects another authority with the same numeric user ID before loading credentials or sending commands", async () => {
    const other = JSON.stringify({
      authority: `omega-key:${"b".repeat(64)}`,
      user_id: 7,
    });
    await expect(
      passwordEnrollmentStatus({ ...options, principal: other }),
    ).rejects.toThrow("different principal");
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "returns explicit status %s and clears only the temporary account-key copy",
    async (Enabled) => {
      mocks.request.mockResolvedValueOnce({
        type: "PasswordEnrollmentStatus",
        data: { Enabled },
      });
      await expect(passwordEnrollmentStatus(options)).resolves.toBe(Enabled);
      expect(keyring).toEqual(new Uint8Array(3));
      expect(mocks.request.mock.calls[0][3].errorTypes).toEqual([
        "ErrorInvalidData",
        "ErrorNotAuthenticated",
        "ErrorInternal",
      ]);
    },
  );

  it("never turns an unavailable status into disabled", async () => {
    const error = new Error("Service unavailable");
    mocks.request.mockRejectedValueOnce(error);
    await expect(passwordEnrollmentStatus(options)).rejects.toBe(error);
    expect(keyring).toEqual(new Uint8Array(3));
  });

  it("requires an explicit disabled response and clears keys even if disable is unconfirmed", async () => {
    mocks.request.mockResolvedValueOnce({
      type: "PasswordEnrollmentStatus",
      data: { Enabled: true },
    });
    await expect(disablePasswordLogin(options)).rejects.toBeInstanceOf(
      ProvisioningUnavailableError,
    );
    expect(keyring).toEqual(new Uint8Array(3));
  });

  it("clears the account key if local OPAQUE setup fails", async () => {
    const error = new Error("OPAQUE setup failed");
    mocks.registration.mockImplementationOnce(() => {
      throw error;
    });
    await expect(
      enrollPassword({ ...options, password: Uint8Array.of(1) }),
    ).rejects.toBe(error);
    expect(keyring).toEqual(new Uint8Array(3));
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("clears account and export keys and disposes registration after a lost finish response", async () => {
    mocks.request
      .mockResolvedValueOnce({
        type: "PasswordEnrollmentResponse",
        data: {
          Uuid: "00000000-0000-4000-8000-000000000001",
          OpaqueMessage: Uint8Array.of(2),
        },
      })
      .mockRejectedValueOnce(new Error("Finish response lost"));
    await expect(
      enrollPassword({ ...options, password: Uint8Array.of(1) }),
    ).rejects.toThrow("Finish response lost");
    expect(keyring).toEqual(new Uint8Array(3));
    expect(exportKey).toEqual(new Uint8Array(3));
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});

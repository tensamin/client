import { beforeEach, describe, expect, it, vi } from "vitest";
import { MTPProtocolError } from "mtp";
import type { StorageContextValue } from "@tensamin/storage/context";
import {
  AuthenticationFailedError,
  CredentialVerificationError,
  ProvisioningUnavailableError,
} from "../errors";
import { loginWithPassword } from "./login";
import { NotFoundError } from "../omega";

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  iota: vi.fn(),
  omikron: vi.fn(),
  connect: vi.fn(),
  startLogin: vi.fn(),
  request: vi.fn(),
  send: vi.fn(),
  disconnect: vi.fn(),
  dispose: vi.fn(),
  finish: vi.fn(),
  openProtected: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("mtp", async (original) => {
  const actual = await original<typeof import("mtp")>();
  return {
    ...actual,
    MTPClient: { init: async () => undefined },
    crypto: { ...actual.crypto, sha256: () => new Uint8Array(32) },
  };
});
vi.mock("../omega", async (original) => ({
  ...(await original<typeof import("../omega")>()),
  fetchAccountIdentity: mocks.account,
  fetchIotaIdentity: mocks.iota,
  fetchAccountOmikron: mocks.omikron,
}));
vi.mock("../credential", async (original) => ({
  ...(await original<typeof import("../credential")>()),
  canonicalPublicKeyBundle: () => Uint8Array.of(1),
}));
vi.mock("../transport", () => ({ connectProvisioningClient: mocks.connect }));
vi.mock("./opaque", () => ({ startLogin: mocks.startLogin }));

const principal = `omega-key:${"a".repeat(64)}#7`;
let keyring: Uint8Array;
let exportKey: Uint8Array;
let events: string[];
const save = vi.fn();
const storage = { load: vi.fn(), save } as unknown as Pick<
  StorageContextValue,
  "load" | "save"
>;

beforeEach(() => {
  vi.resetAllMocks();
  keyring = Uint8Array.of(9, 8, 7);
  exportKey = Uint8Array.of(6, 5, 4);
  events = [];
  mocks.account.mockResolvedValue({
    username: "alice",
    user_id: 7,
    iota_id: 1,
    principal,
    public_key: "AQ==",
  });
  mocks.iota.mockResolvedValue({ public_key: "AQ==" });
  mocks.omikron.mockResolvedValue({
    id: 1,
    ip_address: "omikron.invalid",
    port: 443,
    public_key: "AQ==",
  });
  mocks.send.mockImplementation(async () => {
    events.push("cancel");
  });
  mocks.disconnect.mockImplementation(() => {
    events.push("disconnect");
  });
  mocks.connect.mockResolvedValue({
    keyring,
    publicKeyBundle: Uint8Array.of(1),
    publicKeyBase64: "AQ==",
    client: {
      request: mocks.request,
      send: mocks.send,
      openProtected: mocks.openProtected,
      subscribe: mocks.subscribe,
    },
    disconnect: mocks.disconnect,
  });
  mocks.finish.mockReturnValue({ exportKey, finalization: Uint8Array.of(3) });
  mocks.startLogin.mockReturnValue({
    request: Uint8Array.of(1),
    dispose: mocks.dispose,
    finish: mocks.finish,
  });
  mocks.request.mockImplementation(async (type: string) => {
    if (type === "ProvisioningCreate")
      return {
        data: {
          Uuid: "session",
          ProvisioningMethod: "password",
          ProvisioningRole: "contact",
          ProvisioningParticipantId: 1,
        },
      };
    if (type === "PasswordProvisioningStart")
      return { data: { Uuid: "session", OpaqueMessage: Uint8Array.of(2) } };
    return { raw: new Uint8Array() };
  });
});

function login() {
  return loginWithPassword({
    username: "alice",
    password: new TextEncoder().encode("password"),
    omegaOrigin: "https://omega.invalid/",
    storage,
  });
}

describe("password login failure lifecycle", () => {
  it("reports a discovery outage without treating it as a wrong password", async () => {
    const outage = new ProvisioningUnavailableError();
    mocks.account.mockRejectedValueOnce(outage);
    await expect(login()).rejects.toBe(outage);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("does not reveal an unknown account in its authentication error", async () => {
    mocks.account.mockRejectedValueOnce(new NotFoundError("account"));
    await expect(login()).rejects.toThrow(
      new AuthenticationFailedError().message,
    );
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("cancels a failed active session before disconnecting and clears temporary keys", async () => {
    const outage = new MTPProtocolError({
      type: "ErrorNoIota",
      data: {},
      raw: new Uint8Array(),
    });
    mocks.request
      .mockResolvedValueOnce({
        data: {
          Uuid: "session",
          ProvisioningMethod: "password",
          ProvisioningRole: "contact",
        },
      })
      .mockRejectedValueOnce(outage);
    await expect(login()).rejects.toBeInstanceOf(ProvisioningUnavailableError);
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(keyring).toEqual(new Uint8Array(3));
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(events).toEqual(["cancel", "disconnect"]);
    expect(save).not.toHaveBeenCalled();
  });

  it("never sends KE3 when OPAQUE rejects the password", async () => {
    mocks.finish.mockImplementationOnce(() => {
      throw new Error("OPAQUE rejection");
    });
    await expect(login()).rejects.toBeInstanceOf(AuthenticationFailedError);
    expect(mocks.request.mock.calls.map(([type]) => type)).toEqual([
      "ProvisioningCreate",
      "PasswordProvisioningStart",
    ]);
    expect(mocks.send).toHaveBeenCalledWith("ProvisioningCancel", {
      Uuid: "session",
    });
    expect(events).toEqual(["cancel", "disconnect"]);
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(keyring).toEqual(new Uint8Array(3));
  });

  it("rejects a mismatched session as a protocol defect, not a wrong password", async () => {
    mocks.request
      .mockResolvedValueOnce({
        data: {
          Uuid: "session",
          ProvisioningMethod: "password",
          ProvisioningRole: "contact",
        },
      })
      .mockResolvedValueOnce({
        data: { Uuid: "other-session", OpaqueMessage: Uint8Array.of(2) },
      });
    await expect(login()).rejects.toBeInstanceOf(CredentialVerificationError);
    expect(events).toEqual(["cancel", "disconnect"]);
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it("preserves protected-credential verification failure and clears the export key", async () => {
    const verification = new Error("Signature verification failed");
    mocks.openProtected.mockRejectedValueOnce(verification);
    await expect(login()).rejects.toBe(verification);
    expect(exportKey).toEqual(new Uint8Array(3));
    expect(keyring).toEqual(new Uint8Array(3));
    expect(events).toEqual(["cancel", "disconnect"]);
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});

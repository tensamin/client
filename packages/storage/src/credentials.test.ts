import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageContextValue } from "./context";
import { persistNativeMtpConfig } from "./credentials";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => mocks);
const load = vi.fn();
const storage = { load } as Pick<StorageContextValue, "load">;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.isTauri.mockReturnValue(true);
  mocks.invoke.mockResolvedValue(true);
  load.mockImplementation(async (key: string) =>
    key === "omega_url" ? "https://omega.invalid/" : undefined,
  );
});

describe("native credential persistence ownership", () => {
  it("always runs the plugin persistence command after host import, even if the connection is already active", async () => {
    await persistNativeMtpConfig({
      storage,
      userId: 7,
      keyring: "fixture-key",
    });
    expect(mocks.invoke.mock.calls.map(([name]) => name)).toEqual([
      "plugin:mtp|mtp_clear_credentials",
      "mtp_store_credentials",
      "plugin:mtp|mtp_connect",
    ]);
    expect(mocks.invoke.mock.calls[0][1]).toEqual({ name: "mtp:credentials" });
    expect(mocks.invoke.mock.calls[2][1]).toEqual({
      name: "mtp:credentials",
      mode: "auth",
    });
  });

  it("does not continue when the native secure import fails", async () => {
    mocks.invoke
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("OS credential store is locked"));
    await expect(
      persistNativeMtpConfig({ storage, userId: 7, keyring: "fixture-key" }),
    ).rejects.toThrow("OS credential store is locked");
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("does not import replacement credentials if retiring the durable identity fails", async () => {
    mocks.invoke.mockRejectedValueOnce(
      new Error("Durable identity could not be cleared"),
    );
    await expect(
      persistNativeMtpConfig({ storage, userId: 7, keyring: "fixture-key" }),
    ).rejects.toThrow("Durable identity could not be cleared");
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });

  it("does not report success if plugin-side durable persistence fails", async () => {
    mocks.invoke
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Durable persistence failed"));
    await expect(
      persistNativeMtpConfig({ storage, userId: 7, keyring: "fixture-key" }),
    ).rejects.toThrow("Durable persistence failed");
  });

  it("does not invoke native credential APIs in the browser", async () => {
    mocks.isTauri.mockReturnValue(false);
    await persistNativeMtpConfig({
      storage,
      userId: 7,
      keyring: "fixture-key",
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});

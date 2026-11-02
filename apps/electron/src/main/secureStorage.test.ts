import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ directory: "", available: true }));
vi.mock("electron", () => ({
  app: { getPath: () => host.directory },
  safeStorage: {
    isEncryptionAvailable: () => host.available,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value: string) => Buffer.from(`os-store-fixture:${value}`),
    decryptString: (value: Buffer) => {
      const encoded = value.toString();
      if (!encoded.startsWith("os-store-fixture:"))
        throw new Error("Invalid OS ciphertext");
      return encoded.slice("os-store-fixture:".length);
    },
  },
}));

beforeEach(async () => {
  vi.resetModules();
  host.directory = await mkdtemp(join(tmpdir(), "tensamin-electron-store-"));
  host.available = true;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(host.directory, { recursive: true, force: true });
});

describe("Electron secure storage ownership with real file I/O and a mocked OS keyring", () => {
  it("returns one persisted winner to concurrent master-key creators", async () => {
    const store = await import("./secureStorage");
    const winners = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.getOrCreateSecureStorage("master", `candidate-${index}`),
      ),
    );
    expect(new Set(winners).size).toBe(1);
    expect(await store.loadSecureStorage("master")).toBe(winners[0]);
    vi.resetModules();
    const restarted = await import("./secureStorage");
    expect(
      await restarted.getOrCreateSecureStorage("master", "replacement"),
    ).toBe(winners[0]);
    if (process.platform !== "win32")
      expect(
        (await stat(join(host.directory, "secure-storage.json"))).mode & 0o777,
      ).toBe(0o600);
  });

  it("does not replace the previous store after a failed file write and can continue afterward", async () => {
    const store = await import("./secureStorage");
    await store.saveSecureStorage("existing", "retained");
    const path = join(host.directory, "secure-storage.json");
    const before = await readFile(path);
    await mkdir(`${path}.tmp`);
    await expect(
      store.getOrCreateSecureStorage("new", "candidate"),
    ).rejects.toThrow();
    expect(await readFile(path)).toEqual(before);
    expect(
      await store.getOrCreateSecureStorage("existing", "replacement"),
    ).toBe("retained");
    await rmdir(`${path}.tmp`);
    expect(await store.loadSecureStorage("new")).toBeNull();
  });

  it("refuses a corrupt store without overwriting it", async () => {
    const store = await import("./secureStorage");
    const path = join(host.directory, "secure-storage.json");
    await writeFile(path, "retained invalid encrypted-store document");
    await expect(
      store.getOrCreateSecureStorage("master", "candidate"),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(
      "retained invalid encrypted-store document",
    );
  });

  it("does not create a file when the OS keyring is unavailable", async () => {
    const store = await import("./secureStorage");
    host.available = false;
    expect(() => store.getOrCreateSecureStorage("master", "candidate")).toThrow(
      "unavailable",
    );
    await expect(
      stat(join(host.directory, "secure-storage.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lets independent renderer lifetimes decrypt each other's values with the committed winner", async () => {
    const store = await import("./secureStorage");
    vi.stubGlobal("window", {
      tensaminDesktop: {
        secureStorage: {
          getStatus: async () => store.getSecureStorageStatus(),
          getOrCreate: store.getOrCreateSecureStorage,
        },
      },
    });
    vi.stubGlobal("indexedDB", {});
    const first = await import("../../../../packages/storage/src/secure");
    vi.resetModules();
    const second = await import("../../../../packages/storage/src/secure");
    const [left, right] = await Promise.all([
      first.encodeSecureValue({ fixture: "left" }),
      second.encodeSecureValue({ fixture: "right" }),
    ]);
    expect(await first.decodeSecureValue(right)).toEqual({ fixture: "right" });
    expect(await second.decodeSecureValue(left)).toEqual({ fixture: "left" });
  });
});

import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearDatabaseStore,
  getDatabaseEntry,
  setDatabaseEntry,
} from "@tensamin/shared/indexedDb";
import { decodeSecureValue, encodeSecureValue } from "@tensamin/storage/secure";
import { notifyOnce } from "./receipt";

vi.mock("@tensamin/shared/log", () => ({ log: vi.fn() }));
beforeEach(async () => {
  await clearDatabaseStore("cache");
  const tails = new Map<string, Promise<void>>();
  vi.stubGlobal("navigator", {
    locks: {
      async request(key: string, action: () => Promise<unknown>) {
        const previous = tails.get(key);
        let release!: () => void;
        const next = new Promise<void>((resolve) => {
          release = resolve;
        });
        tails.set(key, next);
        await previous;
        try {
          return await action();
        } finally {
          release();
          if (tails.get(key) === next) tails.delete(key);
        }
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("deduplicates concurrent display and repeated delivery across reconnects", async () => {
  const alerts: string[] = [];
  const show = async () => {
    alerts.push("message");
  };
  expect(
    await Promise.all([
      notifyOnce("a", "sender:1", () => true, show),
      notifyOnce("a", "sender:1", () => true, show),
    ]),
  ).toEqual([true, false]);
  expect(await notifyOnce("a", "sender:1", () => true, show)).toBe(false);
  expect(alerts).toEqual(["message"]);
  expect(await notifyOnce("b", "sender:1", () => true, show)).toBe(true);
});

it("does not record undelivered or stale notifications", async () => {
  const show = vi.fn(async () => {});
  expect(await notifyOnce("a", "sender:1", () => false, show)).toBe(false);
  expect(show).not.toHaveBeenCalled();
  await expect(
    notifyOnce(
      "a",
      "sender:1",
      () => true,
      async () => {
        throw new Error("OS failed");
      },
    ),
  ).rejects.toThrow("OS failed");
  expect(await notifyOnce("a", "sender:1", () => true, show)).toBe(true);
  expect(show).toHaveBeenCalledTimes(1);
});

it("stores only a bounded account-bound ID record and replaces only a corrupt receipt", async () => {
  await setDatabaseEntry("cache", "unrelated", "keep");
  await setDatabaseEntry(
    "cache",
    "notification-receipts:v1:a",
    await encodeSecureValue({
      account: "a",
      ids: Array.from({ length: 1024 }, (_, index) => String(index)),
    }),
  );
  await notifyOnce(
    "a",
    "new",
    () => true,
    async () => {},
  );
  const saved = await decodeSecureValue(
    await getDatabaseEntry("cache", "notification-receipts:v1:a"),
  );
  expect(saved).toEqual({
    account: "a",
    ids: [
      ...Array.from({ length: 1023 }, (_, index) => String(index + 1)),
      "new",
    ],
  });
  await setDatabaseEntry(
    "cache",
    "notification-receipts:v1:a",
    await encodeSecureValue({ account: "foreign", ids: ["other"] }),
  );
  expect(
    await notifyOnce(
      "a",
      "new",
      () => true,
      async () => {},
    ),
  ).toBe(true);
  expect(await getDatabaseEntry("cache", "unrelated")).toBe("keep");
});

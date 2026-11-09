import { z } from "zod";
import { getDatabaseEntry, setDatabaseEntry } from "@tensamin/shared/indexedDb";
import {
  decodeSecureValue,
  encodeSecureValue,
  isSecureEnvelope,
} from "@tensamin/storage/secure";
import { log } from "@tensamin/shared/log";

const receipt = z.strictObject({
  account: z.string(),
  ids: z.array(z.string()).max(1024),
});

// Persist IDs only. This is notification deduplication, not message storage or a sync cursor.
export async function notifyOnce(
  account: string,
  id: string,
  current: () => boolean,
  show: () => Promise<void>,
) {
  if (!navigator.locks)
    throw new Error("Notification deduplication requires Web Locks");
  const key = `notification-receipts:v1:${account}`;
  return navigator.locks.request(key, async () => {
    if (!current()) return false;
    let ids: string[] = [];
    try {
      const stored = await getDatabaseEntry("cache", key);
      if (stored !== undefined) {
        if (!isSecureEnvelope(stored))
          throw new Error("Notification receipt is not encrypted");
        const decoded = receipt.parse(await decodeSecureValue(stored));
        if (decoded.account !== account)
          throw new Error("Notification receipt account changed");
        ids = decoded.ids;
      }
    } catch (error) {
      log(
        1,
        "notifications",
        "yellow",
        "Notification receipt unavailable",
        error,
      );
    }
    if (!current() || ids.includes(id)) return false;
    await show();
    try {
      await setDatabaseEntry(
        "cache",
        key,
        await encodeSecureValue({ account, ids: [...ids.slice(-1023), id] }),
      );
    } catch (error) {
      log(
        1,
        "notifications",
        "yellow",
        "Notification receipt could not be saved",
        error,
      );
    }
    return true;
  });
}

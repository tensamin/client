export const TENSAMIN_DB_NAME = "tensamin";
export const TENSAMIN_DB_VERSION = 1;
export type TensaminStore = "storage" | "cache" | "keys";

const stores: TensaminStore[] = ["storage", "cache", "keys"];
let databasePromise: Promise<IDBDatabase> | undefined;

export function openTensaminDatabase(
  indexedDb: IDBFactory = globalThis.indexedDB,
) {
  databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDb.open(TENSAMIN_DB_NAME, TENSAMIN_DB_VERSION);
    request.onupgradeneeded = () => {
      for (const store of stores) {
        if (!request.result.objectStoreNames.contains(store)) {
          request.result.createObjectStore(store);
        }
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      databasePromise = undefined;
      reject(request.error);
    };
    request.onblocked = () => {
      databasePromise = undefined;
      reject(new Error("The Tensamin database upgrade is blocked."));
    };
  });
  return databasePromise;
}

export async function getDatabaseEntry<T>(store: TensaminStore, key: string) {
  const database = await openTensaminDatabase();
  return new Promise<T | undefined>((resolve, reject) => {
    const request = database
      .transaction(store, "readonly")
      .objectStore(store)
      .get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function setDatabaseEntry(
  store: TensaminStore,
  key: string,
  value: unknown,
) {
  const database = await openTensaminDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(store, "readwrite");
    transaction.objectStore(store).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

// Encrypt/validate values before entering the transaction. A synchronization
// cursor must commit atomically with the records it acknowledges.
export async function setDatabaseEntries(
  store: TensaminStore,
  values: ReadonlyArray<readonly [string, unknown]>,
  signal: AbortSignal,
  deletedKeys: readonly string[] = [],
) {
  const database = await openTensaminDatabase();
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(store, "readwrite");
    const abort = () => transaction.abort();
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", abort);
    transaction.oncomplete = () => {
      cleanup();
      resolve();
    };
    transaction.onerror = transaction.onabort = () => {
      cleanup();
      reject(signal.aborted ? signal.reason : transaction.error);
    };
    const entries = transaction.objectStore(store);
    try {
      for (const [key, value] of values) entries.put(value, key);
      for (const key of deletedKeys) entries.delete(key);
    } catch (error) {
      transaction.abort();
      cleanup();
      reject(error);
    }
  });
}

export async function readDatabasePage(
  store: TensaminStore,
  prefix: string,
  after: string | undefined,
  limit = 16,
) {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 128 ||
    (after !== undefined && !after.startsWith(prefix))
  )
    throw new Error("Invalid database page");
  const database = await openTensaminDatabase();
  return new Promise<Array<[string, unknown]>>((resolve, reject) => {
    const entries: Array<[string, unknown]> = [];
    const request = database
      .transaction(store, "readonly")
      .objectStore(store)
      .openCursor(
        IDBKeyRange.bound(
          after ?? prefix,
          `${prefix}\uffff`,
          after !== undefined,
        ),
      );
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || entries.length === limit) {
        resolve(entries);
        return;
      }
      if (typeof cursor.key !== "string") {
        reject(new Error("Invalid database record key"));
        return;
      }
      entries.push([cursor.key, cursor.value]);
      if (entries.length === limit) resolve(entries);
      else cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

export async function deleteDatabasePrefix(
  store: TensaminStore,
  prefix: string,
) {
  const database = await openTensaminDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(store, "readwrite");
    transaction
      .objectStore(store)
      .delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
}

// Generate candidates before entering this transaction. Every tab receives the
// persisted winner, and no caller may use it until the transaction commits.
export async function getOrCreateDatabaseEntry<T>(
  store: TensaminStore,
  key: string,
  candidate: T,
) {
  const database = await openTensaminDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(store, "readwrite");
    const entries = transaction.objectStore(store);
    const request = entries.get(key);
    let winner: T;
    request.onsuccess = () => {
      if (request.result === undefined) {
        winner = candidate;
        entries.add(candidate, key);
      } else {
        winner = request.result as T;
      }
    };
    transaction.oncomplete = () => resolve(winner);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function deleteDatabaseEntry(store: TensaminStore, key: string) {
  const database = await openTensaminDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(store, "readwrite");
    transaction.objectStore(store).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function clearDatabaseStore(store: TensaminStore) {
  const database = await openTensaminDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(store, "readwrite");
    transaction.objectStore(store).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function listDatabaseEntries(
  store: TensaminStore,
  keyPrefix: string,
) {
  const database = await openTensaminDatabase();
  return new Promise<Array<[string, unknown]>>((resolve, reject) => {
    const entries: Array<[string, unknown]> = [];
    const cursor = database
      .transaction(store, "readonly")
      .objectStore(store)
      .openCursor();
    cursor.onsuccess = () => {
      const value = cursor.result;
      if (!value) {
        resolve(entries);
        return;
      }
      if (typeof value.key === "string" && value.key.startsWith(keyPrefix)) {
        entries.push([value.key, value.value]);
      }
      value.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

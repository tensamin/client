import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type Storage as StorageSchema,
  storageDefaults as defaults,
} from "@tensamin/shared/data";
import {
  deleteDatabaseEntry,
  getDatabaseEntry,
  setDatabaseEntry,
  openTensaminDatabase,
} from "@tensamin/shared/indexedDb";
import { ErrorScreen } from "@nonanium/ui";
import { log } from "@tensamin/shared/log";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  decodeSecureValue,
  encodeSecureValue,
  getSecureStorageStatus,
  isSecureEnvelope,
  type SecureStorageStatus,
} from "./secure";

export type SaveOptions = { secure?: boolean };

export interface StorageContextValue {
  load<K extends keyof StorageSchema>(key: K): Promise<StorageSchema[K]>;
  save<K extends keyof StorageSchema>(
    key: K,
    value: StorageSchema[K],
    options?: SaveOptions,
  ): Promise<void>;
  apply(values: Partial<StorageSchema>): Promise<void>;
  subscribe(
    handler: (keys: (keyof StorageSchema)[], bulk: boolean) => void,
  ): () => void;
  clear: () => Promise<void>;
  secureStorage: SecureStorageStatus | null;
}

const StorageContext = createContext<StorageContextValue | undefined>(
  undefined,
);

const isIndexedDBSupported = typeof indexedDB !== "undefined";

/**
 * Executes StorageProvider.
 * @param props Parameter props.
 * @returns unknown.
 */
export default function StorageProvider(props: { children: ReactNode }) {
  const [storage, setStorage] = useState<StorageSchema>(defaults);
  const storageRef = useRef(storage);
  const loadedKeys = useRef(new Set<keyof StorageSchema>());
  const loadPromises = useRef(
    new Map<keyof StorageSchema, Promise<StorageSchema[keyof StorageSchema]>>(),
  );
  const generations = useRef(new Map<keyof StorageSchema, number>());
  const subscribers = useRef(
    new Set<(keys: (keyof StorageSchema)[], bulk: boolean) => void>(),
  );
  const [secureStorage, setSecureStorage] =
    useState<SecureStorageStatus | null>(null);
  const secureStorageRef = useRef<SecureStorageStatus | null>(null);

  const [error, setError] = useState("");
  const [errorDescription, setErrorDescription] = useState("");

  useEffect(() => {
    void getSecureStorageStatus().then(
      (status) => {
        secureStorageRef.current = status;
        setSecureStorage(status);
      },
      (caught: unknown) => {
        setError("Failed to initialize secure storage");
        setErrorDescription(
          caught instanceof Error ? caught.message : String(caught),
        );
      },
    );
  }, []);

  const commit = useCallback(
    <K extends keyof StorageSchema>(key: K, nextValue: StorageSchema[K]) => {
      const changed =
        !loadedKeys.current.has(key) ||
        JSON.stringify(storageRef.current[key]) !== JSON.stringify(nextValue);
      loadedKeys.current.add(key);
      if (!changed) return;
      const next = { ...storageRef.current, [key]: nextValue };
      storageRef.current = next;
      setStorage(next);
      for (const handler of subscribers.current) handler([key], false);
    },
    [],
  );

  const load = useCallback(
    async <K extends keyof StorageSchema>(
      key: K,
    ): Promise<StorageSchema[K]> => {
      if (loadedKeys.current.has(key)) return storageRef.current[key];
      const pending = loadPromises.current.get(key);
      if (pending) return pending as Promise<StorageSchema[K]>;

      const generation = generations.current.get(key) ?? 0;
      const request = (async () => {
        try {
          if (key === "mtp_keyring" && isTauri()) {
            const restored = await invoke<boolean>("mtp_restore_credentials");
            const credentials = restored
              ? await invoke<{ keyring: number[] }>(
                  "plugin:mtp|mtp_export_credentials",
                  { name: "mtp:credentials" },
                )
              : null;
            const nativeValue = credentials
              ? btoa(String.fromCharCode(...credentials.keyring))
              : null;
            const value = (nativeValue ?? defaults[key]) as StorageSchema[K];
            if ((generations.current.get(key) ?? 0) === generation) {
              commit(key, value);
            }
            return value;
          }
          const desktopStorage = window.tensaminDesktop?.secureStorage;
          const desktopStatus = desktopStorage?.getStatus
            ? await desktopStorage.getStatus()
            : null;
          const desktopValue =
            desktopStatus?.available && desktopStorage?.load
              ? await desktopStorage.load(String(key))
              : null;
          let stored =
            desktopValue === null
              ? await getDatabaseEntry<StorageSchema[K]>("storage", key)
              : (JSON.parse(desktopValue) as StorageSchema[K]);
          if (isSecureEnvelope(stored)) {
            stored = (await decodeSecureValue(stored)) as StorageSchema[K];
          }
          const value = stored ?? defaults[key];
          if ((generations.current.get(key) ?? 0) === generation) {
            commit(key, value);
          }
          return (generations.current.get(key) ?? 0) === generation
            ? value
            : storageRef.current[key];
        } catch (err) {
          setError("Failed to load data");
          setErrorDescription(
            "An error occurred while loading local data. Please reload and try again.",
          );
          log(0, "Storage", "red", err);
          throw err;
        } finally {
          loadPromises.current.delete(key);
        }
      })();
      loadPromises.current.set(
        key,
        request as Promise<StorageSchema[keyof StorageSchema]>,
      );
      return request;
    },
    [commit],
  );

  const save = useCallback(
    async <K extends keyof StorageSchema>(
      key: K,
      value: StorageSchema[K],
      options: SaveOptions = {},
    ): Promise<void> => {
      generations.current.set(key, (generations.current.get(key) ?? 0) + 1);
      if (key === "mtp_keyring" && isTauri()) {
        commit(key, value);
        return;
      }
      const desktopStorage = window.tensaminDesktop?.secureStorage;
      if (JSON.stringify(value) === JSON.stringify(defaults[key])) {
        if (desktopStorage?.delete)
          await desktopStorage.delete(String(key)).catch(() => undefined);
        await deleteDatabaseEntry("storage", key);
        commit(key, defaults[key]);
      } else {
        const status = options.secure
          ? (secureStorageRef.current ?? (await getSecureStorageStatus()))
          : secureStorageRef.current;
        if (
          options.secure &&
          status?.backend === "electron-keyring" &&
          desktopStorage?.save
        ) {
          await desktopStorage.save(String(key), JSON.stringify(value));
          await deleteDatabaseEntry("storage", key);
        } else {
          const persisted = options.secure
            ? await encodeSecureValue(value)
            : value;
          await setDatabaseEntry("storage", key, persisted as StorageSchema[K]);
        }
        commit(key, value);
      }
    },
    [commit],
  );

  const clear = useCallback(async () => {
    const keys = Object.keys(defaults) as (keyof StorageSchema)[];
    for (const key of keys) {
      generations.current.set(key, (generations.current.get(key) ?? 0) + 1);
    }
    await Promise.all(keys.map((key) => deleteDatabaseEntry("storage", key)));
    await window.tensaminDesktop?.secureStorage
      ?.clear?.()
      .catch(() => undefined);
    loadedKeys.current.clear();
    loadPromises.current.clear();
    storageRef.current = defaults;
    setStorage(defaults);
    for (const handler of subscribers.current) handler(keys, true);
  }, []);

  const apply = useCallback(async (values: Partial<StorageSchema>) => {
    const entries = Object.entries(values) as [
      keyof StorageSchema,
      StorageSchema[keyof StorageSchema],
    ][];
    const database = await openTensaminDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("storage", "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
      const store = transaction.objectStore("storage");
      try {
        for (const [key, value] of entries) {
          if (JSON.stringify(value) === JSON.stringify(defaults[key])) {
            store.delete(key);
          } else {
            store.put(value, key);
          }
        }
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
    for (const [key] of entries) {
      generations.current.set(key, (generations.current.get(key) ?? 0) + 1);
      loadedKeys.current.add(key);
    }
    storageRef.current = { ...storageRef.current, ...values };
    setStorage(storageRef.current);
    const keys = entries.map(([key]) => key);
    for (const handler of subscribers.current) handler(keys, true);
  }, []);

  const subscribe = useCallback(
    (handler: (keys: (keyof StorageSchema)[], bulk: boolean) => void) => {
      subscribers.current.add(handler);
      return () => subscribers.current.delete(handler);
    },
    [],
  );

  const value = useMemo<StorageContextValue>(
    () => ({
      load,
      save,
      apply,
      subscribe,
      clear,
      secureStorage,
    }),
    [apply, clear, load, save, secureStorage, subscribe],
  );

  if (error !== "" && errorDescription !== "") {
    return (
      <ErrorScreen
        error={error}
        description={errorDescription}
        // eslint-disable-next-line tensamin/no-window-location-reload -- Storage initialization must restart before the router can render.
        onRetry={() => window.location.reload()}
        statusLink={false}
      />
    );
  }

  if (!isIndexedDBSupported) {
    return (
      <ErrorScreen
        error="Unsupported browser"
        description="Your browser does not support IndexedDB, which is required for this application to function."
      />
    );
  }

  return (
    <StorageContext.Provider value={value}>
      {props.children}
    </StorageContext.Provider>
  );
}

/**
 * Executes useStorage.
 * @param none This function has no parameters.
 * @returns StorageContextValue.
 */
export function useStorage(): StorageContextValue {
  const context = useContext(StorageContext);
  if (!context) {
    throw new Error("useStorage must be used within a StorageProvider");
  }
  return context;
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { base64ToBytes, bytesToBase64, crypto, raw } from "mtp";
import { useMTP } from "@tensamin/mtp";
import { createPrincipalProofResolver } from "@tensamin/mtp/principalProof";
import { createPrincipalRelaySender } from "@tensamin/mtp/principalRelay";
import { useStorage } from "@tensamin/storage/context";
import { useUser } from "@tensamin/identity/context";
import { createFileService } from "@tensamin/files/service";
import { createFileOutput } from "@tensamin/files/output";
import { fileKeySchema, type FileKey } from "@tensamin/crypto/file";
import { getAppFocused, subscribeAppFocus } from "@tensamin/shared/focus";
import { stringifyExactJson } from "@tensamin/shared/exactJson";

const FilesContext = createContext<
  | {
      start(): void;
      retry(): void;
      service?: ReturnType<typeof createFileService>;
      error?: string;
      busy?: string;
      progress?: Parameters<
        NonNullable<Parameters<typeof createFileService>[0]["onProgress"]>
      >[0];
      revision: number;
      watch(key: FileKey): void;
      transfers: Record<
        string,
        Awaited<ReturnType<ReturnType<typeof createFileService>["manifest"]>>
      >;
      run(
        label: string,
        action: (
          service: ReturnType<typeof createFileService>,
        ) => Promise<unknown>,
        refresh?: boolean,
      ): Promise<void>;
      download(key: FileKey): Promise<void>;
      output?: { filename: string; url?: string; save?: () => Promise<void> };
      discard(): Promise<void>;
    }
  | undefined
>(undefined);

// The app owns transfers so navigating away from Files does not abandon them.
// History is initialized on demand and never blocks unrelated chat startup.
export function FilesProvider({ children }: { children: ReactNode }) {
  const {
    accountKey,
    clientState,
    contextReady,
    client,
    send,
    sendSealedRelay,
    subscribe,
  } = useMTP();
  const { load } = useStorage();
  const { getRelayIota } = useUser();
  const [requested, setRequested] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [runtime, setRuntime] = useState<{
    service: ReturnType<typeof createFileService>;
    controller: AbortController;
  }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [progress, setProgress] =
    useState<
      Parameters<
        NonNullable<Parameters<typeof createFileService>[0]["onProgress"]>
      >[0]
    >();
  const [revision, setRevision] = useState(0);
  const [watched, setWatched] = useState<FileKey[]>([]);
  const [transfers, setTransfers] = useState<
    Record<
      string,
      Awaited<ReturnType<ReturnType<typeof createFileService>["manifest"]>>
    >
  >({});
  const watch = useCallback((key: FileKey) => {
    key = fileKeySchema.parse(key);
    setWatched((current) =>
      current.some(
        (item) => stringifyExactJson(item) === stringifyExactJson(key),
      )
        ? current
        : [...current, key],
    );
  }, []);
  const [output, setOutput] = useState<{
    filename: string;
    url?: string;
    save?: () => Promise<void>;
  }>();
  const ownedOutput = useRef<
    | { value: Awaited<ReturnType<typeof createFileOutput>>; url?: string }
    | undefined
  >(undefined);
  const running = useRef(false);
  const discard = useCallback(async () => {
    const owned = ownedOutput.current;
    ownedOutput.current = undefined;
    setOutput(undefined);
    if (owned?.url) URL.revokeObjectURL(owned.url);
    await owned?.value.abort();
  }, []);
  const principal = clientState?.Scope?.principal;
  const authority = principal?.authority;
  const userId = principal?.user_id;
  const dictionaryFingerprint = clientState?.Scope?.dictionary;
  useEffect(() => {
    setRuntime(undefined);
    setBusy(undefined);
    setProgress(undefined);
    setWatched([]);
    setTransfers({});
    running.current = false;
    if (
      !requested ||
      !contextReady ||
      !accountKey ||
      !authority ||
      !userId ||
      !client
    )
      return;
    const controller = new AbortController();
    const { signal } = controller;
    let keyring: Uint8Array | undefined;
    setError(undefined);
    void (async () => {
      keyring = base64ToBytes(await load("mtp_keyring"));
      signal.throwIfAborted();
      const keys = raw.WasmKeyring.from_bytes(keyring);
      let publicKey: Uint8Array;
      try {
        const bundle = keys.public_key_bundle();
        try {
          publicKey = bundle.to_bytes();
        } finally {
          bundle.free();
        }
      } finally {
        keys.free();
      }
      const account = { authority, user_id: BigInt(userId) };
      const resolve = createPrincipalProofResolver({
        accountKey,
        send,
        signal,
      });
      const identity = await resolve(account);
      signal.throwIfAborted();
      if (
        !identity.publicKeys.some(
          (key) => bytesToBase64(key) === bytesToBase64(publicKey),
        )
      )
        throw new Error("The saved file key is not active for this account");
      const dictionary = client.dictionaryIdentity;
      if (!dictionary || dictionary.fingerprint !== dictionaryFingerprint)
        throw new Error("Authenticated file dictionary is unavailable");
      const service = createFileService({
        accountKey,
        account,
        signal,
        send,
        resolveActive: resolve,
        owner: {
          keyring,
          publicKey,
          keyId: Array.from(crypto.sha256(publicKey), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
        },
        sendRelay: createPrincipalRelaySender({
          owner: { authority, user_id: userId },
          dictionary,
          resolve,
          ownIota: () => getRelayIota(userId),
          send: sendSealedRelay,
          signal,
        }),
        onProgress: (value) => {
          if (!signal.aborted) setProgress(value);
        },
      });
      await service.synchronize();
      signal.throwIfAborted();
      setRuntime({ service, controller });
    })().catch((error) => {
      keyring?.fill(0);
      if (!signal.aborted) setError(String(error));
    });
    return () => {
      controller.abort();
      keyring?.fill(0);
      void discard().catch((error) => setError(String(error)));
    };
  }, [
    requested,
    attempt,
    contextReady,
    accountKey,
    authority,
    userId,
    dictionaryFingerprint,
    client,
    send,
    sendSealedRelay,
    load,
    getRelayIota,
    discard,
  ]);

  useEffect(() => {
    if (!runtime) return;
    let refreshing = false;
    let again = false;
    const wake = () => {
      again = true;
      if (refreshing) return;
      refreshing = true;
      void (async () => {
        do {
          again = false;
          await runtime.service.synchronize();
          runtime.controller.signal.throwIfAborted();
          setRevision((value) => value + 1);
        } while (again);
      })()
        .catch((error) => {
          if (!runtime.controller.signal.aborted) setError(String(error));
        })
        .finally(() => {
          refreshing = false;
        });
    };
    const unsubscribeOffer = subscribe("FileShareOffered", wake);
    const unsubscribeRevoke = subscribe("FileShareRevoked", wake);
    const unfocus = subscribeAppFocus(() => {
      if (getAppFocused()) wake();
    });
    return () => {
      unsubscribeOffer();
      unsubscribeRevoke();
      unfocus();
    };
  }, [runtime, subscribe]);

  useEffect(() => {
    if (!runtime || watched.length === 0) return;
    let disposed = false;
    let pending = false;
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (disposed || pending || !getAppFocused()) return;
      pending = true;
      const key = watched[cursor++ % watched.length];
      const resource = stringifyExactJson(key);
      try {
        const status = await runtime.service.manifest(key);
        if (disposed || runtime.controller.signal.aborted) return;
        setTransfers((current) => ({ ...current, [resource]: status }));
        if (status.state !== "transferring") {
          await runtime.service.synchronize();
          if (disposed || runtime.controller.signal.aborted) return;
          setWatched((current) =>
            current.filter((item) => stringifyExactJson(item) !== resource),
          );
          setRevision((value) => value + 1);
        }
      } catch (error) {
        if (!disposed && !runtime.controller.signal.aborted) {
          setError(String(error));
          setWatched((current) =>
            current.filter((item) => stringifyExactJson(item) !== resource),
          );
        }
      } finally {
        pending = false;
        // The file protocol requires status polling. The app transfer owner
        // caps all watched transfers together at one request per second and
        // pauses while hidden; route components never own polling timers.
        if (!disposed && getAppFocused())
          timer = setTimeout(() => void refresh(), 1000);
      }
    };
    const unfocus = subscribeAppFocus(() => {
      if (timer) clearTimeout(timer);
      if (getAppFocused()) void refresh();
    });
    void refresh();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unfocus();
    };
  }, [runtime, watched]);

  const run = async (
    label: string,
    action: (service: ReturnType<typeof createFileService>) => Promise<unknown>,
    refresh = true,
  ) => {
    if (!runtime || runtime.controller.signal.aborted || running.current)
      return;
    running.current = true;
    setBusy(label);
    setError(undefined);
    setProgress(undefined);
    try {
      await action(runtime.service);
      runtime.controller.signal.throwIfAborted();
      if (refresh) {
        await runtime.service.synchronize();
        runtime.controller.signal.throwIfAborted();
        setRevision((value) => value + 1);
      }
    } catch (error) {
      if (!runtime.controller.signal.aborted) setError(String(error));
    } finally {
      if (!runtime.controller.signal.aborted) {
        running.current = false;
        setBusy(undefined);
        setProgress(undefined);
      }
    }
  };
  const start = useCallback(() => {
    setRequested(true);
  }, []);
  return (
    <FilesContext.Provider
      value={{
        start,
        retry: () => setAttempt((value) => value + 1),
        service: runtime?.service,
        error,
        busy,
        progress,
        revision,
        watch,
        transfers,
        run,
        output,
        discard,
        download: (key) =>
          run("Verifying file for export", async (service) => {
            await discard();
            const staged = await createFileOutput(
              accountKey!,
              runtime!.controller.signal,
            );
            try {
              const metadata = await service.download(key, staged.stage);
              runtime!.controller.signal.throwIfAborted();
              if (staged.kind === "browser") {
                const url = URL.createObjectURL(await staged.file());
                ownedOutput.current = { value: staged, url };
                setOutput({ filename: metadata.filename, url });
              } else {
                ownedOutput.current = { value: staged };
                setOutput({
                  filename: metadata.filename,
                  save: () =>
                    run("Saving verified file", async () => {
                      if (await staged.save(metadata.filename)) await discard();
                    }),
                });
              }
            } catch (error) {
              await staged.abort();
              throw error;
            }
          }),
      }}
    >
      {children}
    </FilesContext.Provider>
  );
}

export function useFiles() {
  const context = useContext(FilesContext);
  if (!context) throw new Error("Files requires FilesProvider");
  return context;
}

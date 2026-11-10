import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  hexToHsl,
  HuePicker,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useTheme,
  notify,
} from "@nonanium/ui";
import { useMTP, createSettingsClient, type UserAsset } from "@tensamin/mtp";
import { useStorage } from "@tensamin/storage/context";
import { base64ToBytes, crypto, MTPProtocolError } from "mtp";
import {
  createContext,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ImageIcon, Loader2, Palette, Shapes } from "lucide-react";
import { useContactJobActions } from "@tensamin/identity/contactJobs";
import {
  useFileAccess,
  parseFileAccessDuration,
  formatFileAccessDuration,
} from "./fileAccess";

const SETTING_NAME = "chat-background";
const CHUNK_SIZE = 8 * 1024 * 1024;
const textEncoder = new TextEncoder();
const ASSET_SALT = textEncoder.encode("tensamin-user-asset-v1");

type Pattern = "checker" | "diagonal" | "dots" | "grid" | "tiles";

export type ChatBackground =
  | { kind: "solid"; color: string }
  | { kind: "pattern"; color: string; pattern: Pattern }
  | {
      kind: "image";
      assetId: string;
      size: number;
      sha256: string;
      mimeType: "image/webp";
    };

type TransferRecord = {
  id: string;
  direction: "upload" | "download";
  contactId: number;
  assetId: string;
  uploadId?: string;
  fileName: string;
  size: number;
  sha256: number[];
  oldAssetId?: string;
  setting?: ChatBackground;
};

type BackgroundContextValue = {
  background(contactId: number): ChatBackground | undefined;
  imageUrl(contactId: number): string | undefined;
  animateImage(contactId: number): boolean;
  preview(contactId: number, value?: ChatBackground, url?: string): void;
  save(contactId: number, value?: ChatBackground, file?: Blob): Promise<void>;
  ensureImage(contactId: number): void;
};

const BackgroundContext = createContext<BackgroundContextValue | null>(null);

function validColor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === "primary" || CSS.supports("color", value))
  );
}

function parseBackground(value: string): ChatBackground | undefined {
  try {
    const parsed = JSON.parse(value) as {
      kind?: string;
      color?: string;
      pattern?: string;
      assetId?: string;
      size?: number;
      sha256?: string;
      mimeType?: string;
    };
    if (parsed.kind === "solid" && validColor(parsed.color))
      return { kind: "solid", color: parsed.color };
    if (parsed.kind === "square-wave" && validColor(parsed.color))
      return { kind: "pattern", color: parsed.color, pattern: "checker" };
    if (
      parsed.kind === "pattern" &&
      validColor(parsed.color) &&
      ["checker", "diagonal", "dots", "grid", "tiles"].includes(
        parsed.pattern ?? "",
      )
    )
      return {
        kind: "pattern",
        color: parsed.color,
        pattern: parsed.pattern as Pattern,
      };
    if (
      parsed.kind === "image" &&
      typeof parsed.assetId === "string" &&
      typeof parsed.size === "number" &&
      typeof parsed.sha256 === "string" &&
      parsed.mimeType === "image/webp"
    )
      return {
        kind: "image",
        assetId: parsed.assetId,
        size: parsed.size,
        sha256: parsed.sha256,
        mimeType: "image/webp",
      };
  } catch {
    return undefined;
  }
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function assetKey(keyring: string) {
  return crypto.deriveEncryptionKey(
    base64ToBytes(keyring),
    ASSET_SALT,
    textEncoder.encode("chat-background"),
  );
}

function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned;
}

function sliderValue(value: number | readonly number[], fallback: number) {
  return typeof value === "number" ? value : (value[0] ?? fallback);
}

function resolvedBackgroundColor(color: string, polarity: "dark" | "light") {
  const base = color === "primary" ? "var(--primary)" : color;
  return `color-mix(in oklab,${base} ${polarity === "dark" ? 52 : 78}%,${polarity === "dark" ? "#050507" : "white"})`;
}

function formatBytes(bytes: number) {
  const sign = bytes < 0 ? "-" : "";
  let value = Math.abs(bytes);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${sign}${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: unit === 0 ? 0 : 2,
  }).format(value)} ${units[unit]}`;
}

function transferDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("tensamin-user-assets", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("transfers", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open asset metadata"));
  });
}

async function transferOperation<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const database = await transferDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction("transfers", mode);
      const request = run(transaction.objectStore("transfers"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("Asset metadata operation failed"));
    });
  } finally {
    database.close();
  }
}

const putTransfer = (record: TransferRecord) =>
  transferOperation("readwrite", (store) => store.put(record));
const deleteTransfer = (id: string) =>
  transferOperation("readwrite", (store) => store.delete(id));
const listTransfers = () =>
  transferOperation<TransferRecord[]>("readonly", (store) => store.getAll());

async function assetDirectory() {
  if (!navigator.storage?.getDirectory) throw new Error("OPFS is unavailable");
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("tensamin-user-assets", { create: true });
}

async function writeOpfs(name: string, blob: Blob) {
  const directory = await assetDirectory();
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function readOpfs(name: string) {
  const directory = await assetDirectory();
  return (await directory.getFileHandle(name)).getFile();
}

async function removeOpfs(name: string) {
  const directory = await assetDirectory();
  await directory.removeEntry(name).catch((error: DOMException) => {
    if (error.name !== "NotFoundError") throw error;
  });
}

function assetMetadata(data: ChatBackground & { kind: "image" }): UserAsset {
  return {
    id: data.assetId,
    size: data.size,
    sha256: new Uint8Array(
      data.sha256.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
    ),
    mimeType: data.mimeType,
    revision: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function isNotFound(error: unknown) {
  return error instanceof MTPProtocolError && error.type === "ErrorNotFound";
}

export function ChatBackgroundsProvider({ children }: { children: ReactNode }) {
  const { send, subscribe, identified } = useMTP();
  const storage = useStorage();
  const { setJob, updateJob } = useContactJobActions();
  const client = useMemo(
    () => createSettingsClient({ send, subscribe, clientState: null }),
    [send, subscribe],
  );
  const [settings, setSettings] = useState<Map<number, ChatBackground>>(
    new Map(),
  );
  const settingsRef = useRef(settings);
  const settingIds = useRef(new Map<number, number>());
  const settingRevisions = useRef(new Map<number, number>());
  const deletedSettingRevisions = useRef(new Map<number, number>());
  const [urls, setUrls] = useState<
    Map<
      number,
      { assetId: string; sha256: string; url: string; animate: boolean }
    >
  >(new Map());
  const [previews, setPreviews] = useState<
    Map<number, { value?: ChatBackground; url?: string }>
  >(new Map());
  const downloads = useRef(new Map<number, AbortController>());
  const uploads = useRef(new Map<number, AbortController>());
  const uploadRef = useRef<(record: TransferRecord) => void>(() => undefined);
  const ensureImageRef = useRef<(contactId: number) => void>(() => undefined);
  const missingAssets = useRef(new Set<string>());
  const previewUrls = useRef(new Map<number, string>());

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const applySetting = useCallback(
    (
      target: string,
      payload?: string,
      settingId?: number,
      revision = 0,
      force = false,
    ) => {
      const contactId = Number(target);
      if (!Number.isSafeInteger(contactId) || contactId <= 0) return;
      if (!force && (settingRevisions.current.get(contactId) ?? -1) >= revision)
        return;
      if (
        settingId !== undefined &&
        (deletedSettingRevisions.current.get(settingId) ?? -1) >= revision
      )
        return;
      settingRevisions.current.set(contactId, revision);
      downloads.current.get(contactId)?.abort();
      downloads.current.delete(contactId);
      const previous = settingsRef.current.get(contactId);
      const next = new Map(settingsRef.current);
      const value =
        payload === undefined ? undefined : parseBackground(payload);
      if (value) next.set(contactId, value);
      else next.delete(contactId);
      settingsRef.current = next;
      setSettings(next);
      if (previous?.kind === "image" && value?.kind !== "image")
        void removeOpfs(`download-${previous.assetId}`);
      if (value?.kind !== "image")
        setUrls((current) => {
          const old = current.get(contactId)?.url;
          if (old) URL.revokeObjectURL(old);
          const next = new Map(current);
          next.delete(contactId);
          return next;
        });
      if (settingId !== undefined) settingIds.current.set(settingId, contactId);
    },
    [],
  );

  useEffect(() => {
    if (!identified) return;
    settingIds.current.clear();
    settingRevisions.current.clear();
    deletedSettingRevisions.current.clear();
    settingsRef.current = new Map();
    setSettings(new Map());
    setUrls((current) => {
      for (const { url } of current.values()) URL.revokeObjectURL(url);
      return new Map();
    });
    const unsubscribe = client.subscribeSettingChanges((event) => {
      if ("deletedIds" in event) {
        for (const id of event.deletedIds) {
          deletedSettingRevisions.current.set(id, event.revision);
          const contactId = settingIds.current.get(id);
          if (contactId)
            applySetting(
              String(contactId),
              undefined,
              undefined,
              event.revision,
            );
          settingIds.current.delete(id);
        }
        return;
      }
      if (event.scope !== "contact" || event.name !== SETTING_NAME) return;
      applySetting(event.target, event.payload, event.id, event.revision);
    });
    void client.listSettings().then((values) => {
      for (const setting of values) {
        if (setting.scope !== "contact" || setting.name !== SETTING_NAME)
          continue;
        applySetting(
          setting.target,
          setting.payload,
          setting.id,
          setting.revision,
        );
      }
    });
    return unsubscribe;
  }, [applySetting, client, identified]);

  const upload = useCallback(
    async (record: TransferRecord) => {
      if (!record.uploadId || record.setting?.kind !== "image") return;
      const setting = record.setting;
      const controller = new AbortController();
      uploads.current.get(record.contactId)?.abort();
      uploads.current.set(record.contactId, controller);
      const operationId = record.uploadId;
      setJob({
        contactId: record.contactId,
        operationId,
        label: "Uploading chat background",
        state: "running",
        progress: 0,
        priority: 100,
        cancel: () => controller.abort(),
      });
      try {
        const file = await readOpfs(record.fileName);
        let status = await client.startAssetUpload(record.uploadId, {
          id: record.assetId,
          size: record.size,
          sha256: new Uint8Array(record.sha256),
          mimeType: "application/octet-stream",
        });
        while (status.Offset < record.size) {
          if (controller.signal.aborted)
            throw new DOMException("Upload cancelled", "AbortError");
          const end = Math.min(status.Offset + CHUNK_SIZE, record.size);
          status = await client.uploadAssetChunk(
            record.uploadId,
            status.Offset,
            new Uint8Array(await file.slice(status.Offset, end).arrayBuffer()),
          );
          updateJob(record.contactId, operationId, {
            progress: status.Offset / record.size,
          });
        }
        await client.commitAssetUpload(record.uploadId);
        await writeOpfs(`download-${record.assetId}`, file);
        const savedSetting = await client.setSetting({
          scope: "contact",
          target: String(record.contactId),
          name: SETTING_NAME,
          payload: JSON.stringify(setting),
        });
        applySetting(
          String(record.contactId),
          JSON.stringify(setting),
          savedSetting.id,
          savedSetting.revision,
        );
        const previewUrl = previewUrls.current.get(record.contactId);
        if (previewUrl) {
          previewUrls.current.delete(record.contactId);
          setPreviews((current) => {
            const next = new Map(current);
            next.delete(record.contactId);
            return next;
          });
          setUrls((current) =>
            new Map(current).set(record.contactId, {
              assetId: record.assetId,
              sha256: setting.sha256,
              url: previewUrl,
              animate: false,
            }),
          );
        }
        if (record.oldAssetId && record.oldAssetId !== record.assetId) {
          await client.deleteAsset(record.oldAssetId).catch((error) => {
            if (!isNotFound(error)) throw error;
          });
          await removeOpfs(`download-${record.oldAssetId}`);
        }
        await Promise.all([
          deleteTransfer(record.id),
          removeOpfs(record.fileName),
        ]);
        updateJob(record.contactId, operationId, { state: "success" });
      } catch (caught) {
        if (controller.signal.aborted) {
          await client.abortAssetUpload(record.uploadId).catch(() => undefined);
          await Promise.all([
            deleteTransfer(record.id),
            removeOpfs(record.fileName),
            removeOpfs(`download-${record.assetId}`),
          ]);
          updateJob(record.contactId, operationId, { state: "success" });
          return;
        }
        const error = caught instanceof Error ? caught.message : String(caught);
        updateJob(record.contactId, operationId, {
          state: "failed",
          error,
          cancel: undefined,
          retry: () => uploadRef.current(record),
        });
      } finally {
        if (uploads.current.get(record.contactId) === controller)
          uploads.current.delete(record.contactId);
      }
    },
    [applySetting, client, setJob, updateJob],
  );

  useEffect(() => {
    uploadRef.current = (record) => void upload(record);
  }, [upload]);

  useEffect(() => {
    if (!identified) return;
    void listTransfers()
      .then((records) => {
        for (const record of records.filter(
          (item) => item.direction === "upload",
        ))
          void upload(record);
      })
      .catch((error) => {
        setJob({
          contactId: 0,
          operationId: "asset-resume",
          label: "Resume background transfers",
          state: "failed",
          progress: 0,
          priority: 100,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [identified, setJob, upload]);

  const ensureImage = useCallback(
    (contactId: number) => {
      const value = settingsRef.current.get(contactId);
      if (
        value?.kind !== "image" ||
        missingAssets.current.has(value.assetId) ||
        (urls.get(contactId)?.assetId === value.assetId &&
          urls.get(contactId)?.sha256 === value.sha256) ||
        downloads.current.has(contactId)
      )
        return;
      const controller = new AbortController();
      downloads.current.set(contactId, controller);
      const operationId = `download:${value.assetId}`;
      const cancel = () => controller.abort();
      setJob({
        contactId,
        operationId,
        label: "Downloading chat background",
        state: "running",
        progress: 0,
        priority: 80,
        cancel,
      });
      void (async () => {
        const record: TransferRecord = {
          id: operationId,
          direction: "download",
          contactId,
          assetId: value.assetId,
          fileName: `download-${value.assetId}`,
          size: value.size,
          sha256: Array.from(assetMetadata(value).sha256),
        };
        try {
          await putTransfer(record);
          const directory = await assetDirectory();
          const handle = await directory.getFileHandle(record.fileName, {
            create: true,
          });
          const existing = await handle.getFile();
          let offset = Math.min(existing.size, value.size);
          const downloaded = offset < value.size;
          const writable = await handle.createWritable({
            keepExistingData: true,
          });
          try {
            while (offset < value.size) {
              if (controller.signal.aborted)
                throw new DOMException("Download cancelled", "AbortError");
              const response = await client.getAssetChunk(
                value.assetId,
                offset,
                Math.min(CHUNK_SIZE, value.size - offset),
              );
              if (response.Blob.byteLength === 0)
                throw new Error("Background download ended unexpectedly");
              await writable.write({
                type: "write",
                position: offset,
                data: ownedBytes(response.Blob),
              });
              offset += response.Blob.byteLength;
              updateJob(contactId, operationId, {
                progress: offset / value.size,
              });
            }
            await writable.truncate(value.size);
          } finally {
            await writable.close();
          }
          const encrypted = new Uint8Array(
            await (await handle.getFile()).arrayBuffer(),
          );
          const actualHash = new Uint8Array(
            await globalThis.crypto.subtle.digest(
              "SHA-256",
              ownedBytes(encrypted),
            ),
          );
          if (bytesToHex(actualHash) !== value.sha256)
            throw new Error("Downloaded background failed SHA-256 validation");
          const keyring = await storage.load("mtp_keyring");
          const key = assetKey(keyring);
          let decoded: Uint8Array;
          try {
            decoded = await crypto.decrypt(key, encrypted);
          } finally {
            key.fill(0);
          }
          const url = URL.createObjectURL(
            new Blob([ownedBytes(decoded)], { type: "image/webp" }),
          );
          setUrls((current) => {
            const previous = current.get(contactId);
            if (previous?.url && previous.url !== url)
              URL.revokeObjectURL(previous.url);
            if (previous?.assetId && previous.assetId !== value.assetId)
              void removeOpfs(`download-${previous.assetId}`);
            return new Map(current).set(contactId, {
              assetId: value.assetId,
              sha256: value.sha256,
              url,
              animate: downloaded,
            });
          });
          if (downloaded)
            window.setTimeout(
              () =>
                setUrls((current) => {
                  const entry = current.get(contactId);
                  if (entry?.url !== url || !entry.animate) return current;
                  return new Map(current).set(contactId, {
                    ...entry,
                    animate: false,
                  });
                }),
              600,
            );
          await deleteTransfer(record.id);
          updateJob(contactId, operationId, { state: "success" });
        } catch (caught) {
          if (controller.signal.aborted) {
            await Promise.all([
              deleteTransfer(record.id),
              removeOpfs(record.fileName),
            ]);
            updateJob(contactId, operationId, { state: "success" });
          } else if (isNotFound(caught)) {
            missingAssets.current.add(value.assetId);
            await Promise.all([
              deleteTransfer(record.id),
              removeOpfs(record.fileName),
            ]);
            updateJob(contactId, operationId, { state: "success" });
          } else {
            updateJob(contactId, operationId, {
              state: "failed",
              error: caught instanceof Error ? caught.message : String(caught),
              cancel: undefined,
              retry: () => ensureImageRef.current(contactId),
            });
          }
        } finally {
          if (downloads.current.get(contactId) === controller)
            downloads.current.delete(contactId);
        }
      })();
    },
    [client, setJob, storage, updateJob, urls],
  );

  useEffect(() => {
    ensureImageRef.current = ensureImage;
  }, [ensureImage]);

  const preview = useCallback(
    (contactId: number, value?: ChatBackground, url?: string) => {
      const oldUrl = previewUrls.current.get(contactId);
      if (oldUrl && oldUrl !== url) URL.revokeObjectURL(oldUrl);
      if (url) previewUrls.current.set(contactId, url);
      else previewUrls.current.delete(contactId);
      setPreviews((current) => {
        const next = new Map(current);
        if (value || url) next.set(contactId, { value, url });
        else next.delete(contactId);
        return next;
      });
    },
    [],
  );

  const save = useCallback(
    async (contactId: number, value?: ChatBackground, file?: Blob) => {
      const old = settingsRef.current.get(contactId);
      uploads.current.get(contactId)?.abort();
      const olderTransfers = (await listTransfers()).filter(
        (record) =>
          record.direction === "upload" && record.contactId === contactId,
      );
      for (const record of olderTransfers) {
        if (record.uploadId)
          await client.abortAssetUpload(record.uploadId).catch(() => undefined);
        await Promise.all([
          deleteTransfer(record.id),
          removeOpfs(record.fileName),
        ]);
        updateJob(contactId, record.uploadId ?? record.id, {
          state: "success",
        });
      }
      setPreviews((current) => {
        const next = new Map(current);
        next.delete(contactId);
        return next;
      });
      if (value?.kind === "image") {
        if (!file) throw new Error("Processed background is missing");
        const keyring = await storage.load("mtp_keyring");
        const key = assetKey(keyring);
        let encrypted: Uint8Array;
        try {
          encrypted = await crypto.encrypt(
            key,
            new Uint8Array(await file.arrayBuffer()),
          );
        } finally {
          key.fill(0);
        }
        const hash = new Uint8Array(
          await globalThis.crypto.subtle.digest(
            "SHA-256",
            ownedBytes(encrypted),
          ),
        );
        const uploadId = globalThis.crypto.randomUUID();
        const assetId = globalThis.crypto.randomUUID();
        const setting: ChatBackground = {
          kind: "image",
          assetId,
          size: encrypted.byteLength,
          sha256: bytesToHex(hash),
          mimeType: "image/webp",
        };
        const record: TransferRecord = {
          id: `upload:${uploadId}`,
          direction: "upload",
          contactId,
          assetId,
          uploadId,
          fileName: `upload-${uploadId}`,
          size: encrypted.byteLength,
          sha256: Array.from(hash),
          oldAssetId: old?.kind === "image" ? old.assetId : undefined,
          setting,
        };
        await writeOpfs(record.fileName, new Blob([ownedBytes(encrypted)]));
        await putTransfer(record);
        void upload(record);
        return;
      }
      if (value) {
        const savedSetting = await client.setSetting({
          scope: "contact",
          target: String(contactId),
          name: SETTING_NAME,
          payload: JSON.stringify(value),
        });
        applySetting(
          String(contactId),
          JSON.stringify(value),
          savedSetting.id,
          savedSetting.revision,
        );
      } else {
        const deleted = await client.deleteSetting(
          "contact",
          String(contactId),
          SETTING_NAME,
        );
        if (deleted.SettingId !== undefined)
          settingIds.current.delete(deleted.SettingId);
        applySetting(
          String(contactId),
          undefined,
          undefined,
          deleted.VersionNumber ?? settingRevisions.current.get(contactId) ?? 0,
          true,
        );
      }
      if (old?.kind === "image") {
        await client.deleteAsset(old.assetId).catch((error) => {
          if (!isNotFound(error)) throw error;
        });
        await removeOpfs(`download-${old.assetId}`);
      }
    },
    [applySetting, client, storage, updateJob, upload],
  );

  const value = useMemo<BackgroundContextValue>(
    () => ({
      background: (contactId) =>
        previews.get(contactId)?.value ?? settings.get(contactId),
      imageUrl: (contactId) =>
        previews.get(contactId)?.url ?? urls.get(contactId)?.url,
      animateImage: (contactId) =>
        previews.has(contactId)
          ? false
          : (urls.get(contactId)?.animate ?? false),
      preview,
      save,
      ensureImage,
    }),
    [ensureImage, preview, previews, save, settings, urls],
  );

  return (
    <BackgroundContext.Provider value={value}>
      {children}
    </BackgroundContext.Provider>
  );
}

export function useChatBackground(contactId: number) {
  const context = useContext(BackgroundContext);
  if (!context)
    throw new Error("useChatBackground requires ChatBackgroundsProvider");
  const background = context.background(contactId);
  useEffect(() => {
    context.ensureImage(contactId);
  }, [contactId, context, background]);
  return {
    background,
    imageUrl: context.imageUrl(contactId),
    animateImage: context.animateImage(contactId),
    preview: context.preview,
    save: context.save,
  };
}

function pickerColor(hue: number) {
  return `hsl(${hue} 78% 50%)`;
}

function colorHue(color: string) {
  const match = color.match(/^hsl\(\s*(-?\d+(?:\.\d+)?)/i);
  return match ? ((Number(match[1]) % 360) + 360) % 360 : hexToHsl(color).h;
}

async function encodeWebp(
  file: File,
  maxDimension: number | null,
  compression: number,
) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("Choose a PNG, JPEG, or WebP image");
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("Image could not be decoded");
  });
  const scale = maxDimension
    ? Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
    : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("WebP encoding failed")),
      "image/webp",
      1 - compression / 100,
    ),
  );
}

export function chatBackgroundStyle(
  value?: ChatBackground,
  imageUrl?: string,
  polarity: "dark" | "light" = "light",
): CSSProperties {
  const color =
    value && "color" in value
      ? resolvedBackgroundColor(value.color, polarity)
      : undefined;
  if (value?.kind === "solid") return { background: color };
  if (value?.kind === "pattern") {
    const patterns: Record<Pattern, CSSProperties> = {
      checker: {
        backgroundImage:
          "linear-gradient(45deg,color-mix(in srgb,var(--foreground) 14%,transparent) 25%,transparent 25%,transparent 75%,color-mix(in srgb,var(--foreground) 14%,transparent) 75%),linear-gradient(45deg,color-mix(in srgb,var(--foreground) 14%,transparent) 25%,transparent 25%,transparent 75%,color-mix(in srgb,var(--foreground) 14%,transparent) 75%)",
        backgroundPosition: "0 0, 18px 18px",
        backgroundSize: "36px 36px",
      },
      diagonal: {
        backgroundImage:
          "repeating-linear-gradient(135deg,transparent 0 14px,color-mix(in srgb,var(--foreground) 15%,transparent) 14px 22px,transparent 22px 38px)",
      },
      dots: {
        backgroundImage:
          "radial-gradient(circle,color-mix(in srgb,var(--foreground) 22%,transparent) 2px,transparent 2.5px)",
        backgroundSize: "22px 22px",
      },
      grid: {
        backgroundImage:
          "linear-gradient(color-mix(in srgb,var(--foreground) 14%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--foreground) 14%,transparent) 1px,transparent 1px)",
        backgroundSize: "28px 28px",
      },
      tiles: {
        backgroundImage:
          "linear-gradient(30deg,color-mix(in srgb,var(--foreground) 14%,transparent) 12%,transparent 12.5%,transparent 87%,color-mix(in srgb,var(--foreground) 14%,transparent) 87.5%),linear-gradient(150deg,color-mix(in srgb,var(--foreground) 14%,transparent) 12%,transparent 12.5%,transparent 87%,color-mix(in srgb,var(--foreground) 14%,transparent) 87.5%)",
        backgroundSize: "42px 72px",
      },
    };
    return { backgroundColor: color, ...patterns[value.pattern] };
  }
  if (value?.kind === "image" && imageUrl)
    return {
      backgroundImage: `${polarity === "dark" ? "linear-gradient(rgb(0 0 0/.28),rgb(0 0 0/.28))," : ""}url(${JSON.stringify(imageUrl)})`,
      backgroundSize: "cover",
      backgroundPosition: "center",
    };
  return {};
}

export function ChatBackgroundDialog({
  contactId,
  open,
  onOpenChange,
}: {
  contactId: number;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { resolvedPolarity } = useTheme();
  const { background, preview, save } = useChatBackground(contactId);
  const access = useFileAccess(contactId, open);
  const [durationDraft, setDurationDraft] = useState<string>();
  const durationText =
    durationDraft ??
    (access.days === undefined ? "" : formatFileAccessDuration(access.days));
  const durationDays = parseFileAccessDuration(durationText);
  const [saving, setSaving] = useState(false);
  const [kind, setKind] = useState<"solid" | "pattern" | "image">(
    background?.kind ?? "solid",
  );
  const [colorChoice, setColorChoice] = useState(
    background && "color" in background ? background.color : "primary",
  );
  const [pattern, setPattern] = useState<Pattern>(
    background?.kind === "pattern" ? background.pattern : "dots",
  );
  const [hue, setHue] = useState(210);
  const [customColorOverride, setCustomColorOverride] = useState<string>();
  const [file, setFile] = useState<File>();
  const [encoded, setEncoded] = useState<Blob>();
  const [resize, setResize] = useState("original");
  const [compression, setCompression] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    if (error) notify("error", "Couldn't customise chat", error);
  }, [error]);
  const [processing, setProcessing] = useState(false);
  const wasOpen = useRef(false);
  const customColor = pickerColor(hue);
  const selectedCustomColor = customColorOverride ?? customColor;
  const color = colorChoice === "custom" ? selectedCustomColor : colorChoice;

  useEffect(() => {
    if (open && !wasOpen.current) {
      setKind(background?.kind ?? "solid");
      setDurationDraft(undefined);
      setPattern(background?.kind === "pattern" ? background.pattern : "dots");
      const savedColor =
        background && "color" in background ? background.color : "primary";
      const presetColors = [
        "primary",
        "#1f6f78",
        "#315c9b",
        "#9b4d3a",
        "#4f6b3a",
        "#5e526f",
      ];
      setColorChoice(presetColors.includes(savedColor) ? savedColor : "custom");
      if (!presetColors.includes(savedColor)) setHue(colorHue(savedColor));
      setCustomColorOverride(
        presetColors.includes(savedColor) ? undefined : savedColor,
      );
      setFile(undefined);
      setEncoded(undefined);
      setError("");
      setProcessing(false);
      setResize("original");
      setCompression(0);
    }
    wasOpen.current = open;
  }, [background, open]);

  useEffect(() => {
    if (!open || kind === "image") return;
    preview(
      contactId,
      kind === "pattern" ? { kind, color, pattern } : { kind, color },
    );
  }, [color, contactId, kind, open, pattern, preview]);

  useEffect(() => {
    if (!open || kind !== "image" || !file) return;
    let active = true;
    setProcessing(true);
    setError("");
    const dimension =
      { original: null, "1080p": 1920, "1440p": 2560, "4k": 3840 }[resize] ??
      null;
    void encodeWebp(file, dimension, compression)
      .then((blob) => {
        if (!active) return;
        setEncoded(blob);
        const url = URL.createObjectURL(blob);
        preview(
          contactId,
          {
            kind: "image",
            assetId: "preview",
            size: blob.size,
            sha256: "",
            mimeType: "image/webp",
          },
          url,
        );
      })
      .catch(
        (caught) =>
          active &&
          setError(caught instanceof Error ? caught.message : String(caught)),
      )
      .finally(() => active && setProcessing(false));
    return () => {
      active = false;
      setProcessing(false);
    };
  }, [compression, contactId, file, kind, open, preview, resize]);

  function close(next: boolean) {
    if (!next) preview(contactId);
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl!">
        <DialogHeader>
          <DialogTitle>Customise chat</DialogTitle>
        </DialogHeader>
        <Tabs
          value={kind}
          onValueChange={(value) =>
            setKind(value as "solid" | "pattern" | "image")
          }
        >
          <TabsList className="w-full">
            <TabsTrigger value="solid">
              <Palette className="size-4" />
              Solid
            </TabsTrigger>
            <TabsTrigger value="pattern">
              <Shapes className="size-4" />
              Pattern
            </TabsTrigger>
            <TabsTrigger value="image">
              <ImageIcon className="size-4" />
              Image
            </TabsTrigger>
          </TabsList>
          {kind !== "image" ? (
            <div className="flex flex-col gap-3" role="tabpanel">
              {kind === "pattern" && (
                <Select
                  value={pattern}
                  onValueChange={(value) =>
                    setPattern((value ?? "dots") as Pattern)
                  }
                >
                  <SelectTrigger className="w-40">
                    <SelectValue>
                      {pattern === "diagonal"
                        ? "Diagonal stripes"
                        : pattern[0]?.toUpperCase() + pattern.slice(1)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dots">Dots</SelectItem>
                    <SelectItem value="grid">Grid</SelectItem>
                    <SelectItem value="diagonal">Diagonal stripes</SelectItem>
                    <SelectItem value="checker">Checker</SelectItem>
                    <SelectItem value="tiles">Tiles</SelectItem>
                  </SelectContent>
                </Select>
              )}
              <div className="flex items-center justify-center gap-4">
                <div
                  className="grid shrink-0 grid-cols-2 gap-2"
                  aria-label="Background color"
                >
                  {[
                    ["primary", "Live primary color", "var(--primary)"],
                    ["#1f6f78", "Teal", "#1f6f78"],
                    ["#315c9b", "Blue", "#315c9b"],
                    ["#9b4d3a", "Terracotta", "#9b4d3a"],
                    ["#4f6b3a", "Olive", "#4f6b3a"],
                    ["#5e526f", "Slate violet", "#5e526f"],
                  ].map(([value, label, swatch]) => (
                    <Tooltip key={value}>
                      <TooltipTrigger
                        render={
                          <button
                            aria-label={label}
                            aria-pressed={colorChoice === value}
                            className="size-8 rounded-full border-2 border-background transition-transform hover:scale-110 motion-reduce:transition-none"
                            onClick={() => setColorChoice(value)}
                            style={{
                              background: resolvedBackgroundColor(
                                swatch,
                                resolvedPolarity,
                              ),
                              boxShadow:
                                colorChoice === value
                                  ? "0 0 0 2px var(--ring)"
                                  : undefined,
                            }}
                            type="button"
                          />
                        }
                      />
                      <TooltipContent>{label}</TooltipContent>
                    </Tooltip>
                  ))}
                </div>
                <HuePicker
                  aria-label="Custom background hue"
                  className="w-full max-w-80"
                  color={resolvedBackgroundColor(
                    selectedCustomColor,
                    resolvedPolarity,
                  )}
                  value={hue}
                  onValueChange={(value) => {
                    setCustomColorOverride(undefined);
                    setColorChoice("custom");
                    setHue(value);
                  }}
                  style={
                    colorChoice === "custom"
                      ? { boxShadow: "0 0 0 2px var(--ring)" }
                      : undefined
                  }
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2" role="tabpanel">
              <Input
                id="chat-background-file"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => setFile(event.currentTarget.files?.[0])}
              />
              <div className="flex w-full gap-2">
                <Select
                  value={resize}
                  onValueChange={(value) => setResize(value ?? "original")}
                >
                  <SelectTrigger aria-label="Resize">
                    <SelectValue>
                      {resize === "original"
                        ? "Original"
                        : resize === "4k"
                          ? "4K"
                          : resize}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {["original", "1080p", "1440p", "4k"].map((value) => (
                      <SelectItem key={value} value={value}>
                        {value === "original"
                          ? "Original"
                          : value === "4k"
                            ? "4K"
                            : value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex flex-col gap-2 w-full">
                  <Label>Compression</Label>
                  <Slider
                    aria-label="Compression"
                    min={0}
                    max={95}
                    value={[compression]}
                    onValueChange={(value) =>
                      setCompression(sliderValue(value, 0))
                    }
                  />
                </div>
              </div>
              {file && encoded && (
                <p className="text-sm text-muted-foreground">
                  Original {formatBytes(file.size)}. Encoded{" "}
                  {formatBytes(encoded.size)}. Savings{" "}
                  {formatBytes(file.size - encoded.size)}.
                </p>
              )}
              {processing && (
                <p className="flex items-center gap-2 text-sm">
                  <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                  Encoding image
                </p>
              )}
            </div>
          )}
        </Tabs>
        <div className="flex flex-col gap-2">
          <Label htmlFor="default-file-access">
            Default file access expiry
          </Label>
          <Input
            id="default-file-access"
            value={durationText}
            placeholder="1 year"
            aria-invalid={
              durationDraft !== undefined && durationDays === undefined
            }
            disabled={access.days === undefined || saving}
            onChange={(event) => setDurationDraft(event.target.value)}
          />
        </div>
        <DialogFooter className="flex flex-row! justify-between">
          <Button
            variant="destructive"
            disabled={saving || access.saving}
            onClick={async () => {
              setSaving(true);
              try {
                if (!(await access.save(365))) return;
                await save(contactId);
                close(false);
              } catch (caught) {
                setError(
                  caught instanceof Error ? caught.message : String(caught),
                );
              } finally {
                setSaving(false);
              }
            }}
          >
            Reset
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => close(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                saving ||
                access.saving ||
                access.days === undefined ||
                durationDays === undefined ||
                processing ||
                (kind === "image" && !encoded)
              }
              onClick={async () => {
                const value: ChatBackground =
                  kind === "image"
                    ? {
                        kind: "image",
                        assetId: "pending",
                        size: encoded?.size ?? 0,
                        sha256: "",
                        mimeType: "image/webp",
                      }
                    : kind === "pattern"
                      ? { kind, color, pattern }
                      : { kind, color };
                try {
                  if (durationDays === undefined) return;
                  setSaving(true);
                  if (!(await access.save(durationDays))) return;
                  await save(contactId, value, encoded);
                  close(false);
                } catch (caught) {
                  setError(
                    caught instanceof Error ? caught.message : String(caught),
                  );
                } finally {
                  setSaving(false);
                }
              }}
            >
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

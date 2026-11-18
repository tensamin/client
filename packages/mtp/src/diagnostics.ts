import { invoke, isTauri } from "@tauri-apps/api/core";
import { onUsageDiagnosticsCheckpoint, usageDiagnostics } from "mtp";
import {
  getDatabaseEntry,
  openTensaminDatabase,
} from "@tensamin/shared/indexedDb";

const historyKey = "local:usage-diagnostics:v1";
const retentionMs = 24 * 60 * 60 * 1000;
const maxHistoryBytes = 1536 * 1024;

type History = {
  schema_version: number;
  cleared_at?: number;
  settings_at?: number;
  enabled: boolean;
  mtp_version: string;
  storage_available?: boolean;
  events?: Array<{
    timestamp_unix_ms: number;
    process_started_unix_ms: number;
    elapsed_ms: number;
    sequence: number;
    name: string;
    value: number;
  }>;
  buckets: Array<{
    timestamp_unix_ms: number;
    process_started_unix_ms: number;
    elapsed_ms: number;
    metrics: Record<string, { count: number; total: number; max: number }>;
  }>;
};

declare const __TENSAMIN_BUILD__: {
  app_version: string;
  channel: string;
  client_revision: string;
  mtp_revision: string;
};

let initialization: Promise<void> | undefined;
let lastCheckpoint = 0;
let clearedAt = 0;
let settingsAt = 0;
let storageAvailable = true;
let operation = Promise.resolve();
let channel: BroadcastChannel | undefined;

async function native(action: string, argument?: string, value?: number) {
  return invoke<Record<string, unknown>>("usage_diagnostics", {
    action,
    argument,
    value,
  });
}

function persist(history: History) {
  return openTensaminDatabase().then(
    (database) =>
      new Promise<History>((resolve, reject) => {
        const transaction = database.transaction("storage", "readwrite");
        const store = transaction.objectStore("storage");
        const request = store.get(historyKey);
        request.onsuccess = () => {
          const previous = request.result as History | undefined;
          if ((previous?.cleared_at ?? 0) > clearedAt) {
            clearedAt = previous!.cleared_at!;
            history.buckets = history.buckets.filter(
              (bucket) => bucket.timestamp_unix_ms > clearedAt,
            );
            void usageDiagnostics("clear").catch(() => {
              storageAvailable = false;
            });
          }
          if ((previous?.settings_at ?? 0) > settingsAt) {
            settingsAt = previous!.settings_at!;
            history.enabled = previous!.enabled;
            void usageDiagnostics("enabled", String(history.enabled)).catch(
              () => {
                storageAvailable = false;
              },
            );
          }
          history.cleared_at = clearedAt;
          history.settings_at = settingsAt;
          history.storage_available = true;
          const now = Date.now();
          const buckets = new Map<string, History["buckets"][number]>();
          for (const bucket of [
            ...(previous?.buckets ?? []),
            ...history.buckets,
          ]) {
            if (
              bucket.timestamp_unix_ms > clearedAt &&
              bucket.timestamp_unix_ms <= now &&
              now - bucket.timestamp_unix_ms < retentionMs
            ) {
              buckets.set(
                `${bucket.process_started_unix_ms}:${Math.floor(bucket.elapsed_ms / 60_000)}`,
                bucket,
              );
            }
          }
          const events = new Map<
            string,
            NonNullable<History["events"]>[number]
          >();
          for (const event of [
            ...(previous?.events ?? []),
            ...(history.events ?? []),
          ]) {
            if (
              event.timestamp_unix_ms > clearedAt &&
              event.timestamp_unix_ms <= now &&
              now - event.timestamp_unix_ms < retentionMs
            ) {
              events.set(
                `${event.process_started_unix_ms}:${event.sequence}`,
                event,
              );
            }
          }
          history.events = [...events.values()]
            .sort((a, b) => a.timestamp_unix_ms - b.timestamp_unix_ms)
            .slice(-1024);
          history.buckets = [...buckets.values()]
            .sort((a, b) => a.timestamp_unix_ms - b.timestamp_unix_ms)
            .slice(-1440);
          while (
            new TextEncoder().encode(JSON.stringify(history)).length >
            maxHistoryBytes
          ) {
            if (history.buckets.length) history.buckets.shift();
            else if (history.events.length) history.events.shift();
            else break;
          }
          store.put(history, historyKey);
        };
        transaction.oncomplete = () => resolve(history);
        transaction.onerror = transaction.onabort = () =>
          reject(new Error("Diagnostic storage unavailable"));
      }),
  );
}

async function checkpoint() {
  if (isTauri()) return;
  const desktop = window.tensaminDesktop?.app;
  if (desktop?.getDiagnostics) {
    const device = await desktop.getDiagnostics();
    const processes = device.app_processes as Array<{
      cpu: { cumulativeCPUUsage: number };
      memory: { workingSetSize: number };
    }>;
    await usageDiagnostics(
      "event",
      "app_cpu_total_ms",
      Math.round(
        processes.reduce(
          (total, process) => total + process.cpu.cumulativeCPUUsage,
          0,
        ) * 1000,
      ),
    );
    await usageDiagnostics(
      "event",
      "app_memory_bytes",
      processes.reduce(
        (total, process) => total + process.memory.workingSetSize,
        0,
      ) * 1024,
    );
  }
  const history = JSON.parse(await usageDiagnostics("snapshot")) as History;
  const merged = await persist(history);
  storageAvailable = true;
  return merged;
}

function enqueue<T>(task: () => Promise<T>) {
  const pending = operation.then(task);
  operation = pending.then(
    () => {},
    () => {
      storageAvailable = false;
    },
  );
  return pending;
}

function scheduleCheckpoint() {
  if (Date.now() - lastCheckpoint < 60_000) return;
  lastCheckpoint = Date.now();
  void enqueue(checkpoint).catch(() => {
    storageAvailable = false;
  });
}

export function diagnosticEvent(event: string, value = 1) {
  // The Rust bridge accepts only a fixed list of event names, never raw messages or errors.
  void startDiagnostics()
    .then(() =>
      enqueue(async () => {
        if (isTauri()) await native("event", event, value);
        else await usageDiagnostics("event", event, value);
        scheduleCheckpoint();
      }),
    )
    .catch(() => {
      storageAvailable = false;
    });
}

export function startDiagnostics(): Promise<void> {
  initialization ??= (async () => {
    if (!isTauri()) {
      try {
        const previous = await getDatabaseEntry<History>("storage", historyKey);
        if (previous) {
          clearedAt = previous.cleared_at ?? 0;
          settingsAt = previous.settings_at ?? 0;
          await usageDiagnostics("restore", JSON.stringify(previous));
        }
      } catch {
        storageAvailable = false;
      }
      await onUsageDiagnosticsCheckpoint(scheduleCheckpoint);
    }
    const visibility = () => {
      diagnosticEvent(document.hidden ? "background" : "foreground");
      if (document.hidden)
        void enqueue(checkpoint).catch(() => {
          storageAvailable = false;
        });
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", () => diagnosticEvent("online"));
    window.addEventListener("offline", () => diagnosticEvent("offline"));
    window.addEventListener("pagehide", () => {
      void enqueue(checkpoint).catch(() => {
        storageAvailable = false;
      });
    });
    if (!isTauri() && typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel("tensamin-usage-diagnostics");
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data !== "changed") return;
        void enqueue(async () => {
          const saved = await getDatabaseEntry<History>("storage", historyKey);
          if (!saved) return;
          if ((saved.cleared_at ?? 0) > clearedAt) {
            clearedAt = saved.cleared_at!;
            await usageDiagnostics("clear");
          }
          if ((saved.settings_at ?? 0) > settingsAt) {
            settingsAt = saved.settings_at!;
            await usageDiagnostics("enabled", String(saved.enabled));
          }
        }).catch(() => {
          storageAvailable = false;
        });
      };
    }
    queueMicrotask(() =>
      diagnosticEvent(document.hidden ? "background" : "foreground"),
    );
    if (
      typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes.includes("longtask")
    ) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          diagnosticEvent("long_task_ms", Math.round(entry.duration));
      }).observe({ type: "longtask", buffered: false });
    }
  })().catch(() => {
    storageAvailable = false;
  });
  return initialization;
}

export async function diagnosticSnapshot() {
  await startDiagnostics();
  await operation;
  if (isTauri()) return native("snapshot");
  const merged = await enqueue(checkpoint).catch(() => {
    storageAvailable = false;
  });
  const history =
    merged ?? (JSON.parse(await usageDiagnostics("snapshot")) as History);
  history.storage_available = storageAvailable;
  return {
    history,
    ...__TENSAMIN_BUILD__,
  };
}

export async function setDiagnosticCollection(enabled: boolean) {
  await startDiagnostics();
  await enqueue(async () => {
    settingsAt = Date.now();
    if (isTauri()) await native("enabled", String(enabled));
    else {
      await usageDiagnostics("enabled", String(enabled));
      await checkpoint();
    }
    channel?.postMessage("changed");
  });
}

export async function clearDiagnostics() {
  await startDiagnostics();
  await enqueue(async () => {
    clearedAt = Date.now();
    if (isTauri()) await native("clear");
    else {
      await usageDiagnostics("clear");
      const history = JSON.parse(await usageDiagnostics("snapshot")) as History;
      history.cleared_at = clearedAt;
      history.settings_at = settingsAt;
      const database = await openTensaminDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("storage", "readwrite");
        transaction.objectStore("storage").put(history, historyKey);
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () =>
          reject(new Error("Unable to clear diagnostic history"));
      });
    }
    channel?.postMessage("changed");
  });
}

function browserInfo() {
  const hints = navigator as Navigator & {
    userAgentData?: {
      platform: string;
      mobile: boolean;
      brands: Array<{ brand: string; version: string }>;
    };
    deviceMemory?: number;
  };
  return {
    platform: hints.userAgentData?.platform ?? "unavailable",
    brands: hints.userAgentData?.brands ?? "unavailable",
    mobile: hints.userAgentData?.mobile ?? "unavailable",
    logical_processors: navigator.hardwareConcurrency ?? "unavailable",
    approximate_ram_gib: hints.deviceMemory ?? "unavailable",
    webtransport_supported: "WebTransport" in window,
    online: navigator.onLine,
  };
}

export async function exportDiagnostics(): Promise<boolean> {
  const snapshot = await diagnosticSnapshot();
  const desktop = window.tensaminDesktop?.app;
  const history = snapshot.history as History;
  const totals: Record<string, { count: number; total: number; max: number }> =
    {};
  for (const bucket of history.buckets)
    for (const [name, metric] of Object.entries(bucket.metrics)) {
      const aggregate = (totals[name] ??= { count: 0, total: 0, max: 0 });
      aggregate.count += metric.count;
      aggregate.total += metric.total;
      aggregate.max = Math.max(aggregate.max, metric.max);
    }
  const report = {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    environment: {
      client_type: isTauri() ? "tauri" : desktop ? "electron" : "browser",
      app_version: snapshot.app_version,
      channel: snapshot.channel,
      client_revision: snapshot.client_revision,
      mtp_version: history.mtp_version,
      mtp_revision: snapshot.mtp_revision,
      browser: browserInfo(),
      device: desktop?.getDiagnostics
        ? await desktop.getDiagnostics()
        : (snapshot.device ?? "unavailable in browser"),
    },
    storage_available: storageAvailable,
    history,
    summary: { buckets: history.buckets.length, metrics: totals },
    units: {
      timestamps: "UTC Unix milliseconds; exported_at uses ISO 8601",
      elapsed_ms: "monotonic milliseconds since process start",
      aggregates:
        "count is observations; total is sum; max is largest observation",
      duration:
        "_us is elapsed microseconds, not CPU time; nested operations can overlap",
      frames:
        "encoded bytes are attempts before transport writes; received bytes are decoded application frames, not wire traffic",
      samples:
        "cpu_total_ms and network total bytes are cumulative process/UID samples, not per-bucket consumption",
    },
    limitations: [
      "Activity measurements cannot attribute battery consumption to individual functions.",
      "History checkpoints occur during activity, at most once per minute. Process termination can lose the unfinished minute.",
      "Browser collection stops when the browser suspends or closes the app. Expired history is pruned on next activity or export. OS details unavailable to browsers remain unavailable.",
      "No payloads, keys, credentials, account identifiers, network addresses, or unrestricted error messages are collected.",
    ],
  };
  if (isTauri())
    return invoke<boolean>("export_usage_diagnostics", {
      renderer: JSON.stringify({
        exported_at: report.exported_at,
        environment: { browser: report.environment.browser },
        units: report.units,
        limitations: report.limitations,
      }),
    });
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `tensamin-diagnostics-${new Date().toISOString().replace(/:/g, "-")}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

import { useStorage } from "@tensamin/storage/context";
import {
  normalizeHttpsUrl,
  persistNativeMtpConfig,
} from "@tensamin/storage/credentials";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@nonanium/ui";
import {
  deleteDatabaseEntry,
  listDatabaseEntries,
  setDatabaseEntry,
} from "@tensamin/shared/indexedDb";
import { Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { notify as toast } from "@nonanium/ui";

function stringifyDatabaseValue(value: unknown) {
  return JSON.stringify(value, null, 2) ?? "null";
}

function DatabaseViewer() {
  const [rows, setRows] = useState<Array<{ key: string; value: unknown }>>([]);
  const [editor, setEditor] = useState<{
    originalKey: string | null;
    key: string;
    value: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<{
    message: string;
    action: () => void;
  }>();
  useEffect(() => {
    if (error) toast("error", "Database operation failed", error);
  }, [error]);

  const refresh = useCallback(async () => {
    const entries = await listDatabaseEntries("storage", "");
    setRows(
      entries
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, value })),
    );
  }, []);

  useEffect(() => {
    void refresh().catch((caught) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
  }, [refresh]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveEditor(confirmed = false) {
    if (!editor) return;
    const key = editor.key.trim();
    if (!key) {
      setError("Keys cannot be empty.");
      return;
    }
    if (
      key !== editor.originalKey &&
      rows.some((item) => item.key === key) &&
      !confirmed
    ) {
      setConfirmation({
        message: `Overwrite ${key}?`,
        action: () => void saveEditor(true),
      });
      return;
    }
    await run(async () => {
      await setDatabaseEntry("storage", key, JSON.parse(editor.value));
      if (editor.originalKey && key !== editor.originalKey) {
        await deleteDatabaseEntry("storage", editor.originalKey);
      }
      await refresh();
      setEditor(null);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Dialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open) setConfirmation(undefined);
        }}
      >
        <DialogContent>
          <DialogTitle>Confirm database change</DialogTitle>
          <DialogDescription>{confirmation?.message}</DialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmation(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                confirmation?.action();
                setConfirmation(undefined);
              }}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">IndexedDB storage</h2>
        <div className="flex gap-2">
          <Button
            disabled={busy}
            size="sm"
            onClick={() =>
              setEditor({ originalKey: null, key: "", value: "null" })
            }
          >
            Add entry
          </Button>
          <Button
            disabled={busy}
            size="sm"
            variant="outline"
            onClick={() => void run(refresh)}
          >
            Refresh
          </Button>
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="h-8 w-1/3 px-2">Key</TableHead>
            <TableHead className="h-8 px-2">Value</TableHead>
            <TableHead className="h-8 w-0 px-2">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="px-2 py-1.5 font-mono text-xs">
                {row.key}
              </TableCell>
              <TableCell className="max-w-0 px-2 py-1.5">
                <code
                  className="block truncate text-xs"
                  title={stringifyDatabaseValue(row.value)}
                >
                  {JSON.stringify(row.value) ?? "null"}
                </code>
              </TableCell>
              <TableCell className="px-2 py-1.5">
                <div className="flex gap-1">
                  <Button
                    disabled={busy}
                    size="icon-xs"
                    title={`Edit ${row.key}`}
                    variant="ghost"
                    onClick={() =>
                      setEditor({
                        originalKey: row.key,
                        key: row.key,
                        value: stringifyDatabaseValue(row.value),
                      })
                    }
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    className="text-destructive hover:text-destructive"
                    disabled={busy}
                    size="icon-xs"
                    title={`Delete ${row.key}`}
                    variant="ghost"
                    onClick={() => {
                      setConfirmation({
                        message: `Delete ${row.key}?`,
                        action: () =>
                          void run(async () => {
                            await deleteDatabaseEntry("storage", row.key);
                            await refresh();
                          }),
                      });
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow>
              <TableCell
                className="text-center text-muted-foreground"
                colSpan={3}
              >
                The storage object store is empty.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <Dialog
        open={editor !== null}
        onOpenChange={(open) => !open && setEditor(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editor?.originalKey === null
                ? "Add database entry"
                : "Edit database entry"}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="database-key">Key</Label>
            <Input
              id="database-key"
              value={editor?.key ?? ""}
              onChange={(event) =>
                setEditor((current) =>
                  current
                    ? { ...current, key: event.currentTarget.value }
                    : null,
                )
              }
            />
            <Label htmlFor="database-value">Value</Label>
            <textarea
              className="min-h-64 rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs"
              id="database-value"
              spellCheck={false}
              value={editor?.value ?? ""}
              onChange={(event) =>
                setEditor((current) =>
                  current
                    ? { ...current, value: event.currentTarget.value }
                    : null,
                )
              }
            />
          </div>
          <DialogFooter>
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => setEditor(null)}
            >
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void saveEditor()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}

export default function Page() {
  const storage = useStorage();
  const { save, load } = storage;
  const [draftOmegaUrl, setDraftOmegaUrl] = useState("");
  const [currentOmegaUrl, setCurrentOmegaUrl] = useState("");
  const [draftForcedOmikronUrl, setDraftForcedOmikronUrl] = useState("");
  const [currentForcedOmikronUrl, setCurrentForcedOmikronUrl] = useState("");
  const [draftForcedOmikronPublicKey, setDraftForcedOmikronPublicKey] =
    useState("");
  const [currentForcedOmikronPublicKey, setCurrentForcedOmikronPublicKey] =
    useState("");
  const [loaded, setLoaded] = useState(false);
  const [endpointError, setEndpointError] = useState("");
  const [savingEndpoints, setSavingEndpoints] = useState(false);

  useEffect(() => {
    void Promise.all([
      load("omega_url"),
      load("forced_omikron_url"),
      load("forced_omikron_public_key"),
    ]).then(([omegaUrl, forcedOmikronUrl, forcedOmikronPublicKey]) => {
      setDraftOmegaUrl(omegaUrl);
      setCurrentOmegaUrl(omegaUrl);
      setDraftForcedOmikronUrl(forcedOmikronUrl || "");
      setCurrentForcedOmikronUrl(forcedOmikronUrl || "");
      setDraftForcedOmikronPublicKey(forcedOmikronPublicKey || "");
      setCurrentForcedOmikronPublicKey(forcedOmikronPublicKey || "");
      setLoaded(true);
    });
  }, [load]);

  if (!loaded) return null;

  async function saveEndpoints({
    omegaUrl = currentOmegaUrl,
    forcedOmikronUrl = currentForcedOmikronUrl,
    forcedOmikronPublicKey = currentForcedOmikronPublicKey,
  }: {
    omegaUrl?: string;
    forcedOmikronUrl?: string;
    forcedOmikronPublicKey?: string;
  }) {
    setEndpointError("");
    setSavingEndpoints(true);
    try {
      const normalizedOmega = normalizeHttpsUrl(omegaUrl, "Omega URL");
      if (!normalizedOmega.pathname.endsWith("/")) {
        normalizedOmega.pathname += "/";
      }
      const normalizedForcedUrl = forcedOmikronUrl.trim()
        ? normalizeHttpsUrl(forcedOmikronUrl, "Forced Omikron URL").toString()
        : undefined;
      const normalizedForcedKey = forcedOmikronPublicKey.trim() || undefined;
      if (Boolean(normalizedForcedUrl) !== Boolean(normalizedForcedKey)) {
        throw new Error(
          "Forced Omikron URL and public key must both be set or both be empty",
        );
      }

      const normalizedOmegaUrl = normalizedOmega.toString();
      await Promise.all([
        save("omega_url", normalizedOmegaUrl),
        save("forced_omikron_url", normalizedForcedUrl),
        save("forced_omikron_public_key", normalizedForcedKey),
      ]);
      const [userId, keyring] = await Promise.all([
        load("user_id"),
        load("mtp_keyring"),
      ]);
      await persistNativeMtpConfig({ storage, userId, keyring });
      setDraftOmegaUrl(normalizedOmegaUrl);
      setCurrentOmegaUrl(normalizedOmegaUrl);
      setDraftForcedOmikronUrl(normalizedForcedUrl ?? "");
      setCurrentForcedOmikronUrl(normalizedForcedUrl ?? "");
      setDraftForcedOmikronPublicKey(normalizedForcedKey ?? "");
      setCurrentForcedOmikronPublicKey(normalizedForcedKey ?? "");
    } catch (caught) {
      setEndpointError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setSavingEndpoints(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <p className="text-destructive">
        It's best not to touch these settings! They can be exploited to gain
        access to your account!
      </p>
      <div className="flex flex-col gap-2">
        <Label>Omega Url</Label>
        <div className="flex gap-1">
          <Input
            value={draftOmegaUrl}
            onChange={(event) => setDraftOmegaUrl(event.target.value)}
          />
          <Button
            disabled={savingEndpoints || currentOmegaUrl === draftOmegaUrl}
            onClick={() => void saveEndpoints({ omegaUrl: draftOmegaUrl })}
          >
            Save
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label>Forced Omikron</Label>
        <div className="flex gap-1">
          <Input
            placeholder="URL..."
            value={draftForcedOmikronUrl}
            onChange={(event) => setDraftForcedOmikronUrl(event.target.value)}
          />
          <Input
            placeholder="Public Key..."
            value={draftForcedOmikronPublicKey}
            onChange={(event) =>
              setDraftForcedOmikronPublicKey(event.target.value)
            }
          />
          <Button
            disabled={
              savingEndpoints ||
              (currentForcedOmikronUrl === draftForcedOmikronUrl &&
                currentForcedOmikronPublicKey === draftForcedOmikronPublicKey)
            }
            onClick={() =>
              void saveEndpoints({
                forcedOmikronUrl: draftForcedOmikronUrl,
                forcedOmikronPublicKey: draftForcedOmikronPublicKey,
              })
            }
          >
            Save
          </Button>
        </div>
      </div>
      {endpointError && (
        <p className="text-sm text-destructive">{endpointError}</p>
      )}
      <DatabaseViewer />
    </div>
  );
}

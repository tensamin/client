import { useEffect, useState } from "react";
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Dialog,
  DialogContent,
  DialogTitle,
} from "@nonanium/ui";
import {
  File,
  Folder,
  Upload,
  RefreshCw,
  ChevronRight,
  X,
  Share2,
  Trash2,
  Hash,
  HardDrive,
  FileType,
  CalendarClock,
} from "lucide-react";
import { usePrincipalPresentation } from "@tensamin/identity/context";
import { useFiles } from "@/components/filesRuntime";
import { useMTP } from "@tensamin/mtp";
import {
  encodePrincipal,
  parsePrincipal,
  type WirePrincipal,
} from "@tensamin/shared/principal";
import { useSession } from "@tensamin/identity/session";
import { stringifyExactJson } from "@tensamin/shared/exactJson";
import type { createFileService } from "@tensamin/files/service";
import {
  normalizeFileName,
  type FileKey,
  type FileMetadata,
} from "@tensamin/crypto/file";

const fileColumns = [
  { key: "version", label: "Version", icon: Hash, width: 80 },
  { key: "size", label: "Size", icon: HardDrive, width: 80 },
  { key: "type", label: "Type", icon: FileType, width: 176 },
  { key: "modified", label: "Modified", icon: CalendarClock, width: 192 },
] as const;

type FileColumns = Record<(typeof fileColumns)[number]["key"], boolean>;
const fileNameMinWidth = 160;
const fileActionWidth = 40;

export default function IotaSettings() {
  const { service, start, revision, run, busy, watch, ...files } = useFiles();
  const { clientState, contextReady } = useMTP();
  const { contacts } = useSession();
  const [path, setPath] = useState([{ id: "private", name: "My files" }]);
  const folderId = path[path.length - 1].id;
  const [listing, setListing] = useState<{
    folders: Awaited<
      ReturnType<ReturnType<typeof createFileService>["folders"]>
    >;
    placements: Awaited<
      ReturnType<ReturnType<typeof createFileService>["placements"]>
    >;
    pending: Awaited<
      ReturnType<ReturnType<typeof createFileService>["pending"]>
    >;
    commands: Awaited<
      ReturnType<ReturnType<typeof createFileService>["pendingCommands"]>
    >;
  }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [folderName, setFolderName] = useState("");
  const [filename, setFilename] = useState("");
  const [selection, setSelection] = useState<FileKey>();
  const [action, setAction] = useState<"details" | "sharing">("details");
  const [source, setSource] = useState<string | null>(null);
  const [columns, setColumns] = useState({
    version: false,
    size: true,
    type: false,
    modified: false,
  });
  const openFile = (
    key: FileKey,
    action: "details" | "sharing" = "details",
  ) => {
    setAction(action);
    setSelection(key);
  };
  const deleteFile = (key: FileKey) => {
    if (
      !window.confirm(
        "Delete every version of this file? Active shares will be revoked first. Exported copies cannot be erased.",
      )
    )
      return;

    void run("Revoking shares and deleting file", async (service) => {
      await service.deleteFile(key.file_id);

      if (
        selection?.file_id === key.file_id &&
        encodePrincipal(selection.origin) === encodePrincipal(key.origin)
      )
        setSelection(undefined);
    });
  };
  const [detail, setDetail] = useState<{
    manifest: Awaited<
      ReturnType<ReturnType<typeof createFileService>["manifest"]>
    >;
    metadata: Awaited<
      ReturnType<ReturnType<typeof createFileService>["metadata"]>
    >;
    versions: Awaited<
      ReturnType<ReturnType<typeof createFileService>["versions"]>
    >;
    shares: Awaited<ReturnType<ReturnType<typeof createFileService>["shares"]>>;
  }>();
  useEffect(() => {
    return start();
  }, [start]);
  useEffect(() => {
    let active = true;
    setListing(undefined);
    setError(undefined);

    if (!service) return;
    setLoading(true);
    void Promise.all([
      service.folders(folderId),
      service.placements(folderId),
      service.pending(),
      service.pendingCommands(),
    ])
      .then(
        ([folders, placements, pending, commands]) => {
          if (active) setListing({ folders, placements, pending, commands });
        },
        (error) => {
          if (active) setError(String(error));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [service, folderId, revision]);
  useEffect(() => {
    let active = true;
    setDetail(undefined);
    setError(undefined);
    setFilename("");

    if (!service || !selection) return;
    void Promise.all([
      service.manifest(selection),
      service.metadata(selection),
      service.versions(selection.file_id, selection.origin),
      service.shares(selection.file_id, selection.origin),
    ]).then(
      ([manifest, metadata, versions, shares]) => {
        if (active) setDetail({ manifest, metadata, versions, shares });

        if (active && manifest.state === "transferring") watch(selection);
      },
      (error) => {
        if (active) setError(String(error));
      },
    );

    return () => {
      active = false;
    };
  }, [service, selection, revision, watch]);
  const transfer = selection
    ? (files.transfers[stringifyExactJson(selection)] ?? detail?.manifest)
    : undefined;
  const disabled = !!busy || !service;
  const selectedOutput =
    selection &&
    files.output &&
    stringifyExactJson(selection) === stringifyExactJson(files.output.key);
  const upload = (file: globalThis.File | undefined, key?: FileKey) => {
    if (!file) return;
    void run("Uploading encrypted file", async (service) => {
      if (key) {
        await service.synchronize();
        const latest = await service.latestVersion(key.origin, key.file_id);

        if (!latest) throw new Error("The current file version is unavailable");
        key = { ...latest, version: latest.version + 1n };
      }

      const manifest = await service.upload({
        file,
        filename: normalizeFileName(file.name),
        mimeType: file.type || "application/octet-stream",
        folderId,
        key,
      });
      openFile(manifest.key);
    });
  };

  return (
    <section
      className="@container flex min-w-0 flex-col gap-5"
      aria-labelledby="iota-files-title"
    >
      <header className="flex flex-col gap-4">
        <div>
          <h2
            id="iota-files-title"
            className="text-2xl font-semibold tracking-tight"
          >
            Files
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Select
              value={source ?? "mine"}
              onValueChange={(value) => {
                setSource(value === "mine" ? null : value);
                setSelection(undefined);
              }}
              disabled={!!busy}
            >
              <SelectTrigger aria-label="File source" className="w-40 sm:w-52">
                <SelectValue>
                  {source ? <ContactName principal={source} /> : "My files"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mine">My files</SelectItem>
                {contacts
                  .filter((contact) => contact.Principal)
                  .map((contact) => (
                    <SelectItem
                      key={contact.Principal}
                      value={contact.Principal!}
                    >
                      Shared by <ContactName principal={contact.Principal!} />
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <label>
              <span className="sr-only">Upload a file</span>
              <input
                type="file"
                className="sr-only"
                disabled={disabled}
                onChange={(event) => {
                  upload(event.target.files?.[0]);
                  event.target.value = "";
                }}
                id="files-upload"
              />
              <Button
                disabled={disabled}
                onClick={() => document.getElementById("files-upload")?.click()}
              >
                <Upload className="size-4" />
                Upload file
              </Button>
            </label>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Refresh files"
                    disabled={disabled}
                    onClick={() => void run("Refreshing files", async () => {})}
                  >
                    <RefreshCw className="size-4" />
                  </Button>
                }
              />
              <TooltipContent>Refresh files</TooltipContent>
            </Tooltip>
          </div>
          <div
            className="ml-auto flex items-center gap-1"
            role="group"
            aria-label="Visible columns"
          >
            {fileColumns.map(({ key, label, icon: Icon }) => (
              <Tooltip key={key}>
                <TooltipTrigger
                  render={
                    <Button
                      size="xs"
                      variant={columns[key] ? "default" : "ghost"}
                      aria-label={`Show ${label.toLowerCase()} column`}
                      aria-pressed={columns[key]}
                      onClick={() =>
                        setColumns((value) => ({
                          ...value,
                          [key]: !value[key],
                        }))
                      }
                    >
                      <Icon className="size-4" />
                      {label}
                    </Button>
                  }
                />
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>
      </header>
      {(files.error || error) && (
        <div role="alert" className="text-sm text-destructive">
          <p className="font-medium">
            {files.error
              ? "File operation failed"
              : selection
                ? "Loading file details failed"
                : "Loading files failed"}
          </p>
          <p>{files.error || error}</p>
          {!service && (
            <Button variant="outline" onClick={files.retry}>
              Try again
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {busy && (
        <div role="status" className="text-sm">
          <p>{busy}</p>
          {files.progress && (
            <>
              <p className="text-muted-foreground">
                {files.progress.phase}, {files.progress.bytes.toLocaleString()}{" "}
                of {files.progress.total.toLocaleString()} bytes
              </p>
              <progress
                className="w-full"
                aria-label={files.progress.phase}
                value={Number(files.progress.bytes)}
                max={Number(files.progress.total)}
              />
            </>
          )}
        </div>
      )}
      {files.output && !selectedOutput && <FileExport />}
      <div className="flex min-w-0 flex-col gap-4">
        {source === null ? (
          <div className="min-w-0">
            <div className="min-w-0">
              <nav
                aria-label="File folders"
                className="pb-4 flex flex-wrap items-center gap-1"
              >
                {path.map((folder, index) => (
                  <span
                    key={folder.id}
                    className="flex min-w-0 items-center gap-1"
                  >
                    {index > 0 && (
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <Button
                      key={folder.id}
                      variant="ghost"
                      disabled={!!busy}
                      onClick={() => {
                        setPath(path.slice(0, index + 1));
                        setSelection(undefined);
                      }}
                    >
                      {index === 0 && <Folder className="size-4" />}
                      <span className="truncate">{folder.name}</span>
                    </Button>
                  </span>
                ))}
              </nav>
              <details className="pb-4">
                <summary className="w-fit cursor-pointer text-sm font-medium text-primary">
                  Create a folder
                </summary>
                <form
                  className="pt-3 flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run("Creating folder", async (service) => {
                      await service.putFolder({
                        name: folderName,
                        parentFolderId: folderId,
                      });
                      setFolderName("");
                    });
                  }}
                >
                  <div className="flex min-w-0 flex-1 basis-40 flex-col gap-2">
                    <Label htmlFor="files-folder-name">Folder name</Label>
                    <Input
                      id="files-folder-name"
                      placeholder="e.g. Documents"
                      value={folderName}
                      onChange={(event) => setFolderName(event.target.value)}
                      required
                      disabled={disabled}
                    />
                  </div>
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={disabled || !folderName.trim()}
                  >
                    Create folder
                  </Button>
                </form>
              </details>
              {!service && !files.error && (
                <p role="status">
                  {contextReady ? "Opening file history..." : "Offline"}
                </p>
              )}
              {loading && <p role="status">Loading files...</p>}
              {listing && (
                <>
                  <Table
                    aria-label="My files"
                    className="table-fixed"
                    style={{ minWidth: fileTableMinWidth(columns) }}
                  >
                    <FileTableHeader columns={columns} />
                    <TableBody>
                      {listing.folders.items.map((folder) => (
                        <TableRow key={folder.folder_id}>
                          <TableCell>
                            <Button
                              variant="link"
                              className="max-w-full justify-start px-0"
                              disabled={!!busy}
                              onClick={() => {
                                setPath([
                                  ...path,
                                  { id: folder.folder_id, name: folder.name },
                                ]);
                                setSelection(undefined);
                              }}
                            >
                              <Folder className="size-4 shrink-0" />
                              <span className="truncate">{folder.name}</span>
                            </Button>
                          </TableCell>
                          {fileColumns
                            .filter((column) => columns[column.key])
                            .map((column) => (
                              <TableCell
                                key={column.key}
                                className="text-muted-foreground"
                              >
                                {column.key === "type" ? "Folder" : ""}
                              </TableCell>
                            ))}
                          <TableCell />
                          <TableCell className="p-1">
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={`Delete folder ${folder.name}`}
                                    disabled={!!busy}
                                    onClick={() => {
                                      if (
                                        window.confirm(
                                          `Delete folder "${folder.name}"? It must be empty.`,
                                        )
                                      )
                                        void run("Deleting folder", (service) =>
                                          service.deleteFolder(
                                            folder.folder_id,
                                            folder.revision,
                                          ),
                                        );
                                    }}
                                  >
                                    <Trash2 className="size-4" />
                                  </Button>
                                }
                              />
                              <TooltipContent>Delete folder</TooltipContent>
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                      ))}
                      {listing.placements.items.map((placement) => (
                        <FileTableRow
                          key={placement.placement_id}
                          source={placement}
                          columns={columns}
                          onSelect={openFile}
                          onShare={(key) => openFile(key, "sharing")}
                          onDelete={deleteFile}
                        />
                      ))}
                      {listing.folders.items.length === 0 &&
                        listing.placements.items.length === 0 && (
                          <TableRow>
                            <TableCell
                              colSpan={
                                3 +
                                fileColumns.filter(
                                  (column) => columns[column.key],
                                ).length
                              }
                              className="py-8 text-center text-muted-foreground"
                            >
                              No files yet.
                            </TableCell>
                          </TableRow>
                        )}
                    </TableBody>
                  </Table>
                  {listing.folders.next !== null && (
                    <Button
                      variant="outline"
                      disabled={disabled}
                      onClick={() =>
                        void run(
                          "Loading more folders",
                          async (service) => {
                            const page = await service.folders(
                              folderId,
                              listing.folders.next!,
                            );
                            setListing(
                              (value) =>
                                value && {
                                  ...value,
                                  folders: {
                                    ...page,
                                    items: [
                                      ...value.folders.items,
                                      ...page.items,
                                    ],
                                  },
                                },
                            );
                          },
                          false,
                        )
                      }
                    >
                      More folders
                    </Button>
                  )}
                  {listing.placements.next !== null && (
                    <Button
                      variant="outline"
                      disabled={disabled}
                      onClick={() =>
                        void run(
                          "Loading more files",
                          async (service) => {
                            const page = await service.placements(
                              folderId,
                              listing.placements.next!,
                            );
                            setListing(
                              (value) =>
                                value && {
                                  ...value,
                                  placements: {
                                    ...page,
                                    items: [
                                      ...value.placements.items,
                                      ...page.items,
                                    ],
                                  },
                                },
                            );
                          },
                          false,
                        )
                      }
                    >
                      More files
                    </Button>
                  )}
                  {listing.pending.length > 0 && (
                    <section className="pt-6">
                      <h3 className="font-medium">Interrupted uploads</h3>
                      <ul className="pt-2">
                        {listing.pending.map(({ id, filename }) => (
                          <li
                            key={id}
                            className="flex items-center gap-2 border-b border-border py-2"
                          >
                            <File className="size-4 shrink-0" />
                            <span className="min-w-0 break-words text-sm">
                              {filename ?? id}
                            </span>
                            <Button
                              size="sm"
                              disabled={disabled}
                              onClick={() =>
                                void run("Resuming upload", (service) =>
                                  service.resume(id),
                                )
                              }
                            >
                              Resume
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {listing.commands.length > 0 && (
                    <section className="pt-6">
                      <h3 className="font-medium">Unconfirmed file changes</h3>
                      <p className="text-sm text-muted-foreground">
                        Check the server result before retrying the original
                        operation.
                      </p>
                      <ul>
                        {listing.commands.map((command) => (
                          <li key={command.resource} className="py-3">
                            <p className="break-all text-sm">
                              {command.type}, {command.resource}
                            </p>
                            <div className="pt-2 flex flex-wrap gap-2">
                              <Button
                                variant="outline"
                                disabled={disabled}
                                onClick={() =>
                                  void run(
                                    "Checking file operation",
                                    async (service) => {
                                      const result =
                                        await service.reconcileCommand(
                                          command.resource,
                                        );
                                      setNotice(
                                        result.outcome === "unknown"
                                          ? "The result is still unknown. The original operation has been retained."
                                          : `File operation ${result.outcome}.`,
                                      );
                                    },
                                  )
                                }
                              >
                                Check result
                              </Button>
                              <Button
                                variant="outline"
                                disabled={disabled}
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      "Retry the exact saved file operation? No new encryption or revision will be generated.",
                                    )
                                  )
                                    void run(
                                      "Retrying saved file operation",
                                      (service) =>
                                        service.resumeCommand(command.resource),
                                    );
                                }}
                              >
                                Retry exact operation
                              </Button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                </>
              )}
            </div>
          </div>
        ) : (
          <ConversationFiles
            peer={source}
            columns={columns}
            onSelect={openFile}
            onShare={(key) => openFile(key, "sharing")}
            onDelete={deleteFile}
          />
        )}
        <Dialog
          open={!!selection}
          onOpenChange={(open) => {
            if (!open) setSelection(undefined);
          }}
        >
          <DialogContent showCloseButton={false} className="sm:max-w-lg">
            <div className="flex items-start gap-2">
              <DialogTitle className="min-w-0 flex-1 break-words">
                {action === "sharing" ? "Share " : ""}
                {detail?.metadata.filename ?? "File details"}
              </DialogTitle>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Close file details"
                onClick={() => setSelection(undefined)}
              >
                <X className="size-4" />
              </Button>
            </div>
            {selection &&
              (!detail ? (
                contextReady && (
                  <div className="flex flex-col items-start gap-3 pt-3">
                    <p role="status">
                      {error
                        ? "File details are unavailable. Refresh to retry."
                        : "Verifying file metadata..."}
                    </p>
                    {error && (
                      <Button
                        variant="outline"
                        disabled={disabled}
                        onClick={() =>
                          void run("Reaccepting file transfer", (service) =>
                            service.accept(selection),
                          )
                        }
                      >
                        Reaccept transfer
                      </Button>
                    )}
                  </div>
                )
              ) : (
                <div className="flex flex-col gap-3">
                  {action === "details" ? (
                    <>
                      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm [&>dt]:text-muted-foreground [&>dd]:break-words">
                        <dt>Version</dt>
                        <dd>{selection.version.toString()}</dd>
                        <dt>Size</dt>
                        <dd>
                          {detail.metadata.plaintext_size.toLocaleString()}{" "}
                          bytes
                        </dd>
                        <dt>Transfer</dt>
                        <dd>{transfer?.state}</dd>
                        <dt>Metadata</dt>
                        <dd>Signature verified</dd>
                        <dt>Content</dt>
                        <dd>
                          {selectedOutput
                            ? "Verified for export"
                            : "Verified only during export"}
                        </dd>
                      </dl>
                      {transfer?.transfer && (
                        <div className="pb-4 text-sm" role="status">
                          <p>
                            {transfer.transfer.offset.toLocaleString()} of{" "}
                            {transfer.manifest.ciphertext_size.toLocaleString()}{" "}
                            encrypted bytes
                          </p>
                          <progress
                            className="w-full"
                            aria-label="Server file transfer"
                            value={Number(transfer.transfer.offset)}
                            max={Number(transfer.manifest.ciphertext_size)}
                          />
                          <p>
                            Attempts: {transfer.transfer.attempts.toString()}.
                            Reserved storage:{" "}
                            {transfer.reserved_bytes.toLocaleString()} bytes.
                          </p>
                          {transfer.transfer.error && (
                            <p className="text-destructive">
                              {transfer.transfer.error}
                            </p>
                          )}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-2">
                        {selectedOutput ? (
                          <FileExport showIdentity={false} />
                        ) : (
                          <Button
                            disabled={disabled || transfer?.state !== "ready"}
                            onClick={() => void files.download(selection)}
                          >
                            Verify and export
                          </Button>
                        )}
                        {transfer?.state !== "ready" && (
                          <Button
                            variant="outline"
                            disabled={disabled}
                            onClick={() =>
                              void run("Accepting file transfer", (service) =>
                                service.accept(selection),
                              )
                            }
                          >
                            Accept or retry transfer
                          </Button>
                        )}
                        {transfer?.state === "transferring" && (
                          <Button
                            variant="outline"
                            disabled={disabled}
                            onClick={() =>
                              void run("Cancelling file transfer", (service) =>
                                service.cancel(selection),
                              )
                            }
                          >
                            Cancel transfer
                          </Button>
                        )}
                      </div>
                      {clientState?.Scope &&
                        encodePrincipal(selection.origin) ===
                          encodePrincipal(clientState.Scope.principal) && (
                          <details>
                            <summary className="cursor-pointer text-sm font-medium">
                              Manage file
                            </summary>
                            <div className="pt-4 flex flex-col items-start gap-3">
                              <form
                                className="flex w-full flex-col items-start gap-2 pb-4"
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  void run("Renaming file", async (service) => {
                                    await service.rename(selection, filename);
                                    setFilename("");
                                  });
                                }}
                              >
                                <Label htmlFor="files-rename">
                                  New filename
                                </Label>
                                <Input
                                  id="files-rename"
                                  value={filename}
                                  onChange={(event) =>
                                    setFilename(event.target.value)
                                  }
                                  required
                                  disabled={disabled}
                                />
                                <Button
                                  type="submit"
                                  variant="outline"
                                  disabled={disabled || !filename.trim()}
                                >
                                  Rename
                                </Button>
                              </form>
                              <Label htmlFor="files-new-version">
                                Upload a new version
                              </Label>
                              <input
                                id="files-new-version"
                                type="file"
                                className="sr-only"
                                disabled={disabled}
                                onChange={(event) => {
                                  upload(event.target.files?.[0], selection);
                                  event.target.value = "";
                                }}
                              />
                              <Button
                                variant="outline"
                                disabled={disabled}
                                onClick={() =>
                                  document
                                    .getElementById("files-new-version")
                                    ?.click()
                                }
                              >
                                <Upload className="size-4" />
                                Choose version file
                              </Button>
                              <Button
                                variant="destructive"
                                disabled={disabled}
                                onClick={() => deleteFile(selection)}
                              >
                                Delete every version
                              </Button>
                            </div>
                          </details>
                        )}
                      <details>
                        <summary className="cursor-pointer text-sm font-medium">
                          Version history
                        </summary>
                        <ul>
                          {detail.versions.items.map((version) => (
                            <li key={version.key.version.toString()}>
                              <Button
                                className="w-full justify-start"
                                variant={
                                  version.key.version === selection.version
                                    ? "default"
                                    : "ghost"
                                }
                                aria-current={
                                  version.key.version === selection.version
                                    ? "true"
                                    : undefined
                                }
                                disabled={disabled}
                                onClick={() => setSelection(version.key)}
                              >
                                Version {version.key.version.toString()}
                                {version.key.version === selection.version && (
                                  <span className="ml-auto text-xs">
                                    Viewing
                                  </span>
                                )}
                              </Button>
                            </li>
                          ))}
                        </ul>
                        {detail.versions.next !== null && (
                          <Button
                            variant="outline"
                            disabled={disabled}
                            onClick={() =>
                              void run(
                                "Loading more versions",
                                async (service) => {
                                  const page = await service.versions(
                                    selection.file_id,
                                    selection.origin,
                                    detail.versions.next!,
                                  );
                                  setDetail(
                                    (value) =>
                                      value && {
                                        ...value,
                                        versions: {
                                          ...page,
                                          items: [
                                            ...value.versions.items,
                                            ...page.items,
                                          ],
                                        },
                                      },
                                  );
                                },
                                false,
                              )
                            }
                          >
                            More versions
                          </Button>
                        )}
                      </details>
                      {clientState?.Scope &&
                        encodePrincipal(selection.origin) ===
                          encodePrincipal(clientState.Scope.principal) && (
                          <Button
                            variant="outline"
                            onClick={() => setAction("sharing")}
                          >
                            <Share2 className="size-4" />
                            Share version {selection.version.toString()}
                          </Button>
                        )}
                    </>
                  ) : (
                    <section>
                      {clientState?.Scope &&
                        encodePrincipal(selection.origin) ===
                          encodePrincipal(clientState.Scope.principal) && (
                          <FileSharingControls
                            key={`${encodePrincipal(selection.origin)}:${selection.file_id}:${selection.version}`}
                            fileKey={selection}
                          />
                        )}
                      {detail.shares.items.length === 0 && (
                        <p className="text-sm text-muted-foreground">
                          No shares listed for this file.
                        </p>
                      )}
                      {detail.shares.items.length > 0 && (
                        <h3 className="pt-3 text-sm font-medium">
                          Shared access
                        </h3>
                      )}
                      {detail.shares.items.length > 0 && (
                        <Table aria-label="Shared access">
                          <TableHeader>
                            <TableRow>
                              <TableHead scope="col">Contact</TableHead>
                              <TableHead scope="col">Version</TableHead>
                              <TableHead scope="col">Status</TableHead>
                              <TableHead scope="col">
                                <span className="sr-only">Revoke</span>
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {detail.shares.items.map((grant) => (
                              <TableRow
                                key={`${encodePrincipal(grant.recipient)}:${grant.key.version}`}
                              >
                                <TableCell className="max-w-0 truncate">
                                  <ContactName
                                    principal={encodePrincipal(grant.recipient)}
                                  />
                                </TableCell>
                                <TableCell>
                                  {grant.key.version.toString()}
                                </TableCell>
                                <TableCell
                                  className="capitalize"
                                  title={`Revision ${grant.grant_revision.toString()}`}
                                >
                                  {grant.state}
                                </TableCell>
                                <TableCell className="text-right">
                                  {clientState?.Scope &&
                                    encodePrincipal(selection.origin) ===
                                      encodePrincipal(
                                        clientState.Scope.principal,
                                      ) &&
                                    grant.state !== "revoked" && (
                                      <Button
                                        variant="outline"
                                        size="xs"
                                        aria-label={`Revoke version ${grant.key.version.toString()}`}
                                        disabled={disabled}
                                        onClick={() => {
                                          if (
                                            window.confirm(
                                              "Revoke this version's share? The recipient may already have exported a copy.",
                                            )
                                          )
                                            void run(
                                              "Revoking file share",
                                              async (service) => {
                                                await service.revoke({
                                                  key: grant.key,
                                                  recipient: grant.recipient,
                                                  grantRevision:
                                                    await nextGrantRevision(
                                                      service,
                                                      grant.key,
                                                      grant.recipient,
                                                    ),
                                                });
                                              },
                                            );
                                        }}
                                      >
                                        Revoke
                                      </Button>
                                    )}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                      {detail.shares.next !== null && (
                        <Button
                          variant="outline"
                          disabled={disabled}
                          onClick={() =>
                            void run(
                              "Loading more shares",
                              async (service) => {
                                const page = await service.shares(
                                  selection.file_id,
                                  selection.origin,
                                  detail.shares.next!,
                                );
                                setDetail(
                                  (value) =>
                                    value && {
                                      ...value,
                                      shares: {
                                        ...page,
                                        items: [
                                          ...value.shares.items,
                                          ...page.items,
                                        ],
                                      },
                                    },
                                );
                              },
                              false,
                            )
                          }
                        >
                          More shares
                        </Button>
                      )}
                    </section>
                  )}
                </div>
              ))}
          </DialogContent>
        </Dialog>
      </div>
    </section>
  );
}

function FileExport({ showIdentity = true }: { showIdentity?: boolean }) {
  const { output, busy, run, discard } = useFiles();

  if (!output) return null;

  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      {showIdentity && (
        <p className="break-words text-sm">
          Verified for export: {output.filename}, version{" "}
          {output.key.version.toString()}
        </p>
      )}
      <div className="flex items-center gap-3">
        {output.url ? (
          <Button
            nativeButton={false}
            render={<a href={output.url} download={output.filename} />}
          >
            Save file
          </Button>
        ) : (
          <Button disabled={!!busy} onClick={() => void output.save?.()}>
            Choose destination
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={!!busy}
          onClick={() => void run("Discarding private output", discard)}
        >
          Discard
        </Button>
      </div>
    </div>
  );
}

function FileTableHeader({ columns }: { columns: FileColumns }) {
  return (
    <>
      <colgroup>
        <col />
        {fileColumns
          .filter((column) => columns[column.key])
          .map((column) => (
            <col key={column.key} style={{ width: column.width }} />
          ))}
        <col style={{ width: fileActionWidth }} />
        <col style={{ width: fileActionWidth }} />
      </colgroup>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Name</TableHead>
          {fileColumns
            .filter((column) => columns[column.key])
            .map((column) => (
              <TableHead key={column.key} scope="col">
                {column.label}
              </TableHead>
            ))}
          <TableHead scope="col">
            <span className="sr-only">Share</span>
          </TableHead>
          <TableHead scope="col">
            <span className="sr-only">Delete</span>
          </TableHead>
        </TableRow>
      </TableHeader>
    </>
  );
}

function fileTableMinWidth(columns: FileColumns) {
  return fileColumns.reduce(
    (width, column) => width + (columns[column.key] ? column.width : 0),
    fileNameMinWidth + 2 * fileActionWidth,
  );
}

function formatFileSize(value: string) {
  const bytes = Number(value);
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
  const unit = Math.min(
    Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)),
    units.length - 1,
  );

  return `${(bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

function FileTableRow({
  source,
  columns,
  onSelect,
  onShare,
  onDelete,
}: {
  source:
    | FileKey
    | Awaited<
        ReturnType<ReturnType<typeof createFileService>["placements"]>
      >["items"][number];
  columns: FileColumns;
  onSelect: (key: FileKey) => void;
  onShare: (key: FileKey) => void;
  onDelete: (key: FileKey) => void;
}) {
  const { service, busy, revision } = useFiles();
  const { clientState } = useMTP();
  const ownFile =
    !!clientState?.Scope &&
    encodePrincipal(source.origin) ===
      encodePrincipal(clientState.Scope.principal);
  const [file, setFile] = useState<{ key: FileKey; metadata?: FileMetadata }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    setFile(undefined);
    setError(undefined);

    if (!service) return;
    void (async () => {
      const key =
        "version" in source
          ? source
          : await service.latestVersion(source.origin, source.file_id);

      if (!key) throw new Error("No synchronized file version is available");
      if (active) setFile({ key });
      const metadata = await service.metadata(key);

      if (active) setFile({ key, metadata });
    })().catch((error) => {
      if (active) setError(String(error));
    });

    return () => {
      active = false;
    };
  }, [source, service, revision]);
  const filename =
    file?.metadata?.filename ??
    (error ? `${source.file_id}, metadata unavailable` : "Loading filename...");
  const dot = filename.lastIndexOf(".");
  const extension =
    file?.metadata && dot > 0 && dot < filename.length - 1
      ? filename.slice(dot)
      : "";
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  const characters = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(stem),
    (part) => part.segment,
  );
  const tail =
    file?.metadata && characters.length > 12
      ? characters.slice(-4).join("")
      : "";
  const modified = file?.metadata?.updated_at ?? file?.metadata?.created_at;

  return (
    <TableRow>
      <TableCell className="overflow-hidden">
        <Button
          variant="link"
          className="max-w-full justify-start gap-1 overflow-hidden px-0"
          disabled={!!busy || !file}
          title={error ? `${source.file_id}\n${error}` : filename}
          onClick={() => file && onSelect(file.key)}
        >
          <File className="size-4 shrink-0" />
          <span className="flex min-w-0">
            <span className="min-w-0 truncate">
              {tail ? characters.slice(0, -4).join("") : stem}
            </span>
            {tail && <span className="shrink-0">{tail}</span>}
            {extension && (
              <span className="max-w-[40%] shrink-0 truncate">{extension}</span>
            )}
          </span>
        </Button>
      </TableCell>
      {columns.version && (
        <TableCell>{file?.key.version.toString() ?? ""}</TableCell>
      )}
      {columns.size && (
        <TableCell
          title={
            file?.metadata
              ? `${BigInt(file.metadata.plaintext_size).toLocaleString()} bytes`
              : undefined
          }
        >
          {file?.metadata ? formatFileSize(file.metadata.plaintext_size) : ""}
        </TableCell>
      )}
      {columns.type && (
        <TableCell
          className="max-w-0 truncate"
          title={file?.metadata?.mime_type}
        >
          {file?.metadata?.mime_type}
        </TableCell>
      )}
      {columns.modified && (
        <TableCell>
          {modified
            ? new Date(Number(modified)).toLocaleString()
            : file?.metadata
              ? "Not recorded"
              : ""}
        </TableCell>
      )}
      <TableCell className="p-1">
        {ownFile && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Share ${filename}`}
                  disabled={!!busy || !file}
                  onClick={() => file && onShare(file.key)}
                >
                  <Share2 className="size-4" />
                </Button>
              }
            />
            <TooltipContent>Share</TooltipContent>
          </Tooltip>
        )}
      </TableCell>
      <TableCell className="p-1">
        {ownFile && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${filename}`}
                  disabled={!!busy || !file}
                  onClick={() => file && onDelete(file.key)}
                >
                  <Trash2 className="size-4" />
                </Button>
              }
            />
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
        )}
      </TableCell>
    </TableRow>
  );
}

function ConversationFiles({
  peer,
  columns,
  onSelect,
  onShare,
  onDelete,
}: {
  peer: string;
  columns: FileColumns;
  onSelect: (key: FileKey) => void;
  onShare: (key: FileKey) => void;
  onDelete: (key: FileKey) => void;
}) {
  const { service, busy, revision, run } = useFiles();
  const [page, setPage] =
    useState<
      Awaited<ReturnType<ReturnType<typeof createFileService>["chat"]>>
    >();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    setPage(undefined);
    setError(undefined);

    if (!service) return;
    const principal = parsePrincipal(peer);
    void service
      .chat({ ...principal, user_id: BigInt(principal.user_id) })
      .then(
        (value) => {
          if (active) setPage(value);
        },
        (error) => {
          if (active) setError(String(error));
        },
      );

    return () => {
      active = false;
    };
  }, [service, peer, revision]);
  const sharedFiles =
    page?.items.filter((item) => encodePrincipal(item.key.origin) === peer) ??
    [];

  return (
    <section className="grid min-w-0 gap-2" aria-label="Conversation files">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!page && !error && (
        <p role="status" className="text-sm">
          Loading shared files...
        </p>
      )}
      {page && (
        <>
          <Table
            aria-label="Shared files"
            className="table-fixed"
            style={{ minWidth: fileTableMinWidth(columns) }}
          >
            <FileTableHeader columns={columns} />
            <TableBody>
              {sharedFiles.map((item) => (
                <FileTableRow
                  key={`${encodePrincipal(item.key.origin)}:${item.key.file_id}:${item.key.version}`}
                  source={item.key}
                  columns={columns}
                  onSelect={onSelect}
                  onShare={onShare}
                  onDelete={onDelete}
                />
              ))}
              {sharedFiles.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={
                      3 +
                      fileColumns.filter((column) => columns[column.key]).length
                    }
                    className="py-8 text-center text-muted-foreground"
                  >
                    {page.next === null
                      ? "No files shared by this contact."
                      : "No shared files loaded yet."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {page.next !== null && (
            <Button
              variant="outline"
              disabled={!!busy}
              onClick={() =>
                void run(
                  "Loading shared files",
                  async (service) => {
                    const principal = parsePrincipal(peer);
                    const next = await service.chat(
                      { ...principal, user_id: BigInt(principal.user_id) },
                      page.next!,
                    );
                    setPage({ ...next, items: [...page.items, ...next.items] });
                  },
                  false,
                )
              }
            >
              More shared files
            </Button>
          )}
        </>
      )}
    </section>
  );
}

async function nextGrantRevision(
  service: ReturnType<typeof createFileService>,
  key: FileKey,
  recipient: WirePrincipal,
) {
  let after = 0n;
  let revision = 0n;

  for (;;) {
    const page = await service.shares(key.file_id, key.origin, after);

    for (const grant of page.items)
      if (
        grant.key.version === key.version &&
        encodePrincipal(grant.recipient) === encodePrincipal(recipient) &&
        grant.grant_revision > revision
      )
        revision = grant.grant_revision;

    if (page.next === null) return revision + 1n;

    if (page.next <= after)
      throw new Error("File grant listing did not advance");
    after = page.next;
  }
}

function FileSharingControls({ fileKey }: { fileKey: FileKey }) {
  const { contacts } = useSession();
  const { busy, service, run } = useFiles();
  const [recipient, setRecipient] = useState<string | null>(null);
  const [expiry, setExpiry] = useState("");

  return (
    <form
      className="py-3 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();

        if (!recipient) return;
        void run("Sharing file version", async (service) => {
          const peer = parsePrincipal(recipient);
          const principal = { ...peer, user_id: BigInt(peer.user_id) };
          const expiresAt = new Date(expiry).getTime();

          if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
            throw new Error("Choose a future share expiry");
          await service.share({
            key: fileKey,
            recipient: principal,
            expiresAt: BigInt(expiresAt),
            grantRevision: await nextGrantRevision(service, fileKey, principal),
          });
        });
      }}
    >
      <Label htmlFor="files-recipient">Share this version with</Label>
      <Select
        value={recipient}
        onValueChange={setRecipient}
        disabled={!!busy || !service}
      >
        <SelectTrigger id="files-recipient" className="w-full">
          <SelectValue>
            {recipient ? (
              <ContactName principal={recipient} />
            ) : (
              "Choose a contact"
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {contacts
            .filter((contact) => contact.Principal)
            .map((contact) => (
              <SelectItem key={contact.Principal} value={contact.Principal!}>
                <ContactName principal={contact.Principal!} />
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      <Label htmlFor="files-share-expiry">Access expires</Label>
      <Input
        id="files-share-expiry"
        type="datetime-local"
        required
        value={expiry}
        onChange={(event) => setExpiry(event.target.value)}
        disabled={!!busy}
      />
      <Button type="submit" disabled={!!busy || !recipient || !expiry}>
        Share version {fileKey.version.toString()}
      </Button>
      <p className="text-sm text-muted-foreground">
        Expiry and revocation cannot remove copies someone already exported.
      </p>
    </form>
  );
}

function ContactName({ principal }: { principal: string }) {
  const user = usePrincipalPresentation(principal);

  return (
    <span className="truncate">{user?.Display ?? "Contact unavailable"}</span>
  );
}

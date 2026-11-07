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
} from "@nonanium/ui";
import { File, Folder, Upload, RefreshCw } from "lucide-react";
import { useFiles } from "@/components/filesRuntime";
import { useMTP } from "@tensamin/mtp";
import {
  encodePrincipal,
  parsePrincipal,
  type WirePrincipal,
} from "@tensamin/shared/principal";
import { useSession } from "@tensamin/identity/session";
import { useNavbar } from "@tensamin/shared/navbar";
import { stringifyExactJson } from "@tensamin/shared/exactJson";
import type { createFileService } from "@tensamin/files/service";
import type { FileKey } from "@tensamin/crypto/file";

export default function FilesScreen() {
  const { render } = useNavbar();
  const files = useFiles();
  const { service, start, revision, run, busy, watch } = files;
  const { clientState } = useMTP();
  const [path, setPath] = useState([{ id: "private", name: "My files" }]);
  const folderId = path[path.length - 1].id;
  const [listing, setListing] = useState<{
    folders: Awaited<
      ReturnType<ReturnType<typeof createFileService>["folders"]>
    >;
    placements: Awaited<
      ReturnType<ReturnType<typeof createFileService>["placements"]>
    >;
    pending: string[];
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
    start();
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
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        folderId,
        key,
      });
      setSelection(manifest.key);
    });
  };
  return (
    <section
      className="flex h-full min-h-0 flex-col px-4 pb-4 md:px-6"
      aria-label="Files"
    >
      {render(<h1 className="px-2 font-medium">Files</h1>)}
      <header className="flex flex-wrap items-center justify-between gap-3 py-5">
        <div>
          <p className="text-sm text-muted-foreground">
            Encrypted storage and shared files
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => void run("Refreshing files", async () => {})}
          >
            <RefreshCw className="size-4" />
            Refresh
          </Button>
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
              Upload
            </Button>
          </label>
        </div>
      </header>
      {(files.error || error) && (
        <div role="alert" className="mb-3 text-sm text-destructive">
          {files.error || error}
          {!service && (
            <Button variant="outline" onClick={files.retry}>
              Try again
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="mb-3 text-sm">
          {notice}
        </p>
      )}
      {busy && (
        <div role="status" className="mb-3 text-sm">
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
      {files.output && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border p-3">
          <p className="min-w-0 flex-1 break-all text-sm">
            Verified for export: {files.output.filename}
          </p>
          {files.output.url ? (
            <a
              className="underline"
              href={files.output.url}
              download={files.output.filename}
            >
              Save file
            </a>
          ) : (
            <Button
              disabled={!!busy}
              onClick={() => void files.output?.save?.()}
            >
              Choose destination
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() =>
              void run("Discarding private output", () => files.discard())
            }
          >
            Discard
          </Button>
        </div>
      )}
      <div className="grid min-h-0 flex-1 gap-5 overflow-auto lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
        <div className="min-w-0">
          <ConversationFiles onSelect={setSelection} />
          <nav aria-label="File folders" className="mb-3 flex flex-wrap gap-1">
            {path.map((folder, index) => (
              <Button
                key={folder.id}
                variant="ghost"
                disabled={!!busy}
                onClick={() => {
                  setPath(path.slice(0, index + 1));
                  setSelection(undefined);
                }}
              >
                {folder.name}
              </Button>
            ))}
          </nav>
          <form
            className="mb-4 flex items-end gap-2"
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
            <div className="min-w-0 flex-1">
              <Label htmlFor="files-folder-name">New folder</Label>
              <Input
                id="files-folder-name"
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
          {!service && !files.error && (
            <p role="status">Opening secure file history...</p>
          )}
          {loading && <p role="status">Loading files...</p>}
          {listing && (
            <>
              <ul className="divide-y divide-border">
                {listing.folders.items.map((folder) => (
                  <li
                    key={folder.folder_id}
                    className="flex items-center gap-2 py-2"
                  >
                    <Button
                      variant="ghost"
                      className="min-w-0 flex-1 justify-start"
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
                    <Button
                      variant="ghost"
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
                      Delete
                    </Button>
                  </li>
                ))}
                {listing.placements.items.map((placement) => (
                  <li
                    key={placement.placement_id}
                    className="flex items-center gap-2 py-2"
                  >
                    <Button
                      variant="ghost"
                      className="min-w-0 flex-1 justify-start"
                      disabled={!!busy}
                      onClick={() =>
                        void run(
                          "Finding file version",
                          async (service) => {
                            const key = await service.latestVersion(
                              placement.origin,
                              placement.file_id,
                            );
                            if (!key)
                              throw new Error(
                                "No file version is available in synchronized history. Refresh files to retry.",
                              );
                            setSelection(key);
                          },
                          false,
                        )
                      }
                    >
                      <File className="size-4 shrink-0" />
                      <span className="truncate">
                        <PlacementName placement={placement} />
                      </span>
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={!!busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            "Remove this file from this folder? This does not revoke shares or delete its content.",
                          )
                        )
                          void run("Removing file placement", (service) =>
                            service.deletePlacement(
                              placement.placement_id,
                              placement.revision,
                            ),
                          );
                      }}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
              {listing.folders.items.length === 0 &&
                listing.placements.items.length === 0 && (
                  <p className="py-8 text-sm text-muted-foreground">
                    This folder is empty. Upload a file or create a folder.
                  </p>
                )}
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
                                items: [...value.folders.items, ...page.items],
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
                <section className="mt-6">
                  <h2 className="font-medium">Interrupted uploads</h2>
                  <p className="text-sm text-muted-foreground">
                    Resume the original encrypted upload without creating a
                    duplicate.
                  </p>
                  <ul>
                    {listing.pending.map((id) => (
                      <li
                        key={id}
                        className="flex items-center justify-between gap-2 py-2"
                      >
                        <span className="min-w-0 truncate text-sm">{id}</span>
                        <Button
                          variant="outline"
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
                <section className="mt-6">
                  <h2 className="font-medium">Unconfirmed file changes</h2>
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
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            disabled={disabled}
                            onClick={() =>
                              void run(
                                "Checking file operation",
                                async (service) => {
                                  const result = await service.reconcileCommand(
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
        <aside
          className="min-w-0 border-t pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-5"
          aria-label="File details"
        >
          {!selection ? (
            <p className="text-sm text-muted-foreground">
              Select a file to verify its metadata, view versions or export it.
            </p>
          ) : !detail ? (
            <div>
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
          ) : (
            <>
              <h2 className="break-all font-semibold">
                {detail.metadata.filename}
              </h2>
              <dl className="my-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
                <dt>Version</dt>
                <dd>{selection.version.toString()}</dd>
                <dt>Size</dt>
                <dd>{detail.metadata.plaintext_size.toLocaleString()} bytes</dd>
                <dt>Transfer</dt>
                <dd>{transfer?.state}</dd>
                <dt>Metadata</dt>
                <dd>Signature verified</dd>
                <dt>Content</dt>
                <dd>Verified only during export</dd>
              </dl>
              {transfer?.transfer && (
                <div className="mb-4 text-sm" role="status">
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
                    Attempts: {transfer.transfer.attempts.toString()}. Reserved
                    storage: {transfer.reserved_bytes.toLocaleString()} bytes.
                  </p>
                  {transfer.transfer.error && (
                    <p className="text-destructive">
                      {transfer.transfer.error}
                    </p>
                  )}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={disabled || transfer?.state !== "ready"}
                  onClick={() => void files.download(selection)}
                >
                  Verify and export
                </Button>
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
                  <div className="mt-4">
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void run("Renaming file", async (service) => {
                          await service.rename(selection, filename);
                          setFilename("");
                        });
                      }}
                    >
                      <Label htmlFor="files-rename">New filename</Label>
                      <Input
                        id="files-rename"
                        value={filename}
                        onChange={(event) => setFilename(event.target.value)}
                        required
                        disabled={disabled}
                      />
                      <Button
                        type="submit"
                        variant="outline"
                        className="mt-2 mb-4"
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
                      className="mt-2 block w-full text-sm"
                      disabled={disabled}
                      onChange={(event) => {
                        upload(event.target.files?.[0], selection);
                        event.target.value = "";
                      }}
                    />
                    <Button
                      variant="destructive"
                      className="mt-4"
                      disabled={disabled}
                      onClick={() => {
                        if (
                          window.confirm(
                            "Delete every version of this file? Active shares will be revoked first. Exported copies cannot be erased.",
                          )
                        )
                          void run(
                            "Revoking shares and deleting file",
                            async (service) => {
                              await service.deleteFile(selection.file_id);
                              setSelection(undefined);
                            },
                          );
                      }}
                    >
                      Delete every version
                    </Button>
                  </div>
                )}
              <h3 className="mt-6 font-medium">Versions</h3>
              <ul>
                {detail.versions.items.map((version) => (
                  <li key={version.key.version.toString()}>
                    <Button
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => setSelection(version.key)}
                    >
                      Version {version.key.version.toString()}
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
                                items: [...value.versions.items, ...page.items],
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
              <h3 className="mt-6 font-medium">Shares</h3>
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
              <ul>
                {detail.shares.items.map((grant) => (
                  <li
                    className="py-2 text-sm"
                    key={`${encodePrincipal(grant.recipient)}:${grant.key.version}`}
                  >
                    <p className="break-all">
                      {encodePrincipal(grant.recipient)}
                    </p>
                    <p>
                      {grant.state}, revision {grant.grant_revision.toString()}
                    </p>
                    {clientState?.Scope &&
                      encodePrincipal(selection.origin) ===
                        encodePrincipal(clientState.Scope.principal) &&
                      grant.state !== "revoked" && (
                        <Button
                          variant="outline"
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
                                    grantRevision: await nextGrantRevision(
                                      service,
                                      grant.key,
                                      grant.recipient,
                                    ),
                                  });
                                },
                              );
                          }}
                        >
                          Revoke version {grant.key.version.toString()}
                        </Button>
                      )}
                  </li>
                ))}
              </ul>
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
                                items: [...value.shares.items, ...page.items],
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
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

function PlacementName({
  placement,
}: {
  placement: Awaited<
    ReturnType<ReturnType<typeof createFileService>["placements"]>
  >["items"][number];
}) {
  const { service } = useFiles();
  const [filename, setFilename] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    setFilename(undefined);
    setError(undefined);
    if (!service || placement.metadata.filename) return;
    void (async () => {
      const key = await service.latestVersion(
        placement.origin,
        placement.file_id,
      );
      if (!key) throw new Error("No synchronized file version is available");
      const metadata = await service.metadata(key);
      if (active) setFilename(metadata.filename);
    })().catch((error) => {
      if (active) setError(String(error));
    });
    return () => {
      active = false;
    };
  }, [placement, service]);
  if (placement.metadata.filename) return placement.metadata.filename;
  if (error)
    return <span title={error}>Metadata unavailable, {placement.file_id}</span>;
  return filename ?? "Loading filename...";
}

function ConversationFiles({ onSelect }: { onSelect: (key: FileKey) => void }) {
  const { contacts } = useSession();
  const { service, busy, revision, run } = useFiles();
  const [peer, setPeer] = useState<string | null>(null);
  const [page, setPage] =
    useState<
      Awaited<ReturnType<ReturnType<typeof createFileService>["chat"]>>
    >();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    setPage(undefined);
    setError(undefined);
    if (!service || !peer) return;
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
  return (
    <section className="mb-6 border-b pb-4" aria-label="Conversation files">
      <Label htmlFor="files-conversation">Files shared in a conversation</Label>
      <Select
        value={peer}
        onValueChange={setPeer}
        disabled={!!busy || !service}
      >
        <SelectTrigger id="files-conversation" className="mt-2 w-full">
          <SelectValue placeholder="Choose a contact" />
        </SelectTrigger>
        <SelectContent>
          {contacts
            .filter((contact) => contact.Principal)
            .map((contact) => (
              <SelectItem key={contact.Principal} value={contact.Principal!}>
                {contact.Principal}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {peer && !page && !error && (
        <p role="status" className="mt-2 text-sm">
          Loading shared files...
        </p>
      )}
      {page && (
        <>
          <ul className="mt-2">
            {page.items.map((item) => (
              <li
                key={`${encodePrincipal(item.key.origin)}:${item.key.file_id}:${item.key.version}`}
              >
                <Button
                  variant="ghost"
                  className="max-w-full"
                  disabled={!!busy}
                  onClick={() => onSelect(item.key)}
                >
                  <File className="size-4 shrink-0" />
                  <span className="truncate">
                    {item.key.file_id}, version {item.key.version.toString()}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
          {page.items.length === 0 && (
            <p className="mt-2 text-sm text-muted-foreground">
              No active file shares in this conversation.
            </p>
          )}
          {page.next !== null && (
            <Button
              variant="outline"
              disabled={!!busy}
              onClick={() =>
                void run(
                  "Loading shared files",
                  async (service) => {
                    const principal = parsePrincipal(peer!);
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
      className="my-3 space-y-2"
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
          <SelectValue placeholder="Choose a contact" />
        </SelectTrigger>
        <SelectContent>
          {contacts
            .filter((contact) => contact.Principal)
            .map((contact) => (
              <SelectItem key={contact.Principal} value={contact.Principal!}>
                {contact.Principal}
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
      <Button
        type="submit"
        variant="outline"
        disabled={!!busy || !recipient || !expiry}
      >
        Share version {fileKey.version.toString()}
      </Button>
      <p className="text-sm text-muted-foreground">
        Expiry and revocation cannot remove copies someone already exported.
      </p>
    </form>
  );
}

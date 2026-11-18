import { useFiles } from "./context";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@nonanium/ui";
import type { FileKey } from "@tensamin/crypto/file";
import { useSession } from "@tensamin/identity/session";
import { stringifyExactJson } from "@tensamin/shared/exactJson";
import { encodePrincipal, parsePrincipal } from "@tensamin/shared/principal";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CornerLeftUp,
  Download,
  File,
  Folder,
  FolderPlus,
  Info,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";

import { FileDetails } from "./components/fileDetails";
import { ContactName } from "./components/fileSharing";
import {
  FileDownloadButton,
  FileExport,
  formatFileSize,
} from "./components/fileTransfers";
import { PendingFileOperations } from "./components/pendingFileOperations";
import {
  useFileError,
  useFileListing,
  useFileMetadata,
  useSharedListing,
} from "./components/useFileListing";

// Dragged rows carry this type so folders and the path know what to move.
const entryType = "application/x-tensamin-entry";

const dropHighlight =
  "data-over:bg-(--primary)/15 data-over:outline-2 data-over:-outline-offset-2 data-over:outline-dashed data-over:outline-(--primary)";

// Counts nested enter/leave pairs so moving over a target's children doesn't flicker the highlight.
function useDropTarget(onDrop?: (entry: string) => void) {
  const [depth, setDepth] = useState(0);
  const handle = (event: DragEvent, change: (depth: number) => number) => {
    if (!onDrop || !event.dataTransfer.types.includes(entryType)) return false;
    event.preventDefault();
    setDepth(change);
    return true;
  };

  return {
    "data-over": depth > 0 || undefined,
    onDragEnter: (event: DragEvent) => handle(event, (depth) => depth + 1),
    onDragLeave: (event: DragEvent) =>
      handle(event, (depth) => Math.max(0, depth - 1)),
    onDragOver: (event: DragEvent) => handle(event, (depth) => depth),
    onDrop: (event: DragEvent) => {
      if (handle(event, () => 0))
        onDrop?.(event.dataTransfer.getData(entryType));
    },
  };
}

function Row({
  entry,
  onDrop,
  children,
}: {
  entry?: string;
  onDrop?: (entry: string) => void;
  children: ReactNode;
}) {
  const dropProps = useDropTarget(
    onDrop && ((dragged) => dragged !== entry && onDrop(dragged)),
  );

  return (
    <TableRow
      draggable={!!entry}
      className={dropHighlight}
      onDragStart={(event) => {
        if (!entry) return;
        event.dataTransfer.setData(entryType, entry);
        event.dataTransfer.effectAllowed = "move";
      }}
      {...dropProps}
    >
      {children}
    </TableRow>
  );
}

function SortHead({
  label,
  by,
  sort,
  setSort,
  className,
}: {
  label: string;
  by: "size" | "modified";
  sort: { by: "size" | "modified"; desc: boolean };
  setSort(sort: { by: "size" | "modified"; desc: boolean }): void;
  className?: string;
}) {
  const Arrow = sort.desc ? ArrowDown : ArrowUp;

  return (
    <TableHead className={cn("h-11 px-2", className)}>
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-(--foreground)"
        onClick={() =>
          setSort(
            sort.by === by ? { by, desc: !sort.desc } : { by, desc: true },
          )
        }
      >
        {label}
        {sort.by === by && <Arrow className="size-4" />}
      </button>
    </TableHead>
  );
}

export default function IotaSettings() {
  const { service, start, run, busy, revision, ...files } = useFiles();
  const { contacts } = useSession();
  const [peer, setPeer] = useState<string | null>(null);
  const [path, setPath] = useState([{ id: "private", name: "My files" }]);
  const folderId = path[path.length - 1].id;
  const {
    listing,
    setListing,
    loading,
    error: listingError,
  } = useFileListing(folderId);
  const {
    page: shared,
    setPage: setShared,
    error: sharedError,
  } = useSharedListing(peer);
  // Shared files come from the chat with that contact, so keep only the ones they sent.
  const sources = useMemo(
    () =>
      peer === null
        ? (listing?.placements.items ?? []).map((placement) => ({
            id: placement.placement_id,
            origin: placement.origin,
            file_id: placement.file_id,
          }))
        : (shared?.items ?? [])
            .filter((item) => encodePrincipal(item.key.origin) === peer)
            .map(({ key }) => ({
              id: `${key.file_id}:${key.version}`,
              origin: key.origin,
              file_id: key.file_id,
              key,
            })),
    [peer, listing, shared],
  );
  const metadata = useFileMetadata(sources);
  const [sort, setSort] = useState<{
    by: "size" | "modified";
    desc: boolean;
  }>({ by: "size", desc: true });
  const [folderName, setFolderName] = useState<string>();
  const [confirmation, setConfirmation] = useState<{
    message: string;
    action: () => void;
  }>();
  const [selection, setSelection] = useState<FileKey>();
  const [action, setAction] = useState<"details" | "sharing">("details");
  const [available, setAvailable] = useState<bigint>();
  const [storageError, setStorageError] = useState<string>();
  useFileError(storageError);
  useEffect(() => {
    return start();
  }, [start]);
  useEffect(() => {
    let active = true;
    setStorageError(undefined);

    if (!service) return;
    void service.storage().then(
      (limits) => {
        if (active)
          setAvailable(
            limits.quota_available_bytes < limits.disk_available_bytes
              ? limits.quota_available_bytes
              : limits.disk_available_bytes,
          );
      },
      (error) => {
        if (active) setStorageError(String(error));
      },
    );

    return () => {
      active = false;
    };
  }, [service, revision]);
  const disabled = !!busy || !service || loading;
  const ready = peer === null ? !!listing : !!shared;
  const selectedOutput =
    selection &&
    files.output &&
    stringifyExactJson(selection) === stringifyExactJson(files.output.key);
  const folders =
    peer === null
      ? [...(listing?.folders.items ?? [])].sort((a, b) =>
          a.name.localeCompare(b.name),
        )
      : [];
  const rows = sources
    .map((source) => {
      const file = metadata[source.id];
      const date =
        file?.metadata &&
        (file.metadata.updated_at ?? file.metadata.created_at);
      const placement =
        peer === null
          ? listing?.placements.items.find(
              (item) => item.placement_id === source.id,
            )
          : undefined;

      return {
        source,
        placement,
        key: file?.key,
        verified: !!file?.metadata,
        name: file?.metadata?.filename ?? placement?.metadata.filename ?? "",
        size: file?.metadata && Number(file.metadata.plaintext_size),
        modified: date ? Number(date) : undefined,
        error: !!file?.error,
      };
    })
    // Rows without a value stay at the bottom in both directions.
    .sort((a, b) => {
      const [x, y] = [a[sort.by], b[sort.by]];
      if (x === undefined || y === undefined)
        return Number(x === undefined) - Number(y === undefined);
      return sort.desc ? y - x : x - y;
    });
  const hasMore =
    peer === null
      ? !!listing &&
        (listing.folders.next !== null || listing.placements.next !== null)
      : !!shared && shared.next !== null;

  const deleteFile = (key: Pick<FileKey, "origin" | "file_id">) => {
    setConfirmation({
      message:
        "Delete this file? Active shares will be revoked first. Exported copies cannot be erased.",
      action: () =>
        void run("Revoking shares and deleting file", async (service) => {
          await service.deleteFile(key.file_id);

          if (
            selection?.file_id === key.file_id &&
            encodePrincipal(selection.origin) === encodePrincipal(key.origin)
          )
            setSelection(undefined);
        }),
    });
  };
  const move = (entry: string, target: string) => {
    const folder = listing?.folders.items.find(
      (item) => `folder:${item.folder_id}` === entry,
    );
    const placement = listing?.placements.items.find(
      (item) => `file:${item.placement_id}` === entry,
    );

    if (folder && folder.parent_folder_id !== target)
      void run(`Moving ${folder.name}`, (service) =>
        service.putFolder({
          name: folder.name,
          folderId: folder.folder_id,
          parentFolderId: target,
          revision: folder.revision + 1n,
        }),
      );
    if (placement && placement.folder_id !== target)
      void run("Moving file", (service) =>
        service.putPlacement(
          {
            placement_id: placement.placement_id,
            origin: placement.origin,
            file_id: placement.file_id,
            folder_id: target,
            hidden: placement.hidden,
            revision: placement.revision + 1n,
          },
          placement.metadata,
        ),
      );
  };

  return (
    <section className="@container flex max-w-3xl min-w-0 flex-col gap-3">
      <h2 className="text-lg font-semibold">Files</h2>
      {files.output && !selectedOutput && <FileExport />}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="h-11 px-1">
              <div className="flex min-w-0 items-center gap-0.5 font-normal text-muted-foreground">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        className="min-w-0 text-(--foreground)"
                      />
                    }
                  >
                    {peer === null ? (
                      "My files"
                    ) : (
                      <ContactName principal={peer} />
                    )}
                    <ChevronDown className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem
                      onClick={() => {
                        setPeer(null);
                        setPath(path.slice(0, 1));
                      }}
                    >
                      My files
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>Shared with you</DropdownMenuLabel>
                      {contacts
                        .filter((contact) => contact.Principal)
                        .map((contact) => (
                          <DropdownMenuItem
                            key={contact.Principal}
                            onClick={() => setPeer(contact.Principal!)}
                          >
                            <ContactName principal={contact.Principal!} />
                          </DropdownMenuItem>
                        ))}
                      {!contacts.some((contact) => contact.Principal) && (
                        <DropdownMenuItem disabled>
                          No contacts yet
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                {available !== undefined && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0"
                        />
                      }
                    >
                      <Info className="size-4" />
                    </TooltipTrigger>
                    <TooltipContent>
                      {formatFileSize(available)} of storage available
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </TableHead>
            <SortHead
              label="Modified"
              by="modified"
              sort={sort}
              setSort={setSort}
              className="hidden w-32 @md:table-cell!"
            />
            <SortHead
              label="Size"
              by="size"
              sort={sort}
              setSort={setSort}
              className="w-24"
            />
            <TableHead className="h-11 w-0 px-2">
              <div className="flex justify-end gap-1">
                {peer === null && (
                  <Button
                    disabled={disabled}
                    size="icon-sm"
                    title="New folder"
                    variant="ghost"
                    onClick={() => setFolderName("")}
                  >
                    <FolderPlus className="size-4" />
                  </Button>
                )}
                <Button
                  disabled={!!busy || !service}
                  size="icon-sm"
                  title="Refresh"
                  variant="ghost"
                  onClick={() => void run("Refreshing", async () => {})}
                >
                  <RefreshCw
                    className={cn(
                      "size-4",
                      (busy || loading) && "animate-spin",
                    )}
                  />
                </Button>
              </div>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {peer === null && path.length > 1 && (
            <Row onDrop={(entry) => move(entry, path[path.length - 2].id)}>
              <TableCell colSpan={4} className="px-2 py-2.5">
                <button
                  type="button"
                  className="flex h-7 max-w-full items-center gap-2.5 text-muted-foreground hover:underline"
                  onClick={() => setPath(path.slice(0, -1))}
                >
                  <CornerLeftUp className="size-5 shrink-0" />
                  <span className="truncate">
                    Back to {path[path.length - 2].name}
                  </span>
                </button>
              </TableCell>
            </Row>
          )}
          {folders.map((folder) => (
            <Row
              key={folder.folder_id}
              entry={`folder:${folder.folder_id}`}
              onDrop={(entry) => move(entry, folder.folder_id)}
            >
              <TableCell className="max-w-0 px-2 py-2.5">
                <button
                  type="button"
                  className="flex max-w-full items-center gap-2.5 hover:underline"
                  onClick={() =>
                    setPath([
                      ...path,
                      { id: folder.folder_id, name: folder.name },
                    ])
                  }
                >
                  <Folder className="size-5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{folder.name}</span>
                </button>
              </TableCell>
              <TableCell className="hidden px-2 py-2.5 @md:table-cell!" />
              <TableCell className="px-2 py-2.5" />
              <TableCell className="px-2 py-2.5">
                <div className="flex justify-end">
                  <Button
                    className="text-destructive hover:text-destructive"
                    disabled={disabled}
                    size="icon-sm"
                    title={`Delete ${folder.name}`}
                    variant="ghost"
                    onClick={() =>
                      setConfirmation({
                        message: `Delete the folder "${folder.name}"? It must be empty.`,
                        action: () =>
                          void run("Deleting folder", (service) =>
                            service.deleteFolder(
                              folder.folder_id,
                              folder.revision,
                            ),
                          ),
                      })
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </TableCell>
            </Row>
          ))}
          {rows.map(
            ({
              source,
              placement,
              key,
              verified,
              name,
              size,
              modified,
              error,
            }) => (
              <Row
                key={source.id}
                entry={placement && `file:${placement.placement_id}`}
              >
                <TableCell className="max-w-0 px-2 py-2.5">
                  <button
                    type="button"
                    disabled={!key}
                    className="flex max-w-full items-center gap-2.5 enabled:hover:underline"
                    onClick={() => {
                      if (!key) return;
                      setAction("details");
                      setSelection(key);
                    }}
                  >
                    <File className="size-5 shrink-0 text-muted-foreground" />
                    <span
                      className={cn("truncate", error && "text-destructive")}
                    >
                      {name || (error ? "Couldn't load file" : "Loading")}
                    </span>
                  </button>
                </TableCell>
                <TableCell className="hidden px-2 py-2.5 text-muted-foreground @md:table-cell!">
                  {modified !== undefined &&
                    new Date(modified).toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                </TableCell>
                <TableCell className="px-2 py-2.5 tabular-nums">
                  {size !== undefined && formatFileSize(String(size))}
                </TableCell>
                <TableCell className="px-2 py-2.5">
                  <div className="flex justify-end gap-1">
                    {key && verified && (
                      <FileDownloadButton
                        fileKey={key}
                        save
                        disabled={!!busy}
                        size="icon-sm"
                        title={`Download ${name}`}
                        variant="ghost"
                      >
                        <Download className="size-4" />
                      </FileDownloadButton>
                    )}
                    {placement && (
                      <Button
                        className="text-destructive hover:text-destructive"
                        disabled={disabled}
                        size="icon-sm"
                        title={`Delete ${name}`}
                        variant="ghost"
                        onClick={() => deleteFile(placement)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </Row>
            ),
          )}
          {!ready && (
            <TableRow>
              <TableCell
                className="text-center text-muted-foreground"
                colSpan={4}
              >
                {files.error && !service ? (
                  <Button size="sm" variant="outline" onClick={files.retry}>
                    Try again
                  </Button>
                ) : (peer === null ? listingError : sharedError) ? (
                  <div className="flex flex-col items-center gap-2">
                    {peer === null
                      ? "This folder couldn't be loaded."
                      : "Shared files couldn't be loaded."}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!!busy || !service}
                      onClick={() => void run("Refreshing", async () => {})}
                    >
                      Try again
                    </Button>
                  </div>
                ) : (
                  <Loader2 className="mx-auto size-4 animate-spin" />
                )}
              </TableCell>
            </TableRow>
          )}
          {ready && folders.length + rows.length === 0 && (
            <TableRow>
              <TableCell
                className="text-center text-muted-foreground"
                colSpan={4}
              >
                {peer === null
                  ? "This folder is empty."
                  : hasMore
                    ? "No files from this contact yet. Load more to look further back."
                    : "This contact hasn't shared any files with you."}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {hasMore && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() =>
              void run(
                "Loading more",
                async (service) => {
                  if (peer !== null && shared?.next) {
                    const principal = parsePrincipal(peer);
                    const next = await service.chat(
                      { ...principal, user_id: BigInt(principal.user_id) },
                      shared.next,
                    );
                    setShared((value) =>
                      value === shared
                        ? { ...next, items: [...shared.items, ...next.items] }
                        : value,
                    );
                    return;
                  }
                  if (!listing) return;
                  const [nextFolders, nextPlacements] = await Promise.all([
                    listing.folders.next !== null
                      ? service.folders(folderId, listing.folders.next)
                      : undefined,
                    listing.placements.next !== null
                      ? service.placements(folderId, listing.placements.next)
                      : undefined,
                  ]);
                  // Navigating or refreshing replaces the listing, so drop pages fetched for an older one.
                  setListing((value) =>
                    value === listing
                      ? {
                          ...value,
                          folders: nextFolders
                            ? {
                                ...nextFolders,
                                items: [
                                  ...value.folders.items,
                                  ...nextFolders.items,
                                ],
                              }
                            : value.folders,
                          placements: nextPlacements
                            ? {
                                ...nextPlacements,
                                items: [
                                  ...value.placements.items,
                                  ...nextPlacements.items,
                                ],
                              }
                            : value.placements,
                        }
                      : value,
                  );
                },
                false,
              )
            }
          >
            Load more
          </Button>
        </div>
      )}
      {listing && peer === null && (
        <PendingFileOperations
          listing={listing}
          disabled={disabled}
          setConfirmation={setConfirmation}
        />
      )}
      <Dialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open) setConfirmation(undefined);
        }}
      >
        <DialogContent>
          <DialogTitle>Confirm file operation</DialogTitle>
          <DialogDescription>{confirmation?.message}</DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmation(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={disabled}
              onClick={() => {
                confirmation?.action();
                setConfirmation(undefined);
              }}
            >
              Confirm
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={folderName !== undefined}
        onOpenChange={(open) => {
          if (!open) setFolderName(undefined);
        }}
      >
        <DialogContent>
          <DialogTitle>Create a folder</DialogTitle>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const name = folderName?.trim();
              if (!name || disabled) return;
              void run("Creating folder", async (service) => {
                await service.putFolder({ name, parentFolderId: folderId });
                setFolderName(undefined);
              });
            }}
          >
            <Label htmlFor="files-folder-name">Folder name</Label>
            <Input
              id="files-folder-name"
              value={folderName ?? ""}
              onChange={(event) => setFolderName(event.target.value)}
              required
              disabled={disabled}
            />
            <Button type="submit" disabled={disabled || !folderName?.trim()}>
              Create folder
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <FileDetails
        selection={selection}
        setSelection={setSelection}
        action={action}
        setAction={setAction}
        disabled={disabled}
        deleteFile={deleteFile}
      />
    </section>
  );
}

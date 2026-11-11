import { useFiles } from "@/components/filesRuntime";
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nonanium/ui";
import { type FileKey } from "@tensamin/crypto/file";
import { ArrowLeft, Folder, Trash2 } from "lucide-react";

import type { Dispatch, SetStateAction } from "react";
import {
  FileTableHeader,
  FileTableRow,
  fileColumns,
  fileTableMinWidth,
  type FileColumns,
} from "./fileTable";
import { PendingFileOperations } from "./pendingFileOperations";
import type { FileListing } from "./useFileListing";

export function FileBrowser({
  path,
  setPath,
  listing,
  setListing,
  disabled,
  loading,
  columns,
  setColumns,
  openFile,
  deleteFile,
  setSelection,
  setConfirmation,
}: {
  path: { id: string; name: string }[];
  setPath: Dispatch<SetStateAction<{ id: string; name: string }[]>>;
  listing?: FileListing;
  setListing: Dispatch<SetStateAction<FileListing | undefined>>;
  disabled: boolean;
  loading: boolean;
  columns: FileColumns;
  setColumns: Dispatch<SetStateAction<FileColumns>>;
  openFile(key: FileKey, action?: "details" | "sharing"): void;
  deleteFile(key: Pick<FileKey, "origin" | "file_id">): void;
  setSelection: Dispatch<SetStateAction<FileKey | undefined>>;
  setConfirmation: Dispatch<
    SetStateAction<{ message: string; action: () => void } | undefined>
  >;
}) {
  const { busy, run } = useFiles();
  const folderId = path[path.length - 1].id;
  return (
    <div className="min-w-0">
      <div className="min-w-0">
        <Table
          className="table-fixed"
          style={{ minWidth: fileTableMinWidth(columns) }}
        >
          <FileTableHeader columns={columns} onColumnsChange={setColumns} />
          <TableBody>
            {path.length > 1 && (
              <TableRow>
                <TableCell
                  colSpan={
                    2 +
                    fileColumns.filter((column) => columns[column.key]).length
                  }
                >
                  <Button
                    variant="ghost"
                    disabled={disabled || loading}
                    onClick={() => {
                      setPath((value) => value.slice(0, -1));
                      setSelection(undefined);
                    }}
                  >
                    <ArrowLeft className="size-4" />
                    Back to {path[path.length - 2].name}
                  </Button>
                </TableCell>
              </TableRow>
            )}
            {listing?.folders.items.map((folder) => (
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
                <TableCell className="p-1">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={!!busy}
                          onClick={() => {
                            setConfirmation({
                              message: `Delete folder "${folder.name}"? It must be empty.`,
                              action: () =>
                                void run("Deleting folder", (service) =>
                                  service.deleteFolder(
                                    folder.folder_id,
                                    folder.revision,
                                  ),
                                ),
                            });
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
            {listing?.placements.items.map((placement) => (
              <FileTableRow
                key={placement.placement_id}
                source={placement}
                columns={columns}
                onSelect={openFile}
                onShare={(key) => openFile(key, "sharing")}
                onDelete={deleteFile}
              />
            ))}
            {listing &&
              listing.folders.items.length === 0 &&
              listing.placements.items.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={
                      2 +
                      fileColumns.filter((column) => columns[column.key]).length
                    }
                    className="py-8 text-center text-muted-foreground"
                  >
                    No files yet.
                  </TableCell>
                </TableRow>
              )}
          </TableBody>
        </Table>
        {listing && (
          <>
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
                              items: [...value.placements.items, ...page.items],
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
            <PendingFileOperations
              listing={listing}
              disabled={disabled}
              setConfirmation={setConfirmation}
            />
          </>
        )}
      </div>
    </div>
  );
}

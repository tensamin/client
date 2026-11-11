import { useFiles } from "@/components/filesRuntime";
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nonanium/ui";
import { type FileKey, type FileMetadata } from "@tensamin/crypto/file";
import type { createFileService } from "@tensamin/files/service";
import { useMTP } from "@tensamin/mtp";
import { encodePrincipal } from "@tensamin/shared/principal";
import {
  CalendarClock,
  CircleAlert,
  File,
  FileType,
  HardDrive,
  Info,
  Loader2,
  MoreHorizontal,
  Share2,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";

import { FileDownloadButton } from "./fileTransfers";
import { useFileError } from "./useFileListing";

export const fileColumns = [
  { key: "size", label: "Size", icon: HardDrive, width: 80 },
  { key: "type", label: "Type", icon: FileType, width: 176 },
  { key: "modified", label: "Modified", icon: CalendarClock, width: 192 },
] as const;

export type FileColumns = Record<(typeof fileColumns)[number]["key"], boolean>;
const fileNameMinWidth = 160;
const fileActionWidth = 92;

export function FileTableHeader({
  columns,
  onColumnsChange,
}: {
  columns: FileColumns;
  onColumnsChange: (columns: FileColumns) => void;
}) {
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
          <TableHead scope="col" className="text-right">
            <span className="sr-only">Actions</span>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="icon-sm">
                    <MoreHorizontal className="size-4" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                {fileColumns.map(({ key, label }) => (
                  <DropdownMenuCheckboxItem
                    key={key}
                    checked={columns[key]}
                    onCheckedChange={(checked) =>
                      onColumnsChange({ ...columns, [key]: checked })
                    }
                  >
                    {label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </TableHead>
        </TableRow>
      </TableHeader>
    </>
  );
}

export function fileTableMinWidth(columns: FileColumns) {
  return fileColumns.reduce(
    (width, column) => width + (columns[column.key] ? column.width : 0),
    fileNameMinWidth + fileActionWidth,
  );
}

export function formatFileSize(value: string) {
  const bytes = Number(value);
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
  const unit = Math.min(
    Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)),
    units.length - 1,
  );

  return `${(bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

export function FileTableRow({
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
  onDelete: (key: Pick<FileKey, "origin" | "file_id">) => void;
}) {
  const { service, busy, revision } = useFiles();
  const { clientState } = useMTP();
  const ownFile =
    !!clientState?.Scope &&
    encodePrincipal(source.origin) ===
      encodePrincipal(clientState.Scope.principal);
  const [file, setFile] = useState<{ key: FileKey; metadata?: FileMetadata }>();
  const [error, setError] = useState<string>();
  useFileError(error);
  const origin = encodePrincipal(source.origin);
  useEffect(() => {
    setFile(undefined);
  }, [service, source.file_id, origin]);
  useEffect(() => {
    let active = true;
    setError(undefined);

    if (!service) return;
    void (async () => {
      const key =
        "version" in source
          ? source
          : await service.fileKey(source.origin, source.file_id);

      if (!key) throw new Error("No synchronized file is available");
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
  const filename = file?.metadata?.filename ?? "";
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
        {!file?.metadata ? (
          error ? (
            <Tooltip>
              <TooltipTrigger
                render={<span className="inline-flex text-destructive" />}
              >
                <CircleAlert className="size-4" />
              </TooltipTrigger>
              <TooltipContent>Couldn't load file</TooltipContent>
            </Tooltip>
          ) : (
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          )
        ) : (
          <FileDownloadButton
            fileKey={file.key}
            save
            variant="link"
            className="max-w-full justify-start gap-1 overflow-hidden px-0 text-foreground!"
            disabled={!!busy || !file?.metadata}
            title={error ? `${source.file_id}\n${error}` : filename}
          >
            <File className="size-4 shrink-0" />
            <span className="flex min-w-0">
              <span className="min-w-0 truncate">
                {tail ? characters.slice(0, -4).join("") : stem}
              </span>
              {tail && <span className="shrink-0">{tail}</span>}
              {extension && (
                <span className="max-w-[40%] shrink-0 truncate">
                  {extension}
                </span>
              )}
            </span>
          </FileDownloadButton>
        )}
      </TableCell>
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
              ? ""
              : ""}
        </TableCell>
      )}
      <TableCell className="p-1 whitespace-nowrap">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!!busy || !file}
          onClick={() => file && onSelect(file.key)}
        >
          <Info className="size-4" />
        </Button>
        {ownFile && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={!!busy || !file?.metadata}
                  onClick={() => file && onShare(file.key)}
                >
                  <Share2 className="size-4" />
                </Button>
              }
            />
            <TooltipContent>Share</TooltipContent>
          </Tooltip>
        )}
        {ownFile && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={!!busy}
                  onClick={() => onDelete(source)}
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

import { useFiles } from "@/components/filesRuntime";
import { Button, Table, TableBody, TableCell, TableRow } from "@nonanium/ui";
import { type FileKey } from "@tensamin/crypto/file";
import type { createFileService } from "@tensamin/files/service";
import { encodePrincipal, parsePrincipal } from "@tensamin/shared/principal";
import { useEffect, useState } from "react";

import {
  FileTableHeader,
  FileTableRow,
  fileColumns,
  fileTableMinWidth,
  type FileColumns,
} from "./fileTable";
import { useFileError } from "./useFileListing";

export function ConversationFiles({
  peer,
  columns,
  onColumnsChange,
  onSelect,
  onShare,
  onDelete,
}: {
  peer: string;
  columns: FileColumns;
  onColumnsChange: (columns: FileColumns) => void;
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
  useFileError(error);
  useEffect(() => {
    setPage(undefined);
  }, [service, peer]);
  useEffect(() => {
    let active = true;
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
    <section className="grid min-w-0 gap-2">
      {page && (
        <>
          <Table
            className="table-fixed"
            style={{ minWidth: fileTableMinWidth(columns) }}
          >
            <FileTableHeader
              columns={columns}
              onColumnsChange={onColumnsChange}
            />
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
                      2 +
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

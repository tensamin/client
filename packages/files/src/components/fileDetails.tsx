import { useFiles } from "../context";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@nonanium/ui";
import { normalizeFileName, type FileKey } from "@tensamin/crypto/file";
import type { createFileService } from "../service";
import { useMTP } from "@tensamin/mtp";
import { stringifyExactJson } from "@tensamin/shared/exactJson";
import { encodePrincipal } from "@tensamin/shared/principal";
import { ArrowLeft, Download, Loader2, Share2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { Dispatch, SetStateAction } from "react";
import { FileShares } from "./fileShares";
import {
  FileDownloadButton,
  FileExport,
  formatFileSize,
  transferPercentage,
} from "./fileTransfers";
import { useFileError } from "./useFileListing";

export type FileDetail = {
  manifest: Awaited<
    ReturnType<ReturnType<typeof createFileService>["manifest"]>
  >;
  metadata: Awaited<
    ReturnType<ReturnType<typeof createFileService>["metadata"]>
  >;
  shares: Awaited<ReturnType<ReturnType<typeof createFileService>["shares"]>>;
};

export function FileDetails({
  selection,
  setSelection,
  action,
  setAction,
  disabled,
  deleteFile,
}: {
  selection?: FileKey;
  setSelection: Dispatch<SetStateAction<FileKey | undefined>>;
  action: "details" | "sharing";
  setAction: Dispatch<SetStateAction<"details" | "sharing">>;
  disabled: boolean;
  deleteFile(key: FileKey): void;
}) {
  const { service, revision, run, watch, ...files } = useFiles();
  const { clientState, contextReady } = useMTP();
  const [detail, setDetail] = useState<FileDetail>();
  const [filename, setFilename] = useState("");
  const [error, setError] = useState<string>();
  useFileError(error);
  useEffect(() => {
    setDetail(undefined);
  }, [service, selection]);
  useEffect(() => {
    let active = true;
    setError(undefined);

    if (!service || !selection) return;
    void Promise.all([
      service.manifest(selection),
      service.metadata(selection),
      service.shares(selection.file_id, selection.origin),
    ]).then(
      ([manifest, metadata, shares]) => {
        if (!active) return;
        setDetail({ manifest, metadata, shares });
        setFilename(metadata.filename);
        if (manifest.state === "transferring") watch(selection);
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
  useFileError(transfer?.transfer?.error ?? undefined);
  const own =
    !!selection &&
    !!clientState?.Scope &&
    encodePrincipal(selection.origin) ===
      encodePrincipal(clientState.Scope.principal);
  const selectedOutput =
    selection &&
    files.output &&
    stringifyExactJson(selection) === stringifyExactJson(files.output.key);
  const modified =
    detail && (detail.metadata.updated_at ?? detail.metadata.created_at);

  return (
    <Dialog
      open={!!selection}
      onOpenChange={(open) => {
        if (!open) setSelection(undefined);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="pr-6">
          <DialogTitle className="break-words">
            {detail?.metadata.filename ?? "File details"}
          </DialogTitle>
          {detail && (
            <DialogDescription>
              {formatFileSize(detail.metadata.plaintext_size)}
              {modified &&
                `, modified ${new Date(Number(modified)).toLocaleDateString(
                  undefined,
                  { day: "numeric", month: "short", year: "numeric" },
                )}`}
            </DialogDescription>
          )}
        </DialogHeader>
        {selection && !detail && (
          <div className="flex flex-col items-center gap-3 py-4 text-muted-foreground">
            {error && (
              <p className="text-sm break-words text-destructive">
                This file couldn't be opened. {error}
              </p>
            )}
            {error && contextReady && (
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
            {!error && <Loader2 className="size-4 animate-spin" />}
          </div>
        )}
        {selection && detail && action === "sharing" && (
          <>
            <FileShares
              key={stringifyExactJson(selection)}
              fileKey={selection}
              shares={detail.shares}
              setShares={(shares) =>
                setDetail((value) => value && { ...value, shares })
              }
              disabled={disabled}
            />
            <DialogFooter className="sm:justify-start">
              <Button variant="outline" onClick={() => setAction("details")}>
                <ArrowLeft />
                Back
              </Button>
            </DialogFooter>
          </>
        )}
        {selection && detail && action === "details" && (
          <>
            {own && (
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = filename.trim();
                  if (disabled || !name || name === detail.metadata.filename)
                    return;
                  void run("Renaming file", (service) =>
                    service.rename(selection, normalizeFileName(name)),
                  );
                }}
              >
                <Input
                  value={filename}
                  onChange={(event) => setFilename(event.target.value)}
                  disabled={disabled}
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={
                    disabled ||
                    !filename.trim() ||
                    filename.trim() === detail.metadata.filename
                  }
                >
                  Rename
                </Button>
              </form>
            )}
            {transfer && transfer.state !== "ready" && (
              <div className="flex flex-col items-start gap-2 text-sm">
                <p>
                  {transfer.transfer
                    ? `Transferring, ${transferPercentage(
                        transfer.transfer.offset,
                        transfer.manifest.ciphertext_size,
                      )}% after ${transfer.transfer.attempts} attempts.`
                    : "This file isn't on this device yet."}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={() =>
                      void run("Accepting file transfer", (service) =>
                        service.accept(selection),
                      )
                    }
                  >
                    Accept or retry
                  </Button>
                  {transfer.state === "transferring" && (
                    <Button
                      size="sm"
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
              </div>
            )}
            {selectedOutput && <FileExport showIdentity={false} />}
            <DialogFooter className="sm:justify-between">
              {own && (
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={disabled}
                  onClick={() => deleteFile(selection)}
                >
                  <Trash2 />
                  Delete
                </Button>
              )}
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                {own && (
                  <Button
                    variant="outline"
                    onClick={() => setAction("sharing")}
                  >
                    <Share2 />
                    Share
                  </Button>
                )}
                {!selectedOutput && (
                  <FileDownloadButton
                    fileKey={selection}
                    disabled={disabled || transfer?.state !== "ready"}
                  >
                    <Download />
                    Export
                  </FileDownloadButton>
                )}
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

import { useFiles } from "@/components/filesRuntime";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nonanium/ui";
import { type FileKey } from "@tensamin/crypto/file";
import type { createFileService } from "@tensamin/files/service";
import { useMTP } from "@tensamin/mtp";
import { stringifyExactJson } from "@tensamin/shared/exactJson";
import { encodePrincipal } from "@tensamin/shared/principal";
import { Share2, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { Dispatch, SetStateAction } from "react";
import { FileManagement } from "./fileManagement";
import { FileShares } from "./fileShares";
import {
  FileDownloadButton,
  FileExport,
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
        if (active) setDetail({ manifest, metadata, shares });

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
  useFileError(transfer?.transfer?.error ?? undefined);

  const selectedOutput =
    selection &&
    files.output &&
    stringifyExactJson(selection) === stringifyExactJson(files.output.key);

  return (
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
            onClick={() => setSelection(undefined)}
          >
            <X className="size-4" />
          </Button>
        </div>
        {selection &&
          (!detail ? (
            contextReady && (
              <div className="flex flex-col items-start gap-3 pt-3">
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
                    <dt>Size</dt>
                    <dd>
                      {detail.metadata.plaintext_size.toLocaleString()} bytes
                    </dd>
                    <dt>Transfer</dt>
                    <dd>
                      <Tooltip open={transfer?.state === "transferring"}>
                        <TooltipTrigger render={<span />}>
                          {transfer?.state}
                        </TooltipTrigger>
                        <TooltipContent className="inline-flex">
                          Downloading{" "}
                          {transfer?.transfer
                            ? transferPercentage(
                                transfer.transfer.offset,
                                transfer.manifest.ciphertext_size,
                              )
                            : 0}
                          %
                        </TooltipContent>
                      </Tooltip>
                    </dd>
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
                      <p>
                        Attempts: {transfer.transfer.attempts.toString()}.
                        Reserved storage:{" "}
                        {transfer.reserved_bytes.toLocaleString()} bytes.
                      </p>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {selectedOutput ? (
                      <FileExport showIdentity={false} />
                    ) : (
                      <FileDownloadButton
                        fileKey={selection}
                        disabled={disabled || transfer?.state !== "ready"}
                      >
                        Verify and export
                      </FileDownloadButton>
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
                      <FileManagement
                        key={stringifyExactJson(selection)}
                        selection={selection}
                        disabled={disabled}
                        deleteFile={deleteFile}
                      />
                    )}

                  {clientState?.Scope &&
                    encodePrincipal(selection.origin) ===
                      encodePrincipal(clientState.Scope.principal) && (
                      <Button
                        variant="outline"
                        onClick={() => setAction("sharing")}
                      >
                        <Share2 className="size-4" />
                        Share file
                      </Button>
                    )}
                </>
              ) : (
                <FileShares
                  key={stringifyExactJson(selection)}
                  fileKey={selection}
                  shares={detail.shares}
                  setShares={(shares) =>
                    setDetail((value) => value && { ...value, shares })
                  }
                  disabled={disabled}
                />
              )}
            </div>
          ))}
      </DialogContent>
    </Dialog>
  );
}

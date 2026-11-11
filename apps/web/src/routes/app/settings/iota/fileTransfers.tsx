import { useFiles } from "@/components/filesRuntime";
import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@nonanium/ui";
import { type FileKey } from "@tensamin/crypto/file";
import { useState, type ComponentProps } from "react";

export function transferPercentage(bytes: bigint, total: bigint) {
  return total > 0n
    ? Math.min(100, Math.max(0, Number((bytes * 100n) / total)))
    : 0;
}

export function FileDownloadButton({
  fileKey,
  save = false,
  ...props
}: Omit<ComponentProps<typeof Button>, "onClick"> & {
  fileKey: FileKey;
  save?: boolean;
}) {
  const { download, progress } = useFiles();
  const [downloading, setDownloading] = useState(false);
  return (
    <Tooltip open={downloading && progress?.phase === "downloading"}>
      <TooltipTrigger render={<span className="inline-flex max-w-full" />}>
        <Button
          {...props}
          disabled={props.disabled || downloading}
          onClick={async () => {
            setDownloading(true);
            try {
              await download(fileKey, save);
            } finally {
              setDownloading(false);
            }
          }}
        />
      </TooltipTrigger>
      <TooltipContent className="inline-flex">
        Downloading{" "}
        {progress?.phase === "downloading"
          ? transferPercentage(progress.bytes, progress.total)
          : 0}
        %
      </TooltipContent>
    </Tooltip>
  );
}

export function FileExport({
  showIdentity = true,
}: {
  showIdentity?: boolean;
}) {
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

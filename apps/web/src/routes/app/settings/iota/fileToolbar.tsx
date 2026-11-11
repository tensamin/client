import { useFiles } from "@/components/filesRuntime";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nonanium/ui";
import { type FileKey } from "@tensamin/crypto/file";
import { usePrincipalPresentation } from "@tensamin/identity/context";
import { useSession } from "@tensamin/identity/session";
import { useMTP } from "@tensamin/mtp";
import { encodePrincipal } from "@tensamin/shared/principal";
import { FolderPlus, RefreshCw, Upload } from "lucide-react";

import type { Dispatch, SetStateAction } from "react";
import { ContactName } from "./fileSharing";
import { transferPercentage } from "./fileTransfers";

export function FileToolbar({
  source,
  setSource,
  setSelection,
  disabled,
  loading,
  upload,
  setFolderDialogOpen,
}: {
  source: string | null;
  setSource: Dispatch<SetStateAction<string | null>>;
  setSelection: Dispatch<SetStateAction<FileKey | undefined>>;
  disabled: boolean;
  loading: boolean;
  upload(file: globalThis.File | undefined): void;
  setFolderDialogOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const { busy, run, progress } = useFiles();
  const { clientState } = useMTP();
  const ownUser = usePrincipalPresentation(
    clientState?.Scope
      ? encodePrincipal(clientState.Scope.principal)
      : undefined,
  );
  const { contacts } = useSession();

  const uploadProgress =
    progress &&
    ["encrypting", "uploading", "publishing"].includes(progress.phase)
      ? progress
      : undefined;

  return (
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
            <SelectTrigger className="w-40 sm:w-52">
              <SelectValue>
                {source ? (
                  <ContactName principal={source} />
                ) : (
                  `Me (${ownUser?.Username ?? ownUser?.Display ?? "..."})`
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mine">
                Me ({ownUser?.Username ?? ownUser?.Display ?? "..."})
              </SelectItem>
              {contacts
                .filter((contact) => contact.Principal)
                .map((contact) => (
                  <SelectItem
                    key={contact.Principal}
                    value={contact.Principal!}
                  >
                    <ContactName principal={contact.Principal!} />
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
            <Tooltip open={!!busy && !!uploadProgress}>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Button
                  disabled={disabled}
                  onClick={() =>
                    document.getElementById("files-upload")?.click()
                  }
                >
                  <Upload className="size-4" />
                  Upload file
                </Button>
              </TooltipTrigger>
              <TooltipContent className="inline-flex">
                {uploadProgress && (
                  <>
                    {uploadProgress.phase === "encrypting"
                      ? "Encrypting"
                      : uploadProgress.phase === "publishing"
                        ? "Publishing"
                        : "Uploading"}{" "}
                    {transferPercentage(
                      uploadProgress.bytes,
                      uploadProgress.total,
                    )}
                    %
                  </>
                )}
              </TooltipContent>
            </Tooltip>
          </label>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={disabled || loading}
                  onClick={() => void run("Refreshing files", async () => {})}
                >
                  <RefreshCw className="size-4" />
                </Button>
              }
            />
            <TooltipContent>Refresh files</TooltipContent>
          </Tooltip>
          {source === null && (
            <Button
              variant="ghost"
              size="icon"
              disabled={disabled || loading}
              onClick={() => setFolderDialogOpen(true)}
            >
              <FolderPlus className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}

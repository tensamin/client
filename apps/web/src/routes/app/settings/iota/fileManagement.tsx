import { useFiles } from "@/components/filesRuntime";
import { Button, Input, Label } from "@nonanium/ui";
import { type FileKey } from "@tensamin/crypto/file";
import { useEffect, useState } from "react";

export function FileManagement({
  selection,
  disabled,
  deleteFile,
}: {
  selection: FileKey;
  disabled: boolean;
  deleteFile(key: FileKey): void;
}) {
  const { run, service, revision } = useFiles();
  const [filename, setFilename] = useState("");
  useEffect(() => setFilename(""), [service, revision, selection]);
  return (
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
            disabled={disabled || !filename.trim()}
          >
            Rename
          </Button>
        </form>
        <Button
          variant="destructive"
          disabled={disabled}
          onClick={() => deleteFile(selection)}
        >
          Delete file
        </Button>
      </div>
    </details>
  );
}

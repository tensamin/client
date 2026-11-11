import { useFiles } from "@/components/filesRuntime";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Label,
} from "@nonanium/ui";
import { normalizeFileName, type FileKey } from "@tensamin/crypto/file";
import { stringifyExactJson } from "@tensamin/shared/exactJson";
import { encodePrincipal } from "@tensamin/shared/principal";
import { useEffect, useState } from "react";

import { ConversationFiles } from "./iota/conversationFiles";
import { FileBrowser } from "./iota/fileBrowser";
import { FileDetails } from "./iota/fileDetails";
import { FileToolbar } from "./iota/fileToolbar";
import { FileExport } from "./iota/fileTransfers";
import { useFileListing } from "./iota/useFileListing";

export default function IotaSettings() {
  const { service, start, run, busy, ...files } = useFiles();
  const [path, setPath] = useState([{ id: "private", name: "My files" }]);
  const folderId = path[path.length - 1].id;
  const { listing, setListing, loading } = useFileListing(folderId);
  const [folderName, setFolderName] = useState("");
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    message: string;
    action: () => void;
  }>();
  const [selection, setSelection] = useState<FileKey>();
  const [action, setAction] = useState<"details" | "sharing">("details");
  const [source, setSource] = useState<string | null>(null);
  const [columns, setColumns] = useState({
    size: true,
    type: false,
    modified: true,
  });
  const openFile = (
    key: FileKey,
    action: "details" | "sharing" = "details",
  ) => {
    setAction(action);
    setSelection(key);
  };
  const deleteFile = (key: FileKey) => {
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
  useEffect(() => {
    return start();
  }, [start]);
  const disabled = !!busy || !service || loading;
  const selectedOutput =
    selection &&
    files.output &&
    stringifyExactJson(selection) === stringifyExactJson(files.output.key);
  const upload = (file: globalThis.File | undefined) => {
    if (!file) return;
    void run("Uploading encrypted file", async (service) => {
      const manifest = await service.upload({
        file,
        filename: normalizeFileName(file.name),
        mimeType: file.type || "application/octet-stream",
        folderId,
      });
      openFile(manifest.key);
    });
  };

  return (
    <section className="@container flex min-w-0 flex-col gap-5">
      <FileToolbar
        source={source}
        setSource={setSource}
        setSelection={setSelection}
        disabled={disabled}
        loading={loading}
        upload={upload}
        setFolderDialogOpen={setFolderDialogOpen}
      />
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
      <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
        <DialogContent>
          <DialogTitle>Create a folder</DialogTitle>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!folderName.trim() || disabled) return;
              void run("Creating folder", async (service) => {
                await service.putFolder({
                  name: folderName.trim(),
                  parentFolderId: folderId,
                });
                setFolderName("");
                setFolderDialogOpen(false);
              });
            }}
          >
            <Label htmlFor="files-folder-name">Folder name</Label>
            <Input
              id="files-folder-name"
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              required
              disabled={disabled}
            />
            <Button type="submit" disabled={disabled || !folderName.trim()}>
              Create folder
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      {files.error && !service && (
        <Button variant="outline" onClick={files.retry}>
          Try again
        </Button>
      )}
      {files.output && !selectedOutput && <FileExport />}
      <div className="flex min-w-0 flex-col gap-4">
        {source === null ? (
          <FileBrowser
            path={path}
            setPath={setPath}
            listing={listing}
            setListing={setListing}
            disabled={disabled}
            loading={loading}
            columns={columns}
            setColumns={setColumns}
            openFile={openFile}
            deleteFile={deleteFile}
            setSelection={setSelection}
            setConfirmation={setConfirmation}
          />
        ) : (
          <ConversationFiles
            peer={source}
            columns={columns}
            onColumnsChange={setColumns}
            onSelect={openFile}
            onShare={(key) => openFile(key, "sharing")}
            onDelete={deleteFile}
          />
        )}
        <FileDetails
          selection={selection}
          setSelection={setSelection}
          action={action}
          setAction={setAction}
          disabled={disabled}
          deleteFile={deleteFile}
        />
      </div>
    </section>
  );
}

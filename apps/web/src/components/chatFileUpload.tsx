import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Progress,
  toast,
} from "@nonanium/ui";
import { useChat } from "@tensamin/chat/context";
import { normalizeFileName, type FileKey } from "@tensamin/crypto/file";
import { useSession } from "@tensamin/identity/session";
import { usePrincipalPresentation } from "@tensamin/identity/context";
import { useMTP } from "@tensamin/mtp";
import { parsePrincipal } from "@tensamin/shared/principal";
import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { nextGrantRevision, useFiles } from "./filesRuntime";

export default function ChatFileUpload() {
  const { userId } = useChat();
  const { contacts } = useSession();
  const recipient = contacts.find(
    (contact) => contact.UserId === userId,
  )?.Principal;
  const user = usePrincipalPresentation(recipient);
  const { contextReady } = useMTP();
  const { start, service, busy, error, progress, run, retry } = useFiles();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File>();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploaded, setUploaded] = useState<FileKey>();
  const [expiry, setExpiry] = useState("");

  useEffect(() => {
    if (open) return start();
  }, [open, start]);

  useEffect(() => {
    setOpen(false);
    setFile(undefined);
    setUploaded(undefined);
    setExpiry("");
  }, [userId]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            aria-label="Upload a file"
            variant="ghost"
            className="h-9! w-9 p-0"
            disabled={!contextReady || !recipient || !!busy}
          >
            <Plus size={20} />
          </Button>
        }
      />
      <DialogContent>
        <DialogTitle>Share a file</DialogTitle>
        <DialogDescription>
          Upload and share with {user?.Display ?? "this contact"}.
        </DialogDescription>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!file || !recipient || !service || busy) return;
            const peer = parsePrincipal(recipient);
            const target = { ...peer, user_id: BigInt(peer.user_id) };
            void run(
              "Uploading and sharing file",
              async (service) => {
                const expiresAt = new Date(expiry).getTime();
                if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
                  throw new Error("Choose a future share expiry");
                let key = uploaded;
                if (!key) {
                  const manifest = await service.upload({
                    file,
                    filename: normalizeFileName(file.name),
                    mimeType: file.type || "application/octet-stream",
                  });
                  key = manifest.key;
                  setUploaded(key);
                }
                await service.share({
                  key,
                  recipient: target,
                  expiresAt: BigInt(expiresAt),
                  grantRevision: await nextGrantRevision(service, key, target),
                });
                await service.synchronize();
                setOpen(false);
                setFile(undefined);
                setUploaded(undefined);
                setExpiry("");
                toast.success("File shared");
              },
              false,
            );
          }}
        >
          <Label htmlFor="chat-upload-file">File</Label>
          <Input
            ref={fileInput}
            id="chat-upload-file"
            type="file"
            className="sr-only"
            required={!file}
            disabled={!!busy}
            onChange={(event) => {
              setFile(event.target.files?.[0]);
              setUploaded(undefined);
            }}
          />
          <Button
            type="button"
            variant="outline"
            className="min-w-0 justify-start"
            disabled={!!busy}
            onClick={() => fileInput.current?.click()}
          >
            <span className="truncate">{file?.name ?? "Choose a file"}</span>
          </Button>
          <Label htmlFor="chat-upload-expiry">Access expires</Label>
          <Input
            id="chat-upload-expiry"
            type="datetime-local"
            required
            value={expiry}
            disabled={!!busy}
            onChange={(event) => setExpiry(event.target.value)}
          />
          {busy && (
            <p className="text-sm text-muted-foreground" role="status">
              {busy}
            </p>
          )}
          {busy && progress && (
            <Progress
              aria-label={progress.phase}
              value={Number(progress.bytes)}
              max={Number(progress.total)}
            />
          )}
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
          {error && !service && (
            <Button type="button" variant="outline" onClick={retry}>
              Retry
            </Button>
          )}
          <Button
            type="submit"
            disabled={!contextReady || !service || !file || !expiry || !!busy}
          >
            Upload and share
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

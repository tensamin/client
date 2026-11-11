import { nextGrantRevision, useFiles } from "@/components/filesRuntime";
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@nonanium/ui";
import { useFileAccess } from "@tensamin/chat/file-access";
import { type FileKey } from "@tensamin/crypto/file";
import { usePrincipalPresentation } from "@tensamin/identity/context";
import { useSession } from "@tensamin/identity/session";
import { parsePrincipal } from "@tensamin/shared/principal";
import { useState } from "react";

export function FileSharingControls({ fileKey }: { fileKey: FileKey }) {
  const { contacts } = useSession();
  const { busy, service, run } = useFiles();
  const [recipient, setRecipient] = useState<string | null>(null);
  const [expiry, setExpiry] = useState("");
  const { days } = useFileAccess(
    contacts.find((contact) => contact.Principal === recipient)?.UserId ?? 0,
  );

  return (
    <form
      className="py-3 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();

        if (!recipient || days === undefined) return;
        void run("Sharing file", async (service) => {
          const peer = parsePrincipal(recipient);
          const principal = { ...peer, user_id: BigInt(peer.user_id) };
          const expiresAt = expiry
            ? new Date(expiry).getTime()
            : Date.now() + days * 86400000;

          if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
            throw new Error("Choose a future share expiry");
          await service.share({
            key: fileKey,
            recipient: principal,
            expiresAt: BigInt(expiresAt),
            grantRevision: await nextGrantRevision(service, fileKey, principal),
          });
        });
      }}
    >
      <Label htmlFor="files-recipient">Share this version with</Label>
      <Select
        value={recipient}
        onValueChange={setRecipient}
        disabled={!!busy || !service}
      >
        <SelectTrigger id="files-recipient" className="w-full">
          <SelectValue>
            {recipient ? (
              <ContactName principal={recipient} />
            ) : (
              "Choose a contact"
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {contacts
            .filter((contact) => contact.Principal)
            .map((contact) => (
              <SelectItem key={contact.Principal} value={contact.Principal!}>
                <ContactName principal={contact.Principal!} />
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      <Label htmlFor="files-share-expiry">Access expires</Label>
      <Input
        id="files-share-expiry"
        type="datetime-local"
        value={expiry}
        onChange={(event) => setExpiry(event.target.value)}
        disabled={!!busy || days === undefined}
      />
      <p className="text-xs text-muted-foreground">
        Leave empty to use this contact's default of {days ?? 365} days.
      </p>
      <Button
        type="submit"
        disabled={!!busy || !recipient || days === undefined}
      >
        Share version {fileKey.version.toString()}
      </Button>
      <p className="text-sm text-muted-foreground">
        Expiry and revocation cannot remove copies someone already exported.
      </p>
    </form>
  );
}

export function ContactName({ principal }: { principal: string }) {
  const user = usePrincipalPresentation(principal);

  return (
    <span className="truncate">{user?.Display ?? "Contact unavailable"}</span>
  );
}

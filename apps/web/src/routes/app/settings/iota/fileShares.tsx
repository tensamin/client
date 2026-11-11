import { nextGrantRevision, useFiles } from "@/components/filesRuntime";
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@nonanium/ui";
import { type FileKey } from "@tensamin/crypto/file";
import { useMTP } from "@tensamin/mtp";
import { stringifyExactJson } from "@tensamin/shared/exactJson";
import { encodePrincipal } from "@tensamin/shared/principal";
import { useState } from "react";

import type { FileDetail } from "./fileDetails";
import { ContactName, FileSharingControls } from "./fileSharing";

export function FileShares({
  fileKey,
  shares,
  setShares,
  disabled,
}: {
  fileKey: FileKey;
  shares: FileDetail["shares"];
  setShares(shares: FileDetail["shares"]): void;
  disabled: boolean;
}) {
  const { clientState } = useMTP();
  const { run } = useFiles();
  const [revokeConfirmation, setRevokeConfirmation] = useState<string>();
  return (
    <section>
      {clientState?.Scope &&
        encodePrincipal(fileKey.origin) ===
          encodePrincipal(clientState.Scope.principal) && (
          <FileSharingControls
            key={`${encodePrincipal(fileKey.origin)}:${fileKey.file_id}`}
            fileKey={fileKey}
          />
        )}
      {shares.items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No shares listed for this file.
        </p>
      )}
      {shares.items.length > 0 && (
        <h3 className="pt-3 text-sm font-medium">Shared access</h3>
      )}
      {shares.items.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Contact</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Revoke</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shares.items.map((grant) => (
              <TableRow
                key={stringifyExactJson([
                  grant.key,
                  grant.recipient,
                  grant.chat_id,
                ])}
              >
                <TableCell className="max-w-0 truncate">
                  <ContactName principal={encodePrincipal(grant.recipient)} />
                </TableCell>
                <TableCell
                  className="capitalize"
                  title={`Revision ${grant.grant_revision.toString()}`}
                >
                  {grant.state}
                </TableCell>
                <TableCell className="text-right">
                  {clientState?.Scope &&
                    encodePrincipal(fileKey.origin) ===
                      encodePrincipal(clientState.Scope.principal) &&
                    grant.state !== "revoked" && (
                      <Button
                        variant={
                          revokeConfirmation === stringifyExactJson(grant)
                            ? "destructive"
                            : "outline"
                        }
                        size="xs"
                        disabled={disabled}
                        onClick={() => {
                          if (
                            revokeConfirmation !== stringifyExactJson(grant)
                          ) {
                            setRevokeConfirmation(stringifyExactJson(grant));
                            return;
                          }
                          setRevokeConfirmation(undefined);
                          void run("Revoking file share", async (service) => {
                            await service.revoke({
                              key: grant.key,
                              recipient: grant.recipient,
                              grantRevision: await nextGrantRevision(
                                service,
                                grant.key,
                                grant.recipient,
                              ),
                            });
                          });
                        }}
                      >
                        {revokeConfirmation === stringifyExactJson(grant)
                          ? "Confirm?"
                          : "Revoke"}
                      </Button>
                    )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {shares.next !== null && (
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() =>
            void run(
              "Loading more shares",
              async (service) => {
                const page = await service.shares(
                  fileKey.file_id,
                  fileKey.origin,
                  shares.next!,
                );
                setShares({ ...page, items: [...shares.items, ...page.items] });
              },
              false,
            )
          }
        >
          More shares
        </Button>
      )}
    </section>
  );
}

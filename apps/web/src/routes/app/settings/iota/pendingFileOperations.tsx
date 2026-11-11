import { useFiles } from "@/components/filesRuntime";
import { Button, notify as toast } from "@nonanium/ui";
import { File } from "lucide-react";
import { useEffect, useState } from "react";

import type { Dispatch, SetStateAction } from "react";
import type { FileListing } from "./useFileListing";

export function PendingFileOperations({
  listing,
  disabled,
  setConfirmation,
}: {
  listing: FileListing;
  disabled: boolean;
  setConfirmation: Dispatch<
    SetStateAction<{ message: string; action: () => void } | undefined>
  >;
}) {
  const { run } = useFiles();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    if (notice) toast("info", notice);
  }, [notice]);

  return (
    <>
      {listing.pending.length > 0 && (
        <section className="pt-6">
          <h3 className="font-medium">Interrupted uploads</h3>
          <ul className="pt-2">
            {listing.pending.map(({ id, filename, error }) => (
              <li
                key={id}
                className="flex items-center gap-2 border-b border-border py-2"
              >
                <File className="size-4 shrink-0" />
                <span className="min-w-0 break-words text-sm">
                  {filename ?? "Unreadable pending upload"}
                </span>
                <Button
                  size="sm"
                  disabled={disabled || error !== undefined}
                  onClick={() =>
                    void run("Resuming upload", (service) => service.resume(id))
                  }
                >
                  Resume
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {listing.commands.length > 0 && (
        <section className="pt-6">
          <h3 className="font-medium">Unconfirmed file changes</h3>
          <p className="text-sm text-muted-foreground">
            Check the server result before retrying the original operation.
          </p>
          <ul>
            {listing.commands.map((command) => (
              <li key={command.resource} className="py-3">
                <p className="break-all text-sm">
                  {command.state === "unreadable"
                    ? "Unreadable pending file operation"
                    : `${command.type}, ${command.resource}`}
                </p>
                <div className="pt-2 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={disabled || command.state === "unreadable"}
                    onClick={() =>
                      void run("Checking file operation", async (service) => {
                        const result = await service.reconcileCommand(
                          command.resource,
                        );
                        setNotice(
                          result.outcome === "unknown"
                            ? "The result is still unknown. The original operation has been retained."
                            : `File operation ${result.outcome}.`,
                        );
                      })
                    }
                  >
                    Check result
                  </Button>
                  {command.state === "unreadable" && (
                    <Button
                      variant="destructive"
                      disabled={disabled}
                      onClick={() =>
                        setConfirmation({
                          message:
                            "Discard only this local recovery record? Its operation may already have been applied on the server. This cannot undo remote changes, and a replacement may duplicate them.",
                          action: () =>
                            void run(
                              "Discarding unreadable file operation",
                              command.discard,
                            ),
                        })
                      }
                    >
                      Discard local record
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    disabled={disabled || command.state === "unreadable"}
                    onClick={() => {
                      setConfirmation({
                        message:
                          "Retry the exact saved file operation? No new encryption or revision will be generated.",
                        action: () =>
                          void run("Retrying saved file operation", (service) =>
                            service.resumeCommand(command.resource),
                          ),
                      });
                    }}
                  >
                    Retry exact operation
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

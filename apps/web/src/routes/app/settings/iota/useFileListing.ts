import { useFiles } from "@/components/filesRuntime";
import { notify as toast } from "@nonanium/ui";
import type { createFileService } from "@tensamin/files/service";
import { useEffect, useState } from "react";

export function useFileListing(folderId: string) {
  const { service, revision } = useFiles();
  const [listing, setListing] = useState<{
    folders: Awaited<
      ReturnType<ReturnType<typeof createFileService>["folders"]>
    >;
    placements: Awaited<
      ReturnType<ReturnType<typeof createFileService>["placements"]>
    >;
    pending: Awaited<
      ReturnType<ReturnType<typeof createFileService>["pending"]>
    >;
    commands: Awaited<
      ReturnType<ReturnType<typeof createFileService>["pendingCommands"]>
    >;
  }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  useFileError(error);
  useEffect(() => {
    setListing(undefined);
  }, [service, folderId]);
  useEffect(() => {
    let active = true;
    setError(undefined);

    if (!service) return;
    setLoading(true);
    void Promise.all([
      service.folders(folderId),
      service.placements(folderId),
      service.pending().catch((error) => {
        if (active)
          setError(`Pending uploads could not be loaded: ${String(error)}`);
        return [];
      }),
      service.pendingCommands().catch((error) => {
        if (active)
          setError(
            `Pending file operations could not be loaded: ${String(error)}`,
          );
        return [];
      }),
    ])
      .then(
        ([folders, placements, pending, commands]) => {
          if (active) {
            setListing({ folders, placements, pending, commands });
            const failedUpload = pending.find((upload) => upload.error);
            if (failedUpload)
              toast(
                "error",
                "A pending upload could not be loaded",
                failedUpload.error,
              );
            const unreadable = commands.find(
              (command) => command.state === "unreadable",
            );
            if (unreadable && "error" in unreadable)
              toast(
                "error",
                "A pending file operation could not be loaded",
                unreadable.error,
              );
          }
        },
        (error) => {
          if (active) setError(String(error));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [service, folderId, revision]);

  return { listing, setListing, loading };
}
export type FileListing = NonNullable<
  ReturnType<typeof useFileListing>["listing"]
>;

export function useFileError(error?: string) {
  useEffect(() => {
    if (error) toast("error", "File operation failed", error);
  }, [error]);
}

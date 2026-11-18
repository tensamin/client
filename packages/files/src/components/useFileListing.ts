import { useFiles } from "../context";
import { notify as toast } from "@nonanium/ui";
import type { FileKey, FileMetadata } from "@tensamin/crypto/file";
import type { createFileService } from "../service";
import { parsePrincipal } from "@tensamin/shared/principal";
import { useEffect, useRef, useState } from "react";

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

  return { listing, setListing, loading, error };
}
export type FileListing = NonNullable<
  ReturnType<typeof useFileListing>["listing"]
>;

export function useFileError(error?: string) {
  useEffect(() => {
    if (error) toast("error", "File operation failed", error);
  }, [error]);
}

// Loads the key and metadata of every listed file so the page can sort by size.
export function useFileMetadata(
  sources: {
    id: string;
    origin: FileKey["origin"];
    file_id: string;
    key?: FileKey;
  }[],
) {
  const { service, revision } = useFiles();
  const [files, setFiles] = useState<
    Record<string, { key?: FileKey; metadata?: FileMetadata; error?: string }>
  >({});
  const [error, setError] = useState<string>();
  useFileError(error);
  // Results stay valid until the service or revision changes, so a new page only loads its own rows.
  const loaded = useRef({ generation: 0, requested: new Set<string>() });
  useEffect(() => {
    loaded.current = {
      generation: loaded.current.generation + 1,
      requested: new Set(),
    };
    setFiles({});
    setError(undefined);
  }, [service, revision]);
  useEffect(() => {
    if (!service) return;
    const { generation, requested } = loaded.current;

    for (const source of sources) {
      if (requested.has(source.id)) continue;
      requested.add(source.id);
      void (async () => {
        let key: FileKey | undefined;
        let file: (typeof files)[string];
        try {
          key =
            source.key ??
            (await service.fileKey(source.origin, source.file_id)) ??
            undefined;
          if (!key) throw new Error("No synchronized file is available");
          file = { key, metadata: await service.metadata(key) };
        } catch (error) {
          file = { key, error: String(error) };
          if (loaded.current.generation === generation) setError(String(error));
        }
        if (loaded.current.generation === generation)
          setFiles((files) => ({ ...files, [source.id]: file }));
      })();
    }
  }, [service, sources, revision]);

  return files;
}

export function useSharedListing(peer: string | null) {
  const { service, revision } = useFiles();
  const [page, setPage] =
    useState<
      Awaited<ReturnType<ReturnType<typeof createFileService>["chat"]>>
    >();
  const [error, setError] = useState<string>();
  useFileError(error);
  useEffect(() => {
    setPage(undefined);
  }, [service, peer]);
  useEffect(() => {
    let active = true;
    setError(undefined);

    if (!service || !peer) return;
    const principal = parsePrincipal(peer);
    void service
      .chat({ ...principal, user_id: BigInt(principal.user_id) })
      .then(
        (value) => {
          if (active) setPage(value);
        },
        (error) => {
          if (active) setError(String(error));
        },
      );

    return () => {
      active = false;
    };
  }, [service, peer, revision]);

  return { page, setPage, error };
}

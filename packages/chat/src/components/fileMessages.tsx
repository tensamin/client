import { Badge, Button, withTooltip } from "@nonanium/ui";
import {
  fileKeySchema,
  fileNameSchema,
  type FileKey,
  type FileMetadata,
} from "@tensamin/crypto/file";
import { encryptChatText } from "@tensamin/crypto/chatSecret";
import { encodePrincipal, parsePrincipal } from "@tensamin/shared/principal";
import { Download, File, FileIcon, Loader2, Square, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { RawMessage } from "../values";
import { stringifyExactJson } from "@tensamin/shared/exactJson";
import { z } from "zod";
import { useFiles } from "@tensamin/files/context";

const loadedFiles = new WeakMap<
  object,
  Map<string, { metadata: FileMetadata; state: string }>
>();

export type ChatFile = RawMessage["Files"][number];

const fileReferenceSchema = z.strictObject({
  origin: z.string(),
  file_id: fileKeySchema.shape.file_id,
  version: z.string().max(19),
  name: fileNameSchema,
});

export function chatFileReference(key: FileKey, name: string) {
  return JSON.stringify({
    origin: encodePrincipal(key.origin),
    file_id: key.file_id,
    version: String(key.version),
    name,
  });
}

export function encryptChatFiles(
  chatSecret: Uint8Array,
  version: number,
  files: ChatFile[],
) {
  return Promise.all(
    files.map(async ({ Content, Status }) => ({
      Content: await encryptChatText(chatSecret, Content, version),
      ...(Status && { Status }),
    })),
  );
}

export function withChatFileStatuses<T extends string | Uint8Array>(
  files: { Content: T; Status?: ChatFile["Status"] }[],
  offset: number,
  statuses: ChatFile["Status"][],
) {
  return files.map(({ Content, Status }, index) => {
    const next = index < offset ? Status : statuses[index - offset];
    return { Content, ...(next && { Status: next }) };
  });
}

export function parseChatFile(file: ChatFile, principal: string | undefined) {
  try {
    const value = fileReferenceSchema.parse(JSON.parse(file.Content));
    if (value.origin !== principal) return;
    const origin = parsePrincipal(value.origin);
    const key = fileKeySchema.parse({
      origin: { ...origin, user_id: BigInt(origin.user_id) },
      file_id: value.file_id,
      version: BigInt(value.version),
    });
    if (String(key.version) !== value.version) return;
    return { key, name: value.name, status: file.Status };
  } catch {
    return;
  }
}

export function chatMessagePreview(
  message: Pick<RawMessage, "Content" | "Files" | "Principal">,
) {
  if (message.Content) return message.Content;
  const [first, ...rest] = message.Files;
  if (!first) return "Empty message";
  const name = parseChatFile(first, message.Principal)?.name ?? "File";
  return rest.length > 0 ? `${name} +${rest.length}` : name;
}

export function ChatFiles({
  files,
  principal,
}: {
  files: ChatFile[];
  principal: string | undefined;
}) {
  const serialized = JSON.stringify(files);
  const attachments = useMemo(
    () =>
      (JSON.parse(serialized) as ChatFile[]).map((file) =>
        parseChatFile(file, principal),
      ),
    [serialized, principal],
  );
  return (
    <div className="flex flex-wrap gap-1 py-1">
      {attachments.map((attachment, index) => {
        return attachment ? (
          <ChatFileEmbed
            key={stringifyExactJson(attachment.key)}
            fileKey={attachment.key}
            name={attachment.name}
            status={attachment.status}
          />
        ) : (
          <Button key={index} variant="secondary" disabled>
            <X className="size-4 text-destructive" />
            Invalid file
          </Button>
        );
      })}
    </div>
  );
}

export function ChatFileChip({
  file,
  principal,
  onRemove,
}: {
  file: ChatFile;
  principal: string | undefined;
  onRemove(): void;
}) {
  const name = parseChatFile(file, principal)?.name ?? "Invalid file";
  return (
    <Badge
      variant="secondary"
      className="h-7 min-w-0 max-w-36 basis-36 shrink gap-1 border! border-border px-1.5"
    >
      <FileIcon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-semibold">{name}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        className="size-4! shrink-0 p-0!"
        onClick={onRemove}
      >
        <X className="size-3!" />
      </Button>
    </Badge>
  );
}

function ChatFileEmbed({
  fileKey,
  name,
  status,
}: {
  fileKey: FileKey;
  name: string;
  status?: ChatFile["Status"];
}) {
  const {
    service,
    start,
    revision,
    transfers,
    uploads,
    watch,
    requestDownload,
    fileErrors,
    busy,
  } = useFiles();
  const identity = stringifyExactJson(fileKey);
  const cached = service && loadedFiles.get(service)?.get(identity);
  const [metadata, setMetadata] = useState(cached?.metadata);
  const [state, setState] = useState(cached?.state);
  const [loading, setLoading] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string>();

  const pending = loading && !metadata;
  useEffect(() => start(), [start]);
  useEffect(() => {
    if (!service || status) return;
    let active = true;
    setLoading(true);
    void Promise.all([service.metadata(fileKey), service.manifest(fileKey)])
      .then(([metadata, manifest]) => {
        if (!active) return;
        setMetadata(metadata);
        setState(manifest.state);
        setError(undefined);
        const files = loadedFiles.get(service) ?? new Map();
        loadedFiles.set(
          service,
          files.set(identity, { metadata, state: manifest.state }),
        );
        if (manifest.state === "transferring") watch(fileKey);
      })
      .catch((error) => {
        if (active) {
          setState("unavailable");
          setError(String(error));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fileKey, identity, service, revision, watch, status]);
  const transfer = transfers[identity];
  const currentState =
    state === "unavailable" ? state : (transfer?.state ?? state);
  const ready = currentState === "ready";
  const upload = uploads[identity];
  const cancelled =
    status === "cancelled" ||
    (status === "uploading" && upload?.state === "cancelled");
  const uploading =
    status === "uploading" && !cancelled && upload?.state !== "failed";
  const failed =
    status === "failed" ||
    (status === "uploading" && upload?.state === "failed") ||
    currentState === "unavailable" ||
    currentState === "failed";
  const failure = failed
    ? (error ??
      transfer?.transfer?.error ??
      upload?.error ??
      (status === "failed" || upload?.state === "failed"
        ? "Upload failed"
        : "Transfer failed"))
    : fileErrors[identity];
  return withTooltip(
    <span className="inline-flex max-w-full items-center gap-1">
      <Button
        variant="secondary"
        className="h-auto max-w-full justify-start gap-2 border! border-border bg-muted! py-2 hover:bg-muted! focus-visible:bg-muted! aria-expanded:bg-muted! disabled:opacity-100"
        disabled={
          pending ||
          accepting ||
          failed ||
          cancelled ||
          uploading ||
          !metadata ||
          !!busy ||
          currentState === "transferring"
        }
        onClick={() => {
          if (ready) return requestDownload(fileKey);
          if (!service) return;

          setAccepting(true);
          void service
            .accept(fileKey)
            .then(
              () => requestDownload(fileKey),
              (error) => {
                setState("unavailable");
                setError(String(error));
              },
            )
            .finally(() => setAccepting(false));
        }}
      >
        {failed || cancelled ? (
          <X className={failed ? "size-4 text-destructive" : "size-4"} />
        ) : uploading ||
          pending ||
          accepting ||
          currentState === "transferring" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : ready ? (
          <Download className="size-4" />
        ) : (
          <File className="size-4" />
        )}
        <span className="min-w-0 truncate">
          {cancelled
            ? "Upload cancelled"
            : failed
              ? "File failed"
              : (metadata?.filename ?? name)}
        </span>
      </Button>
      {uploading &&
        upload?.state === "uploading" &&
        withTooltip(
          <Button
            variant="destructive"
            size="icon-xs"
            className="border-0! hover:bg-destructive! focus-visible:bg-destructive! aria-expanded:bg-destructive! disabled:opacity-100 rounded-xl"
            aria-label={`Cancel upload of ${name}`}
            onClick={upload.cancel}
          >
            <Square
              color="var(--foreground)"
              fill="var(--foreground)"
              className="size-2.5"
            />
          </Button>,
          "Cancel",
        )}
    </span>,
    failure,
  );
}

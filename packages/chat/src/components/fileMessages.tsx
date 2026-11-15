import { Button, notify, withTooltip } from "@nonanium/ui";
import {
  fileKeySchema,
  fileNameSchema,
  type FileKey,
  type FileMetadata,
} from "@tensamin/crypto/file";
import { encodePrincipal, parsePrincipal } from "@tensamin/shared/principal";
import { Download, File, Loader2, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatAttachmentRenderer } from "../values";
import { stringifyExactJson } from "@tensamin/shared/exactJson";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { z } from "zod";
import { useFiles } from "@tensamin/files/context";
import { base64ToBytes, bytesToBase64 } from "mtp";

const fileLinkProtocol = "tensamin-file:";
const fileLinkSchema = z.object({
  origin: z.string(),
  file_id: fileKeySchema.shape.file_id,
  version: z.string().max(19),
  name: fileNameSchema,
  status: z.enum(["uploading", "cancelled", "failed"]).optional(),
});

export function chatFileLink(
  key: FileKey,
  name: string,
  status?: z.infer<typeof fileLinkSchema>["status"],
) {
  const value = bytesToBase64(
    new TextEncoder().encode(
      JSON.stringify({
        origin: encodePrincipal(key.origin),
        file_id: key.file_id,
        version: String(key.version),
        name,
        status,
      }),
    ),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return toMarkdown({
    type: "link",
    url: `${fileLinkProtocol}${value}`,
    children: [{ type: "text", value: name }],
  }).trim();
}

export function composeChatFileMessage(caption: string, links: string) {
  if (!caption.trim()) return links;
  const lastBlock = fromMarkdown(caption).children.at(-1);
  const start = lastBlock?.position?.start;
  if (start?.offset !== undefined) {
    let normalized: string | undefined;
    if (lastBlock?.type === "code") {
      normalized = toMarkdown(lastBlock, { fences: true }).trimEnd();
    } else if (
      lastBlock?.type === "html" &&
      fromMarkdown(`${caption}\n\n${links}`).children.at(-1)?.type === "html"
    ) {
      normalized = toMarkdown({
        type: "paragraph",
        children: [{ type: "text", value: lastBlock.value }],
      }).trimEnd();
    }
    if (normalized !== undefined)
      caption = caption.slice(0, start.offset - start.column + 1) + normalized;
  }
  return `${caption}${caption.trim() ? "\n\n" : ""}${links}`;
}

function parseChatFileLink(url: string, principal: string | undefined) {
  if (!url.startsWith(fileLinkProtocol)) return;
  try {
    const encoded = url.slice(fileLinkProtocol.length);
    const json = new TextDecoder("utf-8", { fatal: true }).decode(
      base64ToBytes(
        encoded
          .replace(/-/g, "+")
          .replace(/_/g, "/")
          .padEnd(Math.ceil(encoded.length / 4) * 4, "="),
      ),
    );
    const value = fileLinkSchema.parse(JSON.parse(json));
    if (value.origin !== principal) return;
    const origin = parsePrincipal(value.origin);
    const key = fileKeySchema.parse({
      origin: { ...origin, user_id: BigInt(origin.user_id) },
      file_id: value.file_id,
      version: BigInt(value.version),
    });
    if (String(key.version) !== value.version) return;
    return { key, name: value.name, status: value.status };
  } catch {
    // Invalid attachment links remain ordinary message text.
    return;
  }
}

function ChatFileContent({
  content,
  principal,
  renderBody,
}: {
  content: string;
  principal?: string;
  renderBody: (body: string) => ReactNode;
}) {
  const parsed = useMemo(() => {
    const attachments: {
      key: FileKey;
      name: string;
      status?: z.infer<typeof fileLinkSchema>["status"];
    }[] = [];
    const lines = content.split("\n");
    for (const paragraph of fromMarkdown(content).children) {
      if (paragraph.type !== "paragraph") continue;
      for (const link of paragraph.children) {
        if (link.type !== "link" || !link.url.startsWith(fileLinkProtocol))
          continue;
        const position = link.position;
        if (!position || position.start.line !== position.end.line) continue;
        const index = position.start.line - 1;
        if (
          lines[index]?.trim() !==
          content.slice(position.start.offset, position.end.offset)
        )
          continue;
        const attachment = parseChatFileLink(link.url, principal);
        if (!attachment) continue;
        attachments.push(attachment);
        lines[index] = "";
      }
    }
    return { body: lines.join("\n").trim(), attachments };
  }, [content, principal]);

  if (parsed.attachments.length === 0) return renderBody(content);

  return (
    <div className="min-w-0 flex-1">
      {parsed.body && renderBody(parsed.body)}
      <div className="flex flex-wrap gap-1 py-1">
        {parsed.attachments.map((attachment) => (
          <ChatFileEmbed
            key={stringifyExactJson(attachment.key)}
            fileKey={attachment.key}
            name={attachment.name}
            status={attachment.status}
          />
        ))}
      </div>
    </div>
  );
}

function ChatFileEmbed({
  fileKey,
  name,
  status,
}: {
  fileKey: FileKey;
  name: string;
  status?: z.infer<typeof fileLinkSchema>["status"];
}) {
  const {
    service,
    start,
    revision,
    transfers,
    uploads,
    watch,
    run,
    download,
    busy,
  } = useFiles();
  const [metadata, setMetadata] = useState<FileMetadata>();
  const [state, setState] = useState<string>();
  const [loading, setLoading] = useState(false);
  const reportedError = useRef(false);
  const identity = stringifyExactJson(fileKey);
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
        reportedError.current = false;
        if (manifest.state === "transferring") watch(fileKey);
      })
      .catch((error) => {
        if (active) {
          setState("unavailable");
          if (!reportedError.current) {
            reportedError.current = true;
            notify("error", "Couldn't load shared file", String(error));
          }
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fileKey, service, revision, watch, status]);
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
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <Button
        variant="secondary"
        className="h-auto max-w-full justify-start gap-2 border! border-border bg-muted! py-2 hover:bg-muted! focus-visible:bg-muted! aria-expanded:bg-muted! disabled:opacity-100"
        disabled={
          loading ||
          failed ||
          cancelled ||
          uploading ||
          !metadata ||
          !!busy ||
          currentState === "transferring"
        }
        onClick={() => {
          if (ready) {
            void download(fileKey, true);
            return;
          }
          void run("Accepting shared file", async (service) => {
            await service.accept(fileKey);
            watch(fileKey);
          });
        }}
      >
        {failed || cancelled ? (
          <X className={failed ? "size-4 text-destructive" : "size-4"} />
        ) : uploading || loading || currentState === "transferring" ? (
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
    </span>
  );
}

export const renderChatAttachments: ChatAttachmentRenderer = (
  content,
  principal,
  renderBody,
) => {
  return content.includes(fileLinkProtocol) ? (
    <ChatFileContent
      content={content}
      principal={principal}
      renderBody={renderBody}
    />
  ) : null;
};

renderChatAttachments.renderLink = (url, principal) => {
  const attachment = parseChatFileLink(url, principal);
  return attachment ? (
    <ChatFileEmbed
      fileKey={attachment.key}
      name={attachment.name}
      status={attachment.status}
    />
  ) : undefined;
};

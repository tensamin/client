import { Button, notify } from "@nonanium/ui";
import {
  fileKeySchema,
  fileNameSchema,
  type FileKey,
  type FileMetadata,
} from "@tensamin/crypto/file";
import { encodePrincipal, parsePrincipal } from "@tensamin/shared/principal";
import { Download, File, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatAttachmentRenderer } from "@tensamin/chat/values";
import { stringifyExactJson } from "@tensamin/shared/exactJson";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { z } from "zod";
import { useFiles } from "./filesRuntime";

const fileLinkProtocol = "tensamin-file:";
const fileLinkSchema = z.object({
  origin: z.string(),
  file_id: fileKeySchema.shape.file_id,
  version: z.string().max(19),
  name: fileNameSchema,
});

export function chatFileLink(key: FileKey, name: string) {
  const value = encodeURIComponent(
    JSON.stringify({
      origin: encodePrincipal(key.origin),
      file_id: key.file_id,
      version: String(key.version),
      name,
    }),
  );
  return toMarkdown({
    type: "link",
    url: `${fileLinkProtocol}${value}`,
    children: [{ type: "text", value: name }],
  }).trim();
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
    const attachments: { key: FileKey; name: string }[] = [];
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
        try {
          const value = fileLinkSchema.parse(
            JSON.parse(
              decodeURIComponent(link.url.slice(fileLinkProtocol.length)),
            ),
          );
          if (value.origin !== principal) continue;
          const origin = parsePrincipal(value.origin);
          const key = fileKeySchema.parse({
            origin: { ...origin, user_id: BigInt(origin.user_id) },
            file_id: value.file_id,
            version: BigInt(value.version),
          });
          if (String(key.version) !== value.version) continue;
          attachments.push({ key, name: value.name });
          lines[index] = "";
        } catch {
          // Invalid attachment links remain ordinary message text.
        }
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
          />
        ))}
      </div>
    </div>
  );
}

function ChatFileEmbed({ fileKey, name }: { fileKey: FileKey; name: string }) {
  const { service, start, revision, transfers, watch, run, download, busy } =
    useFiles();
  const [metadata, setMetadata] = useState<FileMetadata>();
  const [state, setState] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const reportedError = useRef(false);
  const identity = stringifyExactJson(fileKey);
  useEffect(() => start(), [start]);
  useEffect(() => {
    if (!service) return;
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
  }, [fileKey, service, revision, watch, attempt]);
  const transfer = transfers[identity];
  const currentState =
    state === "unavailable" ? state : (transfer?.state ?? state);
  const ready = currentState === "ready";
  return (
    <Button
      variant="outline"
      className="h-auto max-w-full justify-start gap-2 py-2"
      disabled={
        loading ||
        (!metadata && currentState !== "unavailable") ||
        !!busy ||
        currentState === "transferring"
      }
      onClick={() => {
        if (currentState === "unavailable") {
          void run("Reaccepting shared file", async (service) => {
            await service.accept(fileKey);
            watch(fileKey);
            setAttempt((value) => value + 1);
          });
          return;
        }
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
      {loading || currentState === "transferring" ? (
        <Loader2 className="size-4 animate-spin" />
      ) : ready ? (
        <Download className="size-4" />
      ) : (
        <File className="size-4" />
      )}
      <span className="min-w-0 truncate">{metadata?.filename ?? name}</span>
      {currentState === "unavailable" && <span className="text-xs">Retry</span>}
    </Button>
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

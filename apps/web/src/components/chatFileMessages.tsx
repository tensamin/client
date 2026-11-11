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
import { useFiles } from "./filesRuntime";

export function chatFileLink(key: FileKey, name: string) {
  const value = encodeURIComponent(
    JSON.stringify({
      origin: encodePrincipal(key.origin),
      file_id: key.file_id,
      version: String(key.version),
      name,
    }),
  ).replace(/[()]/g, (character) => (character === "(" ? "%28" : "%29"));
  return `[${name.replace(/[\\[\]]/g, "\\$&")}](tensamin-file:${value})`;
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
    const body = content
      .replace(
        /^\[[^\n]*\]\(tensamin-file:([^\s)]+)\)$/gm,
        (line, token: string) => {
          try {
            const value = JSON.parse(decodeURIComponent(token));
            if (
              typeof value.origin !== "string" ||
              typeof value.version !== "string" ||
              !/^[1-9]\d{0,18}$/.test(value.version) ||
              value.origin !== principal
            )
              return line;
            const origin = parsePrincipal(value.origin);
            const key = fileKeySchema.parse({
              origin: { ...origin, user_id: BigInt(origin.user_id) },
              file_id: value.file_id,
              version: BigInt(value.version),
            });
            attachments.push({ key, name: fileNameSchema.parse(value.name) });
            return "";
          } catch {
            return line;
          }
        },
      )
      .trim();
    return { body, attachments };
  }, [content, principal]);

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
  return content.includes("(tensamin-file:") ? (
    <ChatFileContent
      content={content}
      principal={principal}
      renderBody={renderBody}
    />
  ) : null;
};

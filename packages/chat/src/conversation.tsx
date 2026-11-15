import {
  Badge,
  Button,
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
  Hint,
  HintContent,
  HintTrigger,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
  useIsMobile,
} from "@nonanium/ui";
import { Markdown } from "@nonanium/ui/markdown";
import ChatScreen from "./screen";
import { useChat } from "./context";
import {
  formatFileAccessDuration,
  parseFileAccessDuration,
  useFileAccess,
  useFileAccessInfo,
} from "@tensamin/files/access";
import { normalizeFileName, type FileKey } from "@tensamin/crypto/file";
import { useSession } from "@tensamin/identity/session";
import { useMTP } from "@tensamin/mtp";
import { parsePrincipal } from "@tensamin/shared/principal";
import { FileIcon, Plus, X, RotateCcw, Upload, ArrowLeft } from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { useFiles } from "@tensamin/files/context";
import { nextGrantRevision } from "@tensamin/files/service";
import {
  chatFileLink,
  composeChatFileMessage,
  renderChatAttachments,
} from "./components/fileMessages";

type QueuedFile = {
  id: string;
  file: File;
  preview?: string;
  duration?: string;
};

export default function ChatConversation() {
  const { userId, accountKey, conversationKey, composerController } = useChat();
  const { contacts } = useSession();
  const recipient = contacts.find(
    (contact) => contact.UserId === userId,
  )?.Principal;
  const { contextReady } = useMTP();
  const { start, service, busy, run, error, retry } = useFiles();
  const queueKey = `${accountKey}:${conversationKey}`;
  const [queues, setQueues] = useState<Record<string, QueuedFile[]>>({});
  const queued = queues[queueKey] ?? [];
  const access = useFileAccess(userId, queued.length > 0);
  const info = useFileAccessInfo();
  const showFileAccessInfo = useEffectEvent(() => {
    void info.showInfo();
  });
  useEffect(() => {
    if (contextReady && queued.length > 0) showFileAccessInfo();
  }, [contextReady, queued.length]);
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const fileBusy = !!busy || sending;
  const [editingFileId, setEditingFileId] = useState<string>();
  const editingFile = queued.find((file) => file.id === editingFileId);
  const isMobile = useIsMobile();
  const picker = useRef<HTMLInputElement>(null);
  const drawerContent = useRef<HTMLDivElement>(null);
  const previews = useRef(new Set<string>());
  const preparedFiles = useRef(
    new Map<
      string,
      {
        key?: FileKey;
        uploadId?: string;
        sharedUntil?: number;
        grantDays?: number;
      }
    >(),
  );

  useEffect(() => {
    if (queued.length > 0) return start();
  }, [queued.length, start]);
  useEffect(() => {
    setExpanded(false);
    setEditingFileId(undefined);
  }, [queueKey]);
  useEffect(() => {
    if (!isMobile && queued.length <= 5) setExpanded(false);
  }, [queued.length, isMobile]);
  useEffect(() => {
    setQueues({});
    const urls = previews.current;
    const prepared = preparedFiles.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
      prepared.clear();
    };
  }, [accountKey]);

  function release(file: QueuedFile) {
    if (file.preview) {
      URL.revokeObjectURL(file.preview);
      previews.current.delete(file.preview);
    }
    preparedFiles.current.delete(file.id);
  }

  function renderFile(file: QueuedFile, fullWidth = false) {
    return (
      <QueuedFileBadge
        key={file.id}
        file={file}
        fullWidth={fullWidth}
        onConfigure={isMobile ? () => setEditingFileId(file.id) : undefined}
        defaultDays={access.days}
        disabled={fileBusy}
        onDuration={(duration) => updateDuration(file.id, duration)}
        onRemove={() => {
          setQueues((current) => ({
            ...current,
            [queueKey]: (current[queueKey] ?? []).filter(
              (item) => item.id !== file.id,
            ),
          }));
          release(file);
        }}
      />
    );
  }

  function updateDuration(id: string, duration: string | undefined) {
    setQueues((current) => ({
      ...current,
      [queueKey]: (current[queueKey] ?? []).map((file) =>
        file.id === id ? { ...file, duration } : file,
      ),
    }));
  }

  const retryControl =
    !service && error ? (
      <Button variant="outline" size="sm" disabled={fileBusy} onClick={retry}>
        Retry file uploads
      </Button>
    ) : null;
  const allFiles = (
    <div className="flex max-h-[60dvh] min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain p-2">
      {isMobile && retryControl}
      {queued.map((file) => renderFile(file, true))}
    </div>
  );
  const overflowTrigger = (
    <Button variant="ghost" size="xs" className="shrink-0">
      + {queued.length - 5}
    </Button>
  );
  const uploadControl = (
    <Hint
      open={!!info.noticeOpen}
      onOpenChange={(next, details) => {
        if (!next) {
          details.cancel();
          void info.dismissInfo();
        }
      }}
    >
      <HintTrigger
        render={
          <Button
            variant={isMobile ? "default" : "ghost"}
            className={isMobile ? undefined : "h-9! w-9 p-0"}
            disabled={!recipient || fileBusy}
            onClick={(event) => {
              event.preventDefault();
              picker.current?.click();
            }}
          >
            {isMobile ? (
              <>
                <Upload className="size-4" />
                Upload files
              </>
            ) : (
              <Plus size={20} />
            )}
          </Button>
        }
      />
      <HintContent
        side="top"
        align="start"
        portalProps={isMobile ? { container: drawerContent } : undefined}
        finalFocus={() => {
          if (isMobile || !composerController.current) return true;
          composerController.current.focus();
          return false;
        }}
      >
        <PopoverTitle>File access</PopoverTitle>
        <PopoverDescription className="text-primary-foreground">
          Access expires after one year by default. Change a contact's default
          in Customise chat, or set an expiry for an individual file.
        </PopoverDescription>
      </HintContent>
    </Hint>
  );

  const invalid = queued.some(
    (file) =>
      file.duration !== undefined &&
      parseFileAccessDuration(file.duration) === undefined,
  );
  const unavailableReason =
    queued.length === 0
      ? undefined
      : !contextReady
        ? "Reconnect to send attachments"
        : fileBusy
          ? "A file operation is in progress"
          : invalid
            ? "Fix the highlighted file access expiry"
            : !service
              ? error
                ? "File uploads failed to start. Retry file uploads."
                : "Preparing file uploads"
              : access.days === undefined
                ? "Loading file access settings"
                : undefined;
  return (
    <ChatScreen
      renderAttachments={renderChatAttachments}
      attachments={{
        count: queued.length,
        busy: unavailableReason !== undefined,
        unavailableReason,
        onSendingChange: setSending,
        prepare: async (caption) => {
          if (!recipient || access.days === undefined || invalid) return;
          const peer = parsePrincipal(recipient);
          const target = { ...peer, user_id: BigInt(peer.user_id) };
          const selected = [...queued];
          const suffix = await run(
            "Preparing message attachments",
            async (service) => {
              const links: string[] = [];
              for (const item of selected) {
                const days =
                  item.duration === undefined
                    ? access.days!
                    : parseFileAccessDuration(item.duration);
                if (days === undefined)
                  throw new Error("Choose a valid file access expiry");
                let prepared = preparedFiles.current.get(item.id);
                if (!prepared) {
                  prepared = {};
                  preparedFiles.current.set(item.id, prepared);
                }
                const record = prepared;
                if (!record.key) {
                  const manifest = record.uploadId
                    ? await service.resume(record.uploadId)
                    : await service.upload({
                        file: item.file,
                        filename: normalizeFileName(item.file.name),
                        mimeType: item.file.type || "application/octet-stream",
                        onPrepared: (id) => {
                          record.uploadId = id;
                        },
                      });
                  record.key = manifest.key;
                  record.uploadId = undefined;
                }
                if (
                  record.grantDays !== days ||
                  !record.sharedUntil ||
                  record.sharedUntil <= Date.now()
                ) {
                  const expiresAt = Date.now() + days * 86400000;
                  await service.share({
                    key: record.key,
                    recipient: target,
                    expiresAt: BigInt(expiresAt),
                    grantRevision: await nextGrantRevision(
                      service,
                      record.key,
                      target,
                    ),
                  });
                  record.sharedUntil = expiresAt;
                  record.grantDays = days;
                }
                links.push(
                  chatFileLink(record.key, normalizeFileName(item.file.name)),
                );
              }
              await service.synchronize();
              return links.join("\n");
            },
            false,
          );
          if (!suffix) return;
          return {
            content: composeChatFileMessage(caption, suffix),
            complete: () => {
              const ids = new Set(selected.map((file) => file.id));
              setQueues((current) => ({
                ...current,
                [queueKey]: (current[queueKey] ?? []).filter(
                  (file) => !ids.has(file.id),
                ),
              }));
              selected.forEach(release);
            },
          };
        },
      }}
      uploadAction={
        <div className="flex min-w-0 items-center gap-1">
          <input
            ref={picker}
            type="file"
            multiple
            className="sr-only"
            disabled={!recipient || fileBusy}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (!files.length) return;
              const additions = files.map((file) => {
                const preview = /^image\/(png|jpeg|webp|gif|avif)$/.test(
                  file.type,
                )
                  ? URL.createObjectURL(file)
                  : undefined;
                if (preview) previews.current.add(preview);
                return { id: crypto.randomUUID(), file, preview };
              });
              setQueues((current) => ({
                ...current,
                [queueKey]: [...(current[queueKey] ?? []), ...additions],
              }));
              event.target.value = "";
              if (!isMobile) composerController.current?.focus();
            }}
          />
          {isMobile ? (
            <>
              <Drawer
                open={expanded}
                onOpenChange={(next) => {
                  setExpanded(next);
                  setEditingFileId(undefined);
                }}
              >
                <DrawerTrigger asChild>
                  <Button
                    variant="ghost"
                    className="h-9! w-9 p-0"
                    disabled={!recipient}
                  >
                    <Plus size={20} />
                  </Button>
                </DrawerTrigger>
                <DrawerContent ref={drawerContent} className="max-h-[85dvh]">
                  {editingFile ? (
                    <>
                      <div className="flex items-center gap-2 px-4 pt-4">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setEditingFileId(undefined)}
                        >
                          <ArrowLeft className="size-4" />
                        </Button>
                        <DrawerTitle>File access</DrawerTitle>
                      </div>
                      <div className="flex max-h-[60dvh] min-w-0 flex-col gap-3 overflow-y-auto p-4">
                        <p className="break-all font-semibold">
                          {editingFile.file.name}
                        </p>
                        <FileExpiryFields
                          file={editingFile}
                          defaultDays={access.days}
                          disabled={fileBusy}
                          onDuration={(duration) =>
                            updateDuration(editingFile.id, duration)
                          }
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center justify-between gap-2 px-4 pt-4">
                        <DrawerTitle>Attachments</DrawerTitle>
                        {uploadControl}
                      </div>
                      {allFiles}
                    </>
                  )}
                </DrawerContent>
              </Drawer>
              {queued.length > 0 && (
                <Badge variant={invalid ? "destructive" : "secondary"}>
                  {queued.length}
                </Badge>
              )}
            </>
          ) : (
            <>
              {uploadControl}
              {retryControl}
              <div className="flex min-w-0 flex-1 items-center gap-1">
                {queued.slice(0, 5).map((file) => renderFile(file))}
                {queued.length > 5 && (
                  <Popover open={expanded} onOpenChange={setExpanded}>
                    <PopoverTrigger render={overflowTrigger} />
                    <PopoverContent
                      side="top"
                      align="start"
                      className="w-[min(36rem,calc(100vw-2rem))]"
                    >
                      <PopoverTitle>Attachments</PopoverTitle>
                      {allFiles}
                    </PopoverContent>
                  </Popover>
                )}
              </div>
            </>
          )}
        </div>
      }
    />
  );
}

function QueuedFileBadge({
  file,
  defaultDays,
  disabled,
  onDuration,
  onRemove,
  fullWidth = false,
  onConfigure,
}: {
  file: QueuedFile;
  defaultDays?: number;
  disabled: boolean;
  onDuration(duration: string | undefined): void;
  onRemove(): void;
  fullWidth?: boolean;
  onConfigure?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const invalid =
    file.duration !== undefined &&
    parseFileAccessDuration(file.duration) === undefined;
  const heldPress = useRef<
    { timer: ReturnType<typeof setTimeout>; x: number; y: number } | undefined
  >(undefined);
  const cancelPress = useCallback(() => {
    if (heldPress.current) clearTimeout(heldPress.current.timer);
    heldPress.current = undefined;
  }, []);
  useEffect(() => () => cancelPress(), [cancelPress]);
  const removeButton = (
    <Button
      variant="ghost"
      size="icon-xs"
      className={cn(
        "shrink-0 p-0!",
        fullWidth ? "size-6!" : "size-4!",
        file.preview && !fullWidth && "mr-1.5",
      )}
      disabled={disabled}
      onClick={onRemove}
    >
      <X className="size-3!" />
    </Button>
  );
  const preview = file.preview ? (
    <span
      className={cn(
        "flex shrink-0 overflow-hidden",
        fullWidth ? "size-5 rounded-sm" : "size-6.5 border-r border-border",
      )}
    >
      <img
        src={file.preview}
        alt=""
        loading="lazy"
        decoding="async"
        className="size-full object-cover"
      />
    </span>
  ) : (
    <FileIcon className="size-4 shrink-0" />
  );
  if (onConfigure)
    return (
      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border p-2">
        <Button
          variant="ghost"
          className={cn(
            "h-auto! min-w-0 flex-1 justify-start gap-2 whitespace-normal px-0 font-semibold",
            invalid && "ring-3 ring-destructive/20 dark:ring-destructive/40",
          )}
          disabled={disabled}
          onClick={(event) => {
            if (event.detail === 0) onConfigure();
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            cancelPress();
            onConfigure();
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || disabled) return;
            cancelPress();
            heldPress.current = {
              x: event.clientX,
              y: event.clientY,
              timer: setTimeout(() => {
                heldPress.current = undefined;
                onConfigure();
              }, 500),
            };
          }}
          onPointerMove={(event) => {
            const press = heldPress.current;
            if (
              press &&
              Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8
            )
              cancelPress();
          }}
          onPointerUp={cancelPress}
          onPointerCancel={cancelPress}
          onPointerLeave={cancelPress}
        >
          {preview}
          <span className="min-w-0 break-all text-left">{file.file.name}</span>
        </Button>
        {removeButton}
      </div>
    );
  const badge = (
    <Badge
      variant={invalid ? "destructive" : "secondary"}
      className={cn(
        "min-w-0 border! border-border outline-none",
        fullWidth
          ? "h-auto min-h-7 w-full max-w-full basis-auto justify-start gap-2 px-2 py-1"
          : "h-7 max-w-28 basis-28 shrink gap-1 px-1.5",
        file.preview && !fullWidth && "p-0",
      )}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className={cn(
              "min-w-0 flex-1 shrink justify-start gap-1 overflow-hidden p-0! hover:bg-transparent! focus-visible:bg-transparent! aria-expanded:bg-transparent!",
              fullWidth ? "h-auto! min-h-5" : "h-6.5! rounded-none",
            )}
            disabled={disabled}
            onContextMenu={(event) => {
              event.preventDefault();
              setOpen(true);
            }}
          >
            {preview}
            <span
              className={cn(
                "min-w-0 font-semibold",
                fullWidth
                  ? "whitespace-normal break-all text-left"
                  : "truncate text-left",
              )}
            >
              {file.file.name}
            </span>
          </Button>
        }
      />
      {removeButton}
    </Badge>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip disabled={open}>
        <TooltipTrigger render={badge} />
        <TooltipContent className="max-w-[min(40rem,calc(100vw-2rem))] overflow-hidden border border-border bg-popover p-0 text-popover-foreground [&>div:last-child]:hidden">
          <QueuedFilePreview file={file} />
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="start">
        <PopoverTitle className="break-words font-semibold">
          {file.file.name}
        </PopoverTitle>
        <FileExpiryFields
          file={file}
          defaultDays={defaultDays}
          disabled={disabled}
          onDuration={onDuration}
        />
      </PopoverContent>
    </Popover>
  );
}

function QueuedFilePreview({ file }: { file: QueuedFile }) {
  const [content, setContent] = useState<string | null>();
  useEffect(() => {
    if (file.preview) return;
    let active = true;
    setContent(undefined);
    void file.file
      .slice(0, 16384)
      .arrayBuffer()
      .then((buffer) => {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer, {
          stream: file.file.size > buffer.byteLength,
        });
        if (/\p{Cc}/u.test(text.replace(/[\t\n\r]/g, "")))
          throw new Error("Binary file");
        const lines = text
          .split(/\r?\n/)
          .slice(0, 16)
          .join("\n")
          .slice(0, 4000);
        const fence = "`".repeat(
          Math.max(
            3,
            ...(lines.match(/`+/g) ?? []).map((run) => run.length + 1),
          ),
        );
        const language = file.file.name.includes(".")
          ? file.file.name
              .split(".")
              .at(-1)!
              .toLowerCase()
              .replace(/[^a-z0-9]/g, "")
          : "";
        if (active) setContent(`${fence}${language}\n${lines}\n${fence}`);
      })
      .catch(() => {
        if (active) setContent(null);
      });
    return () => {
      active = false;
    };
  }, [file.file, file.preview]);

  if (file.preview)
    return (
      <img
        src={file.preview}
        alt={file.file.name}
        decoding="async"
        className="max-h-[min(32rem,75dvh)] max-w-full object-contain"
      />
    );
  if (content === undefined)
    return <span className="p-3">Loading preview...</span>;
  if (content === null)
    return (
      <span className="p-3">No preview available for {file.file.name}</span>
    );
  return (
    <Markdown
      content={content}
      className="max-h-[min(32rem,75dvh)] w-[min(40rem,calc(100vw-2rem))] overflow-auto [&_[data-slot=code-block]]:m-0! [&_[data-slot=code-block]]:rounded-none [&_[data-slot=code-block]]:border-0"
    />
  );
}

function FileExpiryFields({
  file,
  defaultDays,
  disabled,
  onDuration,
}: {
  file: QueuedFile;
  defaultDays?: number;
  disabled: boolean;
  onDuration(duration: string | undefined): void;
}) {
  const duration =
    file.duration ??
    (defaultDays === undefined ? "" : formatFileAccessDuration(defaultDays));
  return (
    <>
      <Label htmlFor={`expiry-${file.id}`}>Access expiry</Label>
      <div className="flex items-center gap-1">
        <Input
          id={`expiry-${file.id}`}
          value={duration}
          className={
            file.duration !== undefined &&
            parseFileAccessDuration(file.duration) === undefined
              ? "ring-3 ring-destructive/20 dark:ring-destructive/40"
              : undefined
          }
          disabled={disabled || defaultDays === undefined}
          onChange={(event) => onDuration(event.target.value)}
        />
        <Button
          variant="ghost"
          size="icon"
          disabled={disabled || defaultDays === undefined}
          onClick={() => onDuration(undefined)}
        >
          <RotateCcw className="size-4" />
        </Button>
      </div>
    </>
  );
}

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
  notify,
  withTooltip,
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
import { stringifyExactJson } from "@tensamin/shared/exactJson";
import { MAX_MESSAGE_FILES } from "@tensamin/shared/data";
import {
  FileIcon,
  Plus,
  Square,
  X,
  RotateCcw,
  Upload,
  ArrowLeft,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { useFiles } from "@tensamin/files/context";
import { chatFileReference } from "./components/fileMessages";
import { useFileSettlements } from "./settlements";
import type { ComposerAttachments, EditAttachments } from "./values";

type QueuedFile = {
  id: string;
  file: File;
  preview?: string;
  duration?: string;
  key?: FileKey;
};

export default function ChatConversation() {
  const { userId, accountKey, conversationKey, composerController } = useChat();
  const { contacts } = useSession();
  const recipient = contacts.find(
    (contact) => contact.UserId === userId,
  )?.Principal;
  const { contextReady } = useMTP();
  const { start, service, busy, uploads, startUpload, error, retry } =
    useFiles();
  const queueKey = `${accountKey}:${conversationKey}`;
  const editKey = `${queueKey}:edit`;
  const [queues, setQueues] = useState<Record<string, QueuedFile[]>>({});
  const queued = useMemo(() => queues[queueKey] ?? [], [queues, queueKey]);
  const editQueued = useMemo(() => queues[editKey] ?? [], [queues, editKey]);
  const access = useFileAccess(userId);
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
  const editPicker = useRef<HTMLInputElement>(null);
  const drawerContent = useRef<HTMLDivElement>(null);
  const previews = useRef(new Set<string>());
  const preparedFiles = useRef(new Map<string, FileKey>());

  useEffect(() => {
    if (queued.length > 0 || editQueued.length > 0) return start();
  }, [queued.length, editQueued.length, start]);
  useEffect(() => {
    if (!service) return;
    for (const [queue, files] of [
      [queueKey, queued],
      [editKey, editQueued],
    ] as const) {
      if (files.every((item) => item.key)) continue;
      const next = files.map((item) => {
        if (item.key) return item;
        let key = preparedFiles.current.get(item.id);
        if (!key) {
          key = startUpload(item.file);
          preparedFiles.current.set(item.id, key);
        }
        return { ...item, key };
      });
      setQueues((current) => ({ ...current, [queue]: next }));
    }
  }, [service, queued, editQueued, queueKey, editKey, startUpload]);
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

  function removeFile(queue: string, file: QueuedFile) {
    if (file.key) {
      const upload = uploads[stringifyExactJson(file.key)];
      if (upload?.state === "uploading") upload.cancel();
    }
    setQueues((current) => ({
      ...current,
      [queue]: (current[queue] ?? []).filter((item) => item.id !== file.id),
    }));
    release(file);
  }

  function renderFile(queue: string, file: QueuedFile, fullWidth = false) {
    return (
      <QueuedFileBadge
        key={file.id}
        file={file}
        fullWidth={fullWidth}
        onConfigure={
          isMobile && queue === queueKey
            ? () => setEditingFileId(file.id)
            : undefined
        }
        defaultDays={access.days}
        disabled={fileBusy}
        onDuration={(duration) => updateDuration(queue, file.id, duration)}
        onRemove={() => removeFile(queue, file)}
      />
    );
  }

  function updateDuration(
    queue: string,
    id: string,
    duration: string | undefined,
  ) {
    setQueues((current) => ({
      ...current,
      [queue]: (current[queue] ?? []).map((file) =>
        file.id === id ? { ...file, duration } : file,
      ),
    }));
  }

  function addFiles(queue: string, input: HTMLInputElement, reserved = 0) {
    const selected = Array.from(input.files ?? []);
    input.value = "";
    const available = Math.max(
      MAX_MESSAGE_FILES - reserved - (queues[queue]?.length ?? 0),
      0,
    );
    if (selected.length > available)
      notify(
        "error",
        "Too many files",
        `A message can have at most ${MAX_MESSAGE_FILES} files.`,
      );
    const files = selected.slice(0, available);
    if (!files.length) return;
    const additions = files.map((file) => {
      const id = crypto.randomUUID();
      const key = service ? startUpload(file) : undefined;
      if (key) preparedFiles.current.set(id, key);
      const preview = /^image\/(png|jpeg|webp|gif|avif)$/.test(file.type)
        ? URL.createObjectURL(file)
        : undefined;
      if (preview) previews.current.add(preview);
      return { id, key, file, preview };
    });
    setQueues((current) => ({
      ...current,
      [queue]: [...(current[queue] ?? []), ...additions],
    }));
  }

  function hasInvalidExpiry(files: QueuedFile[]) {
    return files.some(
      (file) =>
        file.duration !== undefined &&
        parseFileAccessDuration(file.duration) === undefined,
    );
  }

  function queueState(files: QueuedFile[]) {
    const unavailableReason =
      files.length === 0
        ? undefined
        : !contextReady
          ? "Reconnect to send attachments"
          : fileBusy
            ? "A file operation is in progress"
            : hasInvalidExpiry(files)
              ? "Fix the highlighted file access expiry"
              : !service || files.some((file) => !file.key)
                ? error
                  ? "File uploads failed to start. Retry file uploads."
                  : "Preparing file uploads"
                : access.days === undefined
                  ? "Loading file access settings"
                  : undefined;
    return {
      count: files.length,
      busy: unavailableReason !== undefined,
      unavailableReason,
      onSendingChange: setSending,
    };
  }

  async function prepareFiles(
    queue: string,
    files: QueuedFile[],
  ): ReturnType<ComposerAttachments["prepare"]> {
    if (!recipient || access.days === undefined || hasInvalidExpiry(files))
      return;
    const selected = [...files];
    if (!service || selected.some((file) => !file.key)) return;
    return {
      references: selected.map((file) =>
        chatFileReference(file.key!, normalizeFileName(file.file.name)),
      ),
      files: selected.map((item) => {
        const days =
          item.duration === undefined
            ? access.days!
            : parseFileAccessDuration(item.duration)!;
        return {
          key: item.key!,
          expiresAt: BigInt(Date.now() + days * 86400000),
        };
      }),
      complete: () => {
        const ids = new Set(selected.map((file) => file.id));
        setQueues((current) => ({
          ...current,
          [queue]: (current[queue] ?? []).filter((file) => !ids.has(file.id)),
        }));
        selected.forEach(release);
      },
    };
  }

  const { resume } = useFileSettlements();
  const resumeSettlements = useEffectEvent(() => void resume());

  useEffect(() => {
    if (!service || !contextReady) return;
    resumeSettlements();
    const timer = setInterval(resumeSettlements, 30_000);
    return () => clearInterval(timer);
  }, [service, contextReady, userId, accountKey]);

  const discardEditQueue = useEffectEvent((queue: string) =>
    (queues[queue] ?? []).forEach((file) => removeFile(queue, file)),
  );
  useEffect(() => () => discardEditQueue(editKey), [editKey]);

  const retryControl =
    !service && error ? (
      <Button variant="outline" size="sm" disabled={fileBusy} onClick={retry}>
        Retry file uploads
      </Button>
    ) : null;
  const allFiles = (
    <div className="flex max-h-[60dvh] min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain p-2">
      {isMobile && retryControl}
      {queued.map((file) => renderFile(queueKey, file, true))}
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

  const invalid = hasInvalidExpiry(queued);
  const attachments: ComposerAttachments = {
    ...queueState(queued),
    prepare: () => prepareFiles(queueKey, queued),
  };
  const editAttachments: EditAttachments = {
    ...queueState(editQueued),
    prepare: () => prepareFiles(editKey, editQueued),
    action: (kept) => (
      <>
        <input
          ref={editPicker}
          type="file"
          multiple
          className="sr-only"
          disabled={!recipient || fileBusy}
          onChange={(event) => addFiles(editKey, event.target, kept)}
        />
        <Button
          variant="ghost"
          className="h-7! w-7 p-0"
          disabled={!recipient || fileBusy}
          onClick={() => editPicker.current?.click()}
        >
          <Plus size={18} />
        </Button>
        {editQueued.map((file) => renderFile(editKey, file))}
      </>
    ),
    discard: () => editQueued.forEach((file) => removeFile(editKey, file)),
  };
  return (
    <ChatScreen
      attachments={attachments}
      editAttachments={editAttachments}
      uploadAction={
        <div className="flex min-w-0 items-center gap-1">
          <input
            ref={picker}
            type="file"
            multiple
            className="sr-only"
            disabled={!recipient || fileBusy}
            onChange={(event) => {
              addFiles(queueKey, event.target);
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
                            updateDuration(queueKey, editingFile.id, duration)
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
                {queued.slice(0, 5).map((file) => renderFile(queueKey, file))}
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
  const { uploads } = useFiles();
  const upload = file.key ? uploads[stringifyExactJson(file.key)] : undefined;
  const stopped = upload?.state === "cancelled" || upload?.state === "failed";
  const label =
    upload?.state === "cancelled"
      ? "Upload cancelled"
      : upload?.state === "failed"
        ? "File failed"
        : file.file.name;
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
      aria-label={`Remove ${file.file.name}`}
      onClick={onRemove}
    >
      <X className="size-3!" />
    </Button>
  );
  const cancelButton =
    upload?.state === "uploading"
      ? withTooltip(
          <Button
            variant="destructive"
            size="icon-xs"
            className="size-4.5! shrink-0 border-0! hover:bg-destructive! focus-visible:bg-destructive! aria-expanded:bg-destructive! disabled:opacity-100 rounded-xl"
            aria-label={`Cancel upload of ${file.file.name}`}
            onClick={upload.cancel}
          >
            <Square
              color="var(--foreground)"
              fill="var(--foreground)"
              className="size-2.5"
            />
          </Button>,
          "Cancel",
        )
      : null;
  const preview = stopped ? (
    <X
      className={
        upload.state === "failed"
          ? "size-4 shrink-0 text-destructive"
          : "size-4 shrink-0"
      }
    />
  ) : file.preview ? (
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
          <span className="min-w-0 break-all text-left">{label}</span>
        </Button>
        {cancelButton}
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
          : "h-7 max-w-36 basis-36 shrink gap-1 px-1.5",
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
              {label}
            </span>
          </Button>
        }
      />
      {cancelButton}
      {removeButton}
    </Badge>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip disabled={open}>
        <TooltipTrigger render={badge} />
        <TooltipContent className="max-w-[min(40rem,calc(100vw-2rem))] overflow-hidden border border-border bg-popover p-0 text-popover-foreground outline-none [&>div:last-child]:hidden">
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
        if (active) setContent(`${fence}${language}\n${lines}\n...\n${fence}`);
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

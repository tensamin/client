import {
  Badge,
  Button,
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
  cn,
  useIsMobile,
} from "@nonanium/ui";
import ChatScreen from "@tensamin/chat/screen";
import { useChat } from "@tensamin/chat/context";
import {
  formatFileAccessDuration,
  parseFileAccessDuration,
  useFileAccess,
  useFileAccessInfo,
} from "@tensamin/chat/file-access";
import { normalizeFileName, type FileKey } from "@tensamin/crypto/file";
import { useSession } from "@tensamin/identity/session";
import { useMTP } from "@tensamin/mtp";
import { parsePrincipal } from "@tensamin/shared/principal";
import { FileIcon, Plus, X, RotateCcw, Upload, ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { nextGrantRevision, useFiles } from "./filesRuntime";
import { chatFileLink, renderChatAttachments } from "./chatFileMessages";

type QueuedFile = {
  id: string;
  file: File;
  preview?: string;
  duration?: string;
};

export default function ChatConversation() {
  const { userId, accountKey, conversationKey, inputBoxRef } = useChat();
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
    <Button
      variant="ghost"
      size="xs"
      className="shrink-0"
      aria-expanded={expanded}
      aria-label={`Show all ${queued.length} attachments`}
    >
      + {queued.length - 5}
    </Button>
  );
  const uploadControl = (
    <Popover
      open={!!info.noticeOpen}
      onOpenChange={(next, details) => {
        if (!next) details.cancel();
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant={isMobile ? "default" : "ghost"}
            className={isMobile ? undefined : "h-9! w-9 p-0"}
            aria-label="Upload files"
            disabled={!contextReady || !recipient || fileBusy}
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
      <PopoverContent
        side="top"
        align="start"
        className="bg-primary text-primary-foreground"
        portalProps={isMobile ? { container: drawerContent } : undefined}
        finalFocus={() =>
          isMobile
            ? true
            : (inputBoxRef.current?.querySelector<HTMLElement>(".cm-content") ??
              true)
        }
      >
        <PopoverTitle>File access</PopoverTitle>
        <PopoverDescription className="text-primary-foreground">
          Access expires after one year by default. Change a contact's default
          in Customise chat, or set an expiry for an individual file.
        </PopoverDescription>
        <Button
          variant="secondary"
          disabled={info.dismissing}
          onClick={() => void info.dismissInfo()}
        >
          Got it
        </Button>
      </PopoverContent>
    </Popover>
  );

  const invalid = queued.some(
    (file) =>
      file.duration !== undefined &&
      parseFileAccessDuration(file.duration) === undefined,
  );
  const unavailableReason =
    queued.length === 0
      ? undefined
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
        prepare: async () => {
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
            suffix,
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
        <div className="flex min-w-0 items-end gap-1">
          <input
            ref={picker}
            type="file"
            multiple
            className="sr-only"
            aria-label="Choose message attachments"
            disabled={!contextReady || !recipient || fileBusy}
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
              if (!isMobile)
                inputBoxRef.current
                  ?.querySelector<HTMLElement>(".cm-content")
                  ?.focus({ preventScroll: true });
              void info.showInfo();
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
                    aria-label={`Attachments${queued.length ? `, ${queued.length} queued` : ""}`}
                    disabled={!contextReady || !recipient}
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
                          aria-label="Back to attachments"
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
                <Badge
                  variant={invalid ? "destructive" : "secondary"}
                  aria-hidden="true"
                >
                  {queued.length}
                </Badge>
              )}
            </>
          ) : (
            <>
              {uploadControl}
              {retryControl}
              <div className="flex min-w-0 flex-1 gap-1">
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
      className={cn("shrink-0 p-0!", fullWidth ? "size-6!" : "size-4!")}
      aria-label={`Remove ${file.file.name}`}
      disabled={disabled}
      onClick={onRemove}
    >
      <X className="size-3!" />
    </Button>
  );
  const preview = file.preview ? (
    <img
      src={file.preview}
      alt=""
      loading="lazy"
      decoding="async"
      className="size-3.5 shrink-0 rounded-sm object-cover"
    />
  ) : (
    <FileIcon className="size-3 shrink-0" />
  );
  if (onConfigure)
    return (
      <div className="flex min-w-0 items-center gap-2 border-b border-border p-2 last:border-b-0">
        <Button
          variant="ghost"
          className="h-auto! min-w-0 flex-1 justify-start gap-2 whitespace-normal px-0 font-semibold"
          disabled={disabled}
          aria-invalid={invalid}
          aria-label={`Configure access for ${file.file.name}`}
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
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Badge
        variant={invalid ? "destructive" : "secondary"}
        className={cn(
          "min-w-0",
          fullWidth
            ? "h-auto min-h-7 w-full max-w-full basis-auto justify-start gap-2 px-2 py-1"
            : "@container/queued-file max-w-18 basis-18 shrink gap-0 px-0.5",
        )}
      >
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              className={cn(
                "min-w-0 flex-1 shrink justify-start gap-1 overflow-hidden p-0!",
                fullWidth ? "h-auto! min-h-5" : "h-5!",
              )}
              aria-label={`Access settings for ${file.file.name}`}
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
                    : "hidden truncate @min-[48px]/queued-file:block",
                )}
              >
                {file.file.name}
              </span>
            </Button>
          }
        />
        {removeButton}
      </Badge>
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
          aria-invalid={
            file.duration !== undefined &&
            parseFileAccessDuration(file.duration) === undefined
          }
          disabled={disabled || defaultDays === undefined}
          onChange={(event) => onDuration(event.target.value)}
        />
        <Button
          variant="ghost"
          size="icon"
          disabled={disabled || defaultDays === undefined}
          onClick={() => onDuration(undefined)}
          aria-label="Reset to contact default"
        >
          <RotateCcw className="size-4" />
        </Button>
      </div>
    </>
  );
}

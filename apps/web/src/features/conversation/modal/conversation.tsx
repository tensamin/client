import { Basic, Loading } from "@/components/modals/basic";
import Wrapper from "@tensamin/identity/wrapper";
import {
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Drawer,
  DrawerContent,
  DrawerTitle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useIsMobile,
  Button,
} from "@nonanium/ui";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { useSession } from "@tensamin/identity/session";
import { useRef, useState } from "react";
import { Phone } from "lucide-react";
import { ChatBackgroundDialog } from "@tensamin/chat/backgrounds";
import {
  useContactJobs,
  type ContactJob,
} from "@tensamin/identity/contactJobs";

function JobBar({ job }: { job: ContactJob }) {
  return (
    <div className="flex w-full flex-col gap-1 py-1 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span>{job.label}</span>
        <span>{Math.round(job.progress * 100)}%</span>
      </div>
      <div
        aria-label={`${job.label} progress`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={Math.round(job.progress * 100)}
        className="h-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
      >
        <div
          className="h-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${job.progress * 100}%` }}
        />
      </div>
      {job.error && <p className="text-xs text-destructive">{job.error}</p>}
    </div>
  );
}

export default function ConversationModal({ userId }: { userId: number }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { id } = useSearch({ strict: false });
  const { contacts, calls } = useSession();
  const isMobile = useIsMobile();
  const { jobs, dismissJob } = useContactJobs();
  const contactJobs = jobs
    .filter((job) => job.contactId === userId)
    .sort((left, right) => right.priority - left.priority);
  const [customiseOpen, setCustomiseOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  const longPress = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const longPressed = useRef(false);
  const notifications =
    contacts.find((contact) => contact.UserId === userId)?.notifications ?? 0;
  const hasPendingCall = calls.some(
    (call) => call.CallInvited && call.SenderId === userId,
  );
  const active = pathname === "/chat" && id === userId;

  const contact = (
    <button
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative w-full cursor-pointer select-none rounded-xl text-left transition-colors",
        active && "bg-input/30",
      )}
      onClick={() => {
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        navigate({ to: "/chat", search: { id: userId } });
      }}
      onPointerDown={() => {
        if (isMobile)
          longPress.current = setTimeout(() => {
            longPressed.current = true;
            setActionsOpen(true);
          }, 450);
      }}
      onPointerMove={() => clearTimeout(longPress.current)}
      onPointerUp={() => clearTimeout(longPress.current)}
      onPointerCancel={() => clearTimeout(longPress.current)}
    >
      <Wrapper
        loading={<Loading />}
        userId={userId}
        fields={["Display", "Username", "Avatar", "OnlineStatus", "Status"]}
        component={(user) => (
          <Basic
            extra={
              contactJobs[0] && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <div className="w-full h-full flex">
                        <div className="h-1 w-full overflow-hidden rounded-full bg-(--input)/70">
                          <div
                            className="h-full bg-primary transition-[width] motion-reduce:transition-none"
                            style={{
                              width: `${contactJobs[0].progress * 100}%`,
                            }}
                          />
                        </div>
                      </div>
                    }
                  />
                  <TooltipContent className="flex flex-col gap-1">
                    {contactJobs.map((job) => (
                      <JobBar key={job.operationId} job={job} />
                    ))}
                  </TooltipContent>
                </Tooltip>
              )
            }
            user={user}
          />
        )}
      />
      <span className="pointer-events-none absolute -left-1 -top-1 z-10 flex gap-0.5">
        {notifications > 0 && (
          <span
            className={cn(
              "flex h-4 items-center justify-center rounded-full bg-destructive text-[10.5px] leading-none text-primary-foreground motion-safe:animate-in motion-safe:slide-in-from-bottom-2",
              notifications < 10 ? "w-4" : "min-w-4 px-1",
            )}
          >
            {notifications > 99 ? "99+" : notifications}
          </span>
        )}
        {hasPendingCall && (
          <span className="flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground motion-safe:animate-in motion-safe:slide-in-from-bottom-2">
            <Phone className="size-2.5 animate-pulse" />
          </span>
        )}
      </span>
    </button>
  );

  const allJobsContent = jobs.length ? (
    [...jobs]
      .sort((left, right) => right.priority - left.priority)
      .map((job) => (
        <div
          key={`${job.contactId}:${job.operationId}`}
          className="flex items-center gap-2"
        >
          <JobBar job={job} />
          {job.state === "failed" && job.retry && (
            <Button size="sm" onClick={job.retry}>
              Retry
            </Button>
          )}
          {job.cancel && (
            <Button size="sm" variant="outline" onClick={job.cancel}>
              Cancel
            </Button>
          )}
          {job.state === "failed" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => dismissJob(job.contactId, job.operationId)}
            >
              Dismiss
            </Button>
          )}
        </div>
      ))
  ) : (
    <p className="text-sm text-muted-foreground">No background jobs</p>
  );

  return (
    <>
      {isMobile ? (
        contact
      ) : (
        <ContextMenu>
          <ContextMenuTrigger render={contact} />
          <ContextMenuContent>
            <ContextMenuGroup>
              <ContextMenuItem onClick={() => setCustomiseOpen(true)}>
                Customise
              </ContextMenuItem>
              {jobs.length > 0 && (
                <ContextMenuItem onClick={() => setJobsOpen(true)}>
                  Background jobs
                </ContextMenuItem>
              )}
            </ContextMenuGroup>
          </ContextMenuContent>
        </ContextMenu>
      )}
      <Drawer open={actionsOpen} onOpenChange={setActionsOpen}>
        <DrawerContent>
          <DrawerTitle className="px-4 pt-2">Contact actions</DrawerTitle>
          <div className="p-4 w-full flex flex-col gap-2">
            <Button
              onClick={() => {
                setActionsOpen(false);
                setCustomiseOpen(true);
              }}
            >
              Customise
            </Button>
            {jobs.length > 0 && (
              <Button
                variant="outline"
                onClick={() => {
                  setActionsOpen(false);
                  setJobsOpen(true);
                }}
              >
                Background jobs
              </Button>
            )}
          </div>
        </DrawerContent>
      </Drawer>
      <Dialog open={jobsOpen} onOpenChange={setJobsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Background jobs</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 w-full">{allJobsContent}</div>
        </DialogContent>
      </Dialog>
      <ChatBackgroundDialog
        contactId={userId}
        open={customiseOpen}
        onOpenChange={setCustomiseOpen}
      />
    </>
  );
}

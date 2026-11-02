import List from "@/features/conversation/list/body";
import { Basic, Loading } from "./modals/basic";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SidebarContent,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useIsMobile,
} from "@nonanium/ui";
import { useNavigate } from "@tanstack/react-router";
import { useChat } from "@tensamin/chat/context";
import { useUser, type User } from "@tensamin/identity/context";
import Wrapper from "@tensamin/identity/wrapper";
import { RelayRejectedError, useMTP } from "@tensamin/mtp";
import { mtp, userPresencePreferenceSchema } from "@tensamin/shared/data";
import { log } from "@tensamin/shared/log";
import { useStorage } from "@tensamin/storage/context";
import { Check, Ellipsis, Loader2 } from "lucide-react";
import { useState } from "react";
import z from "zod";

import {
  onlineStatusLabels,
  onlineStatusOptions,
  type OnlineStatus,
} from "./status-options";

function accountPreference(status: User["OnlineStatus"]): OnlineStatus {
  return userPresencePreferenceSchema.safeParse(status).success
    ? (status as OnlineStatus)
    : "user_online";
}

function StatusDialog({
  user,
  open,
  onOpenChange,
}: {
  user: Pick<User, "UserId" | "OnlineStatus" | "Status">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { send } = useMTP();
  const { updateProfile, updateState } = useUser();
  const [draftStatus, setDraftStatus] = useState(user.Status ?? "");
  const [draftOnlineStatus, setDraftOnlineStatus] = useState<OnlineStatus>(
    accountPreference(user.OnlineStatus),
  );
  const [errorMessage, setErrorMessage] = useState("");
  const [saveSucceeded, setSaveSucceeded] = useState(false);

  function reset() {
    setDraftStatus(user.Status ?? "");
    setDraftOnlineStatus(accountPreference(user.OnlineStatus));
    setErrorMessage("");
    setSaveSucceeded(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) reset();
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update Status</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="user-status">Status message</Label>
          <Input
            id="user-status"
            placeholder="Getting snacks..."
            value={draftStatus}
            onChange={(event) => {
              setSaveSucceeded(false);
              setErrorMessage("");
              setDraftStatus(event.target.value);
            }}
          />
          <Label htmlFor="user-online-status">Online status</Label>
          <Select
            value={draftOnlineStatus}
            onValueChange={(value) => {
              setSaveSucceeded(false);
              setErrorMessage("");
              setDraftOnlineStatus(value ?? "user_online");
            }}
          >
            <SelectTrigger className="w-full" id="user-online-status">
              <SelectValue placeholder="Online">
                {onlineStatusLabels[draftOnlineStatus]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="p-1">
              {onlineStatusOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {errorMessage && (
          <p className="text-sm text-destructive">{errorMessage}</p>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="destructive">Cancel</Button>} />
          <Button
            onClick={async () => {
              const validation = mtp.ChangeUserData.request.safeParse({
                OnlineStatus: draftOnlineStatus,
                Status: draftStatus,
              });

              if (!validation.success) {
                setSaveSucceeded(false);
                setErrorMessage(
                  validation.error.issues[0]?.message ?? "Invalid status data",
                );
                return;
              }

              try {
                await send("ChangeUserData", validation.data);
                updateState(user.UserId, draftOnlineStatus);
                await updateProfile(user.UserId, { Status: draftStatus });
                setSaveSucceeded(true);
                setErrorMessage("");
              } catch (error) {
                setSaveSucceeded(false);
                setErrorMessage("Failed to update status: " + error);
              }
            }}
          >
            {saveSucceeded ? (
              <span className="inline-flex items-center gap-1.5">
                <Check className="size-4" />
                Saved
              </span>
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConversationForm({ onSuccess }: { onSuccess: () => void }) {
  const { load } = useStorage();
  const { startConversation } = useChat();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(username: string | null) {
    if (loading) return;
    setError(null);

    const result = z
      .string()
      .regex(/^[a-z0-9]+$/, "Username must use lowercase letters and numbers")
      .max(15, "Username is too long")
      .safeParse(username?.toLowerCase().trim());

    if (!result.success) {
      setError(result.error.issues[0].message);
      return;
    }

    const timeout = setTimeout(() => setLoading(true), 500);

    try {
      const authority = new URL(await load("omega_url")).host;
      await startConversation(`${result.data}@${authority}`);
      onSuccess();
    } catch (error) {
      if (error instanceof RelayRejectedError) {
        setError(
          `Could not route the request to your Iota: ${error.responseType}`,
        );
      } else {
        log(1, "mtp", "red", "Add conversation failed", error);
        const detail = error instanceof Error ? error.message : "unknown error";
        setError(`Add conversation failed: ${detail}`);
      }
    } finally {
      clearTimeout(timeout);
      setLoading(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void submit(form.get("username") as string | null);
      }}
    >
      <Input
        required
        type="text"
        id="username"
        name="username"
        placeholder="Enter username..."
      />
      <div className="flex w-full items-center justify-end gap-1">
        {error && <p className="w-full text-sm text-destructive">{error}</p>}
        <DialogClose
          render={({ onClick }) => (
            <Button onClick={onClick} variant="outline">
              Cancel
            </Button>
          )}
        />
        <Button disabled={loading} type="submit">
          {loading && <Loader2 className="animate-spin" />} Continue
        </Button>
      </div>
    </form>
  );
}

export function AddConversationButton() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={({ onClick }) => (
          <Button onClick={onClick}>Add Conversation</Button>
        )}
      />
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>New Conversation</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          Add a new conversation. Just enter the username of the person you want
          to add as a conversation.
        </DialogDescription>
        <ConversationForm onSuccess={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function MobileCommunicationsHeader() {
  const navigate = useNavigate();
  const [statusOpen, setStatusOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  return (
    <Wrapper
      loading={<Loading />}
      userId="own"
      fields={[
        "UserId",
        "Display",
        "Username",
        "Avatar",
        "OnlineStatus",
        "Status",
      ]}
      component={(user) => {
        const display = user.Display || user.Username || "Unknown";
        const avatar = user.Avatar
          ? `data:image/webp;base64,${user.Avatar}`
          : undefined;

        return (
          <>
            <div className="flex min-h-11 items-center justify-between gap-2 px-1.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <Avatar>
                  <AvatarImage src={avatar} />
                  <AvatarFallback>
                    {display.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <p className="truncate text-[15px] font-medium">{display}</p>
              </div>
              <Drawer>
                <DrawerTrigger asChild>
                  <Button variant="ghost" aria-label="Open Home actions">
                    <Ellipsis />
                  </Button>
                </DrawerTrigger>
                <DrawerContent>
                  <DrawerTitle className="sr-only">Home actions</DrawerTitle>
                  <DrawerDescription className="sr-only">
                    Update your status, add a chat, or open settings.
                  </DrawerDescription>
                  <div className="flex flex-col p-2">
                    <DrawerClose
                      className="rounded-md px-2 py-2 text-left text-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => setStatusOpen(true)}
                    >
                      Set status
                    </DrawerClose>
                    <DrawerClose
                      className="rounded-md px-2 py-2 text-left text-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => setAddOpen(true)}
                    >
                      Add chat
                    </DrawerClose>
                    <DrawerClose
                      className="rounded-md px-2 py-2 text-left text-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => void navigate({ to: "/settings" })}
                    >
                      Settings
                    </DrawerClose>
                  </div>
                </DrawerContent>
              </Drawer>
            </div>
            {statusOpen && (
              <StatusDialog user={user} open onOpenChange={setStatusOpen} />
            )}
            {addOpen && (
              <Dialog open onOpenChange={setAddOpen}>
                <DialogContent showCloseButton={false}>
                  <DialogHeader>
                    <DialogTitle>New Communication</DialogTitle>
                  </DialogHeader>
                  <Tabs defaultValue="conversation">
                    <TabsList className="w-full">
                      <TabsTrigger value="conversation">
                        Conversation
                      </TabsTrigger>
                      <TabsTrigger value="community" disabled>
                        Community
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent
                      value="conversation"
                      className="flex flex-col gap-5"
                    >
                      <ConversationForm onSuccess={() => setAddOpen(false)} />
                    </TabsContent>
                  </Tabs>
                </DialogContent>
              </Dialog>
            )}
          </>
        );
      }}
    />
  );
}

function DesktopCommunicationsHeader() {
  const [statusOpen, setStatusOpen] = useState(false);

  return (
    <Wrapper
      loading={<Loading />}
      userId="own"
      fields={[
        "UserId",
        "Display",
        "Username",
        "Avatar",
        "OnlineStatus",
        "Status",
      ]}
      component={(user) => (
        <>
          <Basic
            user={user}
            extra={
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      <Ellipsis />
                    </button>
                  }
                />
                <DropdownMenuContent>
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={() => setStatusOpen(true)}>
                      Set Status
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            }
          />
          {statusOpen && (
            <StatusDialog user={user} open onOpenChange={setStatusOpen} />
          )}
        </>
      )}
    />
  );
}

export default function Communications() {
  const isMobile = useIsMobile();
  const content = (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 pt-0!">
      <div className="px-2">
        {isMobile ? (
          <MobileCommunicationsHeader />
        ) : (
          <DesktopCommunicationsHeader />
        )}
      </div>
      <div className="h-full min-h-0">
        <List />
      </div>
    </div>
  );

  if (isMobile) return content;

  return <SidebarContent className="pt-2">{content}</SidebarContent>;
}

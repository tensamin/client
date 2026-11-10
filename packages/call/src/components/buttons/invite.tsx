import { useEffect, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Button,
  Input,
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useIsMobile,
} from "@nonanium/ui";
import Wrapper from "@tensamin/identity/wrapper";
import { useUser } from "@tensamin/identity/context";
import { Mail } from "lucide-react";
import { sendCallInvite, useCall } from "../../store";
import { log, toast } from "@tensamin/shared/log";
import { useSession } from "@tensamin/identity/session";
import { useStorage } from "@tensamin/storage/context";
import { parsePrincipal } from "@tensamin/shared/principal";

function InviteContacts({
  ownId,
  onInvite,
}: {
  ownId: number | undefined;
  onInvite: (userId: number) => void;
}) {
  const { contacts } = useSession();
  const { get } = useUser();
  const invitedUserId = useCall((state) => state.invitedUserId);
  const currentCallData = useCall((state) => state.currentCallData);
  const [items, setItems] = useState<{ value: number; label: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null,
  );

  useEffect(() => {
    if (ownId === undefined) return;
    let active = true;
    setLoading(true);
    void Promise.all(
      contacts
        .filter(
          (contact) =>
            contact.Principal &&
            parsePrincipal(contact.Principal).user_id !== ownId,
        )
        .map(async (contact) => {
          const userId = parsePrincipal(contact.Principal!).user_id;
          const user = await get(userId, ["Display"]).catch(() => undefined);

          return {
            value: userId,
            label: user?.Display ?? `User ${userId}`,
          };
        }),
    ).then((users) => {
      if (!active) return;
      setItems(users);
      setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [contacts, get, ownId]);

  const search = query.trim().toLocaleLowerCase();
  const filteredItems = items.filter(
    (item) =>
      item.label.toLocaleLowerCase().includes(search) ||
      String(item.value).includes(search),
  );
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: filteredItems.length,
    getScrollElement: () => scrollElement,
    getItemKey: (index) => filteredItems[index].value,
    estimateSize: () => 32,
    overscan: 5,
  });

  return (
    <>
      <Input
        className="h-8 px-2 text-sm"
        aria-label="Search contacts"
        placeholder="Search contacts..."
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          scrollElement?.scrollTo({ top: 0 });
        }}
      />
      <div
        ref={setScrollElement}
        role="region"
        tabIndex={0}
        className="max-h-[min(12rem,40dvh)] overflow-y-auto overscroll-contain"
      >
        <div
          className="relative"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((row) => {
            const item = filteredItems[row.index];
            const inCurrentCall =
              currentCallData?.status === "ready" &&
              currentCallData.userIds.includes(item.value);
            const style = {
              position: "absolute" as const,
              top: row.start,
              height: row.size,
            };

            return (
              <Wrapper
                key={item.value}
                userId={item.value}
                fields={["Display", "OnlineStatus"]}
                loading={
                  <Button
                    variant="ghost"
                    className="w-full justify-between gap-2 px-2 text-sm"
                    disabled
                    style={style}
                  >
                    {item.label}
                  </Button>
                }
                component={(user) => {
                  const unavailable = inCurrentCall
                    ? "In call"
                    : user.OnlineStatus === "iota_offline" ||
                        user.OnlineStatus === "iota_borked"
                      ? "Offline"
                      : invitedUserId !== null
                        ? invitedUserId === item.value
                          ? "Inviting..."
                          : "Waiting..."
                        : null;

                  if (unavailable) {
                    return (
                      <div
                        className="flex w-full items-center justify-between gap-2 px-2 text-sm"
                        style={style}
                      >
                        <span className="truncate">{user.Display}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {unavailable}
                        </span>
                      </div>
                    );
                  }

                  return (
                    <Button
                      variant="ghost"
                      className="w-full justify-between gap-2 px-2 text-sm"
                      style={style}
                      onClick={() => onInvite(item.value)}
                    >
                      <span className="truncate">{user.Display}</span>
                      <Mail className="size-4 shrink-0" />
                    </Button>
                  );
                }}
              />
            );
          })}
        </div>
      </div>
      {(loading || filteredItems.length === 0) && (
        <p
          role="status"
          className="px-2 py-2 text-center text-xs text-muted-foreground"
        >
          {loading
            ? "Loading contacts..."
            : items.length === 0
              ? "No contacts to invite."
              : "No contacts found."}
        </p>
      )}
    </>
  );
}

export default function InviteButton({
  className,
  iconSize,
  tooltip,
}: {
  className?: string;
  iconSize?: number;
  tooltip?: string;
}) {
  const { load } = useStorage();
  const isMobile = useIsMobile();
  const screenRef = useCall((state) => state.screenRef);
  const [portalContainer, setPortalContainer] = useState<HTMLElement>();
  const [open, setOpen] = useState(false);
  const [ownId, setOwnId] = useState<number>();

  useEffect(() => {
    void load("user_id").then(setOwnId);
  }, [load]);

  useEffect(() => {
    setPortalContainer(screenRef?.current ?? undefined);
  }, [screenRef]);

  const trigger = (
    <Button
      aria-label="Invite to call"
      variant="secondary"
      className={className}
    >
      <Mail style={{ scale: (iconSize ? iconSize + 100 : 100) + "%" }} />
    </Button>
  );
  const contactsContent = open && (
    <InviteContacts
      ownId={ownId}
      onInvite={(userId) => {
        void sendCallInvite(userId)
          .then(() => setOpen(false))
          .catch((error) => {
            toast(
              "error",
              "Sending call invitation failed",
              error instanceof Error ? error.message : String(error),
            );
            log(1, "call", "red", "Failed to send call invite", error);
          });
      }}
    />
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent>
          <DrawerHeader className="pb-0">
            <DrawerTitle>Invite a user to the call</DrawerTitle>
          </DrawerHeader>
          <div className="flex max-h-[70dvh] flex-col p-4">
            {contactsContent}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Tooltip>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            tooltip ? (
              <TooltipTrigger
                render={({ ref, onClick }) => (
                  <Button
                    variant="secondary"
                    aria-label="Invite to call"
                    ref={ref}
                    onClick={onClick}
                    className={className}
                  >
                    <Mail
                      style={{
                        scale: (iconSize ? iconSize + 100 : 100) + "%",
                      }}
                    />
                  </Button>
                )}
              />
            ) : (
              trigger
            )
          }
        />
        <PopoverContent
          className="flex w-50 flex-col gap-1 p-1!"
          portalProps={{ container: portalContainer }}
        >
          {contactsContent}
        </PopoverContent>
      </Popover>
      {tooltip ? (
        <TooltipContent portalProps={{ container: portalContainer }}>
          {tooltip}
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}

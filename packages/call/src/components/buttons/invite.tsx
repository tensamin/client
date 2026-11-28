import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nonanium/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useUser } from "@tensamin/identity/context";
import { useSession } from "@tensamin/identity/session";
import Wrapper from "@tensamin/identity/wrapper";
import { useMTP } from "@tensamin/mtp";
import { log, toast } from "@tensamin/shared/log";
import { parsePrincipal } from "@tensamin/shared/principal";
import { useStorage } from "@tensamin/storage/context";
import { Mail } from "lucide-react";
import { useEffect, useState } from "react";
import { useCall, useCallActions } from "../../store";

function InviteContacts({
  ownId,
  onInvite,
}: {
  ownId: number | undefined;
  onInvite: (userId: number) => void;
}) {
  const { contacts } = useSession();
  const { clientState } = useMTP();
  const authority = clientState?.Scope?.principal.authority;
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
    if (ownId === undefined || !authority) return;
    let active = true;
    setLoading(true);
    void Promise.all(
      contacts
        .filter((contact) => {
          if (!contact.Principal) return false;
          const principal = parsePrincipal(contact.Principal);
          return (
            principal.authority === authority && principal.user_id !== ownId
          );
        })
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
  }, [authority, contacts, get, ownId]);

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
                    className="w-full justify-start px-2 text-sm"
                    disabled
                    style={style}
                  >
                    {item.label}
                  </Button>
                }
                component={(user) => (
                  <Button
                    variant="ghost"
                    className="w-full justify-start px-2 text-sm"
                    style={style}
                    onClick={() => onInvite(item.value)}
                    disabled={
                      invitedUserId !== null ||
                      inCurrentCall ||
                      user.OnlineStatus === "iota_offline" ||
                      user.OnlineStatus === "iota_borked"
                    }
                  >
                    <span className="truncate">{user.Display}</span>
                  </Button>
                )}
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
  const { sendCallInvite } = useCallActions();

  const { load } = useStorage();
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
          className="flex w-50 flex-col gap-1 p-1! data-drawer:gap-3 data-drawer:px-4! data-drawer:pt-0! data-drawer:pb-4!"
          portalProps={{ container: portalContainer }}
        >
          <PopoverTitle className="hidden in-data-drawer:block">
            Invite a user to the call
          </PopoverTitle>
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

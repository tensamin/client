import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useUser } from "@tensamin/identity/context";
import { useChat } from "@tensamin/chat/context";
import { useMTP } from "@tensamin/mtp";
import { useSession } from "@tensamin/identity/session";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { decryptChatText } from "@tensamin/crypto/chatSecret";
import { getAppFocused, useAppFocused } from "@tensamin/shared/focus";
import { parsePrincipal } from "@tensamin/shared/principal";
import { log } from "@tensamin/shared/log";
import { playSound } from "@tensamin/shared/sounds";
import { subscribeNotificationHints } from "@tensamin/shared/notification";
import {
  createConversationNotifications,
  type IncomingNotification,
} from "./conversations";
import { notifyOnce } from "./receipt";

export default function Provider({ children }: { children: ReactNode }) {
  const { send, subscribe, accountKey, client, identified } = useMTP();
  const { getPresentation } = useUser();
  const { getChatSecret, markMessagesAsNew, newMessageCount, userId } =
    useChat();
  const { contacts, moveUserIdToTop, setNotifications } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const visible = useAppFocused();
  const rendererOwnsNotifications = !isTauri() || visible;
  const lifetime = useRef<object>({});
  const lastSound = useRef(0);
  const permission = useRef<Promise<boolean> | undefined>(undefined);
  const reads = useRef(new Map<number, number>());
  const viewedPrincipal = contacts.find(
    (contact) => contact.UserId === userId,
  )?.Principal;
  const latest = useRef({
    accountKey,
    pathname: location.pathname,
    userId,
    viewedPrincipal,
  });
  useEffect(() => {
    latest.current = {
      accountKey,
      pathname: location.pathname,
      userId,
      viewedPrincipal,
    };
  }, [accountKey, location.pathname, userId, viewedPrincipal]);
  useEffect(() => {
    if (!isTauri()) return;
    const principal =
      location.pathname === "/chat"
        ? (contacts.find((contact) => contact.UserId === userId)?.Principal ??
          null)
        : null;
    void invoke("mtp_set_viewed_conversation", { principal });
  }, [accountKey, contacts, location.pathname, userId]);
  useEffect(() => {
    lifetime.current = {};
    reads.current.clear();
    return () => {
      lifetime.current = {};
    };
  }, [accountKey, client, identified]);

  const read = useCallback(
    async (id: number, through: number) => {
      if (
        !accountKey ||
        !getAppFocused() ||
        (reads.current.get(id) ?? -1) >= through
      )
        return;
      const active = lifetime.current;
      reads.current.set(id, through);
      setNotifications(id, 0, through);
      try {
        const response = await send("ReadNotification", {
          ChatPartnerId: id,
          LastMessageAt: through,
        });
        if (
          active === lifetime.current &&
          latest.current.accountKey === accountKey &&
          reads.current.get(id) === through &&
          response.type === "ReadNotification"
        ) {
          setNotifications(
            id,
            response.data.notifications,
            response.data.LastMessageAt,
          );
        }
      } catch (error) {
        log(
          1,
          "notifications",
          "red",
          "Failed to mark conversation read",
          error,
        );
      } finally {
        if (active === lifetime.current && reads.current.get(id) === through)
          reads.current.delete(id);
      }
    },
    [accountKey, send, setNotifications],
  );

  useEffect(() => {
    if (!visible || location.pathname !== "/chat") return;
    const contact = contacts.find((contact) => contact.UserId === userId);
    if (!contact?.notifications) return;
    if (!newMessageCount)
      markMessagesAsNew(contact.UserId, contact.notifications);
    void read(contact.UserId, contact.LastMessageAt);
  }, [
    contacts,
    location.pathname,
    markMessagesAsNew,
    newMessageCount,
    read,
    userId,
    visible,
  ]);

  const prepareRef = useRef<
    (message: IncomingNotification, current: () => boolean) => Promise<void>
  >(async () => {});
  useEffect(() => {
    prepareRef.current = async (incoming, newest) => {
      const active = lifetime.current;
      const current = () =>
        newest() &&
        active === lifetime.current &&
        latest.current.accountKey === accountKey &&
        (!isTauri() || getAppFocused());
      const viewing = () =>
        getAppFocused() &&
        latest.current.pathname === "/chat" &&
        latest.current.viewedPrincipal === incoming.principal;
      if (!current() || (isTauri() && !getAppFocused())) return;
      let body =
        incoming.kind === "file" ? "Shared a file" : "New encrypted message";
      let contactId: number | undefined;
      let previewIdentity: { content: string; version: number } | undefined;
      const presentation = getPresentation(incoming.principal).catch(
        () => undefined,
      );
      if (incoming.kind === "message") {
        try {
          const response = await send("MessageGet", {
            Principal: incoming.principal,
            RelayMessageId: incoming.relayId,
          });
          if (!current()) return;
          if (response.type === "ErrorNotFound") return;
          if (response.type !== "MessageGet")
            throw new Error("Message state unavailable");
          if (response.data.Status === "pruned") {
            if (
              response.data.Principal !== incoming.principal ||
              response.data.RelayMessageId !== incoming.relayId
            )
              throw new Error("Pruned message identity changed");
          } else {
            const message = response.data.Message;
            if (
              message.Principal !== incoming.principal ||
              message.RelayMessageId !== incoming.relayId
            )
              throw new Error("Message lookup identity changed");
            contactId = message.SenderId;
            previewIdentity = {
              content: message.Content,
              version: message.VersionNumber,
            };
            const secret = await getChatSecret(
              incoming.principal,
              message.VersionNumber,
            );
            if (!secret) throw new Error("Notification key unavailable");
            if (!current()) return;
            body = await decryptChatText(
              secret,
              message.Content,
              message.VersionNumber,
            );
          }
        } catch (error) {
          // A missing/deleted message is not a new alert. Other failures retain a generic alert, never stale plaintext.
          if (
            error &&
            typeof error === "object" &&
            "frame" in error &&
            (error.frame as { type?: string })?.type === "ErrorNotFound"
          )
            return;
          log(
            1,
            "notifications",
            "yellow",
            "Notification preview unavailable",
            error,
          );
        }
      }
      const user = await presentation;
      if (!current()) return;
      if (previewIdentity) {
        try {
          const response = await send("MessageGet", {
            Principal: incoming.principal,
            RelayMessageId: incoming.relayId,
          });
          if (!current()) return;
          if (response.type === "ErrorNotFound") return;
          if (response.type !== "MessageGet")
            throw new Error("Current message unavailable");
          if (response.data.Status === "pruned") {
            if (
              response.data.Principal !== incoming.principal ||
              response.data.RelayMessageId !== incoming.relayId
            )
              return;
            body = "New encrypted message";
          } else if (
            response.data.Message.Principal !== incoming.principal ||
            response.data.Message.RelayMessageId !== incoming.relayId ||
            response.data.Message.Content !== previewIdentity.content ||
            response.data.Message.VersionNumber !== previewIdentity.version
          )
            return;
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "frame" in error &&
            (error.frame as { type?: string })?.type === "ErrorNotFound"
          )
            return;
          body = "New encrypted message";
        }
      }
      if (viewing()) {
        return;
      }
      if (contactId !== undefined) moveUserIdToTop(contactId);
      const title = user?.Display ?? "New message";
      const url = `/chat?principal=${encodeURIComponent(incoming.principal)}`;
      if (isTauri()) {
        if (!current() || viewing()) return;
        if (incoming.order === undefined)
          throw new Error("Native notification omitted its delivery order");
        if (
          !(await invoke<boolean>("mtp_post_message_notification", {
            account: accountKey,
            signer: parsePrincipal(incoming.principal),
            relayId: incoming.relayId,
            title,
            body,
            time: incoming.time,
            order: incoming.order,
          }))
        )
          return;
      } else {
        permission.current ??= (async () => {
          if (!("Notification" in window)) return false;
          if (Notification.permission !== "default")
            return Notification.permission === "granted";
          return (
            getAppFocused() &&
            (await Notification.requestPermission()) === "granted"
          );
        })();
        const granted = await permission.current;
        if (!current() || viewing()) return;
        if (granted) {
          const options = {
            body,
            icon: user?.Avatar || "/icons/icon-192.png",
            tag: `message-${accountKey}-${incoming.principal}`,
            silent: true,
          };
          const registration =
            "serviceWorker" in navigator
              ? await navigator.serviceWorker.getRegistration()
              : undefined;
          if (!current() || viewing()) return;
          if (
            !accountKey ||
            !(await notifyOnce(
              accountKey,
              `${incoming.principal}:${incoming.relayId}`,
              () => current() && !viewing(),
              async () => {
                if (registration)
                  await registration.showNotification(title, {
                    ...options,
                    data: { url, accountKey, principal: incoming.principal },
                  });
                else {
                  const notification = new Notification(title, options);
                  notification.onclick = () => {
                    if (current()) {
                      window.focus();
                      navigate({ to: url });
                    }
                    notification.close();
                  };
                }
              },
            ))
          )
            return;
        } else if (getAppFocused() && accountKey) {
          if (
            !(await notifyOnce(
              accountKey,
              `${incoming.principal}:${incoming.relayId}`,
              () => current() && !viewing(),
              async () => {
                toast(title, { description: body });
              },
            ))
          )
            return;
        }
      }
      if (
        !isTauri() &&
        current() &&
        !viewing() &&
        Date.now() - lastSound.current >= 1000
      ) {
        lastSound.current = Date.now();
        playSound("message");
      }
    };
  }, [
    accountKey,
    contacts,
    getChatSecret,
    getPresentation,
    markMessagesAsNew,
    moveUserIdToTop,
    navigate,
    read,
    send,
  ]);

  useEffect(() => {
    if (!accountKey || !identified || !rendererOwnsNotifications) return;
    const queue = createConversationNotifications(
      (message, current) => prepareRef.current(message, current),
      (error) => log(1, "notifications", "red", "Notification failed", error),
    );
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unlistenState: (() => void) | undefined;
    const token = crypto.randomUUID();
    if (isTauri()) {
      void listen<{
        account: string;
        signer: string;
        relayId: string;
        kind: string;
        time: number;
        order: number;
      }>("tensamin://notification", ({ payload }) => {
        if (
          disposed ||
          payload.account !== accountKey ||
          !["MessageSend", "FileShareOffered"].includes(payload.kind)
        )
          return;
        parsePrincipal(payload.signer);
        queue.enqueue({
          principal: payload.signer,
          relayId: payload.relayId,
          kind: payload.kind === "MessageSend" ? "message" : "file",
          time: payload.time,
          order: payload.order,
        });
      })
        .then(async (stop) => {
          if (disposed) stop();
          else {
            unlisten = stop;
            const activate = () => {
              if (!disposed)
                void invoke("mtp_set_notification_owner", {
                  account: accountKey,
                  token,
                  ready: true,
                }).catch((error) =>
                  log(
                    1,
                    "notifications",
                    "red",
                    "Native notification handoff failed",
                    error,
                  ),
                );
            };
            const stopState = await listen<{
              kind: string;
              snapshot?: { identified: boolean };
            }>("tensamin://mtp", ({ payload }) => {
              if (payload.kind === "state" && payload.snapshot?.identified)
                activate();
            });
            if (disposed) stopState();
            else {
              unlistenState = stopState;
              activate();
            }
          }
        })
        .catch((error) =>
          log(
            1,
            "notifications",
            "red",
            "Native notification listener failed",
            error,
          ),
        );
    }
    const unsubscribe = isTauri()
      ? () => {}
      : subscribe("MessageLive", ({ data }) => {
          const message = data.Message;
          if (
            !data.suppressNotification &&
            message.Principal &&
            message.RelayMessageId
          )
            queue.enqueue({
              principal: message.Principal,
              relayId: message.RelayMessageId,
              kind: "message",
              time: message.SendTime,
            });
        });
    const unsubscribeHints = subscribeNotificationHints((hint) => {
      if (hint.account === accountKey && hint.kind !== "FileShareRevoked")
        queue.enqueue({
          principal: hint.signer,
          relayId: hint.relayId,
          kind: hint.kind === "MessageSend" ? "message" : "file",
          time: hint.time,
          order: hint.order,
        });
    });
    return () => {
      disposed = true;
      queue.close();
      unsubscribe();
      unsubscribeHints();
      unlisten?.();
      unlistenState?.();
      if (isTauri())
        void invoke("mtp_set_notification_owner", {
          account: accountKey,
          token,
          ready: false,
        }).catch((error) =>
          log(
            1,
            "notifications",
            "yellow",
            "Native notification handoff could not be released",
            error,
          ),
        );
    };
  }, [accountKey, client, identified, subscribe, rendererOwnsNotifications]);
  return <>{children}</>;
}

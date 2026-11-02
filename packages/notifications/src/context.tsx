import { useUser } from "@tensamin/identity/context";
import { useChat } from "@tensamin/chat/context";
import { useMTP } from "@tensamin/mtp";
import {
  createContext,
  useCallback,
  useEffect,
  useContext,
  useRef,
} from "react";
import { toast as sonnerToast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@nonanium/ui";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  isPermissionGranted as isTauriNotificationPermissionGranted,
  requestPermission as requestTauriNotificationPermission,
  sendNotification as sendTauriNotification,
} from "@tauri-apps/plugin-notification";
import { useSession } from "@tensamin/identity/session";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { decryptChatText } from "@tensamin/crypto/chatSecret";
import { log } from "@tensamin/shared/log";
import { playSound } from "@tensamin/shared/sounds";
import { getAppFocused, useAppFocused } from "@tensamin/shared/focus";
import { encodePrincipal } from "@tensamin/shared/principal";

export const context = createContext<contextType | undefined>(undefined);

async function requestNotificationPermission() {
  if (!("Notification" in window)) return false;

  if (Notification.permission === "granted") return true;

  const permission = await Notification.requestPermission();
  return permission === "granted";
}

export default function Provider(props: { children: React.ReactNode }) {
  const { send, clientState, accountKey } = useMTP();
  const { getPresentation } = useUser();
  const {
    chatSecret,
    chatSecretVersion,
    getChatSecret,
    markMessagesAsNew,
    newMessageCount,
    userId,
    ownPrincipal,
  } = useChat();
  const { contacts, moveUserIdToTop, setNotifications } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const latestReadRef = useRef(new Map<number, number>());
  const appFocused = useAppFocused();
  const activeAccountRef = useRef(accountKey);
  const accountLifetimeRef = useRef({});
  useEffect(() => {
    accountLifetimeRef.current = {};
    latestReadRef.current.clear();
    activeAccountRef.current = accountKey;
    return () => {
      activeAccountRef.current = undefined;
    };
  }, [accountKey]);

  const readNotifications = useCallback(
    async (contactUserId: number, through: number) => {
      const lifetime = accountLifetimeRef.current;
      const account = activeAccountRef.current;
      if (!account) return;
      const latest = latestReadRef.current.get(contactUserId) ?? -1;
      if (latest >= through) return;
      latestReadRef.current.set(contactUserId, through);
      setNotifications(contactUserId, 0, through);

      try {
        const response = await send("ReadNotification", {
          ChatPartnerId: contactUserId,
          LastMessageAt: through,
        });
        if (
          response.type === "ReadNotification" &&
          lifetime === accountLifetimeRef.current &&
          account === activeAccountRef.current &&
          latestReadRef.current.get(contactUserId) === through
        ) {
          setNotifications(
            response.data.ChatPartnerId,
            response.data.notifications,
            response.data.LastMessageAt,
          );
        }
      } catch (error) {
        log(
          1,
          "notifications",
          "red",
          "Failed to mark conversation notifications as read",
          error,
          { userId: contactUserId },
        );
      } finally {
        if (
          lifetime === accountLifetimeRef.current &&
          latestReadRef.current.get(contactUserId) === through
        ) {
          latestReadRef.current.delete(contactUserId);
        }
      }
    },
    [send, setNotifications],
  );

  useEffect(() => {
    if (location.pathname !== "/chat" || !appFocused) return;
    const contact = contacts.find((item) => item.UserId === userId);
    if (!contact || contact.notifications === 0) return;
    if (newMessageCount === 0) {
      markMessagesAsNew(contact.UserId, contact.notifications);
    }
    void readNotifications(contact.UserId, contact.LastMessageAt);
  }, [
    appFocused,
    contacts,
    location.pathname,
    markMessagesAsNew,
    newMessageCount,
    readNotifications,
    userId,
  ]);

  const seenMessagesRef = useRef<{
    accountKey?: string;
    initialized: boolean;
    ids: Set<string>;
  }>({ initialized: false, ids: new Set() });
  const notificationQueueRef = useRef(Promise.resolve());

  useEffect(() => {
    if (!accountKey || !clientState) {
      seenMessagesRef.current = { initialized: false, ids: new Set() };
      return;
    }
    if (
      !clientState.Scope ||
      encodePrincipal(clientState.Scope.principal) !== ownPrincipal
    )
      return;
    const seen = seenMessagesRef.current;
    if (seen.accountKey !== accountKey) {
      seen.accountKey = accountKey;
      seen.initialized = false;
      seen.ids = new Set();
    }

    const currentIds = new Set<string>();
    const fresh = new Map<
      number,
      { contact: (typeof clientState.Contacts)[number]; messageId: string }
    >();
    for (const contact of clientState.Contacts) {
      const principal = contact.Principal;
      if (!principal) {
        log(
          1,
          "notifications",
          "red",
          "Contact omitted its canonical identity",
        );
        continue;
      }
      for (const message of contact.Messages) {
        if (!message.RelayMessageId) continue;
        const id = `${principal}:${message.RelayMessageId}`;
        currentIds.add(id);
        if (
          seen.initialized &&
          !seen.ids.has(id) &&
          message.Principal === principal
        ) {
          fresh.set(contact.UserId, { contact, messageId: id });
        }
      }
    }
    seen.ids = currentIds;
    seen.initialized = true;
    const lifetime = accountLifetimeRef.current;

    notificationQueueRef.current = notificationQueueRef.current
      .catch((error) => {
        log(1, "notifications", "red", "Message notification failed", error);
      })
      .then(async () => {
        for (const { contact, messageId } of fresh.values()) {
          if (
            activeAccountRef.current !== accountKey ||
            lifetime !== accountLifetimeRef.current
          )
            return;
          const principal = contact.Principal;
          if (!principal) continue;
          const message = contact.Messages.find(
            (candidate) =>
              `${principal}:${candidate.RelayMessageId}` === messageId,
          );
          if (!message) continue;
          const isCurrentChat =
            location.pathname === "/chat" && userId === contact.UserId;
          const appFocused = getAppFocused();
          const activelyViewing = isCurrentChat && appFocused;
          const shouldNotify = !activelyViewing;
          if (!isCurrentChat) moveUserIdToTop(contact.UserId);
          if (activelyViewing) {
            void readNotifications(contact.UserId, message.SendTime);
          }

          const messageSecret =
            isCurrentChat &&
            chatSecret &&
            message.VersionNumber === chatSecretVersion
              ? chatSecret
              : await getChatSecret(principal, message.VersionNumber).catch(
                  (error) => {
                    log(
                      1,
                      "notifications",
                      "yellow",
                      "Notification key unavailable",
                      error,
                    );
                    return null;
                  },
                );
          if (
            activeAccountRef.current !== accountKey ||
            lifetime !== accountLifetimeRef.current
          )
            return;
          if (shouldNotify) playSound("message");
          const plaintext = messageSecret
            ? await decryptChatText(
                messageSecret,
                message.Content,
                message.VersionNumber,
              ).catch((error) => {
                log(1, "chat", "red", "Failed to decrypt new message", error, {
                  SendTime: message.SendTime,
                });
                return null;
              })
            : null;
          if (
            activeAccountRef.current !== accountKey ||
            lifetime !== accountLifetimeRef.current
          )
            return;
          if (isCurrentChat) {
            markMessagesAsNew(
              contact.UserId,
              appFocused ? 0 : contact.notifications,
            );
          }
          if (!shouldNotify) continue;
          const content =
            plaintext ??
            "Encrypted message. Open the conversation to decrypt it.";
          const user = await getPresentation(principal).catch(() => ({
            Principal: principal,
            Display: principal,
            Avatar: undefined,
          }));
          if (
            activeAccountRef.current !== accountKey ||
            lifetime !== accountLifetimeRef.current
          )
            return;
          const url = `/chat?principal=${encodeURIComponent(principal)}`;

          if (isTauri()) {
            if (!appFocused) continue;
            const permissionGranted =
              (await isTauriNotificationPermissionGranted()) ||
              (await requestTauriNotificationPermission()) === "granted";
            if (
              activeAccountRef.current !== accountKey ||
              lifetime !== accountLifetimeRef.current
            )
              return;
            if (permissionGranted) {
              let handledNatively = false;
              try {
                handledNatively = await invoke<boolean>(
                  "mtp_post_message_notification",
                  {
                    senderId: contact.UserId,
                    sender: user.Display,
                    body: content,
                    avatar: user.Avatar,
                  },
                );
              } catch (error) {
                log(
                  1,
                  "notifications",
                  "red",
                  "Failed to create native message notification",
                  error,
                );
              }
              if (!handledNatively) {
                if (
                  activeAccountRef.current !== accountKey ||
                  lifetime !== accountLifetimeRef.current
                )
                  return;
                sendTauriNotification({ title: user.Display, body: content });
              }
            }
            continue;
          }

          const hasPermissions = await requestNotificationPermission();
          if (
            activeAccountRef.current !== accountKey ||
            lifetime !== accountLifetimeRef.current
          )
            return;
          if (hasPermissions) {
            const options: NotificationOptions = {
              body: content,
              icon: user.Avatar || "/icons/icon-192.png",
              badge: "/icons/notification-badge.png",
              tag: `message-${accountKey}-${principal}`,
              silent: true,
            };
            if ("serviceWorker" in navigator) {
              const registration =
                await navigator.serviceWorker.getRegistration();
              if (
                activeAccountRef.current !== accountKey ||
                lifetime !== accountLifetimeRef.current
              )
                return;
              if (registration) {
                await registration.showNotification(user.Display, {
                  ...options,
                  data: { url, accountKey, principal },
                });
                continue;
              }
            }
            const notification = new Notification(user.Display, options);
            notification.onclick = () => {
              if (
                activeAccountRef.current !== accountKey ||
                lifetime !== accountLifetimeRef.current
              )
                return;
              window.focus();
              navigate({ to: url });
              notification.close();
            };
          } else {
            sonnerToast(user.Display, {
              classNames: { content: "pl-4" },
              description: content,
              icon: (
                <Avatar>
                  <AvatarImage src={user.Avatar} />
                  <AvatarFallback>
                    {user.Display.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              ),
            });
          }
        }
      });
    void notificationQueueRef.current.catch((error) => {
      log(1, "notifications", "red", "Message notification failed", error);
    });
  }, [
    accountKey,
    chatSecret,
    chatSecretVersion,
    clientState,
    getChatSecret,
    getPresentation,
    location.pathname,
    markMessagesAsNew,
    moveUserIdToTop,
    navigate,
    ownPrincipal,
    readNotifications,
    userId,
  ]);

  return (
    <context.Provider value={{ test: () => {} }}>
      {props.children}
    </context.Provider>
  );
}

type contextType = {
  test: () => void;
};

/**
 * Executes useNotifications.
 * @param none This function has no parameters.
 * @returns contextType.
 */
export function useNotifications(): contextType {
  const ctx = useContext(context);
  if (!ctx) {
    throw new Error("useNotifications must be used within a ChatProvider");
  }
  return ctx;
}

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

export const context = createContext<contextType | undefined>(undefined);

async function requestNotificationPermission() {
  if (!("Notification" in window)) return false;

  if (Notification.permission === "granted") return true;

  const permission = await Notification.requestPermission();
  return permission === "granted";
}

export default function Provider(props: { children: React.ReactNode }) {
  const { send, subscribe } = useMTP();
  const { get } = useUser();
  const {
    addLiveMessage,
    chatSecret,
    chatSecretVersion,
    getChatSecret,
    markMessagesAsNew,
    newMessageCount,
    userId,
  } = useChat();
  const { contacts, moveUserIdToTop, setNotifications } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const latestReadRef = useRef(new Map<number, number>());
  const appFocused = useAppFocused();

  const readNotifications = useCallback(
    async (contactUserId: number, through: number) => {
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
        if (latestReadRef.current.get(contactUserId) === through) {
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

  useEffect(() => {
    return subscribe("MessageLive", async ({ data }) => {
      if (!data.SenderId || !data.Message) return;

      const isCurrentChat =
        location.pathname === "/chat" && userId === data.SenderId;
      const appFocused = getAppFocused();
      const activelyViewing = isCurrentChat && appFocused;
      const shouldNotify = !activelyViewing && !data.suppressNotification;
      const notifications =
        data.notifications ??
        (contacts.find((contact) => contact.UserId === data.SenderId)
          ?.notifications ?? 0) + 1;

      if (!isCurrentChat) moveUserIdToTop(data.SenderId);
      if (activelyViewing) {
        void readNotifications(data.SenderId, data.LastMessageAt);
      }

      const messageVersion = data.Message?.VersionNumber ?? 1;
      const messageSecret =
        isCurrentChat && chatSecret && messageVersion === chatSecretVersion
          ? chatSecret
          : await getChatSecret(data.SenderId, messageVersion);

      if (!messageSecret) return;
      if (shouldNotify) playSound("message");

      void decryptChatText(messageSecret, data.Message.Content, messageVersion)
        .catch((err) => {
          log(1, "chat", "red", "Failed to decrypt live message", err, {
            SendTime: data.Message?.SendTime,
          });
          return null;
        })
        .then(async (content) => {
          if (!data.Message || !content || !data.SenderId) return;

          if (isCurrentChat) {
            addLiveMessage(
              {
                ...data.Message,
                Content: content ?? "Failed to decrypt message",
                decryptionFailed: content === null,
              },
              appFocused ? 0 : notifications,
            );
          }

          if (!shouldNotify) return;

          const user = await get(data.SenderId, [
            "UserId",
            "Display",
            "Avatar",
          ]);

          if (isTauri()) {
            if (!appFocused) return;
            const permissionGranted =
              (await isTauriNotificationPermissionGranted()) ||
              (await requestTauriNotificationPermission()) === "granted";

            if (permissionGranted) {
              let handledNatively = false;
              try {
                handledNatively = await invoke<boolean>(
                  "mtp_post_message_notification",
                  {
                    senderId: user.UserId,
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
                sendTauriNotification({ title: user.Display, body: content });
              }
            }
          } else {
            const hasPermissions = await requestNotificationPermission();

            if (hasPermissions) {
              const options: NotificationOptions = {
                body: content,
                icon: user.Avatar || "/icons/icon-192.png",
                badge: "/icons/notification-badge.png",
                tag: `message-${user.UserId}`,
                silent: true,
              };
              if ("serviceWorker" in navigator) {
                const registration =
                  await navigator.serviceWorker.getRegistration();
                if (registration) {
                  await registration.showNotification(user.Display, {
                    ...options,
                    data: { url: `/chat?id=${user.UserId}` },
                  });
                  return;
                }
              }
              const notification = new Notification(user.Display, options);
              notification.onclick = () => {
                window.focus();
                navigate({
                  to: `/chat?id=${user.UserId}`,
                });
                notification.close();
              };
            } else {
              sonnerToast(user.Display, {
                classNames: {
                  content: "pl-4",
                },
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
    });
  }, [
    addLiveMessage,
    chatSecret,
    contacts,
    get,
    location.pathname,
    navigate,
    moveUserIdToTop,
    subscribe,
    getChatSecret,
    userId,
    chatSecretVersion,
    readNotifications,
    setNotifications,
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

import { useEffect, useRef, useState, useCallback } from "react";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { LoadingScreen } from "@nonanium/ui";

import AppLayout from "./layout";
import CallInit from "@/components/callRuntimeInit";
import CacheSync from "@tensamin/cache/sync";
import ChatContext from "@tensamin/chat/context";
import Crypto from "@tensamin/crypto/context";
import UserProvider from "@tensamin/identity/context";
import { Provider as MTPProvider, useMTP } from "@tensamin/mtp";
import NotificationsProvider from "@tensamin/notifications/context";
import OnboardingGate from "@tensamin/onboarding";
import DesktopMediaProvider from "@tensamin/shared/desktopMedia";
import Session from "@tensamin/identity/session";
import { useDeeplinks } from "@tensamin/tauri/deeplinkHandler";
import { SettingsProfilesProvider } from "@tensamin/settings";
import DeviceLoginSettings from "@tensamin/login/deviceLoginSettings";
import { qrLoginId } from "@tensamin/login/qr/deeplink";
import { log, toast } from "@tensamin/shared/log";

function DeeplinkNavigator() {
  const { deeplinks } = useDeeplinks();
  const navigate = useNavigate();
  const handledCount = useRef(0);
  const [loginLinks, setLoginLinks] = useState<string[]>([]);
  const handledLoginIds = useRef(new Set<string>());
  const loginHandled = useCallback(
    () => setLoginLinks((links) => links.slice(1)),
    [],
  );

  useEffect(() => {
    const links = deeplinks.slice(handledCount.current);
    handledCount.current = deeplinks.length;

    for (const link of links) {
      try {
        const url = new URL(link);
        if (url.protocol === "tensamin:" && url.hostname === "qr-login") {
          const session = qrLoginId(link);
          log(0, "deeplink", "blue", "Queued QR login for authenticated UI");
          if (!handledLoginIds.current.has(session)) {
            handledLoginIds.current.add(session);
            setLoginLinks((links) => [...links, link]);
          }
          continue;
        }
        const id = Number(url.searchParams.get("id"));
        if (
          url.protocol === "tensamin:" &&
          url.hostname === "chat" &&
          Number.isSafeInteger(id) &&
          id > 0
        ) {
          void navigate({ to: "/chat", search: { id } });
        } else if (
          url.protocol === "tensamin:" &&
          url.hostname === "authorize"
        ) {
          const request = url.searchParams.get("request");
          if (request) void navigate({ to: "/authorize", search: { request } });
        }
      } catch (error) {
        log(0, "deeplink", "red", "Invalid deeplink", String(error));
        toast("error", "Invalid application link");
      }
    }
  }, [deeplinks, navigate]);

  return (
    <DeviceLoginSettings loginLink={loginLinks[0]} onHandled={loginHandled} />
  );
}

function MainApp() {
  const authorizing = useLocation().pathname === "/authorize";
  const {
    contextReady,
    sessionEstablished,
    loadingDescription,
    connectionStatus,
    retryConnection,
  } = useMTP();

  return (
    <Session>
      <UserProvider>
        <CallInit />
        <CacheSync />
        {authorizing ? (
          <Outlet />
        ) : (
          <SettingsProfilesProvider>
            <OnboardingGate
              connectionReady={contextReady}
              sessionEstablished={sessionEstablished}
              connectionDescription={loadingDescription}
              connectionStatus={connectionStatus}
              retryConnection={retryConnection}
            >
              <AppLayout>
                <ChatContext>
                  <NotificationsProvider>
                    <Outlet />
                  </NotificationsProvider>
                </ChatContext>
              </AppLayout>
            </OnboardingGate>
          </SettingsProfilesProvider>
        )}
      </UserProvider>
    </Session>
  );
}

export default function AppShell() {
  return (
    <Crypto>
      <DesktopMediaProvider>
        <MTPProvider
          fallback={
            <LoadingScreen title="Starting secure messaging" progress={8} />
          }
        >
          <DeeplinkNavigator />
          <MainApp />
        </MTPProvider>
      </DesktopMediaProvider>
    </Crypto>
  );
}

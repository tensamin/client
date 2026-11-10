import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { Button, useIsMobile } from "@nonanium/ui";
import { ArrowLeft } from "lucide-react";
import { useRef } from "react";
import { ConnectionState } from "mtp";

import { SettingsSidebar } from "./sidebar";
import { SettingsProfileMenu } from "./profileMenu";
import { useSettingsProfiles } from "./profiles";
import { useMTP } from "@tensamin/mtp";
import { useNavbar } from "@tensamin/shared/navbar";

export default function SettingsLayout() {
  const isMobile = useIsMobile();
  const location = useLocation();
  const navigate = useNavigate();
  const { activeProfile, loading } = useSettingsProfiles();
  const { identified, readyState } = useMTP();
  const scrollRef = useRef<HTMLDivElement>(null);
  const touchYRef = useRef<number | null>(null);
  const { render } = useNavbar();
  const isSettingsRoot = /^\/settings\/?$/.test(location.pathname);
  const blockingExcluded = /^\/settings\/(legal|developer|security)\/?$/.test(
    location.pathname,
  );
  const blocked =
    !blockingExcluded &&
    (loading || !identified || readyState !== ConnectionState.Connected);

  return (
    <>
      {!isMobile &&
        render(
          <div className="translate-y-[3.5px] [&>div]:w-auto">
            <SettingsProfileMenu />
          </div>,
        )}
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        <div className="flex min-h-0 w-full flex-1 overflow-hidden">
          <SettingsSidebar className="hidden md:flex" />
          <div
            ref={scrollRef}
            className="bg-background flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
          >
            {(isMobile || location.pathname !== "/settings/iota") && (
              <div className="flex items-center gap-2">
                {isMobile && (
                  <Button
                    aria-label={
                      isSettingsRoot
                        ? "Back to conversations"
                        : "Back to settings"
                    }
                    className="h-8 w-8 shrink-0 p-0"
                    variant="ghost"
                    onClick={() => {
                      window.dispatchEvent(new Event("tensamin:navigate-back"));
                      void navigate({ to: isSettingsRoot ? "/" : "/settings" });
                    }}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                )}
                <h1 className="text-xl font-semibold">
                  {location.pathname
                    .split("/")
                    .pop()
                    ?.replace(/-/g, " ")
                    .replace(/\b\w/g, (letter) => letter.toUpperCase())}
                </h1>
              </div>
            )}
            <div className="relative flex min-w-0 flex-1 flex-col">
              <div
                className="flex min-w-0 flex-1 flex-col"
                aria-busy={blocked}
                inert={blocked ? true : undefined}
                key={activeProfile?.id ?? "local"}
              >
                <Outlet />
              </div>
              {blocked && (
                <div
                  role="status"
                  aria-label={
                    loading ? "Loading settings" : "Settings unavailable"
                  }
                  aria-live="polite"
                  className="absolute inset-0 z-40"
                  style={{
                    backgroundColor:
                      "color-mix(in srgb, var(--background) 30%, transparent)",
                  }}
                  onWheel={(event) =>
                    scrollRef.current?.scrollBy({ top: event.deltaY })
                  }
                  onTouchStart={(event) => {
                    touchYRef.current = event.touches[0]?.clientY ?? null;
                  }}
                  onTouchMove={(event) => {
                    const next = event.touches[0]?.clientY;

                    if (next === undefined || touchYRef.current === null)
                      return;
                    scrollRef.current?.scrollBy({
                      top: touchYRef.current - next,
                    });
                    touchYRef.current = next;
                  }}
                  onTouchEnd={() => {
                    touchYRef.current = null;
                  }}
                >
                  <span className="sr-only">
                    {loading ? "Loading settings" : "Settings unavailable"}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

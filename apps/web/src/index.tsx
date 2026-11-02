import "@tensamin/shared/console";
import { createRoot } from "react-dom/client";
import DeveloperMenu, {
  DeveloperMenuHint,
} from "@tensamin/shared/developerMenu";
import LoginDeveloperMenu from "@tensamin/login/loginDeveloperMenu";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createHashHistory,
  createRouter,
  useRouter,
} from "@tanstack/react-router";

import "./index.css";
import "@nonanium/ui/index.css";

import NotFound from "@/routes/404";
import Home from "@/routes/app/home";
import AppShell from "@/routes/app/shell";
import Login from "@tensamin/login/loginForm";
import Register from "@tensamin/login/registerScreen";

import { createSettingsRoute } from "@tensamin/settings";
import ChatScreen from "@tensamin/chat/screen";
import CallScreen from "@tensamin/call/screen";
import Authorize from "@tensamin/tauth/authorize";

import DeeplinkContext from "@tensamin/tauri/deeplinkHandler";

import {
  LoadingScreen,
  ErrorScreen,
  ErrorScreenProvider,
  ThemeProvider,
  useTheme,
  type Theme,
} from "@nonanium/ui";
import z from "zod";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import Storage from "@tensamin/storage/context";
import { log } from "@tensamin/shared/log";

import { useStorage } from "@tensamin/storage/context";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useIsMobile, Toaster, TooltipProvider } from "@nonanium/ui";
import { HotkeysProvider } from "@tensamin/hotkeys";
import { storageDefaults } from "@tensamin/shared/data";

let nextNavigationDirection: "forward" | "back" = "forward";
addEventListener("popstate", () => {
  nextNavigationDirection = "back";
});
addEventListener("tensamin:navigate-back", () => {
  nextNavigationDirection = "back";
});

const wrapper = document.getElementById("root");

if (!wrapper) {
  throw new Error("Missing root element");
}

if (localStorage.getItem("log_level") === null) {
  console.log(
    "%cDo not paste anything in here, there is a 101.1% chance you're being scammed.",
    "color: red; font-size: 24px; font-weight: bold; background: #220000; padding: 8px 12px; border: 3px solid red;",
  );
}

// @ts-expect-error Declare global function
window.enableDev = () => {
  localStorage.setItem("log_level", String(1000));
  location.reload();
};

function LoginWrapper({ children }: { children: ReactNode }) {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [loginError, setLoginError] = useState<Error | null>(null);

  const { load, secureStorage } = useStorage();

  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (secureStorage === null) return;
    let active = true;

    Promise.all([load("user_id"), load("mtp_keyring")])
      .then(([userId, keyring]) => {
        if (!active) return;
        if (userId !== 0 && keyring !== "") {
          setLoggedIn(true);
          const pendingAuthorization = sessionStorage.getItem(
            "tauth.authorization",
          );
          if (location.pathname === "/login" && pendingAuthorization) {
            sessionStorage.removeItem("tauth.authorization");
            window.location.assign(pendingAuthorization);
            return;
          }
          if (
            location.pathname === "/login" ||
            location.pathname === "/register"
          ) {
            void navigate({ to: "/", replace: true });
          }
          return;
        }
        setLoggedIn(false);
        if (location.pathname !== "/register") {
          if (location.pathname === "/authorize") {
            sessionStorage.setItem("tauth.authorization", window.location.href);
          }
          void navigate({
            to: "/login",
            replace: true,
          });
        }
      })
      .catch((error) => {
        log(0, "login", "red", "Failed to load login state", error);
        setLoginError(
          error instanceof Error ? error : new Error(String(error)),
        );
      });

    return () => {
      active = false;
    };
  }, [load, location.pathname, navigate, secureStorage]);

  if (loginError) {
    return (
      <ErrorScreen
        error="Failed to load login state"
        description={loginError.message}
        // eslint-disable-next-line tensamin/no-window-location-reload -- Reload the failed startup state rather than navigating within it.
        onRetry={() => window.location.reload()}
        statusLink={false}
      />
    );
  }

  if (
    loggedIn !== true &&
    location.pathname !== "/login" &&
    location.pathname !== "/register"
  ) {
    return <LoadingScreen title="Checking account" progress={4} />;
  }

  return (
    <>
      {children}
      {(location.pathname === "/login" ||
        location.pathname === "/register") && <LoginDeveloperMenu />}
    </>
  );
}

function ThemePolarityBridge() {
  const { load, save, subscribe } = useStorage();
  const { themePolarity, setThemePolarity, resolvedPolarity } = useTheme();
  useEffect(() => {
    const bridge = (
      window as Window & {
        tensaminSafeArea?: { setLightSystemBars?: (light: boolean) => void };
      }
    ).tensaminSafeArea;
    bridge?.setLightSystemBars?.(resolvedPolarity === "light");
  }, [resolvedPolarity]);
  const [revision, setRevision] = useState(0);
  const ready = useRef(false);
  useEffect(
    () =>
      subscribe((keys, bulk) => {
        if (bulk && keys.includes("theme_polarity")) {
          ready.current = false;
          setRevision((value) => value + 1);
        }
      }),
    [subscribe],
  );
  useEffect(() => {
    let active = true;
    void load("theme_polarity").then((value) => {
      if (!active) return;
      setThemePolarity(value);
      ready.current = true;
    });
    return () => {
      active = false;
    };
  }, [load, revision, setThemePolarity]);
  useEffect(() => {
    if (ready.current) void save("theme_polarity", themePolarity);
  }, [save, themePolarity]);
  return null;
}

function StoredThemeProvider({ children }: { children: ReactNode }) {
  const { load, save, subscribe } = useStorage();
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState(storageDefaults.theme_selected_id);
  const [customThemes, setCustomThemes] = useState<Theme[]>([]);
  const ready = useRef(false);

  useEffect(
    () =>
      subscribe((keys, bulk) => {
        if (bulk && keys.some((key) => key.startsWith("theme_"))) {
          ready.current = false;
          setRevision((value) => value + 1);
        }
      }),
    [subscribe],
  );

  useEffect(() => {
    let active = true;
    void Promise.all([
      load("theme_selected_id"),
      load("theme_custom_themes"),
      load("theme_parent"),
      load("theme_custom_css"),
      load("theme_design"),
      load("theme_color"),
      load("theme_tint"),
      load("theme_primary_color"),
      load("theme_palette"),
      load("theme_border_radius"),
    ]).then(async ([id, themes]) => {
      if (!active) return;
      setCustomThemes(themes);
      setSelection(id);
      ready.current = true;
    });
    return () => {
      active = false;
    };
  }, [load, revision, save]);

  return (
    <ThemeProvider
      storageKey={null}
      customThemes={customThemes}
      selectedThemeId={selection}
      onCustomThemesChange={(themes) => {
        if (!ready.current) return;
        setCustomThemes(themes);
        void save("theme_custom_themes", themes);
      }}
      onSelectedThemeIdChange={(id) => {
        if (!ready.current) return;
        setSelection(id);
        void save("theme_selected_id", id);
      }}
    >
      <ThemePolarityBridge />
      {children}
    </ThemeProvider>
  );
}

function RootShell() {
  const isMobile = useIsMobile();
  const router = useRouter();
  useEffect(() => {
    const onBack = (event: Event) => {
      const dismissal = new CustomEvent("nonanium:back", {
        cancelable: true,
        detail: { result: "none" },
      });
      window.dispatchEvent(dismissal);
      if (dismissal.defaultPrevented) {
        event.preventDefault();
      } else if (router.history.canGoBack()) {
        event.preventDefault();
        router.history.back();
      }
    };
    window.addEventListener("tensamin:back", onBack);
    return () => window.removeEventListener("tensamin:back", onBack);
  }, [router]);
  useLayoutEffect(() => {
    const bridge = (
      window as Window & { tensaminSafeArea?: { getInsets: () => string } }
    ).tensaminSafeArea;
    if (!bridge) return;

    const updateInsets = () => {
      const insets = JSON.parse(bridge.getInsets()) as {
        top: number;
        right: number;
        bottom: number;
        left: number;
        width: number;
      };
      if (!insets.width) return;
      // Native insets are physical pixels. Respect the user's WebView scale.
      const scale = window.innerWidth / insets.width;
      for (const side of ["top", "right", "bottom", "left"] as const) {
        document.documentElement.style.setProperty(
          `--android-safe-area-${side}`,
          `${insets[side] * scale}px`,
        );
      }
    };
    updateInsets();
    window.addEventListener("tensamin:insets", updateInsets);
    window.addEventListener("resize", updateInsets);
    return () => {
      window.removeEventListener("tensamin:insets", updateInsets);
      window.removeEventListener("resize", updateInsets);
    };
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    const removeDragRegions = () => {
      document
        .querySelectorAll("[data-tauri-drag-region]")
        .forEach((element) => {
          element.removeAttribute("data-tauri-drag-region");
        });
    };
    removeDragRegions();
    const observer = new MutationObserver(removeDragRegions);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-tauri-drag-region"],
    });
    return () => observer.disconnect();
  }, [isMobile]);

  return (
    <DeeplinkContext>
      <Storage>
        <StoredThemeProvider>
          <div
            data-safe-area-root
            className="box-border w-screen h-dvh overflow-hidden bg-background has-data-[chat-composer]:bg-[linear-gradient(to_top,var(--card)_var(--ui-safe-area-bottom),transparent_var(--ui-safe-area-bottom))]"
          >
            <Toaster position={isMobile ? "top-center" : "bottom-right"} />
            <TooltipProvider>
              <HotkeysProvider>
                <LoginWrapper>
                  <Outlet />
                </LoginWrapper>
              </HotkeysProvider>
            </TooltipProvider>
          </div>
        </StoredThemeProvider>
      </Storage>
    </DeeplinkContext>
  );
}

const rootRoute = createRootRoute({
  component: RootShell,
  errorComponent: ({ error }: { error: Error }) => (
    <ErrorScreen
      description={error.message}
      error={"Unknown error: " + error.name}
      // eslint-disable-next-line tensamin/no-window-location-reload -- Restart providers after an unrecoverable render failure.
      onRetry={() => window.location.reload()}
      statusLink={false}
    />
  ),
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppShell,
  notFoundComponent: NotFound,
});

const settingsRoute = createSettingsRoute(appRoute);

const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: Home,
  staticData: {
    showMobileNavbar: false,
  },
});

const chatRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "chat",
  component: ChatScreen,
  validateSearch: z.object({
    id: z.number().optional(),
  }),
  staticData: {
    showMobileNavbar: true,
  },
});

const callRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "call",
  component: CallScreen,
  staticData: {
    showMobileNavbar: true,
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "login",
  component: Login,
  staticData: {
    showMobileNavbar: false,
  },
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "register",
  component: Register,
  staticData: {
    showMobileNavbar: false,
  },
});

const authorizeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "authorize",
  validateSearch: z.object({ request: z.string().optional() }),
  component: function AuthorizationRoute() {
    const { request } = authorizeRoute.useSearch();
    return <Authorize request={request} />;
  },
});

const routeTree = rootRoute.addChildren([
  appRoute.addChildren([
    homeRoute,
    chatRoute,
    callRoute,
    settingsRoute,
    authorizeRoute,
  ]),
  loginRoute,
  registerRoute,
]);

const router = createRouter({
  routeTree,
  history:
    window.location.protocol === "file:" ? createHashHistory() : undefined,
  defaultViewTransition: {
    types: ({ hrefChanged }) => {
      const direction = nextNavigationDirection;
      nextNavigationDirection = "forward";
      return hrefChanged &&
        matchMedia("(max-width: 767px)").matches &&
        !matchMedia("(prefers-reduced-motion: reduce)").matches &&
        "startViewTransition" in document &&
        CSS.supports("selector(:active-view-transition-type(forward))")
        ? [direction]
        : false;
    },
  },
  defaultNotFoundComponent: NotFound,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(wrapper).render(
  <>
    <DeveloperMenu />
    <ErrorScreenProvider footer={<DeveloperMenuHint />}>
      <RouterProvider router={router} />
    </ErrorScreenProvider>
  </>,
);

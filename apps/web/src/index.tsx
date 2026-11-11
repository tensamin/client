import {
  Outlet,
  RouterProvider,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  defaultParseSearch,
  defaultStringifySearch,
  useRouter,
} from "@tanstack/react-router";
import { invoke, isTauri } from "@tauri-apps/api/core";
import LoginDeveloperMenu from "@tensamin/login/loginDeveloperMenu";
import "@tensamin/shared/console";
import DeveloperMenu, {
  DeveloperMenuHint,
} from "@tensamin/shared/developerMenu";
import { createRoot } from "react-dom/client";
import "./validation";

import "./index.css";
import "@nonanium/ui/index.css";

import NotFound from "@/routes/404";
import Home from "@/routes/app/home";
import IotaSettings from "@/routes/app/settings/iota";
import AppShell from "@/routes/app/shell";
import Login from "@tensamin/login/loginForm";
import Register from "@tensamin/login/registerScreen";

import CallScreen from "@tensamin/call/screen";
import { createSettingsRoute } from "@tensamin/settings";

import DeeplinkContext from "@tensamin/tauri/deeplinkHandler";

import {
  Button,
  ErrorScreen,
  ErrorScreenProvider,
  LoadingScreen,
  ThemeProvider,
  useTheme,
  type Theme,
} from "@nonanium/ui";
import {
  encodePrincipalForUrl,
  parsePrincipal,
} from "@tensamin/shared/principal";
import z from "zod";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { log } from "@tensamin/shared/log";
import Storage from "@tensamin/storage/context";

import { TooltipProvider, useIsMobile } from "@nonanium/ui";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { HotkeysProvider } from "@tensamin/hotkeys";
import { storageDefaults } from "@tensamin/shared/data";
import { useStorage } from "@tensamin/storage/context";
import ChatConversation from "./components/chatFileUpload";
import AppToaster from "./components/toaster";

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

    const credentials = isTauri()
      ? invoke<boolean>("mtp_has_credentials")
      : Promise.all([load("user_id"), load("mtp_keyring")]).then(
          ([userId, keyring]) => userId !== 0 && keyring !== "",
        );
    credentials
      .then((available) => {
        if (!active) return;

        if (available) {
          setLoggedIn(true);
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
        description={
          isTauri() ? (
            <>
              {loginError.message}
              <br />
              Unlock the system credential store and retry. If the saved key is
              missing, Recovery options can clear local app data so you can log
              in again.
            </>
          ) : (
            loginError.message
          )
        }
        actions={
          isTauri() ? (
            <Button
              variant="outline"
              onClick={() =>
                window.dispatchEvent(new Event("tensamin:developer-menu"))
              }
            >
              Recovery options
            </Button>
          ) : undefined
        }
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
        location.pathname === "/register") && (
        <>
          <AppToaster />
          <LoginDeveloperMenu />
        </>
      )}
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

const settingsRoute = createSettingsRoute(appRoute, IotaSettings);

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
  component: ChatConversation,
  validateSearch: z.object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    principal: z
      .string()
      .refine((value) => {
        try {
          parsePrincipal(value);

          return true;
        } catch {
          return false;
        }
      }, "Invalid canonical principal")
      .optional(),
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

const routeTree = rootRoute.addChildren([
  appRoute.addChildren([homeRoute, chatRoute, callRoute, settingsRoute]),
  loginRoute,
  registerRoute,
]);

const router = createRouter({
  routeTree,
  parseSearch: (search) => {
    const parsed = defaultParseSearch(search);

    if (
      "principal" in parsed &&
      typeof parsed.principal === "string" &&
      /^[A-Za-z0-9_-]+$/.test(parsed.principal)
    ) {
      try {
        parsed.principal = atob(
          parsed.principal.replace(/-/g, "+").replace(/_/g, "/"),
        );
      } catch {
        return parsed;
      }
    }

    return parsed;
  },
  stringifySearch: (search) =>
    defaultStringifySearch({
      ...search,
      ...(typeof search.principal === "string" && {
        principal: encodePrincipalForUrl(search.principal),
      }),
    }),
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

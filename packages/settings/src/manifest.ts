import { settingsNavigation } from "./navigation";
import {
  lazyRouteComponent,
  type RouteComponent,
} from "@tanstack/react-router";

import SettingsIndex from "./pages/index";
import Profile from "./pages/profile";
import Security from "./pages/security";
import Chat from "./pages/chat";
import Call from "./pages/call";
import Cache from "./pages/cache";
import Theme from "./pages/theme";
import Accessibility from "./pages/accessibility";
import Hotkeys from "./pages/hotkeys";
import Developer from "./pages/developer";
import Diagnostics from "./pages/diagnostics";

export function createSettingsPages(iota: RouteComponent) {
  const pageComponents = {
    iota,
    profile: Profile,
    security: Security,
    chat: Chat,
    call: Call,
    cache: Cache,
    theme: Theme,
    accessibility: Accessibility,
    hotkeys: Hotkeys,
    developer: Developer,
    // License texts are large and rarely viewed, so they load on demand.
    legal: lazyRouteComponent(() => import("./pages/legal")),
    diagnostics: Diagnostics,
  } as const;

  return [
    { path: "/", component: SettingsIndex },
    ...settingsNavigation.map((page) => ({
      ...page,
      component: pageComponents[page.path],
    })),
  ] as const;
}

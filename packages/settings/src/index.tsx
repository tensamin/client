import {
  createRoute,
  type AnyRoute,
  type RouteComponent,
} from "@tanstack/react-router";

import SettingsLayout from "./layout";
import { createSettingsPages } from "./manifest";

export { SettingsProfilesProvider, useSettingsProfiles } from "./profiles";
export type { SettingsProfile } from "./profiles";
export { SettingsProfileMenu } from "./profileMenu";

export function createSettingsRoute(
  parentRoute: AnyRoute,
  iota: RouteComponent,
) {
  const settingsRoute = createRoute({
    getParentRoute: () => parentRoute,
    path: "settings",
    component: SettingsLayout,
    staticData: { showMobileNavbar: false },
  });

  return settingsRoute.addChildren(
    createSettingsPages(iota).map((page) =>
      createRoute({
        getParentRoute: () => settingsRoute,
        path: page.path,
        component: page.component,
        staticData: { showMobileNavbar: false },
      }),
    ),
  );
}

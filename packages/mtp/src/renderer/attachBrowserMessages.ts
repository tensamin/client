import { isTauri } from "@tauri-apps/api/core";
import { getAppFocused } from "@tensamin/shared/focus";
import { log } from "@tensamin/shared/log";
import { type AccountState } from "../accountSync";

import { subscribeCommittedRelays } from "../relay";

import { type BrowserMtpClient } from "./client";
import type { RendererState } from "./state";

export function attachBrowserMessages(
  state: Pick<
    RendererState,
    "attachSubscriptions" | "clientStateRef" | "clientRef"
  >,
  activeClient: BrowserMtpClient,
  refreshAccountState: () => Promise<AccountState>,
) {
  const { attachSubscriptions, clientStateRef, clientRef } = state;
  const detachAuthenticated = isTauri()
    ? () => {}
    : attachSubscriptions(activeClient);
  const detachRelays = isTauri()
    ? () => {}
    : subscribeCommittedRelays(
        activeClient,
        async () => {
          const state = clientStateRef.current;

          if (!state?.Scope || clientRef.current !== activeClient)
            throw new Error("Account identity unavailable");

          return state;
        },
        () => {
          if (getAppFocused())
            void refreshAccountState().catch((error) =>
              log(1, "mtp", "red", "Relay catch-up failed", error),
            );
        },
      );
  const unsubscribeForeground = isTauri()
    ? () => {}
    : activeClient.subscribe("SessionActivitySet", (message) => {
        if (clientRef.current !== activeClient || !message.id) return;
        void activeClient
          .send(
            "SessionActivitySet",
            { Foreground: getAppFocused() },
            { id: message.id },
          )
          .catch((error) =>
            log(1, "mtp", "yellow", "Foreground reply failed", error),
          );
      });
  return () => {
    unsubscribeForeground();
    detachRelays();
    detachAuthenticated();
  };
}

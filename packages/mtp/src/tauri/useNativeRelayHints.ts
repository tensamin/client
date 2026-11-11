import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getAppFocused } from "@tensamin/shared/focus";
import { log } from "@tensamin/shared/log";
import { publishNotificationHint } from "@tensamin/shared/notification";
import { useEffect } from "react";
import { type AccountState } from "../accountSync";

export function useNativeRelayHints(
  refreshAccountState: () => Promise<AccountState>,
) {
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<{
      account: string;
      signer: string;
      relayId: string;
      kind: string;
      time: number;
      order: number;
    }>("tensamin://notification", ({ payload }) => {
      if (
        payload.kind === "FileShareOffered" ||
        payload.kind === "FileShareRevoked"
      ) {
        publishNotificationHint({
          ...payload,
          kind: payload.kind,
          time: payload.time,
        });

        return;
      }

      if (getAppFocused())
        void refreshAccountState().catch((error) =>
          log(1, "mtp", "red", "Foreground relay catch-up failed", error),
        );
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });

    return () => {
      disposed = true;
      stop?.();
    };
  }, [refreshAccountState]);
}

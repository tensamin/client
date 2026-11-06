import { useCallback, useEffect } from "react";
import type { SyncScope } from "@tensamin/shared/accountSync";
import { toast } from "@tensamin/shared/log";
import type { SealedRelaySend } from "./mtpContext";
import { createRelayOutbox, type RelayOutboxClient } from "./relayOutbox";

export function useRelayOutbox({
  transport,
  scope,
  ready,
  isCurrent,
}: {
  transport: () => RelayOutboxClient;
  scope: SyncScope | undefined;
  ready: boolean;
  isCurrent: () => boolean;
}): SealedRelaySend {
  const key = scope ? JSON.stringify(scope) : null;
  useEffect(() => {
    if (!ready || !key) return;
    const outbox = createRelayOutbox({
      client: transport(),
      scope: JSON.parse(key),
      isCurrent,
    });
    const controller = new AbortController();
    let reported = false;
    const report = () => {
      if (controller.signal.aborted || reported) return;
      reported = true;
      toast(
        "error",
        "An outgoing operation is still pending",
        "Its original encrypted command is retained. A replacement will not be sent while its outcome is unknown.",
      );
    };
    // Recovery runs once for this authenticated transport, not on a timer or
    // every account refresh. It never rebuilds or re-signs a pending command.
    void outbox.resume(report, controller.signal).catch(report);
    return () => {
      controller.abort();
    };
  }, [transport, key, isCurrent, ready]);

  return useCallback<SealedRelaySend>(
    (...args) => {
      if (!ready || !key) throw new Error("MTP is not authenticated");
      return createRelayOutbox({
        client: transport(),
        scope: JSON.parse(key),
        isCurrent,
      }).send(...args);
    },
    [transport, key, isCurrent, ready],
  );
}

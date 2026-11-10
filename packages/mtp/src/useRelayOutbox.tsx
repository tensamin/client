import { useCallback, useEffect, useState } from "react";
import type { SyncScope } from "@tensamin/shared/accountSync";
import {
  notify,
  Button,
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@nonanium/ui";
import type { SealedRelaySend } from "./mtpContext";
import {
  createRelayOutbox,
  PendingRelayScopeError,
  type RelayOutboxClient,
} from "./relayOutbox";
import { useAppFocused } from "@tensamin/shared/focus";

function DiscardPendingRelay({
  recovery,
  toastId,
}: {
  recovery: PendingRelayScopeError;
  toastId: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button variant="outline" size="sm" disabled={busy}>
            Review
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard this pending operation?</AlertDialogTitle>
          <AlertDialogDescription>
            The result of this {recovery.type} operation is unknown. It may
            already have been delivered. Discarding removes only its local
            recovery record; it cannot undo remote changes. Sending a
            replacement may duplicate the operation.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={async (event) => {
              event.preventDefault();
              setBusy(true);
              try {
                await recovery.discard();
                notify.dismiss(toastId);
                setOpen(false);
              } catch (error) {
                notify(
                  "error",
                  "Could not discard pending operation",
                  String(error),
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            Discard pending operation
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function reportPending(recovery?: PendingRelayScopeError) {
  const id = recovery ? `pending-relay:${recovery.resource}` : "pending-relay";
  notify(
    "error",
    "An outgoing operation is still pending",
    recovery
      ? "It uses an earlier account session or protocol version and cannot be safely resent. Review the retained operation before replacing it."
      : "Its original encrypted command is retained. A replacement will not be sent while its outcome is unknown.",
    {
      id,
      duration: Infinity,
      closeButton: true,
      ...(recovery && {
        action: <DiscardPendingRelay recovery={recovery} toastId={id} />,
      }),
    },
  );
}

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
  const visible = useAppFocused();
  const key = scope ? JSON.stringify(scope) : null;
  useEffect(() => {
    if (!ready || !key || !visible) return;
    const outbox = createRelayOutbox({
      client: transport(),
      scope: JSON.parse(key),
      isCurrent,
    });
    const controller = new AbortController();
    let reported = false;
    const report = (_type?: string, recovery?: PendingRelayScopeError) => {
      if (controller.signal.aborted || reported) return;
      reported = true;
      reportPending(recovery);
    };

    // Foreground recovery never rebuilds or re-signs a pending command.
    void outbox
      .resume(report, controller.signal)
      .catch((error: unknown) =>
        report(
          undefined,
          error instanceof PendingRelayScopeError ? error : undefined,
        ),
      );

    return () => {
      controller.abort();
    };
  }, [transport, key, isCurrent, ready, visible]);

  return useCallback<SealedRelaySend>(
    async (...args) => {
      if (!ready || !key) throw new Error("MTP is not authenticated");

      try {
        return await createRelayOutbox({
          client: transport(),
          scope: JSON.parse(key),
          isCurrent,
        }).send(...args);
      } catch (error) {
        if (error instanceof PendingRelayScopeError) reportPending(error);
        throw error;
      }
    },
    [transport, key, isCurrent, ready],
  );
}

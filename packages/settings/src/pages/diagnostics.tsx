import {
  Button,
  Label,
  Switch,
  useIsMobile,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@nonanium/ui";
import { Check, Info } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "@tensamin/shared/log";
import {
  clearDiagnostics,
  diagnosticSnapshot,
  diagnosticEvent,
  exportDiagnostics,
  setDiagnosticCollection,
} from "@tensamin/mtp/diagnostics";

export default function Diagnostics() {
  const isMobile = useIsMobile();
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState<"export" | "clear" | null>(null);
  useEffect(() => {
    if (!completed) return;
    const timeout = window.setTimeout(() => setCompleted(null), 2000);
    return () => window.clearTimeout(timeout);
  }, [completed]);
  useEffect(() => {
    diagnosticEvent("diagnostics_shown");
    void diagnosticSnapshot()
      .then((snapshot) => {
        const history = snapshot.history as {
          enabled: boolean;
          storage_available: boolean;
        };
        setEnabled(history.enabled);
        if (!history.storage_available)
          toast(
            "error",
            "Diagnostic history cannot be saved",
            "You can still export the available measurements.",
            { duration: Infinity, closeButton: true },
          );
        setLoaded(true);
      })
      .catch(() =>
        toast("error", "Diagnostics could not be loaded", "Please try again.", {
          duration: Infinity,
          closeButton: true,
        }),
      );
  }, []);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setCompleted(null);
    try {
      await task();
    } catch {
      toast("error", "Diagnostic operation failed", "Please try again.", {
        duration: Infinity,
        closeButton: true,
      });
    } finally {
      setBusy(false);
    }
  }

  const infoButton = (
    <Button variant="ghost" size="icon" aria-label="About diagnostic reports">
      <Info className="size-4" />
    </Button>
  );

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="usage-diagnostics">Collect usage diagnostics</Label>
          <Switch
            id="usage-diagnostics"
            aria-describedby="usage-diagnostics-description"
            checked={enabled}
            disabled={!loaded || busy}
            onCheckedChange={(value) => {
              void run(async () => {
                await setDiagnosticCollection(value);
                setEnabled(value);
              });
            }}
          />
        </div>
        <p
          id="usage-diagnostics-description"
          className="text-sm text-muted-foreground"
        >
          These diagnostic reports stay on this device and don't get uploaded.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button
          className="relative"
          disabled={!loaded || busy}
          onClick={() => {
            void run(async () => {
              diagnosticEvent("diagnostics_export_start");
              try {
                const exported = await exportDiagnostics();
                diagnosticEvent(
                  exported
                    ? "diagnostics_export_success"
                    : "diagnostics_export_cancel",
                );
                if (exported) setCompleted("export");
              } catch (error) {
                diagnosticEvent("diagnostics_export_failure");
                throw error;
              }
            });
          }}
        >
          <span className={completed === "export" ? "opacity-0" : undefined}>
            Export report
          </span>
          {completed === "export" && <Check className="absolute size-4" />}
        </Button>
        <Button
          className="relative"
          variant="outline"
          disabled={!loaded || busy}
          onClick={() => {
            void run(async () => {
              await clearDiagnostics();
              setCompleted("clear");
            });
          }}
        >
          <span className={completed === "clear" ? "opacity-0" : undefined}>
            Clear history
          </span>
          {completed === "clear" && <Check className="absolute size-4" />}
        </Button>
        <div className="ms-auto shrink-0">
          {isMobile ? (
            <Dialog>
              <DialogTrigger render={infoButton} />
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>About diagnostic reports</DialogTitle>
                </DialogHeader>
                <ReportDetails />
              </DialogContent>
            </Dialog>
          ) : (
            <Tooltip>
              <TooltipTrigger render={infoButton} />
              <TooltipContent className="max-w-sm">
                <ReportDetails />
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

function ReportDetails() {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>
        Reports include timestamps, app and MTP versions, available OS and
        device specifications, connection outcomes, protocol traffic, crypto
        timings, resource samples, and startup and onboarding transitions.
        Battery measurements depend on the platform.
      </p>
      <p>
        They exclude messages, payloads, account identifiers, network addresses,
        credentials, keys, and unrestricted error messages.
      </p>
      <p>
        History expires after 24 hours and uses at most 4 MiB. The transition
        timeline keeps at most 1,024 events. Old history is removed
        automatically. Turning collection off keeps existing history until it
        expires or you clear it.
      </p>
      <p>You choose whether to export a report and who to share it with.</p>
    </div>
  );
}

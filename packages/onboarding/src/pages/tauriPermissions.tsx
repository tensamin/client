import { useEffect, useState } from "react";
import { Button, useOnboardingStep } from "@nonanium/ui";
import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { BatteryCharging, Bell } from "lucide-react";
import { toast } from "@tensamin/shared/log";

export default function TauriPermissionsPage() {
  const [notificationsGranted, setNotificationsGranted] = useState(false);
  const [batteryExempt, setBatteryExempt] = useState(false);
  const [notificationAttempted, setNotificationAttempted] = useState(false);
  const [batteryAttempted, setBatteryAttempted] = useState(false);

  useEffect(() => {
    let active = true;
    let refreshing = false;
    const refresh = () => {
      if (
        refreshing ||
        document.visibilityState !== "visible" ||
        location.href === "about:blank"
      )
        return;
      refreshing = true;
      void Promise.all([
        isPermissionGranted(),
        invoke<boolean>("mtp_is_ignoring_battery_optimizations"),
      ])
        .then(([notifications, battery]) => {
          if (!active) return;
          setNotificationsGranted(notifications);
          setBatteryExempt(battery);
        })
        .catch(() => {
          // Android can briefly report about:blank while replacing the WebView.
          // The next visible refresh retries against the local app origin.
        })
        .finally(() => {
          refreshing = false;
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const interval = window.setInterval(refresh, 1_000);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(interval);
    };
  }, []);

  useOnboardingStep({
    canContinue:
      (notificationsGranted || notificationAttempted) &&
      (batteryExempt || batteryAttempted),
    onContinue: async () => {
      await invoke("plugin:mtp|mtp_set_background_enabled", { enabled: true });
    },
  });

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-12 py-6">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div>
            <Bell className="h-6! w-6!" />
          </div>
          <div>
            <h3 className="font-semibold">Allow notifications</h3>
            <p className="text-muted-foreground text-sm">
              Allow Tensamin to notify you while it's closed.
            </p>
          </div>
        </div>
        <Button
          variant={notificationsGranted ? "outline" : "default"}
          disabled={notificationsGranted}
          onClick={() => {
            setNotificationAttempted(true);
            void requestPermission()
              .then((permission) => {
                setNotificationsGranted(permission === "granted");
              })
              .catch((error: unknown) =>
                toast(
                  "error",
                  "Requesting notification permission failed",
                  error instanceof Error ? error.message : String(error),
                ),
              );
          }}
        >
          {notificationsGranted ? "Allowed" : "Allow notifications"}
        </Button>
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div>
            <BatteryCharging className="h-6! w-6!" />
          </div>
          <div>
            <h3 className="font-semibold">Allow running in the background</h3>
            <p className="text-muted-foreground text-sm">
              Exclude Tensamin from battery optimisation so Android does not
              suspend it's connection for decryption of live messages.
            </p>
          </div>
        </div>
        <Button
          variant={batteryExempt ? "outline" : "default"}
          disabled={batteryExempt}
          onClick={() => {
            setBatteryAttempted(true);
            void invoke("mtp_request_battery_exemption");
          }}
        >
          {batteryExempt ? "Allowed" : "Open battery prompt"}
        </Button>
      </div>
    </div>
  );
}

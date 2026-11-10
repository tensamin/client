import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
} from "@nonanium/ui";
import { clearDatabaseStore } from "./indexedDb";
import { toast } from "./log";

export default function ClearStorageButton({
  className,
}: {
  className?: string;
}) {
  async function clearStorage() {
    try {
      if (isTauri()) {
        await invoke("plugin:mtp|mtp_clear_credentials", {
          name: "mtp:credentials",
        });
        await invoke("mtp_clear_credentials");
      }

      await window.tensaminDesktop?.secureStorage?.clear?.();
      await Promise.all(
        (["storage", "cache", "keys"] as const).map(clearDatabaseStore),
      );
      localStorage.clear();
      // Reload the app entry point, not the current settings URL in a packaged app.
      location.replace(
        new URL(
          location.protocol === "file:" ? location.pathname : "/",
          location.href,
        ),
      );
    } catch (error) {
      toast(
        "error",
        "Clearing local data failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return (
    <div>
      <AlertDialog>
        <AlertDialogTrigger
          render={
            <Button className={className} variant="destructive">
              Clear data and log out
            </Button>
          }
        />
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all local data?</AlertDialogTitle>
            <AlertDialogDescription>
              This will clear settings, cached messages and credentials. You
              will need to log in again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={clearStorage}>
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

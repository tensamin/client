import { useEffect, useState } from "react";
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@nonanium/ui";
import { Bug, Copy, Trash2 } from "lucide-react";
import { getConsoleOutput } from "./console";
import { clearSiteData } from "./clearSiteData";
import { toast } from "./log";

export function DeveloperMenuHint() {
  return (
    <button
      type="button"
      className="rounded px-2 py-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      onClick={() => window.dispatchEvent(new Event("tensamin:developer-menu"))}
    >
      Press Ctrl+Shift+J to reset the app.
    </button>
  );
}

export default function DeveloperMenu() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const show = () => setOpen(true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !event.ctrlKey ||
        !event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        event.key.toLowerCase() !== "j"
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) setOpen((value) => !value);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("tensamin:developer-menu", show);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("tensamin:developer-menu", show);
    };
  }, []);

  async function run(action: () => void | Promise<void>, success: string) {
    setBusy(true);
    try {
      await action();
      toast("success", success);
    } catch (error) {
      console.error("Developer menu action failed", error);
      toast(
        "error",
        "Developer action failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <Command>
        <CommandInput placeholder="Search for tools..." />
        <CommandList>
          <CommandGroup>
            <CommandItem
              disabled={busy}
              onSelect={() =>
                // @ts-expect-error custom
                void run(window.enableDev(), "Developer mode enabled.")
              }
            >
              <Bug />
              Enable developer mode
            </CommandItem>
            <CommandItem
              disabled={busy}
              onSelect={() =>
                void run(
                  () => navigator.clipboard.writeText(getConsoleOutput()),
                  "Console copied.",
                )
              }
            >
              <Copy />
              Copy entire console
            </CommandItem>
            <CommandItem
              disabled={busy}
              onSelect={() => void run(clearSiteData, "Site data cleared.")}
            >
              <Trash2 />
              Clear all site data now
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

import { Button, Input, Label } from "@nonanium/ui";
import { createSettingsClient, useMTP } from "@tensamin/mtp";
import { toast } from "@tensamin/shared/log";
import { MTPProtocolError } from "mtp";
import { useEffect, useMemo, useState } from "react";

const accessSetting = "chat-file-access-days";
const infoSetting = "file-access-info-seen";
const information = new Map<string, Promise<void>>();

export function useFileAccess(contactId: number) {
  const { send, subscribe, accountKey, contextReady } = useMTP();
  const client = useMemo(
    () => createSettingsClient({ send, subscribe, clientState: null }),
    [send, subscribe],
  );
  const [value, setValue] = useState<{
    account: string;
    contact: number;
    days: number;
  }>();
  const [saving, setSaving] = useState(false);
  const target = String(contactId);

  useEffect(() => {
    if (!accountKey || !contextReady || !contactId) return;
    let active = true;
    let generation = 0;
    async function refresh() {
      if (!active) return;
      const current = ++generation;
      try {
        const setting = await client
          .getSetting("contact", target, accessSetting)
          .catch((error) => {
            if (
              error instanceof MTPProtocolError &&
              error.type === "ErrorNotFound"
            )
              return null;
            throw error;
          });
        const days = setting ? Number(setting.payload) : 365;
        if (!Number.isInteger(days) || days < 1 || days > 36500)
          throw new Error("Invalid default file access duration");
        if (active && current === generation)
          setValue({ account: accountKey!, contact: contactId, days });
      } catch (error) {
        if (active && current === generation)
          toast("error", "Couldn't load file access settings", String(error), {
            action: { label: "Retry", onClick: () => void refresh() },
          });
      }
    }
    const unsubscribe = client.subscribeSettingChanges((event) => {
      if (
        "deletedIds" in event ||
        (event.scope === "contact" &&
          event.target === target &&
          event.name === accessSetting)
      )
        void refresh();
    });
    void refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [accountKey, client, contactId, contextReady, target]);

  const days =
    value && value.account === accountKey && value.contact === contactId
      ? value.days
      : undefined;
  return {
    days,
    saving,
    async save(days: number) {
      if (!accountKey || !contextReady || saving) return;
      if (!Number.isInteger(days) || days < 1 || days > 36500) {
        toast("error", "Choose between 1 and 36500 days");
        return;
      }
      setSaving(true);
      try {
        await client.setSetting({
          scope: "contact",
          target,
          name: accessSetting,
          payload: String(days),
        });
        setValue({ account: accountKey, contact: contactId, days });
      } catch (error) {
        toast("error", "Couldn't save file access settings", String(error));
      } finally {
        setSaving(false);
      }
    },
  };
}

export function FileAccessSettings({ contactId }: { contactId: number }) {
  const { days, saving, save } = useFileAccess(contactId);
  const [draft, setDraft] = useState<string>();
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="default-file-access">Default file access in days</Label>
      <p className="text-sm text-muted-foreground">
        New files shared with this contact use this duration. Existing shares
        keep their expiry.
      </p>
      <div className="flex gap-2">
        <Input
          id="default-file-access"
          type="number"
          min={1}
          max={36500}
          step={1}
          value={draft ?? String(days ?? "")}
          disabled={days === undefined || saving}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          variant="outline"
          disabled={
            days === undefined || saving || Number(draft ?? days) === days
          }
          onClick={() => void save(Number(draft))}
        >
          Save duration
        </Button>
      </div>
    </div>
  );
}

export function useFileAccessInfo() {
  const { send, subscribe, accountKey, contextReady } = useMTP();
  return async () => {
    if (!accountKey || !contextReady) return;
    if (information.has(accountKey)) return information.get(accountKey);
    const client = createSettingsClient({ send, subscribe, clientState: null });
    const pending = (async () => {
      try {
        const setting = await client
          .getSetting("user", "", infoSetting)
          .catch((error) => {
            if (
              error instanceof MTPProtocolError &&
              error.type === "ErrorNotFound"
            )
              return null;
            throw error;
          });
        if (setting?.payload === "1") return;
        toast(
          "info",
          "About file access",
          "Chat files are accessible for one year by default. Change a contact's default in Customisation, or choose an expiry for an individual file.",
        );
        await client.setSetting({
          scope: "user",
          target: "",
          name: infoSetting,
          payload: "1",
        });
      } catch (error) {
        information.delete(accountKey);
        toast("error", "Couldn't save file access information", String(error));
      }
    })();
    information.set(accountKey, pending);
    return pending;
  };
}

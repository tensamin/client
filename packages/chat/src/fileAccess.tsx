import { notify as toast } from "@nonanium/ui";
import { createSettingsClient, useMTP } from "@tensamin/mtp";
import { MTPProtocolError } from "mtp";
import { useEffect, useMemo, useState } from "react";

const accessSetting = "chat-file-access-days";
const infoSetting = "file-access-info-dismissed";

export function parseFileAccessDuration(value: string) {
  const match =
    /^(?:(\d+)\s*years?\s*)?(?:(\d+)\s*months?\s*)?(?:(\d+)\s*days?\s*)?$/i.exec(
      value.trim(),
    );
  if (!match || !match.slice(1).some(Boolean)) return undefined;
  const days =
    Number(match[1] ?? 0) * 365 +
    Number(match[2] ?? 0) * 30 +
    Number(match[3] ?? 0);
  return Number.isSafeInteger(days) && days > 0 && days <= 36500
    ? days
    : undefined;
}

export function formatFileAccessDuration(days: number) {
  const [amount, unit] =
    days % 365 === 0
      ? [days / 365, "year"]
      : days % 30 === 0
        ? [days / 30, "month"]
        : [days, "day"];
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}

export function useFileAccess(contactId: number, enabled = true) {
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
    if (!accountKey || !contextReady || !contactId || !enabled) return;
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
  }, [accountKey, client, contactId, contextReady, target, enabled]);

  const days =
    value && value.account === accountKey && value.contact === contactId
      ? value.days
      : undefined;
  return {
    days,
    saving,
    async save(days: number) {
      if (!accountKey || !contextReady || saving) return false;
      if (!Number.isInteger(days) || days < 1 || days > 36500) {
        toast("error", "Choose between 1 and 36500 days");
        return false;
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
        return true;
      } catch (error) {
        toast("error", "Couldn't save file access settings", String(error));
        return false;
      } finally {
        setSaving(false);
      }
    },
  };
}

export function useFileAccessInfo() {
  const { send, subscribe, accountKey, contextReady } = useMTP();
  const client = useMemo(
    () => createSettingsClient({ send, subscribe, clientState: null }),
    [send, subscribe],
  );
  const [notice, setNotice] = useState<{ account: string; open: boolean }>();
  const [dismissing, setDismissing] = useState(false);
  return {
    noticeOpen:
      notice !== undefined && notice.account === accountKey && notice.open,
    dismissing,
    async showInfo() {
      if (!accountKey || !contextReady) return;
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
        setNotice({ account: accountKey, open: true });
      } catch (error) {
        toast("error", "Couldn't load file access information", String(error));
      }
    },
    async dismissInfo() {
      if (!accountKey || dismissing) return;
      setDismissing(true);
      try {
        await client.setSetting({
          scope: "user",
          target: "",
          name: infoSetting,
          payload: "1",
        });
        setNotice({ account: accountKey, open: false });
      } catch (error) {
        toast("error", "Couldn't save file access information", String(error));
      } finally {
        setDismissing(false);
      }
    },
  };
}

export type IncomingNotification = {
  principal: string;
  relayId: string;
  kind: "message" | "file";
  time: number;
  order?: number;
};

// One preparation per conversation, at most four independent lookups at once.
export function createConversationNotifications(
  prepare: (
    message: IncomingNotification,
    current: () => boolean,
  ) => Promise<void>,
  failed: (error: unknown) => void,
) {
  const pending = new Map<
    string,
    {
      message: IncomingNotification;
      revision: number;
      first: number;
      due: number;
      running: boolean;
      dirty: boolean;
    }
  >();
  const seen = new Set<string>();
  const latest = new Map<string, IncomingNotification>();
  let active = true;
  let running = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drain = () => {
    clearTimeout(timer);
    if (!active) return;
    const now = Date.now();
    for (const [principal, batch] of pending) {
      if (running === 4) break;
      if (batch.running || !batch.dirty || batch.due > now) continue;
      batch.running = true;
      batch.dirty = false;
      const revision = batch.revision;
      running++;
      void prepare(batch.message, () => active && batch.revision === revision)
        .catch(failed)
        .finally(() => {
          running--;
          batch.running = false;
          if (batch.revision === revision) pending.delete(principal);
          else batch.first = Date.now();
          drain();
        });
    }
    const waiting = [...pending.values()].filter(
      (batch) => !batch.running && batch.dirty,
    );
    if (waiting.length && running < 4)
      timer = setTimeout(
        drain,
        Math.max(
          0,
          Math.min(...waiting.map((batch) => batch.due)) - Date.now(),
        ),
      );
  };
  return {
    enqueue(message: IncomingNotification) {
      if (!active) return;
      const id = `${message.principal}:${message.relayId}`;
      if (seen.has(id)) return;
      seen.add(id);
      if (seen.size > 1024) seen.delete(seen.values().next().value!);
      const previous = latest.get(message.principal);
      if (
        previous &&
        (message.time < previous.time ||
          (message.time === previous.time &&
            (message.order ?? 0) < (previous.order ?? 0)))
      )
        return;
      latest.delete(message.principal);
      latest.set(message.principal, message);
      if (latest.size > 1024) latest.delete(latest.keys().next().value!);
      const batch = pending.get(message.principal);
      const now = Date.now();
      if (batch) {
        batch.message = message;
        batch.revision++;
        batch.dirty = true;
        batch.due = Math.min(now + 200, batch.first + 1000);
      } else {
        pending.set(message.principal, {
          message,
          revision: 1,
          first: now,
          due: now + 200,
          running: false,
          dirty: true,
        });
      }
      drain();
    },
    close() {
      active = false;
      clearTimeout(timer);
      pending.clear();
      seen.clear();
      latest.clear();
    },
  };
}

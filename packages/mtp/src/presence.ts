import { mtp, presenceSnapshotSchema } from "@tensamin/shared/data";
import type { z } from "zod";

/** Transport-owned replay closes the gap while account-scoped UI subscribers mount. */
export class PresenceMailbox {
  private contacts = new Set<number>();
  private snapshot:
    | {
        type: "GetStates";
        data: z.infer<typeof presenceSnapshotSchema> & { SessionId: number };
      }
    | undefined;
  private events = new Map<
    number,
    {
      type: "ClientChanged";
      data: z.infer<typeof mtp.ClientChanged.response> & {
        Uuid: string;
        Timestamp: number;
        VersionNumber: number;
      };
    }
  >();

  remember(type: "GetStates" | "ClientChanged", data: unknown) {
    if (type === "GetStates") {
      const complete = presenceSnapshotSchema.safeParse(data);
      const frame = mtp.GetStates.response.safeParse(data);
      if (!complete.success || !frame.success) return;
      const previous = this.snapshot?.data;
      if (
        previous &&
        (previous.Uuid !== complete.data.Uuid ||
          previous.Timestamp > complete.data.Timestamp)
      )
        return;
      this.snapshot = {
        type,
        data: { ...complete.data, SessionId: frame.data.SessionId },
      };
      this.contacts = new Set([
        ...complete.data.UserStates.map((entry) => entry.UserId),
        ...complete.data.MissingUserIds,
      ]);
      for (const [userId, event] of this.events) {
        if (
          event.data.Uuid !== complete.data.Uuid ||
          event.data.Timestamp < complete.data.Timestamp ||
          (event.data.Timestamp === complete.data.Timestamp &&
            !this.contacts.has(userId))
        )
          this.events.delete(userId);
      }
    } else {
      const frame = mtp.ClientChanged.response.safeParse(data);
      if (!frame.success) return;
      const event = frame.data;
      if (
        !event.Uuid ||
        event.Timestamp === undefined ||
        event.VersionNumber === undefined
      )
        return;
      const snapshot = this.snapshot?.data;
      if (
        snapshot &&
        (snapshot.Uuid !== event.Uuid || snapshot.Timestamp > event.Timestamp)
      )
        return;
      if (
        snapshot?.Timestamp === event.Timestamp &&
        !this.contacts.has(event.UserId)
      )
        return;
      const previous = this.events.get(event.UserId)?.data;
      if (
        !previous ||
        previous.Timestamp < event.Timestamp ||
        (previous.Timestamp === event.Timestamp &&
          previous.VersionNumber < event.VersionNumber)
      )
        this.events.set(event.UserId, {
          type,
          data: {
            ...event,
            Uuid: event.Uuid,
            Timestamp: event.Timestamp,
            VersionNumber: event.VersionNumber,
          },
        });
    }
  }

  replay(type: "GetStates" | "ClientChanged") {
    return type === "GetStates"
      ? this.snapshot
        ? [this.snapshot]
        : []
      : [...this.events.values()];
  }
}

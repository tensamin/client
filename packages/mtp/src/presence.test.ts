import { describe, expect, it } from "vitest";
import { PresenceMailbox } from "./presence";

const epoch = "e972c8b0-005c-4fb6-93cc-eef5ed99a7e6";
const snapshot = (generation = 1) => ({
  SessionId: 9,
  Uuid: epoch,
  Timestamp: generation,
  VersionNumber: 1,
  UserStates: [{ UserId: 7, UserState: "user_online", VersionNumber: 2 }],
  MissingUserIds: [42],
});
const event = (generation: number, version: number, userId = 7) => ({
  SessionId: 9,
  Uuid: epoch,
  Timestamp: generation,
  VersionNumber: version,
  UserId: userId,
  UserState: "user_dnd",
});

describe("transport-owned presence replay", () => {
  it("retains a live event while account-scoped subscribers are unmounted", () => {
    const mailbox = new PresenceMailbox();
    mailbox.remember("ClientChanged", event(1, 4));
    mailbox.remember("GetStates", snapshot());
    expect(mailbox.replay("GetStates")[0].data).toEqual(snapshot());
    expect(mailbox.replay("ClientChanged")[0].data).toEqual(event(1, 4));
    mailbox.remember("ClientChanged", event(1, 3));
    expect(mailbox.replay("ClientChanged")[0].data.VersionNumber).toBe(4);
  });

  it("rejects older subscriptions, unknown contacts and unversioned legacy frames", () => {
    const mailbox = new PresenceMailbox();
    mailbox.remember("GetStates", snapshot(2));
    mailbox.remember("GetStates", snapshot(1));
    mailbox.remember("ClientChanged", event(1, 99));
    mailbox.remember("ClientChanged", event(2, 99, 999));
    mailbox.remember("ClientChanged", {
      SessionId: 9,
      UserId: 7,
      UserState: "user_online",
    });
    expect(mailbox.replay("GetStates")[0].data.Timestamp).toBe(2);
    expect(mailbox.replay("ClientChanged")).toEqual([]);
    expect(new PresenceMailbox().replay("GetStates")).toEqual([]);
  });

  it("prunes obsolete events after a replacement snapshot but retains its early updates", () => {
    const mailbox = new PresenceMailbox();
    mailbox.remember("GetStates", snapshot(1));
    mailbox.remember("ClientChanged", event(1, 4, 42));
    mailbox.remember("ClientChanged", event(2, 5));
    mailbox.remember("GetStates", snapshot(2));
    expect(mailbox.replay("ClientChanged")).toEqual([
      { type: "ClientChanged", data: event(2, 5) },
    ]);
  });
});

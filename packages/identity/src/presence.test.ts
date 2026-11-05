import { describe, expect, it } from "vitest";
import { PresenceOrder } from "./presence";

describe("presence observation ordering", () => {
  it("never lets a delayed initial snapshot or missing record undo a newer live state", () => {
    const order = new PresenceOrder();
    order.install("epoch-one", 1);
    expect(order.accept("epoch-one", 1, 7, 4)).toBe(true);
    expect(order.accept("epoch-one", 1, 7, 3)).toBe(false);
    expect(order.accept("epoch-one", 1, 7, 1)).toBe(false);
    expect(order.accept("epoch-one", 1, 7, 4)).toBe(false);
    expect(order.accept("epoch-one", 1, 7, 5)).toBe(true);
    expect(order.accept("epoch-one", 1, 42, 2)).toBe(true);
  });

  it("does not install an epoch from an unsolicited live event", () => {
    const order = new PresenceOrder();
    expect(order.accept("epoch-one", 1, 7, 100)).toBe(false);
    order.install("epoch-one", 1);
    expect(order.accept("epoch-one", 1, 7, 100)).toBe(true);
    expect(order.accept("epoch-two", 2, 7, 1)).toBe(false);
    expect(order.install("epoch-one", 1)).toBe(false);
    expect(order.install("epoch-one", 2)).toBe(true);
    expect(order.accept("epoch-one", 2, 7, 1)).toBe(true);
    expect(order.accept("epoch-one", 1, 7, 101)).toBe(false);
    expect(order.install("epoch-one", 1)).toBeNull();
    expect(order.install("epoch-two", 3)).toBeNull();
  });

  it("retains a newer event received before its initial or replacement snapshot", () => {
    const order = new PresenceOrder<string>();
    expect(order.event("epoch-one", 1, 7, 4, "user_dnd")).toBe(false);
    order.install("epoch-one", 1);
    order.accept("epoch-one", 1, 7, 3);
    expect(order.takePending()).toEqual([{ userId: 7, state: "user_dnd" }]);
    expect(order.event("epoch-one", 2, 7, 6, "user_idle")).toBe(false);
    expect(order.takePending()).toEqual([]);
    order.install("epoch-one", 2);
    order.accept("epoch-one", 2, 7, 5);
    expect(order.takePending()).toEqual([{ userId: 7, state: "user_idle" }]);
    expect(order.takePending()).toEqual([]);
  });
});

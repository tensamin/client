import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getAppFocused, setPlatformVisible, waitForForeground } from "./focus";

let documentEvents: EventTarget;
beforeEach(() => {
  documentEvents = new EventTarget();
  Object.defineProperties(documentEvents, {
    visibilityState: { value: "visible", writable: true },
    hasFocus: { value: () => false },
  });
  vi.stubGlobal("document", documentEvents);
  vi.stubGlobal("window", new EventTarget());
  setPlatformVisible(true);
});
afterEach(() => {
  setPlatformVisible(true);
  vi.unstubAllGlobals();
});

function visibility(value: string) {
  Object.defineProperty(documentEvents, "visibilityState", {
    value,
    writable: true,
  });
  documentEvents.dispatchEvent(new Event("visibilitychange"));
}

it("does not suspend a visible application just because keyboard focus moved", async () => {
  expect(getAppFocused()).toBe(true);
  await expect(
    waitForForeground(new AbortController().signal),
  ).resolves.toBeUndefined();
});
it("pauses between bounded requests until both document and platform are visible", async () => {
  visibility("hidden");
  let resumed = false;
  const waiting = waitForForeground(new AbortController().signal).then(() => {
    resumed = true;
  });
  await Promise.resolve();
  expect(resumed).toBe(false);
  setPlatformVisible(false);
  visibility("visible");
  await Promise.resolve();
  expect(resumed).toBe(false);
  setPlatformVisible(true);
  await waiting;
  expect(resumed).toBe(true);
});
it("account cancellation rejects paused work without restarting it on foreground", async () => {
  visibility("hidden");
  const controller = new AbortController();
  const waiting = waitForForeground(controller.signal);
  controller.abort(new Error("account changed"));
  await expect(waiting).rejects.toThrow("account changed");
  visibility("visible");
});

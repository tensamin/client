import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElectronMediaShareAdapter } from "./electron";

const select = vi.fn();
const display = vi.fn();
const stop = vi.fn();
const stream = { getTracks: () => [{ stop }] };
beforeEach(() => {
  vi.resetAllMocks();
  select.mockResolvedValue(true);
  display.mockResolvedValue(stream);
  vi.stubGlobal("window", {
    tensaminDesktop: { media: { selectScreenShareSource: select } },
  });
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: display } });
});
afterEach(() => vi.unstubAllGlobals());

describe("Electron capture request ownership", () => {
  it("selects before capture and returns the requested media session", async () => {
    const session = await new ElectronMediaShareAdapter().start({
      kind: "screen",
      sourceId: "window:chosen",
    });
    expect(select).toHaveBeenCalledExactlyOnceWith("window:chosen");
    expect(select.mock.invocationCallOrder[0]).toBeLessThan(
      display.mock.invocationCallOrder[0],
    );
    await session.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("cancels an unused selection when Chromium rejects before invoking the capture handler", async () => {
    display.mockRejectedValueOnce(new Error("Capture cancelled"));
    await expect(
      new ElectronMediaShareAdapter().start({
        kind: "screen",
        sourceId: "window:chosen",
      }),
    ).rejects.toThrow("Capture cancelled");
    expect(select.mock.calls).toEqual([["window:chosen"], [null]]);
  });

  it("does not start capture after selection is rejected", async () => {
    select.mockResolvedValueOnce(false);
    await expect(
      new ElectronMediaShareAdapter().start({
        kind: "screen",
        sourceId: "window:chosen",
      }),
    ).rejects.toThrow("selection was rejected");
    expect(display).not.toHaveBeenCalled();
  });

  it("rejects overlapping requests across adapter instances without replacing consent", async () => {
    let resolve!: (value: typeof stream) => void;
    let entered!: () => void;
    const ready = new Promise<void>((done) => {
      entered = done;
    });
    display.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
          entered();
        }),
    );
    const first = new ElectronMediaShareAdapter().start({
      kind: "screen",
      sourceId: "window:first",
    });
    await ready;
    await expect(
      new ElectronMediaShareAdapter().start({
        kind: "screen",
        sourceId: "window:second",
      }),
    ).rejects.toThrow("already pending");
    expect(select).toHaveBeenCalledExactlyOnceWith("window:first");
    resolve(stream);
    const session = await first;
    await session.stop();
  });
});

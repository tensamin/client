import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent, Session, WebFrameMain } from "electron";
import { registerDisplayMediaHandler } from "./screenCapture.js";

const mocks = vi.hoisted(() => ({
  sources: vi.fn(),
  handle: vi.fn(),
  display: vi.fn(),
}));
vi.mock("electron", () => ({
  desktopCapturer: { getSources: mocks.sources },
  ipcMain: { handle: mocks.handle },
  session: { defaultSession: { setDisplayMediaRequestHandler: mocks.display } },
}));

let capture: NonNullable<
  Parameters<Session["setDisplayMediaRequestHandler"]>[0]
>;
let select: (event: IpcMainInvokeEvent, id: string | null) => boolean;
let frame: WebFrameMain;
let sender: EventEmitter;
let event: IpcMainInvokeEvent;
let trusted: boolean;
const chosen = { id: "window:chosen" };
const other = { id: "screen:other" };
beforeEach(() => {
  vi.resetAllMocks();
  frame = {} as WebFrameMain;
  sender = new EventEmitter();
  event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  trusted = true;
  registerDisplayMediaHandler((candidate) => candidate === frame && trusted);
  capture = mocks.display.mock.calls[0][0];
  select = mocks.handle.mock.calls[0][1];
  mocks.sources.mockResolvedValue([other, chosen]);
});

function request(requestFrame: WebFrameMain | null = frame) {
  return {
    frame: requestFrame,
    audioRequested: false,
    videoRequested: true,
    userGesture: true,
    securityOrigin: "file://",
  };
}

describe("Electron screen capture consent", () => {
  it("grants exactly the selected source once, never the first source", async () => {
    select(event, chosen.id);
    const callback = vi.fn();
    await capture(request(), callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith({ video: chosen });
    const duplicate = vi.fn();
    await capture(request(), duplicate);
    expect(duplicate).toHaveBeenCalledExactlyOnceWith({});
    expect(sender.listenerCount("did-start-navigation")).toBe(0);
    expect(sender.listenerCount("destroyed")).toBe(0);
  });

  it("denies capture without a selection or after the chosen window disappears", async () => {
    const absent = vi.fn();
    await capture(request(), absent);
    expect(absent).toHaveBeenCalledExactlyOnceWith({});
    expect(mocks.sources).not.toHaveBeenCalled();
    select(event, "window:closed");
    const closed = vi.fn();
    await capture(request(), closed);
    expect(closed).toHaveBeenCalledExactlyOnceWith({});
  });

  it("rejects foreign frames without consuming the owning frame's selection", async () => {
    select(event, chosen.id);
    for (const foreign of [null, {} as WebFrameMain]) {
      const callback = vi.fn();
      await capture(request(foreign), callback);
      expect(callback).toHaveBeenCalledExactlyOnceWith({});
    }
    const owner = vi.fn();
    await capture(request(), owner);
    expect(owner).toHaveBeenCalledExactlyOnceWith({ video: chosen });
  });

  it("claims consent before asynchronous enumeration and rejects overlapping requests/selections", async () => {
    let resolve!: (sources: unknown[]) => void;
    mocks.sources.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    select(event, chosen.id);
    const first = vi.fn();
    const pending = capture(request(), first);
    const second = vi.fn();
    await capture(request(), second);
    expect(second).toHaveBeenCalledExactlyOnceWith({});
    expect(() => select(event, other.id)).toThrow("already pending");
    resolve([other, chosen]);
    await pending;
    expect(first).toHaveBeenCalledExactlyOnceWith({ video: chosen });
    expect(mocks.sources).toHaveBeenCalledOnce();
  });

  it.each(["did-start-navigation", "destroyed", "cancel", "untrusted"])(
    "denies a pending capture after %s",
    async (cause) => {
      let resolve!: (sources: unknown[]) => void;
      mocks.sources.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      select(event, chosen.id);
      const callback = vi.fn();
      const pending = capture(request(), callback);
      if (cause === "cancel") select(event, null);
      else if (cause === "untrusted") trusted = false;
      else sender.emit(cause);
      resolve([chosen]);
      await pending;
      expect(callback).toHaveBeenCalledExactlyOnceWith({});
    },
  );

  it("denies enumeration failures and allows a fresh explicit selection afterward", async () => {
    select(event, chosen.id);
    mocks.sources.mockRejectedValueOnce(
      new Error("Capture source unavailable"),
    );
    const failed = vi.fn();
    await capture(request(), failed);
    expect(failed).toHaveBeenCalledExactlyOnceWith({});
    expect(() => select(event, other.id)).not.toThrow();
  });

  it("rejects invalid or untrusted selection IPC", () => {
    expect(() => select(event, "")).toThrow("Invalid screen share source");
    expect(() => select(event, "x".repeat(257))).toThrow(
      "Invalid screen share source",
    );
    trusted = false;
    expect(() => select(event, chosen.id)).toThrow("Untrusted capture sender");
  });
});

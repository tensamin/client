// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { AccountState } from "./accountSync";
import { useAccountRefresh, type MTPContextType } from "./mtpContext";

vi.mock("@tensamin/shared/log", () => ({ log: vi.fn() }));

it("reruns a refresh that was requested while a failing refresh was in flight", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let rejectFirst!: (error: Error) => void;
  const state = {} as AccountState;
  const operation = vi
    .fn<MTPContextType["refreshAccountState"]>()
    .mockImplementationOnce(
      () => new Promise((_, reject) => (rejectFirst = reject)),
    )
    .mockResolvedValueOnce(state);
  let refresh!: () => Promise<AccountState>;

  function Probe() {
    refresh = useAccountRefresh(
      operation,
      () => () => {},
      false,
      () => () => {},
    );

    return null;
  }

  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));

  const first = refresh();
  const second = refresh();
  rejectFirst(new Error("sync timed out"));

  await expect(first).resolves.toBe(state);
  await expect(second).resolves.toBe(state);
  expect(operation).toHaveBeenCalledTimes(2);

  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("rejects when a refresh fails with no other refresh queued", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const operation = vi
    .fn<MTPContextType["refreshAccountState"]>()
    .mockRejectedValueOnce(new Error("sync timed out"));
  let refresh!: () => Promise<AccountState>;

  function Probe() {
    refresh = useAccountRefresh(
      operation,
      () => () => {},
      false,
      () => () => {},
    );

    return null;
  }

  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));

  await expect(refresh()).rejects.toThrow("sync timed out");
  expect(operation).toHaveBeenCalledTimes(1);

  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let listening = false;
let platformVisible = true;
let focused = getCurrentFocus();

function getCurrentFocus() {
  return (
    typeof document !== "undefined" &&
    document.visibilityState === "visible" &&
    platformVisible
  );
}

export function setPlatformVisible(visible: boolean) {
  platformVisible = visible;
  updateFocus();
}

function updateFocus() {
  const next = getCurrentFocus();
  if (next === focused) return;
  focused = next;
  for (const listener of listeners) listener();
}

function startListening() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  focused = getCurrentFocus();
  document.addEventListener("visibilitychange", updateFocus);
}

function stopListening() {
  if (!listening || listeners.size !== 0) return;
  listening = false;
  document.removeEventListener("visibilitychange", updateFocus);
}

export function getAppFocused() {
  focused = getCurrentFocus();
  return focused;
}

export function subscribeAppFocus(listener: () => void) {
  listeners.add(listener);
  startListening();
  return () => {
    listeners.delete(listener);
    stopListening();
  };
}

export function useAppFocused() {
  return useSyncExternalStore(subscribeAppFocus, getAppFocused, () => false);
}

export async function waitForForeground(signal: AbortSignal) {
  signal.throwIfAborted();
  if (getAppFocused()) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      unsubscribe();
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else resolve();
    };
    const abort = () => finish();
    const unsubscribe = subscribeAppFocus(() => {
      if (getAppFocused()) finish();
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted || getAppFocused()) finish();
  });
}

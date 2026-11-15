import { createContext, useContext, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { management } from "./manager";
import type { CallSession } from "./session/instance";
import { initialCallState, type CallState } from "./state";
const CallContext = createContext<CallSession | null>(null);
const idleState = createStore(initialCallState);
export function CallProvider({
  call,
  children,
}: {
  call: CallSession;
  children: ReactNode;
}) {
  return <CallContext value={call}>{children}</CallContext>;
}
export function useOptionalCallSession() {
  const context = useContext(CallContext);
  const selected = management((s) => (context ? null : s.selected));
  return context ?? selected;
}
export function useCallSession() {
  const call = useOptionalCallSession();
  if (!call) throw new Error("A call provider is required");
  return call;
}
export function useCall<T>(selector: (state: CallState) => T): T {
  const call = useOptionalCallSession();
  return useStore(call?.store ?? idleState, selector);
}
export const useCallActions = useCallSession;

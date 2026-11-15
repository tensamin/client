import type { RefObject } from "react";
import { flushSync } from "react-dom";
import type { CallView, CurrentCallData } from "../state";
import type { CallSession } from "./instance";
import { requireRuntime } from "./shared";

export function updateCallView(
  this: CallSession,
  update: () => void,
  kind: "join" | "layout",
) {
  if (
    typeof document === "undefined" ||
    !document.querySelector("[data-call-screen]") ||
    !document.startViewTransition ||
    matchMedia("(prefers-reduced-motion: reduce)").matches ||
    this.store.getState().callIsPopout
  ) {
    update();
    return null;
  }
  if (this.activeCallViewTransition) {
    if (kind === "join") {
      this.activeCallViewTransition.skipTransition();
      this.activeCallViewTransition = null;
    } else {
      update();
      return null;
    }
  }
  document.documentElement.dataset.callTransition = kind;
  const transition = document.startViewTransition(() => flushSync(update));
  this.activeCallViewTransition = transition;
  const timeout = window.setTimeout(
    () => transition.skipTransition(),
    kind === "join" ? 2500 : 750,
  );
  void transition.updateCallbackDone.then(
    () => window.clearTimeout(timeout),
    () => window.clearTimeout(timeout),
  );
  void transition.finished.then(
    () => {
      if (this.activeCallViewTransition !== transition) return;
      this.activeCallViewTransition = null;
      delete document.documentElement.dataset.callTransition;
    },
    () => {
      if (this.activeCallViewTransition !== transition) return;
      this.activeCallViewTransition = null;
      delete document.documentElement.dataset.callTransition;
    },
  );
  return transition.finished.catch(() => undefined);
}

export function setCallView(this: CallSession, view: CallView) {
  const previous = this.store.getState().view;
  if (previous === view) return;
  this.updateCallView(
    () => this.store.setState({ view }),
    previous === "preview" && view === "grid" ? "join" : "layout",
  );
}

export function setUsersInFocusedViewHidden(
  this: CallSession,
  usersInFocusedViewHidden: boolean,
) {
  this.store.setState((state) => ({
    usersInFocusedViewHidden,
    layoutVersion:
      state.usersInFocusedViewHidden === usersInFocusedViewHidden
        ? state.layoutVersion
        : state.layoutVersion + 1,
  }));
}

export function setCallIsFullscreen(
  this: CallSession,
  callIsFullscreen: boolean,
) {
  this.store.setState({ callIsFullscreen });
}

export function setCallIsPopout(this: CallSession, callIsPopout: boolean) {
  this.store.setState({ callIsPopout });
}

export function triggerCallLayoutCalculation(this: CallSession) {
  this.store.setState((state) => ({
    layoutVersion: state.layoutVersion + 1,
  }));
}

export function setScreenRef(
  this: CallSession,
  screenRef: RefObject<HTMLDivElement | null> | null,
) {
  this.store.setState({ screenRef });
}

// Keep the current call id in sync with navigation and connection flow.
export function setCallId(this: CallSession, callId: string | null) {
  this.store.setState({ callId });
}

// Cache server call metadata used by the preview screen.
export function setCurrentCallData(
  this: CallSession,
  currentCallData: CurrentCallData,
) {
  this.store.setState({ currentCallData });
}

// more utils Navigate the app into the dedicated call route for an active call.
export async function openCallPage(this: CallSession, callId: string) {
  await requireRuntime(this.store.getState().runtime).navigate({
    to: "/call",
    search: { id: callId },
  });
}

export function callRouteOwner(this: CallSession): number | undefined {
  return this.store.getState().callRoute?.ownerOmikronId;
}

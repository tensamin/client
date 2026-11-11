import { invoke, isTauri } from "@tauri-apps/api/core";
import { getAppFocused, subscribeAppFocus } from "@tensamin/shared/focus";
import { log } from "@tensamin/shared/log";
import { ConnectionState } from "mtp";
import { useCallback, useEffect } from "react";
import { loadOfflineAccountState, type AccountState } from "../accountSync";

import { useAccountRefresh } from "../mtpContext";
import { INITIAL_SYNC_TIMEOUT } from "../values";

import { initializeAccountState } from "./accountState";
import { type BrowserMtpClient } from "./client";
import type { RendererState } from "./state";

export function useAccountSync(
  state: Pick<
    RendererState,
    | "clientRef"
    | "bindingRef"
    | "authenticatedClientRef"
    | "sessionAbortRef"
    | "clientStateRef"
    | "publishState"
    | "forceSnapshotRef"
    | "subscribe"
    | "sessionEstablished"
    | "addInterceptor"
    | "visible"
    | "contextClient"
    | "credentials"
    | "identified"
  >,
  attachNativeView: (client: BrowserMtpClient) => Promise<void>,
) {
  const {
    clientRef,
    bindingRef,
    authenticatedClientRef,
    sessionAbortRef,
    clientStateRef,
    publishState,
    forceSnapshotRef,
    subscribe,
    sessionEstablished,
    addInterceptor,
    visible,
    contextClient,
    credentials,
    identified,
  } = state;
  const refreshSnapshot = useCallback(async () => {
    const client = clientRef.current;
    const binding = bindingRef.current;

    if (!client || client !== authenticatedClientRef.current || !binding)
      throw new Error("MTP is not authenticated");

    if (!getAppFocused())
      throw new Error("Account synchronization is paused while hidden");
    const controller = new AbortController();
    const unsubscribe = subscribeAppFocus(() => {
      if (!getAppFocused())
        controller.abort(new Error("Account synchronization paused"));
    });
    let state: AccountState;

    try {
      const signal = AbortSignal.any([
        controller.signal,
        sessionAbortRef.current?.signal ?? AbortSignal.abort(),
        AbortSignal.timeout(INITIAL_SYNC_TIMEOUT),
      ]);

      if (isTauri() && client.state !== ConnectionState.Connected)
        await attachNativeView(client);

      if (!clientStateRef.current) {
        try {
          const cached = await loadOfflineAccountState(binding, signal);
          signal.throwIfAborted();

          if (
            cached &&
            clientRef.current === client &&
            bindingRef.current === binding
          )
            publishState(cached);
        } catch (error) {
          signal.throwIfAborted();
          forceSnapshotRef.current = true;
          log(
            1,
            "mtp",
            "yellow",
            "Saved account state could not be projected",
            error,
          );
        }
      }

      state = await initializeAccountState(
        client,
        signal,
        binding,
        INITIAL_SYNC_TIMEOUT,
        forceSnapshotRef.current,
      );
      signal.throwIfAborted();

      if (isTauri()) {
        if (!getAppFocused())
          throw new Error("Foreground synchronization paused");
        await invoke("mtp_refresh_identity");
        signal.throwIfAborted();
      }
    } finally {
      unsubscribe();
    }

    if (
      clientRef.current !== client ||
      authenticatedClientRef.current !== client ||
      !getAppFocused()
    )
      throw new Error("Account connection changed");
    forceSnapshotRef.current = false;
    publishState(state);

    return state;
  }, [
    attachNativeView,
    authenticatedClientRef,
    bindingRef,
    clientRef,
    clientStateRef,
    forceSnapshotRef,
    publishState,
    sessionAbortRef,
  ]);
  const refreshAccountState = useAccountRefresh(
    refreshSnapshot,
    subscribe,
    sessionEstablished,
    addInterceptor,
  );
  useEffect(() => {
    const binding = bindingRef.current;

    if (
      !visible ||
      !binding ||
      clientStateRef.current ||
      authenticatedClientRef.current
    )
      return;
    const controller = new AbortController();
    void loadOfflineAccountState(binding, controller.signal)
      .then((cached) => {
        if (
          !controller.signal.aborted &&
          getAppFocused() &&
          bindingRef.current === binding &&
          !clientStateRef.current &&
          cached
        )
          publishState(cached);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          forceSnapshotRef.current = true;
          log(1, "mtp", "yellow", "Saved account state unavailable", error);
        }
      });

    return () => controller.abort();
  }, [
    authenticatedClientRef,
    bindingRef,
    clientStateRef,
    contextClient,
    credentials,
    forceSnapshotRef,
    identified,
    publishState,
    visible,
  ]);

  return refreshAccountState;
}

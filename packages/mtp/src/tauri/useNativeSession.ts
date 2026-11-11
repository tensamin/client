import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { credentialMetadata } from "@tensamin/shared/accountSync";
import { getAppFocused, setPlatformVisible } from "@tensamin/shared/focus";
import { log } from "@tensamin/shared/log";
import { ConnectionState } from "mtp";
import { useCallback, useEffect } from "react";

import { type BrowserMtpClient } from "../renderer/client";
import type { RendererState } from "../renderer/state";

export function useNativeSession(
  state: Pick<
    RendererState,
    | "clientRef"
    | "authenticatedClientRef"
    | "bindingRef"
    | "reloadCredentialsRef"
    | "nativeGenerationRef"
    | "setNativeViewReady"
    | "contextClient"
    | "identified"
    | "visible"
    | "callActive"
    | "callActiveRef"
    | "nativeViewReady"
    | "attachSubscriptions"
    | "setReadyState"
    | "sessionAbortRef"
    | "setIdentified"
    | "retryConnectionRef"
  >,
) {
  const {
    clientRef,
    authenticatedClientRef,
    bindingRef,
    reloadCredentialsRef,
    nativeGenerationRef,
    setNativeViewReady,
    contextClient,
    identified,
    visible,
    callActive,
    callActiveRef,
    nativeViewReady,
    attachSubscriptions,
    setReadyState,
    sessionAbortRef,
    setIdentified,
    retryConnectionRef,
  } = state;
  const attachNativeView = useCallback(
    async (client: BrowserMtpClient) => {
      if (
        clientRef.current !== client ||
        authenticatedClientRef.current !== client
      )
        throw new Error("Native session changed");
      const status = await invoke<{ generation: number }>("mtp_status");
      const metadata = credentialMetadata.parse(
        await invoke("mtp_credential_metadata"),
      );
      const binding = bindingRef.current;

      if (
        !binding ||
        metadata.userId !== binding.user_id ||
        metadata.credentialSha256 !== binding.credential_sha256 ||
        metadata.omegaUrl !== binding.omega_url
      ) {
        await reloadCredentialsRef.current();

        throw new Error("Native credentials changed");
      }

      if (client.state !== ConnectionState.Connected) await client.connect();

      if (
        clientRef.current !== client ||
        authenticatedClientRef.current !== client
      )
        throw new Error("Native session changed during attachment");
      nativeGenerationRef.current = status.generation;
      setNativeViewReady(true);
    },
    [
      authenticatedClientRef,
      bindingRef,
      clientRef,
      nativeGenerationRef,
      reloadCredentialsRef,
      setNativeViewReady,
    ],
  );
  useEffect(() => {
    if (!isTauri() || !contextClient || !identified) return;
    let disposed = false;

    if (!visible && !callActive) {
      contextClient.disconnect();
      setNativeViewReady(false);

      return;
    }

    void attachNativeView(contextClient)
      .then(() => {
        if (!getAppFocused() && !callActiveRef.current) {
          contextClient.disconnect();
          setNativeViewReady(false);
        }
      })
      .catch((error) => {
        if (!disposed)
          log(1, "mtp", "red", "Native view attachment failed", error);
      });

    return () => {
      disposed = true;
    };
  }, [
    attachNativeView,
    callActive,
    callActiveRef,
    contextClient,
    identified,
    setNativeViewReady,
    visible,
  ]);
  useEffect(() => {
    if (isTauri() && contextClient && identified && nativeViewReady)
      return attachSubscriptions(contextClient);
  }, [attachSubscriptions, contextClient, identified, nativeViewReady]);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<{
      kind: string;
      snapshot?: {
        generation: number;
        readyState: number;
        identified: boolean;
      };
    }>("tensamin://mtp", ({ payload }) => {
      const snapshot = payload.snapshot;

      if (payload.kind !== "state" || !snapshot || disposed) return;
      const previous = nativeGenerationRef.current;
      nativeGenerationRef.current = snapshot.generation;
      setReadyState(snapshot.readyState);

      if (!snapshot.identified && authenticatedClientRef.current) {
        sessionAbortRef.current?.abort(new Error("Native session changed"));
        authenticatedClientRef.current = null;
        setIdentified(false);
      } else if (
        snapshot.identified &&
        ((authenticatedClientRef.current &&
          previous !== undefined &&
          previous !== snapshot.generation) ||
          sessionAbortRef.current?.signal.aborted)
      ) {
        void invoke("mtp_credential_metadata")
          .then((value) => {
            if (disposed || nativeGenerationRef.current !== snapshot.generation)
              return;
            const metadata = credentialMetadata.parse(value);
            const binding = bindingRef.current;

            if (
              binding &&
              binding.user_id === metadata.userId &&
              binding.omega_url === metadata.omegaUrl &&
              binding.credential_sha256 === metadata.credentialSha256
            )
              retryConnectionRef.current();
            else return reloadCredentialsRef.current();
          })
          .catch((error) =>
            log(1, "mtp", "red", "Native credential handoff failed", error),
          );
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });

    return () => {
      disposed = true;
      stop?.();
    };
  }, [
    authenticatedClientRef,
    bindingRef,
    nativeGenerationRef,
    reloadCredentialsRef,
    retryConnectionRef,
    sessionAbortRef,
    setIdentified,
    setReadyState,
  ]);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<boolean>("tensamin://visibility", ({ payload }) =>
      setPlatformVisible(payload),
    ).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    const update = () =>
      void invoke("mtp_set_ui_visible", {
        visible: document.visibilityState === "visible",
      });
    document.addEventListener("visibilitychange", update);
    update();

    return () => {
      disposed = true;
      unlisten?.();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  return attachNativeView;
}

import { toast as sonnerToast } from "@nonanium/ui";
import { useEffect, useRef } from "react";

import type { RendererState } from "./state";

export function useConnectionFeedback(
  state: Pick<
    RendererState,
    | "credentials"
    | "sessionEstablished"
    | "connectionStatus"
    | "clientState"
    | "retryConnectionRef"
    | "subscribe"
    | "setIdentified"
    | "setIdentifying"
    | "resolveConnectionRef"
  >,
) {
  const {
    credentials,
    sessionEstablished,
    connectionStatus,
    clientState,
    retryConnectionRef,
    subscribe,
    setIdentified,
    setIdentifying,
    resolveConnectionRef,
  } = state;
  const connectionToastPending = useRef(false);

  useEffect(() => {
    if (!credentials || !sessionEstablished) {
      connectionToastPending.current = false;
      sonnerToast.dismiss(CONNECTION_TOAST_ID);

      return;
    }

    if (!connectionStatus) {
      if (connectionToastPending.current && sessionEstablished && clientState) {
        sonnerToast.success("Connected", {
          id: CONNECTION_TOAST_ID,
          description: undefined,
          action: undefined,
          closeButton: false,
          duration: 4000,
        });
        connectionToastPending.current = false;
      }

      return;
    }

    connectionToastPending.current = true;

    if (connectionStatus.kind === "reconnecting") {
      sonnerToast.loading("Connecting...", {
        id: CONNECTION_TOAST_ID,
        description: undefined,
        action: undefined,
        closeButton: false,
      });

      return;
    }

    sonnerToast.error("Connecting failed", {
      id: CONNECTION_TOAST_ID,
      description: connectionStatus.description,
      duration: Infinity,
      closeButton: true,
      action: {
        label: "Retry",
        onClick: () => retryConnectionRef.current(),
      },
    });
  }, [
    connectionStatus,
    sessionEstablished,
    clientState,
    credentials,
    retryConnectionRef,
  ]);

  useEffect(() => {
    return subscribe("ErrorNoIota", () => {
      setIdentified(false);
      setIdentifying(false);
      resolveConnectionRef.current?.();
    });
  }, [resolveConnectionRef, setIdentified, setIdentifying, subscribe]);
}

export const CONNECTION_TOAST_ID = "mtp-connection-toast";

import { invoke, isTauri } from "@tauri-apps/api/core";
import { getAppFocused } from "@tensamin/shared/focus";
import { ConnectionState } from "mtp";
import { useCallback, useMemo } from "react";
import {
  callControlRequests,
  createNativeCallControl,
} from "../nativeCallControl";
import { createNativeRelayClient } from "../nativeRelay";
import { useRelayOutbox } from "../useRelayOutbox";

import { type BoundSendFn } from "../mtpContext";

import { type BrowserMtpClient } from "./client";
import type { RendererState } from "./state";

export function useRendererRequests(
  state: Pick<
    RendererState,
    | "contextClient"
    | "clientRef"
    | "authenticatedClientRef"
    | "callActiveRef"
    | "credentials"
    | "nativeGenerationRef"
    | "setNativeViewReady"
    | "callControlRequestRef"
    | "clientState"
    | "identified"
    | "sessionEstablished"
  >,
  attachNativeView: (client: BrowserMtpClient) => Promise<void>,
  blockConnection?: boolean,
) {
  const {
    contextClient,
    clientRef,
    authenticatedClientRef,
    callActiveRef,
    credentials,
    nativeGenerationRef,
    setNativeViewReady,
    callControlRequestRef,
    clientState,
    identified,
    sessionEstablished,
  } = state;
  const send: BoundSendFn = useMemo(
    () => async (type, data, options) => {
      const client = contextClient;

      if (
        !client ||
        clientRef.current !== client ||
        client !== authenticatedClientRef.current
      )
        throw new Error("MTP is not authenticated");
      const backgroundCall =
        callControlRequests.has(type) ||
        (callActiveRef.current && type === "UserResolve");

      if (isTauri()) {
        if (!getAppFocused() && !backgroundCall)
          throw new Error("Native foreground requests are paused");

        if (client.state !== ConnectionState.Connected)
          await attachNativeView(client);

        if (!getAppFocused() && !backgroundCall)
          throw new Error("Native foreground requests are paused");
      }

      const response = await client.request(type, data, options);

      if (
        clientRef.current !== client ||
        authenticatedClientRef.current !== client
      )
        throw new Error("Account connection changed");

      return response;
    },
    [
      attachNativeView,
      authenticatedClientRef,
      callActiveRef,
      clientRef,
      contextClient,
    ],
  );
  const dismissCallInvite = useCallback(
    async (callId: string) => {
      if (!isTauri()) return;
      const active = contextClient;
      const identity = credentials?.identity;

      if (
        !active ||
        clientRef.current !== active ||
        !identity ||
        !("binding" in identity)
      )
        throw new Error("Call invitation account changed");
      await invoke("mtp_dismiss_call_invite", {
        callId,
        generation: nativeGenerationRef.current,
        credentialSha256: identity.binding.credential_sha256,
      });

      if (clientRef.current !== active)
        throw new Error("Call invitation account changed");
    },
    [clientRef, contextClient, credentials?.identity, nativeGenerationRef],
  );
  const isCallInviteHandled = useCallback(
    async (callId: string) => {
      if (!isTauri()) return false;
      const active = contextClient;
      const identity = credentials?.identity;

      if (
        !active ||
        clientRef.current !== active ||
        !identity ||
        !("binding" in identity)
      )
        throw new Error("Call invitation account changed");
      const handled = await invoke<boolean>("mtp_call_invite_handled", {
        callId,
        generation: nativeGenerationRef.current,
        credentialSha256: identity.binding.credential_sha256,
      });

      if (clientRef.current !== active)
        throw new Error("Call invitation account changed");

      return handled;
    },
    [clientRef, contextClient, credentials?.identity, nativeGenerationRef],
  );
  const sendToCallOwner = useMemo(
    () =>
      async (
        ownerOmikronId: number | undefined,
        ...args: Parameters<BoundSendFn>
      ) => {
        const active = contextClient;

        if (
          !active ||
          clientRef.current !== active ||
          authenticatedClientRef.current !== active
        )
          throw new Error("Call session changed");

        if (isTauri()) {
          if (active.state !== ConnectionState.Connected)
            await attachNativeView(active);

          try {
            return await createNativeCallControl({
              send,
              session: () => ({
                authenticated:
                  authenticatedClientRef.current === active &&
                  clientRef.current === active,
                generation: nativeGenerationRef.current ?? -1,
                client: active,
              }),
            })(ownerOmikronId, ...args);
          } finally {
            if (!getAppFocused() && !callActiveRef.current) {
              active.disconnect();
              setNativeViewReady(false);
            }
          }
        }

        const request = callControlRequestRef.current;

        if (!request || !active)
          throw new Error("mtp call control is not authenticated");
        const response = await request(ownerOmikronId, ...args);

        if (authenticatedClientRef.current !== active)
          throw new Error("Account connection changed");

        return response;
      },
    [
      attachNativeView,
      authenticatedClientRef,
      callActiveRef,
      callControlRequestRef,
      clientRef,
      contextClient,
      nativeGenerationRef,
      send,
      setNativeViewReady,
    ],
  );
  const isRelaySessionCurrent = useCallback(
    () =>
      contextClient !== null &&
      clientRef.current === contextClient &&
      authenticatedClientRef.current === contextClient,
    [authenticatedClientRef, clientRef, contextClient],
  );
  const relayTransport = useCallback(() => {
    if (!contextClient) throw new Error("MTP is not authenticated");

    if (isTauri())
      return createNativeRelayClient({
        session: () => ({
          authenticated: authenticatedClientRef.current === contextClient,
          generation: nativeGenerationRef.current ?? -1,
          client: clientRef.current,
        }),
      });

    return contextClient;
  }, [authenticatedClientRef, clientRef, contextClient, nativeGenerationRef]);
  const sendSealedRelay = useRelayOutbox({
    transport: relayTransport,
    scope: clientState?.Scope,
    ready:
      identified &&
      contextClient !== null &&
      sessionEstablished &&
      !blockConnection,
    isCurrent: isRelaySessionCurrent,
  });

  return {
    send,
    dismissCallInvite,
    isCallInviteHandled,
    sendToCallOwner,
    sendSealedRelay,
  };
}

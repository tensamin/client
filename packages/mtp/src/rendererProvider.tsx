import { isTauri } from "@tauri-apps/api/core";
import { log } from "@tensamin/shared/log";
import { ConnectionState } from "mtp";
import { useCallback, useMemo, type ReactNode } from "react";

import {
  MTPContext,
  type BoundSendFn,
  type MTPContextType,
} from "./mtpContext";

import { useRendererState } from "./renderer/state";
import { useAccountSync } from "./renderer/useAccountSync";
import { useConnectionFeedback } from "./renderer/useConnectionFeedback";
import { useRendererConnection } from "./renderer/useRendererConnection";
import { useRendererCredentials } from "./renderer/useRendererCredentials";
import { useRendererRequests } from "./renderer/useRendererRequests";
import { useNativeCallReplay } from "./tauri/useNativeCallReplay";
import { useNativeRelayHints } from "./tauri/useNativeRelayHints";
import { useNativeSession } from "./tauri/useNativeSession";
export function RendererProvider(props: {
  children: ReactNode;
  blockConnection?: boolean;
}) {
  const state = useRendererState();
  const {
    contextClient,
    clientState,
    connected,
    identified,
    identifying,
    readyState,
    nativeViewReady,
    credentials,
    interceptorsRef,
    ...rest
  } = state;
  const {
    addInterceptor,
    subscribe,
    setCallActive,
    setFreshContacts,
    freshCommunities,
    freshContacts,
    freshCalls,
    readCachedMessages,
    sessionEstablished,
    connectionStatus,
    retryConnectionRef,
  } = rest;
  const attachNativeView = useNativeSession(state);
  const refreshAccountState = useAccountSync(state, attachNativeView);
  useNativeRelayHints(refreshAccountState);
  useConnectionFeedback(state);
  useRendererCredentials(state);
  const {
    send,
    dismissCallInvite,
    isCallInviteHandled,
    sendToCallOwner,
    sendSealedRelay,
  } = useRendererRequests(state, attachNativeView, props.blockConnection);
  useRendererConnection(state, refreshAccountState, props.blockConnection);
  useNativeCallReplay(state, sendToCallOwner);
  const mtpUrl = credentials?.omegaUrl ?? null;
  const loadingDescription = useMemo(() => {
    if (!mtpUrl) return "Finding an Omikron...";

    if (readyState === ConnectionState.Connecting || !connected) {
      return "Connecting to Omikron...";
    }

    if (identifying || !identified) return "Authenticating...";

    return "Loading...";
  }, [connected, identified, identifying, readyState, mtpUrl]);

  const contextReady =
    connected &&
    identified &&
    mtpUrl !== null &&
    (!isTauri() || nativeViewReady);
  const sendWithInterceptors: BoundSendFn = useMemo(
    () => async (type, data, options) => {
      const response = await send(type, data, options);

      for (const interceptor of interceptorsRef.current) {
        void Promise.resolve(interceptor({ type, data, response })).catch(
          (error) => {
            log(1, "mtp", "yellow", "MTP interceptor failed", error, { type });
          },
        );
      }

      return response;
    },
    [interceptorsRef, send],
  );

  const scope = clientState?.Scope;
  const accountKey = useMemo(
    () =>
      scope
        ? JSON.stringify([scope.principal, scope.authorization_generation])
        : undefined,
    [scope],
  );
  const retryConnection = useCallback(
    () => retryConnectionRef.current(),
    [retryConnectionRef],
  );
  const value = useMemo<MTPContextType>(
    () => ({
      send: sendWithInterceptors,
      sendCallControl: sendToCallOwner,
      sendSealedRelay,
      subscribe,
      addInterceptor,
      client: contextClient,
      readyState,
      identified,
      freshContacts,
      updateContacts: setFreshContacts,
      freshCommunities,
      freshCalls,
      clientState,
      accountKey,
      refreshAccountState,
      readCachedMessages,
      contextReady,
      sessionEstablished,
      loadingDescription,
      connectionStatus,
      retryConnection,
      setCallActive,
      dismissCallInvite,
      isCallInviteHandled,
    }),
    [
      sendWithInterceptors,
      sendToCallOwner,
      sendSealedRelay,
      subscribe,
      addInterceptor,
      contextClient,
      readyState,
      identified,
      freshContacts,
      setFreshContacts,
      freshCommunities,
      freshCalls,
      clientState,
      accountKey,
      refreshAccountState,
      readCachedMessages,
      contextReady,
      sessionEstablished,
      loadingDescription,
      connectionStatus,
      retryConnection,
      setCallActive,
      dismissCallInvite,
      isCallInviteHandled,
    ],
  );

  return (
    <MTPContext.Provider value={value}>{props.children}</MTPContext.Provider>
  );
}

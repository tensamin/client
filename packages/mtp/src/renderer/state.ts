import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  type Calls,
  type Communities,
  type Contacts,
} from "@tensamin/shared/data";
import { useAppFocused } from "@tensamin/shared/focus";
import { log } from "@tensamin/shared/log";
import { useStorage } from "@tensamin/storage/context";
import { ConnectionState } from "mtp";
import { useCallback, useRef, useState } from "react";
import {
  loadCachedMessages,
  type AccountCacheBinding,
  type AccountState,
} from "../accountSync";

import {
  useMessageHandlers,
  type BoundSendFn,
  type MTPConnectionStatus,
} from "../mtpContext";

import { type BrowserMtpClient } from "./client";

export function useRendererState() {
  const { load, subscribe: subscribeStorage } = useStorage();
  const visible = useAppFocused();
  const [callActive, setCallActivity] = useState(false);
  const callActiveRef = useRef(false);
  const [nativeViewReady, setNativeViewReady] = useState(false);
  const setCallActive = useCallback((active: boolean, microphone: boolean) => {
    callActiveRef.current = active;
    setCallActivity(active);

    if (isTauri())
      void invoke("mtp_set_call_active", { active, microphone }).catch(
        (error) =>
          log(1, "call", "red", "Native audio lifecycle failed", error),
      );
  }, []);
  const [credentials, setCredentials] = useState<{
    userId: number;
    identity: { keyring: string } | { binding: AccountCacheBinding };
    omegaUrl: string;
    deviceId: string;
    forcedUrl: string | undefined;
    forcedKey: string | undefined;
  } | null>(null);
  const credentialRevisionRef = useRef(0);
  const reloadCredentialsRef = useRef<() => Promise<void>>(async () => {});
  const [readyState, setReadyState] = useState<number>(
    ConnectionState.Disconnected,
  );
  const [identified, setIdentified] = useState(false);
  const [identifying, setIdentifying] = useState(false);
  const [sessionEstablished, setSessionEstablished] = useState(false);
  const [connectionStatus, setConnectionStatus] =
    useState<MTPConnectionStatus | null>(null);
  const [freshCommunities, setFreshCommunities] = useState<Communities>([]);
  const [freshContacts, setFreshContacts] = useState<Contacts>([]);
  const [freshCalls, setFreshCalls] = useState<Calls>([]);
  const [clientState, setClientState] = useState<AccountState | null>(null);
  const clientStateRef = useRef<AccountState | null>(null);
  const publishState = useCallback((state: AccountState | null) => {
    clientStateRef.current = state;
    setClientState(state);
    setFreshContacts(state?.Contacts ?? []);
    setFreshCommunities(state?.Communities ?? []);
    setFreshCalls(state?.Calls ?? []);
  }, []);
  const readCachedMessages = useCallback(
    (principal: string) =>
      clientState?.Scope
        ? loadCachedMessages(clientState.Scope, principal)
        : Promise.resolve(null),
    [clientState],
  );
  const clientRef = useRef<BrowserMtpClient | null>(null);
  const authenticatedClientRef = useRef<BrowserMtpClient | null>(null);
  const bindingRef = useRef<AccountCacheBinding | null>(null);
  const forceSnapshotRef = useRef(false);
  const sessionAbortRef = useRef<AbortController | null>(null);
  const nativeGenerationRef = useRef<number | undefined>(undefined);
  const [contextClient, setContextClient] = useState<BrowserMtpClient | null>(
    null,
  );

  const callControlRequestRef = useRef<
    | ((
        ownerOmikronId: number | undefined,
        ...args: Parameters<BoundSendFn>
      ) => ReturnType<BoundSendFn>)
    | null
  >(null);
  const {
    addInterceptor,
    attachSubscriptions,
    interceptorsRef,
    subscribe,
    publish,
  } = useMessageHandlers();

  const connected = readyState === ConnectionState.Connected;
  const retryConnectionRef = useRef(() => {});

  const resolveConnectionRef = useRef(() => {});

  return {
    load,
    subscribeStorage,
    visible,
    callActive,
    setCallActivity,
    callActiveRef,
    nativeViewReady,
    setNativeViewReady,
    setCallActive,
    credentials,
    setCredentials,
    credentialRevisionRef,
    reloadCredentialsRef,
    readyState,
    setReadyState,
    identified,
    setIdentified,
    identifying,
    setIdentifying,
    sessionEstablished,
    setSessionEstablished,
    connectionStatus,
    setConnectionStatus,
    freshCommunities,
    setFreshCommunities,
    freshContacts,
    setFreshContacts,
    freshCalls,
    setFreshCalls,
    clientState,
    setClientState,
    clientStateRef,
    publishState,
    readCachedMessages,
    clientRef,
    authenticatedClientRef,
    bindingRef,
    forceSnapshotRef,
    sessionAbortRef,
    nativeGenerationRef,
    contextClient,
    setContextClient,
    callControlRequestRef,
    addInterceptor,
    attachSubscriptions,
    interceptorsRef,
    subscribe,
    publish,
    connected,
    retryConnectionRef,
    resolveConnectionRef,
  };
}
export type RendererState = ReturnType<typeof useRendererState>;

import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  credentialMetadata,
  getSyncDeviceId,
} from "@tensamin/shared/accountSync";
import { log } from "@tensamin/shared/log";
import { useEffect } from "react";

import type { RendererState } from "./state";

export function useRendererCredentials(
  state: Pick<
    RendererState,
    | "credentialRevisionRef"
    | "authenticatedClientRef"
    | "sessionAbortRef"
    | "bindingRef"
    | "forceSnapshotRef"
    | "clientRef"
    | "callControlRequestRef"
    | "setContextClient"
    | "setCredentials"
    | "publishState"
    | "setIdentified"
    | "setSessionEstablished"
    | "load"
    | "reloadCredentialsRef"
    | "subscribeStorage"
  >,
) {
  const {
    credentialRevisionRef,
    authenticatedClientRef,
    sessionAbortRef,
    bindingRef,
    forceSnapshotRef,
    clientRef,
    callControlRequestRef,
    setContextClient,
    setCredentials,
    publishState,
    setIdentified,
    setSessionEstablished,
    load,
    reloadCredentialsRef,
    subscribeStorage,
  } = state;
  useEffect(() => {
    let disposed = false;
    const reloadCredentials = async () => {
      const revision = ++credentialRevisionRef.current;
      authenticatedClientRef.current = null;
      sessionAbortRef.current?.abort(new Error("Account credentials changed"));
      bindingRef.current = null;
      forceSnapshotRef.current = false;
      const previous = clientRef.current;
      clientRef.current = null;
      previous?.disconnect();
      callControlRequestRef.current = null;
      setContextClient(null);
      setCredentials(null);
      publishState(null);
      setIdentified(false);
      setSessionEstablished(false);
      const deviceId = await getSyncDeviceId();

      if (isTauri()) {
        if (!(await invoke<boolean>("mtp_has_credentials"))) return;
        const metadata = credentialMetadata.parse(
          await invoke("mtp_credential_metadata"),
        );

        if (!disposed && revision === credentialRevisionRef.current)
          setCredentials({
            userId: metadata.userId,
            omegaUrl: metadata.omegaUrl,
            deviceId,
            forcedUrl: undefined,
            forcedKey: undefined,
            identity: {
              binding: {
                user_id: metadata.userId,
                device_id: deviceId,
                omega_url: metadata.omegaUrl,
                credential_sha256: metadata.credentialSha256,
              },
            },
          });

        return;
      }

      const [userId, keyring, omegaUrl, forcedUrl, forcedKey] =
        await Promise.all([
          load("user_id"),
          load("mtp_keyring"),
          load("omega_url"),
          load("forced_omikron_url"),
          load("forced_omikron_public_key"),
        ]);

      if (
        !disposed &&
        revision === credentialRevisionRef.current &&
        userId &&
        keyring
      ) {
        setCredentials({
          userId,
          identity: { keyring },
          omegaUrl,
          deviceId,
          forcedUrl,
          forcedKey,
        });
      }
    };

    reloadCredentialsRef.current = reloadCredentials;
    const unsubscribe = subscribeStorage((keys) => {
      if (
        keys.some((key) =>
          [
            "user_id",
            "mtp_keyring",
            "omega_url",
            "session_id",
            "forced_omikron_url",
            "forced_omikron_public_key",
          ].includes(key),
        )
      ) {
        void reloadCredentials().catch((error) =>
          log(0, "mtp", "red", "Failed to load account credentials", error),
        );
      }
    });
    void reloadCredentials().catch((error) =>
      log(0, "mtp", "red", "Failed to load account credentials", error),
    );

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [
    authenticatedClientRef,
    bindingRef,
    callControlRequestRef,
    clientRef,
    credentialRevisionRef,
    forceSnapshotRef,
    load,
    publishState,
    reloadCredentialsRef,
    sessionAbortRef,
    setContextClient,
    setCredentials,
    setIdentified,
    setSessionEstablished,
    subscribeStorage,
  ]);
}

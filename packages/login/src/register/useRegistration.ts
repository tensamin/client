import { MTPClient, bytesToBase64 } from "mtp";
import { useStorage } from "@tensamin/storage/context";
import { persistMtpCredentials } from "@tensamin/storage/credentials";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { saveKeyringFile, targetFromFragment } from "./invitation";
import {
  planRegistration,
  persistPending,
  restorePendingRegistration,
  runProvisioningAttempt,
  type PendingInvitationRegistration,
} from "./registration";

export function useRegistration() {
  const { load, save } = useStorage();
  const navigate = useNavigate();
  const [initialTarget] = useState(() =>
    targetFromFragment(window.location.hash.slice(1)),
  );
  const keyring = useRef<Uint8Array | null>(null);
  const resetToken = useRef<string | null>(null);
  const pendingRegistration = useRef<PendingInvitationRegistration | null>(
    null,
  );
  const [credential, setCredential] = useState(initialTarget?.credential ?? "");
  const [username, setUsername] = useState("");
  const [initialized, setInitialized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void MTPClient.init()
      .then(() => restorePendingRegistration(load))
      .then((restored) => {
        if (cancelled) return;
        if (restored) {
          pendingRegistration.current = restored.pending;
          keyring.current = restored.keyring;
          resetToken.current = restored.resetToken;
          setCredential(restored.pending.target.credential);
          setUsername(restored.pending.username);
        } else {
          keyring.current ??= MTPClient.crypto.generateKeyring();
        }
        setInitialized(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setMessage(
          error instanceof Error
            ? error.message
            : "Registration initialization failed.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!initialized || busy) return;
    setBusy(true);
    try {
      const form = new FormData(event.currentTarget);
      const plan = await planRegistration({
        load,
        credential,
        initialTarget,
        pending: pendingRegistration.current,
        requestedUsername: String(form.get("username") ?? "")
          .trim()
          .toLowerCase(),
        password: String(form.get("password") ?? ""),
      });
      keyring.current ??= MTPClient.crypto.generateKeyring();
      const privateKeyring = keyring.current;
      resetToken.current ??= bytesToBase64(
        crypto.getRandomValues(new Uint8Array(192)),
      );
      const registration = (pendingRegistration.current = {
        ...plan.registration,
        keyring: bytesToBase64(privateKeyring),
        resetToken: resetToken.current,
      });
      await persistPending({
        save,
        plan: { ...plan, registration },
        privateKeyring,
        resetToken: resetToken.current,
      });

      let userId = registration.userId;
      for (;;) {
        const attempt = await runProvisioningAttempt({
          plan: { ...plan, registration },
          privateKeyring,
          save,
          setMessage,
        });
        if (attempt.kind === "done") {
          userId = attempt.userId;
          break;
        }
      }

      await persistMtpCredentials({
        storage: { load, save },
        userId,
        keyring: bytesToBase64(privateKeyring),
      });
      await save("mtp_reset_token", resetToken.current, { secure: true });
      await save("pending_invitation_registration", "", { secure: true });
      pendingRegistration.current = null;
      await navigate({ to: "/", replace: true });
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Registration failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    canDownloadKeyring: initialized && keyring.current !== null,
    credential,
    credentialReadOnly: initialTarget !== null,
    downloadKeyring: () => keyring.current && saveKeyringFile(keyring.current),
    initialized,
    message,
    setCredential,
    setUsername,
    submit,
    username,
  };
}

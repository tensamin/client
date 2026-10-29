import { useStorage } from "@tensamin/storage/context";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { createContactCreatedSession } from "../qr/contactCreated";
import { QrDisplay } from "./qrDisplay";
import { toast } from "@tensamin/shared/log";
import { qrLoginLink } from "../qr/deeplink";
import { SessionTerminatedError } from "../errors";
import { OperationTimeoutError } from "../events";
import { Avatar, AvatarFallback, AvatarImage } from "@nonanium/ui";

export default function QrLogin() {
  const storage = useStorage();
  const navigate = useNavigate();
  const [locator, setLocator] = useState("");
  const [generation, setGeneration] = useState(0);
  const [identity, setIdentity] = useState<{
    username: string;
    avatar: string | null;
  } | null>(null);
  const { load } = storage;

  useEffect(() => {
    const controller = new AbortController();
    let session: { dispose(): void } | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setLocator("");
    setIdentity(null);
    async function start() {
      try {
        const active = await createContactCreatedSession({
          omegaOrigin: await load("omega_url"),
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          active.dispose();
          return;
        }
        session = active;
        setLocator(qrLoginLink(active.temporaryLoginId));
        refreshTimer = setTimeout(
          () => {
            controller.abort();
            active.dispose();
            setGeneration((value) => value + 1);
          },
          Math.max(0, active.expiresAt - Date.now() - 1_000),
        );
        const account = await active.awaitVerifiedBinding();
        clearTimeout(refreshTimer);
        setLocator("");
        const response = await fetch(
          `${active.omega}api/get/user/${account.user_id}`,
          { signal: controller.signal },
        );
        if (!response.ok)
          throw new Error("Could not fetch claiming user's avatar");
        const user = (await response.json()) as { avatar?: string | null };
        if (user.avatar) {
          const image = new Image();
          image.src = `data:image/webp;base64,${user.avatar}`;
          await image.decode();
        }
        setIdentity({
          username: account.username,
          avatar: user.avatar ?? null,
        });
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        await active.avatarReady();
        await active.persistAndComplete({ storage });
        if (!controller.signal.aborted)
          await navigate({ to: "/", replace: true });
      } catch (error) {
        if (!controller.signal.aborted) {
          setLocator("");
          setIdentity(null);
          const silentRefresh =
            (error instanceof SessionTerminatedError &&
              error.reason === "connection-lost") ||
            (error instanceof OperationTimeoutError &&
              error.message === "Timed out waiting for ProvisioningCredential");
          if (!silentRefresh) {
            toast(
              "error",
              error instanceof Error ? error.message : "QR login failed",
              undefined,
              { duration: Infinity, closeButton: true },
            );
          }
          refreshTimer = setTimeout(() => {
            if (!controller.signal.aborted) setGeneration((value) => value + 1);
          }, 2_000);
        }
      } finally {
        session?.dispose();
      }
    }
    void start();
    return () => {
      controller.abort();
      clearTimeout(refreshTimer);
      session?.dispose();
    };
  }, [load, navigate, storage, generation]);

  return (
    <section className="flex w-55 h-full aspect-square shrink-0 flex-col gap-3 rounded-lg bg-muted border-2">
      {identity ? (
        <Avatar className="w-full h-full rounded-none! border-none! after:rounded-none! after:border-none!">
          <AvatarFallback className="text-4xl">
            {identity.username.slice(0, 2).toUpperCase()}
          </AvatarFallback>
          <AvatarImage
            className="border-none! rounded-none!"
            src={`data:image/webp;base64,${identity.avatar}`}
          />
        </Avatar>
      ) : locator ? (
        <QrDisplay className="rounded-lg overflow-hidden" locator={locator} />
      ) : (
        <div className="aspect-square w-full animate-pulse" role="status" />
      )}
    </section>
  );
}

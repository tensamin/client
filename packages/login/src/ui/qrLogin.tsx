import { useStorage } from "@tensamin/storage/context";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { createContactCreatedSession } from "../qr/contactCreated";
import { QrDisplay } from "./qrDisplay";
import { toast } from "@tensamin/shared/log";
import { qrLoginLink } from "../qr/deeplink";
import { SessionTerminatedError } from "../errors";
import { OperationTimeoutError } from "../events";
import { Avatar, AvatarFallback, AvatarImage, cn } from "@nonanium/ui";
import { Loader2 } from "lucide-react";

const QR_LOGIN_ERROR_TOAST_ID = "qr-login-error";

export default function QrLogin({
  disabled = false,
  onBusyChange,
  status,
}: {
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  status?: string | null;
}) {
  const storage = useStorage();
  const navigate = useNavigate();
  const [locator, setLocator] = useState("");
  const [generation, setGeneration] = useState(0);
  const lastError = useRef<string | undefined>(undefined);
  const [identity, setIdentity] = useState<{
    username: string;
    avatar: string | null;
  } | null>(null);
  const { load } = storage;

  useEffect(() => {
    if (disabled) return;
    const controller = new AbortController();
    let session: { dispose(): void } | undefined;
    let completing = false;
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
        lastError.current = undefined;
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
        if (controller.signal.aborted) return;
        completing = true;
        onBusyChange?.(true);
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
            const message =
              error instanceof Error ? error.message : String(error);

            if (lastError.current !== message) {
              lastError.current = message;
              toast("error", "QR login failed", message, {
                id: QR_LOGIN_ERROR_TOAST_ID,
                duration: Infinity,
                closeButton: true,
              });
            }
          }

          refreshTimer = setTimeout(() => {
            if (!controller.signal.aborted) setGeneration((value) => value + 1);
          }, 2_000);
        }
      } finally {
        if (completing) onBusyChange?.(false);
        session?.dispose();
      }
    }

    void start();

    return () => {
      controller.abort();
      clearTimeout(refreshTimer);
      session?.dispose();
    };
  }, [disabled, load, navigate, onBusyChange, storage, generation]);

  const loading = disabled || Boolean(status) || (!identity && !locator);

  return (
    <section className="relative flex w-55 h-full aspect-square shrink-0 flex-col gap-3 rounded-lg bg-muted border-2">
      {!disabled && identity ? (
        <Avatar className="w-full h-full rounded-none! border-none! after:rounded-none! after:border-none!">
          <AvatarFallback className="text-4xl">
            {identity.username.slice(0, 2).toUpperCase()}
          </AvatarFallback>
          <AvatarImage
            className="border-none! rounded-none!"
            src={`data:image/webp;base64,${identity.avatar}`}
          />
        </Avatar>
      ) : !loading && locator ? (
        <QrDisplay className="rounded-lg overflow-hidden" locator={locator} />
      ) : null}
      {loading && (
        <div
          className={cn(
            "flex flex-col items-center gap-3 text-center text-sm text-muted-foreground",
            identity && !disabled
              ? "absolute inset-x-0 bottom-0 rounded-b-lg bg-muted/95 p-2"
              : "m-auto px-4",
          )}
          role={status ? undefined : "status"}
        >
          <Loader2 aria-hidden="true" className="size-7 animate-spin" />
          <span>{status ?? "Preparing QR sign-in..."}</span>
        </div>
      )}
    </section>
  );
}

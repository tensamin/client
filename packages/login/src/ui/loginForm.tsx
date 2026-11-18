import { Button, cn, useIsMobile } from "@nonanium/ui";
import {
  Input,
  Label,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nonanium/ui";
import { useStorage } from "@tensamin/storage/context";
import { log, toast } from "@tensamin/shared/log";
import { File, Info, Loader2 } from "lucide-react";
import { type FormEvent, useCallback, useRef, useState } from "react";
import { z } from "zod";
import {
  parseTuFileContent,
  persistMtpCredentials,
} from "@tensamin/storage/credentials";
import { useNavigate } from "@tanstack/react-router";
import { isTauri } from "@tauri-apps/api/core";
import { fetchAccountIdentity, normalizeOmegaOrigin } from "../omega";
import { useTuFileInput } from "../tuFileInput";
import { loginWithPassword } from "../password/login";
import { isBase64Credential } from "../password/policy";
import QrLogin from "./qrLogin";
import { CreateScreen } from "@nonanium/ui";
import RightSidePanel from "./rightSidePanel";

const formSchema = z.object({
  username: z.string().min(1).max(255),
  password: z.string().min(1),
});
const LOGIN_ERROR_TOAST_ID = "login-error";

export default function Form() {
  const isMobile = useIsMobile();
  const storage = useStorage();
  const { load, save } = storage;
  const [progress, setProgress] = useState<string | null>(null);
  const [qrBusy, setQrBusy] = useState(false);
  const busy = progress !== null || qrBusy;
  const navigate = useNavigate();
  const loginPendingRef = useRef(false);

  const persistLogin = useCallback(
    async (userId: number, privateKey: string, domain?: string | null) => {
      await persistMtpCredentials({
        storage: { load, save },
        userId,
        keyring: privateKey,
        domain,
        onProgress: setProgress,
      });
      setProgress("Opening your account...");
      await navigate({ to: "/", replace: true });
    },
    [load, navigate, save],
  );

  const processDroppedFile = useCallback(
    async (file: globalThis.File): Promise<void> => {
      if (loginPendingRef.current || qrBusy) return;
      loginPendingRef.current = true;
      setProgress("Reading your TU file...");

      try {
        if (!file.name.toLowerCase().endsWith(".tu"))
          throw new Error("Please select a .tu login file.");

        const content = await file.text();
        setProgress("Checking your TU file...");
        const parsed = parseTuFileContent(content);
        await persistLogin(parsed.userId, parsed.privateKey, parsed.domain);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : error && typeof error === "object" && "message" in error
                ? String(error.message)
                : "Failed to load file";
        log(0, "login", "red", message);
        toast("error", "Importing login file failed", message, {
          id: LOGIN_ERROR_TOAST_ID,
          duration: Infinity,
          closeButton: true,
        });
      } finally {
        loginPendingRef.current = false;
        setProgress(null);
      }
    },
    [persistLogin, qrBusy],
  );

  const {
    filePickerOpen,
    handleFileInputChange,
    isDragging,
    openFilePicker,
    uploadRef,
  } = useTuFileInput(processDroppedFile, busy);
  const controlsDisabled = busy || filePickerOpen;
  const status =
    progress ??
    (qrBusy
      ? "Completing sign-in with your other device..."
      : filePickerOpen
        ? "Choose your TU login file to continue."
        : null);

  const handleCredentialsSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();

      if (loginPendingRef.current || filePickerOpen || qrBusy) return;
      const inputParse = formSchema.safeParse(
        Object.fromEntries(new FormData(event.currentTarget)),
      );

      if (!inputParse.success) {
        toast(
          "error",
          "Logging in failed",
          "Please enter a username and password.",
          {
            id: LOGIN_ERROR_TOAST_ID,
            duration: Infinity,
            closeButton: true,
          },
        );

        return;
      }

      const inputUsername = inputParse.data.username.trim();
      const [actualUsername, domainPart] = inputUsername.includes("@")
        ? inputUsername.split("@")
        : [inputUsername, null];

      const credential = inputParse.data.password;
      const password = new TextEncoder().encode(credential);
      const input = event.currentTarget.elements.namedItem(
        "password",
      ) as HTMLInputElement;
      input.value = "";
      loginPendingRef.current = true;
      setProgress("Preparing secure sign-in...");

      try {
        if (!isBase64Credential(credential)) {
          await loginWithPassword({
            username: actualUsername,
            password,
            storage,
            omegaOrigin: domainPart ? `https://${domainPart}/` : undefined,
            onProgress: setProgress,
          });
          setProgress("Opening your account...");
          await navigate({ to: "/", replace: true });

          return;
        }

        setProgress("Looking up your account...");
        const storedOmegaUrl = await load("omega_url");
        const omega = normalizeOmegaOrigin(
          domainPart ? `https://${domainPart}` : storedOmegaUrl,
        );
        const account = await fetchAccountIdentity(omega, actualUsername);
        await persistLogin(account.user_id, credential, domainPart);
      } catch (error) {
        log(0, "login", "red", error);
        toast(
          "error",
          "Logging in failed",
          error instanceof Error ? error.message : String(error),
          { id: LOGIN_ERROR_TOAST_ID, duration: Infinity, closeButton: true },
        );
      } finally {
        password.fill(0);
        loginPendingRef.current = false;
        setProgress(null);
      }
    },
    [filePickerOpen, load, navigate, persistLogin, qrBusy, storage],
  );

  return (
    <CreateScreen>
      <div className="w-full h-full flex justify-center">
        <div className="relative flex min-h-0 flex-col items-center gap-5 h-full w-full overflow-y-auto px-5 py-6">
          <input
            accept={
              isTauri() && isMobile ? "application/octet-stream,.tu" : ".tu"
            }
            onChange={handleFileInputChange}
            type="file"
            disabled={busy}
            ref={uploadRef}
            hidden
          />
          <div className="mt-auto flex w-full shrink-0 flex-row flex-wrap items-center justify-center gap-6 md:w-auto md:gap-15">
            {isMobile ? (
              <Button
                variant="outline"
                disabled={controlsDisabled}
                onClick={openFilePicker}
                className={cn(
                  "flex aspect-square h-auto w-55 max-w-full shrink-0 flex-col gap-3",
                  isDragging && "animate-wiggle",
                  isMobile && "border-3! bg-transparent!",
                )}
              >
                {controlsDisabled ? (
                  <Loader2 aria-hidden="true" className="size-7 animate-spin" />
                ) : (
                  <File className="size-7" />
                )}
                <span className="whitespace-normal text-center text-sm">
                  {status ?? "Select TU file"}
                </span>
              </Button>
            ) : (
              <QrLogin
                disabled={progress !== null || filePickerOpen}
                onBusyChange={setQrBusy}
                status={status}
              />
            )}
            <form
              className="flex max-w-full flex-col justify-between aspect-square w-55"
              onSubmit={handleCredentialsSubmit}
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  required
                  type="text"
                  id="username"
                  name="username"
                  autoComplete="username"
                  disabled={controlsDisabled}
                />
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 pr-1">
                  <Label htmlFor="login-password">Password</Label>
                  {!isMobile && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            disabled={controlsDisabled}
                            aria-label="Supported login credentials"
                            className="text-muted-foreground ml-auto"
                          />
                        }
                      >
                        <Info className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipContent>
                        MTP Keyrings are supported.
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
                <Input
                  required
                  type="password"
                  id="login-password"
                  name="password"
                  autoComplete="current-password"
                  disabled={controlsDisabled}
                />
              </div>
              <Button type="submit" disabled={controlsDisabled}>
                Login
              </Button>
            </form>
          </div>
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
          >
            {status}
          </div>
          <div className="mb-auto flex shrink-0 justify-center">
            <a
              target="_blank"
              href="https://docs.tensamin.net/installation/#iota"
            >
              <p className="text-sm text-muted-foreground text-center whitespace-pre-wrap">
                Don't have an account yet?{"\n"}Click here to get help setting
                up an Iota.
              </p>
            </a>
          </div>
          {!isMobile && (
            <Button
              variant="outline"
              size="sm"
              disabled={controlsDisabled}
              onClick={openFilePicker}
              className={cn(
                isDragging && "animate-wiggle",
                "absolute bottom-5",
              )}
            >
              Select TU file
            </Button>
          )}
        </div>
        <RightSidePanel />
      </div>
    </CreateScreen>
  );
}

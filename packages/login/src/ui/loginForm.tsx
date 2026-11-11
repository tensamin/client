import { Button, cn, useIsMobile, toast as sonnerToast } from "@nonanium/ui";
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
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const loginPendingRef = useRef(false);

  const persistLogin = useCallback(
    async (userId: number, privateKey: string, domain?: string | null) => {
      if (loginPendingRef.current) return;
      loginPendingRef.current = true;

      try {
        await persistMtpCredentials({
          storage: { load, save },
          userId,
          keyring: privateKey,
          domain,
        });
        sonnerToast.dismiss(LOGIN_ERROR_TOAST_ID);
        await navigate({ to: "/", replace: true });
      } finally {
        loginPendingRef.current = false;
      }
    },
    [load, navigate, save],
  );

  const processDroppedFile = useCallback(
    async (file: globalThis.File): Promise<void> => {
      sonnerToast.dismiss(LOGIN_ERROR_TOAST_ID);

      try {
        if (!file.name.endsWith(".tu")) {
          toast(
            "error",
            "Importing login file failed",
            "Please upload a .tu file",
            {
              id: LOGIN_ERROR_TOAST_ID,
              duration: Infinity,
              closeButton: true,
            },
          );

          return;
        }

        const parsed = parseTuFileContent(await file.text());
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
      }
    },
    [persistLogin],
  );

  const {
    filePickerOpen,
    handleFileInputChange,
    isDragging,
    openFilePicker,
    uploadRef,
  } = useTuFileInput(processDroppedFile);

  const handleCredentialsSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();

      if (busy) return;
      sonnerToast.dismiss(LOGIN_ERROR_TOAST_ID);
      const inputParse = formSchema.safeParse(
        Object.fromEntries(new FormData(event.currentTarget)),
      );

      if (!inputParse.success) {
        toast("error", "Logging in failed", "Please enter valid data", {
          id: LOGIN_ERROR_TOAST_ID,
          duration: Infinity,
          closeButton: true,
        });

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
      setBusy(true);

      try {
        if (!isBase64Credential(credential)) {
          await loginWithPassword({
            username: actualUsername,
            password,
            storage,
            omegaOrigin: domainPart ? `https://${domainPart}/` : undefined,
          });
          await navigate({ to: "/", replace: true });

          return;
        }

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
        setBusy(false);
      }
    },
    [busy, load, navigate, persistLogin, storage],
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
            ref={uploadRef}
            hidden
          />
          <div className="mt-auto flex w-full shrink-0 flex-row flex-wrap items-center justify-center gap-6 md:w-auto md:gap-15">
            {isMobile ? (
              <Button
                variant="outline"
                disabled={filePickerOpen}
                onClick={openFilePicker}
                className={cn(
                  "flex aspect-square h-auto w-55 max-w-full shrink-0 flex-col gap-3",
                  isDragging && "animate-wiggle",
                  isMobile && "border-3! bg-transparent!",
                )}
              >
                {filePickerOpen ? (
                  <Loader2 className="size-7 animate-spin" />
                ) : (
                  <File className="size-7" />
                )}
                {filePickerOpen ? "Opening file picker..." : "Select TU file"}
              </Button>
            ) : (
              <QrLogin />
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
                  disabled={busy}
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
                  disabled={busy}
                />
              </div>
              <Button type="submit" disabled={busy}>
                {busy ? "Logging in..." : "Login"}
              </Button>
            </form>
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
              disabled={filePickerOpen}
              onClick={openFilePicker}
              className={cn(
                isDragging && "animate-wiggle",
                "absolute bottom-5",
              )}
            >
              {filePickerOpen && <Loader2 className="animate-spin" />}
              {filePickerOpen ? "Opening file picker..." : "Select TU file"}
            </Button>
          )}
        </div>
        <RightSidePanel />
      </div>
    </CreateScreen>
  );
}

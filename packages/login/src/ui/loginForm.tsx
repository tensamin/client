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
import QrLogin from "./qrLogin";
import { CreateScreen } from "@nonanium/ui";
import RightSidePanel from "./rightSidePanel";

const formSchema = z.object({
  username: z.string().min(1).max(255),
  password: z.string().min(1),
});

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
        await navigate({ to: "/", replace: true });
      } finally {
        loginPendingRef.current = false;
      }
    },
    [load, navigate, save],
  );

  const processDroppedFile = useCallback(
    async (file: globalThis.File): Promise<void> => {
      try {
        if (!file.name.endsWith(".tu")) {
          toast("error", "Please upload a .tu file", undefined, {
            duration: Infinity,
            closeButton: true,
          });
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
        toast("error", message, undefined, {
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
      const inputParse = formSchema.safeParse(
        Object.fromEntries(new FormData(event.currentTarget)),
      );
      if (!inputParse.success) {
        toast("error", "Please enter valid data", undefined, {
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
      const isKeyring =
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          credential,
        );
      const password = new TextEncoder().encode(credential);
      const input = event.currentTarget.elements.namedItem(
        "password",
      ) as HTMLInputElement;
      input.value = "";
      setBusy(true);
      try {
        if (!isKeyring) {
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
          error instanceof Error ? error.message : "Login failed",
          undefined,
          { duration: Infinity, closeButton: true },
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
                <div className="flex items-center gap-2">
                  <Label htmlFor="login-password">Password</Label>
                  {!isMobile && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label="Supported login credentials"
                            className="text-muted-foreground ml-auto mr-1"
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
                "absolute bottom-0 mb-5",
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

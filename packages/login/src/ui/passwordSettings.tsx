import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nonanium/ui";
import { RefreshCw } from "lucide-react";
import { useStorage } from "@tensamin/storage/context";
import { useMTP } from "@tensamin/mtp";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  disablePasswordLogin,
  enrollPassword,
  passwordEnrollmentStatus,
} from "../password/enrollment";
import { toast } from "@tensamin/shared/log";
import { encodePrincipal } from "@tensamin/shared/principal";
import { BASE64_PASSWORD_ERROR, isBase64Credential } from "../password/policy";

export default function PasswordSettings() {
  const { client, send, contextReady, clientState } = useMTP();
  const userId = clientState?.Scope?.principal.user_id;
  const authorizationGeneration = clientState?.Scope?.authorization_generation;
  const principal = clientState?.Scope
    ? encodePrincipal(clientState.Scope.principal)
    : undefined;
  const storage = useStorage();
  const lifetime = useRef<AbortController | null>(null);
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState<boolean>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);

  const run = useCallback(
    async (action: "status" | "disable" | "enroll", password?: Uint8Array) => {
      const active = lifetime.current;

      if (
        !client ||
        !contextReady ||
        !userId ||
        !principal ||
        authorizationGeneration === undefined ||
        !active ||
        active.signal.aborted ||
        pending.current === active
      ) {
        password?.fill(0);

        return;
      }

      pending.current = active;
      setBusy(true);

      try {
        const response = await send("GetUserData", { UserId: userId });
        active.signal.throwIfAborted();

        if (
          response.type !== "GetUserData" ||
          response.data.UserId !== userId
        ) {
          throw new Error("Password management account could not be verified");
        }

        const options = {
          client,
          storage,
          principal,
          authorizationGeneration,
          username: response.data.Username,
          signal: active.signal,
        };

        if (action === "enroll" && password) {
          await enrollPassword({ ...options, password });
          active.signal.throwIfAborted();
          setEnabled(true);
          setOpen(false);
        } else if (action === "disable") {
          await disablePasswordLogin(options);
          active.signal.throwIfAborted();
          setEnabled(false);
        } else {
          const enabled = await passwordEnrollmentStatus(options);
          active.signal.throwIfAborted();
          setEnabled(enabled);
        }

        setError(undefined);
      } catch (caught) {
        if (active.signal.aborted) return;
        const description =
          caught instanceof Error ? caught.message : String(caught);
        setEnabled(undefined);
        setOpen(false);
        setError(description);
        const operation =
          action === "enroll"
            ? "Enabling password login"
            : action === "disable"
              ? "Disabling password login"
              : "Checking password login status";
        toast("error", `${operation} failed`, description);
      } finally {
        password?.fill(0);

        if (pending.current === active) pending.current = null;

        if (!active.signal.aborted) setBusy(false);
      }
    },
    [
      client,
      contextReady,
      userId,
      principal,
      authorizationGeneration,
      storage,
      send,
    ],
  );

  useEffect(() => {
    const active = new AbortController();
    lifetime.current = active;
    setEnabled(undefined);
    setError(undefined);
    setBusy(false);
    setOpen(false);
    void run("status");

    return () => active.abort(new Error("Password management account changed"));
  }, [run]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const credential = String(new FormData(form).get("password") ?? "");
    form.reset();

    if (isBase64Credential(credential)) {
      toast("error", "Enabling password login failed", BASE64_PASSWORD_ERROR);

      return;
    }

    const password = new TextEncoder().encode(credential);
    void run("enroll", password);
  }

  return (
    <section className="flex max-w-2xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex gap-2 items-center">
          <Switch
            id="password-login"
            checked={enabled ?? false}
            disabled={!client || !contextReady || busy || enabled === undefined}
            onCheckedChange={(checked) => {
              if (checked) setOpen(true);
              else void run("disable");
            }}
          />
          <Label htmlFor="password-login">Enable password login</Label>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={!client || !contextReady || busy}
                  onClick={() => void run("status")}
                >
                  <RefreshCw className={busy ? "animate-spin" : undefined} />
                </Button>
              }
            />
            <TooltipContent>
              {busy ? "Checking..." : "Check status"}
            </TooltipContent>
          </Tooltip>
          <Dialog open={open} onOpenChange={setOpen}>
            {(enabled ?? false) ? (
              <DialogTrigger render={<Button variant="outline" />}>
                Change password
              </DialogTrigger>
            ) : null}
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {enabled ? "Change password" : "Set up password login"}
                </DialogTitle>
              </DialogHeader>
              <form className="flex max-w-md flex-col gap-3" onSubmit={submit}>
                <Label htmlFor="enrollment-password">New password</Label>
                <Input
                  id="enrollment-password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  disabled={!client || !contextReady || busy}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    disabled={!client || !contextReady || busy}
                  >
                    Set password
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          Password status is unconfirmed. {error}
        </p>
      )}
    </section>
  );
}

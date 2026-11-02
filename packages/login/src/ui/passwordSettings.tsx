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
} from "@nonanium/ui";
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

export default function PasswordSettings() {
  const { client, send, contextReady, clientState } = useMTP();
  const userId = clientState?.Scope?.principal.user_id;
  const principal = clientState?.Scope
    ? encodePrincipal(clientState.Scope.principal)
    : undefined;
  const storage = useStorage();
  const lifetime = useRef<AbortController | null>(null);
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState<boolean>();
  const [open, setOpen] = useState(false);

  const run = useCallback(
    async (action: "status" | "disable" | "enroll", password?: Uint8Array) => {
      const active = lifetime.current;
      if (
        !client ||
        !contextReady ||
        !userId ||
        !principal ||
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
      } catch (caught) {
        if (active.signal.aborted) return;
        toast(
          "error",
          caught instanceof Error
            ? caught.message
            : "Password management failed",
        );
      } finally {
        password?.fill(0);
        if (pending.current === active) pending.current = null;
        if (!active.signal.aborted) setBusy(false);
      }
    },
    [client, contextReady, userId, principal, storage, send],
  );

  useEffect(() => {
    const active = new AbortController();
    lifetime.current = active;
    setEnabled(undefined);
    setBusy(false);
    setOpen(false);
    void run("status");
    return () => active.abort(new Error("Password management account changed"));
  }, [run]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const password = new TextEncoder().encode(
      String(new FormData(form).get("password") ?? ""),
    );
    form.reset();
    void run("enroll", password);
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
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
        <div className="flex items-center gap-3 h-5">
          <Dialog open={open} onOpenChange={setOpen}>
            {(enabled ?? false) ? (
              <DialogTrigger render={<Button variant="outline" size="xs" />}>
                Edit
              </DialogTrigger>
            ) : null}
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Edit password</DialogTitle>
              </DialogHeader>
              <form className="flex max-w-md flex-col gap-3" onSubmit={submit}>
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
    </section>
  );
}

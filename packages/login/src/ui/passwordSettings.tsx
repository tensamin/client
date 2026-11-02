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

export default function PasswordSettings() {
  const { client, send } = useMTP();
  const storage = useStorage();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState<boolean>();
  const [open, setOpen] = useState(false);

  const run = useCallback(
    async (action: "status" | "disable" | "enroll", password?: Uint8Array) => {
      if (!client || pending.current) {
        password?.fill(0);
        return;
      }
      pending.current = true;
      setBusy(true);
      try {
        const userId = await storage.load("user_id");
        const response = await send("GetUserData", { UserId: userId });
        const options = { client, storage, username: response.data.Username };
        if (action === "enroll" && password) {
          await enrollPassword({ ...options, password });
          setEnabled(true);
          setOpen(false);
        } else if (action === "disable") {
          await disablePasswordLogin(options);
          setEnabled(false);
        } else {
          const enabled = await passwordEnrollmentStatus(options);
          setEnabled(enabled);
        }
      } catch (caught) {
        toast(
          "error",
          caught instanceof Error
            ? caught.message
            : "Password management failed",
        );
      } finally {
        password?.fill(0);
        pending.current = false;
        setBusy(false);
      }
    },
    [client, storage, send],
  );

  useEffect(() => {
    void run("status");
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
            disabled={!client || busy || enabled === undefined}
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
                  disabled={!client || busy}
                />
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={!client || busy}>
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

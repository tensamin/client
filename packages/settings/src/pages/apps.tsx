import { useMTP } from "@tensamin/mtp";
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@nonanium/ui";
import { Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "@tensamin/shared/log";

type Grant = {
  app_id: string;
  app_name: string;
  domain: string;
  scopes: string[];
  insecure: boolean;
  metadata: string | null;
};

export default function Page() {
  const { send } = useMTP();
  const [grants, setGrants] = useState<Grant[]>([]);
  const [json, setJson] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [revoke, setRevoke] = useState<Grant>();

  const refresh = useCallback(async () => {
    const { data } = await send("TAuthGrantList", {});
    const next = JSON.parse(data.Json) as Grant[];
    setGrants(next);
    setJson(
      Object.fromEntries(
        next.map((grant) => [grant.app_id, grant.metadata ?? "null"]),
      ),
    );
  }, [send]);

  useEffect(() => {
    void refresh().catch((error) =>
      toast(
        "error",
        "Loading apps failed",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }, [refresh]);

  async function run(
    appId: string,
    operation: string,
    action: () => Promise<void>,
  ) {
    setBusy(appId);

    try {
      await action();
      operation = "Loading apps";
      await refresh();
    } catch (error) {
      toast(
        "error",
        `${operation} failed`,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <Dialog
        open={!!revoke}
        onOpenChange={(open) => {
          if (!open) setRevoke(undefined);
        }}
      >
        <DialogContent>
          <DialogTitle>Revoke app access</DialogTitle>
          <DialogDescription>
            Revoke {revoke?.app_name} and delete its JSON?
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRevoke(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!!busy}
              onClick={() => {
                if (!revoke) return;
                void run(revoke.app_id, "Revoking app access", () =>
                  send("TAuthGrantRevoke", { AppId: revoke.app_id }).then(
                    () => undefined,
                  ),
                );
                setRevoke(undefined);
              }}
            >
              Revoke
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-1/3">App name</TableHead>
            <TableHead>App data</TableHead>
            <TableHead className="w-0">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {grants.map((grant) => (
            <TableRow key={grant.app_id}>
              <TableCell className="align-top">
                <p className="font-medium">{grant.app_name}</p>
                <p className="text-xs text-muted-foreground">{grant.domain}</p>
                <p className="pt-1 text-xs text-muted-foreground">
                  {grant.scopes.join(", ")}
                </p>
                {grant.insecure && (
                  <p className="pt-1 text-xs font-medium text-destructive">
                    Insecure
                  </p>
                )}
              </TableCell>
              <TableCell>
                <Textarea
                  aria-label={`${grant.app_name} JSON metadata`}
                  className="min-h-28 font-mono text-xs"
                  spellCheck={false}
                  value={json[grant.app_id] ?? "null"}
                  onChange={(event) =>
                    setJson((current) => ({
                      ...current,
                      [grant.app_id]: event.currentTarget.value,
                    }))
                  }
                />
              </TableCell>
              <TableCell className="align-top">
                <div className="flex gap-1">
                  <Button
                    disabled={busy === grant.app_id}
                    size="icon-xs"
                    title={`Save ${grant.app_name} JSON`}
                    variant="ghost"
                    onClick={() => {
                      const value = json[grant.app_id] ?? "null";

                      try {
                        JSON.parse(value);
                      } catch (error) {
                        toast(
                          "error",
                          "Saving app data failed",
                          error instanceof Error
                            ? error.message
                            : String(error),
                        );

                        return;
                      }

                      void run(grant.app_id, "Saving app data", () =>
                        send("TAuthGrantMetadataSet", {
                          AppId: grant.app_id,
                          Json: value,
                        }).then(() => undefined),
                      );
                    }}
                  >
                    <Save className="size-3.5" />
                  </Button>
                  <Button
                    className="text-destructive hover:text-destructive"
                    disabled={busy === grant.app_id}
                    size="icon-xs"
                    title={`Revoke ${grant.app_name}`}
                    variant="ghost"
                    onClick={() => {
                      setRevoke(grant);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
          {grants.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={3}
                className="text-center text-muted-foreground"
              >
                No authorized apps.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </>
  );
}

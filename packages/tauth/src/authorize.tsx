import { useMTP } from "@tensamin/mtp";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@nonanium/ui";
import { isTauri } from "@tauri-apps/api/core";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

type AuthorizationDetails = {
  AppId: string;
  AppName: string;
  Domain: string;
  RedirectUri: string;
  Scopes: string[];
  State: string;
  Locator: string;
  AuthorizationCode?: string;
};

function decodeRequest(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return new TextDecoder().decode(
    Uint8Array.from(
      atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
      (character) => character.charCodeAt(0),
    ),
  );
}

function finish(details: AuthorizationDetails, error?: "access_denied") {
  const redirect = new URL(details.RedirectUri);
  redirect.searchParams.set("state", details.State);
  if (error) {
    redirect.searchParams.set("error", error);
  } else {
    redirect.searchParams.set("code", details.AuthorizationCode!);
    redirect.searchParams.set("locator", details.Locator);
  }
  const result = error
    ? { error, state: details.State }
    : {
        code: details.AuthorizationCode!,
        locator: details.Locator,
        state: details.State,
      };
  if (window.opener) {
    window.opener.postMessage(
      { type: "tauth.authorization", ...result },
      redirect.origin,
    );
  }
  window.location.assign(redirect);
}

export default function Authorize({ request }: { request?: string }) {
  const { send } = useMTP();
  const [details, setDetails] = useState<AuthorizationDetails | null>(null);
  const [error, setError] = useState(
    request ? "" : "Missing authorization request.",
  );
  const [busy, setBusy] = useState(Boolean(request));

  useEffect(() => {
    if (!request) return;
    if (!isTauri() && !window.tensaminDesktop) {
      window.location.href = `tensamin://authorize?request=${encodeURIComponent(request)}`;
    }
    let decodedRequest: string;
    try {
      decodedRequest = decodeRequest(request);
    } catch {
      setError("Invalid authorization request.");
      setBusy(false);
      return;
    }
    let active = true;
    send("TAuthAuthorize", {
      AuthorizationRequest: decodedRequest,
      Enabled: false,
    })
      .then(({ data }) => {
        if (!active) return;
        const verified = data as AuthorizationDetails;
        if (verified.AuthorizationCode) {
          finish(verified);
          return;
        }
        setDetails(verified);
      })
      .catch((caught) => {
        if (active)
          setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => active && setBusy(false));
    return () => {
      active = false;
    };
  }, [request, send]);

  async function allow() {
    if (!request) return;
    setBusy(true);
    setError("");
    try {
      const { data } = await send("TAuthAuthorize", {
        AuthorizationRequest: decodeRequest(request),
        Enabled: true,
      });
      finish(data as AuthorizationDetails);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  }

  return (
    <div className="w-full h-full min-h-0 bg-background flex flex-col items-center overflow-y-auto p-4">
      <Card className="relative my-auto w-full max-w-lg shrink-0 wrap-anywhere">
        <CardHeader>
          <CardTitle>{details?.AppName ?? "Verify app"}</CardTitle>
          <div className="absolute -top-5 right-3">
            {busy && <Loader2 className="mx-auto my-8 size-6 animate-spin" />}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <CardDescription>
            {details
              ? `${details.Domain} requests access to your Tensamin account.`
              : "Tensamin is checking DNS, manifest, app signature, and redirect binding."}
          </CardDescription>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {details && (
            <div className="flex flex-col gap-3">
              <div>
                <p className="font-medium">Verified domain</p>
                <p className="text-muted-foreground">{details.Domain}</p>
              </div>
              <div className="flex flex-col gap-2">
                <p className="font-medium">Requested scopes</p>
                <div className="flex flex-col gap-1 text-muted-foreground">
                  {details.Scopes.map((scope) => (
                    <div key={scope} className="flex items-center gap-1.5">
                      <div className="size-1 bg-(--muted-foreground) rounded-full" />
                      <p>{scope}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </CardContent>
        <CardFooter className="flex gap-2">
          <Button disabled={!details || busy} onClick={() => void allow()}>
            {busy && <Loader2 className="animate-spin" />}
            Allow
          </Button>
          <Button
            variant="outline"
            disabled={!details || busy}
            onClick={() => details && finish(details, "access_denied")}
          >
            Deny
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

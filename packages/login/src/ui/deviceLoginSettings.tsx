import { Button } from "@nonanium/ui";
import { useStorage } from "@tensamin/storage/context";
import { useMTP } from "@tensamin/mtp";
import { useCallback, useEffect, useRef, useState } from "react";
import { claimTemporaryLogin } from "../qr/temporaryLogin";
import { qrLoginId } from "../qr/deeplink";
import { log, toast } from "@tensamin/shared/log";

export default function DeviceLoginSettings({
  loginLink,
  onHandled,
}: {
  loginLink?: string;
  onHandled?: () => void;
} = {}) {
  const storage = useStorage();
  const { client, sessionEstablished } = useMTP();
  const pending = useRef<Awaited<
    ReturnType<typeof claimTemporaryLogin>
  > | null>(null);
  const generation = useRef(0);
  const [attempt, setAttempt] = useState("");
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const [scanning, setScanning] = useState(false);
  const start = useCallback(
    async (id: string) => {
      if (busy) return;
      const current = ++generation.current;
      setBusy(true);
      try {
        if (!client)
          throw new Error("Authenticated login transport unavailable");
        id = qrLoginId(id);
        log(0, "qr-login", "blue", "Claiming temporary session");
        const claimed = await claimTemporaryLogin({ id, client, storage });
        if (current !== generation.current) {
          await claimed.cancel();
          return;
        }
        pending.current = claimed;
        log(0, "qr-login", "green", "Claim accepted; showing approval dialog");
        setAttempt(id);
      } catch (error) {
        if (current === generation.current) {
          toast(
            "error",
            error instanceof Error ? error.message : "Login claim failed",
          );
          log(0, "qr-login", "red", "Claim failed", String(error));
          setBusy(false);
        }
      }
    },
    [busy, client, storage],
  );
  const handledLink = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (
      !loginLink ||
      !sessionEstablished ||
      !client ||
      busy ||
      handledLink.current === loginLink
    )
      return;
    handledLink.current = loginLink;
    void start(loginLink).finally(() => onHandled?.());
  }, [loginLink, sessionEstablished, client, busy, start, onHandled]);
  useEffect(() => {
    if (!scanning) return;
    let stream: MediaStream | undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function scan() {
      try {
        const Detector = (
          globalThis as unknown as {
            BarcodeDetector?: new (options: { formats: string[] }) => {
              detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
            };
          }
        ).BarcodeDetector;
        if (!Detector)
          throw new Error(
            "QR scanning is unavailable in this browser. Paste the temporary login ID instead.",
          );
        const detector = new Detector({ formats: ["qr_code"] });
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (stopped) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const element = video.current;
        if (!element) throw new Error("Camera view unavailable");
        element.srcObject = stream;
        await element.play();
        async function detect() {
          if (stopped || !video.current) return;
          try {
            const codes = await detector.detect(video.current);
            if (stopped) return;
            if (codes[0]) {
              log(0, "qr-login", "blue", "Camera decoded QR");
              setScanning(false);
              void start(codes[0].rawValue.trim());
              return;
            }
            timer = setTimeout(() => void detect(), 200);
          } catch (error) {
            toast(
              "error",
              error instanceof Error ? error.message : "QR scan failed",
            );
            setScanning(false);
          }
        }
        void detect();
      } catch (error) {
        if (!stopped) {
          toast(
            "error",
            error instanceof Error ? error.message : "Camera unavailable",
          );
          setScanning(false);
        }
      }
    }
    void scan();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [scanning, start]);
  const confirmAt = useRef(0);
  useEffect(() => {
    if (!attempt) return;
    setEnabled(false);
    confirmAt.current = Date.now() + 3_000;
    const timer = setTimeout(() => setEnabled(true), 3_000);
    return () => clearTimeout(timer);
  }, [attempt]);
  useEffect(
    () => () => {
      generation.current++;
      void pending.current?.cancel().catch(() => {});
    },
    [],
  );

  function cancel() {
    generation.current++;
    void pending.current?.cancel().catch(() => {});
    pending.current = null;
    setAttempt("");
    setBusy(false);
  }

  async function confirm() {
    const claimed = pending.current;
    if (!claimed || !enabled || Date.now() < confirmAt.current) return;
    setEnabled(false);
    const current = generation.current;
    try {
      await claimed.confirm();
    } catch (error) {
      await claimed.cancel().catch(() => {});
      if (current === generation.current)
        toast(
          "error",
          error instanceof Error ? error.message : "Transfer failed",
        );
    } finally {
      if (current === generation.current) {
        pending.current = null;
        setAttempt("");
        setBusy(false);
      }
    }
  }

  return (
    <section className="flex max-w-md flex-col gap-3">
      {busy && !attempt && (
        <Button variant="outline" onClick={cancel}>
          Cancel
        </Button>
      )}
      {attempt && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center overflow-y-auto bg-background pt-[max(1.5rem,var(--ui-safe-area-top))] pr-[max(1.5rem,var(--ui-safe-area-right))] pb-[max(1.5rem,var(--ui-safe-area-bottom))] pl-[max(1.5rem,var(--ui-safe-area-left))]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="qr-login-warning"
          onKeyDown={(event) => {
            if (event.key === "Escape") cancel();
          }}
        >
          <div className="my-auto flex max-w-lg shrink-0 flex-col gap-5">
            <h2 id="qr-login-warning" className="text-xl font-semibold">
              Approve login on another device?
            </h2>
            <p className="text-destructive">
              Never approve logins on devices that don't belong to you!
              Approving a login, even temporarily, will send your permanent
              private key to another device, which will compromise it
              permanently!
            </p>
            <Button variant="outline" onClick={cancel}>
              Cancel
            </Button>
            <Button disabled={!enabled} onClick={() => void confirm()}>
              {enabled ? "Approve" : "Please read the warning..."}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

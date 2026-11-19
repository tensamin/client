import { type ReactNode, useContext, useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { MTPClient } from "mtp";
import { startDiagnostics } from "./diagnostics";

import { MTPContext, type MTPContextType } from "./mtpContext";
import { RendererProvider } from "./rendererProvider";

export function Provider({
  fallback,
  ...props
}: {
  children: ReactNode;
  blockConnection?: boolean;
  fallback?: ReactNode;
}) {
  useEffect(() => {
    void startDiagnostics();
  }, []);
  if (isTauri()) return <RendererProvider {...props} />;
  return <BrowserWasmProvider {...props} fallback={fallback} />;
}

function BrowserWasmProvider({
  fallback,
  ...props
}: {
  children: ReactNode;
  blockConnection?: boolean;
  fallback?: ReactNode;
}) {
  const [wasmReady, setWasmReady] = useState(false);
  const [wasmError, setWasmError] = useState<unknown>();
  useEffect(() => {
    let active = true;
    void startDiagnostics()
      .then(() => MTPClient.init())
      .then(
        () => active && setWasmReady(true),
        (error: unknown) => active && setWasmError(() => error),
      );
    return () => {
      active = false;
    };
  }, []);
  if (wasmError) throw wasmError;
  return wasmReady ? <RendererProvider {...props} /> : fallback;
}

export function useMTP(): MTPContextType {
  const context = useContext(MTPContext);
  if (!context) throw new Error("useMTP must be used within an MTPProvider");
  return context;
}

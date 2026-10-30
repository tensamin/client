import { type ReactNode, useContext, useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { MTPClient } from "mtp";

import { BrowserProvider } from "./browser";
import { MTPContext, type MTPContextType } from "./mtpContext";
import { TauriProvider } from "./tauri";

export function Provider({
  fallback,
  ...props
}: {
  children: ReactNode;
  blockConnection?: boolean;
  fallback?: ReactNode;
}) {
  if (isTauri()) return <TauriProvider {...props} />;
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
    void MTPClient.init().then(
      () => active && setWasmReady(true),
      (error: unknown) => active && setWasmError(() => error),
    );
    return () => {
      active = false;
    };
  }, []);
  if (wasmError) throw wasmError;
  return wasmReady ? <BrowserProvider {...props} /> : fallback;
}

export function useMTP(): MTPContextType & { accountKey: string | undefined } {
  const context = useContext(MTPContext);
  if (!context) throw new Error("useMTP must be used within an MTPProvider");
  const scope = context.clientState?.Scope;
  return {
    ...context,
    accountKey: scope
      ? JSON.stringify([scope.principal, scope.authorization_generation])
      : undefined,
  };
}

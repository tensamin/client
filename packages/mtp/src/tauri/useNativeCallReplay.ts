import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { mtp as mtpSchemas } from "@tensamin/shared/data";
import { log } from "@tensamin/shared/log";
import { decode, MTPProtocol } from "mtp";
import { useEffect } from "react";

import type { RendererState } from "../renderer/state";

export function useNativeCallReplay(
  state: Pick<
    RendererState,
    | "contextClient"
    | "identified"
    | "visible"
    | "callActive"
    | "authenticatedClientRef"
    | "nativeGenerationRef"
    | "publish"
  >,
  sendToCallOwner: NonNullable<
    RendererState["callControlRequestRef"]["current"]
  >,
) {
  const {
    contextClient,
    identified,
    visible,
    callActive,
    authenticatedClientRef,
    nativeGenerationRef,
    publish,
  } = state;
  useEffect(() => {
    if (
      !isTauri() ||
      !contextClient ||
      !identified ||
      (!visible && !callActive)
    )
      return;
    let disposed = false;
    let stop: (() => void) | undefined;
    const replay = async () => {
      const status = await invoke<{ identified: boolean; generation: number }>(
        "mtp_status",
      );

      if (!status.identified || disposed) return;
      const frames = await invoke<number[][]>("mtp_pending_calls");
      const protocol = new MTPProtocol({
        schemas: mtpSchemas,
        throwProtocolErrors: true,
      });

      for (const bytes of frames) {
        if (
          disposed ||
          authenticatedClientRef.current !== contextClient ||
          nativeGenerationRef.current !== status.generation
        )
          return;
        const invitation = await protocol.parseResponse(
          "CallInvite",
          decode(Uint8Array.from(bytes)),
        );

        if (
          invitation.type !== "CallInvite" ||
          !invitation.data.CallId ||
          !invitation.data.OmikronId
        )
          continue;

        try {
          const current = await sendToCallOwner(
            invitation.data.OmikronId,
            "CallData",
            { CallId: invitation.data.CallId },
          );

          if (
            !disposed &&
            current.type === "CallData" &&
            authenticatedClientRef.current === contextClient &&
            nativeGenerationRef.current === status.generation
          )
            publish(invitation);
        } catch (error) {
          log(
            1,
            "call",
            "yellow",
            "Saved invitation is no longer available",
            error,
          );
        }
      }
    };

    const wake = () => {
      void replay().catch((error) =>
        log(1, "call", "red", "Native call handoff failed", error),
      );
    };

    void listen<{ kind: string; snapshot?: { identified: boolean } }>(
      "tensamin://mtp",
      ({ payload }) => {
        if (payload.kind === "state" && payload.snapshot?.identified) wake();
      },
    ).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    wake();

    return () => {
      disposed = true;
      stop?.();
    };
  }, [
    authenticatedClientRef,
    callActive,
    contextClient,
    identified,
    nativeGenerationRef,
    publish,
    sendToCallOwner,
    visible,
  ]);
}

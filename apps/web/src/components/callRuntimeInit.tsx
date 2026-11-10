import { useEffect, useState } from "react";

import { useTheme } from "@nonanium/ui";
import { useIsSpeaking } from "@tensamin/call/speakingState";
import { useCall, useInitializeCall } from "@tensamin/call/store";
import { useMTP } from "@tensamin/mtp";

function createCallTrayIcon(color: string, speaking: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;

  const context = canvas.getContext("2d");

  if (!context) return undefined;

  context.globalAlpha = speaking ? 1 : 0.55;
  context.fillStyle = color;
  context.beginPath();
  context.arc(16, 16, 13, 0, Math.PI * 2);
  context.fill();

  if (speaking) {
    context.globalAlpha = 0.3;
    context.fillStyle = "#ffffff";
    context.fill();
  }

  return canvas.toDataURL("image/png");
}

export default function CallRuntimeInit() {
  const callInvitePopup = useInitializeCall();
  const { clientState, setCallActive } = useMTP();
  const { selectedTheme, resolvedPolarity } = useTheme();
  const localUserId = clientState?.Scope?.principal.user_id ?? -1;
  const [primaryColor, setPrimaryColor] = useState("");
  const inCall = useCall((state) => state.state === "open");
  const callActive = useCall((state) => state.state !== "closed");
  const microphone = useCall((state) => state.micEnabled);
  const speaking = useIsSpeaking(localUserId);

  useEffect(() => {
    setCallActive(callActive, microphone);
  }, [callActive, microphone, setCallActive]);
  useEffect(() => () => setCallActive(false, false), [setCallActive]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setPrimaryColor(
        getComputedStyle(document.documentElement)
          .getPropertyValue("--primary")
          .trim(),
      );
    });

    return () => cancelAnimationFrame(frame);
  }, [selectedTheme, resolvedPolarity]);

  useEffect(() => {
    const iconDataUrl = primaryColor
      ? createCallTrayIcon(primaryColor, speaking)
      : undefined;

    void window.tensaminDesktop?.call
      ?.setStatus?.({
        inCall,
        speaking: inCall && speaking,
        iconDataUrl: inCall ? iconDataUrl : undefined,
      })
      .catch((error: unknown) => {
        console.error("Failed to update desktop call status", error);
      });
  }, [inCall, primaryColor, speaking]);

  return callInvitePopup;
}

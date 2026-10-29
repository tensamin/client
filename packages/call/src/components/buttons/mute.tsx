import { Button } from "@nonanium/ui";
import { toggleMute, useCall } from "../../store";
import { Mic, MicOff } from "lucide-react";
import {
  type CallButtonProps,
  iconScale,
  withButtonTooltip,
} from "./tooltipButton";

export default function MuteButton({
  className,
  iconSize,
  tooltip,
  portalContainer,
}: CallButtonProps) {
  const micEnabled = useCall((state) => state.micEnabled);

  const button = (
    <Button
      aria-label={micEnabled ? "Mute microphone" : "Unmute microphone"}
      variant={micEnabled ? "default" : "destructive"}
      className={`${className ?? ""} motion-safe:transition-colors motion-safe:duration-200`}
      onClick={() => void toggleMute()}
    >
      {micEnabled ? (
        <Mic style={iconScale(iconSize)} />
      ) : (
        <MicOff style={iconScale(iconSize)} />
      )}
    </Button>
  );

  return withButtonTooltip(button, tooltip, portalContainer);
}

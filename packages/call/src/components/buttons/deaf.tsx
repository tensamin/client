import { Button } from "@nonanium/ui";
import { HeadphoneOff, Headphones } from "lucide-react";
import { useCall, useCallActions } from "../../store";
import {
  type CallButtonProps,
  iconScale,
  withButtonTooltip,
} from "./tooltipButton";

export default function DeafButton({
  className,
  iconSize,
  tooltip,
  portalContainer,
}: CallButtonProps) {
  const { toggleDeaf } = useCallActions();

  const deaf = useCall((state) => state.deaf);

  const button = (
    <Button
      variant={deaf ? "destructive" : "default"}
      onClick={toggleDeaf}
      className={className}
    >
      {deaf ? (
        <HeadphoneOff style={iconScale(iconSize)} />
      ) : (
        <Headphones style={iconScale(iconSize)} />
      )}
    </Button>
  );

  return withButtonTooltip(button, tooltip, portalContainer);
}

import { LeaveIcon } from "@livekit/components-react";
import { Button } from "@nonanium/ui";
import { leaveCall, useCall } from "../../store";
import { log, toast } from "@tensamin/shared/log";
import {
  type CallButtonProps,
  iconScale,
  withButtonTooltip,
} from "./tooltipButton";

export default function LeaveButton({
  className,
  iconSize,
  tooltip,
  portalContainer,
}: CallButtonProps) {
  const state = useCall((store) => store.state);

  const button = (
    <Button
      className={className}
      onClick={() => {
        void leaveCall().catch((error) => {
          toast(
            "error",
            "Leaving call failed",
            error instanceof Error ? error.message : String(error),
          );
          log(1, "call", "red", "Failed to revoke call membership", error);
        });
      }}
      disabled={state === "closing" || state === "closed"}
      variant="destructive"
    >
      <LeaveIcon style={iconScale(iconSize)} />
    </Button>
  );

  return withButtonTooltip(button, tooltip, portalContainer);
}

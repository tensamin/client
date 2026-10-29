import { Button } from "@nonanium/ui";
import { toast } from "@tensamin/shared/log";
import { Camera, CameraOff } from "lucide-react";
import { startCameraShare, stopCameraShare, useCall } from "../../store";
import {
  type CallButtonProps,
  iconScale,
  withButtonTooltip,
} from "./tooltipButton";

export default function CameraShareButton({
  className,
  iconSize,
  tooltip,
  portalContainer,
}: CallButtonProps) {
  const enabled = useCall((state) => state.cameraEnabled);

  const button = (
    <Button
      aria-label={enabled ? "Turn camera off" : "Turn camera on"}
      className={`${className ?? ""} motion-safe:transition-colors motion-safe:duration-200`}
      variant={enabled ? "default" : "secondary"}
      onClick={() => {
        void (enabled ? stopCameraShare() : startCameraShare()).catch(
          (error) => {
            console.error("Failed to toggle camera sharing", error);
            toast("error", "Failed to toggle camera sharing.");
          },
        );
      }}
    >
      {enabled ? (
        <CameraOff style={iconScale(iconSize)} />
      ) : (
        <Camera style={iconScale(iconSize)} />
      )}
    </Button>
  );

  return withButtonTooltip(button, tooltip, portalContainer);
}

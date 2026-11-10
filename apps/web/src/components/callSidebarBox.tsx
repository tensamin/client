import { useCall } from "@tensamin/call/state";
import SidebarBox from "@tensamin/call/sidebarBox";
import { useLocation } from "@tanstack/react-router";

export default function CallSidebarBox() {
  const onCallPage = useLocation({
    select: (location) => location.pathname === "/call",
  });
  const active = useCall(
    (state) => state.state !== "closed" && state.state !== "encrypting",
  );

  return active && !onCallPage ? <SidebarBox /> : null;
}

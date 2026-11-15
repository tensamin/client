import SidebarBox from "@tensamin/call/sidebarBox";
import {
CallProvider,
useCall,
useOptionalCallSession,
} from "@tensamin/call/store";

export default function CallSidebarBox() {
  const call = useOptionalCallSession();
  const active = useCall(
    (state) => state.state !== "closed" && state.state !== "encrypting",
  );

  return active && call ? (
    <CallProvider call={call}>
      <SidebarBox />
    </CallProvider>
  ) : null;
}

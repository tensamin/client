import Popout from "@tensamin/call/popout";
import {
CallProvider,
useCall,
useOptionalCallSession,
} from "@tensamin/call/store";

export default function CallPopout() {
  const call = useOptionalCallSession();
  const active = useCall((state) => state.state !== "closed");

  return active && call ? (
    <CallProvider call={call}>
      <Popout />
    </CallProvider>
  ) : null;
}

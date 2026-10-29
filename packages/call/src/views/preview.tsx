import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, ErrorScreen } from "@nonanium/ui";
import { useNavbar } from "@tensamin/shared/navbar";
import { requestJoinCall, useCall } from "../store";
import type { CurrentCallData } from "../state";
import OptionalPixelBlast from "@tensamin/shared/pixelBlast";
import { PreviewParticipant } from "../components/participantCard";
import { calculateOptimalGridLayout } from "./main/grid";
import { displayCallId } from "../utils";

const STATUS_MESSAGES: Record<CurrentCallData["status"], string | null> = {
  loading: null,
  ready: null,
  "not-found": "Call expired",
  forbidden: "You do not have access to this call",
  error: "Unable to load call",
};

export function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [
    days && `${days}d`,
    hours && `${hours}h`,
    minutes && `${minutes}m`,
    seconds % 60 && `${seconds % 60}s`,
  ]
    .filter(Boolean)
    .join(" ");
}

export default function Preview() {
  const { render } = useNavbar();
  const currentCallData = useCall((state) => state.currentCallData);
  const callId = useCall((state) => state.callId);
  const ownerOmikronId = useCall((state) => state.callRoute?.ownerOmikronId);
  const callState = useCall((state) => state.state);
  const [now, setNow] = useState(0);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useLayoutEffect(() => {
    const element = gridRef.current;
    if (!element) return;
    const syncSize = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize({ width, height });
    };
    syncSize();
    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [currentCallData?.status]);

  const count =
    currentCallData?.status === "ready" ? currentCallData.userIds.length : 0;
  const layout = calculateOptimalGridLayout(size.width, size.height, count, 8);
  let index = 0;
  const rows = layout.rowCounts.map((rowCount) =>
    Array.from({ length: rowCount }, () => index++),
  );
  const message =
    currentCallData?.status === "error"
      ? currentCallData.message
      : currentCallData
        ? STATUS_MESSAGES[currentCallData.status]
        : null;

  if (!callId) {
    return (
      <ErrorScreen
        error="No call selected"
        description="Open a conversation to start or join a call."
        icon={null}
        footer={false}
        fullScreen={false}
        statusLink={false}
      />
    );
  }

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden p-6">
      <div
        data-call-preview-background
        className="absolute w-full h-full opacity-50"
        style={{ viewTransitionName: "call-preview-background" }}
      >
        <OptionalPixelBlast />
      </div>
      {currentCallData?.status === "ready" ? (
        <>
          {render(
            <div className="flex w-full items-center px-3 text-sm justify-between md:px-6">
              <p className="invisible md:visible">
                {displayCallId(callId)}
              </p>
              <p>
                {formatDuration(Math.max(0, now - currentCallData.createdAt))}
              </p>
            </div>,
          )}
          <div className="relative flex h-[min(65vh,440px)] w-[min(100%,1240px)] flex-col items-center justify-center gap-8 p-8 sm:p-12">
            <div ref={gridRef} className="min-h-0 w-full flex-1">
              <div className="flex h-full flex-col items-center justify-center gap-5">
                {rows.map((row, rowIndex) => (
                  <div key={rowIndex} className="flex justify-center gap-5">
                    {row.map((userIndex) => (
                      <div
                        key={currentCallData.userIds[userIndex]}
                        style={{
                          width: Math.min(layout.tileWidth, 240 * 4),
                          height: Math.min(layout.tileHeight, 135 * 4),
                          viewTransitionName: `call-user-${currentCallData.userIds[userIndex]}`,
                        }}
                      >
                        <PreviewParticipant
                          userId={currentCallData.userIds[userIndex]}
                        />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <Button
              size="lg"
              style={{ viewTransitionName: "call-join-button" }}
              className="h-12 w-auto shrink-0 px-12 text-lg hover:bg-[color-mix(in_srgb,var(--primary)_85%,black)]! disabled:bg-[color-mix(in_srgb,var(--primary)_75%,black)]! disabled:opacity-100!"
              disabled={
                currentCallData.userIds.length === 0 ||
                joining ||
                callState !== "closed"
              }
              onClick={() => {
                if (callState !== "closed") return;
                setJoining(true);
                setJoinError(null);
                void Promise.resolve(
                  requestJoinCall(
                    currentCallData.userIds[0],
                    currentCallData.callSecret,
                    callId,
                    false,
                    ownerOmikronId,
                  ),
                )
                  .catch((error) => {
                    setJoinError(
                      error instanceof Error
                        ? error.message
                        : "Unable to join call",
                    );
                  })
                  .finally(() => setJoining(false));
              }}
            >
              {joining ? "Joining..." : "Join call"}
            </Button>
            {joinError && (
              <p role="alert" className="text-sm text-destructive">
                {joinError}
              </p>
            )}
          </div>
        </>
      ) : message ? (
        <ErrorScreen
          error={
            currentCallData?.status === "error"
              ? "Unable to load call"
              : message
          }
          description={
            currentCallData?.status === "error"
              ? currentCallData.message
              : undefined
          }
          fullScreen={false}
          statusLink={false}
          className="relative rounded-xl bg-card/90"
        />
      ) : null}
    </div>
  );
}

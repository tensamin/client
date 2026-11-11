import { Lock, LockOpen, Timer } from "lucide-react";
import { openCallPage, useCall, getRoom } from "../store";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useIsMobile,
} from "@nonanium/ui";
import MediaShareButton from "./buttons/mediaShare";
import MuteButton from "./buttons/mute";
import DeafButton from "./buttons/deaf";
import { Room, Track } from "livekit-client";
import { useEffect, useState } from "react";
import { AreaChart, Area } from "recharts";
import LeaveButton from "./buttons/leave";
import { formatDuration } from "../views/preview";

async function getPing(room: Room): Promise<number | undefined> {
  const report = await room.localParticipant
    .getTrackPublication(Track.Source.Microphone)
    ?.track?.getRTCStatsReport();

  if (!report) return;

  let bestRtt: number | undefined;

  report.forEach((stat) => {
    if (
      stat.type === "candidate-pair" &&
      stat.state === "succeeded" &&
      stat.currentRoundTripTime != null
    ) {
      bestRtt = stat.currentRoundTripTime * 1000;
    }

    if (stat.type === "remote-inbound-rtp" && stat.roundTripTime != null) {
      bestRtt = stat.roundTripTime * 1000;
    }
  });

  if (bestRtt == null || bestRtt <= 0) return;

  const roundedRtt = Math.round(bestRtt);

  if (roundedRtt <= 0) return;

  return roundedRtt;
}

function ConnectionBar() {
  const state = useCall((store) => store.state);
  const isEncrypted = useCall((store) => store.isEncrypted);
  const callId = useCall((store) => store.callId);
  const warnings = useCall((store) => store.warnings);
  const createdAt = useCall((store) => store.callCreatedAt);
  const [now, setNow] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);

    return () => window.clearInterval(timer);
  }, []);
  const age = createdAt == null || !now ? null : now - createdAt;
  const isConnecting = state === "encrypting" || state === "connecting";

  return (
    <Tooltip>
      <TooltipTrigger
        render={({ ref, onClick }) => (
          <Button
            ref={ref as React.Ref<HTMLButtonElement>}
            onClick={(event) => {
              onClick?.(event);
              openCallPage(callId || "");
            }}
            size="lg"
            variant={
              isConnecting ||
              warnings.length > 0 ||
              (age != null && age >= 2 * 86400000)
                ? "warning"
                : "default"
            }
            className="flex items-center justify-between px-2! group/connection-bar"
          >
            <div className="w-21 truncate flex justify-center text-center">
              {state === "encrypting" && "Encrypting..."}
              {state === "connecting" && "Connecting..."}
              {state === "open" && (
                <>
                  {formatDuration(age || 0).trim() != "" ? (
                    <>
                      <div className="flex gap-1 items-center group-hover/connection-bar:hidden">
                        <Timer className="size-3.5" />
                        <code className="text-xs">
                          {formatDuration(age || 0)}
                        </code>
                      </div>
                      <p className="hidden group-hover/connection-bar:block">
                        Connected
                      </p>
                    </>
                  ) : (
                    <p>Connected</p>
                  )}
                </>
              )}
              {state === "closed" && "Closed"}
              {state === "closing" && "Closing"}
            </div>

            <TinyPingGraph />

            {isEncrypted ? (
              <Lock color="currentColor" />
            ) : (
              <LockOpen color="currentColor" />
            )}
          </Button>
        )}
      />
      <TooltipContent className="flex flex-col gap-3 items-start">
        <p>Click to open call page</p>
        {age != null && age >= 2 * 86400000 && (
          <p>Calls expire after three days.</p>
        )}
        {warnings.map((warning, index) => (
          <p key={index}>{warning}</p>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

export function TinyPingGraph() {
  const room = getRoom();

  const [mapData, setMapData] = useState<Map<number, number>>(() => new Map());

  const data = Array.from(mapData, ([time, ping]) => ({ time, ping }));

  useEffect(() => {
    const interval = setInterval(async () => {
      const now = Date.now();
      const ping = await getPing(room);
      const cutoff = now - 10_000;

      setMapData((prev) => {
        const next = new Map(prev);

        if (ping != null && ping > 0) {
          next.set(now, ping);
        }

        for (const time of next.keys()) {
          if (time < cutoff) next.delete(time);
        }

        return next;
      });
    }, 2_000);

    return () => clearInterval(interval);
  }, [room]);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className="h-6 w-24 min-w-0 shrink-0"
            style={{
              WebkitMaskImage:
                "linear-gradient(to right, transparent 0%, var(--primary) 15%, var(--primary) 85%, transparent 100%)",
              maskImage:
                "linear-gradient(to right, transparent 0%, var(--primary) 15%, var(--primary) 85%, transparent 100%)",
            }}
          >
            {data.length > 1 && (
              <AreaChart
                width={96}
                height={24}
                data={data}
                margin={{ top: 2, right: 0, bottom: 2, left: 0 }}
              >
                <defs>
                  <linearGradient id="pingGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor="currentColor"
                      stopOpacity={0.35}
                    />
                    <stop
                      offset="70%"
                      stopColor="currentColor"
                      stopOpacity={0.08}
                    />
                    <stop
                      offset="100%"
                      stopColor="currentColor"
                      stopOpacity={0}
                    />
                  </linearGradient>
                </defs>

                <Area
                  type="monotone"
                  dataKey="ping"
                  stroke="currentColor"
                  strokeWidth={2}
                  fill="url(#pingGradient)"
                  fillOpacity={1}
                  dot={false}
                  activeDot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            )}
          </div>
        }
      />
      <TooltipContent>
        {data.length > 0 ? `${data.at(-1)?.ping} ms` : "Measuring ping..."}
      </TooltipContent>
    </Tooltip>
  );
}

export default function SidebarBox() {
  const state = useCall((store) => store.state);
  const isMobile = useIsMobile();

  return state === "closed" || state === "encrypting" ? null : (
    <Card className="p-1.5 gap-2" hidden={isMobile}>
      <CardHeader className="p-0! pb-2! border-b-2">
        <ConnectionBar />
      </CardHeader>
      <CardContent className="p-0! flex flex-col gap-1">
        <div className="flex justify-center gap-1">
          <MuteButton className="h-9! w-[24%]" />
          <DeafButton className="h-9! w-[24%]" />
          <MediaShareButton className="h-9! w-[24%]!" defaultPortal />
          <LeaveButton className="h-9! w-[24%]" />
        </div>
      </CardContent>
    </Card>
  );
}

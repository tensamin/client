import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useIsMobile,
} from "@nonanium/ui";
import { useUserFields } from "@tensamin/identity/context";
import { useNavbar } from "@tensamin/shared/navbar";
import { RoomEvent } from "livekit-client";
import z from "zod";
import {
  getAllParticipants,
  getParticipantId,
  getRoom,
  setCallIsFullscreen,
  setCallIsPopout,
  triggerCallLayoutCalculation,
  useCall,
} from "./store";
import { useRecentSpeakerIds } from "./speakingState";

import MainLayout from "./views/main/layout";
import MainGrid from "./views/main/grid";
import MainFocused from "./views/main/focused";
import Preview from "./views/preview";

const participantIdSchema = z.number().int().positive();
const watchedScreenShareParticipantIdsSchema = z.array(z.unknown());
const USER_FIELDS = ["Avatar", "Display"] as const;

function ScreenShareViewer({ participantId }: { participantId: number }) {
  const { data: user } = useUserFields(participantId, USER_FIELDS);
  const display = user?.Display || String(participantId);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Avatar className="size-7">
            <AvatarImage src={user?.Avatar} alt={display} />
            <AvatarFallback className="text-xs">
              {display.slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        }
      />
      <TooltipContent>{display}</TooltipContent>
    </Tooltip>
  );
}

function parseWatchedScreenShareParticipantIds(value: string | undefined) {
  if (!value) return [];

  try {
    const parsed = watchedScreenShareParticipantIdsSchema.safeParse(
      JSON.parse(value),
    );

    if (!parsed.success) return [];

    return [
      ...new Set(
        parsed.data.flatMap((value) => {
          const participantId = participantIdSchema.safeParse(value);

          return participantId.success ? [participantId.data] : [];
        }),
      ),
    ];
  } catch {
    return [];
  }
}

function ScreenShareViewers() {
  const isMobile = useIsMobile();
  const { render } = useNavbar();
  const recentSpeakerIds = useRecentSpeakerIds();
  const view = useCall((state) => state.view);
  const focusedParticipantId = useCall((state) => state.focusedParticipantId);
  const focusedParticipantType = useCall(
    (state) => state.focusedParticipantType,
  );
  const activeScreenShareParticipantIds = useCall(
    (state) => state.activeScreenShareParticipantIds,
  );
  const callIsPopout = useCall((state) => state.callIsPopout);
  const [, setParticipantVersion] = useState(0);

  useEffect(() => {
    const room = getRoom();
    const syncParticipants = () =>
      setParticipantVersion((version) => version + 1);
    room.on(RoomEvent.ParticipantConnected, syncParticipants);
    room.on(RoomEvent.ParticipantDisconnected, syncParticipants);
    room.on(RoomEvent.ParticipantAttributesChanged, syncParticipants);

    return () => {
      room.off(RoomEvent.ParticipantConnected, syncParticipants);
      room.off(RoomEvent.ParticipantDisconnected, syncParticipants);
      room.off(RoomEvent.ParticipantAttributesChanged, syncParticipants);
    };
  }, []);

  if (
    isMobile ||
    callIsPopout ||
    view !== "focused" ||
    focusedParticipantType !== "stream" ||
    focusedParticipantId == null ||
    !activeScreenShareParticipantIds.includes(focusedParticipantId)
  ) {
    return null;
  }

  const participants = getAllParticipants();
  const viewers = participants
    .map((participant, stableIndex) => ({
      participantId: getParticipantId(participant.identity),
      stableIndex,
      watchedParticipantIds: parseWatchedScreenShareParticipantIds(
        participant.attributes.watchedScreenShareParticipantIds,
      ),
    }))
    .filter(
      (
        participant,
      ): participant is typeof participant & { participantId: number } =>
        participant.participantId != null &&
        participant.participantId !== focusedParticipantId &&
        participant.watchedParticipantIds.includes(focusedParticipantId),
    );

  if (viewers.length === 0) return null;

  const recency = new Map(recentSpeakerIds.map((id, index) => [id, index]));
  viewers.sort((a, b) => {
    const aRecency = recency.get(a.participantId);
    const bRecency = recency.get(b.participantId);

    if (aRecency != null || bRecency != null) {
      if (aRecency == null) return 1;

      if (bRecency == null) return -1;

      return aRecency - bRecency;
    }

    return a.stableIndex - b.stableIndex;
  });

  const visibleViewers = viewers.slice(0, 8);
  const overflow = viewers.length - visibleViewers.length;

  return render(
    <div className="flex items-center pl-2">
      {visibleViewers.map(({ participantId }, index) => (
        <div
          key={participantId}
          className={index === visibleViewers.length - 1 ? "w-7" : "w-5"}
        >
          <ScreenShareViewer participantId={participantId} />
        </div>
      ))}
      {overflow > 0 && (
        <div className="flex size-8 items-center justify-center rounded-full text-xs font-medium">
          +{overflow}
        </div>
      )}
    </div>,
  );
}

function ScreenContent() {
  const view = useCall((state) => state.view);

  return (
    <div
      data-call-screen
      className="h-full w-full"
      style={{ viewTransitionName: "call-screen" }}
    >
      {view === "preview" ? (
        <Preview />
      ) : (
        <MainLayout>
          {view === "grid" ? <MainGrid /> : <MainFocused />}
        </MainLayout>
      )}
    </div>
  );
}

// Popout Window
function copyDocumentStyles(targetDocument: Document) {
  for (const node of document.querySelectorAll(
    'link[rel="stylesheet"], style',
  )) {
    targetDocument.head.appendChild(node.cloneNode(true));
  }
}

function syncDocumentAttributes(targetDocument: Document) {
  for (const attribute of document.documentElement.attributes) {
    targetDocument.documentElement.setAttribute(
      attribute.name,
      attribute.value,
    );
  }

  targetDocument.body.className = document.body.className;
}

function PopoutScreen() {
  const closeCheckRef = useRef<number | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    const popoutWindow = window.open(
      "",
      "tensamin-call-popout",
      "popup,width=1280,height=720",
    );

    if (!popoutWindow) {
      setCallIsFullscreen(false);
      setCallIsPopout(false);

      return;
    }

    let isMounted = true;

    popoutWindow.document.title = document.title;
    popoutWindow.document.body.innerHTML = "";
    popoutWindow.document.body.style.margin = "0";
    copyDocumentStyles(popoutWindow.document);
    syncDocumentAttributes(popoutWindow.document);

    popoutWindow.document.documentElement.style.height = "100%";
    popoutWindow.document.body.style.height = "100%";

    const containerElement = popoutWindow.document.createElement("div");
    containerElement.style.width = "100%";
    containerElement.style.height = "100%";
    popoutWindow.document.body.appendChild(containerElement);
    queueMicrotask(() => {
      if (isMounted) {
        setContainer(containerElement);
      }
    });

    const closePopout = () => {
      setCallIsFullscreen(false);
      setCallIsPopout(false);
    };

    const syncLayout = () => triggerCallLayoutCalculation();

    popoutWindow.addEventListener("beforeunload", closePopout);
    popoutWindow.addEventListener("resize", syncLayout);
    popoutWindow.focus();

    closeCheckRef.current = window.setInterval(() => {
      if (popoutWindow.closed) {
        closePopout();
      }
    }, 500);

    triggerCallLayoutCalculation();

    return () => {
      isMounted = false;
      popoutWindow.removeEventListener("beforeunload", closePopout);
      popoutWindow.removeEventListener("resize", syncLayout);

      if (closeCheckRef.current) {
        window.clearInterval(closeCheckRef.current);
        closeCheckRef.current = null;
      }

      if (!popoutWindow.closed) {
        popoutWindow.close();
      }

      setCallIsFullscreen(false);
      triggerCallLayoutCalculation();
    };
  }, []);

  if (!container) {
    return null;
  }

  return createPortal(<ScreenContent />, container);
}

export default function Screen() {
  const callIsPopout = useCall((state) => state.callIsPopout);
  const view = useCall((state) => state.view);
  const { setTopPadding } = useNavbar();

  useLayoutEffect(() => {
    setTopPadding(view !== "preview");

    return () => setTopPadding(null);
  }, [setTopPadding, view]);

  return (
    <>
      <ScreenShareViewers />
      {callIsPopout ? (
        <div className="flex justify-center items-center h-full w-full">
          <p>The window is popped out.</p>
          <PopoutScreen />
        </div>
      ) : (
        <ScreenContent />
      )}
    </>
  );
}

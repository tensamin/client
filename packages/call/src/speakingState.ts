import { useStore } from "zustand";
import { useOptionalCallSession } from "./context";
import { createSpeakingState } from "./speakingStore";

const idleSpeaking = createSpeakingState();

export function useRecentSpeakerIds(): number[] {
  return useStore(
    useOptionalCallSession()?.speaking.store ?? idleSpeaking.store,
    (state) => state.recentSpeakerIds,
  );
}

export function useLastSpeakingParticipantId(): number | null {
  return useStore(
    useOptionalCallSession()?.speaking.store ?? idleSpeaking.store,
    (state) => state.lastSpeakingParticipantId,
  );
}

export function useIsSpeaking(participantId: number): boolean {
  return useStore(
    useOptionalCallSession()?.speaking.store ?? idleSpeaking.store,
    (state) => state.speakingParticipantIds.has(participantId),
  );
}

import type { createSpeakingState } from "./speakingStore";
const SPEAKING_THRESHOLD = 0.01;
const SPEAKING_HANGTIME_MS = 500;
const ANALYSIS_INTERVAL_MS = 30;
const FFT_SIZE = 256;

export class SpeakingDetector {
  private speaking: ReturnType<typeof createSpeakingState>;

  constructor(speaking: ReturnType<typeof createSpeakingState>) {
    this.speaking = speaking;
  }
  private audioContext: AudioContext | null = null;
  private entries = new Map<
    number,
    {
      source: MediaStreamAudioSourceNode;
      analyser: AnalyserNode;
      track: MediaStreamTrack;
      originalTrack?: MediaStreamTrack;
      lastSpeakingTime: number;
      isSpeaking: boolean;
    }
  >();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private deaf = false;
  private gateThresholdStart = -50;
  private gateThresholdEnd = -40;
  private gateEnabled = true;
  private localParticipantId: number | null = null;
  private localMicGateClosed = false;

  private ensureAudioContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    if (this.audioContext.state === "suspended") {
      void this.audioContext.resume();
    }
    return this.audioContext;
  }

  setLocalParticipantId(id: number) {
    this.localParticipantId = id;
  }

  setGateThresholds(start: number, end: number) {
    this.gateThresholdStart = start;
    this.gateThresholdEnd = end;
  }

  setGateEnabled(enabled: boolean) {
    this.gateEnabled = enabled;
    if (!enabled && this.localMicGateClosed) this.muteLocalTrack(false);
  }

  addTrack(
    participantId: number,
    track: MediaStreamTrack,
    originalTrack?: MediaStreamTrack,
  ) {
    if (track.kind !== "audio") return;

    this.removeParticipant(participantId);

    const ctx = this.ensureAudioContext();
    const stream = new MediaStream([track]);
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    source.connect(analyser);

    this.entries.set(participantId, {
      source,
      analyser,
      track,
      originalTrack,
      lastSpeakingTime: 0,
      isSpeaking: false,
    });

    if (!this.intervalId) {
      this.startLoop();
    }
  }

  removeParticipant(participantId: number) {
    const entry = this.entries.get(participantId);
    if (!entry) return;

    try {
      entry.source.disconnect();
    } catch {
      // ignore
    }
    if (entry.originalTrack) {
      entry.track.stop();
    }
    this.entries.delete(participantId);

    this.speaking.removeSpeakingParticipant(participantId);

    if (participantId === this.localParticipantId && this.localMicGateClosed) {
      this.muteLocalTrack(false);
    }
  }

  setDeaf(deaf: boolean) {
    this.deaf = deaf;
    if (deaf) {
      for (const entry of this.entries.values()) {
        entry.isSpeaking = false;
        entry.lastSpeakingTime = 0;
      }
      this.speaking.clearSpeakingParticipants();
    }
  }

  private startLoop() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.analyse(), ANALYSIS_INTERVAL_MS);
  }

  private stopLoop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private muteLocalTrack(muted: boolean) {
    const entry = this.localParticipantId
      ? this.entries.get(this.localParticipantId)
      : undefined;
    const target = entry?.originalTrack ?? entry?.track;

    if (target && target.enabled === muted) {
      target.enabled = !muted;
    }

    this.localMicGateClosed = muted;
    this.speaking.setMicGated(muted);
  }

  private applyNoiseGate(rms: number) {
    const db = 20 * Math.log10(Math.max(rms, 0.0001));

    if (!this.localMicGateClosed && db < this.gateThresholdStart) {
      this.muteLocalTrack(true);
    } else if (this.localMicGateClosed && db > this.gateThresholdEnd) {
      this.muteLocalTrack(false);
    }
  }

  private analyse() {
    if (this.deaf || this.entries.size === 0) return;

    const now = Date.now();
    const changed = new Map<number, boolean>();

    for (const [participantId, entry] of this.entries) {
      const { analyser, track } = entry;

      if (track.muted || track.readyState === "ended" || !track.enabled) {
        if (entry.isSpeaking) {
          entry.isSpeaking = false;
          entry.lastSpeakingTime = 0;
          changed.set(participantId, false);
        }
        continue;
      }

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      analyser.getByteTimeDomainData(dataArray);

      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        const sample = (dataArray[i] - 128) / 128.0;
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / bufferLength);

      let nextIsSpeaking = entry.isSpeaking;
      if (rms > SPEAKING_THRESHOLD) {
        entry.lastSpeakingTime = now;
        nextIsSpeaking = true;
      } else if (now - entry.lastSpeakingTime > SPEAKING_HANGTIME_MS) {
        nextIsSpeaking = false;
      }

      if (participantId === this.localParticipantId && this.gateEnabled) {
        this.applyNoiseGate(rms);
        if (this.localMicGateClosed) {
          nextIsSpeaking = false;
        }
      }

      if (nextIsSpeaking !== entry.isSpeaking) {
        entry.isSpeaking = nextIsSpeaking;
        changed.set(participantId, nextIsSpeaking);
      }
    }

    if (changed.size > 0) {
      this.speaking.updateSpeakingParticipants(changed);
    }
  }

  dispose() {
    this.stopLoop();
    for (const id of Array.from(this.entries.keys())) {
      this.removeParticipant(id);
    }
    this.entries.clear();
    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
    this.speaking.clearSpeakingParticipants(true);
  }
}

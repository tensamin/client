import type { BoundSendFn } from "@tensamin/mtp";
import type { Calls, Storage } from "@tensamin/shared/data";
import type { RefObject } from "react";
import { createStore } from "zustand/vanilla";

import type { LocalMediaShareSession } from "./mediaShare/controller";

export type CallView = "preview" | "focused" | "grid";

export type WrappedCallSecret = {
  secretId: string;
  versionNumber: number;
  encryptedSecret: Uint8Array;
  kemCiphertext: Uint8Array;
  wrappingScheme: string;
};

export type CallRoute = {
  ownerOmikronId: number;
  livekitUrl: string | null;
};

export type CurrentCallData =
  | { status: "loading" }
  | {
      status: "ready";
      userIds: number[];
      createdAt: number;
      callSecret: WrappedCallSecret;
    }
  | { status: "not-found" }
  | { status: "forbidden" }
  | { status: "error"; message: string };

export type CallControlTransport = {
  request: (
    ownerOmikronId: number | undefined,
    ...args: Parameters<BoundSendFn>
  ) => ReturnType<BoundSendFn>;
};

export type CallRuntime = {
  accountKey: string | undefined;
  navigate: (options: {
    to: string;
    search?: Record<string, unknown>;
  }) => Promise<void>;
  callControl: CallControlTransport;
  load: <K extends keyof Storage>(key: K) => Promise<Storage[K]>;
  save: <K extends keyof Storage>(key: K, value: Storage[K]) => Promise<void>;
  subscribeStorage: (
    handler: (keys: (keyof Storage)[], bulk: boolean) => void,
  ) => () => void;
  getPublicKey: (userId: number) => Promise<string>;
  upsertCall: (call: Calls[number]) => void;
  removeCall: (callId: string) => void;
  dismissCallInvite: (callId: string) => Promise<void>;
  isCallInviteHandled: (callId: string) => Promise<boolean>;
};

export type CallState = {
  state: "closed" | "closing" | "connecting" | "open" | "encrypting";
  view: CallView;
  invitedUserId: number | null;
  callId: string | null;
  callCreatedAt: number | null;
  callRoute: CallRoute | null;
  callSecret: string | null;
  livekitToken: string | null;
  currentCallData: CurrentCallData | null;
  deaf: boolean;
  micEnabled: boolean;
  cameraEnabled: boolean;
  screenShareEnabled: boolean;
  screenShareSession: LocalMediaShareSession | null;
  cameraSession: LocalMediaShareSession | null;
  disabledCameraParticipantIds: number[];
  focusedParticipantId: number | null;
  focusedParticipantType: "user" | "stream" | null;
  usersInFocusedViewHidden: boolean;
  watchedStreamParticipantIds: number[];
  pendingWatchedParticipantIds: number[];
  activeScreenShareParticipantIds: number[];
  activeScreenShareAudioParticipantIds: number[];
  isEncrypted: boolean;
  warnings: string[];
  screenShareExpectedCodec: string | null;
  screenShareActiveCodec: string | null;
  callIsFullscreen: boolean;
  callIsPopout: boolean;
  layoutVersion: number;
  screenRef: RefObject<HTMLDivElement | null> | null;
  runtime: CallRuntime | null;
  lastFocusedParticipantId: number | null;
};

export const initialCallState = (): CallState => ({
  state: "closed",
  view: "preview",
  invitedUserId: null,
  callId: null,
  callCreatedAt: null,
  callRoute: null,
  callSecret: null,
  livekitToken: null,
  currentCallData: null,
  deaf: false,
  micEnabled: false,
  cameraEnabled: false,
  screenShareEnabled: false,
  screenShareSession: null,
  cameraSession: null,
  disabledCameraParticipantIds: [],
  focusedParticipantId: null,
  focusedParticipantType: null,
  usersInFocusedViewHidden: false,
  watchedStreamParticipantIds: [],
  pendingWatchedParticipantIds: [],
  activeScreenShareParticipantIds: [],
  activeScreenShareAudioParticipantIds: [],
  isEncrypted: false,
  warnings: [],
  screenShareExpectedCodec: null,
  screenShareActiveCodec: null,
  callIsFullscreen: false,
  callIsPopout: false,
  layoutVersion: 0,
  screenRef: null,
  runtime: null,
  lastFocusedParticipantId: null,
});

export function createCallStore(runtime: CallRuntime) {
  return createStore<CallState>(() => ({ ...initialCallState(), runtime }));
}

export type CallManagementState = {
  incomingCallInvite: {
    callId: string;
    callSecret: WrappedCallSecret;
    senderId: number;
    ownerOmikronId: number;
  } | null;
  pendingCallSwitch: {
    userId: number;
    callSecret?: WrappedCallSecret;
    callId?: string;
    sendInvite: boolean;
    ownerOmikronId?: number;
  } | null;
};

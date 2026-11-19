import { mtp } from "@tensamin/shared/data";
import { log } from "@tensamin/shared/log";
import { playSound, stopSound } from "@tensamin/shared/sounds";
import { create } from "zustand";
import { createCallSession, type CallSession } from "./session/instance";
import {
  normalizeWrappedCallSecret,
  requireRuntime,
  type ProtocolCallSecret,
  type ProtocolCallSecretResponse,
} from "./session/shared";
import {
  initialCallState,
  type CallManagementState,
  type CallRuntime as Runtime,
  type WrappedCallSecret,
} from "./state";
export const management = create<{
  runtime: Runtime | null;
  sessions: CallSession[];
  selected: CallSession | null;
  incomingCallInvite: CallManagementState["incomingCallInvite"];
  pendingCallSwitch: CallManagementState["pendingCallSwitch"];
}>(() => ({
  runtime: null,
  sessions: [],
  selected: null,
  incomingCallInvite: null,
  pendingCallSwitch: null,
}));
export function selectedCall() {
  return management.getState().selected;
}
export function createManagedCall() {
  const call = createCallSession(requireRuntime(management.getState().runtime));
  management.setState((s) => ({
    sessions: [...s.sessions, call],
    selected: call,
  }));
  call.store.subscribe((state, previous) => {
    if (state.state === "closed" && previous.state !== "closed") {
      queueMicrotask(() => void releaseCall(call));
    }
  });
  return call;
}
export async function releaseCall(call: CallSession) {
  if (!management.getState().sessions.includes(call)) return;
  management.setState((s) => ({
    sessions: s.sessions.filter((c) => c !== call),
    selected: s.selected === call ? null : s.selected,
  }));
  await call.disposeCallRuntime();
}
export function setCallRuntime(runtime: Runtime) {
  const previous = management.getState().runtime;
  if (previous?.accountKey !== runtime.accountKey) {
    joining = null;
    handledCallInvites.clear();
    stopCallJingle();
    management.setState({ incomingCallInvite: null, pendingCallSwitch: null });
    for (const call of management.getState().sessions) void releaseCall(call);
  }
  management.setState({ runtime });
  for (const call of management.getState().sessions)
    call.store.setState({ runtime });
}
let joining: symbol | null = null;
async function joinManagedCall(...args: Parameters<CallSession["joinCall"]>) {
  if (joining) return;
  const attempt = Symbol();
  joining = attempt;
  let call = selectedCall();
  try {
    if (call && args[2] && call.store.getState().callId === args[2]) {
      if (call.store.getState().state !== "closed")
        return await call.openCallPage(args[2]);
    } else {
      if (call) {
        if (call.store.getState().state !== "closed") {
          try {
            await call.leaveCall();
          } catch (error) {
            log(
              1,
              "call",
              "red",
              "Failed to revoke old call membership",
              error,
            );
          }
        }
        await releaseCall(call);
      }
      if (joining !== attempt) return;
      call = createManagedCall();
    }
    await call.joinCall(...args);
  } catch (error) {
    if (call) await releaseCall(call);
    throw error;
  } finally {
    if (joining === attempt) joining = null;
  }
}
let callJingle: HTMLAudioElement | null = null;
let callJingleGeneration = 0;
async function startCallJingle(shouldPlay: () => boolean) {
  const generation = ++callJingleGeneration;
  stopSound(callJingle);
  callJingle = null;

  const runtime = requireRuntime(management.getState().runtime);
  const [jingle, volume] = await Promise.all([
    runtime.load("settings.call_jingle"),
    runtime.load("call_sound_volume"),
  ]);

  if (generation !== callJingleGeneration || !shouldPlay()) {
    return;
  }

  callJingle = playSound(
    jingle === "jingle_2" ? "call_jingle_2" : "call_jingle_1",
    true,
    volume / 100,
  );
}

export function stopCallJingle() {
  callJingleGeneration += 1;
  stopSound(callJingle);
  callJingle = null;
}

// Ask before replacing a different call, regardless of where the join originated.
export function requestJoinCall(
  userId: number,
  callSecret?:
    WrappedCallSecret | ProtocolCallSecret | ProtocolCallSecretResponse,
  existingCallId?: string,
  sendInvite = true,
  ownerOmikronId?: number,
) {
  const active = selectedCall()?.store.getState() ?? initialCallState();

  if (
    active.state === "closing" ||
    active.state === "connecting" ||
    active.state === "encrypting"
  )
    return;

  if (active.state !== "closed" && active.callId !== existingCallId) {
    management.setState({
      pendingCallSwitch: {
        userId,
        callSecret: callSecret
          ? normalizeWrappedCallSecret(callSecret)
          : undefined,
        callId: existingCallId,
        sendInvite,
        ownerOmikronId,
      },
    });

    return;
  }

  return joinManagedCall(
    userId,
    callSecret,
    existingCallId,
    sendInvite,
    ownerOmikronId,
  );
}

export function respondToCallSwitch(confirmed: boolean) {
  const pending = management.getState().pendingCallSwitch;
  management.setState({ pendingCallSwitch: null });

  if (confirmed && pending) {
    return joinManagedCall(
      pending.userId,
      pending.callSecret,
      pending.callId,
      pending.sendInvite,
      pending.ownerOmikronId,
    );
  }
}

const handledCallInvites = new Set<string>();

export async function receiveCallInvite(data: unknown, ownUserId: number) {
  const parsed = mtp.CallInvite.response.parse(data);
  const { CallId, CallSecret, SenderId, OmikronId } = parsed;

  if (!CallId || !CallSecret || !SenderId || OmikronId == null) {
    return;
  }

  if (SenderId === ownUserId) {
    return;
  }

  if (handledCallInvites.has(CallId)) return;
  const runtime = requireRuntime(management.getState().runtime);
  const handled = await runtime.isCallInviteHandled(CallId);

  if (
    handled ||
    handledCallInvites.has(CallId) ||
    management.getState().runtime?.accountKey !== runtime.accountKey
  )
    return;

  if (
    management
      .getState()
      .sessions.some(
        (call) =>
          call.store.getState().callId === CallId &&
          call.store.getState().state !== "closed",
      )
  ) {
    return;
  }

  management.setState({
    incomingCallInvite: {
      callId: CallId,
      callSecret: normalizeWrappedCallSecret(CallSecret),
      senderId: SenderId,
      ownerOmikronId: OmikronId,
    },
  });
  requireRuntime(management.getState().runtime).upsertCall({
    CallId,
    OmikronId,
    CallSecret,
    CallMembers: [SenderId],
    CallInvited: true,
    SenderId,
  });
  void startCallJingle(() => management.getState().incomingCallInvite != null);
}

export async function respondToCallInvite(accepted: boolean) {
  const invite = management.getState().incomingCallInvite;

  stopCallJingle();
  management.setState({ incomingCallInvite: null });

  if (!invite) {
    return;
  }

  const runtime = requireRuntime(management.getState().runtime);

  try {
    await runtime.dismissCallInvite(invite.callId);
  } catch (error) {
    if (
      management.getState().runtime?.accountKey === runtime.accountKey &&
      !management.getState().incomingCallInvite
    )
      management.setState({ incomingCallInvite: invite });

    throw error;
  }

  if (management.getState().runtime?.accountKey !== runtime.accountKey) return;

  if (!handledCallInvites.has(invite.callId)) {
    if (handledCallInvites.size === 128)
      handledCallInvites.delete(handledCallInvites.values().next().value!);
    handledCallInvites.add(invite.callId);
  }

  if (!accepted) {
    log(2, "call", "purple", "Declined call invite", {
      callId: invite.callId,
      senderId: invite.senderId,
    });

    return;
  }

  await requestJoinCall(
    invite.senderId,
    invite.callSecret,
    invite.callId,
    false,
    invite.ownerOmikronId,
  );
}

export async function refreshInviteSoundVolume() {
  if (!callJingle) return;
  const runtime = requireRuntime(management.getState().runtime);
  const volume = await runtime.load("call_sound_volume");
  if (callJingle && management.getState().runtime === runtime)
    callJingle.volume = volume / 100;
}

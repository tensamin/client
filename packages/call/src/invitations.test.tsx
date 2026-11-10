// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import InvitePopup from "./components/invitePopup";
import { storageDefaults } from "@tensamin/shared/data";
import { playSound } from "@tensamin/shared/sounds";
import {
  receiveCallInvite,
  respondToCallInvite,
  setCallRuntime,
  stopCallJingle,
} from "./callStore";
import { useCall, type CallRuntime } from "./state";

vi.mock("@tensamin/shared/log", () => ({ log: vi.fn(), toast: vi.fn() }));
vi.mock("@tensamin/identity/wrapper", () => ({
  default: ({
    component,
  }: {
    component: (user: { Avatar: string; Display: string }) => ReactNode;
  }) => component({ Avatar: "", Display: "Caller" }),
}));
vi.mock("@tensamin/shared/sounds", () => ({
  playSound: vi.fn(() => null),
  stopSound: vi.fn(),
}));
const dismiss = vi.fn<(id: string) => Promise<void>>();
const upsert = vi.fn();
const handled = vi.fn<(id: string) => Promise<boolean>>();
const runtime: CallRuntime = {
  accountKey: "invitation-account",
  navigate: async () => {},
  callControl: { request: vi.fn() },
  load: async (key) => storageDefaults[key],
  save: async () => {},
  subscribeStorage: () => () => {},
  getPublicKey: async () => "",
  upsertCall: upsert,
  removeCall: vi.fn(),
  dismissCallInvite: dismiss,
  isCallInviteHandled: handled,
};
const invitation = {
  CallId: "call-invite",
  SenderId: 2,
  OmikronId: 9,
  CallSecret: {
    SecretId: "secret",
    VersionNumber: 1,
    EncryptedSecret: new Uint8Array([1]),
    KemCiphertext: new Uint8Array([2]),
    WrappingScheme: "fixture",
  },
};
beforeEach(() => {
  useCall.setState({
    runtime: null,
    incomingCallInvite: null,
    state: "closed",
    callId: null,
  });
  dismiss.mockReset().mockResolvedValue(undefined);
  handled.mockReset().mockResolvedValue(false);
  upsert.mockClear();
  vi.mocked(playSound).mockClear();
  setCallRuntime(runtime);
});
afterEach(() => {
  stopCallJingle();
  useCall.setState({ runtime: null, incomingCallInvite: null });
});

it("does not ring a declined invitation again and scopes handled IDs to the account", async () => {
  await receiveCallInvite(invitation, 1);
  expect(useCall.getState().incomingCallInvite?.callId).toBe("call-invite");
  await respondToCallInvite(false);
  expect(dismiss).toHaveBeenCalledWith("call-invite");
  expect(useCall.getState().incomingCallInvite).toBeNull();
  const rings = vi.mocked(playSound).mock.calls.length;
  await receiveCallInvite(invitation, 1);
  expect(useCall.getState().incomingCallInvite).toBeNull();
  expect(upsert).toHaveBeenCalledTimes(1);
  expect(playSound).toHaveBeenCalledTimes(rings);
  setCallRuntime({ ...runtime, accountKey: "another-account" });
  await receiveCallInvite(invitation, 1);
  expect(useCall.getState().incomingCallInvite?.callId).toBe("call-invite");
});

it("marks an invitation handled when the shared dialog closes with Escape", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  function Dialog() {
    const invite = useCall((state) => state.incomingCallInvite);

    return invite ? (
      <InvitePopup
        open
        user={invite.senderId}
        onAccept={(accepted) => {
          void respondToCallInvite(accepted);
        }}
      />
    ) : null;
  }

  await receiveCallInvite(invitation, 1);
  const root = createRoot(document.createElement("div"));

  try {
    await act(async () => {
      root.render(<Dialog />);
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(dismiss).toHaveBeenCalledWith("call-invite");
    expect(useCall.getState().incomingCallInvite).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await receiveCallInvite(invitation, 1);
    expect(useCall.getState().incomingCallInvite).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("retains an invitation when recording its dismissal fails", async () => {
  await receiveCallInvite(invitation, 1);
  dismiss.mockRejectedValueOnce(new Error("native lifetime changed"));
  await expect(respondToCallInvite(false)).rejects.toThrow(
    "native lifetime changed",
  );
  expect(useCall.getState().incomingCallInvite?.callId).toBe("call-invite");
  await respondToCallInvite(false);
  expect(useCall.getState().incomingCallInvite).toBeNull();
});

it("claims the response before awaiting native dismissal", async () => {
  let finish!: () => void;
  dismiss.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await receiveCallInvite(invitation, 1);
  const first = respondToCallInvite(false);
  await respondToCallInvite(false);
  expect(dismiss).toHaveBeenCalledTimes(1);
  finish();
  await first;
  expect(useCall.getState().incomingCallInvite).toBeNull();
});

it("does not clear a new account invitation when an old dismissal completes", async () => {
  let finish!: () => void;
  dismiss.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await receiveCallInvite(invitation, 1);
  const first = respondToCallInvite(false);
  setCallRuntime({ ...runtime, accountKey: "replacement-account" });
  await receiveCallInvite({ ...invitation, CallId: "new-call" }, 1);
  finish();
  await first;
  expect(useCall.getState().incomingCallInvite?.callId).toBe("new-call");
});

it("checks native handled state after the renderer call runtime is recreated", async () => {
  useCall.setState({ runtime: null });
  setCallRuntime(runtime);
  handled.mockResolvedValueOnce(true);
  await receiveCallInvite(invitation, 1);
  expect(useCall.getState().incomingCallInvite).toBeNull();
  expect(upsert).not.toHaveBeenCalled();
  expect(playSound).not.toHaveBeenCalled();
});

it("does not publish an old account invitation after its handled-state lookup finishes", async () => {
  let finish!: (value: boolean) => void;
  handled.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  );
  const pending = receiveCallInvite(invitation, 1);
  setCallRuntime({ ...runtime, accountKey: "replacement-account" });
  finish(false);
  await pending;
  expect(useCall.getState().incomingCallInvite).toBeNull();
  expect(upsert).not.toHaveBeenCalled();
});

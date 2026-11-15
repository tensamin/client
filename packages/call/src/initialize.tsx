import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@nonanium/ui";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useUser } from "@tensamin/identity/context";
import { useSession } from "@tensamin/identity/session";
import { useMTP } from "@tensamin/mtp";
import { mtp } from "@tensamin/shared/data";
import { log, toast } from "@tensamin/shared/log";
import { useStorage } from "@tensamin/storage/context";
import { useCallback, useEffect, useRef } from "react";
import { useCallSession } from "./context";
import { stopCallJingle } from "./manager";

import InvitePopup from "./components/invitePopup";
import { CallProvider, useCall } from "./context";
import {
  createManagedCall,
  management,
  receiveCallInvite,
  refreshInviteSoundVolume,
  releaseCall,
  respondToCallInvite,
  respondToCallSwitch,
  selectedCall,
  setCallRuntime,
} from "./manager";

import { useCallRuntime } from "./runtime";
function CallRuntime({ navigateBack }: { navigateBack: () => void }) {
  const call = useCallSession();
  const back = useCallback(() => {
    if (selectedCall() === call) navigateBack();
  }, [call, navigateBack]);
  useCallRuntime(back);
  return null;
}
export function useInitializeCall() {
  const navigate = useNavigate();
  const router = useRouter();
  const location = useLocation();
  const returnTo = useRef("/");
  useEffect(() => {
    if (location.pathname !== "/call") returnTo.current = location.href;
  }, [location.href, location.pathname]);
  const {
    sendCallControl,
    subscribe,
    contextReady,
    dismissCallInvite,
    isCallInviteHandled,
    accountKey,
  } = useMTP();
  const { load, save, subscribe: subscribeStorage } = useStorage();
  const { upsertCall, removeCall, calls } = useSession();
  const { get } = useUser();

  const callId = useCall((state) => state.callId);
  const view = useCall((state) => state.view);
  const incomingCallInvite = management((state) => state.incomingCallInvite);
  const pendingCallSwitch = management((state) => state.pendingCallSwitch);

  useEffect(() => {
    setCallRuntime({
      accountKey,
      navigate,
      callControl: {
        request: (ownerOmikronId, type, data, options) =>
          sendCallControl(ownerOmikronId, type, data, options),
      },
      load,
      save,
      subscribeStorage,
      getPublicKey: (userId) =>
        get(userId, ["PublicKey"]).then((user) => user.PublicKey),
      upsertCall,
      removeCall,
      dismissCallInvite,
      isCallInviteHandled,
    });
  }, [
    accountKey,
    get,
    dismissCallInvite,
    isCallInviteHandled,
    load,
    navigate,
    removeCall,
    save,
    sendCallControl,
    subscribeStorage,
    upsertCall,
  ]);

  useEffect(
    () =>
      subscribeStorage((keys, bulk) => {
        if (bulk || keys.includes("call_sound_volume"))
          void refreshInviteSoundVolume();
      }),
    [subscribeStorage],
  );

  // Return through the router so file-based and browser history behave alike.
  const navigateBackFromCall = useCallback(() => {
    if (router.state.location.pathname !== "/call") return;
    const state = selectedCall()?.store.getState().state;

    if (state === "encrypting" || state === "connecting") return;
    void router.navigate({ href: returnTo.current, replace: true });
  }, [router]);

  const respondToInvite = useCallback((accepted: boolean) => {
    void respondToCallInvite(accepted).catch((error) => {
      log(0, "call", "red", "Failed to respond to call invitation", error);
      toast(
        "error",
        accepted ? "Joining call failed" : "Declining call failed",
        error instanceof Error ? error.message : String(error),
      );
    });
  }, []);

  // listen to call invites
  useEffect(() => {
    return subscribe("CallInvite", async ({ data }) => {
      await receiveCallInvite(data, Number(await load("user_id")));
    });
  }, [load, subscribe]);

  useEffect(
    () =>
      subscribe("CallEnded", ({ data }) => {
        const callId = mtp.CallEnded.response.parse(data).CallId;
        removeCall(callId);

        for (const call of management.getState().sessions) {
          if (call.store.getState().callId !== callId) continue;
          const selected = selectedCall() === call;
          void call
            .disconnect()
            .then(() => releaseCall(call))
            .then(() => {
              if (selected) navigateBackFromCall();
            });
        }
      }),
    [removeCall, navigateBackFromCall, router, subscribe],
  );

  // get callId from url
  useEffect(() => {
    if (!location.pathname.startsWith("/call")) {
      return;
    }

    const search = new URLSearchParams(location.searchStr);
    const routeCallId = search.get("id");

    if (routeCallId) {
      const active = selectedCall();
      if (!active || active.store.getState().state === "closed") {
        const call = active ?? createManagedCall();
        call.setCallId(routeCallId);
      }
    }
  }, [accountKey, location.pathname, location.searchStr]);

  // fetch call data for preview page
  const previewOwner = calls.find((call) => call.CallId === callId)?.OmikronId;
  useEffect(() => {
    if (view !== "preview" || !callId || !contextReady) {
      return;
    }

    selectedCall()?.store.setState({
      callRoute:
        previewOwner == null
          ? null
          : { ownerOmikronId: previewOwner, livekitUrl: null },
    });
    void selectedCall()?.loadCallData(callId, previewOwner);
  }, [callId, view, contextReady, previewOwner]);

  useEffect(() => {
    if (location.pathname.startsWith("/call")) return;
    for (const call of management.getState().sessions) {
      if (call.store.getState().state === "closed") void releaseCall(call);
    }
  }, [location.pathname]);
  useEffect(
    () => () => {
      stopCallJingle();
      for (const call of management.getState().sessions) void releaseCall(call);
    },
    [],
  );
  const sessions = management((s) => s.sessions);
  return (
    <>
      {sessions.map((call) => (
        <CallProvider key={call.id} call={call}>
          <CallRuntime navigateBack={navigateBackFromCall} />
        </CallProvider>
      ))}
      {incomingCallInvite && (
        <InvitePopup
          open
          onAccept={respondToInvite}
          user={incomingCallInvite.senderId}
        />
      )}
      <AlertDialog
        open={pendingCallSwitch != null}
        onOpenChange={(open) => {
          if (!open) respondToCallSwitch(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch calls?</AlertDialogTitle>
            <AlertDialogDescription>
              Joining the other call will leave your current call.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => respondToCallSwitch(false)}>
              Stay in current call
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void respondToCallSwitch(true)?.catch((error) => {
                  log(1, "call", "red", "Failed to switch calls", error);
                });
              }}
            >
              Join other call
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

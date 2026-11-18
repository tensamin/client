import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ErrorScreen,
  LoadingScreen,
  CreateScreen,
  OnboardingFlow,
  type OnboardingStep,
} from "@nonanium/ui";
import { useStorage } from "@tensamin/storage/context";
import type { MTPConnectionStatus } from "@tensamin/mtp";
import { useSettingsProfiles } from "@tensamin/settings/profiles";
import { isTauri } from "@tauri-apps/api/core";

import { diagnosticEvent } from "@tensamin/mtp/diagnostics";
import { toast } from "@tensamin/shared/log";

import TauriPermissionsPage from "./pages/tauriPermissions";

export {
  useOnboardingStep,
  type OnboardingStep,
  type OnboardingStepControls,
} from "@nonanium/ui";

type OnboardingDecision = {
  onboarding: boolean;
  tauriPermissions: boolean;
};

function useOnboardingFlags() {
  const { load, subscribe } = useStorage();
  const [flags, setFlags] = useState<{
    onboarding: boolean;
    tauriPermissions: boolean;
  } | null>(null);

  useEffect(() => {
    let active = true;
    let revision = 0;
    const refresh = () => {
      const current = ++revision;
      void Promise.all([
        load("onboarding_done"),
        load("tauri_permissions_done"),
      ]).then(([onboardingDone, tauriPermissionsDone]) => {
        if (!active || current !== revision) return;
        setFlags({
          onboarding: !onboardingDone,
          tauriPermissions:
            isTauri() &&
            /Android/.test(navigator.userAgent) &&
            !tauriPermissionsDone,
        });
      });
    };
    const unsubscribe = subscribe((keys) => {
      if (
        keys.includes("onboarding_done") ||
        keys.includes("tauri_permissions_done")
      )
        refresh();
    });
    refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [load, subscribe]);

  return flags;
}

function StartupLoader({
  connectionReady,
  connectionDescription,
  sessionEstablished,
  connectionStatus,
  retryConnection,
  settingsLoaded,
  onboardingLoaded,
}: {
  connectionReady: boolean;
  connectionDescription: string;
  sessionEstablished: boolean;
  connectionStatus: MTPConnectionStatus | null;
  retryConnection(): void;
  settingsLoaded: boolean;
  onboardingLoaded: boolean;
}) {
  const { error: settingsError, retry: retrySettings } = useSettingsProfiles();
  const completedSteps = [
    connectionReady,
    settingsLoaded,
    onboardingLoaded,
  ].filter(Boolean).length;
  const progress = (completedSteps / 3) * 100;
  const description =
    connectionStatus?.kind === "failed"
      ? connectionStatus.description
      : connectionStatus?.kind === "reconnecting"
        ? `Attempt ${connectionStatus.attempt} of 3`
        : undefined;

  if (connectionStatus?.kind === "failed" && !sessionEstablished) {
    return (
      <ErrorScreen
        error="Connection failed"
        description={connectionStatus.description}
        onRetry={retryConnection}
        statusLink={false}
      />
    );
  }

  if (settingsError && !settingsLoaded) {
    return (
      <ErrorScreen
        error="Loading settings failed"
        description={settingsError}
        onRetry={() => void retrySettings()}
        statusLink={false}
      />
    );
  }

  const title = !connectionReady
    ? connectionDescription
    : !settingsLoaded
      ? "Loading settings"
      : !onboardingLoaded
        ? "Checking onboarding"
        : "";

  if (connectionStatus?.kind === "reconnecting") {
    return (
      <CreateScreen className="gap-5 text-center">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <div
          className="h-1.5 w-64 overflow-hidden rounded-full bg-secondary"
          role="status"
        >
          <div className="loading-line-wobble h-full rounded-full bg-primary" />
        </div>
        <p
          className="max-w-sm wrap-break-word px-4 text-xs text-destructive"
          role="status"
        >
          {connectionStatus.description}
        </p>
      </CreateScreen>
    );
  }

  return (
    <LoadingScreen
      title={title}
      description={description}
      progress={progress}
    />
  );
}

async function saveOnboardingCompletion(
  decision: OnboardingDecision,
  save: ReturnType<typeof useStorage>["save"],
) {
  if (decision.onboarding) await save("onboarding_done", true);

  if (decision.tauriPermissions) await save("tauri_permissions_done", true);
}

function createOnboardingSteps(decision: OnboardingDecision) {
  const steps: OnboardingStep[] = [];

  if (decision.tauriPermissions) {
    steps.push({
      id: "tauri-permissions",
      title: "Enable notifications",
      description:
        "We need these permissions so that notifications can be independent of Google Play Services.",
      defaultCanContinue: false,
      content: <TauriPermissionsPage />,
    });
  }

  return steps;
}

function ActiveOnboarding({
  children,
  decision,
  feedback,
}: {
  children: ReactNode;
  decision: OnboardingDecision;
  feedback?: ReactNode;
}) {
  const { save } = useStorage();
  const [complete, setComplete] = useState(false);

  const finish = useCallback(async () => {
    diagnosticEvent("onboarding_finish_start");
    try {
      await saveOnboardingCompletion(decision, save);
      diagnosticEvent("onboarding_finish_success");
      setComplete(true);
    } catch {
      diagnosticEvent("onboarding_finish_failure");
      toast(
        "error",
        "Onboarding could not be saved",
        "Please try Continue again.",
        {
          duration: Infinity,
          closeButton: true,
        },
      );
    }
  }, [decision, save]);

  const steps = createOnboardingSteps(decision);

  useEffect(() => {
    if (steps.length !== 0 || complete || !decision.onboarding) return;
    void finish();
  }, [complete, decision.onboarding, finish, steps.length]);

  if (complete || steps.length === 0) {
    return <>{children}</>;
  }

  return (
    <>
      {feedback}
      <OnboardingFlow
        key={steps.map((step) => step.id).join(":")}
        steps={steps}
        onFinish={() => finish()}
      />
    </>
  );
}

export default function OnboardingGate({
  children,
  connectionReady,
  connectionDescription,
  sessionEstablished,
  connectionStatus,
  retryConnection,
  hasCachedState = false,
  onboardingFeedback,
}: {
  children: ReactNode;
  connectionReady: boolean;
  connectionDescription: string;
  sessionEstablished: boolean;
  connectionStatus: MTPConnectionStatus | null;
  retryConnection(): void;
  hasCachedState?: boolean;
  onboardingFeedback?: ReactNode;
}) {
  const { loaded: settingsLoaded } = useSettingsProfiles();
  const flags = useOnboardingFlags();

  const [entered, setEntered] = useState(false);
  const canEnter =
    flags !== null &&
    ((hasCachedState && !flags.onboarding && !flags.tauriPermissions) ||
      (sessionEstablished && connectionReady && settingsLoaded));
  useEffect(() => {
    if (canEnter) setEntered(true);
  }, [canEnter]);

  const stage =
    !entered || !flags
      ? "startup"
      : flags.tauriPermissions
        ? "onboarding"
        : "app";
  useEffect(() => {
    const started = performance.now();
    diagnosticEvent(
      stage === "startup"
        ? "startup_shown"
        : stage === "onboarding"
          ? "onboarding_shown"
          : "app_shown",
    );
    return () =>
      diagnosticEvent(
        stage === "startup"
          ? "startup_duration_ms"
          : stage === "onboarding"
            ? "onboarding_duration_ms"
            : "app_duration_ms",
        Math.round(performance.now() - started),
      );
  }, [stage]);
  const previousReadiness = useRef<Record<string, boolean>>({});
  useEffect(() => {
    const readiness = {
      startup_connection_ready: connectionReady,
      startup_session_established: sessionEstablished,
      startup_settings_loaded: settingsLoaded,
      startup_flags_loaded: flags !== null,
    };
    for (const [event, ready] of Object.entries(readiness)) {
      if (previousReadiness.current[event] !== ready)
        diagnosticEvent(event, Number(ready));
    }
    previousReadiness.current = readiness;
  }, [connectionReady, sessionEstablished, settingsLoaded, flags]);

  // Startup readiness must not unmount an active flow or page during a reconnect.
  if (!entered || !flags) {
    return (
      <StartupLoader
        connectionReady={connectionReady}
        connectionDescription={connectionDescription}
        connectionStatus={connectionStatus}
        retryConnection={retryConnection}
        sessionEstablished={sessionEstablished}
        settingsLoaded={settingsLoaded}
        onboardingLoaded={flags !== null}
      />
    );
  }

  return (
    <ActiveOnboarding decision={flags} feedback={onboardingFeedback}>
      {children}
    </ActiveOnboarding>
  );
}

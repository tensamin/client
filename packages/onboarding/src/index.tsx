import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ErrorScreen,
  LoadingScreen,
  OnboardingFlow,
  type OnboardingStep,
} from "@nonanium/ui";
import { useStorage } from "@tensamin/storage/context";
import type { MTPConnectionStatus } from "@tensamin/mtp";
import { useSettingsProfiles } from "@tensamin/settings/profiles";
import { isTauri } from "@tauri-apps/api/core";

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
  const { load } = useStorage();
  const [flags, setFlags] = useState<{
    onboarding: boolean;
    tauriPermissions: boolean;
  } | null>(null);

  useEffect(() => {
    void Promise.all([
      load("onboarding_done"),
      load("tauri_permissions_done"),
    ]).then(([onboardingDone, tauriPermissionsDone]) => {
      setFlags({
        onboarding: !onboardingDone,
        tauriPermissions:
          isTauri() &&
          /Android/.test(navigator.userAgent) &&
          !tauriPermissionsDone,
      });
    });
  }, [load]);

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

  const title = !connectionReady
    ? connectionDescription
    : !settingsLoaded
      ? "Loading settings"
      : !onboardingLoaded
        ? "Checking onboarding"
        : "";
  if (connectionStatus?.kind === "reconnecting") {
    return <LoadingScreen title={title} description={description} noProgress />;
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
}: {
  children: ReactNode;
  decision: OnboardingDecision;
}) {
  const { save } = useStorage();
  const [complete, setComplete] = useState(false);

  const finish = useCallback(async () => {
    setComplete(true);
    await saveOnboardingCompletion(decision, save);
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
    <OnboardingFlow
      key={steps.map((step) => step.id).join(":")}
      steps={steps}
      onFinish={() => finish()}
    />
  );
}

export default function OnboardingGate({
  children,
  connectionReady,
  connectionDescription,
  sessionEstablished,
  connectionStatus,
  retryConnection,
}: {
  children: ReactNode;
  connectionReady: boolean;
  connectionDescription: string;
  sessionEstablished: boolean;
  connectionStatus: MTPConnectionStatus | null;
  retryConnection(): void;
}) {
  const { loaded: settingsLoaded } = useSettingsProfiles();
  const flags = useOnboardingFlags();
  const decision =
    flags === null || !connectionReady || !settingsLoaded ? null : flags;

  if (!sessionEstablished) {
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

  if (!decision) {
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

  return <ActiveOnboarding decision={decision}>{children}</ActiveOnboarding>;
}

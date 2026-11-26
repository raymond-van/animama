import {
  Outlet,
  createFileRoute,
  useRouterState,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { useRuntimeAdmission } from "@/app/runtime/RuntimeAdmissionProvider";
import { FirstRunAgeConfirmation } from "@/app/local-runtime/setup/FirstRunAgeConfirmation";
import { HostedAgeConfirmation } from "@/app/hosted-runtime/HostedAgeConfirmation";
import {
  unavailableReasonText,
  unavailableRouteReason,
} from "@/app/runtime/route-admission";
import { AppShellPage } from "@/ui/app/AppShellPage";
import { AppShell } from "@/ui/app/AppShell";
import { ContentPreviewDockProvider } from "@/ui/content-preview/ContentPreviewDockProvider";
import { SettingsGate } from "@/ui/settings/SettingsGate";
import { DesktopUpdatesPanel } from "@/ui/settings/DesktopUpdatesPanel";
import { DesktopMenuCommands } from "@/ui/app/DesktopMenuCommands";
import { ModelDownloadToasts } from "@/ui/app/ModelDownloads";
import { SidebarShell } from "@/ui/sidebar";

export const Route = createFileRoute("/_app")({
  component: ApplicationAreaLayout,
});

function ApplicationAreaLayout() {
  const { t } = useTranslation("app");
  const { admission, composition } = useRuntimeAdmission();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  if (admission.status !== "ready") return null;
  const reason = unavailableRouteReason(pathname, admission.capabilities);
  // The composition never changes, so the confirmation boundary stays mounted.
  const AgeConfirmation =
    composition?.kind === "hosted"
      ? HostedAgeConfirmation
      : FirstRunAgeConfirmation;
  return (
    <AgeConfirmation>
      <SettingsGate>
        <AppShell>
          <ContentPreviewDockProvider>
            <SidebarShell />
            {reason ? (
              <AppShellPage>
                <h1 className="text-lg font-semibold">
                  {t("unavailable.title")}
                </h1>
                <p className="text-muted-foreground">
                  {unavailableReasonText(reason, t)}
                </p>
              </AppShellPage>
            ) : (
              <Outlet />
            )}
            {!admission.onboardingRequired && <DesktopUpdatesPanel notice />}
            {/* Like the update notice, menu commands wait for first run. */}
            {!admission.onboardingRequired && <DesktopMenuCommands />}
            <ModelDownloadToasts />
          </ContentPreviewDockProvider>
        </AppShell>
      </SettingsGate>
    </AgeConfirmation>
  );
}

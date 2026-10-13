import {
  Outlet,
  createFileRoute,
  useRouterState,
} from "@tanstack/react-router";

import { useRuntimeAdmission } from "@web/app/runtime/RuntimeAdmissionProvider";
import { FirstRunAgeConfirmation } from "@web/app/local-runtime/setup/FirstRunAgeConfirmation";
import { unavailableRouteReason } from "@web/app/runtime/route-admission";
import { AppShellPage } from "@/ui/app/AppShellPage";
import { AppShell } from "@/ui/app/AppShell";
import { ContentPreviewDockProvider } from "@/ui/content-preview/ContentPreviewDockProvider";
import { SettingsGate } from "@/ui/settings/SettingsGate";
import { DesktopUpdatesPanel } from "@/ui/settings/DesktopUpdatesPanel";
import { SidebarShell } from "@/ui/sidebar";

export const Route = createFileRoute("/_app")({
  component: ApplicationAreaLayout,
});

function ApplicationAreaLayout() {
  const { admission } = useRuntimeAdmission();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  if (admission.status !== "ready") return null;
  const reason = unavailableRouteReason(pathname, admission.capabilities);
  return (
    <FirstRunAgeConfirmation>
      <SettingsGate>
        <AppShell>
          <ContentPreviewDockProvider>
            <SidebarShell />
            {reason ? (
              <AppShellPage>
                <h1 className="text-lg font-semibold">Unavailable here</h1>
                <p className="text-muted-foreground">{reason}</p>
              </AppShellPage>
            ) : (
              <Outlet />
            )}
            {!admission.onboardingRequired && <DesktopUpdatesPanel notice />}
          </ContentPreviewDockProvider>
        </AppShell>
      </SettingsGate>
    </FirstRunAgeConfirmation>
  );
}

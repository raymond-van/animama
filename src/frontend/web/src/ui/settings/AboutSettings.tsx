import { isProviderCredential } from "../../../../shared/desktop-runtime";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { copyText } from "@/lib/diagnostics/copy-text";
import { buildDiagnosticsSummary } from "@/lib/diagnostics/summary";
import { recentLogEntries, recentMilestones } from "@/lib/logger";
import { env } from "@/platform/env";
import { useRuntimePlatform } from "@/platform/RuntimePlatformProvider";
import { useDesktopFeaturePacks } from "@/hooks/useDesktopFeaturePacks";
import { Button } from "@/ui/components/button";
import { SettingsRow } from "@/ui/settings/SettingsLayout";

/** Operating system names are product names and stay as written. */
const OS_LABELS: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

/** Human-readable platform: desktop OS, or the browser app. */
function usePlatformLabel(): string {
  const { t } = useTranslation("settings");
  const platform = useRuntimePlatform();
  if (!platform.isDesktop) return t("about.platform.web");
  const os = platform.os ? (OS_LABELS[platform.os] ?? platform.os) : null;
  return os
    ? t("about.platform.desktopOs", { os })
    : t("about.platform.desktop");
}

/** App version and platform, shown in both the browser and desktop app. */
export function AboutVersionSetting() {
  const { t } = useTranslation("settings");
  const platformLabel = usePlatformLabel();
  const platform = useRuntimePlatform();
  // A Linux desktop build has no in-app updates: it is rebuilt from source.
  const sourceBuild = platform.isDesktop && platform.os === "linux";
  return (
    <SettingsRow
      label={t("about.version")}
      description={
        sourceBuild ? (
          <>
            {platformLabel}
            <br />
            {t("about.sourceBuild")}
          </>
        ) : (
          platformLabel
        )
      }
      control={
        <span className="text-foreground font-mono text-sm">
          {env.appVersion}
        </span>
      }
    />
  );
}

/** Desktop only: reveal the redacted main-process log folder. */
export function OpenLogsSetting() {
  const { t } = useTranslation("settings");
  const platform = useRuntimePlatform();
  const runtime = platform.isDesktop
    ? platform.desktopBridge.runtime
    : undefined;
  return (
    <SettingsRow
      label={t("about.logs.label")}
      description={t("about.logs.description")}
      control={
        <Button
          type="button"
          variant="outline"
          disabled={!runtime}
          onClick={() => {
            void runtime
              ?.openLogs()
              .catch(() => toast.error(t("about.logs.openFailed")));
          }}
        >
          {t("about.logs.open")}
        </Button>
      }
    />
  );
}

/**
 * Copy a bug-report summary. Collects only status facts; see
 * `lib/diagnostics/summary.ts` for what is and is not included.
 */
export function CopyDiagnosticsSetting() {
  const { t } = useTranslation("settings");
  const platform = useRuntimePlatform();
  const { packs } = useDesktopFeaturePacks();

  const copy = async () => {
    const bridge = platform.isDesktop ? platform.desktopBridge : null;
    // Each desktop fact is optional; a failed read simply leaves it out.
    const [runtime, providers] = await Promise.all([
      bridge?.runtime?.status().catch(() => null) ?? null,
      bridge?.credentials?.list().catch(() => null) ?? null,
    ]);
    const summary = buildDiagnosticsSummary({
      appVersion: env.appVersion,
      platform: platform.isDesktop
        ? `desktop-${platform.os ?? "unknown"}`
        : "web",
      runtime:
        runtime && "code" in runtime
          ? { state: runtime.state, code: runtime.code }
          : runtime
            ? { state: runtime.state }
            : null,
      featurePacks: packs.map((pack) => ({
        id: pack.id,
        state: pack.state,
        // Only the installed version; `version` may be the one on offer.
        version: pack.activeVersion,
      })),
      providers: providers?.filter(isProviderCredential).map((status) => ({
        provider: status.provider,
        configured: status.configured,
      })),
      recentActivity: recentMilestones(),
      recentProblems: recentLogEntries(),
    });
    if (await copyText(summary)) toast.success(t("about.diagnostics.copied"));
    else toast.error(t("about.diagnostics.copyFailed"));
  };

  return (
    <SettingsRow
      label={t("about.diagnostics.label")}
      description={t("about.diagnostics.description")}
      control={
        <Button type="button" variant="outline" onClick={() => void copy()}>
          {t("about.diagnostics.copy")}
        </Button>
      }
    />
  );
}

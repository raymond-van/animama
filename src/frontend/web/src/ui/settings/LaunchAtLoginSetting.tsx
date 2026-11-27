import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { useDesktopLoginItem } from "@/hooks/useDesktopLoginItem";
import { useRuntimePlatform } from "@/platform/RuntimePlatformProvider";
import { Switch } from "@/ui/components/switch";
import { SettingsRow } from "@/ui/settings/SettingsLayout";

/** Open the packaged desktop app when the user logs in to the computer. */
export function LaunchAtLoginSetting({
  loginItem,
}: {
  loginItem: ReturnType<typeof useDesktopLoginItem>;
}) {
  const { t } = useTranslation("settings");
  const platform = useRuntimePlatform();
  const { status, pending, setEnabled } = loginItem;
  if (!status.available) return null;
  const label = t("launchAtLogin.label");
  const os =
    platform.kind === "desktop" ? platform.desktopBridge.platform : undefined;
  const blockedHint =
    os === "win32"
      ? t("launchAtLogin.blocked.windows")
      : os === "linux"
        ? t("launchAtLogin.blocked.linux")
        : t("launchAtLogin.blocked.macos");

  return (
    <SettingsRow
      label={label}
      description={
        status.blockedBySystem ? blockedHint : t("launchAtLogin.description")
      }
      control={
        <Switch
          checked={status.enabled}
          disabled={pending}
          aria-label={label}
          onCheckedChange={(checked) => {
            void setEnabled(checked).catch(() =>
              toast.error(t("launchAtLogin.updateFailed")),
            );
          }}
        />
      }
    />
  );
}

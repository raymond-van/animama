import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { useDesktopMenuEntry } from "@/hooks/useDesktopMenuEntry";
import { Button } from "@/ui/components/button";
import { Switch } from "@/ui/components/switch";
import { SettingsRow } from "@/ui/settings/SettingsLayout";

/**
 * Add the Linux AppImage to the desktop's application menu. Nothing installs
 * an AppImage, so the entry exists only while this is on, and it names the
 * file as it was when added: after the file moves, the row says so and offers
 * to point the entry at the running file.
 */
export function ApplicationMenuEntrySetting({
  menuEntry,
}: {
  menuEntry: ReturnType<typeof useDesktopMenuEntry>;
}) {
  const { t } = useTranslation("settings");
  const { status, pending, setEnabled } = menuEntry;
  if (!status.available) return null;
  const label = t("menuEntry.label");
  const change = (enabled: boolean) => {
    void setEnabled(enabled).catch(() =>
      toast.error(t("menuEntry.updateFailed")),
    );
  };

  return (
    <SettingsRow
      label={label}
      description={
        status.stale ? t("menuEntry.stale") : t("menuEntry.description")
      }
      control={
        <div className="flex items-center gap-3">
          {status.stale ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => change(true)}
            >
              {t("menuEntry.repoint")}
            </Button>
          ) : null}
          <Switch
            checked={status.enabled}
            disabled={pending}
            aria-label={label}
            onCheckedChange={change}
          />
        </div>
      }
    />
  );
}

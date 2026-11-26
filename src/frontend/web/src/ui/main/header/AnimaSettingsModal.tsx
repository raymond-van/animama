import { Stethoscope } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  animaBehaviorOverride,
  appBehaviorEnabled,
  behaviorPatch,
  effectiveBehaviorEnabled,
  type BehaviorFlag,
  type BehaviorOverride,
} from "@/lib/settings/behavior-defaults";
import { runtimeAvatarModelSha256 } from "@/lib/runtime-content/runtimeAvatarFaceParts";
import { adaptRuntimeSnapshot } from "@/lib/runtime-content/runtimeSnapshotAdapter";
import { cn } from "@/lib/utils";
import { useAnimaLoadout } from "@/query/hooks/useAnimaLoadout";
import { AnimaAvatarChoiceRow } from "@/ui/animas/AnimaAvatarChoiceRow";
import { useAnimaRuntimeCatalog } from "@/query/hooks/useAnimaRuntimeCatalog";
import { useAvatarSettingsAvailable } from "@/query/hooks/useAvatarSettings";
import { AvatarDiagnosticsDialog } from "@/ui/animas/AvatarDiagnosticsDialog";
import { AvatarSettingsRows } from "@/ui/animas/AvatarSettingsRows";
import { Button } from "@/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/ui/components/tooltip";
import { behaviorLabel } from "@/ui/settings/BehaviorDataSettings";
import { useSettings } from "@/ui/settings/SettingsProvider";

type InheritableSettingRowProps = {
  label: string;
  description: string;
  tooltip: string;
  value: BehaviorOverride;
  /** The App Settings value shown for "Use app default". */
  appEnabled: boolean;
  disabled?: boolean;
  onChange: (value: BehaviorOverride) => void;
};

/**
 * A memory/emotion behaviour that follows App Settings unless this Anima sets
 * its own value.
 */
function InheritableSettingRow({
  label,
  description,
  tooltip,
  value,
  appEnabled,
  disabled,
  onChange,
}: InheritableSettingRowProps) {
  const { t } = useTranslation("settings");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "border-border/60 bg-background flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4",
            disabled && "opacity-70",
          )}
        >
          <div className="min-w-0">
            <p className="text-foreground text-sm font-medium">{label}</p>
            <p className="text-muted-foreground text-xs">{description}</p>
          </div>
          <Select
            value={value}
            disabled={disabled}
            onValueChange={(next) => onChange(next as BehaviorOverride)}
          >
            <SelectTrigger
              className="w-full shrink-0 sm:w-48"
              aria-label={label}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">
                {appEnabled
                  ? t("animaSettings.choices.appDefaultOn")
                  : t("animaSettings.choices.appDefaultOff")}
              </SelectItem>
              <SelectItem value="on">
                {t("animaSettings.choices.on")}
              </SelectItem>
              <SelectItem value="off">
                {t("animaSettings.choices.off")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** The Anima's Avatar settings: the shared rows for its Avatar item. */
function AnimaAvatarSettingsRows({ animaId }: { animaId: string }) {
  const { available } = useAvatarSettingsAvailable();
  const loadout = useAnimaLoadout(animaId);
  const runtime = useAnimaRuntimeCatalog(available ? animaId : null);
  const vrmSha256 = useMemo(
    () =>
      runtime.data
        ? runtimeAvatarModelSha256(
            adaptRuntimeSnapshot(runtime.data).avatar_model,
          )
        : null,
    [runtime.data],
  );
  return (
    <AvatarSettingsRows
      itemId={loadout.data?.avatar_source?.catalog_item_id ?? null}
      vrmSha256={vrmSha256}
    />
  );
}

/** The Anima's Avatar diagnostics, opened in their own dialog. */
function AvatarDiagnosticsRow({ animaId }: { animaId: string }) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  return (
    <div className="border-border/60 bg-background flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <p className="text-foreground text-sm font-medium">
          {t("animaSettings.rows.avatar_diagnostics.label")}
        </p>
        <p className="text-muted-foreground text-xs">
          {t("animaSettings.rows.avatar_diagnostics.description")}
        </p>
      </div>
      <Button
        variant="outline"
        className="w-full shrink-0 sm:w-48"
        onClick={() => setOpen(true)}
      >
        <Stethoscope /> {t("animaSettings.rows.avatar_diagnostics.open")}
      </Button>
      <AvatarDiagnosticsDialog
        source={{ kind: "anima", animaId }}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}

type AnimaSettingsModalProps = {
  /** The Anima whose Avatar the Diagnostics section describes. */
  animaId?: string | null;
};

export function AnimaSettingsModal({ animaId }: AnimaSettingsModalProps = {}) {
  const { t } = useTranslation("settings");
  const {
    userPreferences,
    animaPreferences,
    updateAnimaPreferences,
    isLoading,
    isUpdating,
  } = useSettings();
  const isBusy = isLoading || isUpdating;
  const memoryEnabled = effectiveBehaviorEnabled(
    userPreferences,
    animaPreferences,
    "memory_influence",
  );

  const handleBehaviorChange = useCallback(
    (flag: BehaviorFlag, choice: BehaviorOverride) => {
      if (isBusy) return;
      void updateAnimaPreferences(behaviorPatch(flag, choice)).catch(() =>
        toast(
          flag === "emotion_updates"
            ? t("animaSettings.updateFailed.emotion")
            : t("animaSettings.updateFailed.memory"),
        ),
      );
    },
    [isBusy, t, updateAnimaPreferences],
  );

  return (
    <div className="border-border/60 bg-muted/10 flex flex-1 flex-col gap-6 rounded-xl border p-4 sm:p-6">
      <div>
        <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          {t("animaSettings.headings.emotion")}
        </p>
        <div className="mt-3 grid gap-3">
          <InheritableSettingRow
            label={behaviorLabel(t, "emotion_updates")}
            description={t("animaSettings.rows.emotion_updates.description")}
            tooltip={t("animaSettings.rows.emotion_updates.tooltip")}
            value={animaBehaviorOverride(animaPreferences, "emotion_updates")}
            appEnabled={appBehaviorEnabled(userPreferences, "emotion_updates")}
            disabled={isBusy}
            onChange={(choice) =>
              handleBehaviorChange("emotion_updates", choice)
            }
          />
        </div>
      </div>

      <div>
        <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          {t("animaSettings.headings.memory")}
        </p>
        <div className="mt-3 grid gap-3">
          <InheritableSettingRow
            label={behaviorLabel(t, "memory_influence")}
            description={t("animaSettings.rows.memory_influence.description")}
            tooltip={t("animaSettings.rows.memory_influence.tooltip")}
            value={animaBehaviorOverride(animaPreferences, "memory_influence")}
            appEnabled={appBehaviorEnabled(userPreferences, "memory_influence")}
            disabled={isBusy}
            onChange={(choice) =>
              handleBehaviorChange("memory_influence", choice)
            }
          />
          <InheritableSettingRow
            label={behaviorLabel(t, "memory_updates")}
            description={
              memoryEnabled
                ? t("animaSettings.rows.memory_updates.description")
                : t("animaSettings.rows.memory_updates.memoryOff")
            }
            tooltip={t("animaSettings.rows.memory_updates.tooltip")}
            value={animaBehaviorOverride(animaPreferences, "memory_updates")}
            appEnabled={appBehaviorEnabled(userPreferences, "memory_updates")}
            disabled={!memoryEnabled || isBusy}
            onChange={(choice) =>
              handleBehaviorChange("memory_updates", choice)
            }
          />
        </div>
      </div>

      {animaId ? (
        <div>
          <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
            {t("animaSettings.headings.avatar")}
          </p>
          <div className="mt-3 grid gap-3">
            <AnimaAvatarChoiceRow animaId={animaId} />
            <AnimaAvatarSettingsRows animaId={animaId} />
            <AvatarDiagnosticsRow animaId={animaId} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

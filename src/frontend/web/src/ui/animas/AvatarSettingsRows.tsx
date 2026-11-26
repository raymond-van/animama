import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  AVATAR_MATERIAL_MODES,
  AVATAR_SPRING_MODES,
  WIND_STRENGTH_PERCENT,
  materialModesFor,
  useAvatarFileMaterials,
  type AvatarMaterialMode,
  type AvatarSpringMode,
} from "@/lib/avatar/avatarSettings";
import { cn } from "@/lib/utils";
import {
  useAvatarSettings,
  useAvatarSettingsAvailable,
} from "@/query/hooks/useAvatarSettings";
import { useSaveAvatarSettings } from "@/query/mutations/useSaveAvatarSettings";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components/select";
import { Slider } from "@/ui/components/slider";
import { materialModeLabel, springModeLabel } from "./avatarSettingLabels";

type AvatarSettingRowProps<Mode extends string> = {
  label: string;
  description: string;
  value: Mode;
  modes: readonly Mode[];
  modeLabel: (mode: Mode) => string;
  disabled: boolean;
  onChange: (mode: Mode) => void;
};

/** One setting of an Avatar, chosen from its modes. */
function AvatarSettingRow<Mode extends string>({
  label,
  description,
  value,
  modes,
  modeLabel,
  disabled,
  onChange,
}: AvatarSettingRowProps<Mode>) {
  return (
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
        onValueChange={(next) => onChange(next as Mode)}
      >
        <SelectTrigger className="w-full shrink-0 sm:w-48" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {modes.map((mode) => (
            <SelectItem key={mode} value={mode}>
              {modeLabel(mode)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

type WindStrengthRowProps = {
  /** The stored strength in percent of the default. */
  percent: number;
  disabled: boolean;
  onCommit: (percent: number) => void;
};

/**
 * The Avatar's wind strength, from none to twice the default. Dragging
 * previews the value; it is saved when released.
 */
function WindStrengthRow({
  percent,
  disabled,
  onCommit,
}: WindStrengthRowProps) {
  const { t } = useTranslation("settings");
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? percent;
  const label = t("animaSettings.avatar.windStrength.label");
  const valueText = t("animaSettings.avatar.windStrength.value", {
    percent: shown,
  });
  return (
    <div
      className={cn(
        "border-border/60 bg-background flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4",
        disabled && "opacity-70",
      )}
    >
      <div className="min-w-0">
        <p className="text-foreground text-sm font-medium">{label}</p>
        <p className="text-muted-foreground text-xs">
          {t("animaSettings.avatar.windStrength.description")}
        </p>
      </div>
      <div className="flex w-full shrink-0 items-center gap-3 sm:w-48">
        <Slider
          min={WIND_STRENGTH_PERCENT.min}
          max={WIND_STRENGTH_PERCENT.max}
          step={WIND_STRENGTH_PERCENT.step}
          value={[shown]}
          disabled={disabled}
          thumbProps={{ "aria-label": label, "aria-valuetext": valueText }}
          onValueChange={([value]) => setDraft(value ?? percent)}
          onValueCommit={([value]) => {
            setDraft(null);
            if (value !== undefined && value !== percent) onCommit(value);
          }}
        />
        <span className="text-muted-foreground w-12 shrink-0 text-right text-xs tabular-nums">
          {valueText}
        </span>
      </div>
    </div>
  );
}

type AvatarSettingsRowsProps = {
  /** The Avatar catalog item the settings are kept for. */
  itemId: string | null;
  /** The sha256 of the item's VRM file, to know which materials it has. */
  vrmSha256: string | null;
};

/**
 * An Avatar's settings, kept per Avatar item by the local runtimes, so they
 * apply wherever the Avatar is used (the Anima settings and the Library show
 * the same rows). Materials is offered only for a file with lilToon
 * materials (known once this session has read the file), or while a stored
 * choice needs a way back to Automatic. Renders nothing where the runtime
 * keeps no settings or without an item.
 */
export function AvatarSettingsRows({
  itemId,
  vrmSha256,
}: AvatarSettingsRowsProps) {
  const { t } = useTranslation("settings");
  const { available } = useAvatarSettingsAvailable();
  const fileMaterials = useAvatarFileMaterials(vrmSha256);
  const settings = useAvatarSettings(itemId);
  const save = useSaveAvatarSettings(itemId);
  if (!available || !itemId) return null;

  const busy = settings.isLoading || save.isPending;
  const springMode = settings.data?.spring_mode ?? "automatic";
  const materialMode = settings.data?.material_mode ?? "automatic";
  // A stored choice the file does not offer (lilToon on an unlit file) stays
  // selectable, so the select can show it.
  const offeredModes = materialModesFor(fileMaterials);
  const materialModes = offeredModes.includes(materialMode)
    ? offeredModes
    : AVATAR_MATERIAL_MODES;
  const showMaterials =
    fileMaterials === "liltoon" ||
    fileMaterials === "unlit" ||
    settings.data?.material_mode_source === "stored";
  const saveFailed = () => toast(t("animaSettings.updateFailed.avatar"));
  return (
    <>
      <AvatarSettingRow<AvatarSpringMode>
        label={t("animaSettings.avatar.wind.label")}
        description={t("animaSettings.avatar.wind.description")}
        value={springMode}
        modes={AVATAR_SPRING_MODES}
        modeLabel={(mode) => springModeLabel(t, mode)}
        disabled={busy}
        onChange={(mode) =>
          save.mutate(
            // Automatic is stored as no value.
            { spring_mode: mode === "automatic" ? null : mode },
            { onError: saveFailed },
          )
        }
      />
      {springMode === "automatic" || springMode === "on" ? (
        <WindStrengthRow
          percent={
            settings.data?.wind_strength ?? WIND_STRENGTH_PERCENT.default
          }
          disabled={busy}
          onCommit={(percent) =>
            save.mutate(
              // The default strength is stored as no value.
              {
                wind_strength:
                  percent === WIND_STRENGTH_PERCENT.default ? null : percent,
              },
              { onError: saveFailed },
            )
          }
        />
      ) : null}
      {showMaterials ? (
        <AvatarSettingRow<AvatarMaterialMode>
          label={t("animaSettings.avatar.materials.label")}
          description={
            fileMaterials === "unlit"
              ? t("animaSettings.avatar.materials.unlitDescription")
              : t("animaSettings.avatar.materials.description")
          }
          value={materialMode}
          modes={materialModes}
          modeLabel={(mode) => materialModeLabel(t, mode)}
          disabled={busy}
          onChange={(mode) =>
            save.mutate(
              { material_mode: mode === "automatic" ? null : mode },
              { onError: saveFailed },
            )
          }
        />
      ) : null}
    </>
  );
}

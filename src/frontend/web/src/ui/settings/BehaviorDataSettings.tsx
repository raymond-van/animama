import { useState } from "react";
import type { TFunction } from "i18next";
import { useTheme } from "next-themes";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  appBehaviorEnabled,
  behaviorPatch,
  type BehaviorFlag,
} from "@/lib/settings/behavior-defaults";
import { writeSelectedMicrophoneId } from "@/lib/voice/microphone-preferences";
import {
  AUTOMATIC_EPISODE_PROCESSING_POLL_MS,
  useAutomaticEpisodeProcessing,
} from "@/query/hooks/useAutomaticEpisodeProcessing";
import { useUpdateAutomaticEpisodeProcessing } from "@/query/mutations/useAutomaticEpisodeProcessing";
import type { PyAutomaticEpisodeProcessingStatus } from "@animama/runtime-contracts/api-types";
import { Button } from "@/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components/select";
import { Switch } from "@/ui/components/switch";
import { SettingsRow } from "@/ui/settings/SettingsLayout";
import { useSettings } from "@/ui/settings/SettingsProvider";

/** Display name of a memory/emotion behaviour, shared by App and Anima Settings. */
export function behaviorLabel(
  t: TFunction<"settings">,
  flag: BehaviorFlag,
): string {
  switch (flag) {
    case "memory_influence":
      return t("behavior.flags.memory_influence.label");
    case "memory_updates":
      return t("behavior.flags.memory_updates.label");
    case "emotion_updates":
      return t("behavior.flags.emotion_updates.label");
  }
}

/** What the App Settings default for a behaviour controls. */
function behaviorDescription(
  t: TFunction<"settings">,
  flag: BehaviorFlag,
): string {
  switch (flag) {
    case "memory_influence":
      return t("behavior.flags.memory_influence.description");
    case "memory_updates":
      return t("behavior.flags.memory_updates.description");
    case "emotion_updates":
      return t("behavior.flags.emotion_updates.description");
  }
}

/**
 * App-wide default for a memory/emotion behaviour. Animas follow it unless
 * they set their own value in Anima settings.
 */
export function AppBehaviorSetting({
  flag,
  disabled,
}: {
  flag: BehaviorFlag;
  disabled: boolean;
}) {
  const { t } = useTranslation("settings");
  const { userPreferences, updateUserPreferences } = useSettings();
  const enabled = appBehaviorEnabled(userPreferences, flag);
  const memoryEnabled = appBehaviorEnabled(userPreferences, "memory_influence");
  const blockedByMemory = flag === "memory_updates" && !memoryEnabled;
  const label = behaviorLabel(t, flag);

  return (
    <SettingsRow
      label={label}
      description={
        blockedByMemory
          ? t("behavior.blockedByMemory")
          : behaviorDescription(t, flag)
      }
      control={
        <Switch
          checked={enabled && !blockedByMemory}
          disabled={disabled || blockedByMemory}
          aria-label={t("behavior.appDefaultLabel", { label })}
          onCheckedChange={(checked) => {
            void updateUserPreferences(
              behaviorPatch(flag, checked ? "on" : "off"),
            ).catch(() => toast.error(t("behavior.updateFailed", { label })));
          }}
        />
      }
    />
  );
}

/** Off, or the pending-note counts the backend accepts (5–50), in steps of five. */
export const AUTOMATIC_PROCESSING_THRESHOLDS = [
  0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50,
] as const;

/** The line under the setting: what automatic processing is doing, or why it is not. */
export function automaticProcessingDescription(
  t: TFunction<"settings">,
  status: PyAutomaticEpisodeProcessingStatus | undefined,
): string {
  switch (status?.state) {
    case "memory_off":
      return t("behavior.automaticProcessing.memoryOff");
    case "needs_model":
      return t("behavior.automaticProcessing.needsModel");
    // A ChatGPT plan model runs automatic work only with the owner's agreement (spec #919).
    case "needs_plan_agreement":
      return t("behavior.automaticProcessing.needsPlanAgreement");
    case "needs_plan_sign_in":
      return t("behavior.automaticProcessing.needsPlanSignIn");
    case "plan_paused":
      return t("behavior.automaticProcessing.planPaused");
    case "running":
      return t("behavior.automaticProcessing.running", {
        count: status.batch_size ?? 0,
      });
    case "paused":
      return t("behavior.automaticProcessing.paused", {
        error: status.last_error ?? "",
      });
    case "backing_off":
      return status.last_error
        ? t("behavior.automaticProcessing.retrying", {
            error: status.last_error,
          })
        : t("behavior.automaticProcessing.dailyLimit");
    default:
      return t("behavior.automaticProcessing.description");
  }
}

/**
 * How many pending episode notes start an automatic Memory Manager run, or Off.
 * Only runtimes with the `automatic_episode_processing` capability show it; the
 * setting is stored by the backend, not in user preferences.
 */
export function AutomaticEpisodeProcessingSetting({
  disabled,
}: {
  disabled: boolean;
}) {
  const { t } = useTranslation("settings");
  // Memory flags and runs change the state while the setting is open.
  const status = useAutomaticEpisodeProcessing({
    refetchInterval: AUTOMATIC_EPISODE_PROCESSING_POLL_MS,
  });
  const update = useUpdateAutomaticEpisodeProcessing();
  const threshold = status.data?.threshold;
  const label = t("behavior.automaticProcessing.label");

  return (
    <SettingsRow
      label={label}
      description={automaticProcessingDescription(t, status.data)}
      control={
        <Select
          // Controlled from the first render; empty until the status loads.
          value={threshold === undefined ? "" : String(threshold)}
          disabled={disabled || threshold === undefined || update.isPending}
          onValueChange={(value) => {
            update.mutate(Number(value), {
              onError: () =>
                toast.error(t("behavior.automaticProcessing.updateFailed")),
            });
          }}
        >
          <SelectTrigger className="w-56" aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUTOMATIC_PROCESSING_THRESHOLDS.map((value) => (
              <SelectItem key={value} value={String(value)}>
                {value === 0
                  ? t("behavior.automaticProcessing.off")
                  : t("behavior.automaticProcessing.notes", { count: value })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );
}

/**
 * Restore app preferences to their defaults after confirmation. Anima
 * settings, chats, memories, content, provider keys and the display name are
 * untouched; the last opened Anima and locale are kept.
 */
export function ResetAppSettingsSetting({
  onReset,
}: {
  /** Called after a successful reset, e.g. to close App Settings so every control reloads. */
  onReset?: () => void;
}) {
  const { t } = useTranslation("settings");
  const { updateUserSettings, userPreferences } = useSettings();
  const { setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  const reset = async () => {
    setResetting(true);
    try {
      await updateUserSettings({
        // First-message suggestion state is product history, not a setting.
        preferences: userPreferences?.has_sent_chat_message
          ? { has_sent_chat_message: true }
          : {},
        theme: "light",
      });
      // Apply locally too, so the stored-theme sync cannot mistake the reset
      // for an echo of an earlier save.
      setTheme("light");
      // The microphone choice is stored on this machine, not in preferences.
      writeSelectedMicrophoneId(null);
      setOpen(false);
      toast.success(t("data.reset.succeeded"));
      onReset?.();
    } catch {
      toast.error(t("data.reset.failed"));
    } finally {
      setResetting(false);
    }
  };

  return (
    <SettingsRow
      label={t("data.reset.label")}
      description={t("data.reset.description")}
      control={
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button type="button" variant="outline">
              {t("data.reset.open")}
            </Button>
          </DialogTrigger>
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>{t("data.reset.confirmTitle")}</DialogTitle>
              <DialogDescription>
                {t("data.reset.confirmDescription")}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="ghost" disabled={resetting}>
                  {t("actions.cancel")}
                </Button>
              </DialogClose>
              <Button
                type="button"
                variant="destructive"
                disabled={resetting}
                onClick={() => void reset()}
              >
                {resetting
                  ? t("data.reset.resetting")
                  : t("data.reset.confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      }
    />
  );
}

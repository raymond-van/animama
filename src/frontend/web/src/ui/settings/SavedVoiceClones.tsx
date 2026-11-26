import { Check } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { PyVoiceContent } from "@animama/runtime-contracts/api-types";

import { toTtsProvider } from "@/lib/speech/tts-provider";
import { useAnima } from "@/query/hooks/useAnima";
import { useAnimaLoadout } from "@/query/hooks/useAnimaLoadout";
import { useVoiceClones } from "@/query/hooks/useVoiceClones";
import { useVoiceSelection } from "@/query/mutations/useVoiceSelection";
import { Button } from "@/ui/components/button";
import { useSettings } from "@/ui/settings/SettingsProvider";

/**
 * The owner's saved voice clones in App Settings → Voice. Cloning there saves
 * a voice without choosing it for anyone, so the list offers the step that
 * follows: use a clone for the Anima these settings were opened from, when
 * that Anima speaks with PocketTTS (the only provider that uses a clone). Like
 * any loadout change it applies from the next chat mount, which the success
 * message says. The hint stays for every other case: each Anima chooses its
 * voice under Voices on its own page.
 */
export function SavedVoiceClones({ busy = false }: { busy?: boolean }) {
  const { t } = useTranslation("animas");
  const { animaId, effectivePreferences } = useSettings();
  const library = useVoiceClones();
  const { data: anima } = useAnima(animaId);
  const loadout = useAnimaLoadout(animaId);
  const selectVoice = useVoiceSelection(animaId);
  const [saving, setSaving] = useState<string | null>(null);
  const clones = library.data ?? [];
  if (clones.length === 0) return null;

  const selectedId = loadout.data?.voice_source?.catalog_item_id ?? null;
  const usable =
    Boolean(anima) &&
    loadout.data !== undefined &&
    toTtsProvider(effectivePreferences.speech?.tts_provider) === "pocket_tts";

  const use = async (clone: PyVoiceContent) => {
    if (!anima || !loadout.data || saving) return;
    setSaving(clone.item_id);
    try {
      await selectVoice.mutateAsync({
        clone,
        expectedRevision: loadout.data.revision,
      });
      toast.success(
        t("voices.cloning.usedFor", {
          voice: clone.name,
          anima: anima.display_name,
        }),
      );
    } catch {
      toast.error(t("voices.pocket.selectFailed"));
    } finally {
      setSaving(null);
    }
  };

  return (
    <section
      className="space-y-2"
      aria-label={t("voices.picker.clonesHeading")}
    >
      <h5 className="text-muted-foreground text-xs font-semibold">
        {t("voices.picker.clonesHeading")}
      </h5>
      <ul className="divide-border/60 divide-y">
        {clones.map((clone) => (
          <li
            key={clone.item_id}
            className="flex flex-wrap items-center justify-between gap-2 py-1.5"
          >
            <span className="min-w-0 truncate text-sm">{clone.name}</span>
            {usable && anima ? (
              selectedId === clone.item_id ? (
                <span className="text-muted-foreground flex items-center gap-1 text-xs">
                  <Check className="size-3.5" aria-hidden />
                  {t("voices.cloning.usedBy", { anima: anima.display_name })}
                </span>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || saving !== null}
                  onClick={() => void use(clone)}
                >
                  {t("voices.cloning.useFor", { anima: anima.display_name })}
                </Button>
              )
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-xs">
        {t("voices.cloning.chooseHint")}
      </p>
    </section>
  );
}

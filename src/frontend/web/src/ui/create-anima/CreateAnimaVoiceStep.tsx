import { useProductApiClient } from "@animama/product-ui";
import { useFormatters } from "@animama/product-ui/i18n";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { usePocketVoiceDownloads } from "@/hooks/usePocketVoiceDownloads";
import {
  DEFAULT_POCKET_VOICE,
  POCKET_VOICES,
} from "@/lib/speech/pocket/voice-catalog";
import { voiceCloneSampleSource } from "@/lib/speech/pocket/voice-clones";
import { resolvePocketVoicePreference } from "@/lib/speech/pocket/voice-preferences";
import {
  useAllAnimaSettings,
  type AnimaWithSettings,
} from "@/query/hooks/useAnimaSettings";
import { useVoiceClones } from "@/query/hooks/useVoiceClones";
import { PocketVoicePicker } from "@/ui/animas/PocketVoicePicker";
import { VoiceCloneLibrary } from "@/ui/animas/VoiceCloneLibrary";
import {
  ContentDeleteDialog,
  type ContentToDelete,
} from "@/ui/content-delete/ContentDeleteDialog";
import { elevenLabsVoiceId } from "@/ui/animas/VoiceLoadoutSection";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { ModelLink } from "@/ui/components/model-link";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components/select";
import { useSettings } from "@/ui/settings/SettingsProvider";
import { SpeechLanguageNotice } from "@/ui/settings/SpeechLanguageNotice";
import type { CreateAnimaDraft, DraftEdit } from "./createAnimaDraft";
import { WordedError } from "@/lib/errors/apiError";

/** ElevenLabs' public voice library, where owners find voices to add. */
export const ELEVENLABS_VOICE_LIBRARY =
  "https://elevenlabs.io/app/voice-library";

/** A saved ElevenLabs voice ID and the Animas that use it. */
export type ReusableElevenLabsVoice = { voiceId: string; names: string[] };

/**
 * The distinct ElevenLabs voice IDs saved on existing Animas, in Anima list
 * order, so a new Anima can reuse one without copying it by hand.
 */
export function reusableElevenLabsVoices(
  animas: readonly AnimaWithSettings[],
): ReusableElevenLabsVoice[] {
  const voices = new Map<string, string[]>();
  for (const anima of animas) {
    const preferences = anima.settings.preferences as
      | { speech?: { [key: string]: unknown } }
      | undefined;
    const voiceId = elevenLabsVoiceId(preferences?.speech);
    if (!voiceId) continue;
    voices.set(voiceId, [...(voices.get(voiceId) ?? []), anima.displayName]);
  }
  return [...voices].map(([voiceId, names]) => ({ voiceId, names }));
}

/** Shared library writes are explicit; provider/voice selection only edits this draft. */
export function CreateAnimaVoiceStep({
  draft,
  onChange,
  disabled,
  onBusyChange,
}: {
  draft: CreateAnimaDraft;
  onChange: (patch: DraftEdit) => void;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation("create");
  const apiClient = useProductApiClient();

  const { effectivePreferences, isLoading } = useSettings();
  const voice = draft.voice;
  const library = useVoiceClones({ enabled: voice?.provider === "pocket_tts" });
  const downloads = usePocketVoiceDownloads({
    enabled: voice?.provider === "pocket_tts",
  });
  const [cloning, setCloning] = useState(false);
  const [deleting, setDeleting] = useState<ContentToDelete | null>(null);
  const formatters = useFormatters();
  // Other Animas' settings load only once ElevenLabs is chosen.
  const reusable = reusableElevenLabsVoices(
    useAllAnimaSettings({ enabled: voice?.provider === "elevenlabs" }),
  );
  useEffect(() => {
    if (voice || isLoading || disabled) return;
    const speech = effectivePreferences.speech;
    const preset = resolvePocketVoicePreference(speech);
    onChange({
      voice: {
        provider:
          speech?.tts_provider === "elevenlabs" ? "elevenlabs" : "pocket_tts",
        pocket: {
          type: "preset",
          voice_id: POCKET_VOICES.some((item) => item.id === preset)
            ? preset!
            : DEFAULT_POCKET_VOICE,
        },
        elevenlabs_voice_id: elevenLabsVoiceId(speech) || null,
      },
    });
  }, [voice, isLoading, disabled, effectivePreferences.speech, onChange]);
  if (!voice) return <p role="status">{t("voiceStep.loading")}</p>;
  const clones = library.data ?? [];
  const selectedId =
    voice.pocket.type === "clone" ? voice.pocket.source.item_id : null;
  const selected = selectedId
    ? `clone:${selectedId}`
    : voice.pocket.type === "preset"
      ? voice.pocket.voice_id
      : DEFAULT_POCKET_VOICE;
  const select = async (id: string) => {
    if (disabled || cloning) throw new WordedError(t("voiceStep.busy"));
    if (id.startsWith("clone:")) {
      const clone = clones.find((item) => `clone:${item.item_id}` === id);
      if (!clone) throw new WordedError(t("voiceStep.cloneUnavailable"));
      onChange({
        voice: {
          ...voice,
          pocket: {
            type: "clone",
            source: {
              item_id: clone.item_id,
              revision_sha256: clone.revision_sha256,
            },
          },
        },
        evidence: Object.fromEntries(
          Object.entries(draft.evidence).filter(([id]) => id !== clone.item_id),
        ),
      });
    } else {
      onChange({
        voice: { ...voice, pocket: { type: "preset", voice_id: id } },
      });
      const state = downloads.availability(id);
      if (state?.status === "not_installed" || state?.status === "failed")
        downloads.install(state.assetId);
    }
  };
  return (
    <section
      id="creation-voice"
      tabIndex={-1}
      className="space-y-6"
      aria-label={t("voiceStep.label")}
    >
      <div className="flex items-center justify-between gap-4">
        <label
          htmlFor="creation-tts-provider"
          className="text-sm font-semibold"
        >
          {t("voiceStep.provider")}
        </label>
        <Select
          value={voice.provider}
          disabled={disabled}
          onValueChange={(provider) => {
            if (provider === "pocket_tts" || provider === "elevenlabs")
              onChange({ voice: { ...voice, provider } });
          }}
        >
          <SelectTrigger
            id="creation-tts-provider"
            aria-label={t("voiceStep.provider")}
            className="w-48 min-w-0"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pocket_tts">
              {t("voiceStep.providers.pocketTts")}
            </SelectItem>
            <SelectItem value="elevenlabs">
              {t("voiceStep.providers.elevenLabs")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <SpeechLanguageNotice
        direction="textToSpeech"
        provider={voice.provider}
      />
      {voice.provider === "pocket_tts" ? (
        <div className="space-y-6">
          <div className="space-y-3">
            <h2 className="text-sm font-semibold">
              {t("voiceStep.pocketVoice")}
            </h2>
            <PocketVoicePicker
              value={selected}
              disabled={disabled || library.isPending || library.isError}
              hasCustomVoice={false}
              clones={clones.map(voiceCloneSampleSource.bind(null, apiClient))}
              unavailableSelection={
                selectedId &&
                !clones.some((clone) => clone.item_id === selectedId)
                  ? t("voiceStep.savedVoiceUnavailable")
                  : undefined
              }
              onDeleteClone={(id, focus) => {
                const clone = clones.find(
                  (candidate) => `clone:${candidate.item_id}` === id,
                );
                if (clone)
                  setDeleting({
                    itemId: clone.item_id,
                    kind: "voice",
                    name: clone.name,
                    revision: clone.revision_sha256,
                    focus,
                  });
              }}
              onSelect={select}
              availability={downloads.availability}
              onDownload={downloads.install}
              onRemove={downloads.remove}
              downloadBusy={downloads.busy}
              downloadBlockedReason={downloads.blockedReason}
              downloadError={downloads.error}
              retryAssetIds={downloads.retryAssetIds}
              operatorManaged={downloads.operatorManaged}
              downloadsEnded={downloads.downloadsEnded}
            />
            {selectedId &&
            !library.isPending &&
            !library.isError &&
            !clones.some((clone) => clone.item_id === selectedId) ? (
              <p role="alert" className="text-destructive text-sm">
                {t("voiceStep.chooseAnother")}
              </p>
            ) : null}
            {library.isError ? (
              <div role="alert" className="space-y-2 text-sm">
                <p>{t("voiceStep.loadFailed")}</p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void library.refetch()}
                >
                  {t("voiceStep.retry")}
                </Button>
              </div>
            ) : null}
          </div>
          <ContentDeleteDialog
            item={deleting}
            onClose={() => setDeleting(null)}
          />
          <VoiceCloneLibrary
            disabled={(disabled && !cloning) || library.isError}
            onBusyChange={(busy) => {
              setCloning(busy);
              onBusyChange(busy);
            }}
          />
        </div>
      ) : (
        <div className="space-y-2">
          <label
            htmlFor="creation-elevenlabs-id"
            className="text-sm font-semibold"
          >
            {t("voiceStep.elevenLabsId")}
          </label>
          <Input
            id="creation-elevenlabs-id"
            placeholder={t("voiceStep.elevenLabsPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            value={voice.elevenlabs_voice_id ?? ""}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                voice: {
                  ...voice,
                  elevenlabs_voice_id: event.target.value.trim() || null,
                },
              })
            }
          />
          <p className="text-muted-foreground text-xs">
            <Trans
              t={t}
              i18nKey="voiceStep.elevenLabsLibrary"
              components={{
                link: <ModelLink href={ELEVENLABS_VOICE_LIBRARY} />,
              }}
            />
          </p>
          {reusable.length ? (
            <Select
              // Shows the Animas whose voice is entered, else the prompt.
              value={
                reusable.some(
                  (item) => item.voiceId === voice.elevenlabs_voice_id,
                )
                  ? (voice.elevenlabs_voice_id ?? "")
                  : ""
              }
              disabled={disabled}
              onValueChange={(voiceId) =>
                onChange({ voice: { ...voice, elevenlabs_voice_id: voiceId } })
              }
            >
              <SelectTrigger
                aria-label={t("voiceStep.reuseVoice")}
                className="w-full min-w-0"
              >
                <SelectValue placeholder={t("voiceStep.reuseVoice")} />
              </SelectTrigger>
              <SelectContent>
                {reusable.map((item) => (
                  <SelectItem key={item.voiceId} value={item.voiceId}>
                    {t("voiceStep.reuseVoiceOption", {
                      names: formatters.list(item.names),
                      id: item.voiceId,
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
      )}
    </section>
  );
}

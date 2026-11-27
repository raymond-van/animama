import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@animama/product-ui/i18n";
import {
  Check,
  ChevronDown,
  Download,
  LoaderCircle,
  Trash2,
} from "lucide-react";

import {
  POCKET_VOICES,
  type PocketVoiceGender,
} from "@/lib/speech/pocket/voice-catalog";
import {
  pocketVoiceAccentLabel,
  pocketVoiceLabel,
} from "@/lib/speech/pocket/voice-groups";
import {
  POCKET_TTS_CUSTOM_VOICE,
  type PocketVoiceAvailability,
} from "@/lib/speech/pocket/voice-preferences";
import {
  createVoiceSamplePlayer,
  IDLE_VOICE_SAMPLE,
  type VoiceSampleSource,
} from "@/lib/speech/pocket/voice-sample-player";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/components/button";
import type { DeleteFocusTargets } from "@/ui/components/useDeleteReturnFocus";
import { Input } from "@/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/components/popover";
import { Checkbox } from "@/ui/components/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/components/tabs";
import {
  modelDownloadsEndedNote,
  operatorManagedModelsNote,
} from "@/ui/settings/operator-managed-models";
import {
  VoiceSampleButton,
  type VoiceSamplePlayback,
} from "./VoiceSampleButton";

type VoiceFilter = {
  gender: "any" | PocketVoiceGender;
  recommended: boolean;
  search: string;
};

/**
 * The list is metadata-only: browsing never initializes the speech engine.
 * Search matches the accent as shown and as authored in English.
 */
export function filteredPocketVoices({
  gender,
  recommended,
  search,
}: VoiceFilter) {
  const query = search.trim().toLocaleLowerCase();
  return POCKET_VOICES.filter(
    (voice) =>
      (gender === "any" || voice.gender === gender) &&
      (!recommended || voice.recommended) &&
      [
        voice.name,
        voice.accent ?? "",
        voice.accent ? pocketVoiceAccentLabel(voice.accent) : "",
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query),
  );
}

type PocketVoicePickerProps = {
  value: string;
  disabled: boolean;
  hasCustomVoice: boolean;
  clones?: VoiceSampleSource[];
  unavailableSelection?: string;
  onSelect: (id: string) => Promise<void>;
  /** Open a clone's delete confirmation, returning focus to `focus`. */
  onDeleteClone?: (id: string, focus: DeleteFocusTargets) => void;
  availability: (id: string) => PocketVoiceAvailability | null;
  onDownload: (assetId: string) => void;
  onRemove?: (assetId: string) => void;
  downloadBusy?: boolean;
  downloadBlockedReason?: string | null;
  downloadError?: string | null;
  retryAssetIds?: ReadonlySet<string>;
  /** The runtime's operator provides voices; none is downloaded here. */
  operatorManaged?: boolean;
  /** Downloads have ended; only installed and built-in voices can be chosen. */
  downloadsEnded?: boolean;
};

/**
 * Whether a downloadable voice is unavailable because this app never
 * downloads it: the operator provides voices and did not provide this one, or
 * downloads have ended and it was never installed. A state that is still
 * loading (`unknown`) is not treated as unavailable.
 */
export function pocketVoiceNotProvided(
  availability: PocketVoiceAvailability | null,
  noDownloads: boolean,
): boolean {
  return (
    noDownloads &&
    availability !== null &&
    availability.status !== "installed" &&
    availability.status !== "unknown"
  );
}

/** A compact selected voice opens a keyboard-accessible list with independent actions. */
export function PocketVoicePicker(props: PocketVoicePickerProps) {
  const { t } = useTranslation("animas");
  const [open, setOpen] = useState(false);
  const [sample, setSample] = useState(IDLE_VOICE_SAMPLE);
  const player = useMemo(() => createVoiceSamplePlayer(setSample), []);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Focus returns to the button that asked, or to the picker once the list
  // that asked has closed or the clone is gone.
  const deleteClone = props.onDeleteClone
    ? (id: string, opener: HTMLElement | null) =>
        props.onDeleteClone?.(id, {
          kept: () => (opener?.isConnected ? opener : triggerRef.current),
          deleted: () => triggerRef.current,
        })
    : undefined;
  useEffect(() => () => player.dispose(), [player]);
  useEffect(() => player.stop(), [player, props.value]);
  const voice =
    props.clones?.find((item) => item.id === props.value) ??
    POCKET_VOICES.find((item) => item.id === props.value);
  const selectedName =
    voice?.name ??
    props.unavailableSelection ??
    (props.value === POCKET_TTS_CUSTOM_VOICE
      ? t("voices.picker.customUploaded")
      : pocketVoiceLabel(props.value));
  const changeOpen = (next: boolean) => {
    player.stop();
    setOpen(next);
  };
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <div className="flex items-center gap-2">
        <PopoverTrigger asChild>
          <Button
            ref={triggerRef}
            variant="outline"
            disabled={props.disabled}
            className="min-w-0 flex-1 justify-between"
            aria-label={t("voices.picker.trigger", { name: selectedName })}
          >
            <span className="truncate">{selectedName}</span>
            <ChevronDown className="size-4 shrink-0 opacity-60" />
          </Button>
        </PopoverTrigger>
        <VoiceSampleButton voice={voice} sample={sample} player={player} />
        {voice &&
        props.clones?.some((clone) => clone.id === voice.id) &&
        deleteClone ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-destructive hover:text-destructive"
            aria-label={t("voices.picker.delete", { name: voice.name })}
            disabled={props.disabled}
            onClick={(event) => {
              player.stop();
              deleteClone(voice.id, event.currentTarget);
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        ) : null}
      </div>
      {!open && voice && "sampleUnavailable" in voice ? (
        <p className="text-muted-foreground text-xs">
          {voice.sampleUnavailable}
        </p>
      ) : null}
      {!open && sample.error ? (
        <p role="alert" className="text-destructive text-xs">
          {sample.error}
        </p>
      ) : null}
      <PopoverContent
        align="start"
        className="flex max-h-[var(--radix-popover-content-available-height)] w-[min(30rem,var(--radix-popover-content-available-width))] flex-col p-0"
        aria-label={t("voices.picker.listLabel")}
      >
        {open ? (
          <PocketVoiceList
            {...props}
            onDeleteClone={
              deleteClone ? (id) => deleteClone(id, null) : undefined
            }
            sample={sample}
            player={player}
            onSelected={() => changeOpen(false)}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** The selected voice and list share one player, owned by the picker. */
export function PocketVoiceList({
  value,
  disabled,
  hasCustomVoice,
  clones = [],
  onSelect,
  availability,
  onDownload,
  onRemove,
  downloadBusy,
  downloadBlockedReason,
  downloadError,
  retryAssetIds,
  operatorManaged = false,
  downloadsEnded = false,
  onDeleteClone,
  onSelected,
  sample,
  player,
}: Omit<PocketVoicePickerProps, "onDeleteClone"> &
  VoiceSamplePlayback & {
    onSelected: () => void;
    /** The list closes before the confirmation opens. */
    onDeleteClone?: (id: string) => void;
  }) {
  const { t } = useTranslation("animas");
  const formatters = useFormatters();
  const [gender, setGender] = useState<VoiceFilter["gender"]>("any");
  const [recommended, setRecommended] = useState(false);
  const [search, setSearch] = useState("");
  const [customOnly, setCustomOnly] = useState(false);
  // Saved clones have no gender/recommendation metadata. Preserve the preset
  // filters while browsing custom voices, and still apply the search to both.
  const tab = customOnly ? "any" : gender;
  const voices = customOnly
    ? []
    : filteredPocketVoices({ gender, recommended, search });
  const showCustom = customOnly || (gender === "any" && !recommended);
  const query = search.trim().toLocaleLowerCase();
  const filterLabel = customOnly
    ? t("voices.picker.filters.custom")
    : gender === "any"
      ? t("voices.picker.filters.any")
      : gender === "female"
        ? t("voices.picker.filters.female")
        : t("voices.picker.filters.male");
  const customUploadedLabel = t("voices.picker.customUploaded");
  // Match the label as shown and its English name, which voice docs use.
  const showUploaded =
    showCustom &&
    hasCustomVoice &&
    (customUploadedLabel.toLocaleLowerCase().includes(query) ||
      "custom (uploaded)".includes(query));
  const matchingClones = showCustom
    ? clones.filter((clone) =>
        clone.name
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()),
      )
    : [];
  const count = voices.length + matchingClones.length + Number(showUploaded);
  const notProvided = (voiceId: string) =>
    pocketVoiceNotProvided(
      availability(voiceId),
      operatorManaged || downloadsEnded,
    );
  const footer =
    downloadBlockedReason ||
    downloadError ||
    (voices.some((voice) => notProvided(voice.id))
      ? operatorManaged
        ? operatorManagedModelsNote()
        : modelDownloadsEndedNote()
      : null);
  const choose = async (id: string) => {
    try {
      await onSelect(id);
      onSelected();
    } catch {
      // The owner reports persistence errors; keep the picker available to retry.
    }
  };
  return (
    <Tabs
      value={tab}
      onValueChange={(next) => {
        player.stop();
        setGender(next as VoiceFilter["gender"]);
      }}
      className="flex min-h-0 flex-col"
    >
      <div className="flex shrink-0 flex-col gap-3 border-b p-3">
        <Input
          aria-label={t("voices.picker.searchLabel")}
          placeholder={t("voices.picker.search")}
          value={search}
          onChange={(event) => {
            player.stop();
            setSearch(event.target.value);
          }}
        />
        <TabsList
          className="grid w-full grid-cols-3"
          aria-label={t("voices.picker.gender.label")}
        >
          <TabsTrigger value="any" disabled={customOnly}>
            {t("voices.picker.gender.any")}
          </TabsTrigger>
          <TabsTrigger value="female" disabled={customOnly}>
            {t("voices.picker.gender.female")}
          </TabsTrigger>
          <TabsTrigger value="male" disabled={customOnly}>
            {t("voices.picker.gender.male")}
          </TabsTrigger>
        </TabsList>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
          <label className="flex items-center gap-2">
            <Checkbox
              aria-label={t("voices.picker.recommendedOnly")}
              checked={recommended && !customOnly}
              disabled={customOnly}
              onCheckedChange={(checked) => {
                player.stop();
                setRecommended(checked === true);
              }}
            />
            <span className={customOnly ? "text-muted-foreground" : undefined}>
              {t("voices.picker.recommendedOnly")}
            </span>
          </label>
          <label className="flex items-center gap-2">
            <Checkbox
              aria-label={t("voices.picker.custom")}
              checked={customOnly}
              onCheckedChange={(checked) => {
                player.stop();
                setCustomOnly(checked === true);
              }}
            />
            {t("voices.picker.custom")}
          </label>
        </div>
      </div>
      <div
        className="text-muted-foreground flex shrink-0 items-center justify-between px-4 py-2 text-xs"
        aria-live="polite"
      >
        <span>
          {recommended && !customOnly
            ? t("voices.picker.filtersRecommended", { filter: filterLabel })
            : filterLabel}
        </span>
        <span>{t("voices.picker.count", { count })}</span>
      </div>
      <TabsContent value={tab} className="mt-0 min-h-0 overflow-y-auto">
        <div
          className="max-h-[min(22rem,45dvh)] min-h-0 overflow-y-auto overscroll-contain px-2 pb-2"
          role="list"
          aria-label={t("voices.picker.available")}
        >
          {matchingClones.length ? (
            <p className="text-muted-foreground px-3 py-2 text-xs font-semibold">
              {t("voices.picker.clonesHeading")}
            </p>
          ) : null}
          {matchingClones.map((clone) => (
            <div
              key={clone.id}
              role="listitem"
              className={cn(
                "flex items-center gap-1 rounded-lg px-1",
                value === clone.id && "bg-muted/60",
              )}
            >
              <button
                type="button"
                disabled={disabled}
                onClick={() => void choose(clone.id)}
                aria-label={t("voices.picker.select", { name: clone.name })}
                aria-pressed={value === clone.id}
                className="hover:bg-muted/40 focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2.5 text-left outline-none focus-visible:ring-2 disabled:opacity-50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {clone.name}
                  </span>
                  {"sampleUnavailable" in clone ? (
                    <span className="text-muted-foreground block text-xs">
                      {clone.sampleUnavailable}
                    </span>
                  ) : null}
                </span>
                {value === clone.id ? (
                  <Check className="size-4 shrink-0" />
                ) : null}
              </button>
              <VoiceSampleButton
                voice={clone}
                sample={sample}
                player={player}
                compact
              />
              {onDeleteClone ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-destructive hover:text-destructive shrink-0"
                  aria-label={t("voices.picker.delete", { name: clone.name })}
                  disabled={disabled}
                  onClick={() => {
                    player.stop();
                    onSelected();
                    onDeleteClone(clone.id);
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              ) : (
                <div className="w-8 shrink-0" />
              )}
            </div>
          ))}
          {matchingClones.length && voices.length ? (
            <p className="text-muted-foreground px-3 py-2 text-xs font-semibold">
              {t("voices.picker.pocketHeading")}
            </p>
          ) : null}
          {voices.map((voice) => {
            const download = availability(voice.id);
            const unavailable = notProvided(voice.id);
            const downloading = download?.status === "downloading";
            // Operator-provided voices are never downloaded here, and no
            // voice is once downloads have ended.
            const needsDownload =
              !operatorManaged &&
              !downloadsEnded &&
              download &&
              download.status !== "installed";
            const retry =
              download?.status === "failed" ||
              Boolean(download && retryAssetIds?.has(download.assetId));
            const progress = Math.round((download?.progress ?? 0) * 100);
            const percent = formatters.number(progress / 100, {
              style: "percent",
            });
            const downloadStatus =
              progress === 100
                ? t("voices.picker.verifying")
                : t("voices.picker.downloadingTitle", { percent });
            const cancel = downloading && onRemove;
            return (
              <div
                key={voice.id}
                role="listitem"
                className={cn(
                  "flex items-center gap-1 rounded-lg px-1",
                  value === voice.id && "bg-muted/60",
                )}
              >
                <button
                  type="button"
                  disabled={disabled || unavailable}
                  onClick={() => void choose(voice.id)}
                  aria-label={t("voices.picker.select", { name: voice.name })}
                  aria-pressed={value === voice.id}
                  className="hover:bg-muted/40 focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2.5 text-left outline-none focus-visible:ring-2 disabled:opacity-50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{voice.name}</p>
                    <p className="text-muted-foreground text-xs">
                      {[
                        voice.accent
                          ? pocketVoiceAccentLabel(voice.accent)
                          : null,
                        voice.recommended
                          ? t("voices.picker.recommended")
                          : null,
                        unavailable ? t("voices.picker.notAvailable") : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  {value === voice.id ? (
                    <Check className="size-4 shrink-0" />
                  ) : null}
                </button>
                <VoiceSampleButton
                  voice={voice}
                  sample={sample}
                  player={player}
                  compact
                />
                <div className="flex w-8 shrink-0 justify-center">
                  {needsDownload ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={
                        !cancel &&
                        (disabled ||
                          downloadBusy ||
                          Boolean(downloadBlockedReason) ||
                          downloading ||
                          download.status === "unknown")
                      }
                      aria-label={
                        cancel
                          ? t("voices.picker.downloadCancel", {
                              name: voice.name,
                            })
                          : downloading
                            ? t("voices.picker.downloading", {
                                name: voice.name,
                                percent,
                              })
                            : retry
                              ? t("voices.picker.downloadRetry", {
                                  name: voice.name,
                                })
                              : t("voices.picker.download", {
                                  name: voice.name,
                                })
                      }
                      title={
                        downloading
                          ? cancel
                            ? t("voices.picker.titleWithCancel", {
                                status: downloadStatus,
                              })
                            : downloadStatus
                          : retry
                            ? t("voices.picker.downloadRetry", {
                                name: voice.name,
                              })
                            : t("voices.picker.download", { name: voice.name })
                      }
                      onClick={() =>
                        cancel
                          ? onRemove(download.assetId)
                          : onDownload(download.assetId)
                      }
                    >
                      {downloading || download.status === "unknown" ? (
                        <LoaderCircle className="animate-spin motion-reduce:animate-none" />
                      ) : (
                        <Download
                          className={retry ? "text-destructive" : undefined}
                        />
                      )}
                    </Button>
                  ) : !voice.assetId || download?.status === "installed" ? (
                    <span
                      role="img"
                      aria-label={
                        !voice.assetId
                          ? t("voices.picker.included", { name: voice.name })
                          : operatorManaged
                            ? t("voices.picker.availableState", {
                                name: voice.name,
                              })
                            : t("voices.picker.downloaded", {
                                name: voice.name,
                              })
                      }
                      title={
                        !voice.assetId
                          ? t("voices.picker.includedTitle")
                          : operatorManaged
                            ? t("voices.picker.availableTitle")
                            : t("voices.picker.downloadedTitle")
                      }
                      className="text-muted-foreground flex size-8 items-center justify-center"
                    >
                      <Check className="size-4" aria-hidden="true" />
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
          {!count ? (
            <p className="text-muted-foreground px-3 py-5 text-sm">
              {t("voices.picker.noMatch")}
            </p>
          ) : null}
          {showUploaded ? (
            <Button
              variant="ghost"
              className="w-full justify-start"
              disabled={disabled}
              onClick={() => void choose("custom")}
            >
              {customUploadedLabel}
              {value === "custom" ? <Check /> : null}
            </Button>
          ) : null}
        </div>
      </TabsContent>
      {footer ? (
        <p
          role="status"
          className="text-muted-foreground shrink-0 border-t px-4 py-3 text-xs"
        >
          {footer}
        </p>
      ) : null}
      {sample.error ? (
        <p
          role="alert"
          className="text-destructive shrink-0 border-t px-4 py-3 text-xs"
        >
          {sample.error}
        </p>
      ) : null}
    </Tabs>
  );
}

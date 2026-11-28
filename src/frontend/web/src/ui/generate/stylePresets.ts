import type { TFunction } from "i18next";

/**
 * The style presets a conversation with the content assistant may hold
 * (R8.5), by id and in the order the page lists them. The page sends a
 * preset's id and nothing else: the sentence a model reads is the backend's
 * own. The backend keeps the same ids, and both are tested against the shared
 * fixture `fixtures/style-presets.json`.
 */
export const GENERATION_STYLE_PRESETS = [
  "anime_expressive",
  "soft_natural",
  "cute_playful",
  "cool_composed",
  "dramatic_theatrical",
] as const;

export type GenerationStylePresetId = (typeof GENERATION_STYLE_PRESETS)[number];

/**
 * A stored preset id as the page knows it. `null` for no style, and for an id
 * this build does not list (one stored by another build): the backend then
 * adds nothing either, so it shows as None.
 */
export function knownStylePreset(
  value: string | null | undefined,
): GenerationStylePresetId | null {
  return GENERATION_STYLE_PRESETS.find((preset) => preset === value) ?? null;
}

/** A preset's name, in the UI Locale. */
export function stylePresetName(
  t: TFunction<"generate">,
  preset: GenerationStylePresetId,
): string {
  switch (preset) {
    case "anime_expressive":
      return t("style.presets.animeExpressive");
    case "soft_natural":
      return t("style.presets.softNatural");
    case "cute_playful":
      return t("style.presets.cutePlayful");
    case "cool_composed":
      return t("style.presets.coolComposed");
    case "dramatic_theatrical":
      return t("style.presets.dramaticTheatrical");
  }
}

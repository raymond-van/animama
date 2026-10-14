import { parseAvatarEffectDefinition } from "./definition";
import type { AvatarVFXParsedEntry } from "./types";

/**
 * An Avatar Effect as the review tools load it from a descriptor on disk
 * (`effects:render`, `effects:bench` and the headed `animation:preview`): its
 * stored `/2` definition and the URLs that serve its images to the page.
 */
export type EffectSource = {
  stem: string;
  contentId: string;
  name: string;
  description: string;
  definition: Record<string, unknown>;
  imageUrl: string;
  /** Served `art.otherEyeImage`, when the definition names one. */
  otherImageUrl: string | null;
  /**
   * The sound cue a clip event plays when it applies the effect (the content
   * id its `soundAlias` dependency names), or null for a silent effect.
   */
  soundCueId?: string | null;
};

/**
 * Parse a source the same way runtime catalog loading parses a stored `/2`
 * definition. `id` is the runtime id: the content id for a source applied on
 * its own, or the dependency alias a clip event names. Throws
 * `AvatarEffectDefinitionError` with the offending field.
 */
export function effectSourceEntry(
  effect: EffectSource,
  id: string = effect.contentId,
): AvatarVFXParsedEntry {
  return parseAvatarEffectDefinition(effect.definition, {
    id,
    label: effect.name,
    description: effect.description || effect.name,
    assetPath: effect.imageUrl,
    ...(effect.otherImageUrl
      ? { otherEyeAssetPath: effect.otherImageUrl }
      : {}),
    ...(effect.soundCueId ? { sound: { onApply: effect.soundCueId } } : {}),
  });
}

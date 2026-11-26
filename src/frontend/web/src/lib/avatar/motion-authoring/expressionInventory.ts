import { VRMExpressionPresetName } from "@pixiv/three-vrm";

import { ARKIT_BLENDSHAPES } from "../arkit";
import { resolvePartExpressionFallbacks } from "../partExpressionFallback";
import { isVroidMoodPart } from "../vroidMoodParts";
import type { AnimaPoseClipV2 } from "../poses/animaPoseClip";

/**
 * An Avatar's expression names as an authoring assistant is told them: by
 * family, names only, and bounded. The names come from an Avatar file, which
 * can name a morph target anything, so they are treated as data: a name that
 * is over-long or carries non-printing characters never leaves the page.
 */

/**
 * The families, in the order names are kept when there are too many: first
 * the two the runtime also plays on Avatars without them (presets, and VRoid
 * mood parts through their fallbacks), last an author's own shapes.
 */
export const EXPRESSION_FAMILIES = [
  /** VRM's preset expressions (`happy`, `blink`, `aa` …). */
  "vrmPresets",
  /**
   * VRoid's mood parts (`Fcl_BRW_Joy`, `Fcl_ALL_Fun` …), which every Avatar
   * plays. A VRoid model's other `Fcl_*` shapes are its own.
   */
  "vroidParts",
  /** Apple's ARKit face shapes under their canonical names (`jawOpen` …). */
  "arkit",
  /** MMD morphs and any other shape named in kana or kanji (`まばたき` …). */
  "mmd",
  /** Everything else: shapes the Avatar's author named. */
  "custom",
] as const;

export type ExpressionFamily = (typeof EXPRESSION_FAMILIES)[number];

export type ExpressionInventory = {
  /** The kept names of each family, in the order they were given. */
  families: Record<ExpressionFamily, string[]>;
  /**
   * How many distinct names were left out: empty, longer than
   * {@link MAX_EXPRESSION_NAME_LENGTH}, carrying a non-printing character, or
   * beyond {@link MAX_EXPRESSION_NAMES}.
   */
  dropped: number;
};

/** The most names an inventory holds, over all families. */
export const MAX_EXPRESSION_NAMES = 400;
/** The longest name an inventory holds, in characters (code points). */
export const MAX_EXPRESSION_NAME_LENGTH = 64;

const VRM_PRESET_NAMES = new Set<string>(
  Object.values(VRMExpressionPresetName),
);
const KANA_OR_KANJI = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
/**
 * Unicode's "other" categories (control and format characters, lone
 * surrogates, private-use and unassigned code points) and its line and
 * paragraph separators. None belongs in a name shown to a model, and line
 * breaks or direction overrides could disguise one.
 */
const NON_PRINTING = /[\p{C}\p{Zl}\p{Zp}]/u;

/** Whether a name may be listed: non-blank, short and fully printable. */
function isListableName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    // A character is at most two UTF-16 units, so a huge name is not scanned.
    name.length <= MAX_EXPRESSION_NAME_LENGTH * 2 &&
    [...name].length <= MAX_EXPRESSION_NAME_LENGTH &&
    name.trim() !== "" &&
    !NON_PRINTING.test(name)
  );
}

/**
 * Group an Avatar's available expression names, as `getAvailableExpressions`
 * lists them, by family and bound them for an authoring request. A repeated
 * name is listed once. Unlistable names are dropped, then names beyond the
 * total cap, taking families in {@link EXPRESSION_FAMILIES} order so an
 * Avatar with hundreds of its own shapes still lists every portable one.
 *
 * @param arkitNames The names that count as ARKit shapes: the canonical 52 by
 *   default, under which the runtime registers an Avatar's own spellings.
 */
export function groupExpressionNames(
  names: Iterable<string>,
  arkitNames: Iterable<string> = ARKIT_BLENDSHAPES,
): ExpressionInventory {
  const arkit = new Set(arkitNames);
  const familyOf = (name: string): ExpressionFamily => {
    if (VRM_PRESET_NAMES.has(name)) return "vrmPresets";
    if (arkit.has(name)) return "arkit";
    if (isVroidMoodPart(name)) return "vroidParts";
    if (KANA_OR_KANJI.test(name)) return "mmd";
    return "custom";
  };

  const grouped = Object.fromEntries(
    EXPRESSION_FAMILIES.map((family) => [family, [] as string[]]),
  ) as Record<ExpressionFamily, string[]>;
  let dropped = 0;
  for (const name of new Set(names)) {
    if (isListableName(name)) grouped[familyOf(name)].push(name);
    else dropped += 1;
  }

  let room = MAX_EXPRESSION_NAMES;
  const families = { ...grouped };
  for (const family of EXPRESSION_FAMILIES) {
    const kept = grouped[family].slice(0, room);
    dropped += grouped[family].length - kept.length;
    room -= kept.length;
    families[family] = kept;
  }
  return { families, dropped };
}

/**
 * The expression names a clip keys that an Avatar would not show. A VRoid
 * whole-face, brow or eye part the Avatar lacks is not reported when its
 * mood's preset plays instead, as at playback
 * (`resolvePartExpressionFallbacks`).
 *
 * @param supports Whether the Avatar has an expression of that name.
 */
export function missingExpressionNames(
  clip: Pick<AnimaPoseClipV2, "expressions">,
  supports: (name: string) => boolean,
): string[] {
  return Object.keys(clip.expressions ?? {}).filter(
    (name) =>
      Object.keys(resolvePartExpressionFallbacks({ [name]: 1 }, supports))
        .length === 0,
  );
}

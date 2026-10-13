/**
 * Lip-sync evidence from a run's provider character timing: spoken words,
 * punctuation and audio tags, each with the window the provider gave it.
 *
 * The module is pure and provider-neutral. It reports provider times unchanged,
 * so a planner should treat two patterns as hints rather than facts:
 *
 * - a word's last character, or a turn's last characters, can run past the
 *   audio into the following pause;
 * - a tag's span can be much shorter than its effect (`[pause]` covers 60 ms,
 *   and the pause falls on the punctuation and space before it), and a laugh
 *   or sigh can continue into the space after it.
 *
 * Today's estimated lip-sync planner does not read this evidence; #468 adds a
 * planner that does.
 */

import type { TimedChar } from "./provider-speech-timing";

/**
 * How an audio tag affects the mouth:
 *
 * - `nonverbal`: a vocal sound (a laugh, sigh or gasp), a non-speech interval;
 * - `sound_effect`: a sound that is not the voice, an interval with the mouth at
 *   rest;
 * - `pacing`: a pause, a silent interval;
 * - `delivery`: an emotion or delivery direction, a zero-width marker at the
 *   span's start that applies to the words after it. Unknown tags are delivery.
 */
export type AudioTagClass =
  | "nonverbal"
  | "sound_effect"
  | "pacing"
  | "delivery";

/** An entry's place in the timeline: characters `charStart` up to `charEnd`. */
type TimelineSpan = {
  startSec: number;
  endSec: number;
  charStart: number;
  charEnd: number;
};

/**
 * A spoken word: a run of letters, digits and inner apostrophes (`word`), or
 * one Han, kana or Hangul character with its own window (`character`).
 */
export type EvidenceWord = TimelineSpan & {
  kind: "word" | "character";
  text: string;
};

/** Punctuation or symbols; each entry is a possible pause. */
export type EvidencePunctuation = TimelineSpan & { text: string };

/** A bracketed audio tag, which is never a word. */
export type EvidenceTag = TimelineSpan & {
  /** The tag as sent, brackets included, such as `[whispering, playful]`. */
  raw: string;
  /** Each comma-separated direction with its own class. */
  directions: Array<{ text: string; tagClass: AudioTagClass }>;
  /** The strongest direction's class: sound effect, non-verbal, pacing, then delivery. */
  tagClass: AudioTagClass;
};

export type SpeechTimingEvidence = {
  words: EvidenceWord[];
  punctuation: EvidencePunctuation[];
  tags: EvidenceTag[];
};

// Lowercase words that name each class; any other direction is delivery.
const SOUND_EFFECT_WORDS = new Set([
  "applause",
  "beep",
  "beeps",
  "bell",
  "bells",
  "clapping",
  "claps",
  "crash",
  "ding",
  "door",
  "explosion",
  "footsteps",
  "gulp",
  "gulps",
  "gunshot",
  "gunshots",
  "knock",
  "knocking",
  "knocks",
  "phone",
  "rain",
  "ringing",
  "splash",
  "swallows",
  "thunder",
  "wind",
]);
const NONVERBAL_WORDS = new Set([
  "breath",
  "breathes",
  "breathing",
  "chuckle",
  "chuckles",
  "chuckling",
  "cough",
  "coughing",
  "coughs",
  "cries",
  "cry",
  "crying",
  "exhale",
  "exhales",
  "exhaling",
  "gasp",
  "gasping",
  "gasps",
  "giggle",
  "giggles",
  "giggling",
  "groan",
  "groaning",
  "groans",
  "grunt",
  "grunts",
  "hiccup",
  "hiccups",
  "hum",
  "humming",
  "hums",
  "inhale",
  "inhales",
  "inhaling",
  "laugh",
  "laughing",
  "laughs",
  "laughter",
  "scream",
  "screaming",
  "screams",
  "sigh",
  "sighing",
  "sighs",
  "sneeze",
  "sneezes",
  "sneezing",
  "sniff",
  "sniffle",
  "sniffles",
  "sniffs",
  "snicker",
  "snickers",
  "snort",
  "snorting",
  "snorts",
  "sob",
  "sobbing",
  "sobs",
  "throat",
  "wheeze",
  "wheezes",
  "wheezing",
  "whimper",
  "whimpers",
  "yawn",
  "yawning",
  "yawns",
]);
const PACING_WORDS = new Set(["pause", "pauses", "silence"]);
const CLASS_STRENGTH: readonly AudioTagClass[] = [
  "sound_effect",
  "nonverbal",
  "pacing",
  "delivery",
];

/** Classify one tag direction, such as `laughs softly` or `long pause`. */
export function classifyAudioTag(direction: string): AudioTagClass {
  const words = direction.toLowerCase().split(/[^\p{L}]+/u);
  if (words.some((word) => SOUND_EFFECT_WORDS.has(word))) return "sound_effect";
  if (words.some((word) => NONVERBAL_WORDS.has(word))) return "nonverbal";
  if (words.some((word) => PACING_WORDS.has(word))) return "pacing";
  return "delivery";
}

// Tags are short directions; a longer bracketed span is not one.
const MAX_TAG_LENGTH = 64;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
// Han, kana and Hangul characters each keep their own window. The prolonged
// sound mark belongs to both kana scripts.
const CHARACTER_WINDOW_CHAR =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー]/u;
const APOSTROPHE = /['’]/;
const WHITESPACE = /\s/;

type CharClass = "space" | "character" | "word" | "punctuation";

function classifyChar(
  timeline: readonly TimedChar[],
  index: number,
): CharClass {
  const { char } = timeline[index];
  if (WHITESPACE.test(char)) return "space";
  if (CHARACTER_WINDOW_CHAR.test(char)) return "character";
  if (WORD_CHAR.test(char)) return "word";
  // An apostrophe between word letters belongs to the word ("can't").
  if (APOSTROPHE.test(char)) {
    const before = timeline[index - 1]?.char ?? "";
    const after = timeline[index + 1]?.char ?? "";
    const isWordLetter = (value: string) =>
      WORD_CHAR.test(value) && !CHARACTER_WINDOW_CHAR.test(value);
    if (isWordLetter(before) && isWordLetter(after)) return "word";
  }
  return "punctuation";
}

/**
 * Where the tag opening at `open` closes; `pending` when a timeline still being
 * collected may close it, or `null` when the bracket is not a tag.
 */
function findTagClose(
  timeline: readonly TimedChar[],
  open: number,
  complete: boolean,
): number | "pending" | null {
  const limit = Math.min(timeline.length, open + 2 + MAX_TAG_LENGTH);
  for (let index = open + 1; index < limit; index += 1) {
    const { char } = timeline[index];
    if (char === "[") return null;
    if (char === "]") {
      const inner = timeline
        .slice(open + 1, index)
        .map((entry) => entry.char)
        .join("");
      return inner.trim() ? index : null;
    }
  }
  // Only a timeline still being collected, ending before the longest tag
  // could close, may close it yet.
  return !complete && timeline.length < open + 2 + MAX_TAG_LENGTH
    ? "pending"
    : null;
}

function span(
  timeline: readonly TimedChar[],
  charStart: number,
  charEnd: number,
): TimelineSpan & { text: string } {
  const chars = timeline.slice(charStart, charEnd);
  return {
    text: chars.map((entry) => entry.char).join(""),
    startSec: chars[0].startSec,
    endSec: chars[chars.length - 1].endSec,
    charStart,
    charEnd,
  };
}

/**
 * Turn a run's character timeline (from `provider-speech-timing`) into words,
 * punctuation and tags, each in timeline order (starts can overlap slightly at
 * a turn boundary).
 *
 * While a run is still being collected, a tag that has not closed by the end
 * of the timeline is left out until it does. Pass `complete` once the run's
 * audio has ended: an unclosed bracket is then punctuation.
 */
export function buildSpeechTimingEvidence(
  timeline: readonly TimedChar[],
  { complete = false }: { complete?: boolean } = {},
): SpeechTimingEvidence {
  const evidence: SpeechTimingEvidence = {
    words: [],
    punctuation: [],
    tags: [],
  };
  let index = 0;
  while (index < timeline.length) {
    if (timeline[index].char === "[") {
      const close = findTagClose(timeline, index, complete);
      if (close === "pending") break;
      if (close !== null) {
        const { text, ...tagSpan } = span(timeline, index, close + 1);
        const directions = text
          .slice(1, -1)
          .split(",")
          .map((direction) => direction.trim())
          .filter(Boolean)
          .map((direction) => ({
            text: direction,
            tagClass: classifyAudioTag(direction),
          }));
        const tagClass =
          CLASS_STRENGTH.find((candidate) =>
            directions.some((direction) => direction.tagClass === candidate),
          ) ?? "delivery";
        evidence.tags.push({ raw: text, directions, tagClass, ...tagSpan });
        index = close + 1;
        continue;
      }
    }

    const charClass = classifyChar(timeline, index);
    if (charClass === "space") {
      index += 1;
      continue;
    }
    if (charClass === "character") {
      evidence.words.push({
        kind: "character",
        ...span(timeline, index, index + 1),
      });
      index += 1;
      continue;
    }

    // Extend a word or a punctuation run while the class holds; a bracket that
    // opens a tag ends a run.
    let end = index + 1;
    while (
      end < timeline.length &&
      classifyChar(timeline, end) === charClass &&
      !(
        timeline[end].char === "[" &&
        findTagClose(timeline, end, complete) !== null
      )
    ) {
      end += 1;
    }
    if (charClass === "word") {
      evidence.words.push({ kind: "word", ...span(timeline, index, end) });
    } else {
      evidence.punctuation.push(span(timeline, index, end));
    }
    index = end;
  }
  return evidence;
}

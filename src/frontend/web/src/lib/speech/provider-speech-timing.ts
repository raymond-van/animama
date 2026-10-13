/**
 * Character timing that ElevenLabs returns with Eleven v4 Turbo audio, placed on
 * one clock per run: seconds from the run's first audio sample. Add a run's
 * `audioStartSec` (its `AudioContext` time when the first sample played) to map a
 * character onto the playback clock, while playback has not starved: the
 * player fills a dry buffer with silence, which delays the audio but not that
 * clock.
 *
 * Two sources arrive in different time bases:
 *
 * - The Text to Dialogue socket restarts times at 0 in every alignment frame.
 *   Within a prosody turn the frames tile the turn's audio, but not one-to-one
 *   with audio frames: some audio frames carry `alignment: null`, and a turn's
 *   timing can overrun its audio slightly (80 ms in captured Japanese, Korean and
 *   Chinese turns). A cursor therefore advances by each frame's length and
 *   restarts at the audio received when the provider sends
 *   `is_final_audio_for_turn`.
 * - A hosted server socket forwards timing already relative to the run's first
 *   audio sample, which is appended as it is.
 *
 * Provider data is untrusted: a malformed frame is ignored and does not move the
 * cursor.
 */

/** One character of the text sent to the provider, with its spoken window. */
export type TimedChar = {
  char: string;
  startSec: number;
  endSec: number;
};

/** Collects one run's character timing from the frames of its speech socket. */
export type SpeechTimingCollector = {
  /** Count audio received for the run, in samples. */
  acceptAudio: (samples: number) => void;
  /**
   * Place one dialogue socket `alignment` (`chars`, `char_start_times_ms`,
   * `char_durations_ms`, restarting at 0) after the turn's previous frame.
   */
  acceptDialogueAlignment: (alignment: unknown) => TimedChar[];
  /** Start the next prosody turn at the audio received so far. */
  endTurn: () => void;
  /**
   * Append a server socket `alignment` (`characters`,
   * `character_start_times_seconds`, `character_end_times_seconds`), already
   * timed from the run's first audio sample.
   */
  acceptRunAlignment: (alignment: unknown) => TimedChar[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimeArray(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every(
      (entry) =>
        typeof entry === "number" && Number.isFinite(entry) && entry >= 0,
    )
  );
}

function readChars(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : null;
}

/** A dialogue socket frame's characters, with times in milliseconds from the frame's start. */
function readDialogueAlignment(
  value: unknown,
): { chars: string[]; startsMs: number[]; durationsMs: number[] } | null {
  if (!isRecord(value)) return null;
  const chars = readChars(value.chars);
  if (!chars) return null;
  const startsMs = value.char_start_times_ms;
  const durationsMs = value.char_durations_ms;
  if (
    !isTimeArray(startsMs, chars.length) ||
    !isTimeArray(durationsMs, chars.length)
  )
    return null;
  return { chars, startsMs, durationsMs };
}

function readRunAlignment(value: unknown): TimedChar[] | null {
  if (!isRecord(value)) return null;
  const chars = readChars(value.characters);
  if (!chars) return null;
  const starts = value.character_start_times_seconds;
  const ends = value.character_end_times_seconds;
  if (!isTimeArray(starts, chars.length) || !isTimeArray(ends, chars.length))
    return null;
  if (starts.some((start, index) => ends[index] < start)) return null;
  return chars.map((char, index) => ({
    char,
    startSec: starts[index],
    endSec: ends[index],
  }));
}

/** Create the collector for one run whose audio plays at `sampleRate`. */
export function createSpeechTimingCollector(
  sampleRate: number,
): SpeechTimingCollector {
  let receivedSamples = 0;
  // Where the current turn starts on the run clock, and how much of it the
  // turn's earlier frames have covered.
  let turnStartSec = 0;
  let turnOffsetSec = 0;

  return {
    acceptAudio: (samples) => {
      if (Number.isFinite(samples) && samples > 0) receivedSamples += samples;
    },
    acceptDialogueAlignment: (alignment) => {
      const frame = readDialogueAlignment(alignment);
      if (!frame) return [];
      const frameStartSec = turnStartSec + turnOffsetSec;
      let frameLengthMs = 0;
      const chars = frame.chars.map((char, index) => {
        const startMs = frame.startsMs[index];
        const endMs = startMs + frame.durationsMs[index];
        frameLengthMs = Math.max(frameLengthMs, endMs);
        return {
          char,
          startSec: frameStartSec + startMs / 1000,
          endSec: frameStartSec + endMs / 1000,
        };
      });
      turnOffsetSec += frameLengthMs / 1000;
      return chars;
    },
    endTurn: () => {
      turnStartSec = receivedSamples / sampleRate;
      turnOffsetSec = 0;
    },
    acceptRunAlignment: (alignment) => readRunAlignment(alignment) ?? [],
  };
}

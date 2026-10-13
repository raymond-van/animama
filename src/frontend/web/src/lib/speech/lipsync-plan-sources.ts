/**
 * Lip-sync plan sources compared in the Anima debug panel's Lip-sync view.
 *
 * A source turns one captured run's inputs into a vowel viseme segment, the
 * same shape the avatar plays. "Estimated (today)" wraps the current planner
 * unchanged; a planner that uses provider timing (#468) registers itself, and
 * the view draws and replays every registered source without changes.
 */

import { buildVisemeAssetsFromRaw } from "@/lib/avatar/viseme-worker-client";
import type { VowelVisemeLipSyncSegment } from "@/lib/avatar/vowelVisemeSegment";
import type { TimedChar } from "./provider-speech-timing";
import type { SpeechTimingEvidence } from "./speech-timing-evidence";

/** What a captured run offers a planner. */
export type LipSyncPlanInputs = {
  runId: string;
  /** The gruut phonemes and text the estimated planner receives for the run. */
  phonemizedText: string[][] | null;
  tokenizedText: string | null;
  fps: number;
  /** The played audio's length. */
  audioDurationSec: number;
  /** Provider character timing on the run clock, and the evidence built from it. */
  timing: readonly TimedChar[];
  evidence: SpeechTimingEvidence;
};

export type LipSyncPlanSource = {
  id: string;
  label: string;
  /** Build the run's segment, or `null` when this source cannot plan it. */
  build: (
    inputs: LipSyncPlanInputs,
  ) => Promise<VowelVisemeLipSyncSegment | null>;
};

export const ESTIMATED_LIPSYNC_PLAN_SOURCE_ID = "estimated";

/**
 * Today's planner, given the run's final inputs and the played length, as it
 * plans when the length is known before playback. During realtime speech the
 * avatar plays a provisional plan first and rescales the rest once the length
 * is known, so the live mouth can differ slightly from this curve.
 */
const estimatedPlanSource: LipSyncPlanSource = {
  id: ESTIMATED_LIPSYNC_PLAN_SOURCE_ID,
  label: "Estimated (today)",
  build: async (inputs) => {
    if (!Array.isArray(inputs.phonemizedText)) return null;
    const result = await buildVisemeAssetsFromRaw({
      runId: `lipsync-debug-${inputs.runId}`,
      mode: "actual_prestart",
      phonemizedText: inputs.phonemizedText,
      tokenizedText: inputs.tokenizedText,
      fps: inputs.fps,
      targetDurationSec: inputs.audioDurationSec,
    });
    return result.segment;
  },
};

const registeredSources: LipSyncPlanSource[] = [];

/**
 * Add a plan source to the debug view, replacing one with the same id. Returns
 * a function that removes it.
 */
export function registerLipSyncPlanSource(
  source: LipSyncPlanSource,
): () => void {
  const existing = registeredSources.findIndex(
    (candidate) => candidate.id === source.id,
  );
  if (existing >= 0) registeredSources.splice(existing, 1, source);
  else registeredSources.push(source);
  return () => {
    const index = registeredSources.indexOf(source);
    if (index >= 0) registeredSources.splice(index, 1);
  };
}

/** Today's estimated planner first, then the registered sources in order. */
export function lipSyncPlanSources(): readonly LipSyncPlanSource[] {
  return [estimatedPlanSource, ...registeredSources];
}

// Approximate jaw opening of each Vowel5 shape (A, E, I, O, U), for display only.
const OPENNESS_WEIGHTS = [1, 0.6, 0.35, 0.8, 0.45] as const;

/** A segment's approximate mouth opening (0–1) at each frame. */
export function mouthOpennessCurve(
  segment: VowelVisemeLipSyncSegment,
): Array<{ timeSec: number; openness: number }> {
  const curve: Array<{ timeSec: number; openness: number }> = [];
  for (const frame of segment.frames) {
    const { time_sec: timeSec, values } = frame;
    if (typeof timeSec !== "number" || !Array.isArray(values)) continue;
    const openness = OPENNESS_WEIGHTS.reduce(
      (sum, weight, index) =>
        sum + weight * (typeof values[index] === "number" ? values[index] : 0),
      0,
    );
    curve.push({ timeSec, openness: Math.min(1, Math.max(0, openness)) });
  }
  return curve;
}

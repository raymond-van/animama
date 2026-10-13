import { afterEach, describe, expect, it, vi } from "vitest";

import { buildVisemeAssetsFromRaw } from "@/lib/avatar/viseme-worker-client";
import type { VowelVisemeLipSyncSegment } from "@/lib/avatar/vowelVisemeSegment";
import {
  ESTIMATED_LIPSYNC_PLAN_SOURCE_ID,
  lipSyncPlanSources,
  mouthOpennessCurve,
  registerLipSyncPlanSource,
  type LipSyncPlanInputs,
} from "./lipsync-plan-sources";
import { buildSpeechTimingEvidence } from "./speech-timing-evidence";

vi.mock("@/lib/avatar/viseme-worker-client", () => ({
  buildVisemeAssetsFromRaw: vi.fn(),
}));

function segmentWith(
  frames: Array<[number, [number, number, number, number, number]]>,
): VowelVisemeLipSyncSegment {
  return {
    segmentId: "segment-1",
    meta: { run_id: "run-1", segment_id: "segment-1" },
    frames: frames.map(([timeSec, values], index) => ({
      frame_index: index,
      time_sec: timeSec,
      format: "vowel5",
      values,
    })),
    frameCount: frames.length,
    durationMs: 1000,
    durationSec: 1,
    fps: 60,
  };
}

const timing = [
  { char: "H", startSec: 0, endSec: 0.1 },
  { char: "i", startSec: 0.1, endSec: 0.2 },
];
const inputs: LipSyncPlanInputs = {
  runId: "run-1",
  phonemizedText: [["h", "aɪ"]],
  tokenizedText: "Hi",
  fps: 60,
  audioDurationSec: 0.4,
  timing,
  evidence: buildSpeechTimingEvidence(timing),
};

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
  vi.mocked(buildVisemeAssetsFromRaw).mockReset();
});

describe("lip-sync plan sources", () => {
  it("lists today's estimated planner, then each registered source", () => {
    expect(lipSyncPlanSources().map((source) => source.id)).toEqual([
      ESTIMATED_LIPSYNC_PLAN_SOURCE_ID,
    ]);

    unregister = registerLipSyncPlanSource({
      id: "timing-test",
      label: "Timing (test)",
      build: async () => null,
    });

    expect(lipSyncPlanSources().map((source) => source.label)).toEqual([
      "Estimated (today)",
      "Timing (test)",
    ]);
    unregister();
    unregister = null;
    expect(lipSyncPlanSources()).toHaveLength(1);
  });

  it("replaces a source registered again under its id", () => {
    unregister = registerLipSyncPlanSource({
      id: "timing-test",
      label: "First",
      build: async () => null,
    });
    const unregisterSecond = registerLipSyncPlanSource({
      id: "timing-test",
      label: "Second",
      build: async () => null,
    });

    expect(lipSyncPlanSources().map((source) => source.label)).toEqual([
      "Estimated (today)",
      "Second",
    ]);
    unregisterSecond();
  });

  it("builds the estimated plan with today's planner at the played length", async () => {
    const segment = segmentWith([[0, [1, 0, 0, 0, 0]]]);
    vi.mocked(buildVisemeAssetsFromRaw).mockResolvedValue({
      segment,
    } as Awaited<ReturnType<typeof buildVisemeAssetsFromRaw>>);
    const [estimated] = lipSyncPlanSources();

    await expect(estimated.build(inputs)).resolves.toBe(segment);
    expect(buildVisemeAssetsFromRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "actual_prestart",
        phonemizedText: inputs.phonemizedText,
        tokenizedText: "Hi",
        fps: 60,
        targetDurationSec: 0.4,
      }),
    );
  });

  it("has no estimated plan without phonemes", async () => {
    const [estimated] = lipSyncPlanSources();

    await expect(
      estimated.build({ ...inputs, phonemizedText: null }),
    ).resolves.toBeNull();
    expect(buildVisemeAssetsFromRaw).not.toHaveBeenCalled();
  });
});

describe("mouth openness", () => {
  it("weights open vowels above closed ones", () => {
    const curve = mouthOpennessCurve(
      segmentWith([
        [0, [0, 0, 0, 0, 0]],
        [0.1, [1, 0, 0, 0, 0]],
        [0.2, [0, 0, 1, 0, 0]],
        [0.3, [0, 0, 0, 1, 0]],
      ]),
    );

    expect(curve.map((point) => point.timeSec)).toEqual([0, 0.1, 0.2, 0.3]);
    expect(curve[0].openness).toBe(0);
    expect(curve[1].openness).toBe(1);
    expect(curve[2].openness).toBeLessThan(curve[3].openness);
    expect(curve[3].openness).toBeLessThan(curve[1].openness);
  });

  it("skips frames without vowel values", () => {
    const segment = segmentWith([[0, [1, 0, 0, 0, 0]]]);
    segment.frames.push({ time_sec: 0.5, values: "bad" });

    expect(mouthOpennessCurve(segment)).toEqual([{ timeSec: 0, openness: 1 }]);
  });
});

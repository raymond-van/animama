import { describe, expect, it, vi } from "vitest";

import type { VowelVisemeLipSyncSegment } from "@/lib/avatar/vowelVisemeSegment";
import type { LipSyncDebugCapture } from "@/stores/lipsync-debug-store";
import { startLipSyncReplay } from "./lipsync-debug-replay";

class FakeBufferSource {
  buffer: { channel: Float32Array } | null = null;
  onended: (() => void) | null = null;
  connected = false;
  startedAt: number | null = null;
  stopped = 0;
  connect() {
    this.connected = true;
  }
  start(when: number) {
    this.startedAt = when;
  }
  stop() {
    this.stopped += 1;
  }
}

class FakeAudioContext {
  readonly sources: FakeBufferSource[] = [];
  currentTime = 2;
  closed = 0;
  destination = {};
  readonly options: { sampleRate: number };
  constructor(options: { sampleRate: number }) {
    this.options = options;
  }
  createBuffer(_channels: number, length: number) {
    const channel = new Float32Array(length);
    return { channel, getChannelData: () => channel };
  }
  createBufferSource() {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source;
  }
  async close() {
    this.closed += 1;
  }
}

const capture: LipSyncDebugCapture = {
  runId: "run-1",
  provider: "elevenlabs",
  sampleRate: 24_000,
  chunks: [new Int16Array([16384, -16384]), new Int16Array([0])],
  samples: 3,
  truncated: false,
  timing: [],
  inputs: null,
  audioDurationSec: 3 / 24_000,
  seenInBridge: true,
  playbackEnded: true,
};

const segment: VowelVisemeLipSyncSegment = {
  segmentId: "segment-1",
  meta: { run_id: "lipsync-debug-run-1", segment_id: "segment-1" },
  frames: [
    {
      run_id: "lipsync-debug-run-1",
      segment_id: "segment-1",
      frame_index: 0,
      time_sec: 0,
      format: "vowel5",
      values: [1, 0, 0, 0, 0],
    },
  ],
  frameCount: 1,
  durationMs: 1,
  durationSec: 0.001,
  fps: 60,
};

describe("lip-sync replay", () => {
  it("plays the captured audio and applies the plan on its clock under a replay run", async () => {
    let context: FakeAudioContext | null = null;
    const playSegment = vi.fn<
      (args: {
        segment: VowelVisemeLipSyncSegment;
        audioContext: AudioContext;
        audioStartSec: number;
      }) => boolean
    >(() => true);
    const stopSegment = vi.fn();

    const replay = await startLipSyncReplay({
      capture,
      segment,
      playSegment,
      stopSegment,
      createAudioContext: (options) => {
        context = new FakeAudioContext(options);
        return context as unknown as AudioContext;
      },
    });

    const audio = context as unknown as FakeAudioContext;
    expect(audio.options.sampleRate).toBe(24_000);
    const source = audio.sources[0];
    expect(Array.from(source.buffer?.channel ?? [])).toEqual([0.5, -0.5, 0]);
    expect(source.connected).toBe(true);
    expect(source.startedAt).toBeCloseTo(2.1, 6);

    expect(playSegment).toHaveBeenCalledTimes(1);
    const played = playSegment.mock.calls[0]?.[0];
    if (!played) throw new Error("The replay did not apply its plan.");
    expect(played.audioStartSec).toBeCloseTo(2.1, 6);
    expect(played.segment.meta.run_id).toBe(replay.runId);
    expect(played.segment.frames[0]?.run_id).toBe(replay.runId);
    expect(played.segment.segmentId).not.toBe(segment.segmentId);
    // The source plan is untouched.
    expect(segment.meta.run_id).toBe("lipsync-debug-run-1");

    replay.stop();
    expect(source.stopped).toBe(1);
    expect(audio.closed).toBe(1);
    expect(stopSegment).toHaveBeenCalledTimes(1);
    replay.stop();
    expect(audio.closed).toBe(1);
  });

  it("stops when the audio ends", async () => {
    let context: FakeAudioContext | null = null;
    const onEnded = vi.fn();
    const replay = await startLipSyncReplay({
      capture,
      segment,
      playSegment: () => true,
      stopSegment: vi.fn(),
      onEnded,
      createAudioContext: (options) => {
        context = new FakeAudioContext(options);
        return context as unknown as AudioContext;
      },
    });

    (context as unknown as FakeAudioContext).sources[0]?.onended?.();

    expect(onEnded).toHaveBeenCalledTimes(1);
    expect((context as unknown as FakeAudioContext).closed).toBe(1);
    expect(replay.runId).toMatch(/^lipsync-replay-/);
  });

  it("refuses to play without an avatar to drive", async () => {
    let context: FakeAudioContext | null = null;
    await expect(
      startLipSyncReplay({
        capture,
        segment,
        playSegment: () => false,
        stopSegment: vi.fn(),
        createAudioContext: (options) => {
          context = new FakeAudioContext(options);
          return context as unknown as AudioContext;
        },
      }),
    ).rejects.toThrow("No avatar is ready to replay lip-sync.");
    expect((context as unknown as FakeAudioContext).closed).toBe(1);
  });
});

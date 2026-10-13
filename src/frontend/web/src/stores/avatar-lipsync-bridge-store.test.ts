import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildVisemeAssetsFromRaw } from "@/lib/avatar/viseme-worker-client";
import {
  isProviderTimingOnlyChange,
  useAvatarLipSyncBridgeStore,
} from "./avatar-lipsync-bridge-store";

vi.mock("@/lib/avatar/viseme-worker-client", () => ({
  buildVisemeAssetsFromRaw: vi.fn(
    async (args: {
      runId: string;
      targetDurationSec?: number | null;
      phonemizedText?: string[][] | null;
    }) => {
      const wordCount = Array.isArray(args.phonemizedText)
        ? args.phonemizedText.length
        : 1;
      const durationSec = args.targetDurationSec ?? wordCount;
      const segmentId = `viseme-${args.runId}`;
      return {
        segment: {
          segmentId,
          meta: {
            run_id: args.runId,
            segment_id: segmentId,
            duration_seconds: durationSec,
            format: "vowel5",
          },
          frames: [],
          frameCount: 0,
          durationMs: durationSec * 1000,
          durationSec,
          fps: 60,
        },
        planSummary: {
          basis: "phoneme_viseme_plan",
          durationSec,
          durationMs: durationSec * 1000,
          frameCount: 0,
          fps: 60,
        },
        speechGestureTimeline: {
          beats: [],
          words: [],
          utteranceDurationSec: durationSec,
        },
        buildMode: args.targetDurationSec
          ? "actual_prestart"
          : "estimated_provisional",
        provisionalTargetDurationSec: null,
        provisionalMarginSec: null,
        workerElapsedMs: 0,
      };
    },
  ),
}));

describe("avatar lip-sync bridge store", () => {
  beforeEach(() => {
    vi.mocked(buildVisemeAssetsFromRaw).mockClear();
    useAvatarLipSyncBridgeStore.getState().clearAll();
  });

  it("stores duration without throwing when raw viseme inputs arrive later", async () => {
    const store = useAvatarLipSyncBridgeStore.getState();

    expect(() => {
      store.markSpeechAudioDurationResolved({
        runId: "run-1",
        audioDurationSec: 1.25,
        generationId: null,
      });
    }).not.toThrow();
    expect(
      useAvatarLipSyncBridgeStore.getState().speechAudioDurationsByRun["run-1"]
        ?.audioDurationSec,
    ).toBe(1.25);
    expect(buildVisemeAssetsFromRaw).not.toHaveBeenCalled();

    store.queueVisemeInputsForRun({
      runId: "run-1",
      phonemizedText: [["h", "AI"]],
      tokenizedText: "Hi!",
      provider: "elevenlabs",
    });

    await vi.waitFor(() => {
      expect(buildVisemeAssetsFromRaw).toHaveBeenCalledTimes(1);
    });
    expect(buildVisemeAssetsFromRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        mode: "actual_prestart",
        targetDurationSec: 1.25,
        phonemizedText: [["h", "AI"]],
        tokenizedText: "Hi!",
      }),
    );
  });

  it("replaces in-flight provisional visemes when later speech segments extend a run", async () => {
    const avatar = {
      isReady: true,
      clearLipSync: vi.fn(),
      setAudioContext: vi.fn(),
      initLipSyncSegment: vi.fn(),
      registerLipSyncFrame: vi.fn(),
      onSegmentAudioStarted: vi.fn(),
    };
    const audioContext = { currentTime: 6.5 } as AudioContext;
    const store = useAvatarLipSyncBridgeStore.getState();

    store.registerAvatarInstance({
      avatar: avatar as never,
      animaId: "anima-1",
    });
    store.queueVisemeInputsForRun({
      runId: "run-1",
      phonemizedText: [["one"], ["two"], ["three"], ["four"]],
      tokenizedText: "One two three four.",
      provider: "elevenlabs",
    });

    await vi.waitFor(() => {
      expect(buildVisemeAssetsFromRaw).toHaveBeenCalledTimes(1);
    });

    store.markSpeechAudioStarted({
      runId: "run-1",
      audioStartSec: 4,
      audioContext,
    });
    store.tickGate({ avatarState: "talking", preferredRunId: "run-1" });
    expect(avatar.initLipSyncSegment).toHaveBeenCalledTimes(1);

    store.queueVisemeInputsForRun({
      runId: "run-1",
      phonemizedText: [
        ["one"],
        ["two"],
        ["three"],
        ["four"],
        ["five"],
        ["six"],
      ],
      tokenizedText: "One two three four. Five six.",
      provider: "elevenlabs",
    });

    await vi.waitFor(() => {
      expect(buildVisemeAssetsFromRaw).toHaveBeenCalledTimes(2);
      expect(avatar.initLipSyncSegment).toHaveBeenCalledTimes(2);
    });
    expect(buildVisemeAssetsFromRaw).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runId: "run-1",
        mode: "estimated_provisional",
        targetDurationSec: null,
        anchor: expect.objectContaining({
          elapsedSec: 2.5,
          currentDurationSec: 4,
        }),
      }),
    );
  });

  it("plans visemes for Gemini speech and skips unknown providers", async () => {
    const store = useAvatarLipSyncBridgeStore.getState();
    store.queueVisemeInputsForRun({
      runId: "run-gemini",
      phonemizedText: [["h", "AI"]],
      tokenizedText: "Hi!",
      provider: "gemini",
    });
    await vi.waitFor(() => {
      expect(buildVisemeAssetsFromRaw).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run-gemini" }),
      );
    });

    store.queueVisemeInputsForRun({
      runId: "run-other",
      phonemizedText: [["h", "AI"]],
      tokenizedText: "Hi!",
      provider: "other" as "gemini",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(buildVisemeAssetsFromRaw).not.toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-other" }),
    );
  });
});

describe("provider speech timing", () => {
  beforeEach(() => {
    useAvatarLipSyncBridgeStore.getState().clearAll();
  });

  it("keeps each run's characters in arrival order until the run is cleared", () => {
    const store = useAvatarLipSyncBridgeStore.getState();

    store.appendProviderSpeechTiming({
      runId: "run-1",
      provider: "elevenlabs",
      chars: [{ char: "H", startSec: 0, endSec: 0.08 }],
    });
    store.appendProviderSpeechTiming({
      runId: "run-2",
      provider: "elevenlabs",
      chars: [{ char: "Y", startSec: 0, endSec: 0.1 }],
    });
    store.appendProviderSpeechTiming({
      runId: "run-1",
      provider: "elevenlabs",
      chars: [{ char: "i", startSec: 0.08, endSec: 0.2 }],
    });

    expect(
      useAvatarLipSyncBridgeStore.getState().providerSpeechTimingByRun["run-1"],
    ).toEqual({
      provider: "elevenlabs",
      chars: [
        { char: "H", startSec: 0, endSec: 0.08 },
        { char: "i", startSec: 0.08, endSec: 0.2 },
      ],
    });

    store.clearRun("run-1");
    expect(
      Object.keys(
        useAvatarLipSyncBridgeStore.getState().providerSpeechTimingByRun,
      ),
    ).toEqual(["run-2"]);

    store.clearAll();
    expect(
      useAvatarLipSyncBridgeStore.getState().providerSpeechTimingByRun,
    ).toEqual({});
  });

  it("tells a timing-only update apart from one a mirror must copy", () => {
    const changes: boolean[] = [];
    const unsubscribe = useAvatarLipSyncBridgeStore.subscribe(
      (state, previous) =>
        changes.push(isProviderTimingOnlyChange(state, previous)),
    );
    const store = useAvatarLipSyncBridgeStore.getState();

    store.appendProviderSpeechTiming({
      runId: "run-1",
      provider: "elevenlabs",
      chars: [{ char: "H", startSec: 0, endSec: 0.08 }],
    });
    store.markSpeechAudioDurationResolved({
      runId: "run-1",
      audioDurationSec: 1,
      generationId: null,
    });
    unsubscribe();

    expect(changes[0]).toBe(true);
    expect(changes.slice(1)).not.toContain(true);
  });

  it("ignores an empty append", () => {
    const store = useAvatarLipSyncBridgeStore.getState();
    const before = useAvatarLipSyncBridgeStore.getState();

    store.appendProviderSpeechTiming({
      runId: "run-1",
      provider: "elevenlabs",
      chars: [],
    });

    expect(useAvatarLipSyncBridgeStore.getState()).toBe(before);
  });
});

describe("debug replay segments", () => {
  beforeEach(() => {
    useAvatarLipSyncBridgeStore.getState().clearAll();
    useAvatarLipSyncBridgeStore.setState({ avatar: null, avatarAnimaId: null });
  });

  function fakeAvatar() {
    const calls: string[] = [];
    const avatar = {
      isReady: true,
      clearLipSync: () => calls.push("clear"),
      setAudioContext: () => calls.push("context"),
      initLipSyncSegment: (meta: { run_id?: string | null }) =>
        calls.push(`init:${meta.run_id}`),
      registerLipSyncFrame: () => calls.push("frame"),
      onSegmentAudioStarted: (segmentId: string, audioStartSec: number) =>
        calls.push(`start:${segmentId}@${audioStartSec}`),
    };
    return { avatar, calls };
  }

  const segment = {
    segmentId: "replay-segment",
    meta: { run_id: "lipsync-replay-1", segment_id: "replay-segment" },
    frames: [
      { time_sec: 0, values: [1, 0, 0, 0, 0] },
      { time_sec: 1 / 60, values: [0, 1, 0, 0, 0] },
    ],
    frameCount: 2,
    durationMs: 33,
    durationSec: 0.033,
    fps: 60,
  };

  it("plays a replay's plan on the avatar against the replay's clock", () => {
    const { avatar, calls } = fakeAvatar();
    const store = useAvatarLipSyncBridgeStore.getState();
    store.registerAvatarInstance({
      avatar: avatar as unknown as Parameters<
        typeof store.registerAvatarInstance
      >[0]["avatar"],
    });

    expect(
      useAvatarLipSyncBridgeStore.getState().playReplaySegment({
        segment,
        audioContext: {} as AudioContext,
        audioStartSec: 2.5,
      }),
    ).toBe(true);
    expect(calls).toEqual([
      "clear",
      "context",
      "init:lipsync-replay-1",
      "frame",
      "frame",
      "start:replay-segment@2.5",
    ]);
    // A replay is not a chat run: nothing waits for the speech gate.
    expect(useAvatarLipSyncBridgeStore.getState().segmentsByRun).toEqual({});

    useAvatarLipSyncBridgeStore.getState().stopReplaySegment();
    expect(calls.at(-1)).toBe("clear");
  });

  function speakingRun(started: boolean) {
    useAvatarLipSyncBridgeStore.setState({
      speechAudioStartsByRun: {
        "run-1": {
          runId: "run-1",
          audioStartSec: 0,
          audioContext: {} as AudioContext,
          generationId: null,
          receivedAtMs: 0,
        },
      },
      startedRuns: started ? { "run-1": true } : {},
    });
  }

  it("leaves a speaking reply's own plan when a replay stops", () => {
    const { avatar, calls } = fakeAvatar();
    const store = useAvatarLipSyncBridgeStore.getState();
    store.registerAvatarInstance({
      avatar: avatar as unknown as Parameters<
        typeof store.registerAvatarInstance
      >[0]["avatar"],
    });
    speakingRun(true);

    useAvatarLipSyncBridgeStore.getState().stopReplaySegment();

    expect(calls).toEqual([]);
  });

  it("clears a stopped replay when the speaking reply has no plan of its own", () => {
    const { avatar, calls } = fakeAvatar();
    const store = useAvatarLipSyncBridgeStore.getState();
    store.registerAvatarInstance({
      avatar: avatar as unknown as Parameters<
        typeof store.registerAvatarInstance
      >[0]["avatar"],
    });
    // A Japanese reply has no estimated plan, so the replay's pose would freeze.
    speakingRun(false);

    useAvatarLipSyncBridgeStore.getState().stopReplaySegment();

    expect(calls).toEqual(["clear"]);
  });

  it("does not play a replay without a ready avatar", () => {
    expect(
      useAvatarLipSyncBridgeStore.getState().playReplaySegment({
        segment,
        audioContext: {} as AudioContext,
        audioStartSec: 0,
      }),
    ).toBe(false);
  });
});

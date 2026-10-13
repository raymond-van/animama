import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { speechPcmTap } from "@/lib/speech/speech-debug-tap";
import { useAvatarLipSyncBridgeStore } from "./avatar-lipsync-bridge-store";
import {
  LIPSYNC_DEBUG_MAX_SECONDS,
  useLipSyncDebugStore,
} from "./lipsync-debug-store";

vi.mock("@/lib/avatar/viseme-worker-client", () => ({
  buildVisemeAssetsFromRaw: vi.fn(),
}));

const SAMPLE_RATE = 24_000;

function play(runId: string, samples: number, value = 1) {
  speechPcmTap()?.({
    runId,
    provider: "elevenlabs",
    sampleRate: SAMPLE_RATE,
    pcm: new Int16Array(samples).fill(value),
  });
}

beforeEach(() => {
  useLipSyncDebugStore.getState().reset();
  useAvatarLipSyncBridgeStore.getState().clearAll();
});

afterEach(() => {
  useLipSyncDebugStore.getState().reset();
});

describe("lip-sync debug capture", () => {
  it("captures nothing until the debug view starts capturing", () => {
    expect(speechPcmTap()).toBeNull();
    play("run-1", 100);

    expect(useLipSyncDebugStore.getState().capture).toBeNull();
  });

  it("keeps a copy of the latest run's audio only", () => {
    useLipSyncDebugStore.getState().startCapture();
    const pcm = new Int16Array([1, 2, 3]);
    speechPcmTap()?.({
      runId: "run-1",
      provider: "elevenlabs",
      sampleRate: SAMPLE_RATE,
      pcm,
    });
    pcm[0] = 9;
    play("run-1", 2, 4);

    const first = useLipSyncDebugStore.getState().capture;
    expect(first?.runId).toBe("run-1");
    expect(first?.chunks.map((chunk) => Array.from(chunk))).toEqual([
      [1, 2, 3],
      [4, 4],
    ]);

    play("run-2", 5);
    const second = useLipSyncDebugStore.getState().capture;
    expect(second?.runId).toBe("run-2");
    expect(second?.samples).toBe(5);
  });

  it("stops keeping audio after 90 seconds", () => {
    useLipSyncDebugStore.getState().startCapture();
    for (let second = 0; second < LIPSYNC_DEBUG_MAX_SECONDS + 2; second += 1) {
      play("run-1", SAMPLE_RATE);
    }

    const capture = useLipSyncDebugStore.getState().capture;
    expect(capture?.samples).toBe(LIPSYNC_DEBUG_MAX_SECONDS * SAMPLE_RATE);
    expect(capture?.truncated).toBe(true);
  });

  it("keeps the run's timing, planner inputs and length after the bridge clears them", () => {
    useLipSyncDebugStore.getState().startCapture();
    useAvatarLipSyncBridgeStore.setState({
      rawVisemeInputsByRun: {
        "run-1": {
          phonemizedText: [["h", "aɪ"]],
          tokenizedText: "Hi",
          fps: 60,
        },
      },
    });
    play("run-1", 10);
    useAvatarLipSyncBridgeStore.getState().appendProviderSpeechTiming({
      runId: "run-1",
      provider: "elevenlabs",
      chars: [{ char: "H", startSec: 0, endSec: 0.1 }],
    });
    useAvatarLipSyncBridgeStore.setState({
      speechAudioDurationsByRun: {
        "run-1": {
          runId: "run-1",
          audioDurationSec: 0.4,
          generationId: null,
          receivedAtMs: 0,
        },
      },
    });
    useAvatarLipSyncBridgeStore.getState().clearRun("run-1");

    expect(useLipSyncDebugStore.getState().capture).toMatchObject({
      runId: "run-1",
      inputs: { phonemizedText: [["h", "aɪ"]], tokenizedText: "Hi", fps: 60 },
      timing: [{ char: "H", startSec: 0, endSec: 0.1 }],
      audioDurationSec: 0.4,
    });
  });

  it("marks playback ended once the bridge clears the run", () => {
    useLipSyncDebugStore.getState().startCapture();
    play("run-1", 10);
    useAvatarLipSyncBridgeStore.getState().appendProviderSpeechTiming({
      runId: "run-1",
      provider: "elevenlabs",
      chars: [{ char: "H", startSec: 0, endSec: 0.1 }],
    });
    expect(useLipSyncDebugStore.getState().capture?.playbackEnded).toBe(false);

    useAvatarLipSyncBridgeStore.getState().clearRun("run-1");

    expect(useLipSyncDebugStore.getState().capture?.playbackEnded).toBe(true);
  });

  it("drops the capture and its tap when capturing stops", () => {
    useLipSyncDebugStore.getState().startCapture();
    play("run-1", 10);

    useLipSyncDebugStore.getState().stopCapture();

    expect(speechPcmTap()).toBeNull();
    expect(useLipSyncDebugStore.getState().capture).toBeNull();
    useAvatarLipSyncBridgeStore.getState().appendProviderSpeechTiming({
      runId: "run-1",
      provider: "elevenlabs",
      chars: [{ char: "H", startSec: 0, endSec: 0.1 }],
    });
    expect(useLipSyncDebugStore.getState().capture).toBeNull();
  });
});

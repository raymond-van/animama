// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildVisemeAssetsFromRaw } from "@/lib/avatar/viseme-worker-client";
import type { VowelVisemeLipSyncSegment } from "@/lib/avatar/vowelVisemeSegment";
import { registerLipSyncPlanSource } from "@/lib/speech/lipsync-plan-sources";
import { useAvatarLipSyncBridgeStore } from "@/stores/avatar-lipsync-bridge-store";
import {
  useLipSyncDebugStore,
  type LipSyncDebugCapture,
} from "@/stores/lipsync-debug-store";
import { LipSyncDebugSection } from "./LipSyncDebugSection";
import { startLipSyncReplay } from "./lipsync-debug-replay";
import { drawLipSyncTimeline } from "./lipsync-debug-timeline";

vi.mock("@/lib/avatar/viseme-worker-client", () => ({
  buildVisemeAssetsFromRaw: vi.fn(),
}));
vi.mock("./lipsync-debug-replay", () => ({
  startLipSyncReplay: vi.fn(),
}));
vi.mock("./lipsync-debug-timeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lipsync-debug-timeline")>()),
  drawLipSyncTimeline: vi.fn(),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function segment(frameCount: number): VowelVisemeLipSyncSegment {
  return {
    segmentId: `segment-${frameCount}`,
    meta: { run_id: "run-1", segment_id: `segment-${frameCount}` },
    frames: Array.from({ length: frameCount }, (_, index) => ({
      frame_index: index,
      time_sec: index / 60,
      format: "vowel5" as const,
      values: [1, 0, 0, 0, 0],
    })),
    frameCount,
    durationMs: (frameCount / 60) * 1000,
    durationSec: frameCount / 60,
    fps: 60,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let unregister: (() => void) | null = null;

async function settle() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
}

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<LipSyncDebugSection />));
  await settle();
}

function capture(overrides: Partial<LipSyncDebugCapture> = {}) {
  useLipSyncDebugStore.setState({
    capture: {
      runId: "run-1",
      provider: "elevenlabs",
      sampleRate: 24_000,
      chunks: [new Int16Array(240).fill(8000)],
      samples: 240,
      truncated: false,
      timing: Array.from("Hi.").map((char, index) => ({
        char,
        startSec: index / 300,
        endSec: (index + 1) / 300,
      })),
      inputs: { phonemizedText: [["h", "aɪ"]], tokenizedText: "Hi.", fps: 60 },
      audioDurationSec: 0.01,
      seenInBridge: true,
      playbackEnded: true,
      ...overrides,
    },
  });
}

function registerTimingSource() {
  unregister = registerLipSyncPlanSource({
    id: "timing-test",
    label: "Timing (test)",
    build: async () => segment(5),
  });
}

function button(label: string) {
  return container?.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
}

beforeEach(() => {
  vi.mocked(buildVisemeAssetsFromRaw).mockResolvedValue({
    segment: segment(3),
  } as Awaited<ReturnType<typeof buildVisemeAssetsFromRaw>>);
  // happy-dom has no 2D canvas; the drawing itself is tested separately.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: () => undefined,
  } as never);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  unregister?.();
  unregister = null;
  useLipSyncDebugStore.getState().reset();
  useAvatarLipSyncBridgeStore.getState().clearAll();
  vi.mocked(startLipSyncReplay).mockReset();
  vi.mocked(drawLipSyncTimeline).mockReset();
});

describe("Lip-sync debug section", () => {
  it("explains how to capture a run before one exists", async () => {
    await render();

    expect(container?.textContent).toContain(
      "Send a reply with ElevenLabs speech",
    );
  });

  it("draws a curve and offers a replay for every registered plan source", async () => {
    registerTimingSource();
    capture();
    await render();

    const plans = container?.querySelector('[aria-label="Lip-sync plans"]');
    expect(plans?.textContent).toContain("Estimated (today)3 frames");
    expect(plans?.textContent).toContain("Timing (test)5 frames");
    expect(button("Replay with Timing (test)")).not.toBeNull();
    expect(container?.textContent).toContain("1 word · 1 pause · 0 tags");
    const drawn = vi.mocked(drawLipSyncTimeline).mock.calls.at(-1)?.[1];
    expect(drawn?.curves.map((curve) => curve.id)).toEqual([
      "estimated",
      "timing-test",
    ]);
  });

  it("waits for the reply to finish playing before planning or replaying", async () => {
    // The stream has ended, so the length is known, but the audio still plays.
    capture({ playbackEnded: false });
    await render();

    expect(container?.textContent).toContain("capturing…");
    expect(button("Replay with Estimated (today)")).toBeNull();
    expect(buildVisemeAssetsFromRaw).not.toHaveBeenCalled();
  });

  it("keeps Replay off while another reply is speaking", async () => {
    capture();
    useAvatarLipSyncBridgeStore.setState({
      speechAudioStartsByRun: {
        "run-2": {
          runId: "run-2",
          audioStartSec: 0,
          audioContext: {} as AudioContext,
          generationId: null,
          receivedAtMs: 0,
        },
      },
    });
    await render();

    expect(button("Replay with Estimated (today)")?.disabled).toBe(true);
    expect(container?.textContent).toContain("Replay waits for the reply");

    await act(async () => {
      useAvatarLipSyncBridgeStore.getState().clearRun("run-2");
    });
    expect(button("Replay with Estimated (today)")?.disabled).toBe(false);
  });

  it("draws a capped reply on the length of the audio it kept", async () => {
    capture({
      sampleRate: 100,
      chunks: [new Int16Array(9000)],
      samples: 9000,
      truncated: true,
      audioDurationSec: 120,
    });
    await render();

    expect(container?.textContent).toContain("first 90 s kept");
    const drawn = vi.mocked(drawLipSyncTimeline).mock.calls.at(-1)?.[1];
    expect(drawn?.durationSec).toBe(90);
    expect(drawn?.width).toBe(90 * 120);
    expect(drawn?.envelope).toHaveLength(90 * 120);
  });

  it("replays the run with the chosen plan", async () => {
    const stop = vi.fn();
    vi.mocked(startLipSyncReplay).mockResolvedValue({
      runId: "lipsync-replay-1",
      audioContext: { currentTime: 0 } as AudioContext,
      audioStartSec: 0,
      stop,
    });
    registerTimingSource();
    capture();
    await render();

    await act(async () => button("Replay with Timing (test)")?.click());

    expect(startLipSyncReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        segment: expect.objectContaining({ frameCount: 5 }),
        capture: expect.objectContaining({ runId: "run-1" }),
      }),
    );
    const stopButton = Array.from(
      container?.querySelectorAll("button") ?? [],
    ).find((candidate) => candidate.textContent === "Stop replay");
    await act(async () => stopButton?.click());
    expect(stop).toHaveBeenCalled();
  });

  it("ends a replay when a reply starts speaking", async () => {
    const stop = vi.fn();
    vi.mocked(startLipSyncReplay).mockResolvedValue({
      runId: "lipsync-replay-1",
      audioContext: { currentTime: 0 } as AudioContext,
      audioStartSec: 0,
      stop,
    });
    capture();
    await render();
    await act(async () => button("Replay with Estimated (today)")?.click());

    await act(async () => {
      useAvatarLipSyncBridgeStore.setState({
        speechAudioStartsByRun: {
          "run-2": {
            runId: "run-2",
            audioStartSec: 0,
            audioContext: {} as AudioContext,
            generationId: null,
            receivedAtMs: 0,
          },
        },
      });
    });

    expect(stop).toHaveBeenCalled();
    expect(container?.textContent).not.toContain("Stop replay");
  });

  it("clears the previous replay when a new one cannot start", async () => {
    const stop = vi.fn();
    vi.mocked(startLipSyncReplay)
      .mockResolvedValueOnce({
        runId: "lipsync-replay-1",
        audioContext: { currentTime: 0 } as AudioContext,
        audioStartSec: 0,
        stop,
      })
      .mockRejectedValueOnce(
        new Error("No avatar is ready to replay lip-sync."),
      );
    registerTimingSource();
    capture();
    await render();

    await act(async () => button("Replay with Timing (test)")?.click());
    await act(async () => button("Replay with Estimated (today)")?.click());

    expect(stop).toHaveBeenCalled();
    expect(container?.textContent).toContain(
      "No avatar is ready to replay lip-sync.",
    );
    expect(container?.textContent).not.toContain("Stop replay");
    expect(container?.textContent).not.toContain("Replaying");
  });
});

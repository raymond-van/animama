"use client";

import { create } from "zustand";

import { registerPrivateStateReset } from "@/app/runtime/private-module-state";
import type { TimedChar } from "@/lib/speech/provider-speech-timing";
import {
  setSpeechPcmTap,
  type SpeechPcmTapEvent,
} from "@/lib/speech/speech-debug-tap";
import {
  useAvatarLipSyncBridgeStore,
  type RawVisemeInputs,
} from "./avatar-lipsync-bridge-store";

/** The longest audio one capture keeps. */
export const LIPSYNC_DEBUG_MAX_SECONDS = 90;

/**
 * The latest realtime run captured for the debug panel's Lip-sync view: its
 * audio and what the planners need, copied before the bridge clears the run.
 */
export type LipSyncDebugCapture = {
  runId: string;
  provider: SpeechPcmTapEvent["provider"];
  sampleRate: number;
  chunks: Int16Array[];
  samples: number;
  /** Whether audio beyond the cap was dropped. */
  truncated: boolean;
  timing: TimedChar[];
  inputs: RawVisemeInputs | null;
  /** The played length, known once the provider has sent all the audio. */
  audioDurationSec: number | null;
  /** Whether the bridge has seen this run, so its clear means playback ended. */
  seenInBridge: boolean;
  /**
   * Whether the run's playback has ended: the bridge clears a run when its
   * audio stops, which is later than the stream's end.
   */
  playbackEnded: boolean;
};

type LipSyncDebugState = {
  capturing: boolean;
  capture: LipSyncDebugCapture | null;
  /** Capture each new realtime run while the debug panel is enabled. */
  startCapture: () => void;
  /** Stop capturing and drop the captured run. */
  stopCapture: () => void;
  reset: () => void;
};

let unsubscribeBridge: (() => void) | null = null;

export const useLipSyncDebugStore = create<LipSyncDebugState>((set, get) => {
  /** Copy the captured run's planner inputs, timing and length from the bridge. */
  const syncFromBridge = (
    bridge: ReturnType<typeof useAvatarLipSyncBridgeStore.getState>,
  ) => {
    const capture = get().capture;
    if (!capture) return;
    const inputs = bridge.rawVisemeInputsByRun[capture.runId];
    const timing = bridge.providerSpeechTimingByRun[capture.runId]?.chars;
    const audioDuration = bridge.speechAudioDurationsByRun[capture.runId];
    const inBridge = Boolean(
      inputs ||
      timing ||
      audioDuration ||
      bridge.speechAudioStartsByRun[capture.runId],
    );
    // A cleared run keeps what was copied before.
    const next = {
      inputs: inputs ?? capture.inputs,
      timing: timing ?? capture.timing,
      audioDurationSec:
        audioDuration?.audioDurationSec ?? capture.audioDurationSec,
      seenInBridge: capture.seenInBridge || inBridge,
      playbackEnded:
        capture.playbackEnded || (capture.seenInBridge && !inBridge),
    };
    if (
      next.inputs === capture.inputs &&
      next.timing === capture.timing &&
      next.audioDurationSec === capture.audioDurationSec &&
      next.seenInBridge === capture.seenInBridge &&
      next.playbackEnded === capture.playbackEnded
    )
      return;
    set({ capture: { ...capture, ...next } });
  };

  const acceptPcm = (event: SpeechPcmTapEvent) => {
    let capture = get().capture;
    if (!capture || capture.runId !== event.runId) {
      // Keep only the latest run.
      capture = {
        runId: event.runId,
        provider: event.provider,
        sampleRate: event.sampleRate,
        chunks: [],
        samples: 0,
        truncated: false,
        timing: [],
        inputs: null,
        audioDurationSec: null,
        seenInBridge: false,
        playbackEnded: false,
      };
      set({ capture });
      syncFromBridge(useAvatarLipSyncBridgeStore.getState());
      capture = get().capture ?? capture;
    }
    const room =
      LIPSYNC_DEBUG_MAX_SECONDS * capture.sampleRate - capture.samples;
    if (room <= 0) {
      if (!capture.truncated) set({ capture: { ...capture, truncated: true } });
      return;
    }
    const chunk = event.pcm.slice(0, room);
    set({
      capture: {
        ...capture,
        chunks: [...capture.chunks, chunk],
        samples: capture.samples + chunk.length,
        truncated: chunk.length < event.pcm.length,
      },
    });
  };

  const stopCapture = () => {
    setSpeechPcmTap(null);
    unsubscribeBridge?.();
    unsubscribeBridge = null;
    set({ capturing: false, capture: null });
  };

  return {
    capturing: false,
    capture: null,
    startCapture: () => {
      if (get().capturing) return;
      setSpeechPcmTap(acceptPcm);
      unsubscribeBridge = useAvatarLipSyncBridgeStore.subscribe(syncFromBridge);
      set({ capturing: true });
    },
    stopCapture,
    reset: stopCapture,
  };
});

// The capture holds a reply's audio and text, which end with the session.
registerPrivateStateReset(() => useLipSyncDebugStore.getState().reset());

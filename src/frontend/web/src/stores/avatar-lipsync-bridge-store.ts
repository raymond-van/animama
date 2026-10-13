"use client";

import { create } from "zustand";

import {
  type Avatar,
  type AvatarAnimationState,
  type ProceduralSpeechTimingContext,
} from "@/lib/avatar";
import { buildVisemeAssetsFromRaw } from "@/lib/avatar/viseme-worker-client";
import type {
  GruutVisemeKeyframePlanSummary,
  VisemeWorkerBuildMode,
  VisemeWorkerOverrunPolicy,
} from "@/lib/avatar/viseme-worker-protocol";
import type {
  Vowel5FrameValues,
  VowelVisemeLipSyncSegment,
} from "@/lib/avatar/vowelVisemeSegment";
import { createLogger } from "@/lib/logger";
import type { SpeechGestureTimeline } from "@/lib/speech/gruut-viseme-keyframes";
import type { TimedChar } from "@/lib/speech/provider-speech-timing";
import type { TtsChunkRecord } from "@/lib/speech/tts-chunker";

type SpeechAudioStart = {
  runId: string;
  audioStartSec: number;
  audioContext: AudioContext;
  generationId: string | null;
  receivedAtMs: number;
};

type SpeechAudioDuration = {
  runId: string;
  audioDurationSec: number;
  generationId: string | null;
  receivedAtMs: number;
};

type StoredSegment = VowelVisemeLipSyncSegment & {
  runId: string;
  queuedAtMs: number;
};

export type RawVisemeInputs = {
  phonemizedText: string[][] | null;
  tokenizedText: string | null;
  fps: number;
};

type TickGateArgs = {
  avatarState: AvatarAnimationState;
  preferredRunId?: string | null;
};

type ClearOptions = {
  clearAvatarLipSync?: boolean;
};

/**
 * A run's provider character timing on the run clock (seconds from its first
 * audio sample; add the run's `audioStartSec` for the playback clock, which
 * holds until playback starves). It is lip-sync evidence for planners: today's
 * estimated plan does not read it.
 */
export type ProviderSpeechTiming = {
  provider: "elevenlabs";
  chars: TimedChar[];
};

type AvatarLipSyncBridgeState = {
  avatar: Avatar | null;
  avatarAnimaId: string | null;
  sourcePlansByRun: Record<string, GruutVisemeKeyframePlanSummary>;
  speechGestureTimelinesByRun: Record<string, SpeechGestureTimeline>;
  speechChunksByRun: Record<string, TtsChunkRecord[]>;
  rawVisemeInputsByRun: Record<string, RawVisemeInputs>;
  segmentsByRun: Record<string, StoredSegment>;
  speechAudioStartsByRun: Record<string, SpeechAudioStart>;
  speechAudioDurationsByRun: Record<string, SpeechAudioDuration>;
  providerSpeechTimingByRun: Record<string, ProviderSpeechTiming>;
  startedRuns: Record<string, true>;
  buildSeqByRun: Record<string, number>;
  registerAvatarInstance: (args: {
    avatar: Avatar;
    animaId?: string | null;
  }) => void;
  unregisterAvatarInstance: (avatar: Avatar) => void;
  queueVisemeInputsForRun: (args: {
    runId: string;
    phonemizedText: string[][] | null;
    tokenizedText: string | null;
    provider?: "pocket_tts" | "elevenlabs" | "gemini";
  }) => void;
  queueTtsChunksForRun: (args: {
    runId: string;
    chunks: readonly TtsChunkRecord[];
  }) => void;
  markSpeechAudioStarted: (args: {
    runId: string;
    audioStartSec: number;
    audioContext: AudioContext;
    generationId?: string | null;
  }) => void;
  markSpeechAudioDurationResolved: (args: {
    runId: string;
    audioDurationSec: number;
    generationId?: string | null;
  }) => void;
  /** Append characters the speech runtime timed for a run, in arrival order. */
  appendProviderSpeechTiming: (args: {
    runId: string;
    provider: ProviderSpeechTiming["provider"];
    chars: readonly TimedChar[];
  }) => void;
  getSpeechTimingContext: (
    preferredRunId?: string | null,
  ) => ProceduralSpeechTimingContext | null;
  /**
   * Play a debug replay's plan on the avatar against the replay's own audio
   * clock (the debug panel's Lip-sync view). It bypasses the chat-run gate and
   * returns whether an avatar was ready.
   */
  playReplaySegment: (args: {
    segment: VowelVisemeLipSyncSegment;
    audioContext: AudioContext;
    audioStartSec: number;
  }) => boolean;
  /**
   * Clear a debug replay's plan from the avatar, unless a speaking reply has
   * since applied its own plan.
   */
  stopReplaySegment: () => void;
  tickGate: (args: TickGateArgs) => void;
  clearRun: (runId?: string | null, options?: ClearOptions) => void;
  clearAll: (options?: ClearOptions) => void;
};

const logger = createLogger("AvatarVisemeSync");
const EPS = 1e-6;
const DURATION_DEDUPE_EPS_SEC = 1e-4;
const SPEECH_GESTURE_TIMELINE_DURATION_EPS_SEC = 0.05;
const PROVISIONAL_VISEME_MARGIN_MIN_SEC = 1.5;
const PROVISIONAL_VISEME_MARGIN_RATIO = 0.3;
const PROVISIONAL_VISEME_MARGIN_MAX_SEC = 4.0;
const DEFAULT_VOWEL_VISEME_FPS = 60;
const PROVISIONAL_OVERRUN_POLICY: VisemeWorkerOverrunPolicy = {
  minSec: PROVISIONAL_VISEME_MARGIN_MIN_SEC,
  ratio: PROVISIONAL_VISEME_MARGIN_RATIO,
  maxSec: PROVISIONAL_VISEME_MARGIN_MAX_SEC,
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidDurationSec(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readVowel5Values(values: unknown): Vowel5FrameValues {
  if (!Array.isArray(values)) return [0, 0, 0, 0, 0];
  return [0, 1, 2, 3, 4].map((index) => {
    const raw = values[index];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  }) as Vowel5FrameValues;
}

function lerpValues(
  a: Vowel5FrameValues,
  b: Vowel5FrameValues,
  alpha: number,
): Vowel5FrameValues {
  const t = clamp(alpha, 0, 1);
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
    a[3] + (b[3] - a[3]) * t,
    a[4] + (b[4] - a[4]) * t,
  ];
}

function sampleSegmentValuesAtTime(
  segment: VowelVisemeLipSyncSegment,
  timeSec: number,
): Vowel5FrameValues {
  const frames = segment.frames;
  if (!Array.isArray(frames) || frames.length === 0) {
    return [0, 0, 0, 0, 0];
  }

  const t = clamp(timeSec, 0, Math.max(0, segment.durationSec));
  const first = frames[0]!;
  const firstTime = typeof first.time_sec === "number" ? first.time_sec : 0;
  if (t <= firstTime + EPS) {
    return readVowel5Values(first.values);
  }

  const last = frames[frames.length - 1]!;
  const lastTime =
    typeof last.time_sec === "number" ? last.time_sec : firstTime;
  if (t >= lastTime - EPS) {
    return readVowel5Values(last.values);
  }

  for (let index = 0; index < frames.length - 1; index += 1) {
    const f0 = frames[index]!;
    const f1 = frames[index + 1]!;
    const t0 = typeof f0.time_sec === "number" ? f0.time_sec : 0;
    const t1 = typeof f1.time_sec === "number" ? f1.time_sec : t0;
    if (t < t0 - EPS || t > t1 + EPS) continue;
    if (Math.abs(t1 - t0) <= EPS) {
      return readVowel5Values(f1.values);
    }
    const alpha = (t - t0) / (t1 - t0);
    return lerpValues(
      readVowel5Values(f0.values),
      readVowel5Values(f1.values),
      alpha,
    );
  }

  return readVowel5Values(last.values);
}

function applySegmentToAvatarPlayback(args: {
  avatar: Avatar;
  segment: VowelVisemeLipSyncSegment;
  audioStart: SpeechAudioStart;
}): void {
  const { avatar, segment, audioStart } = args;
  avatar.clearLipSync();
  avatar.setAudioContext(audioStart.audioContext);
  avatar.initLipSyncSegment(segment.meta);
  for (const frame of segment.frames) {
    avatar.registerLipSyncFrame(frame);
  }
  avatar.onSegmentAudioStarted(segment.segmentId, audioStart.audioStartSec);
}

/**
 * Whether an update changed only the provider timing, which mirrors of this
 * store (the desktop PiP window) do not copy.
 */
export function isProviderTimingOnlyChange(
  state: AvatarLipSyncBridgeState,
  previous: AvatarLipSyncBridgeState,
): boolean {
  if (state.providerSpeechTimingByRun === previous.providerSpeechTimingByRun)
    return false;
  return (Object.keys(state) as Array<keyof AvatarLipSyncBridgeState>).every(
    (key) =>
      key === "providerSpeechTimingByRun" || state[key] === previous[key],
  );
}

export const useAvatarLipSyncBridgeStore = create<AvatarLipSyncBridgeState>(
  (set, get) => {
    const requestVisemeBuildForRun = async ({
      runId,
      reason,
    }: {
      runId: string;
      reason:
        | "queue_inputs"
        | "actual_duration_resolved"
        | "known_actual_before_queue";
    }): Promise<void> => {
      if (!runId) return;
      const snapshot = get();
      const rawInputs = snapshot.rawVisemeInputsByRun[runId];
      if (!rawInputs || !Array.isArray(rawInputs.phonemizedText)) {
        logger.warn(
          "Worker",
          "Skipped viseme worker build missing raw inputs",
          {
            runId,
            reason,
            hasRawInputs: Boolean(rawInputs),
          },
        );
        return;
      }

      const durationEntry = snapshot.speechAudioDurationsByRun[runId] ?? null;
      const currentSegment = snapshot.segmentsByRun[runId] ?? null;
      const audioStart = snapshot.speechAudioStartsByRun[runId] ?? null;
      const hasStarted = Boolean(snapshot.startedRuns[runId]);

      let mode: VisemeWorkerBuildMode = "estimated_provisional";
      let targetDurationSec: number | null = null;
      let anchor: {
        elapsedSec: number;
        currentDurationSec: number;
        currentValues: Vowel5FrameValues;
      } | null = null;
      let elapsedSec: number | null = null;

      if (durationEntry && isValidDurationSec(durationEntry.audioDurationSec)) {
        targetDurationSec = durationEntry.audioDurationSec;
        if (hasStarted && currentSegment && audioStart) {
          mode = "actual_inflight";
          elapsedSec = clamp(
            audioStart.audioContext.currentTime - audioStart.audioStartSec,
            0,
            Math.max(currentSegment.durationSec, targetDurationSec),
          );
          anchor = {
            elapsedSec,
            currentDurationSec: currentSegment.durationSec,
            currentValues: sampleSegmentValuesAtTime(
              currentSegment,
              elapsedSec,
            ),
          };
        } else {
          mode = "actual_prestart";
        }
      } else if (hasStarted && currentSegment && audioStart) {
        elapsedSec = clamp(
          audioStart.audioContext.currentTime - audioStart.audioStartSec,
          0,
          Math.max(currentSegment.durationSec, 0),
        );
        anchor = {
          elapsedSec,
          currentDurationSec: currentSegment.durationSec,
          currentValues: sampleSegmentValuesAtTime(currentSegment, elapsedSec),
        };
      }

      const nextSeq = (snapshot.buildSeqByRun[runId] ?? 0) + 1;
      set((state) => ({
        buildSeqByRun: {
          ...state.buildSeqByRun,
          [runId]: nextSeq,
        },
      }));

      logger.info("Worker", "Requesting viseme worker build", {
        runId,
        reason,
        seq: nextSeq,
        mode,
        targetDurationSec,
        hasAnchor: Boolean(anchor),
        elapsedSec,
        hasCurrentSegment: Boolean(currentSegment),
        hasStarted,
      });

      try {
        const result = await buildVisemeAssetsFromRaw({
          runId,
          mode,
          phonemizedText: rawInputs.phonemizedText,
          tokenizedText: rawInputs.tokenizedText,
          fps: rawInputs.fps,
          targetDurationSec,
          anchor,
          provisionalOverrun:
            mode === "estimated_provisional"
              ? PROVISIONAL_OVERRUN_POLICY
              : null,
        });

        const latest = get();
        if ((latest.buildSeqByRun[runId] ?? 0) !== nextSeq) {
          logger.info("Worker", "Dropped stale viseme worker response", {
            runId,
            reason,
            seq: nextSeq,
            latestSeq: latest.buildSeqByRun[runId] ?? null,
            mode,
          });
          return;
        }

        const nowMs = Date.now();
        const previousSegment = latest.segmentsByRun[runId];
        const nextStoredSegment: StoredSegment = {
          ...result.segment,
          runId,
          queuedAtMs: previousSegment?.queuedAtMs ?? nowMs,
        };

        set((state) => ({
          sourcePlansByRun: {
            ...state.sourcePlansByRun,
            [runId]: result.planSummary,
          },
          speechGestureTimelinesByRun: {
            ...state.speechGestureTimelinesByRun,
            [runId]: result.speechGestureTimeline,
          },
          segmentsByRun: {
            ...state.segmentsByRun,
            [runId]: nextStoredSegment,
          },
        }));

        logger.info(
          "Worker",
          "Applied viseme worker build result to bridge state",
          {
            runId,
            reason,
            seq: nextSeq,
            mode: result.buildMode,
            frameCount: nextStoredSegment.frameCount,
            durationSec: nextStoredSegment.durationSec,
            durationMs: nextStoredSegment.durationMs,
            fps: nextStoredSegment.fps,
            plannerBasis: result.planSummary.basis,
            plannerDurationSec: result.planSummary.durationSec,
            plannerFrameCount: result.planSummary.frameCount,
            speechGestureBeatCount: result.speechGestureTimeline.beats.length,
            provisionalTargetDurationSec: result.provisionalTargetDurationSec,
            provisionalMarginSec: result.provisionalMarginSec,
            workerElapsedMs: result.workerElapsedMs,
          },
        );

        const shouldApplyInflightReplacement =
          result.buildMode === "actual_inflight" ||
          (result.buildMode === "estimated_provisional" &&
            Boolean(get().startedRuns[runId]));
        if (!shouldApplyInflightReplacement) {
          return;
        }

        const applyState = get();
        const avatar = applyState.avatar;
        const applyAudioStart = applyState.speechAudioStartsByRun[runId];
        if (
          !avatar?.isReady ||
          !applyAudioStart ||
          !applyState.startedRuns[runId]
        ) {
          logger.info(
            "Worker",
            "Skipped immediate in-flight viseme replacement after worker build",
            {
              runId,
              reason,
              seq: nextSeq,
              hasAvatar: Boolean(avatar?.isReady),
              hasAudioStart: Boolean(applyAudioStart),
              hasStarted: Boolean(applyState.startedRuns[runId]),
            },
          );
          return;
        }

        try {
          applySegmentToAvatarPlayback({
            avatar,
            segment: nextStoredSegment,
            audioStart: applyAudioStart,
          });
          logger.info(
            "Playback",
            result.buildMode === "actual_inflight"
              ? "Replaced in-flight vowel keyframes with actual-duration keyframes"
              : "Replaced in-flight vowel keyframes with provisional keyframes",
            {
              runId,
              generationId: applyAudioStart.generationId ?? null,
              segmentId: nextStoredSegment.segmentId,
              elapsedSec,
              audioStartSec: applyAudioStart.audioStartSec,
              frameCount: nextStoredSegment.frameCount,
              durationSec: nextStoredSegment.durationSec,
              seq: nextSeq,
            },
          );
        } catch (error) {
          logger.warn(
            "Playback",
            "Failed to apply in-flight actual-duration viseme segment replacement",
            {
              runId,
              seq: nextSeq,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      } catch (error) {
        const latest = get();
        if ((latest.buildSeqByRun[runId] ?? 0) !== nextSeq) {
          logger.info("Worker", "Ignored stale viseme worker failure", {
            runId,
            reason,
            seq: nextSeq,
            latestSeq: latest.buildSeqByRun[runId] ?? null,
            mode,
          });
          return;
        }
        logger.warn("Worker", "Viseme worker build failed", {
          runId,
          reason,
          seq: nextSeq,
          mode,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    return {
      avatar: null,
      avatarAnimaId: null,
      sourcePlansByRun: {},
      speechGestureTimelinesByRun: {},
      speechChunksByRun: {},
      rawVisemeInputsByRun: {},
      segmentsByRun: {},
      speechAudioStartsByRun: {},
      speechAudioDurationsByRun: {},
      providerSpeechTimingByRun: {},
      startedRuns: {},
      buildSeqByRun: {},

      registerAvatarInstance: ({ avatar, animaId }) => {
        if (!avatar) return;
        logger.info("Init", "Registered avatar instance for viseme sync", {
          animaId: animaId ?? null,
        });
        set({
          avatar,
          avatarAnimaId: animaId ?? null,
        });
      },

      unregisterAvatarInstance: (avatar) => {
        const state = get();
        if (state.avatar !== avatar) return;
        logger.info("Cleanup", "Unregistered avatar instance for viseme sync", {
          animaId: state.avatarAnimaId,
        });
        set({
          avatar: null,
          avatarAnimaId: null,
        });
      },

      queueVisemeInputsForRun: ({
        runId,
        phonemizedText,
        tokenizedText,
        provider,
      }) => {
        if (!runId) return;
        if (
          provider &&
          provider !== "pocket_tts" &&
          provider !== "elevenlabs" &&
          provider !== "gemini"
        ) {
          logger.info(
            "Queue",
            "Skipped viseme queue for unsupported provider",
            {
              runId,
              provider,
            },
          );
          return;
        }
        if (!Array.isArray(phonemizedText) || phonemizedText.length === 0) {
          logger.info("Queue", "Skipped viseme queue missing phonemized text", {
            runId,
            provider: provider ?? null,
            hasPhonemizedText: Array.isArray(phonemizedText),
          });
          return;
        }
        const state = get();
        const knownDurationSec =
          state.speechAudioDurationsByRun[runId]?.audioDurationSec ?? null;
        const rawInputs: RawVisemeInputs = {
          phonemizedText,
          tokenizedText,
          fps: DEFAULT_VOWEL_VISEME_FPS,
        };

        logger.info("Queue", "Captured raw viseme inputs for run", {
          runId,
          provider: provider ?? null,
          hasPhonemizedText: Array.isArray(phonemizedText),
          phonemizedWordCount: Array.isArray(phonemizedText)
            ? phonemizedText.length
            : 0,
          hasTokenizedText: Boolean(tokenizedText && tokenizedText.trim()),
          fps: rawInputs.fps,
          knownDurationSec,
        });

        set((current) => ({
          rawVisemeInputsByRun: {
            ...current.rawVisemeInputsByRun,
            [runId]: rawInputs,
          },
        }));

        void requestVisemeBuildForRun({
          runId,
          reason:
            knownDurationSec != null
              ? "known_actual_before_queue"
              : "queue_inputs",
        });
      },

      queueTtsChunksForRun: ({ runId, chunks }) => {
        if (!runId || chunks.length === 0) return;

        set((state) => {
          const existing = state.speechChunksByRun[runId] ?? [];
          const existingIds = new Set(existing.map((chunk) => chunk.chunkId));
          const nextChunks = chunks.filter(
            (chunk) => chunk.runId === runId && !existingIds.has(chunk.chunkId),
          );
          if (nextChunks.length === 0) return state;

          return {
            speechChunksByRun: {
              ...state.speechChunksByRun,
              [runId]: existing.concat(nextChunks),
            },
          };
        });

        logger.info("Queue", "Captured TTS chunk metadata for run", {
          runId,
          chunkCount: chunks.length,
        });
      },

      markSpeechAudioStarted: ({
        runId,
        audioStartSec,
        audioContext,
        generationId,
      }) => {
        if (!runId) return;
        if (!audioContext || !isFiniteNumber(audioStartSec)) {
          logger.warn(
            "Playback",
            "Ignored speech audio start missing timing/context",
            {
              runId,
              hasAudioContext: Boolean(audioContext),
              audioStartSec,
            },
          );
          return;
        }

        logger.info("Playback", "Recorded speech audio start for viseme sync", {
          runId,
          audioStartSec,
          generationId: generationId ?? null,
        });

        set((state) => ({
          speechAudioStartsByRun: {
            ...state.speechAudioStartsByRun,
            [runId]: {
              runId,
              audioStartSec,
              audioContext,
              generationId: generationId ?? null,
              receivedAtMs: Date.now(),
            },
          },
        }));
      },

      markSpeechAudioDurationResolved: ({
        runId,
        audioDurationSec,
        generationId,
      }) => {
        if (!runId || !isValidDurationSec(audioDurationSec)) return;

        const previousState = get();
        const previousDuration = previousState.speechAudioDurationsByRun[runId];
        if (
          previousDuration &&
          Math.abs(previousDuration.audioDurationSec - audioDurationSec) <=
            DURATION_DEDUPE_EPS_SEC &&
          (previousDuration.generationId ?? null) === (generationId ?? null)
        ) {
          logger.info(
            "Playback",
            "Ignored duplicate speech audio duration for viseme recompute",
            {
              runId,
              generationId: generationId ?? null,
              audioDurationSec,
            },
          );
          return;
        }

        const nowMs = Date.now();
        set((state) => ({
          speechAudioDurationsByRun: {
            ...state.speechAudioDurationsByRun,
            [runId]: {
              runId,
              audioDurationSec,
              generationId: generationId ?? null,
              receivedAtMs: nowMs,
            },
          },
        }));

        const state = get();
        const previousPlan = state.sourcePlansByRun[runId];
        const rawInputs = state.rawVisemeInputsByRun[runId];
        if (!rawInputs || !Array.isArray(rawInputs.phonemizedText)) {
          logger.warn(
            "Playback",
            "Missing raw viseme inputs for speech actual-duration recompute",
            {
              runId,
              generationId: generationId ?? null,
              hasPreviousPlan: Boolean(previousPlan),
              hasCurrentSegment: Boolean(state.segmentsByRun[runId]),
              hasStarted: Boolean(state.startedRuns[runId]),
              hasRawVisemeInputs: Boolean(rawInputs),
            },
          );
          return;
        }

        const currentSegment = state.segmentsByRun[runId];
        const hasStarted = Boolean(state.startedRuns[runId]);
        logger.info(
          "Playback",
          "Recomputing viseme plan from actual speech audio duration",
          {
            runId,
            generationId: generationId ?? null,
            mode: hasStarted ? "inflight" : "prestart",
            actualDurationSec: audioDurationSec,
            previousPlanDurationSec: previousPlan?.durationSec ?? null,
            previousSegmentDurationSec: currentSegment?.durationSec ?? null,
            previousFrameCount:
              currentSegment?.frameCount ?? previousPlan?.frameCount ?? null,
            fps: rawInputs.fps,
            phonemizedWordCount: rawInputs.phonemizedText.length,
            hasTokenizedText: Boolean(rawInputs.tokenizedText?.trim()),
          },
        );

        if (!previousPlan) {
          logger.info(
            "Playback",
            "Stored speech audio duration before viseme plan was available",
            {
              runId,
              audioDurationSec,
              generationId: generationId ?? null,
            },
          );
        }

        void requestVisemeBuildForRun({
          runId,
          reason: "actual_duration_resolved",
        });
      },

      appendProviderSpeechTiming: ({ runId, provider, chars }) => {
        if (!runId || chars.length === 0) return;
        set((state) => ({
          providerSpeechTimingByRun: {
            ...state.providerSpeechTimingByRun,
            [runId]: {
              provider,
              chars: (
                state.providerSpeechTimingByRun[runId]?.chars ?? []
              ).concat(chars),
            },
          },
        }));
      },

      playReplaySegment: ({ segment, audioContext, audioStartSec }) => {
        const avatar = get().avatar;
        if (!avatar?.isReady) return false;
        applySegmentToAvatarPlayback({
          avatar,
          segment,
          audioStart: {
            runId: segment.meta.run_id ?? segment.segmentId,
            audioStartSec,
            audioContext,
            generationId: null,
            receivedAtMs: Date.now(),
          },
        });
        return true;
      },

      stopReplaySegment: () => {
        const state = get();
        // A reply without its own plan (Japanese, or one still being planned)
        // would otherwise keep the replay's last pose on a stopped clock.
        if (
          Object.keys(state.speechAudioStartsByRun).some(
            (runId) => state.startedRuns[runId],
          )
        )
          return;
        state.avatar?.clearLipSync();
      },

      getSpeechTimingContext: (preferredRunId) => {
        const state = get();
        const startsByRun = state.speechAudioStartsByRun;
        const selectedRunId =
          preferredRunId && startsByRun[preferredRunId]
            ? preferredRunId
            : (Object.keys(startsByRun).sort((left, right) => {
                const leftReceivedAt = startsByRun[left]?.receivedAtMs ?? 0;
                const rightReceivedAt = startsByRun[right]?.receivedAtMs ?? 0;
                return rightReceivedAt - leftReceivedAt;
              })[0] ?? null);
        if (!selectedRunId) return null;

        const audioStart = startsByRun[selectedRunId];
        if (!audioStart) return null;

        const elapsedSec =
          audioStart.audioContext.currentTime - audioStart.audioStartSec;
        if (!isFiniteNumber(elapsedSec)) return null;

        const nonNegativeElapsedSec = Math.max(0, elapsedSec);
        const durationSec =
          state.speechAudioDurationsByRun[selectedRunId]?.audioDurationSec ??
          null;
        const gestureTimeline =
          state.speechGestureTimelinesByRun[selectedRunId] ?? null;
        if (isValidDurationSec(durationSec)) {
          const matchingGestureTimeline =
            gestureTimeline &&
            Math.abs(gestureTimeline.utteranceDurationSec - durationSec) <=
              SPEECH_GESTURE_TIMELINE_DURATION_EPS_SEC
              ? gestureTimeline
              : null;
          return {
            runId: selectedRunId,
            elapsedSec: nonNegativeElapsedSec,
            utteranceDurationSec: durationSec,
            durationSec,
            remainingSec: Math.max(0, durationSec - nonNegativeElapsedSec),
            durationKnown: true,
            gestureTimeline: matchingGestureTimeline,
            ttsChunks: state.speechChunksByRun[selectedRunId] ?? [],
          };
        }

        const provisionalDurationSec =
          gestureTimeline &&
          isValidDurationSec(gestureTimeline.utteranceDurationSec)
            ? gestureTimeline.utteranceDurationSec
            : null;

        return {
          runId: selectedRunId,
          elapsedSec: nonNegativeElapsedSec,
          utteranceDurationSec: provisionalDurationSec,
          durationSec: provisionalDurationSec,
          remainingSec:
            provisionalDurationSec != null
              ? Math.max(0, provisionalDurationSec - nonNegativeElapsedSec)
              : null,
          durationKnown: false,
          gestureTimeline,
          ttsChunks: state.speechChunksByRun[selectedRunId] ?? [],
        };
      },

      tickGate: ({ avatarState, preferredRunId }) => {
        if (avatarState !== "talking") return;

        const state = get();
        const avatar = state.avatar;
        if (!avatar?.isReady) return;

        const candidateRunIds = Object.keys(state.segmentsByRun).filter(
          (runId) => {
            if (state.startedRuns[runId]) return false;
            return Boolean(state.speechAudioStartsByRun[runId]);
          },
        );
        if (candidateRunIds.length === 0) return;

        let selectedRunId: string | null = null;
        if (preferredRunId && candidateRunIds.includes(preferredRunId)) {
          selectedRunId = preferredRunId;
        } else {
          selectedRunId =
            candidateRunIds.sort((a, b) => {
              const aQueued = state.segmentsByRun[a]?.queuedAtMs ?? 0;
              const bQueued = state.segmentsByRun[b]?.queuedAtMs ?? 0;
              return aQueued - bQueued;
            })[0] ?? null;
        }
        if (!selectedRunId) return;

        const segment = state.segmentsByRun[selectedRunId];
        const audioStart = state.speechAudioStartsByRun[selectedRunId];
        if (!segment || !audioStart) return;

        try {
          applySegmentToAvatarPlayback({
            avatar,
            segment,
            audioStart,
          });
        } catch (error) {
          logger.warn(
            "Playback",
            "Failed to start expression blendshape playback",
            {
              runId: selectedRunId,
              segmentId: segment.segmentId,
              error: error instanceof Error ? error.message : String(error),
            },
          );
          set((current) => {
            const nextSegments = { ...current.segmentsByRun };
            const nextStarts = { ...current.speechAudioStartsByRun };
            const nextDurations = { ...current.speechAudioDurationsByRun };
            const nextPlans = { ...current.sourcePlansByRun };
            const nextGestureTimelines = {
              ...current.speechGestureTimelinesByRun,
            };
            const nextSpeechChunks = { ...current.speechChunksByRun };
            const nextRawInputs = { ...current.rawVisemeInputsByRun };
            const nextBuildSeq = { ...current.buildSeqByRun };
            delete nextSegments[selectedRunId!];
            delete nextStarts[selectedRunId!];
            delete nextDurations[selectedRunId!];
            delete nextPlans[selectedRunId!];
            delete nextGestureTimelines[selectedRunId!];
            delete nextSpeechChunks[selectedRunId!];
            delete nextRawInputs[selectedRunId!];
            delete nextBuildSeq[selectedRunId!];
            return {
              segmentsByRun: nextSegments,
              speechAudioStartsByRun: nextStarts,
              speechAudioDurationsByRun: nextDurations,
              sourcePlansByRun: nextPlans,
              speechGestureTimelinesByRun: nextGestureTimelines,
              speechChunksByRun: nextSpeechChunks,
              rawVisemeInputsByRun: nextRawInputs,
              buildSeqByRun: nextBuildSeq,
              startedRuns: {
                ...current.startedRuns,
                [selectedRunId!]: true,
              },
            };
          });
          return;
        }

        logger.info("Playback", "Expression blendshape started", {
          runId: selectedRunId,
          segmentId: segment.segmentId,
          provider: "speech_audio",
          audioStartSec: audioStart.audioStartSec,
          avatarState,
          frameCount: segment.frameCount,
          durationMs: segment.durationMs,
          fps: segment.fps,
          visemeFormat: "vowel5",
        });

        set((current) => ({
          startedRuns: {
            ...current.startedRuns,
            [selectedRunId!]: true,
          },
        }));
      },

      clearRun: (runId, options) => {
        const clearAvatarLipSync = options?.clearAvatarLipSync === true;
        const state = get();
        if (!runId) {
          if (clearAvatarLipSync) {
            state.avatar?.clearLipSync();
          }
          set({
            sourcePlansByRun: {},
            speechGestureTimelinesByRun: {},
            speechChunksByRun: {},
            rawVisemeInputsByRun: {},
            segmentsByRun: {},
            speechAudioStartsByRun: {},
            speechAudioDurationsByRun: {},
            providerSpeechTimingByRun: {},
            startedRuns: {},
            buildSeqByRun: {},
          });
          logger.info("Cleanup", "Cleared all viseme bridge run state", {
            clearAvatarLipSync,
          });
          return;
        }

        if (clearAvatarLipSync) {
          state.avatar?.clearLipSync();
        }

        set((current) => {
          const nextPlans = { ...current.sourcePlansByRun };
          const nextGestureTimelines = {
            ...current.speechGestureTimelinesByRun,
          };
          const nextSpeechChunks = { ...current.speechChunksByRun };
          const nextRawInputs = { ...current.rawVisemeInputsByRun };
          const nextSegments = { ...current.segmentsByRun };
          const nextStarts = { ...current.speechAudioStartsByRun };
          const nextDurations = { ...current.speechAudioDurationsByRun };
          const nextTiming = { ...current.providerSpeechTimingByRun };
          const nextStarted = { ...current.startedRuns };
          const nextBuildSeq = { ...current.buildSeqByRun };
          delete nextPlans[runId];
          delete nextGestureTimelines[runId];
          delete nextSpeechChunks[runId];
          delete nextRawInputs[runId];
          delete nextSegments[runId];
          delete nextStarts[runId];
          delete nextDurations[runId];
          delete nextTiming[runId];
          delete nextStarted[runId];
          delete nextBuildSeq[runId];
          return {
            sourcePlansByRun: nextPlans,
            speechGestureTimelinesByRun: nextGestureTimelines,
            speechChunksByRun: nextSpeechChunks,
            rawVisemeInputsByRun: nextRawInputs,
            segmentsByRun: nextSegments,
            speechAudioStartsByRun: nextStarts,
            speechAudioDurationsByRun: nextDurations,
            providerSpeechTimingByRun: nextTiming,
            startedRuns: nextStarted,
            buildSeqByRun: nextBuildSeq,
          };
        });

        logger.info("Cleanup", "Cleared viseme bridge run state", {
          runId,
          clearAvatarLipSync,
        });
      },

      clearAll: (options) => {
        const clearAvatarLipSync = options?.clearAvatarLipSync === true;
        const state = get();
        if (clearAvatarLipSync) {
          state.avatar?.clearLipSync();
        }
        set({
          sourcePlansByRun: {},
          speechGestureTimelinesByRun: {},
          speechChunksByRun: {},
          rawVisemeInputsByRun: {},
          segmentsByRun: {},
          speechAudioStartsByRun: {},
          speechAudioDurationsByRun: {},
          providerSpeechTimingByRun: {},
          startedRuns: {},
          buildSeqByRun: {},
        });
        logger.info("Cleanup", "Cleared all viseme bridge state", {
          clearAvatarLipSync,
        });
      },
    };
  },
);

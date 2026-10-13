"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { createLogger } from "@/lib/logger";
import type { TimedChar } from "@/lib/speech/provider-speech-timing";
import {
  countTtsChunkWords,
  createTtsChunkRecords,
  extractReadyTtsChunkCandidates,
  flushRemainingTtsChunkCandidates,
  isExclamationTtsChunk,
  takeIdleTtsChunkCandidate,
  TTS_CHUNKING_DEFAULTS,
  type TtsChunkCandidate,
  type TtsChunkRecord,
} from "@/lib/speech/tts-chunker";
import {
  canFallBackToPocketTts,
  isBrowserSpeechSynthesisSupported,
  isElevenLabsTtsSupported,
  isGeminiTtsSupported,
  isPocketTtsSupported,
  resolvePreferredTtsProvider,
  shouldPreparePocketTts,
  toTtsProvider,
  type TtsProvider,
} from "@/lib/speech/tts-provider";
import {
  claimSessionNotice,
  resolveOncePerRun,
  resolvePocketFallbackVoice,
  resolvePocketVoicePreference,
  type PerRunValue,
} from "@/lib/speech/pocket/voice-preferences";
import {
  encodePocketAnimaCatalogReference,
  resolvePocketAnimaVoiceSelection,
} from "@/lib/speech/pocket/anima-voice-selection";
import type { PocketAnimaVoiceSelectionContext } from "@/lib/speech/pocket/anima-voice-selection";
import { DEFAULT_POCKET_VOICE } from "@/lib/speech/pocket/voice-catalog";
import { usePocketVoiceDownloads } from "@/hooks/use-pocket-voice-downloads";
import {
  usePocketTtsRuntime,
  type PocketTtsCoreEvent,
} from "@/hooks/use-pocket-tts-runtime";
import {
  useElevenLabsTtsRuntime,
  type ElevenLabsSessionError,
  type ElevenLabsSessionResponse,
} from "@/hooks/use-elevenlabs-tts-runtime";
import {
  useFinalizedTtsRuntime,
  type FinalizedTtsAudioPayload,
  type FinalizedTtsErrorPayload,
} from "@/hooks/use-finalized-tts-runtime";
import { useSoundController } from "@/hooks/use-sound-controller";
import { useRuntimePlatform } from "@/platform/RuntimePlatformProvider";
import { useSettings } from "@/ui/settings/SettingsProvider";

function getSpeechSynthesisOrNull(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  return window.speechSynthesis ?? null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

type UseTtsPlaybackResult = {
  startRun: (runId: string) => void;
  appendToken: (
    runId: string,
    token: string,
    options?: TtsAppendOptions,
  ) => void;
  completeRun: (runId: string) => void;
  acceptElevenLabsSession: (
    runId: string,
    session: ElevenLabsSessionResponse,
  ) => void;
  markElevenLabsSessionFailed: (
    runId: string,
    error: ElevenLabsSessionError | string,
  ) => void;
  acceptFinalizedAudio: (
    runId: string,
    payload: FinalizedTtsAudioPayload,
  ) => void;
  completeFinalizedAudio: (runId: string) => void;
  markFinalizedAudioFailed: (
    runId: string,
    error: FinalizedTtsErrorPayload | string,
  ) => void;
  fallBackToPocketTts: (runId: string) => boolean;
  cancelAll: () => void;
  isAudioActive: boolean;
};

type AudioEndedReason = "natural" | "error";
type TtsTextBasis = "plain" | "gruut_text_with_ws";
type TtsAppendOptions = {
  textBasis?: TtsTextBasis | null;
};

type UseTtsPlaybackOptions = {
  onAudioStarted?: (event: {
    runId: string;
    provider: TtsProvider | null;
    audioStartSec?: number | null;
    audioContext?: AudioContext | null;
    generationId?: string | null;
  }) => void;
  onAudioDurationResolved?: (event: {
    runId: string;
    provider: TtsProvider | null;
    audioDurationSec: number;
    generationId?: string | null;
  }) => void;
  onPlaybackEndedSignal?: (event: {
    runId: string;
    provider: TtsProvider | null;
    generationId?: string | null;
  }) => void;
  onAudioEnded?: (event: {
    runId: string;
    provider: TtsProvider | null;
    reason: AudioEndedReason;
  }) => void;
  onChunksQueued?: (event: {
    runId: string;
    provider: TtsProvider;
    chunks: TtsChunkRecord[];
  }) => void;
  /** Characters ElevenLabs timed for a realtime run, on the run clock (lip-sync evidence). */
  onSpeechTiming?: (event: {
    runId: string;
    provider: "elevenlabs";
    chars: TimedChar[];
  }) => void;
  getPocketVoiceSelectionContext?: (
    runId: string,
  ) => PocketAnimaVoiceSelectionContext | null;
  /** Whether the composition offers Gemini voice (`gemini_tts` capability). */
  geminiTtsOffered?: boolean;
  getSpeechVoiceSelectionContext?: (runId: string) => {
    animaId: string | null;
    emotionLabel?: string | null;
    emotionIntensity?: number | null;
    languageCode?: string | null;
    modelId?: string | null;
    textBasis?: TtsTextBasis | null;
    animaVoiceCatalogUrl?: string | null;
  } | null;
};

type PocketQueueItem = {
  text: string;
  endStream: boolean;
};

type ResolvedPocketVoiceSelection = {
  fallbackVoice?: string;
  animaId?: string;
  animaVoiceKey?: string;
  assertAnimaCatalogActive?: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPocketGenerationId(event: PocketTtsCoreEvent): string | null {
  const detail = isRecord(event.detail) ? event.detail : null;
  if (!detail) return null;
  return typeof detail.generationId === "string" ? detail.generationId : null;
}

function readPocketPlaybackStartSec(event: PocketTtsCoreEvent): number | null {
  const detail = isRecord(event.detail) ? event.detail : null;
  if (!detail) return null;
  const value = detail.startTime;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readPocketAudioDurationSec(event: PocketTtsCoreEvent): number | null {
  const detail = isRecord(event.detail) ? event.detail : null;
  if (!detail) return null;
  const metrics = isRecord(detail.metrics) ? detail.metrics : null;
  if (!metrics) return null;
  const value = metrics.audioDuration;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/** Runs whose audio the server pushes as PCM: Gemini; ElevenLabs speaks in realtime. */
function isFinalizedServerProvider(provider: TtsProvider | null): boolean {
  return provider === "gemini";
}

export function useTtsPlayback(
  options: UseTtsPlaybackOptions = {},
): UseTtsPlaybackResult {
  const {
    onAudioStarted,
    onAudioDurationResolved,
    onPlaybackEndedSignal,
    onAudioEnded,
    onChunksQueued,
    onSpeechTiming,
    getPocketVoiceSelectionContext,
    geminiTtsOffered = false,
    getSpeechVoiceSelectionContext,
  } = options;
  const logger = useMemo(() => createLogger("TTSPlayback"), []);
  const { masterMuted, ttsMuted, ttsVolume } = useSoundController();
  const effectiveTtsVolume = masterMuted || ttsMuted ? 0 : ttsVolume;
  const { effectivePreferences, settingsLoaded } = useSettings();
  const platform = useRuntimePlatform();
  const [isAudioActive, setIsAudioActive] = useState(false);
  const shouldStreamTtsChunks =
    effectivePreferences.speech?.tts_stream_chunks !== false;
  const {
    warmup: warmupPocketRuntime,
    preloadAnimaVoices: preloadPocketAnimaVoices,
    stop: stopPocketRuntime,
    generateAndWait: generatePocketTtsChunk,
    endStream: endPocketStream,
    setVolume: setPocketTtsVolume,
    getAudioContext: getPocketAudioContext,
    onCoreEvent: onPocketCoreEvent,
    hasCustomVoice: pocketHasCustomVoice,
    voices: pocketVoices,
  } = usePocketTtsRuntime();
  const {
    startRun: startElevenLabsRuntime,
    acceptSession: acceptElevenLabsRuntimeSession,
    markSessionFailed: markElevenLabsRuntimeSessionFailed,
    appendText: appendElevenLabsText,
    completeRun: completeElevenLabsRuntime,
    stop: stopElevenLabsRuntime,
    setVolume: setElevenLabsVolume,
  } = useElevenLabsTtsRuntime({
    onWarning: (runId, reason, message) => {
      const key = `${runId}:${reason}`;
      if (warnedKeysRef.current.has(key)) return;
      warnedKeysRef.current.add(key);
      toast.error("Text-to-speech unavailable", {
        description: message,
      });
    },
    onAudioStarted: ({ runId, audioContext, audioStartSec }) => {
      emitAudioStarted(runId, "elevenlabs", runSeqRef.current, {
        audioStartSec,
        audioContext,
      });
    },
    onAudioDurationResolved: ({ runId, audioDurationSec }) => {
      if (!Number.isFinite(audioDurationSec) || audioDurationSec <= 0) return;
      onAudioDurationResolved?.({
        runId,
        provider: "elevenlabs",
        audioDurationSec,
        generationId: null,
      });
      logger.info("Playback", "ElevenLabs audio duration resolved", {
        runId,
        provider: "elevenlabs",
        audioDurationSec,
      });
    },
    onPlaybackEndedSignal: ({ runId }) => {
      onPlaybackEndedSignal?.({
        runId,
        provider: "elevenlabs",
        generationId: null,
      });
      logger.info("Playback", "ElevenLabs playback ended signal received", {
        runId,
        provider: "elevenlabs",
      });
    },
    onAudioEnded: ({ runId, reason }) => {
      emitAudioEnded(runId, "elevenlabs", runSeqRef.current, reason);
    },
    onSpeechTiming,
  });
  // The provider of the run whose pushed audio is playing (set when it is prepared).
  const finalizedProviderRef = useRef<TtsProvider>("gemini");
  const {
    prepareRun: prepareFinalizedRun,
    acceptAudioChunk: acceptFinalizedAudioChunk,
    finishPushedStream: finishFinalizedPushedStream,
    failPushedStream: failFinalizedPushedStream,
    stop: stopFinalizedRuntime,
    setVolume: setFinalizedVolume,
  } = useFinalizedTtsRuntime({
    onWarning: (runId, reason, message) => {
      const key = `${runId}:${reason}`;
      if (warnedKeysRef.current.has(key)) return;
      warnedKeysRef.current.add(key);
      toast.error("Text-to-speech unavailable", {
        description: message,
      });
    },
    onAudioStarted: ({ runId, audioContext, audioStartSec }) => {
      emitAudioStarted(runId, finalizedProviderRef.current, runSeqRef.current, {
        audioStartSec,
        audioContext,
      });
    },
    onAudioDurationResolved: ({ runId, audioDurationSec }) => {
      if (!Number.isFinite(audioDurationSec) || audioDurationSec <= 0) return;
      onAudioDurationResolved?.({
        runId,
        provider: finalizedProviderRef.current,
        audioDurationSec,
        generationId: null,
      });
      logger.info("Playback", "Finalized audio duration resolved", {
        runId,
        provider: finalizedProviderRef.current,
        audioDurationSec,
      });
    },
    onPlaybackEndedSignal: ({ runId }) => {
      onPlaybackEndedSignal?.({
        runId,
        provider: finalizedProviderRef.current,
        generationId: null,
      });
      logger.info("Playback", "Finalized playback ended signal received", {
        runId,
        provider: finalizedProviderRef.current,
      });
    },
    onAudioEnded: ({ runId, reason }) => {
      emitAudioEnded(
        runId,
        finalizedProviderRef.current,
        runSeqRef.current,
        reason,
      );
    },
  });

  const runIdRef = useRef<string | null>(null);
  const runSeqRef = useRef(0);
  const bufferRef = useRef("");
  const idleFlushTimerRef = useRef<number | null>(null);
  const warnedKeysRef = useRef<Set<string>>(new Set());
  const runCompletedRef = useRef(false);
  const audioStartedRef = useRef(false);
  const audioEndedRef = useRef(false);
  const isAudioActiveRef = useRef(false);
  const ttsChunkIndexRef = useRef(0);
  const ttsChunkWordCursorRef = useRef(0);
  const browserPlaybackErrorRef = useRef(false);
  const pocketPlaybackErrorRef = useRef(false);
  const pocketPlaybackEndedRef = useRef(false);
  const activePocketGenerationIdRef = useRef<string | null>(null);

  const browserQueueRef = useRef<string[]>([]);
  const browserSpeakingRef = useRef(false);
  const activeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const ttsVolumeRef = useRef(effectiveTtsVolume);

  const pocketQueueRef = useRef<PocketQueueItem[]>([]);
  const pocketDrainingRef = useRef(false);
  const pocketDrainSeqRef = useRef(0);
  const pocketAbortRef = useRef<AbortController | null>(null);
  const pocketStreamNeedsExplicitEndRef = useRef(false);
  const pocketStreamOpenRef = useRef(false);
  const activePocketVoiceSelectionRef =
    useRef<ResolvedPocketVoiceSelection | null>(null);
  const pocketFallbackVoiceRef = useRef<PerRunValue<string | undefined>>(null);
  const lastPreloadedPocketAnimaRefRef = useRef<string | null>(null);
  const finalizedTextBasisByRunRef = useRef<Record<string, TtsTextBasis>>({});
  // A run whose ElevenLabs speech the server declined speaks with Pocket TTS
  // instead (fallBackToPocketTts); the saved provider is unchanged.
  const declinedElevenLabsRunIdRef = useRef<string | null>(null);
  // All speech text appended to the active run, so a declined run can be
  // spoken again from its first word.
  const runSpeechTextRef = useRef("");

  const resolveSpeechRuntimeContext = useCallback(
    (runId: string) => getSpeechVoiceSelectionContext?.(runId) ?? null,
    [getSpeechVoiceSelectionContext],
  );

  const clearIdleFlushTimer = useCallback(() => {
    if (idleFlushTimerRef.current !== null) {
      window.clearTimeout(idleFlushTimerRef.current);
      idleFlushTimerRef.current = null;
    }
  }, []);

  const clearActiveUtteranceHandlers = useCallback(() => {
    if (!activeUtteranceRef.current) return;
    activeUtteranceRef.current.onstart = null;
    activeUtteranceRef.current.onend = null;
    activeUtteranceRef.current.onerror = null;
    activeUtteranceRef.current = null;
  }, []);

  const setAudioActiveState = useCallback((nextActive: boolean) => {
    if (isAudioActiveRef.current === nextActive) return;
    isAudioActiveRef.current = nextActive;
    setIsAudioActive(nextActive);
  }, []);

  const resetRunPlaybackLifecycle = useCallback(() => {
    runCompletedRef.current = false;
    audioStartedRef.current = false;
    audioEndedRef.current = false;
    ttsChunkIndexRef.current = 0;
    ttsChunkWordCursorRef.current = 0;
    setAudioActiveState(false);
    browserPlaybackErrorRef.current = false;
    pocketPlaybackErrorRef.current = false;
    pocketPlaybackEndedRef.current = false;
    activePocketGenerationIdRef.current = null;
    activePocketVoiceSelectionRef.current = null;
  }, [setAudioActiveState]);

  const emitAudioStarted = useCallback(
    (
      runId: string,
      provider: TtsProvider | null,
      runSeq: number,
      extra?: {
        audioStartSec?: number | null;
        audioContext?: AudioContext | null;
        generationId?: string | null;
      },
    ) => {
      if (runSeqRef.current !== runSeq) return;
      if (runIdRef.current !== runId) return;
      if (audioStartedRef.current || audioEndedRef.current) return;
      audioStartedRef.current = true;
      setAudioActiveState(true);
      onAudioStarted?.({
        runId,
        provider,
        audioStartSec: extra?.audioStartSec ?? null,
        audioContext: extra?.audioContext ?? null,
        generationId: extra?.generationId ?? null,
      });
      logger.info("Playback", "Audio started", {
        runId,
        provider,
        audioStartSec: extra?.audioStartSec ?? null,
        generationId: extra?.generationId ?? null,
      });
    },
    [logger, onAudioStarted, setAudioActiveState],
  );

  const emitAudioEnded = useCallback(
    (
      runId: string,
      provider: TtsProvider | null,
      runSeq: number,
      reason: AudioEndedReason,
    ) => {
      if (runSeqRef.current !== runSeq) return;
      if (runIdRef.current !== runId) return;
      if (audioEndedRef.current) return;
      audioEndedRef.current = true;
      setAudioActiveState(false);
      onAudioEnded?.({
        runId,
        provider,
        reason,
      });
      logger.info("Playback", "Audio ended", {
        runId,
        provider,
        reason,
      });
    },
    [logger, onAudioEnded, setAudioActiveState],
  );

  const maybeEmitBrowserAudioEnded = useCallback(
    (runId: string, runSeq: number) => {
      if (runSeqRef.current !== runSeq) return;
      if (runIdRef.current !== runId) return;
      if (!runCompletedRef.current) return;
      if (browserSpeakingRef.current || activeUtteranceRef.current) return;
      if (browserQueueRef.current.length > 0) return;
      emitAudioEnded(
        runId,
        "browser",
        runSeq,
        browserPlaybackErrorRef.current ? "error" : "natural",
      );
    },
    [emitAudioEnded],
  );

  const emitPocketAudioDurationResolved = useCallback(
    (
      runId: string,
      runSeq: number,
      audioDurationSec: number,
      generationId?: string | null,
    ) => {
      if (runSeqRef.current !== runSeq) return;
      if (runIdRef.current !== runId) return;
      if (!Number.isFinite(audioDurationSec) || audioDurationSec <= 0) return;
      onAudioDurationResolved?.({
        runId,
        provider: "pocket_tts",
        audioDurationSec,
        generationId: generationId ?? null,
      });
      logger.info("Playback", "Pocket audio duration resolved", {
        runId,
        provider: "pocket_tts",
        audioDurationSec,
        generationId: generationId ?? null,
      });
    },
    [logger, onAudioDurationResolved],
  );

  const maybeEmitPocketAudioEnded = useCallback(
    (runId: string, runSeq: number) => {
      if (runSeqRef.current !== runSeq) return;
      if (runIdRef.current !== runId) return;
      if (!runCompletedRef.current || !pocketPlaybackEndedRef.current) return;
      emitAudioEnded(
        runId,
        "pocket_tts",
        runSeq,
        pocketPlaybackErrorRef.current ? "error" : "natural",
      );
    },
    [emitAudioEnded],
  );

  const warnOnceForRun = useCallback(
    (runId: string, reason: string, message: string) => {
      const key = `${runId}:${reason}`;
      if (warnedKeysRef.current.has(key)) return;
      warnedKeysRef.current.add(key);
      toast.error("Text-to-speech unavailable", {
        description: message,
      });
    },
    [],
  );

  // Warnings about saved settings (not a single run) show once per app session.
  const warnOncePerSession = useCallback((reason: string, message: string) => {
    if (!claimSessionNotice(reason)) return;
    toast.warning("Pocket voice unavailable", { description: message });
  }, []);

  const shouldStreamChunksForProvider = useCallback(
    (provider: TtsProvider): boolean => {
      if (provider === "browser" || provider === "pocket_tts") {
        // Browser speechSynthesis can cancel the active utterance when VFX SFX
        // starts mid-sentence, so keep browser TTS serialized after dispatch.
        return false;
      }
      if (isFinalizedServerProvider(provider)) {
        return false;
      }
      return shouldStreamTtsChunks;
    },
    [shouldStreamTtsChunks],
  );

  const resolveActiveProvider = useCallback(
    (runId: string | null): TtsProvider | null => {
      if (!runId) return null;
      if (effectivePreferences.speech?.tts_enabled !== true) return null;
      // The server declined this run's ElevenLabs speech; Pocket speaks it.
      if (declinedElevenLabsRunIdRef.current === runId) return "pocket_tts";

      const savedProvider = toTtsProvider(
        effectivePreferences.speech?.tts_provider,
      );
      const provider = resolvePreferredTtsProvider({
        savedProvider,
        platform,
        offers: { gemini: geminiTtsOffered },
      }).provider;
      if (!provider) return null;

      if (
        provider === "browser" &&
        !isBrowserSpeechSynthesisSupported(platform)
      ) {
        warnOnceForRun(
          runId,
          "browser_tts_unsupported",
          "Speech synthesis is not supported in this browser.",
        );
        return null;
      }

      if (provider === "pocket_tts" && !isPocketTtsSupported()) {
        warnOnceForRun(
          runId,
          "pocket_tts_unsupported",
          "PocketTTS is not supported in this browser environment.",
        );
        return null;
      }

      if (provider === "gemini" && !isGeminiTtsSupported()) {
        warnOnceForRun(
          runId,
          "gemini_unsupported",
          "Gemini TTS needs the Web Audio API, which this browser lacks.",
        );
        return null;
      }

      if (provider === "elevenlabs" && !isElevenLabsTtsSupported()) {
        warnOnceForRun(
          runId,
          "elevenlabs_unsupported",
          "ElevenLabs TTS is not supported in this browser environment.",
        );
        return null;
      }

      return provider;
    },
    [
      effectivePreferences.speech?.tts_enabled,
      effectivePreferences.speech?.tts_provider,
      geminiTtsOffered,
      platform,
      warnOnceForRun,
    ],
  );

  const cancelBrowserPlayback = useCallback(() => {
    browserQueueRef.current = [];
    browserSpeakingRef.current = false;
    clearActiveUtteranceHandlers();

    const synthesis = getSpeechSynthesisOrNull();
    if (!synthesis) return;
    try {
      synthesis.cancel();
    } catch {
      // noop
    }
  }, [clearActiveUtteranceHandlers]);

  const cancelPocketPlayback = useCallback(() => {
    pocketQueueRef.current = [];
    pocketDrainingRef.current = false;
    pocketDrainSeqRef.current += 1;
    pocketStreamNeedsExplicitEndRef.current = false;
    pocketStreamOpenRef.current = false;

    if (pocketAbortRef.current) {
      pocketAbortRef.current.abort();
      pocketAbortRef.current = null;
    }

    stopPocketRuntime();
  }, [stopPocketRuntime]);

  const cancelAll = useCallback(() => {
    runSeqRef.current += 1;
    clearIdleFlushTimer();
    bufferRef.current = "";
    runSpeechTextRef.current = "";
    runIdRef.current = null;
    declinedElevenLabsRunIdRef.current = null;
    finalizedTextBasisByRunRef.current = {};
    warnedKeysRef.current.clear();
    resetRunPlaybackLifecycle();
    cancelBrowserPlayback();
    cancelPocketPlayback();
    stopElevenLabsRuntime();
    stopFinalizedRuntime();
  }, [
    cancelBrowserPlayback,
    cancelPocketPlayback,
    clearIdleFlushTimer,
    resetRunPlaybackLifecycle,
    stopElevenLabsRuntime,
    stopFinalizedRuntime,
  ]);

  const drainBrowserQueue = useCallback(() => {
    const drain = () => {
      if (browserSpeakingRef.current) return;

      const runId = runIdRef.current;
      if (!runId) return;
      const runSeq = runSeqRef.current;

      const provider = resolveActiveProvider(runId);
      if (provider !== "browser") {
        browserQueueRef.current = [];
        return;
      }

      const nextChunk = browserQueueRef.current.shift();
      if (!nextChunk) return;

      const synthesis = getSpeechSynthesisOrNull();
      if (!synthesis) {
        warnOnceForRun(
          runId,
          "browser_tts_missing",
          "Speech synthesis is not supported in this browser.",
        );
        browserQueueRef.current = [];
        return;
      }

      const utterance = new SpeechSynthesisUtterance(nextChunk);
      utterance.volume = ttsVolumeRef.current;
      activeUtteranceRef.current = utterance;
      browserSpeakingRef.current = true;

      utterance.onstart = () => {
        emitAudioStarted(runId, "browser", runSeq);
      };

      utterance.onend = () => {
        if (activeUtteranceRef.current === utterance) {
          clearActiveUtteranceHandlers();
        }
        browserSpeakingRef.current = false;
        drain();
        maybeEmitBrowserAudioEnded(runId, runSeq);
      };

      utterance.onerror = () => {
        if (activeUtteranceRef.current === utterance) {
          clearActiveUtteranceHandlers();
        }
        browserSpeakingRef.current = false;
        browserPlaybackErrorRef.current = true;
        warnOnceForRun(
          runId,
          "browser_tts_error",
          "Failed to generate browser speech for this response.",
        );
        drain();
        maybeEmitBrowserAudioEnded(runId, runSeq);
      };

      try {
        synthesis.speak(utterance);
      } catch (error) {
        if (activeUtteranceRef.current === utterance) {
          clearActiveUtteranceHandlers();
        }
        browserSpeakingRef.current = false;
        browserPlaybackErrorRef.current = true;
        warnOnceForRun(
          runId,
          "browser_tts_speak_failed",
          "Failed to play browser speech for this response.",
        );
        logger.warn("Playback", "speechSynthesis.speak threw", {
          error: error instanceof Error ? error.message : String(error),
        });
        drain();
        maybeEmitBrowserAudioEnded(runId, runSeq);
      }
    };

    drain();
  }, [
    clearActiveUtteranceHandlers,
    emitAudioStarted,
    logger,
    maybeEmitBrowserAudioEnded,
    resolveActiveProvider,
    warnOnceForRun,
  ]);

  // Owners of another provider read the downloadable voice list only once a
  // reply has fallen back to Pocket (fallBackToPocketTts).
  const [pocketFallbackUsed, setPocketFallbackUsed] = useState(false);
  const pocketVoiceDownloads = usePocketVoiceDownloads({
    enabled:
      effectivePreferences.speech?.tts_enabled === true &&
      (effectivePreferences.speech?.tts_provider === "pocket_tts" ||
        pocketFallbackUsed),
  });
  // A reply that fell back mid-run resolves its voice from the list as loaded
  // by then, not as captured when the run began.
  const pocketVoiceDownloadsRef = useRef(pocketVoiceDownloads);
  pocketVoiceDownloadsRef.current = pocketVoiceDownloads;

  const resolvePocketFallbackVoiceForRun = useCallback(
    (runId: string): string | undefined =>
      // Every chunk of a reply speaks with the voice chosen for its first one.
      resolveOncePerRun(pocketFallbackVoiceRef, runId, () => {
        const downloads = pocketVoiceDownloadsRef.current;
        const { voice, notice, install } = resolvePocketFallbackVoice(
          resolvePocketVoicePreference(effectivePreferences.speech),
          pocketVoices,
          pocketHasCustomVoice,
          DEFAULT_POCKET_VOICE,
          downloads.availability,
        );
        // A missing downloadable voice installs in the background; this reply
        // uses the default voice and later replies use the installed voice.
        if (install) downloads.install(install);
        // A reply moved to Pocket after declined ElevenLabs speech stays
        // quiet: the owner chose ElevenLabs, so stale Pocket voice settings
        // need no notice.
        if (declinedElevenLabsRunIdRef.current === runId) return voice;
        if (notice?.scope === "session") {
          warnOncePerSession(notice.key, notice.message);
        } else if (notice) {
          warnOnceForRun(runId, notice.key, notice.message);
        }
        return voice;
      }),
    [
      effectivePreferences.speech,
      pocketHasCustomVoice,
      pocketVoices,
      warnOnceForRun,
      warnOncePerSession,
    ],
  );

  const resolvePocketVoiceSelectionForRun = useCallback(
    (runId: string): ResolvedPocketVoiceSelection => {
      const selection = resolvePocketAnimaVoiceSelection(
        getPocketVoiceSelectionContext?.(runId) ?? null,
      );
      const fallbackVoice = selection.assertAnimaCatalogActive
        ? undefined
        : resolvePocketFallbackVoiceForRun(runId);
      const animaCatalogReference =
        encodePocketAnimaCatalogReference(selection);

      return {
        fallbackVoice,
        assertAnimaCatalogActive: selection.assertAnimaCatalogActive,
        ...(animaCatalogReference ? { animaId: animaCatalogReference } : {}),
        ...(selection.animaVoiceKey
          ? { animaVoiceKey: selection.animaVoiceKey }
          : {}),
      };
    },
    [getPocketVoiceSelectionContext, resolvePocketFallbackVoiceForRun],
  );

  const resolvePocketAnimaCatalogReferenceForPreload = useCallback(() => {
    const selection = resolvePocketAnimaVoiceSelection(
      getPocketVoiceSelectionContext?.("__pocket_preload__") ?? null,
    );
    return encodePocketAnimaCatalogReference(selection);
  }, [getPocketVoiceSelectionContext]);

  useEffect(() => {
    ttsVolumeRef.current = effectiveTtsVolume;
    if (activeUtteranceRef.current) {
      activeUtteranceRef.current.volume = effectiveTtsVolume;
    }
    setPocketTtsVolume(effectiveTtsVolume);
    setElevenLabsVolume(effectiveTtsVolume);
    setFinalizedVolume(effectiveTtsVolume);
  }, [
    effectiveTtsVolume,
    setFinalizedVolume,
    setElevenLabsVolume,
    setPocketTtsVolume,
  ]);

  const drainPocketQueue = useCallback(() => {
    if (pocketDrainingRef.current) return;

    const runId = runIdRef.current;
    if (!runId) return;
    const runSeq = runSeqRef.current;

    pocketDrainingRef.current = true;
    const drainSeq = ++pocketDrainSeqRef.current;

    const drain = async () => {
      while (true) {
        if (pocketDrainSeqRef.current !== drainSeq) return;
        if (runIdRef.current !== runId) return;

        const provider = resolveActiveProvider(runId);
        if (provider !== "pocket_tts") {
          pocketQueueRef.current = [];
          pocketStreamNeedsExplicitEndRef.current = false;
          pocketStreamOpenRef.current = false;
          return;
        }

        const nextChunk = pocketQueueRef.current.shift();
        if (!nextChunk) {
          if (pocketStreamNeedsExplicitEndRef.current) {
            pocketStreamNeedsExplicitEndRef.current = false;
            pocketStreamOpenRef.current = false;
            endPocketStream();
          }
          return;
        }

        const abortController = new AbortController();
        pocketAbortRef.current = abortController;

        try {
          const voiceSelection =
            activePocketVoiceSelectionRef.current ??
            resolvePocketVoiceSelectionForRun(runId);
          await generatePocketTtsChunk(nextChunk.text, {
            signal: abortController.signal,
            preservePlayback: true,
            endStream: nextChunk.endStream,
            assertAnimaCatalogActive: voiceSelection.assertAnimaCatalogActive,
            ...(voiceSelection.fallbackVoice
              ? { voice: voiceSelection.fallbackVoice }
              : {}),
            ...(voiceSelection.animaId
              ? { animaId: voiceSelection.animaId }
              : {}),
            ...(voiceSelection.animaVoiceKey
              ? { animaVoiceKey: voiceSelection.animaVoiceKey }
              : {}),
          });
          if (nextChunk.endStream) {
            pocketStreamOpenRef.current = false;
          }
        } catch (error) {
          if (isAbortError(error)) return;
          pocketPlaybackErrorRef.current = true;
          warnOnceForRun(
            runId,
            "pocket_generation_failed",
            "PocketTTS failed to synthesize part of this response.",
          );
          logger.warn("Playback", "PocketTTS chunk generation failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          pocketQueueRef.current = [];
          pocketStreamNeedsExplicitEndRef.current = false;
          if (pocketStreamOpenRef.current) {
            pocketStreamOpenRef.current = false;
            endPocketStream();
          }
          emitAudioEnded(runId, "pocket_tts", runSeq, "error");
          maybeEmitPocketAudioEnded(runId, runSeq);
          return;
        } finally {
          if (pocketAbortRef.current === abortController) {
            pocketAbortRef.current = null;
          }
        }
      }
    };

    void drain().finally(() => {
      if (pocketDrainSeqRef.current !== drainSeq) return;
      pocketDrainingRef.current = false;
      if (pocketQueueRef.current.length > 0 && runIdRef.current === runId) {
        drainPocketQueue();
      }
    });
  }, [
    endPocketStream,
    emitAudioEnded,
    logger,
    generatePocketTtsChunk,
    maybeEmitPocketAudioEnded,
    resolveActiveProvider,
    resolvePocketVoiceSelectionForRun,
    warnOnceForRun,
  ]);

  const recordPreparedChunksForAvatar = useCallback(
    (
      runId: string,
      provider: TtsProvider,
      chunks: readonly TtsChunkCandidate[],
    ) => {
      if (chunks.length === 0) return;

      const records = createTtsChunkRecords({
        runId,
        chunks,
        startIndex: ttsChunkIndexRef.current,
        wordStartIndex: ttsChunkWordCursorRef.current,
      });
      const lastRecord = records[records.length - 1] ?? null;
      ttsChunkIndexRef.current += records.length;
      if (lastRecord) {
        ttsChunkWordCursorRef.current = lastRecord.wordEndIndex;
      }

      onChunksQueued?.({
        runId,
        provider,
        chunks: records,
      });
    },
    [onChunksQueued],
  );

  const prepareChunksForPlayback = useCallback(
    (
      chunks: readonly TtsChunkCandidate[],
      provider: TtsProvider,
    ): TtsChunkCandidate[] => {
      if (chunks.length === 0) return [];
      const prepared: TtsChunkCandidate[] = [];

      for (const chunk of chunks) {
        const trimmed = chunk.text.trim();
        if (!trimmed) continue;

        logger.info("Prepare", "Prepared TTS text", {
          provider,
          text: trimmed,
        });
        prepared.push({
          ...chunk,
          text: trimmed,
        });
      }

      return prepared;
    },
    [logger],
  );

  const enqueueBrowserChunks = useCallback(
    (runId: string, chunks: readonly TtsChunkCandidate[]) => {
      const prepared = prepareChunksForPlayback(chunks, "browser");
      if (prepared.length === 0) return;
      recordPreparedChunksForAvatar(runId, "browser", prepared);
      browserQueueRef.current.push(...prepared.map((chunk) => chunk.text));
      drainBrowserQueue();
    },
    [
      drainBrowserQueue,
      prepareChunksForPlayback,
      recordPreparedChunksForAvatar,
    ],
  );

  const enqueuePocketChunks = useCallback(
    (
      runId: string,
      chunks: readonly TtsChunkCandidate[],
      options?: { markLastChunkAsFinal?: boolean },
    ) => {
      const prepared = prepareChunksForPlayback(chunks, "pocket_tts");
      if (prepared.length === 0) return;
      recordPreparedChunksForAvatar(runId, "pocket_tts", prepared);
      const markLastChunkAsFinal = options?.markLastChunkAsFinal === true;
      const queueItems: PocketQueueItem[] = prepared.map((chunk, index) => ({
        text: chunk.text,
        endStream: markLastChunkAsFinal && index === prepared.length - 1,
      }));
      pocketQueueRef.current.push(...queueItems);
      pocketStreamOpenRef.current = true;
      pocketPlaybackEndedRef.current = false;
      if (markLastChunkAsFinal) {
        pocketStreamNeedsExplicitEndRef.current = false;
      }
      drainPocketQueue();
    },
    [drainPocketQueue, prepareChunksForPlayback, recordPreparedChunksForAvatar],
  );

  const enqueueElevenLabsChunks = useCallback(
    (runId: string, chunks: readonly TtsChunkCandidate[]) => {
      const prepared = prepareChunksForPlayback(chunks, "elevenlabs");
      if (prepared.length === 0) return;
      const speechContext = resolveSpeechRuntimeContext(runId);
      if (!speechContext?.animaId) {
        warnOnceForRun(
          runId,
          "elevenlabs_missing_persona",
          "ElevenLabs TTS requires a anima context for this response.",
        );
        return;
      }
      recordPreparedChunksForAvatar(runId, "elevenlabs", prepared);
      for (const chunk of prepared) {
        appendElevenLabsText(runId, chunk.text, speechContext);
      }
    },
    [
      appendElevenLabsText,
      prepareChunksForPlayback,
      recordPreparedChunksForAvatar,
      resolveSpeechRuntimeContext,
      warnOnceForRun,
    ],
  );

  const scheduleIdleFlush = useCallback(
    (runId: string) => {
      const schedule = () => {
        clearIdleFlushTimer();
        const { minIdleFlushChars, idleFlushMs } = TTS_CHUNKING_DEFAULTS;
        if (bufferRef.current.trim().length < minIdleFlushChars) return;

        idleFlushTimerRef.current = window.setTimeout(() => {
          if (runIdRef.current !== runId) return;
          const provider = resolveActiveProvider(runId);
          if (!provider) {
            bufferRef.current = "";
            browserQueueRef.current = [];
            pocketQueueRef.current = [];
            pocketStreamNeedsExplicitEndRef.current = false;
            pocketStreamOpenRef.current = false;
            return;
          }

          const { chunk, remaining } = takeIdleTtsChunkCandidate(
            bufferRef.current,
          );
          bufferRef.current = remaining;
          if (chunk) {
            if (provider === "browser") {
              enqueueBrowserChunks(runId, [chunk]);
            } else if (provider === "pocket_tts") {
              enqueuePocketChunks(runId, [chunk]);
            } else {
              enqueueElevenLabsChunks(runId, [chunk]);
            }
          }

          if (bufferRef.current.trim().length >= minIdleFlushChars) {
            schedule();
          }
        }, idleFlushMs);
      };

      schedule();
    },
    [
      clearIdleFlushTimer,
      enqueueBrowserChunks,
      enqueueElevenLabsChunks,
      enqueuePocketChunks,
      resolveActiveProvider,
    ],
  );

  useEffect(() => {
    const unsubscribePlaybackStarted = onPocketCoreEvent(
      "playback_started",
      (event) => {
        const runId = runIdRef.current;
        if (!runId) return;
        const provider = resolveActiveProvider(runId);
        if (provider !== "pocket_tts") return;
        const runSeq = runSeqRef.current;
        const generationId = readPocketGenerationId(event);
        const audioStartSec = readPocketPlaybackStartSec(event);
        if (generationId) {
          activePocketGenerationIdRef.current = generationId;
        }
        pocketPlaybackEndedRef.current = false;
        emitAudioStarted(runId, "pocket_tts", runSeq, {
          audioStartSec,
          audioContext: getPocketAudioContext(),
          generationId,
        });
      },
    );

    const unsubscribePlaybackEnded = onPocketCoreEvent(
      "playback_ended",
      (event) => {
        const runId = runIdRef.current;
        if (!runId) return;
        const provider = resolveActiveProvider(runId);
        if (provider !== "pocket_tts") return;

        const generationId = readPocketGenerationId(event);
        const activeGenerationId = activePocketGenerationIdRef.current;
        if (
          generationId &&
          activeGenerationId &&
          generationId !== activeGenerationId
        ) {
          logger.info("Playback", "Ignored stale Pocket playback end event", {
            runId,
            generationId,
            activeGenerationId,
          });
          return;
        }

        pocketPlaybackEndedRef.current = true;
        onPlaybackEndedSignal?.({
          runId,
          provider: "pocket_tts",
          generationId: generationId ?? null,
        });
        logger.info("Playback", "Pocket playback ended signal received", {
          runId,
          provider: "pocket_tts",
          generationId: generationId ?? null,
          runCompleted: runCompletedRef.current,
        });
        maybeEmitPocketAudioEnded(runId, runSeqRef.current);
      },
    );

    const unsubscribeGenerationFinished = onPocketCoreEvent(
      "generation_finished",
      (event) => {
        const runId = runIdRef.current;
        if (!runId) return;
        const provider = resolveActiveProvider(runId);
        if (provider !== "pocket_tts") return;

        const generationId = readPocketGenerationId(event);
        const activeGenerationId = activePocketGenerationIdRef.current;
        if (
          generationId &&
          activeGenerationId &&
          generationId !== activeGenerationId
        ) {
          logger.info(
            "Playback",
            "Ignored stale Pocket generation finished event",
            {
              runId,
              generationId,
              activeGenerationId,
            },
          );
          return;
        }

        const audioDurationSec = readPocketAudioDurationSec(event);
        if (!audioDurationSec) return;
        emitPocketAudioDurationResolved(
          runId,
          runSeqRef.current,
          audioDurationSec,
          generationId,
        );
      },
    );

    return () => {
      unsubscribePlaybackStarted();
      unsubscribePlaybackEnded();
      unsubscribeGenerationFinished();
    };
  }, [
    emitPocketAudioDurationResolved,
    emitAudioStarted,
    getPocketAudioContext,
    logger,
    maybeEmitPocketAudioEnded,
    onPlaybackEndedSignal,
    onPocketCoreEvent,
    resolveActiveProvider,
  ]);

  const startRun = useCallback(
    (runId: string) => {
      if (!runId) return;
      if (runIdRef.current === runId) return;
      cancelAll();
      runIdRef.current = runId;
      warnedKeysRef.current.clear();
      const provider = resolveActiveProvider(runId);
      if (provider === "elevenlabs" || provider === "gemini") {
        const speechContext = resolveSpeechRuntimeContext(runId);
        if (!speechContext?.animaId) {
          warnOnceForRun(
            runId,
            `${provider}_missing_persona`,
            `${provider === "gemini" ? "Gemini" : "ElevenLabs"} TTS requires an Anima context for this response.`,
          );
        } else if (isFinalizedServerProvider(provider)) {
          finalizedProviderRef.current = provider;
          prepareFinalizedRun(runId);
          logger.info("Run", "Waiting for finalized server speech text", {
            runId,
            provider,
            modelId: speechContext.modelId,
          });
        } else {
          void startElevenLabsRuntime(runId, speechContext);
        }
      }
      logger.info("Run", "Started TTS run", { runId });
    },
    [
      cancelAll,
      logger,
      prepareFinalizedRun,
      resolveActiveProvider,
      resolveSpeechRuntimeContext,
      startElevenLabsRuntime,
      warnOnceForRun,
    ],
  );

  const appendToken = useCallback(
    (runId: string, token: string, options?: TtsAppendOptions) => {
      if (!runId || !token) return;
      if (runIdRef.current !== runId) {
        startRun(runId);
      }
      if (runIdRef.current !== runId) return;

      const provider = resolveActiveProvider(runId);
      if (!provider) return;

      if (options?.textBasis === "gruut_text_with_ws") {
        finalizedTextBasisByRunRef.current[runId] = "gruut_text_with_ws";
      }
      bufferRef.current += token;
      runSpeechTextRef.current += token;
      if (!shouldStreamChunksForProvider(provider)) {
        return;
      }

      const { chunks, remaining } = extractReadyTtsChunkCandidates(
        bufferRef.current,
      );
      bufferRef.current = remaining;

      if (chunks.length > 0) {
        if (provider === "browser") {
          enqueueBrowserChunks(runId, chunks);
        } else if (provider === "pocket_tts") {
          enqueuePocketChunks(runId, chunks);
        } else {
          enqueueElevenLabsChunks(runId, chunks);
        }
      }
      scheduleIdleFlush(runId);
    },
    [
      enqueueBrowserChunks,
      enqueueElevenLabsChunks,
      enqueuePocketChunks,
      resolveActiveProvider,
      scheduleIdleFlush,
      shouldStreamChunksForProvider,
      startRun,
    ],
  );

  const completeRun = useCallback(
    (runId: string) => {
      if (!runId) return;
      if (runIdRef.current !== runId) return;
      clearIdleFlushTimer();
      runCompletedRef.current = true;
      const runSeq = runSeqRef.current;

      const provider = resolveActiveProvider(runId);
      if (!provider) {
        bufferRef.current = "";
        browserQueueRef.current = [];
        pocketQueueRef.current = [];
        pocketStreamNeedsExplicitEndRef.current = false;
        pocketStreamOpenRef.current = false;
        emitAudioEnded(runId, null, runSeq, "natural");
        return;
      }

      const streamChunks = shouldStreamChunksForProvider(provider);
      const chunks = streamChunks
        ? flushRemainingTtsChunkCandidates(bufferRef.current)
        : (() => {
            const finalChunk = bufferRef.current.trim();
            return finalChunk
              ? [
                  {
                    text: finalChunk,
                    boundaryType: "final" as const,
                    isExclamation: isExclamationTtsChunk(finalChunk),
                    wordCount: countTtsChunkWords(finalChunk),
                  },
                ]
              : [];
          })();
      bufferRef.current = "";

      if (provider === "browser") {
        activePocketVoiceSelectionRef.current = null;
        enqueueBrowserChunks(runId, chunks);
        maybeEmitBrowserAudioEnded(runId, runSeq);
      } else if (provider === "pocket_tts") {
        activePocketVoiceSelectionRef.current =
          resolvePocketVoiceSelectionForRun(runId);
        if (chunks.length > 0) {
          enqueuePocketChunks(runId, chunks, { markLastChunkAsFinal: true });
        } else if (pocketQueueRef.current.length > 0) {
          pocketQueueRef.current[pocketQueueRef.current.length - 1]!.endStream =
            true;
          pocketStreamNeedsExplicitEndRef.current = false;
        } else if (pocketStreamOpenRef.current) {
          pocketStreamNeedsExplicitEndRef.current = true;
          drainPocketQueue();
        } else if (!audioStartedRef.current) {
          emitAudioEnded(runId, "pocket_tts", runSeq, "natural");
        }
        maybeEmitPocketAudioEnded(runId, runSeq);
      } else {
        const speechContext = resolveSpeechRuntimeContext(runId);
        if (speechContext?.animaId) {
          if (isFinalizedServerProvider(provider)) {
            delete finalizedTextBasisByRunRef.current[runId];
            logger.info("Run", "Waiting for pushed finalized audio", {
              runId,
              provider,
              modelId: speechContext.modelId,
            });
          } else {
            enqueueElevenLabsChunks(runId, chunks);
            completeElevenLabsRuntime(runId, speechContext);
          }
        } else {
          emitAudioEnded(runId, provider, runSeq, "error");
        }
      }

      logger.info("Run", "Completed TTS run", {
        runId,
        chunks: chunks.length,
        streamChunks,
      });
    },
    [
      clearIdleFlushTimer,
      enqueueBrowserChunks,
      enqueueElevenLabsChunks,
      enqueuePocketChunks,
      completeElevenLabsRuntime,
      drainPocketQueue,
      emitAudioEnded,
      logger,
      maybeEmitBrowserAudioEnded,
      maybeEmitPocketAudioEnded,
      resolveActiveProvider,
      resolveSpeechRuntimeContext,
      resolvePocketVoiceSelectionForRun,
      shouldStreamChunksForProvider,
    ],
  );

  const acceptElevenLabsSession = useCallback(
    (runId: string, session: ElevenLabsSessionResponse) => {
      if (!runId) return;
      const provider = resolveActiveProvider(runId);
      if (provider !== "elevenlabs") return;
      const speechContext = resolveSpeechRuntimeContext(runId);
      if (!speechContext?.animaId) {
        warnOnceForRun(
          runId,
          "elevenlabs_missing_persona",
          "ElevenLabs TTS requires a anima context for this response.",
        );
        return;
      }
      void startElevenLabsRuntime(runId, speechContext);
      acceptElevenLabsRuntimeSession(runId, session);
    },
    [
      acceptElevenLabsRuntimeSession,
      resolveActiveProvider,
      resolveSpeechRuntimeContext,
      startElevenLabsRuntime,
      warnOnceForRun,
    ],
  );

  const markElevenLabsSessionFailed = useCallback(
    (runId: string, error: ElevenLabsSessionError | string) => {
      if (!runId) return;
      const provider = resolveActiveProvider(runId);
      if (provider !== "elevenlabs") return;
      markElevenLabsRuntimeSessionFailed(runId, error);
    },
    [markElevenLabsRuntimeSessionFailed, resolveActiveProvider],
  );

  const acceptFinalizedAudio = useCallback(
    (runId: string, payload: FinalizedTtsAudioPayload) => {
      if (!runId) return;
      const provider = resolveActiveProvider(runId);
      if (!isFinalizedServerProvider(provider)) return;
      acceptFinalizedAudioChunk(runId, payload);
    },
    [acceptFinalizedAudioChunk, resolveActiveProvider],
  );

  const completeFinalizedAudio = useCallback(
    (runId: string) => {
      if (!runId) return;
      const provider = resolveActiveProvider(runId);
      if (!isFinalizedServerProvider(provider)) return;
      finishFinalizedPushedStream(runId);
    },
    [finishFinalizedPushedStream, resolveActiveProvider],
  );

  const markFinalizedAudioFailed = useCallback(
    (runId: string, error: FinalizedTtsErrorPayload | string) => {
      if (!runId) return;
      const provider = resolveActiveProvider(runId);
      if (!isFinalizedServerProvider(provider)) return;
      failFinalizedPushedStream(runId, error);
    },
    [failFinalizedPushedStream, resolveActiveProvider],
  );

  /**
   * Speak the active run with Pocket TTS after the server declined its
   * ElevenLabs speech (an exhausted voice allowance), before or after the reply
   * text arrived. The declined path closes without a failure notice or an
   * audio end, and Pocket speaks the whole reply at completion like any Pocket
   * run, choosing its voice the same way. Returns false and
   * changes nothing for an inactive run or one `canFallBackToPocketTts`
   * refuses. Stop, the next run and teardown (`cancelAll`) end the switch.
   */
  const fallBackToPocketTts = useCallback(
    (runId: string): boolean => {
      if (!runId || runIdRef.current !== runId) return false;
      if (declinedElevenLabsRunIdRef.current === runId) return true;
      if (
        !canFallBackToPocketTts({
          provider: resolveActiveProvider(runId),
          audioStarted: audioStartedRef.current,
          audioEnded: audioEndedRef.current,
          pocketSupported: isPocketTtsSupported(),
        })
      ) {
        return false;
      }
      clearIdleFlushTimer();
      // Only an ElevenLabs run falls back, so only its realtime speech stops.
      stopElevenLabsRuntime();
      declinedElevenLabsRunIdRef.current = runId;
      setPocketFallbackUsed(true);
      // Text already sent to ElevenLabs was never spoken; Pocket starts over.
      bufferRef.current = runSpeechTextRef.current;
      logger.info("Run", "Speaking with PocketTTS after declined speech", {
        runId,
        runCompleted: runCompletedRef.current,
      });
      void warmupPocketRuntime().catch((error) => {
        logger.warn("Warmup", "PocketTTS warmup failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      // The decline followed the reply's completed speech text: speak it now.
      if (runCompletedRef.current) completeRun(runId);
      return true;
    },
    [
      clearIdleFlushTimer,
      completeRun,
      logger,
      resolveActiveProvider,
      stopElevenLabsRuntime,
      warmupPocketRuntime,
    ],
  );

  useEffect(() => {
    return () => {
      cancelAll();
    };
  }, [cancelAll]);

  useEffect(() => {
    cancelAll();
  }, [
    cancelAll,
    effectivePreferences.speech?.tts_enabled,
    effectivePreferences.speech?.tts_elevenlabs_model_id,
    effectivePreferences.speech?.tts_provider,
  ]);

  useEffect(() => {
    if (
      !shouldPreparePocketTts(
        settingsLoaded,
        effectivePreferences.speech?.tts_enabled,
        effectivePreferences.speech?.tts_provider,
      )
    )
      return;

    void warmupPocketRuntime().catch((error) => {
      logger.warn("Warmup", "PocketTTS warmup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, [
    settingsLoaded,
    effectivePreferences.speech?.tts_enabled,
    effectivePreferences.speech?.tts_provider,
    logger,
    warmupPocketRuntime,
  ]);

  useEffect(() => {
    if (
      !shouldPreparePocketTts(
        settingsLoaded,
        effectivePreferences.speech?.tts_enabled,
        effectivePreferences.speech?.tts_provider,
      )
    )
      return;

    const animaCatalogReference =
      resolvePocketAnimaCatalogReferenceForPreload();
    if (!animaCatalogReference) {
      lastPreloadedPocketAnimaRefRef.current = null;
      return;
    }
    if (lastPreloadedPocketAnimaRefRef.current === animaCatalogReference) {
      return;
    }

    void preloadPocketAnimaVoices(animaCatalogReference)
      .then(() => {
        lastPreloadedPocketAnimaRefRef.current = animaCatalogReference;
        logger.info("Warmup", "Preloaded Pocket anima voice catalog", {
          animaCatalogReference,
        });
      })
      .catch((error) => {
        logger.warn("Warmup", "Pocket anima voice catalog preload failed", {
          animaCatalogReference,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [
    settingsLoaded,
    effectivePreferences.speech?.tts_enabled,
    effectivePreferences.speech?.tts_provider,
    logger,
    preloadPocketAnimaVoices,
    resolvePocketAnimaCatalogReferenceForPreload,
  ]);

  return {
    startRun,
    appendToken,
    completeRun,
    acceptElevenLabsSession,
    markElevenLabsSessionFailed,
    acceptFinalizedAudio,
    completeFinalizedAudio,
    markFinalizedAudioFailed,
    fallBackToPocketTts,
    cancelAll,
    isAudioActive,
  };
}

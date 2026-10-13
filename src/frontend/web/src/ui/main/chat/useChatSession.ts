"use client";
import { useCallback, useMemo } from "react";
import {
  useProductChatSession,
  type UseProductChatSessionArgs,
  type ChatSessionEffects,
  type ChatSpeechPolicy,
} from "@animama/product-ui/chat";
import { useAnima } from "@/query/hooks/useAnima";
import { useRuntimeCapabilities } from "@/query/hooks/useRuntimeCapabilities";
import { useSettings } from "@/ui/settings/SettingsProvider";
import { useRuntimePlatform } from "@/platform/RuntimePlatformProvider";
import { useMountedAnimaRuntimeContent } from "@/ui/app/AnimaRouteProviders";
import { useAvatarRuntimeStore } from "@/stores/avatar-runtime-store";
import { useAvatarLipSyncBridgeStore } from "@/stores/avatar-lipsync-bridge-store";
import { useTtsPlayback } from "@/hooks/use-tts-playback";
import { createLogger } from "@/lib/logger";
import {
  resolvePreferredTtsProvider,
  toTtsProvider,
} from "@/lib/speech/tts-provider";
import {
  DEFAULT_ELEVENLABS_TTS_MODEL_ID,
  DEFAULT_GEMINI_TTS_MODEL_ID,
  toElevenLabsTtsModelId,
  toGeminiTtsModelId,
} from "@/lib/settings/preferences";
import { buildElevenLabsChatTtsDispatchOptions } from "@/lib/chat/elevenlabs-chat-tts-dispatch";
import { buildGeminiChatTtsDispatchOptions } from "@/lib/chat/gemini-chat-tts-dispatch";
import type { PocketAnimaVoiceSelectionContext } from "@/lib/speech/pocket/anima-voice-selection";
export {
  chatSessionCanChat,
  type ChatMessage,
  type PendingModelSwitch,
} from "@animama/product-ui/chat";

/** Providers whose audio drives viseme lip-sync from gruut phonemes. */
const VISEME_SYNC_PROVIDERS = new Set(["pocket_tts", "elevenlabs", "gemini"]);

function syncsVisemes(provider: string | null): boolean {
  return provider !== null && VISEME_SYNC_PROVIDERS.has(provider);
}

type UseChatSessionArgs = Omit<
  UseProductChatSessionArgs,
  "runtime" | "effects" | "speech" | "dispatchOptions"
>;

/** Local composition supplies settings, playback and mounted-content effects to the shared session. */
export function useChatSession(args: UseChatSessionArgs) {
  const { animaId } = args;
  const logger = useMemo(() => createLogger("ChatInterface"), []);
  const { data: anima } = useAnima(animaId);
  const { chatRequestOptions, effectivePreferences } = useSettings();
  const runtimeCapabilities = useRuntimeCapabilities();
  const platform = useRuntimePlatform();
  const mountedRuntimeContent = useMountedAnimaRuntimeContent();
  const resetAvatarRuntime = useAvatarRuntimeStore(
    (state) => state.resetForAnima,
  );
  const setAnimaEmotionSnapshot = useAvatarRuntimeStore(
    (state) => state.setAnimaEmotionSnapshot,
  );
  const startAvatarRun = useAvatarRuntimeStore((state) => state.startRun);
  const markNonTtsResponseStarted = useAvatarRuntimeStore(
    (state) => state.markNonTtsResponseStarted,
  );
  const requestNonTtsResponseCompletion = useAvatarRuntimeStore(
    (state) => state.requestNonTtsResponseCompletion,
  );
  const markAvatarSpeechStarted = useAvatarRuntimeStore(
    (state) => state.markSpeechStarted,
  );
  const markAvatarSpeechEnded = useAvatarRuntimeStore(
    (state) => state.markSpeechEnded,
  );
  const finishAvatarRun = useAvatarRuntimeStore((state) => state.finishRun);
  const abortAvatarRun = useAvatarRuntimeStore((state) => state.abortRun);
  const applyAvatarEmotionUpdate = useAvatarRuntimeStore(
    (state) => state.applyEmotionUpdate,
  );
  const requestAvatarGesture = useAvatarRuntimeStore(
    (state) => state.requestGesture,
  );
  const queueAvatarVisemeInputsForRun = useAvatarLipSyncBridgeStore(
    (state) => state.queueVisemeInputsForRun,
  );
  const markAvatarSpeechAudioStarted = useAvatarLipSyncBridgeStore(
    (state) => state.markSpeechAudioStarted,
  );
  const markAvatarSpeechAudioDurationResolved = useAvatarLipSyncBridgeStore(
    (state) => state.markSpeechAudioDurationResolved,
  );
  const queueAvatarTtsChunksForRun = useAvatarLipSyncBridgeStore(
    (state) => state.queueTtsChunksForRun,
  );
  const appendProviderSpeechTiming = useAvatarLipSyncBridgeStore(
    (state) => state.appendProviderSpeechTiming,
  );
  const clearAvatarVisemeBridgeRun = useAvatarLipSyncBridgeStore(
    (state) => state.clearRun,
  );
  const clearAvatarVisemeBridgeAll = useAvatarLipSyncBridgeStore(
    (state) => state.clearAll,
  );
  const handleTtsAudioStarted = useCallback(
    ({
      runId,
      provider,
      audioStartSec,
      audioContext,
      generationId,
    }: {
      runId: string;
      provider: string | null;
      audioStartSec?: number | null;
      audioContext?: AudioContext | null;
      generationId?: string | null;
    }) => {
      logger.info("TTS", "Audio started", {
        runId,
        provider,
        audioStartSec: audioStartSec ?? null,
        generationId: generationId ?? null,
      });
      markAvatarSpeechStarted(runId);
      if (!syncsVisemes(provider)) {
        logger.info(
          "TTS",
          "Skipped viseme sync audio-start hook for provider",
          {
            runId,
            provider,
          },
        );
        return;
      }
      if (!audioContext || typeof audioStartSec !== "number") {
        logger.warn("TTS", "Speech audio start missing viseme sync timing", {
          runId,
          provider,
          hasAudioContext: Boolean(audioContext),
          audioStartSec: audioStartSec ?? null,
        });
        return;
      }
      markAvatarSpeechAudioStarted({
        runId,
        audioStartSec,
        audioContext,
        generationId: generationId ?? null,
      });
    },
    [logger, markAvatarSpeechAudioStarted, markAvatarSpeechStarted],
  );
  const handleTtsAudioEnded = useCallback(
    ({
      runId,
      provider,
      reason,
    }: {
      runId: string;
      provider: string | null;
      reason: "natural" | "error";
    }) => {
      logger.info("TTS", "Audio ended", { runId, provider, reason });
      markAvatarSpeechEnded(runId);
      finishAvatarRun(runId);
      clearAvatarVisemeBridgeRun(runId, { clearAvatarLipSync: true });
    },
    [
      clearAvatarVisemeBridgeRun,
      finishAvatarRun,
      logger,
      markAvatarSpeechEnded,
    ],
  );
  const handleTtsPlaybackEndedSignal = useCallback(
    ({
      runId,
      provider,
      generationId,
    }: {
      runId: string;
      provider: string | null;
      generationId?: string | null;
    }) => {
      logger.info("TTS", "Playback ended signal received", {
        runId,
        provider,
        generationId: generationId ?? null,
      });
      if (!syncsVisemes(provider)) {
        logger.info(
          "TTS",
          "Skipped viseme hard-stop for playback-ended signal provider",
          {
            runId,
            provider,
          },
        );
        return;
      }
      logger.info(
        "TTS",
        "Hard-stopping avatar lip-sync on speech playback end",
        {
          runId,
          generationId: generationId ?? null,
        },
      );
      clearAvatarVisemeBridgeRun(runId, { clearAvatarLipSync: true });
    },
    [clearAvatarVisemeBridgeRun, logger],
  );
  const handleTtsAudioDurationResolved = useCallback(
    ({
      runId,
      provider,
      audioDurationSec,
      generationId,
    }: {
      runId: string;
      provider: string | null;
      audioDurationSec: number;
      generationId?: string | null;
    }) => {
      logger.info("TTS", "Audio duration resolved", {
        runId,
        provider,
        audioDurationSec,
        generationId: generationId ?? null,
      });
      if (!syncsVisemes(provider)) {
        logger.info("TTS", "Skipped viseme duration hook for provider", {
          runId,
          provider,
        });
        return;
      }
      markAvatarSpeechAudioDurationResolved({
        runId,
        audioDurationSec,
        generationId: generationId ?? null,
      });
    },
    [logger, markAvatarSpeechAudioDurationResolved],
  );
  const handleTtsChunksQueued = useCallback(
    (event: Parameters<typeof queueAvatarTtsChunksForRun>[0]) => {
      queueAvatarTtsChunksForRun(event);
    },
    [queueAvatarTtsChunksForRun],
  );
  const getPocketVoiceSelectionContext = useCallback(
    (runId: string): PocketAnimaVoiceSelectionContext | null => {
      void runId;
      if (!animaId || anima?.id !== animaId) return null;

      const runtimeState = useAvatarRuntimeStore.getState();
      const dominantEmotion = runtimeState.emotionalState.dominantEmotion;

      return {
        animaId,
        emotionLabel: dominantEmotion?.group ?? "neutral",
        emotionIntensity: dominantEmotion?.intensity ?? 1,
        animaVoiceCatalogUrl: anima?.pocket_voice_catalog_url ?? null,
        mountedVoice: mountedRuntimeContent.pocketVoice,
      };
    },
    [
      anima?.id,
      anima?.pocket_voice_catalog_url,
      animaId,
      mountedRuntimeContent.pocketVoice,
    ],
  );
  const ttsEnabled = effectivePreferences.speech?.tts_enabled === true;
  // Gemini speaks only where the composition offers it.
  const geminiTtsOffered = runtimeCapabilities.data?.gemini_tts != null;
  const ttsProvider = ttsEnabled
    ? resolvePreferredTtsProvider({
        savedProvider: toTtsProvider(effectivePreferences.speech?.tts_provider),
        platform,
        offers: { gemini: geminiTtsOffered },
      }).provider
    : null;
  const elevenLabsModelId =
    ttsProvider === "elevenlabs"
      ? (toElevenLabsTtsModelId(
          effectivePreferences.speech?.tts_elevenlabs_model_id,
        ) ?? DEFAULT_ELEVENLABS_TTS_MODEL_ID)
      : null;
  const geminiModelId =
    ttsProvider === "gemini"
      ? (toGeminiTtsModelId(effectivePreferences.speech?.tts_gemini_model_id) ??
        DEFAULT_GEMINI_TTS_MODEL_ID)
      : null;
  const {
    startRun: startTtsRun,
    appendToken: appendTtsToken,
    completeRun: completeTtsRun,
    acceptElevenLabsSession,
    markElevenLabsSessionFailed,
    acceptFinalizedAudio,
    completeFinalizedAudio,
    markFinalizedAudioFailed,
    fallBackToPocketTts,
    cancelAll: cancelTts,
    isAudioActive: isTtsAudioActive,
  } = useTtsPlayback({
    onAudioStarted: handleTtsAudioStarted,
    onAudioDurationResolved: handleTtsAudioDurationResolved,
    onPlaybackEndedSignal: handleTtsPlaybackEndedSignal,
    onAudioEnded: handleTtsAudioEnded,
    onChunksQueued: handleTtsChunksQueued,
    onSpeechTiming: appendProviderSpeechTiming,
    getPocketVoiceSelectionContext,
    geminiTtsOffered,
    getSpeechVoiceSelectionContext: (runId) => {
      const context = getPocketVoiceSelectionContext(runId);
      if (!context) return null;
      return {
        animaId: context.animaId,
        emotionLabel: context.emotionLabel,
        emotionIntensity: context.emotionIntensity,
        languageCode: null,
        modelId:
          geminiModelId ??
          toElevenLabsTtsModelId(
            effectivePreferences.speech?.tts_elevenlabs_model_id,
          ) ??
          DEFAULT_ELEVENLABS_TTS_MODEL_ID,
        animaVoiceCatalogUrl: context.animaVoiceCatalogUrl,
      };
    },
  });

  const effects: ChatSessionEffects = {
    resetAvatarRuntime,
    setAnimaEmotionSnapshot,
    startAvatarRun,
    markNonTtsResponseStarted,
    requestNonTtsResponseCompletion,
    markAvatarSpeechEnded,
    finishAvatarRun,
    abortAvatarRun,
    applyAvatarEmotionUpdate,
    requestAvatarGesture,
    queueAvatarVisemeInputsForRun,
    clearAvatarVisemeBridgeRun,
    clearAvatarVisemeBridgeAll,
    startTtsRun,
    appendTtsToken,
    completeTtsRun,
    acceptElevenLabsSession,
    markElevenLabsSessionFailed,
    acceptFinalizedAudio,
    completeFinalizedAudio,
    markFinalizedAudioFailed,
    fallBackToPocketTts,
    cancelTts,
    isTtsAudioActive,
  };
  const speech: ChatSpeechPolicy = {
    enabled: ttsEnabled,
    provider: ttsProvider,
    elevenLabsModelId,
    // Only Gemini pushes finalized audio; ElevenLabs speaks in realtime.
    finalizedServerAudio: ttsProvider === "gemini",
    dispatchOptions:
      ttsEnabled && ttsProvider === "elevenlabs"
        ? {
            tts: buildElevenLabsChatTtsDispatchOptions({
              modelId: elevenLabsModelId ?? DEFAULT_ELEVENLABS_TTS_MODEL_ID,
            }),
          }
        : ttsEnabled && ttsProvider === "gemini"
          ? {
              tts: buildGeminiChatTtsDispatchOptions({
                modelId: geminiModelId ?? DEFAULT_GEMINI_TTS_MODEL_ID,
              }),
            }
          : undefined,
  };
  return useProductChatSession({
    ...args,
    runtime: mountedRuntimeContent,
    effects,
    speech,
    dispatchOptions: chatRequestOptions,
    webSearch: runtimeCapabilities.data?.web_search,
  });
}

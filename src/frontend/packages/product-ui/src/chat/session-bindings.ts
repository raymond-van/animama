import type { PyAnimaDispatchOptions } from "@animama/runtime-contracts/api-types";

export type InputMode = "typed" | "dictation" | "voice";
export type VoiceSubmitReason =
  | "manual"
  | "semantic_end_turn"
  | "silence_timeout";

/** The issued server fence is required even when visual playback is unavailable. */
export type ChatRuntimeFence = {
  runtimeRevision: string | null;
  canChat: boolean;
  remountLatest: () => Promise<unknown>;
};

type ClearOptions = { clearAvatarLipSync?: boolean };
type TtsError = {
  error?: string | null;
  code?: string | null;
  status_code?: number | null;
  details?: unknown;
};

/** Playback adapters own browser/native audio and avatar instances; the session owns lifecycle order. */
export type ChatSessionEffects = {
  resetAvatarRuntime: (animaId: string | null) => void;
  setAnimaEmotionSnapshot: (snapshot: unknown) => void;
  startAvatarRun: (
    runId: string,
    options?: { inputText?: string | null },
  ) => void;
  markNonTtsResponseStarted: (runId: string) => void;
  requestNonTtsResponseCompletion: (runId: string) => void;
  markAvatarSpeechEnded: (runId: string) => void;
  finishAvatarRun: (runId?: string | null) => void;
  abortAvatarRun: (runId?: string | null) => void;
  applyAvatarEmotionUpdate: (update: {
    eventId?: string | null;
    runId?: string | null;
    emotions?: unknown;
    emotionalTone?: string | null;
    emotionalIntensity?: number | null;
  }) => void;
  requestAvatarGesture: (request: {
    eventId?: string | null;
    runId?: string | null;
    gesture?: string | null;
  }) => void;
  queueAvatarVisemeInputsForRun: (args: {
    runId: string;
    phonemizedText: string[][] | null;
    tokenizedText: string | null;
    provider?: "pocket_tts" | "elevenlabs" | "gemini";
  }) => void;
  clearAvatarVisemeBridgeRun: (
    runId?: string | null,
    options?: ClearOptions,
  ) => void;
  clearAvatarVisemeBridgeAll: (options?: ClearOptions) => void;
  startTtsRun: (runId: string) => void;
  appendTtsToken: (
    runId: string,
    token: string,
    options?: { textBasis?: "plain" | "gruut_text_with_ws" | null },
  ) => void;
  completeTtsRun: (runId: string) => void;
  acceptElevenLabsSession: (
    runId: string,
    session: {
      voice_id: string;
      model_id: string;
      output_format: string;
      sync_alignment: boolean;
      language_code?: string | null;
      token?: string | null;
      websocket_base_url?: string | null;
      /** Server transport is cookie-authorized at the admitted application origin. */
      transport?: "direct" | "server";
      websocket_url?: string | null;
    },
  ) => void;
  markElevenLabsSessionFailed: (
    runId: string,
    error: TtsError | string,
  ) => void;
  acceptFinalizedAudio: (
    runId: string,
    payload: {
      run_id?: string | null;
      model_id?: string | null;
      output_format?: string | null;
      audio_base64?: string | null;
    },
  ) => void;
  completeFinalizedAudio: (runId: string) => void;
  markFinalizedAudioFailed: (runId: string, error: TtsError | string) => void;
  /**
   * Speak a run with Pocket TTS after the server declined its ElevenLabs speech
   * because the owner's voice allowance is exhausted, for that run only.
   * Returns whether the run switched; when it did not (or without this
   * adapter), the run's speech ends as for any other speech error.
   */
  fallBackToPocketTts?: (runId: string) => boolean;
  cancelTts: () => void;
  isTtsAudioActive: boolean;
};

/** Explicit text-only playback adapter, usable when the host supplies no speech/avatar capability. */
const ignore = () => undefined;
export const textOnlyChatEffects: ChatSessionEffects = {
  resetAvatarRuntime: ignore,
  setAnimaEmotionSnapshot: ignore,
  startAvatarRun: ignore,
  markNonTtsResponseStarted: ignore,
  requestNonTtsResponseCompletion: ignore,
  markAvatarSpeechEnded: ignore,
  finishAvatarRun: ignore,
  abortAvatarRun: ignore,
  applyAvatarEmotionUpdate: ignore,
  requestAvatarGesture: ignore,
  queueAvatarVisemeInputsForRun: ignore,
  clearAvatarVisemeBridgeRun: ignore,
  clearAvatarVisemeBridgeAll: ignore,
  startTtsRun: ignore,
  appendTtsToken: ignore,
  completeTtsRun: ignore,
  acceptElevenLabsSession: ignore,
  markElevenLabsSessionFailed: ignore,
  acceptFinalizedAudio: ignore,
  completeFinalizedAudio: ignore,
  markFinalizedAudioFailed: ignore,
  fallBackToPocketTts: () => false,
  cancelTts: ignore,
  isTtsAudioActive: false,
};

export type ChatSpeechPolicy = {
  enabled: boolean;
  provider: "browser" | "pocket_tts" | "elevenlabs" | "gemini" | null;
  elevenLabsModelId: string | null;
  /** The server pushes the reply's audio as `tts.audio` frames (Gemini). */
  finalizedServerAudio: boolean;
  dispatchOptions?: PyAnimaDispatchOptions;
};

export const textOnlySpeechPolicy: ChatSpeechPolicy = {
  enabled: false,
  provider: null,
  elevenLabsModelId: null,
  finalizedServerAudio: false,
};

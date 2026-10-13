"use client";

import type { TtsProviderPreference } from "@/lib/settings/preferences";
import {
  getRuntimePlatformSnapshot,
  type RuntimePlatform,
} from "@/platform/runtime-platform";

export type TtsProvider = TtsProviderPreference;

export const TTS_PROVIDERS = [
  "browser",
  "pocket_tts",
  "elevenlabs",
  "gemini",
] as const satisfies readonly TtsProvider[];

type TtsProviderSet = Record<TtsProvider, true>;

const TTS_PROVIDER_SET: TtsProviderSet = {
  browser: true,
  pocket_tts: true,
  elevenlabs: true,
  gemini: true,
};

export type TtsProviderOption = {
  id: TtsProvider;
  label: string;
  description: string;
  disabled: boolean;
  reason?: string;
};

export type ResolveTtsProviderResult = {
  provider: TtsProvider | null;
  hasExplicitPreference: boolean;
};

/** Providers the backend composition offers beyond the browser-only ones. */
export type TtsProviderOffers = {
  /** Gemini voice, present when runtime capabilities report `gemini_tts`. */
  gemini?: boolean;
};

type ResolveTtsProviderInput = {
  savedProvider?: TtsProvider | null;
  platform?: RuntimePlatform;
  /** Without an offer, a saved Gemini choice falls back like an unsupported provider. */
  offers?: TtsProviderOffers;
};

type SpeechSynthesisWindow = Window &
  typeof globalThis & {
    speechSynthesis?: SpeechSynthesis;
    SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };

function asSpeechSynthesisWindow(): SpeechSynthesisWindow | null {
  if (typeof window === "undefined") return null;
  return window as SpeechSynthesisWindow;
}

export function toTtsProvider(value: unknown): TtsProvider | null {
  if (typeof value !== "string") return null;
  if (value in TTS_PROVIDER_SET) return value as TtsProvider;
  return null;
}

/**
 * Whether to warm up and preload Pocket TTS from the effective preferences.
 *
 * Until the owner's settings are read (and if reading them fails), preferences
 * resolve from the defaults, which turn Pocket TTS on. Preparing it then would
 * download and run Pocket TTS for owners who turned speech off or chose another
 * provider; a reply that needs Pocket still starts it on demand.
 */
export function shouldPreparePocketTts(
  settingsLoaded: boolean,
  ttsEnabled: boolean | undefined,
  ttsProvider: unknown,
  supported: () => boolean = isPocketTtsSupported,
): boolean {
  return (
    settingsLoaded &&
    ttsEnabled === true &&
    toTtsProvider(ttsProvider) === "pocket_tts" &&
    supported()
  );
}

/**
 * Whether a run whose ElevenLabs speech the server declined (an exhausted voice
 * allowance) can speak with Pocket TTS instead. Only an ElevenLabs run that has
 * neither started nor ended audio switches, so a reply is never spoken twice or
 * after its speech ended, and only where Pocket TTS runs.
 */
export function canFallBackToPocketTts(run: {
  provider: TtsProvider | null;
  audioStarted: boolean;
  audioEnded: boolean;
  pocketSupported: boolean;
}): boolean {
  return (
    run.provider === "elevenlabs" &&
    !run.audioStarted &&
    !run.audioEnded &&
    run.pocketSupported
  );
}

export function isBrowserSpeechSynthesisSupported(
  platform: RuntimePlatform = getRuntimePlatformSnapshot(),
): boolean {
  if (platform.isDesktop) return false;
  const speechWindow = asSpeechSynthesisWindow();
  if (!speechWindow) return false;
  return (
    typeof speechWindow.speechSynthesis !== "undefined" &&
    typeof speechWindow.SpeechSynthesisUtterance !== "undefined"
  );
}

export function isPocketTtsSupported(): boolean {
  const speechWindow = asSpeechSynthesisWindow();
  if (!speechWindow) return false;
  if (!speechWindow.isSecureContext) return false;
  if (typeof speechWindow.Worker === "undefined") return false;

  const AudioContextCtor =
    speechWindow.AudioContext ?? speechWindow.webkitAudioContext;
  if (!AudioContextCtor || !AudioContextCtor.prototype) return false;

  return "audioWorklet" in AudioContextCtor.prototype;
}

export function isElevenLabsTtsSupported(): boolean {
  const speechWindow = asSpeechSynthesisWindow();
  if (!speechWindow) return false;
  if (!speechWindow.isSecureContext) return false;
  if (typeof speechWindow.WebSocket === "undefined") return false;

  const AudioContextCtor =
    speechWindow.AudioContext ?? speechWindow.webkitAudioContext;
  if (!AudioContextCtor || !AudioContextCtor.prototype) return false;

  return "audioWorklet" in AudioContextCtor.prototype;
}

/** Gemini audio is pushed by the server as PCM, so playback needs only Web Audio. */
export function isGeminiTtsSupported(): boolean {
  const speechWindow = asSpeechSynthesisWindow();
  if (!speechWindow) return false;
  const AudioContextCtor =
    speechWindow.AudioContext ?? speechWindow.webkitAudioContext;
  return Boolean(AudioContextCtor);
}

function getPocketTtsUnsupportedReason(): string | undefined {
  const speechWindow = asSpeechSynthesisWindow();
  if (!speechWindow) return "PocketTTS can only run in a browser context.";
  if (!speechWindow.isSecureContext) {
    return "PocketTTS requires HTTPS or localhost (secure context).";
  }
  if (typeof speechWindow.Worker === "undefined") {
    return "Web Workers are not supported in this browser.";
  }
  const AudioContextCtor =
    speechWindow.AudioContext ?? speechWindow.webkitAudioContext;
  if (!AudioContextCtor || !AudioContextCtor.prototype) {
    return "Web Audio API is not supported in this browser.";
  }
  if (!("audioWorklet" in AudioContextCtor.prototype)) {
    return "AudioWorklet is not supported in this browser.";
  }
  return undefined;
}

function getElevenLabsTtsUnsupportedReason(): string | undefined {
  const speechWindow = asSpeechSynthesisWindow();
  if (!speechWindow) return "ElevenLabs TTS can only run in a browser context.";
  if (!speechWindow.isSecureContext) {
    return "ElevenLabs TTS requires HTTPS or localhost (secure context).";
  }
  if (typeof speechWindow.WebSocket === "undefined") {
    return "WebSocket is not supported in this browser.";
  }
  const AudioContextCtor =
    speechWindow.AudioContext ?? speechWindow.webkitAudioContext;
  if (!AudioContextCtor || !AudioContextCtor.prototype) {
    return "Web Audio API is not supported in this browser.";
  }
  if (!("audioWorklet" in AudioContextCtor.prototype)) {
    return "AudioWorklet is not supported in this browser.";
  }
  return undefined;
}

export function isTtsProviderSupported(
  provider: TtsProvider,
  platform: RuntimePlatform = getRuntimePlatformSnapshot(),
): boolean {
  if (provider === "browser")
    return isBrowserSpeechSynthesisSupported(platform);
  if (provider === "pocket_tts") return isPocketTtsSupported();
  if (provider === "elevenlabs") return isElevenLabsTtsSupported();
  if (provider === "gemini") return isGeminiTtsSupported();
  return false;
}

export function getTtsProviderOptions(
  platform: RuntimePlatform = getRuntimePlatformSnapshot(),
  offers: TtsProviderOffers = {},
): TtsProviderOption[] {
  const isDesktop = platform.isDesktop;
  const browserSupported = isBrowserSpeechSynthesisSupported(platform);
  const pocketSupported = isPocketTtsSupported();
  const pocketReason = getPocketTtsUnsupportedReason();
  const elevenlabsSupported = isElevenLabsTtsSupported();
  const elevenlabsReason = getElevenLabsTtsUnsupportedReason();

  const options: TtsProviderOption[] = [
    {
      id: "browser",
      label: "Browser",
      description: "Browser speech synthesis via the Web Speech API.",
      disabled: !browserSupported,
      reason: browserSupported
        ? undefined
        : isDesktop
          ? "Browser TTS is unavailable in the desktop app."
          : "Speech synthesis is not supported in this browser.",
    },
    {
      id: "pocket_tts",
      label: "PocketTTS",
      description: "Client-side PocketTTS synthesis.",
      disabled: !pocketSupported,
      reason: pocketReason,
    },
    {
      id: "elevenlabs",
      label: "ElevenLabs",
      description: "Realtime ElevenLabs speech with Eleven v4 Turbo.",
      disabled: !elevenlabsSupported,
      reason: elevenlabsReason,
    },
  ];
  if (offers.gemini) {
    const geminiSupported = isGeminiTtsSupported();
    options.push({
      id: "gemini",
      label: "Gemini",
      description: "Gemini speech streamed from the server.",
      disabled: !geminiSupported,
      reason: geminiSupported
        ? undefined
        : "Web Audio API is not supported in this browser.",
    });
  }

  return isDesktop
    ? options.filter((option) => option.id !== "browser")
    : options;
}

export function resolvePreferredTtsProvider({
  savedProvider = null,
  platform = getRuntimePlatformSnapshot(),
  offers = {},
}: ResolveTtsProviderInput = {}): ResolveTtsProviderResult {
  if (
    savedProvider &&
    (savedProvider !== "gemini" || offers.gemini === true) &&
    isTtsProviderSupported(savedProvider, platform)
  ) {
    return {
      provider: savedProvider,
      hasExplicitPreference: true,
    };
  }

  if (isTtsProviderSupported("elevenlabs", platform)) {
    return {
      provider: "elevenlabs",
      hasExplicitPreference: false,
    };
  }

  // Gemini needs a key and a composition that offers it, so only an explicit choice selects it.
  const firstSupported = TTS_PROVIDERS.find(
    (provider) =>
      provider !== "gemini" && isTtsProviderSupported(provider, platform),
  );

  return {
    provider: firstSupported ?? null,
    hasExplicitPreference: false,
  };
}

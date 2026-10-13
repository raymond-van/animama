import type { GeminiTtsCapability } from "@animama/runtime-contracts/api-types";
import type { MicSensitivity } from "@/lib/voice/microphone-preferences";
import type { AppearanceOverrides } from "@/lib/theme/appearance-overrides";
import {
  DEFAULT_DESKTOP_SHORTCUTS,
  type DesktopShortcut,
  type DesktopShortcutAction,
} from "@/lib/settings/desktop-shortcuts";

export type PreferenceToggleSection = {
  disable_influence?: boolean;
  disable_updates?: boolean;
  [key: string]: unknown;
};

export type MemoryPreferences = PreferenceToggleSection;

/**
 * A job the owner assigns to a catalog model row in App Settings → Models.
 * `chat` is the model new Animas start with; `utility` writes chat titles and
 * compacts long chats.
 */
export type ModelRole = "chat" | "utility" | "memory_manager" | "embeddings";

/**
 * Catalog row ids for installation-wide model roles other than chat; null or
 * absent uses the default (the chat model for utility and the Memory Manager,
 * off for embeddings).
 */
export type ModelRolePreferences = {
  utility_model_provider_id?: string | null;
  memory_manager_model_provider_id?: string | null;
  embedding_model_provider_id?: string | null;
};

export type SttProviderPreference =
  | "parakeet"
  | "browser_external"
  | "browser_local";

export type TtsProviderPreference =
  | "browser"
  | "pocket_tts"
  | "elevenlabs"
  | "gemini";

/** ElevenLabs speaks every reply with Eleven v4 Turbo, streamed while the reply is written. */
export type ElevenLabsTtsModelId = "eleven_v4_turbo";
/** The backend's Gemini speech models; removing or renaming one there is a type error here. */
export type GeminiTtsModelId = GeminiTtsCapability["models"][number];

export const DEFAULT_ELEVENLABS_TTS_MODEL_ID =
  "eleven_v4_turbo" satisfies ElevenLabsTtsModelId;

/**
 * Retired ElevenLabs models and the model that now speaks for them. Saved
 * preferences keep a retired id until they are next written, so every read
 * maps it and the old id never reaches the backend.
 */
const RETIRED_ELEVENLABS_TTS_MODEL_REPLACEMENTS: Readonly<
  Record<string, ElevenLabsTtsModelId>
> = {
  eleven_flash_v2_5: "eleven_v4_turbo",
  eleven_multilingual_v2: "eleven_v4_turbo",
  eleven_v3: "eleven_v4_turbo",
};
export const DEFAULT_GEMINI_TTS_MODEL_ID =
  "gemini-3.8-flash-lite-tts" satisfies GeminiTtsModelId;

/** Labels for the Gemini speech models the backend accepts. */
export const GEMINI_TTS_MODEL_OPTIONS: Array<{
  id: GeminiTtsModelId;
  label: string;
  description: string;
}> = [
  {
    id: "gemini-3.8-flash-lite-tts",
    label: "Flash-Lite TTS",
    description: "Lower-latency, lower-cost Gemini speech.",
  },
  {
    id: "gemini-3.8-flash-tts",
    label: "Flash TTS",
    description: "Gemini's flagship speech model, at a higher cost.",
  },
];

export type SpeechPreferences = {
  stt_provider?: SttProviderPreference;
  /** Experimental: run local Parakeet on WebGPU when available (default off). */
  stt_parakeet_webgpu?: boolean;
  tts_enabled?: boolean;
  tts_provider?: TtsProviderPreference;
  tts_stream_chunks?: boolean;
  tts_elevenlabs_model_id?: ElevenLabsTtsModelId;
  tts_gemini_model_id?: GeminiTtsModelId;
  desktop_shortcuts?: Partial<Record<DesktopShortcutAction, DesktopShortcut>>;
  tts_pocket_voice?: string;
  tts_pocket_anima_voice?: string;
  tts_pocket_custom_voice_available?: boolean;
  tts_pocket_anima_custom_voice_available?: boolean;
  /** Voice-detection sensitivity; see `lib/voice/microphone-preferences.ts`. */
  mic_sensitivity?: MicSensitivity;
  [key: string]: unknown;
};

export type AvatarBackgroundPreferences = {
  background_id?: string;
  focal_x?: number;
  focal_y?: number;
  zoom?: number;
  [key: string]: unknown;
};

export type PresentationPreferences = {
  enable_avatar_transform_controls?: boolean;
  /** Render assistant replies as Markdown (default on). */
  render_markdown?: boolean;
  disable_animation?: boolean;
  disable_vfx?: boolean;
  avatar_background?: AvatarBackgroundPreferences | null;
  [key: string]: unknown;
};

/** Owner safety choices; they can only choose resources or add protection (spec R8). */
export type SafetyPreferences = {
  /** ISO region code, or null to follow the system locale. */
  crisis_resource_region?: string | null;
  /** Shorter AI-notice reminder interval in hours; longer values are ignored by the server. */
  reminder_hours?: number | null;
  [key: string]: unknown;
};

export type SettingsPreferences = {
  /** Keeps first-message suggestions dismissed across chats and deleted history. */
  has_sent_chat_message?: boolean;
  /** The Chat default (the model new Animas start with), set in App Settings → Models. */
  chat?: { default_model_provider_id?: string | null };
  /** Other model role assignments chosen in App Settings → Models. */
  models?: ModelRolePreferences;
  /** Per-mode colour overrides; see `lib/theme/appearance-overrides.ts`. */
  appearance?: AppearanceOverrides;
  memory?: MemoryPreferences;
  emotion?: PreferenceToggleSection;
  presentation?: PresentationPreferences;
  speech?: SpeechPreferences;
  safety?: SafetyPreferences;
  [key: string]: unknown;
};

export const DEFAULT_ANIMAMA_PREFERENCES: SettingsPreferences = {
  memory: { disable_influence: false, disable_updates: false },
  emotion: { disable_influence: false, disable_updates: false },
  speech: {
    tts_enabled: true,
    tts_provider: "pocket_tts",
    tts_elevenlabs_model_id: DEFAULT_ELEVENLABS_TTS_MODEL_ID,
    tts_stream_chunks: true,
    desktop_shortcuts: DEFAULT_DESKTOP_SHORTCUTS,
  },
  presentation: {
    enable_avatar_transform_controls: false,
    disable_animation: false,
    disable_vfx: false,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeSection(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const baseSection = isRecord(base[key])
    ? (base[key] as Record<string, unknown>)
    : undefined;
  const patchSection = isRecord(patch[key])
    ? (patch[key] as Record<string, unknown>)
    : undefined;
  if (!baseSection && !patchSection) return undefined;
  return { ...(baseSection ?? {}), ...(patchSection ?? {}) };
}

function mergeNestedRecord(
  base: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const baseValue = base && isRecord(base[key]) ? base[key] : undefined;
  const patchValue = patch && isRecord(patch[key]) ? patch[key] : undefined;
  if (!baseValue && !patchValue) return undefined;
  return {
    ...((baseValue as Record<string, unknown> | undefined) ?? {}),
    ...((patchValue as Record<string, unknown> | undefined) ?? {}),
  };
}

export function mergePreferences(
  base?: SettingsPreferences | null,
  patch?: SettingsPreferences | null,
): SettingsPreferences {
  const baseObj = isRecord(base) ? base : {};
  const patchObj = isRecord(patch) ? patch : {};
  const merged: SettingsPreferences = { ...baseObj, ...patchObj };

  const memory = mergeSection(baseObj, patchObj, "memory");
  const emotion = mergeSection(baseObj, patchObj, "emotion");
  const presentation = mergeSection(baseObj, patchObj, "presentation");
  const speech = mergeSection(baseObj, patchObj, "speech");
  const safety = mergeSection(baseObj, patchObj, "safety");
  const appearance = mergeSection(baseObj, patchObj, "appearance");
  const chat = mergeSection(baseObj, patchObj, "chat");
  const models = mergeSection(baseObj, patchObj, "models");
  if (chat) merged.chat = chat as SettingsPreferences["chat"];
  if (models) merged.models = models as ModelRolePreferences;

  if (memory) merged.memory = memory as PreferenceToggleSection;
  if (emotion) merged.emotion = emotion as PreferenceToggleSection;
  if (presentation)
    merged.presentation = presentation as PresentationPreferences;
  if (safety) merged.safety = safety as SafetyPreferences;
  if (appearance) {
    // Merge each mode separately so editing one colour keeps the others.
    const baseAppearance = isRecord(baseObj.appearance)
      ? (baseObj.appearance as Record<string, unknown>)
      : undefined;
    const patchAppearance = isRecord(patchObj.appearance)
      ? (patchObj.appearance as Record<string, unknown>)
      : undefined;
    for (const mode of ["light", "dark"]) {
      const modeValue = mergeNestedRecord(
        baseAppearance,
        patchAppearance,
        mode,
      );
      if (modeValue) appearance[mode] = modeValue;
    }
    merged.appearance = appearance as AppearanceOverrides;
  }
  if (speech) {
    const baseSpeech = isRecord(baseObj.speech)
      ? (baseObj.speech as Record<string, unknown>)
      : undefined;
    const patchSpeech = isRecord(patchObj.speech)
      ? (patchObj.speech as Record<string, unknown>)
      : undefined;
    const desktopShortcuts = mergeNestedRecord(
      baseSpeech,
      patchSpeech,
      "desktop_shortcuts",
    );
    if (desktopShortcuts) {
      speech.desktop_shortcuts = desktopShortcuts;
    }
    merged.speech = speech as SpeechPreferences;
  }

  return merged;
}

/** Where each role's catalog row id is stored: `[section, key]`. */
const MODEL_ROLE_PREFERENCE_PATHS = {
  chat: ["chat", "default_model_provider_id"],
  utility: ["models", "utility_model_provider_id"],
  memory_manager: ["models", "memory_manager_model_provider_id"],
  embeddings: ["models", "embedding_model_provider_id"],
} as const satisfies Record<ModelRole, readonly [string, string]>;

/** The dotted preference path of a role, as the server reports it in model usage. */
export function modelRolePreferencePath(role: ModelRole): string {
  return MODEL_ROLE_PREFERENCE_PATHS[role].join(".");
}

/** The owner's model for a role, or null for the role's default. */
export function readModelRoleId(
  preferences: unknown,
  role: ModelRole,
): string | null {
  const [section, key] = MODEL_ROLE_PREFERENCE_PATHS[role];
  if (!isRecord(preferences) || !isRecord(preferences[section])) return null;
  const value = preferences[section][key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A preferences patch that assigns (or, with null, clears) one role. */
export function modelRolePatch(
  role: ModelRole,
  modelProviderId: string | null,
): SettingsPreferences {
  const [section, key] = MODEL_ROLE_PREFERENCE_PATHS[role];
  return { [section]: { [key]: modelProviderId } };
}

export function resolvePreferences(
  userPrefs?: SettingsPreferences | null,
  animaPrefs?: SettingsPreferences | null,
): SettingsPreferences {
  const withUser = mergePreferences(DEFAULT_ANIMAMA_PREFERENCES, userPrefs);
  return mergePreferences(withUser, animaPrefs);
}

/**
 * Map a stored theme to a supported mode. Retired values (`custom`/`anima`,
 * the backend default) fall back to light.
 */
export function normalizeThemeSetting(
  theme?: string | null,
): "system" | "light" | "dark" | null {
  if (theme === "system" || theme === "light" || theme === "dark") {
    return theme;
  }
  if (theme === "custom" || theme === "anima") return "light";
  return null;
}

export function themesEquivalent(
  stored?: string | null,
  current?: string | null,
): boolean {
  const storedNormalized = normalizeThemeSetting(stored);
  const currentNormalized = normalizeThemeSetting(current);
  if (!storedNormalized || !currentNormalized) return false;
  return storedNormalized === currentNormalized;
}

/** A saved ElevenLabs model, with a retired id read as its replacement. */
export function toElevenLabsTtsModelId(
  value: unknown,
): ElevenLabsTtsModelId | null {
  if (typeof value !== "string") return null;
  const current = RETIRED_ELEVENLABS_TTS_MODEL_REPLACEMENTS[value] ?? value;
  return current === DEFAULT_ELEVENLABS_TTS_MODEL_ID ? current : null;
}

export function toGeminiTtsModelId(value: unknown): GeminiTtsModelId | null {
  return value === "gemini-3.8-flash-lite-tts" ||
    value === "gemini-3.8-flash-tts"
    ? value
    : null;
}

/**
 * The experimental WebGPU speech setting is opt-in: absent, `false` or any
 * non-boolean value means off.
 */
export function isParakeetWebgpuPreferred(
  preferences: SettingsPreferences | null | undefined,
): boolean {
  return preferences?.speech?.stt_parakeet_webgpu === true;
}

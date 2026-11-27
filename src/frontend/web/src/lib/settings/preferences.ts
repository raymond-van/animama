import type { GeminiTtsCapability } from "@animama/runtime-contracts/api-types";
import type { OfflineSttEngine } from "@/lib/speech/offline-stt/routing";
import type { MicSensitivity } from "@/lib/voice/microphone-preferences";
import type { AppearanceOverrides } from "@/lib/theme/appearance-overrides";
import type {
  DesktopShortcut,
  DesktopShortcutAction,
} from "@/lib/settings/desktop-shortcuts";
import { isRecord } from "@/lib/records";

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

/**
 * The Gemini speech models the backend accepts; `label` is the vendor's model
 * name, and descriptions are catalog text.
 */
export const GEMINI_TTS_MODEL_OPTIONS: Array<{
  id: GeminiTtsModelId;
  label: string;
}> = [
  { id: "gemini-3.8-flash-lite-tts", label: "Flash-Lite TTS" },
  { id: "gemini-3.8-flash-tts", label: "Flash TTS" },
];

export type SpeechPreferences = {
  stt_provider?: SttProviderPreference;
  /**
   * Run offline recognition on WebGPU when available (default off); the GPU
   * preference for both offline engines, despite its name.
   */
  stt_parakeet_webgpu?: boolean;
  /**
   * The offline engine the owner chose; absent follows the UI Locale
   * (`routeOfflineSpeech`). Read with `offlineSttEnginePreference`.
   */
  stt_offline_engine?: OfflineSttEngine;
  tts_enabled?: boolean;
  tts_provider?: TtsProviderPreference;
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
  /**
   * Enhanced Avatar rendering: toon-shaded MToon, three-point lighting,
   * Neutral tone mapping and a soft chat-canvas grade (default on).
   */
  enhanced_rendering?: boolean;
  disable_animation?: boolean;
  disable_vfx?: boolean;
  /**
   * The chat canvas's camera preset (`SceneCameraPreset`); missing or unknown
   * uses Portrait. Fine-tuned camera positions are not saved.
   */
  camera_preset?: string;
  /** The desktop PiP window's camera preset; missing uses Portrait close. */
  pip_camera_preset?: string;
  /**
   * App stage scene behind the Avatar (`dreamy`, `sakura`, …) or `none`;
   * missing means Dreamy in light mode and Sakura in dark mode. A bound
   * Background image still wins.
   */
  stage_background?: string;
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

/**
 * The content assistant's remembered choices. Its model is a choice of its
 * own, not a model role: a run names it, and with none (or one that can no
 * longer be used) the assistant shows setup instead of using another model.
 */
export type GenerationPreferences = {
  model_provider_id?: string | null;
  /**
   * The reasoning effort chosen for the assistant on each model, by model id.
   * A model without an entry (or with `null`) runs at its own default.
   */
  reasoning_efforts?: Record<string, string | null>;
  [key: string]: unknown;
};

export type SettingsPreferences = {
  /** Keeps first-message suggestions dismissed across chats and deleted history. */
  has_sent_chat_message?: boolean;
  /** The Chat default (the model new Animas start with), set in App Settings → Models. */
  chat?: { default_model_provider_id?: string | null };
  /** Other model role assignments chosen in App Settings → Models. */
  models?: ModelRolePreferences;
  /** The content assistant's model, chosen on the Generate page. */
  generation?: GenerationPreferences;
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
    // Desktop shortcuts default per OS through `resolveDesktopShortcuts`.
  },
  presentation: {
    enable_avatar_transform_controls: false,
    disable_animation: false,
    disable_vfx: false,
  },
};

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
  const generation = mergeSection(baseObj, patchObj, "generation");
  if (chat) merged.chat = chat as SettingsPreferences["chat"];
  if (models) merged.models = models as ModelRolePreferences;
  if (generation) {
    // Merged by model, so choosing one model's level keeps the others'.
    const efforts = mergeNestedRecord(
      isRecord(baseObj.generation) ? baseObj.generation : undefined,
      isRecord(patchObj.generation) ? patchObj.generation : undefined,
      "reasoning_efforts",
    );
    if (efforts) generation.reasoning_efforts = efforts;
    merged.generation = generation as GenerationPreferences;
  }

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

/** The model the owner chose for the content assistant, or null before any choice. */
export function readGenerationModelId(preferences: unknown): string | null {
  if (!isRecord(preferences) || !isRecord(preferences.generation)) return null;
  const value = preferences.generation.model_provider_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A preferences patch that sets (or, with null, clears) the assistant's model. */
export function generationModelPatch(
  modelProviderId: string | null,
): SettingsPreferences {
  return { generation: { model_provider_id: modelProviderId } };
}

/**
 * The reasoning effort the owner chose for the assistant on one model, or
 * null when that model runs at its own default.
 */
export function readGenerationReasoningEffort(
  preferences: unknown,
  modelProviderId: string | null | undefined,
): string | null {
  if (!modelProviderId) return null;
  if (!isRecord(preferences) || !isRecord(preferences.generation)) return null;
  const efforts = preferences.generation.reasoning_efforts;
  const value = isRecord(efforts) ? efforts[modelProviderId] : null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * A preferences patch that sets the assistant's reasoning effort on one model
 * or, with null, returns that model to its own default.
 */
export function generationReasoningEffortPatch(
  modelProviderId: string,
  effort: string | null,
): SettingsPreferences {
  return { generation: { reasoning_efforts: { [modelProviderId]: effort } } };
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

/**
 * The offline speech engine the owner chose, or `null` to follow the UI
 * Locale. Saved preferences are untyped JSON, so any other value is ignored.
 */
export function offlineSttEnginePreference(
  preferences: SettingsPreferences | null | undefined,
): OfflineSttEngine | null {
  const engine: unknown = preferences?.speech?.stt_offline_engine;
  return engine === "parakeet" || engine === "sensevoice" ? engine : null;
}

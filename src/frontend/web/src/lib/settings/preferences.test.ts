import { describe, expect, it } from "vitest";

import {
  DEFAULT_ANIMAMA_PREFERENCES,
  DEFAULT_ELEVENLABS_TTS_MODEL_ID,
  isParakeetWebgpuPreferred,
  mergePreferences,
  modelRolePatch,
  modelRolePreferencePath,
  readModelRoleId,
  normalizeThemeSetting,
  resolvePreferences,
  toElevenLabsTtsModelId,
  toGeminiTtsModelId,
} from "./preferences";

describe("Anima TTS provider", () => {
  it.each(["pocket_tts", "elevenlabs"] as const)(
    "overrides the app provider with %s while preserving speech enable and both voices",
    (provider) => {
      const app = {
        speech: { tts_enabled: false, tts_provider: "browser" as const },
      };
      const anima = {
        speech: {
          tts_pocket_anima_voice: "azelma",
          elevenlabs: { primary_voice: { voice_id: "saved-voice" } },
        },
      };
      const saved = JSON.parse(
        JSON.stringify(
          mergePreferences(anima, {
            speech: { tts_provider: provider },
          }),
        ),
      );
      expect(saved.speech).toEqual({ ...anima.speech, tts_provider: provider });
      expect(resolvePreferences(app, saved).speech).toMatchObject({
        ...anima.speech,
        tts_provider: provider,
        tts_enabled: false,
      });
      expect(app.speech).toEqual({
        tts_enabled: false,
        tts_provider: "browser",
      });
      expect(resolvePreferences(app, anima).speech?.tts_provider).toBe(
        "browser",
      );
    },
  );
});

describe("ElevenLabs model preference", () => {
  it("speaks with Eleven v4 Turbo", () => {
    expect(DEFAULT_ELEVENLABS_TTS_MODEL_ID).toBe("eleven_v4_turbo");
    expect(DEFAULT_ANIMAMA_PREFERENCES.speech?.tts_elevenlabs_model_id).toBe(
      "eleven_v4_turbo",
    );
  });

  it.each([
    ["eleven_flash_v2_5", "eleven_v4_turbo"],
    ["eleven_multilingual_v2", "eleven_v4_turbo"],
    ["eleven_v3", "eleven_v4_turbo"],
  ])("reads the retired model %s as %s", (saved, replacement) => {
    expect(toElevenLabsTtsModelId(saved)).toBe(replacement);
  });

  it("keeps the current model and rejects unknown ones", () => {
    expect(toElevenLabsTtsModelId("eleven_v4_turbo")).toBe("eleven_v4_turbo");
    expect(toElevenLabsTtsModelId("eleven_v4")).toBeNull();
    expect(toElevenLabsTtsModelId("eleven_turbo_v2")).toBeNull();
    expect(toElevenLabsTtsModelId(undefined)).toBeNull();
  });
});

describe("safety preferences", () => {
  it("merges a partial safety patch without dropping the other safety choice", () => {
    const merged = mergePreferences(
      { safety: { crisis_resource_region: "GB", reminder_hours: 2 } },
      { safety: { reminder_hours: 1 } },
    );
    expect(merged.safety).toEqual({
      crisis_resource_region: "GB",
      reminder_hours: 1,
    });
  });
});

describe("theme and appearance preferences", () => {
  it("keeps supported modes and maps retired custom themes to light", () => {
    expect(normalizeThemeSetting("system")).toBe("system");
    expect(normalizeThemeSetting("dark")).toBe("dark");
    expect(normalizeThemeSetting("custom")).toBe("light");
    expect(normalizeThemeSetting("anima")).toBe("light");
    expect(normalizeThemeSetting("sepia")).toBeNull();
  });

  it("merges one colour override without dropping the mode's others", () => {
    const merged = mergePreferences(
      { appearance: { dark: { accent: "#ff6600", background: "#000000" } } },
      { appearance: { dark: { accent: "#00ff00" } } },
    );
    expect(merged.appearance).toEqual({
      dark: { accent: "#00ff00", background: "#000000" },
    });
  });

  it("removes an override when patched to undefined", () => {
    const merged = mergePreferences(
      { appearance: { light: { accent: "#ff6600" } } },
      { appearance: { light: { accent: undefined } } },
    );
    expect(JSON.parse(JSON.stringify(merged))).toEqual({
      appearance: { light: {} },
    });
  });
});

describe("isParakeetWebgpuPreferred", () => {
  it("is off unless the experimental setting is explicitly true", () => {
    expect(isParakeetWebgpuPreferred(null)).toBe(false);
    expect(isParakeetWebgpuPreferred(DEFAULT_ANIMAMA_PREFERENCES)).toBe(false);
    // Saved preferences are untyped JSON, so a string must not enable it.
    expect(
      isParakeetWebgpuPreferred({
        speech: { stt_parakeet_webgpu: "true" as unknown as boolean },
      }),
    ).toBe(false);
    expect(
      isParakeetWebgpuPreferred({ speech: { stt_parakeet_webgpu: true } }),
    ).toBe(true);
  });
});

describe("model role preferences", () => {
  it("assigns one role without dropping the others and clears with null", () => {
    const stored = mergePreferences(DEFAULT_ANIMAMA_PREFERENCES, {
      models: {
        utility_model_provider_id: "owner:small",
        embedding_model_provider_id: "owner:embed",
      },
    });
    const updated = mergePreferences(
      stored,
      modelRolePatch("memory_manager", "owner:tools"),
    );
    const cleared = mergePreferences(updated, modelRolePatch("utility", null));

    expect(readModelRoleId(updated, "utility")).toBe("owner:small");
    expect(readModelRoleId(updated, "memory_manager")).toBe("owner:tools");
    expect(readModelRoleId(updated, "embeddings")).toBe("owner:embed");
    expect(readModelRoleId(cleared, "utility")).toBeNull();
    expect(readModelRoleId(cleared, "embeddings")).toBe("owner:embed");
    expect(
      readModelRoleId(
        { models: { utility_model_provider_id: " " } },
        "utility",
      ),
    ).toBeNull();
  });

  it("stores the Chat default under chat and reports each role's path", () => {
    const updated = mergePreferences(
      { chat: { default_model_provider_id: "owner:old" } },
      modelRolePatch("chat", "owner:new"),
    );
    expect(readModelRoleId(updated, "chat")).toBe("owner:new");
    expect(modelRolePreferencePath("chat")).toBe(
      "chat.default_model_provider_id",
    );
    expect(modelRolePreferencePath("utility")).toBe(
      "models.utility_model_provider_id",
    );
  });
});

describe("Gemini TTS model preference", () => {
  it("accepts only the Gemini speech models", () => {
    expect(toGeminiTtsModelId("gemini-3.8-flash-lite-tts")).toBe(
      "gemini-3.8-flash-lite-tts",
    );
    expect(toGeminiTtsModelId("gemini-3.8-flash-tts")).toBe(
      "gemini-3.8-flash-tts",
    );
    expect(toGeminiTtsModelId("eleven_v4")).toBeNull();
    expect(toGeminiTtsModelId(undefined)).toBeNull();
  });
});

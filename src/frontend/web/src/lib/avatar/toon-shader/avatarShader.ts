import { create } from "zustand";

/*
 * Development-only switch between experimental Avatar toon shaders. Production
 * builds always use three-vrm's MToon. The Vite dev server reads the choice
 * stored by the debug panel; review renderers (which serve with
 * `__ANIMAMA_DEV_BUILD__` false) opt in through a window override.
 */

export const AVATAR_SHADER_IDS = ["mtoon", "mtoon-tuned", "liltoon"] as const;

export type AvatarShaderId = (typeof AVATAR_SHADER_IDS)[number];

export const AVATAR_SHADER_LABELS: Record<AvatarShaderId, string> = {
  mtoon: "MToon (default)",
  "mtoon-tuned": "MToon tuned",
  liltoon: "lilToon (experimental)",
};

const AVATAR_SHADER_STORAGE_KEY = "animama.debug.avatarShader";

type AvatarShaderWindow = Window & { __animamaAvatarShaderOverride?: unknown };

function isAvatarShaderId(value: unknown): value is AvatarShaderId {
  return (AVATAR_SHADER_IDS as readonly unknown[]).includes(value);
}

function readInitialShader(): AvatarShaderId {
  if (!import.meta.env.DEV || typeof window === "undefined") return "mtoon";
  const override = (window as AvatarShaderWindow).__animamaAvatarShaderOverride;
  if (isAvatarShaderId(override)) return override;
  if (!__ANIMAMA_DEV_BUILD__) return "mtoon";
  try {
    const stored = window.localStorage.getItem(AVATAR_SHADER_STORAGE_KEY);
    return isAvatarShaderId(stored) ? stored : "mtoon";
  } catch {
    return "mtoon";
  }
}

type AvatarShaderState = {
  shader: AvatarShaderId;
  setShader: (shader: AvatarShaderId) => void;
};

export const useAvatarShaderStore = create<AvatarShaderState>((set) => ({
  shader: readInitialShader(),
  setShader: (shader) => {
    try {
      window.localStorage.setItem(AVATAR_SHADER_STORAGE_KEY, shader);
    } catch {
      // Storage can be unavailable; the choice still applies this session.
    }
    set({ shader });
  },
}));

export function getActiveAvatarShader(): AvatarShaderId {
  return useAvatarShaderStore.getState().shader;
}

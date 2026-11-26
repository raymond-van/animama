import { create } from "zustand";

/**
 * Per-Avatar settings an owner keeps outside the file (one row per owner and
 * Avatar item, `GET/PUT /v1/avatar-content/{item_id}/settings`). A missing or
 * unreadable value means Automatic.
 */

/**
 * Wind and spring physics. Automatic keeps today's choice (no wind or updraft
 * on Avatars converted by Mochiya, whose springs rely on their modelled
 * shape); On and Off force ambient forces; Springs off also holds every spring
 * joint at rest.
 */
export type AvatarSpringMode = "automatic" | "on" | "off" | "springs_off";

/**
 * How a file's own materials render, for files whose materials Animama can
 * draw two ways. Authored lilToon materials: Automatic is lilToon unless this
 * machine's measured lilToon frame time is too slow, then Simple
 * (`liltoon/lilToonGpuCheck.ts`); Simple uses the file's glTF fallback
 * materials, which cost far less per frame. Materials that all ignore light
 * (`unlitToonShading.ts`): Automatic adds toon shading; Simple keeps them
 * unlit. lilToon names a choice only lilToon files offer; on other files it
 * acts as Automatic.
 */
export type AvatarMaterialMode = "automatic" | "liltoon" | "simple";

export const AVATAR_SPRING_MODES: readonly AvatarSpringMode[] = [
  "automatic",
  "on",
  "off",
  "springs_off",
];

/**
 * The wind strength range an owner can choose, in percent of the default
 * (100, stored as no value). It scales wind and the updraft.
 */
export const WIND_STRENGTH_PERCENT = {
  min: 0,
  max: 200,
  step: 10,
  default: 100,
} as const;

/** A stored wind strength (percent, or none) as a multiple of the default. */
export function windStrengthMultiple(
  percent: number | null | undefined,
): number {
  return typeof percent === "number" && Number.isFinite(percent)
    ? Math.max(0, percent) / 100
    : 1;
}

export const AVATAR_MATERIAL_MODES: readonly AvatarMaterialMode[] = [
  "automatic",
  "liltoon",
  "simple",
];

/**
 * Which materials a file has that the Materials setting chooses between:
 * authored lilToon, all unlit, or neither (the setting changes nothing).
 */
export type AvatarFileMaterials = "liltoon" | "unlit" | "other";

/**
 * The Materials choices a file offers: lilToon files all three, files whose
 * materials all ignore light Automatic (toon shading) and Simple. Any other
 * file offers all three, which only a stored choice shows (to undo it).
 */
export function materialModesFor(
  materials: AvatarFileMaterials | undefined,
): readonly AvatarMaterialMode[] {
  return materials === "unlit"
    ? AVATAR_MATERIAL_MODES.filter((mode) => mode !== "liltoon")
    : AVATAR_MATERIAL_MODES;
}

/**
 * Whether wind and updraft apply. `automaticAmbientForces` is Automatic's
 * answer for this file (false for springs tuned without them).
 */
export function resolveAmbientForces(
  mode: AvatarSpringMode,
  automaticAmbientForces: boolean,
): boolean {
  switch (mode) {
    case "automatic":
      return automaticAmbientForces;
    case "on":
      return true;
    case "off":
    case "springs_off":
      return false;
  }
}

/**
 * Whether lilToon materials load under a mode. `Avatar.load` resolves
 * Automatic through the GPU check first; here Automatic means lilToon.
 */
export function rendersLilToon(mode: AvatarMaterialMode): boolean {
  return mode !== "simple";
}

type AvatarFileTraitsState = {
  /** Which materials a VRM file has (`AvatarFileMaterials`), by its sha256. */
  materialsBySha256: Readonly<Record<string, AvatarFileMaterials>>;
};

/**
 * What loaded Avatar files are known to contain, so settings can offer the
 * Materials choice only for files it changes. `Avatar.load` fills it; a file
 * no surface has loaded yet is unknown.
 */
export const useAvatarFileTraitsStore = create<AvatarFileTraitsState>(() => ({
  materialsBySha256: {},
}));

/** Record a loaded file's materials (`Avatar.load`). */
export function rememberAvatarFileMaterials(
  vrmSha256: string,
  materials: AvatarFileMaterials,
): void {
  const known = useAvatarFileTraitsStore.getState().materialsBySha256;
  if (known[vrmSha256] === materials) return;
  useAvatarFileTraitsStore.setState({
    materialsBySha256: { ...known, [vrmSha256]: materials },
  });
}

/** Which materials a file has: undefined until one has loaded. */
export function useAvatarFileMaterials(
  vrmSha256: string | null,
): AvatarFileMaterials | undefined {
  return useAvatarFileTraitsStore((state) =>
    vrmSha256 ? state.materialsBySha256[vrmSha256] : undefined,
  );
}

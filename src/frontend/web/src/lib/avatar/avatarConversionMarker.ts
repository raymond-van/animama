/**
 * The marker Animama Avatar Converter writes into every MikuMikuDance (PMX)
 * model it converts: `{ "source": "pmx", "converter": "<version>" }` under
 * this name, listed in `extensionsUsed`
 * (docs/frontend/runtime/mmd-model-conversion.md). Animama checks only that it
 * is present. It means the springs were tuned without ambient forces
 * (`SpringBonePhysicsController.ts`) and the MToon was made for MMD's light,
 * not VRoid's (`convertedAvatarBrightness.ts`, and the enhanced retune skips
 * it in `enhanced-rendering/mtoonPatch.ts`).
 */
export const ANIMAMA_CONVERSION_EXTENSION = "ANIMAMA_avatar_conversion";

/** Whether a glTF's `extensionsUsed` lists Animama Avatar Converter's marker. */
export function isAnimamaConversion(json: unknown): boolean {
  const used =
    json && typeof json === "object"
      ? (json as { extensionsUsed?: unknown }).extensionsUsed
      : undefined;
  return Array.isArray(used) && used.includes(ANIMAMA_CONVERSION_EXTENSION);
}

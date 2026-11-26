/**
 * Brightness for MikuMikuDance (PMX) models converted by Animama Avatar
 * Converter.
 *
 * The converter writes MToon whose lit colour is MMD's: the texture as MMD's
 * default light shows it (docs/frontend/runtime/mmd-model-conversion.md).
 * Animama's chat lights draw an MToon lit colour darker than that, so a
 * converted Avatar looked about a tenth darker than in MMD. The loader raises
 * the lit and shaded colours of these files' MToon materials by the gain the
 * toon shading of unlit-only files uses (`LIT_GAIN` in `unlitToonShading.ts`),
 * before three-vrm builds them. It is a calibration to Animama's lights, not
 * a change of look, so it applies under every Materials setting; outlines,
 * rim light and sphere-map matcaps keep the file's values.
 */
import type { VRMLoaderPlugin } from "@pixiv/three-vrm";

import { createLogger } from "@/lib/logger";
import { LIT_GAIN } from "./unlitToonShading";

const logger = createLogger("AvatarLoader");

/**
 * The marker Animama Avatar Converter writes into every MMD conversion; the
 * spring settings read it too (`SpringBonePhysicsController.ts`).
 */
export const ANIMAMA_CONVERSION_EXTENSION = "ANIMAMA_avatar_conversion";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/** Whether a glTF carries Animama Avatar Converter's marker. */
export function isAnimamaConversion(json: unknown): boolean {
  const used = asRecord(json)?.extensionsUsed;
  return Array.isArray(used) && used.includes(ANIMAMA_CONVERSION_EXTENSION);
}

/** `factor`'s first three channels (default `fallback`) times `gain`. */
function raised(
  factor: unknown,
  fallback: number,
  gain: number,
): number[] | null {
  const values = Array.isArray(factor) ? factor : [];
  const channels = [0, 1, 2].map((channel) =>
    typeof values[channel] === "number"
      ? (values[channel] as number)
      : fallback,
  );
  if (channels.some((value) => !Number.isFinite(value))) return null;
  return [...channels.map((value) => value * gain), ...values.slice(3)];
}

/**
 * Raise the lit colour (`baseColorFactor`, glTF's default white when absent)
 * and the shade colour (`shadeColorFactor`, MToon's default black when absent)
 * of every MToon material in a converted file by `LIT_GAIN`. Alpha and every
 * other parameter stay. Returns how many materials it raised; a file without
 * the marker is left alone.
 */
export function raiseConvertedAvatarBrightness(json: unknown): number {
  if (!isAnimamaConversion(json)) return 0;
  const materials = asRecord(json)?.materials;
  if (!Array.isArray(materials)) return 0;
  let raisedCount = 0;
  for (const value of materials) {
    const material = asRecord(value);
    const mtoon = asRecord(
      asRecord(material?.extensions)?.VRMC_materials_mtoon,
    );
    if (!material || !mtoon) continue;
    const pbr = asRecord(material.pbrMetallicRoughness) ?? {};
    const lit = raised(pbr.baseColorFactor ?? [1, 1, 1, 1], 1, LIT_GAIN);
    const shade = raised(mtoon.shadeColorFactor ?? [0, 0, 0], 0, LIT_GAIN);
    if (!lit || !shade) continue;
    material.pbrMetallicRoughness = { ...pbr, baseColorFactor: lit };
    mtoon.shadeColorFactor = shade;
    raisedCount += 1;
  }
  return raisedCount;
}

/**
 * Raise a converted MMD model's MToon colours in `plugin`'s glTF
 * (`raiseConvertedAvatarBrightness`) before three-vrm builds any material,
 * after every step `plugin` already carries there (the VRM 0.x compat step,
 * the enhanced retune and the unlit toon shading, none of which touch these
 * files).
 */
export function withConvertedAvatarBrightness(
  plugin: VRMLoaderPlugin,
): VRMLoaderPlugin {
  const v0Compat = plugin.materialsV0CompatPlugin;
  const earlierSteps = v0Compat.beforeRoot.bind(v0Compat);
  v0Compat.beforeRoot = async () => {
    await earlierSteps();
    const count = raiseConvertedAvatarBrightness(plugin.parser.json);
    if (count > 0) {
      logger.info("Load", "Converted MMD model's colours raised", {
        reason: "avatar_conversion_brightness",
        materials: count,
        gain: LIT_GAIN,
      });
    }
  };
  return plugin;
}

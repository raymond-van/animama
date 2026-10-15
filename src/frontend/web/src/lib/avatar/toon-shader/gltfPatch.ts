import type { VRMLoaderPlugin } from "@pixiv/three-vrm";
import type { GLTFParser } from "three/examples/jsm/loaders/GLTFLoader.js";

import { getActiveAvatarShader } from "./avatarShader";
import { vroidLookFor, type ToonLook } from "./vroidPalette";

type MToonExtension = Record<string, unknown>;
type GltfMaterial = {
  name?: string;
  extensions?: { VRMC_materials_mtoon?: MToonExtension };
};

/** Shading shift and toony values per look; the face stays mostly lit. */
const SHADING: Record<ToonLook["kind"], { shift: number; toony: number }> = {
  face: { shift: 0.6, toony: 0.7 },
  skin: { shift: 0, toony: 0.85 },
  cloth: { shift: -0.1, toony: 0.85 },
  hair: { shift: -0.1, toony: 0.8 },
};

/** Screen-space outline widths (fraction of view height) per look. */
const OUTLINE_WIDTH: Record<ToonLook["kind"], number> = {
  face: 0.0035,
  skin: 0.0045,
  cloth: 0.0045,
  hair: 0.004,
};

function retuneMToon(material: GltfMaterial, mtoon: MToonExtension): void {
  const look = vroidLookFor(material.name ?? "");
  if (!look) return;
  mtoon.shadeColorFactor = look.shade;
  mtoon.shadingShiftFactor = SHADING[look.kind].shift;
  mtoon.shadingToonyFactor = SHADING[look.kind].toony;
  mtoon.parametricRimColorFactor = look.rim;
  mtoon.parametricRimFresnelPowerFactor = look.rimPower;
  mtoon.parametricRimLiftFactor = 0;
  mtoon.rimLightingMixFactor = 0.5;
  mtoon.outlineWidthMode = "screenCoordinates";
  mtoon.outlineWidthFactor = OUTLINE_WIDTH[look.kind];
  mtoon.outlineColorFactor = look.outlineColor;
  mtoon.outlineLightingMixFactor = 0.6;
}

function patchMaterials(parser: GLTFParser): void {
  const shader = getActiveAvatarShader();
  if (shader === "mtoon") return;
  const materials = (parser.json.materials ?? []) as GltfMaterial[];
  for (const material of materials) {
    const mtoon = material.extensions?.VRMC_materials_mtoon;
    if (!mtoon) continue;
    if (shader === "mtoon-tuned") retuneMToon(material, mtoon);
    // lilToon draws its own outlines; MToon's would duplicate the geometry.
    else mtoon.outlineWidthMode = "none";
  }
}

/**
 * Patch the active shader's MToon parameters into `plugin`'s glTF before
 * three-vrm builds any material. The patch runs right after the VRM 0.x
 * compat step, which is where VRM 0.x files gain `VRMC_materials_mtoon`. The
 * shader is read per parse, so a cached loader follows later switches.
 */
export function withAvatarShaderPatch(
  plugin: VRMLoaderPlugin,
): VRMLoaderPlugin {
  const v0Compat = plugin.materialsV0CompatPlugin;
  const convertV0Materials = v0Compat.beforeRoot.bind(v0Compat);
  v0Compat.beforeRoot = async () => {
    await convertV0Materials();
    patchMaterials(plugin.parser);
  };
  return plugin;
}

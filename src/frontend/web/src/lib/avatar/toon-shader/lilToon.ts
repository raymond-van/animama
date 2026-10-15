import * as THREE from "three";
import { LilToonMaterial, enableLilToon } from "@mochiya/three-liltoon";
import type { VRM } from "@pixiv/three-vrm";

import { vroidLookFor } from "./vroidPalette";

/*
 * Rebuild an Avatar's MToon materials as three-liltoon materials. The package
 * only converts its own glTF extension, which VRoid exports never carry, so
 * the VRoid palette supplies shadow, rim and outline colours.
 */

// three-liltoon writes sRGB itself and ignores `renderer.toneMapping`; apply
// three's ACES Filmic curve (the chat canvas's) just before that conversion.
const ACES_GLSL = `
highp vec3 animamaRRTAndODTFit(highp vec3 v) {
  highp vec3 a = v * (v + 0.0245786) - 0.000090537;
  highp vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
highp vec3 animamaACESFilmic(highp vec3 color) {
  const highp mat3 inputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const highp mat3 outputMat = mat3(
    vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color *= 1.0 / 0.6;
  color = outputMat * animamaRRTAndODTFit(inputMat * color);
  return clamp(color, 0.0, 1.0);
}
`;
const SRGB_INPUT =
  "highp vec3 linearColor = max(out_var_SV_Target.rgb, vec3(0.0));";

/**
 * A `LilToonMaterial` with ACES tone mapping. Defined as a subclass so clones
 * (Avatar Effect texture composites) keep it.
 */
class ToneMappedLilToonMaterial extends LilToonMaterial {
  override onBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms) {
    if (!shader.fragmentShader.includes(SRGB_INPUT)) return;
    shader.fragmentShader = shader.fragmentShader
      .replace("void main()", `${ACES_GLSL}\nvoid main()`)
      .replace(
        SRGB_INPUT,
        "highp vec3 linearColor = animamaACESFilmic(max(out_var_SV_Target.rgb, vec3(0.0)));",
      );
  }
}

type MToonLike = THREE.Material & {
  map?: THREE.Texture | null;
  color?: THREE.Color;
  alphaTest: number;
};

function toLilToon(source: MToonLike): LilToonMaterial {
  const look = vroidLookFor(source.name);
  const isFace = look?.kind === "face";
  const color = source.color ?? new THREE.Color(1, 1, 1);
  const properties: Record<string, number | number[]> = {
    _Color: [color.r, color.g, color.b, source.opacity],
    _Cull: source.side === THREE.DoubleSide ? 0 : 2,
    // lilToon's transparent mode writes depth by default; MToon's does not
    // (unless `transparentWithZWrite`), and silhouette overlays rely on that.
    _ZWrite: source.depthWrite ? 1 : 0,
    _UseShadow: look ? 1 : 0,
    _UseRim: look ? 1 : 0,
    _UseOutline: look ? 1 : 0,
  };
  if (look) {
    const [r, g, b] = look.shade;
    Object.assign(properties, {
      _ShadowColor: [r, g, b, 1],
      _ShadowBorder: isFace ? 0.2 : 0.55,
      _ShadowBlur: 0.08,
      // lilToon's warm terminator band suits skin but tints cloth pink.
      _ShadowBorderRange:
        look.kind === "face" || look.kind === "skin" ? 0.08 : 0,
      _Shadow2ndColor: [r * 0.8, g * 0.75, b * 0.85, 0.6],
      _Shadow2ndBorder: isFace ? 0.05 : 0.3,
      _Shadow2ndBlur: 0.15,
      _RimColor: [...look.rim.map((value) => value * 2.5), 1],
      _RimBorder: 0.5,
      _RimBlur: 0.5,
      _RimFresnelPower: look.rimPower,
      _RimEnableLighting: 1,
      _OutlineWidth: isFace ? 0.05 : 0.1,
      _OutlineColor: [...look.outlineColor, 1],
    });
  }
  return new ToneMappedLilToonMaterial({
    name: source.name,
    map: source.map ?? null,
    alphaTest: source.transparent ? 0 : source.alphaTest,
    renderMode: source.transparent
      ? "transparent"
      : source.alphaTest > 0
        ? "cutout"
        : "opaque",
    properties,
  });
}

/**
 * Replace every material on `vrm` with its lilToon equivalent. VRM
 * expressions that bind material colours keep pointing at the old materials
 * and stop applying; morph-target expressions are unaffected.
 */
export function convertVrmToLilToon(vrm: VRM): void {
  const converted = new Map<THREE.Material, LilToonMaterial>();
  const convert = (material: THREE.Material) => {
    // An MToon outline clone (should the glTF patch have missed one) stays
    // MToon: converted, it would draw a second copy of the surface.
    if ((material as { isOutline?: boolean }).isOutline) return material;
    let next = converted.get(material);
    if (!next) {
      next = toLilToon(material as MToonLike);
      converted.set(material, next);
    }
    return next;
  };
  vrm.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(convert)
      : convert(mesh.material);
  });
  converted.forEach((_, source) => source.dispose());
}

/** Install lilToon's outline and special-mode passes on `renderer`. */
export function enableLilToonRendering(
  renderer: THREE.WebGLRenderer,
): () => void {
  return enableLilToon(renderer);
}

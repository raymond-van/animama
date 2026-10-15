import * as THREE from "three";

import {
  configureEffectBlend,
  createTextureFromImage,
  resolveArtFrameSize,
} from "./effectArt";
import type { AvatarSilhouetteVFXEntry } from "./types";

/*
 * Silhouette overlays draw effect art only where the avatar is visible,
 * without touching its materials or the canvas.
 *
 * Each overlaid avatar primitive gets a sibling draw: a mesh that shares the
 * primitive's geometry, skeleton and `morphTargetInfluences` array and is a
 * child of the primitive with an identity transform, so it deforms, animates
 * and hides with it. Its material samples the primitive's original base map
 * only for alpha cutout (never a face effect's composite texture, which the
 * controller owns and disposes), and draws the art in screen space. `LessEqual` depth with
 * a one-unit polygon offset keeps exactly the frontmost depth-writing
 * surface's overlay at each pixel, so hidden parts never show through.
 *
 * Excluded: MToon outlines (a single overlay material draws each triangle once,
 * ignoring the outline's duplicate geometry group) and transparent layers that
 * do not write depth (irises, highlights, brows, eye lines and lashes). Those
 * layers sit on depth-writing skin or eye whites whose overlays already cover
 * them; overlaying both would stack the art twice.
 */

/** Drawn after the avatar and before face and body planes (950) and stickers (960). */
export const SILHOUETTE_RENDER_ORDER = 940;
/** At `patternScale` 1 one tile is this fraction of the avatar's on-screen height. */
export const SILHOUETTE_TILE_HEIGHT_FRACTION = 0.25;

const VERTEX_SHADER = /* glsl */ `
#include <common>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
uniform mat3 sourceMapTransform;
varying vec2 vSourceUv;
void main() {
  vSourceUv = (sourceMapTransform * vec3(uv, 1.0)).xy;
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D sourceMap;
uniform float useSourceMap;
uniform float sourceOpacity;
uniform float sourceAlphaTest;
uniform sampler2D artMap;
uniform vec4 artFrame;
uniform vec2 patternOrigin;
uniform vec2 tileSize;
uniform vec2 patternOffset;
uniform float patternRotation;
uniform float flatFill;
uniform vec3 flatColor;
uniform vec3 tint;
uniform float opacity;
varying vec2 vSourceUv;
void main() {
  // Respect the primitive's own cutout so hair cards and lashes keep their shape.
  float sourceAlpha = sourceOpacity;
  if (useSourceMap > 0.5) sourceAlpha *= texture2D(sourceMap, vSourceUv).a;
  if (sourceAlpha < max(sourceAlphaTest, 0.001)) discard;
  vec4 art;
  if (flatFill > 0.5) {
    art = vec4(flatColor, 1.0);
  } else {
    vec2 p = gl_FragCoord.xy - patternOrigin;
    float c = cos(patternRotation);
    float s = sin(patternRotation);
    p = vec2(c * p.x + s * p.y, c * p.y - s * p.x);
    vec2 cell = fract(p / tileSize + patternOffset);
    art = texture2D(artMap, artFrame.xy + cell * artFrame.zw);
  }
  gl_FragColor = vec4(art.rgb * tint, art.a * opacity);
  #include <colorspace_fragment>
  #include <premultiplied_alpha_fragment>
}
`;

/** Uniform values shared by every overlay material of one effect. */
export type SilhouetteUniforms = {
  artMap: THREE.IUniform<THREE.Texture>;
  artFrame: THREE.IUniform<THREE.Vector4>;
  patternOrigin: THREE.IUniform<THREE.Vector2>;
  tileSize: THREE.IUniform<THREE.Vector2>;
  patternOffset: THREE.IUniform<THREE.Vector2>;
  patternRotation: THREE.IUniform<number>;
  flatFill: THREE.IUniform<number>;
  flatColor: THREE.IUniform<THREE.Color>;
  tint: THREE.IUniform<THREE.Color>;
  opacity: THREE.IUniform<number>;
};

/** Pattern motion on the effect's own timeline, in tiles and radians. */
export type SilhouettePatternState = {
  offsetX: number;
  offsetY: number;
  rotation: number;
  scale: number;
  opacity: number;
  frame: { offsetX: number; offsetY: number; repeatX: number; repeatY: number };
};

export type SilhouetteOverlay = {
  /** Overlay meshes, each a child of the primitive it covers. */
  meshes: THREE.Mesh[];
  uniforms: SilhouetteUniforms;
  setPatternState(state: SilhouettePatternState): void;
  /** Remove the overlays and release what they own; shared data stays. */
  dispose(): void;
};

type MaterialWithMap = THREE.Material & {
  map?: THREE.Texture | null;
  isOutline?: boolean;
  isLilToonMaterial?: boolean;
};

/**
 * A primitive's own material (or materials). Face effects temporarily swap a
 * face binding's material for a composite clone; callers pass the original.
 */
export type SilhouetteMaterialSource = (
  mesh: THREE.Mesh,
) => THREE.Material | THREE.Material[];

const liveMaterial: SilhouetteMaterialSource = (mesh) => mesh.material;

/** The surface (non-outline) material of a primitive. */
function surfaceMaterial(
  mesh: THREE.Mesh,
  materialOf: SilhouetteMaterialSource = liveMaterial,
): MaterialWithMap | null {
  const material = materialOf(mesh);
  const materials = Array.isArray(material) ? material : [material];
  return (
    (materials.find(
      (material) => material && !(material as MaterialWithMap).isOutline,
    ) as MaterialWithMap | undefined) ?? null
  );
}

/**
 * Whether a primitive receives an overlay: it writes depth (opaque or cutout).
 * Transparent layers without depth writes lie on surfaces that do.
 */
export function isSilhouetteSource(
  mesh: THREE.Mesh,
  materialOf: SilhouetteMaterialSource = liveMaterial,
): boolean {
  const material = surfaceMaterial(mesh, materialOf);
  if (!material) return false;
  return !(material.transparent && !material.depthWrite);
}

/**
 * Average colour of the art (alpha-weighted) as a linear colour, for the
 * `tint` fill. Falls back to white where no 2D canvas is available.
 */
export function averageArtColor(image: CanvasImageSource): THREE.Color {
  const white = new THREE.Color(1, 1, 1);
  if (typeof document === "undefined") return white;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return white;
    context.drawImage(image, 0, 0, 16, 16);
    const { data } = context.getImageData(0, 0, 16, 16);
    let r = 0;
    let g = 0;
    let b = 0;
    let weight = 0;
    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3]! / 255;
      r += data[index]! * alpha;
      g += data[index + 1]! * alpha;
      b += data[index + 2]! * alpha;
      weight += alpha;
    }
    if (weight <= 0) return white;
    return new THREE.Color().setRGB(
      r / weight / 255,
      g / weight / 255,
      b / weight / 255,
      THREE.SRGBColorSpace,
    );
  } catch {
    return white;
  }
}

/**
 * The overlay reproduces an MToon primitive's depth exactly; one unit of bias
 * absorbs precision noise. A slope factor or more units would also pass
 * layered cloth just behind (seen as double coverage at Y_0's cuffs). The
 * dev-only lilToon shader (`../toon-shader`) skins and projects in its own
 * order, so its depth drifts further: eight units hide that without a slope
 * factor, and its silhouette edges can still differ by a pixel.
 */
function polygonOffsetUnits(source: MaterialWithMap): number {
  return source.isLilToonMaterial ? -8 : -1;
}

function createOverlayMaterial(
  source: MaterialWithMap,
  shared: SilhouetteUniforms,
  blend: AvatarSilhouetteVFXEntry["appearance"]["blend"],
): THREE.ShaderMaterial {
  // Only a cutout or blended surface has a shape inside its triangles; an
  // opaque one ignores its map's alpha, as the avatar's own shader does.
  const cutout = source.alphaTest > 0 || source.transparent;
  const map = cutout ? (source.map ?? null) : null;
  if (map?.matrixAutoUpdate) map.updateMatrix();
  const material = new THREE.ShaderMaterial({
    name: `AvatarSilhouetteVFX:${source.name}`,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      ...shared,
      sourceMap: { value: map },
      useSourceMap: { value: map ? 1 : 0 },
      sourceMapTransform: {
        value: map ? map.matrix : new THREE.Matrix3(),
      },
      sourceOpacity: { value: cutout ? source.opacity : 1 },
      sourceAlphaTest: { value: cutout ? source.alphaTest : 0 },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    depthFunc: THREE.LessEqualDepth,
    polygonOffset: true,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: polygonOffsetUnits(source),
    side: source.side,
    toneMapped: false,
  });
  // One pass per face; a double-sided primitive needs no back-then-front split.
  material.forceSinglePass = true;
  configureEffectBlend(material, blend);
  return material;
}

const scratchAnchor = new THREE.Vector3();
const scratchTop = new THREE.Vector3();
const scratchUp = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();
const scratchViewport = new THREE.Vector4();
const scratchTopPixels = new THREE.Vector2();

/**
 * Overlay `sources` with the effect's art. `frame()` returns the avatar's
 * screen anchor (world) and its height in world units for this render, so the
 * pattern moves and scales with the avatar instead of swimming over it.
 */
export function createSilhouetteOverlay(args: {
  sources: readonly THREE.Mesh[];
  /** Each source's own material; defaults to its live material. */
  materialOf?: SilhouetteMaterialSource;
  art: CanvasImageSource;
  entry: AvatarSilhouetteVFXEntry;
  frame: () => { anchor: THREE.Vector3; height: number };
}): SilhouetteOverlay {
  const { entry } = args;
  const texture = createTextureFromImage(args.art);
  const uniforms: SilhouetteUniforms = {
    artMap: { value: texture },
    artFrame: { value: new THREE.Vector4(0, 0, 1, 1) },
    patternOrigin: { value: new THREE.Vector2() },
    tileSize: { value: new THREE.Vector2(64, 64) },
    patternOffset: { value: new THREE.Vector2() },
    patternRotation: { value: 0 },
    flatFill: { value: entry.fill === "tint" ? 1 : 0 },
    flatColor: {
      value:
        entry.fill === "tint" ? averageArtColor(args.art) : new THREE.Color(),
    },
    tint: { value: new THREE.Color(entry.appearance.tint ?? "#ffffff") },
    opacity: { value: entry.appearance.opacity },
  };
  // Art aspect of one frame, so tiles keep the art's proportions.
  const frameSize = resolveArtFrameSize(args.art, entry.flipbook);
  const imageAspect = frameSize ? frameSize.width / frameSize.height : 1;
  let patternScale = 1;

  /** Place the pattern for the camera and viewport about to draw. */
  const updateScreenUniforms = (
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
  ): void => {
    const { anchor, height } = args.frame();
    renderer.getCurrentViewport(scratchViewport);
    camera.getWorldQuaternion(scratchQuaternion);
    scratchUp.set(0, 1, 0).applyQuaternion(scratchQuaternion);
    scratchAnchor.copy(anchor).project(camera);
    scratchTop.copy(anchor).addScaledVector(scratchUp, height).project(camera);
    const toPixels = (ndc: THREE.Vector3, target: THREE.Vector2) =>
      target.set(
        scratchViewport.x + ((ndc.x + 1) / 2) * scratchViewport.z,
        scratchViewport.y + ((ndc.y + 1) / 2) * scratchViewport.w,
      );
    const origin = toPixels(scratchAnchor, uniforms.patternOrigin.value);
    const top = toPixels(scratchTop, scratchTopPixels);
    const avatarHeightPx = Math.max(1, top.distanceTo(origin));
    const tileHeight = Math.max(
      2,
      avatarHeightPx *
        SILHOUETTE_TILE_HEIGHT_FRACTION *
        entry.patternScale *
        patternScale,
    );
    uniforms.tileSize.value.set(tileHeight * imageAspect, tileHeight);
  };

  const materials: THREE.ShaderMaterial[] = [];
  const meshes: THREE.Mesh[] = [];
  for (const source of args.sources) {
    const sourceMaterial = surfaceMaterial(source, args.materialOf);
    if (!sourceMaterial) continue;
    const material = createOverlayMaterial(
      sourceMaterial,
      uniforms,
      entry.appearance.blend,
    );
    const overlay =
      source instanceof THREE.SkinnedMesh
        ? new THREE.SkinnedMesh(source.geometry, material)
        : new THREE.Mesh(source.geometry, material);
    if (overlay instanceof THREE.SkinnedMesh) {
      const skinned = source as THREE.SkinnedMesh;
      overlay.bindMode = skinned.bindMode;
      overlay.bind(skinned.skeleton, skinned.bindMatrix);
    }
    // Share the live array, so expressions and lip-sync move the overlay too.
    overlay.morphTargetInfluences = source.morphTargetInfluences;
    overlay.morphTargetDictionary = source.morphTargetDictionary;
    overlay.name = `AvatarSilhouetteVFX:${entry.id}:${source.name}`;
    overlay.renderOrder = SILHOUETTE_RENDER_ORDER;
    overlay.frustumCulled = false;
    overlay.onBeforeRender = (renderer, _scene, camera) =>
      updateScreenUniforms(renderer, camera);
    source.add(overlay);
    materials.push(material);
    meshes.push(overlay);
  }

  return {
    meshes,
    uniforms,
    setPatternState(state) {
      uniforms.patternOffset.value.set(state.offsetX, state.offsetY);
      uniforms.patternRotation.value = state.rotation;
      patternScale = Math.max(0.0001, state.scale);
      uniforms.opacity.value = state.opacity;
      uniforms.artFrame.value.set(
        state.frame.offsetX,
        state.frame.offsetY,
        state.frame.repeatX,
        state.frame.repeatY,
      );
    },
    dispose() {
      // Geometry, skeleton, morph weights and source maps belong to the avatar.
      for (const mesh of meshes) mesh.removeFromParent();
      for (const material of materials) material.dispose();
      texture.dispose();
      meshes.length = 0;
      materials.length = 0;
    },
  };
}

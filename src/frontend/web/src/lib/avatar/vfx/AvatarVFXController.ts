import * as THREE from "three";

import {
  AvatarAttachmentEffects,
  MAX_ACTIVE_ATTACHMENT_EFFECTS,
} from "./AvatarAttachmentEffects";
import { addAvatarIssue, type AvatarIssue } from "../diagnostics/issues";
import { PrimitiveRegionHider } from "./primitiveRegionHiding";
import { loadEffectImage } from "./effect-image";
import {
  applyFlipbookFrameToTexture,
  configureEffectBlend,
  createTextureFromImage,
  disposeObjectTree,
  getImageSize,
  isAnimatedEffect,
  resolveArtFrameSize,
} from "./effectArt";
import {
  rectangleGuidePoints,
  resolveTexturePlacementTransform,
  transformTexturePlacementPoint,
} from "./placement-transform";
import type {
  AvatarVFXManipulationFrame,
  AvatarVFXManipulationPlacement,
  AvatarVFXPlacementGuides,
  AvatarVFXUvGuide,
} from "./placement-guide-types";
import {
  planeImageCorners,
  quadManipulationPlacement,
} from "./manipulationPlacement";
import { MeshUvLocator } from "./meshUvLocator";
import {
  collectFaceSkinClipTriangles,
  createClipPath,
  dilateClipTriangles,
  type FaceSkinClipSource,
} from "./faceSkinClip";
import { TextureUvMapping } from "./textureUvMapping";
import type { RuntimePrimitiveBindingEntry } from "./avatarPrimitiveUtils";
import {
  anchoredGuideLabel,
  boxGuideLabel,
  eyeGuideLabel,
  flattenGuideLabel,
  materialTargetMessage,
  mouthGuideLabel,
  placementGuideMessage,
  placementWarningMessage,
  textureGuideLabel,
  unnamedMaterialName,
} from "./placementGuideText";

import type { Avatar } from "../Avatar";
import {
  headSized,
  measureAvatarProportions,
  type AvatarProportions,
} from "../avatarProportions";
import type {
  AvatarFaceTextureAnchorSnapshot,
  AvatarFaceTextureAnchorsSnapshot,
  AvatarFaceTextureFlattenRegionSnapshot,
  AvatarFaceTextureReferenceSize,
} from "./texture-anchor-types";
import type {
  AvatarFaceEyeLandmarkSnapshot,
  AvatarFaceLandmarksSnapshot,
  AvatarFaceLandmarkVector,
} from "./landmark-types";
import {
  EMPTY_RUNTIME_MEDIA_PROVIDER,
  type AnimaRuntimeMediaProvider,
} from "@/lib/runtime-content/AnimaRuntimeMediaCatalog";
import {
  deriveAvatarVFXAnimationPreset,
  evaluateAvatarVFXAnimation,
  resolveAvatarVFXAnimationConfig,
} from "./animation";
import { matchAvatarTargetRole } from "./avatarRuntimeTargeting";
import {
  AVATAR_FACE_PART_LABELS,
  createFaceVertexFilter,
  findFaceSkinRegion,
  findMissingFacePart,
  hasEstimatedEyes,
  resolveFacePartTargetRoles,
  type AvatarFacePartRole,
} from "./faceParts";
import { createLogger } from "@/lib/logger";
import { resolveAvatarVFXModelProfile, resolveIrisEyeLayout } from "./profiles";
import { buildRuntimePrimitiveBindings } from "../vrmEditorInspection";
import type {
  AvatarVFXAnimationPreset,
  AvatarVFXAppearance,
  AvatarVFXAppliedEffectSnapshot,
  AvatarVFXBlend,
  AvatarVFXAttachmentEntry,
  AvatarVFXApplyMode,
  AvatarVFXCatalogEntry,
  AvatarVFXEffectTransform,
  AvatarVFXParsedEntry,
  AvatarVFXFaceFlattenSnapshot,
  AvatarVFXFlattenColorSnapshot,
  AvatarVFXFlipbook,
  AvatarEyeHoverVFXEntry,
  AvatarFaceAnchoredVFXEntry,
  AvatarHoverVFXEntry,
  AvatarMouthHoverVFXEntry,
  AvatarVFXHoverPlacement,
  AvatarVFXModelProfile,
  AvatarVFXNormalizedRect,
  AvatarVFXObservationSnapshot,
  AvatarVFXRenderMode,
  AvatarVFXResolvedAnimationConfig,
  AvatarVFXRegion,
  AvatarVFXSnapshot,
  AvatarVFXTargetBindingSnapshot,
  AvatarVFXTargetRole,
  AvatarVFXTargetBindingTextureSlot,
  AvatarVFXSide,
  AvatarTextureVFXEntry,
  AvatarVFXTransform,
  AvatarVFXTransformAxisTriple,
  AvatarVFXTextureSlot,
} from "./types";
import type { AvatarVFXAnimationState } from "./animation";
import {
  getAvatarVFXApplyMode,
  getAvatarVFXRegion,
  getAvatarVFXRenderMode,
  getAvatarVFXTargetRole,
  isAvatarVFXRegionStackable,
  isBoxHoverVFXEntry,
  isEyeHoverVFXEntry,
  isFaceAnchoredVFXEntry,
  isHoverVFXEntry,
  isMouthHoverVFXEntry,
  isTextureVFXEntry,
} from "./types";

type CanvasContext = CanvasRenderingContext2D;
type VFXListener = () => void;

const logger = createLogger("AvatarVFXController");

type BindingTextureState = {
  slot: AvatarVFXTextureSlot;
  texture: THREE.Texture;
  width: number;
  height: number;
  canOverlay: boolean;
};

type EffectLayerCanvasState = {
  slot: AvatarVFXTextureSlot;
  image: CanvasImageSource;
  /** Unmirrored art for mirrored placements, when the effect has one. */
  otherImage: CanvasImageSource | null;
  placements: TexturePixelPlacementInstance[];
  width: number;
  height: number;
};

type CompositeTextureSlotState = {
  slot: AvatarVFXTextureSlot;
  canvas: HTMLCanvasElement;
  context: CanvasContext;
  texture: THREE.CanvasTexture;
  staticSegments: StaticCompositeSegmentState[];
  width: number;
  height: number;
  /** Whether the static cache drew the original slot beneath its effects. */
  baseDrawn: boolean;
  /** Clips of opaque replacements the static cache cleared the original in. */
  baseClips: Path2D[];
};

type BindingTextureCompositeState = {
  materialClone: THREE.Material;
  slotStates: Map<AvatarVFXTextureSlot, CompositeTextureSlotState>;
  staticCacheDirty: boolean;
};

type ActiveBindingEffect = {
  appliedEffectId: string;
  effectId: string;
  effectEntry: AvatarVFXCatalogEntry;
  applyMode: AvatarVFXApplyMode | null;
  animationPreset: AvatarVFXAnimationPreset | null;
  animationConfig: AvatarVFXResolvedAnimationConfig;
  renderMode: AvatarVFXRenderMode;
  forcesBlink: boolean;
  layerCanvases: Map<AvatarVFXTextureSlot, EffectLayerCanvasState>;
  hoverGroup: THREE.Group | null;
  hoverInstances: HoverPlaneInstanceState[];
  hoverRuntimeMaterials: THREE.Material[];
  /** Face part roles the effect hides while its face changes are on. */
  autoDisabledRoles: AvatarVFXTargetRole[];
  /** Bindings hidden right now; empty below {@link FACE_CHANGE_MIN_INTENSITY}. */
  disabledBindingKeys: string[];
  elapsedSec: number;
  /** Redrawn on each animation tick: own motion, or a fade below full intensity. */
  isAnimated: boolean;
  /** The effect's own motion (presets, keyframes or flipbook), without fades. */
  hasOwnMotion: boolean;
  animationState: AvatarVFXAnimationState;
  appliedOrder: number;
  /** Event envelope value (0–1) that multiplies opacity; 1 without a fade. */
  intensity: number;
  /** Pre-tinted copies of the effect's images, built once per image. */
  tintedImages: Map<CanvasImageSource, HTMLCanvasElement>;
};

type BindingState = {
  /** The live primitive this binding was built from. */
  entry: RuntimePrimitiveBindingEntry;
  bindingKey: string;
  /** Primary role: a corrected face part first, else name-matcher precedence. */
  targetRole: AvatarVFXTargetRole;
  /** Every role the mesh serves (primary first); effects on any of them use it. */
  targetRoles: AvatarVFXTargetRole[];
  materialIndex: number | null;
  materialName: string | null;
  objectName: string | null;
  objectType: string;
  object: THREE.Mesh;
  originalVisible: boolean;
  originalMaterial: THREE.Material | THREE.Material[];
  originalMainMaterial: THREE.Material | null;
  textureSlots: BindingTextureState[];
  availableEffectIds: string[];
  autoDisableSources: Set<string>;
  visibleBeforeAutoDisable: boolean | null;
  warning: string | null;
  activeEffects: Map<string, ActiveBindingEffect>;
  textureComposite: BindingTextureCompositeState | null;
};

type Size = {
  width: number;
  height: number;
};

type HoverPlacementInstance = {
  label: string;
  mirrored: boolean;
  position: THREE.Vector3;
  referenceSizeLocal: AvatarFaceTextureReferenceSize | null;
  /**
   * An eye placement's closed cover on a converted MikuMikuDance model (both
   * eyes' for a centred one): where its skin patch goes.
   */
  closedCover?: THREE.Box3;
};

type TexturePlacementInstance = {
  label: string;
  mirrorX: boolean;
  /** The effect's own mirrored copy; see `TexturePlacement.effectMirror`. */
  effectMirror?: boolean;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

type PixelRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type TexturePixelPlacementInstance = {
  label: string;
  mirrorX: boolean;
  /** The effect's own mirrored copy; see `TexturePlacement.effectMirror`. */
  effectMirror?: boolean;
  /** A cell with mirrored UVs; see `TexturePlacement.flipX`. */
  flipX?: boolean;
  rect: PixelRect;
  /** Where the art may draw; see the eye layout's `clip`. */
  clip?: PixelRect;
  /**
   * The face skin's own triangles, as a cached pixel path: whole-face art
   * draws only inside it where the texture needs a clip (`_faceSkinClip`).
   */
  clipPath?: Path2D;
};

type StaticCompositeSegmentState = {
  canvas: HTMLCanvasElement;
  context: CanvasContext;
};

type HoverPlaneInstanceState = {
  label: string;
  mesh: THREE.Mesh;
  /** Positioned at the placement (landmark plus offset) in anchor space. */
  placementRoot: THREE.Group;
  animatedGroup: THREE.Group;
  /** Holds the authored rotation for the art and its backdrop. */
  staticGroup: THREE.Group;
  backdropMesh: THREE.Mesh | null;
  /**
   * A closed-eye skin patch: fixed over the eye, in anchor space, whatever
   * the art's offset, rotation or scale.
   */
  coverPatch: { mesh: THREE.Mesh; center: THREE.Vector3 } | null;
  /** Plane size before the authored scale. */
  baseWidth: number;
  baseHeight: number;
  planeWidth: number;
  planeHeight: number;
  /** Mirrored placements mirror keyframe offsets as well as static ones. */
  mirrored: boolean;
  material: THREE.MeshBasicMaterial;
  texture: THREE.Texture;
  backdropMaterial: THREE.Material | null;
  backdropBaseOpacity: number;
};

type HoverEffectGroupState = {
  group: THREE.Group;
  instances: HoverPlaneInstanceState[];
  runtimeMaterials: THREE.Material[];
};

type ResolvedFaceFlattenState = {
  status: "unavailable" | "ready";
  faceBindingKey: string | null;
  previewEyes: boolean;
  previewMouth: boolean;
  autoEyes: boolean;
  autoMouth: boolean;
  activeEyes: boolean;
  activeMouth: boolean;
  sampledColor: AvatarVFXFlattenColorSnapshot | null;
  sampledColorsBySlot: Partial<
    Record<AvatarVFXTextureSlot, AvatarVFXFlattenColorSnapshot>
  >;
  warning: string | null;
  shouldRenderEyes: boolean;
  shouldRenderMouth: boolean;
  eyeRegions: AvatarFaceTextureFlattenRegionSnapshot[];
  mouthRegion: AvatarFaceTextureFlattenRegionSnapshot | null;
};

const SUPPORTED_TEXTURE_SLOTS: AvatarVFXTextureSlot[] = [
  "map",
  "shadeMultiplyTexture",
];

/**
 * Hover plane heights (m) at the Included Avatars' size. Eye planes grow with
 * eyes larger than {@link EYE_HOVER_REFERENCE_EYE_HEIGHT}, box planes with a
 * big head ({@link headSized}).
 */
const EYE_HOVER_PLANE_HEIGHT = 0.06;
const BOX_HOVER_PLANE_HEIGHT = 0.08;
/**
 * The largest eye the fixed eye plane fits (m): the Included Avatars' irises
 * are 0.024-0.033 m high, and adult proportions measure up to about 0.038 m.
 * A larger eye (a chibi's or a robot's) scales the plane by its height over
 * this, so eye overlays keep covering it.
 */
const EYE_HOVER_REFERENCE_EYE_HEIGHT = 0.04;
const EYE_HOVER_SURFACE_LERP = 0.35;
/**
 * How far in front of the face's surface an estimated eye's plane stays, as a
 * share of the distance between the eyes: an eye without its own mesh has no
 * depth of its own, and the face may bulge in front of it.
 */
const EYE_HOVER_SURFACE_CLEARANCE = 0.05;
const MOUTH_HOVER_SURFACE_LERP = 0.1;
const HOVER_SKIN_BACKDROP_TEXTURE_SIZE = 256;
const HOVER_SKIN_BACKDROP_WIDTH_SCALE = 1.0;
const HOVER_SKIN_BACKDROP_HEIGHT_SCALE = 0.4;
const HOVER_SKIN_BACKDROP_Z_OFFSET = -0.0001;
/**
 * A closed-eye skin patch's size over its eye's closed cover, at most
 * {@link CLOSED_EYE_PATCH_MAX_SHARE} of the eye spacing, so the patches of
 * two eyes never meet and never reach past the face.
 */
const CLOSED_EYE_PATCH_SCALE = 1.15;
const CLOSED_EYE_PATCH_MAX_SHARE = { width: 0.75, height: 0.7 };
/**
 * The share of a closed-eye patch's radius that fades out: narrower than
 * the face cleanup's, so a patch little larger than its eye covers it and
 * spills little onto hair beside the eye.
 */
const CLOSED_EYE_PATCH_FEATHER = 0.2;
/**
 * How far (m) in front of its closed cover's front a closed-eye patch sits:
 * just clear of the lids and lashes, so bangs hanging in front of the eyes
 * still cover it as they cover the face.
 */
const CLOSED_EYE_PATCH_CLEARANCE = 0.0005;
const HOVER_RENDER_ORDER = 950;
const EYE_HOVER_FORCE_BLINK_EXPRESSION = "blink";
/**
 * Envelope value at which an effect's on/off face changes (hidden parts and
 * face cleanup) switch on, so a fade-in hides the eyes once its art is half
 * visible rather than on its first faint frame. The forced blink and the art
 * fade continuously instead.
 */
const FACE_CHANGE_MIN_INTENSITY = 0.5;
const VFX_ANIMATION_FRAME_INTERVAL_SEC = 1 / 30;
/** Composites redrawn for a transform edit at most this often (30 FPS). */
const TRANSFORM_REDRAW_INTERVAL_MS = 1000 / 30;
const FACE_FLATTEN_EDGE_FEATHER_RATIO = 0.4;
const EYE_HOVER_AUTO_DISABLED_ROLES: AvatarVFXTargetRole[] = [
  "eye_highlight",
  "eyeline",
  "eyelash",
];
/** Hidden roles whose parts can also be regions of a shared primitive. */
const DETAIL_REGION_ROLES = ["eyeline", "eyelash"] as const;
/**
 * Roles hidden region by region when a part is a region of a shared
 * primitive: the eye details, and face skin that is the head region of a
 * primitive holding the whole body.
 */
const HIDDEN_REGION_ROLES = [...DETAIL_REGION_ROLES, "face_skin"] as const;
const HOVER_BACKDROP_STRIPPED_TEXTURE_PROPS = [
  "alphaMap",
  "normalMap",
  "normalTexture",
  "bumpMap",
  "aoMap",
  "emissiveMap",
  "emissiveTexture",
  "matcap",
  "matcapTexture",
  "metalnessMap",
  "roughnessMap",
  "occlusionTexture",
  "outlineWidthMultiplyTexture",
  "rimMultiplyTexture",
  "shadingShiftTexture",
  "uvAnimationMaskTexture",
] as const;

function isMaterialWithTextures(
  value: THREE.Material | null,
): value is THREE.Material & Record<string, unknown> {
  return value instanceof THREE.Material;
}

function hasMaterialUpdate(
  value: THREE.Material | null,
): value is THREE.Material & { update: (delta: number) => void } {
  if (!(value instanceof THREE.Material)) return false;
  const candidate = value as THREE.Material & {
    update?: ((delta: number) => void) | undefined;
  };
  return typeof candidate.update === "function";
}

function isCanvasImageSource(value: unknown): value is CanvasImageSource {
  if (!value) return false;
  if (
    typeof HTMLImageElement !== "undefined" &&
    value instanceof HTMLImageElement
  ) {
    return true;
  }
  if (
    typeof HTMLCanvasElement !== "undefined" &&
    value instanceof HTMLCanvasElement
  ) {
    return true;
  }
  if (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap) {
    return true;
  }
  if (
    typeof OffscreenCanvas !== "undefined" &&
    value instanceof OffscreenCanvas
  ) {
    return true;
  }
  if (
    typeof HTMLVideoElement !== "undefined" &&
    value instanceof HTMLVideoElement
  ) {
    return true;
  }
  return false;
}

function cloneTransformAxisTriple(
  value: AvatarVFXTransformAxisTriple,
): AvatarVFXTransformAxisTriple {
  return {
    x: value.x,
    y: value.y,
    z: value.z,
  };
}

function cloneEffectTransform(value: AvatarVFXTransform): AvatarVFXTransform {
  return {
    offset: cloneTransformAxisTriple(value.offset),
    scale: cloneTransformAxisTriple(value.scale),
    rotation: cloneTransformAxisTriple(value.rotation),
  };
}

function resolveStaticScaleComponent(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0.0001, Math.abs(value));
}

function formatSizeLabel(width: number, height: number): string {
  return `${width}x${height}`;
}

function resolveEffectRenderMode(
  effect: AvatarVFXCatalogEntry,
): AvatarVFXRenderMode {
  return getAvatarVFXRenderMode(effect);
}

function resolveTextureLayout(
  effect: AvatarFaceAnchoredVFXEntry,
): "single" | "span" {
  if (effect.anchor === "mouth") {
    return "single";
  }
  return effect.layout;
}

function resolveTexturePivot(effect: {
  pivot?: AvatarFaceAnchoredVFXEntry["pivot"];
}): NonNullable<AvatarFaceAnchoredVFXEntry["pivot"]> {
  return effect.pivot ?? "center";
}

function isAnchoredFaceTextureEffect(
  effect: AvatarVFXCatalogEntry,
): effect is AvatarFaceAnchoredVFXEntry {
  return isFaceAnchoredVFXEntry(effect);
}

function cloneCatalogEffectEntry(
  effect: AvatarVFXCatalogEntry,
): AvatarVFXCatalogEntry {
  return {
    ...effect,
    transform: cloneEffectTransform(effect.transform),
    animationConfig: effect.animationConfig
      ? {
          ...effect.animationConfig,
          driftPerSecond: effect.animationConfig.driftPerSecond
            ? { ...effect.animationConfig.driftPerSecond }
            : undefined,
        }
      : undefined,
  };
}

function shouldForceBlink(effect: AvatarVFXCatalogEntry): boolean {
  return isEyeHoverVFXEntry(effect) && (effect.forceBlink ?? true);
}

/** The hiding source `Fcl_EYE_Iris_Hide` counts under, beside effects. */
const IRIS_HIDE_SOURCE = "expression:Fcl_EYE_Iris_Hide";

/**
 * Whether hiding these roles hides a mesh that serves `roles`. A mesh that is
 * also face skin or an iris stays visible unless that role is hidden too, so
 * hiding eye details never removes the face or the eyes.
 */
function bindingIsHiddenByRoles(
  roles: readonly AvatarVFXTargetRole[],
  hidden: readonly AvatarVFXTargetRole[],
): boolean {
  if (!roles.some((role) => hidden.includes(role))) return false;
  return roles.every(
    (role) =>
      hidden.includes(role) || (role !== "face_skin" && role !== "eye_iris"),
  );
}

function getAutoDisabledRoles(
  effect: AvatarVFXCatalogEntry,
): AvatarVFXTargetRole[] {
  const roles = new Set(
    "disableTargetRoles" in effect ? (effect.disableTargetRoles ?? []) : [],
  );
  if (isEyeHoverVFXEntry(effect) && (effect.autoDisableEyeMaterials ?? true)) {
    EYE_HOVER_AUTO_DISABLED_ROLES.forEach((role) => roles.add(role));
  }
  return Array.from(roles);
}

function lerpNumber(start: number, end: number, alpha: number): number {
  return start + (end - start) * alpha;
}

function toVector3(value: AvatarFaceLandmarkVector): THREE.Vector3 {
  return new THREE.Vector3(value.x, value.y, value.z);
}

function lerpVector3(
  start: THREE.Vector3,
  end: THREE.Vector3,
  alpha: number,
): THREE.Vector3 {
  return start.clone().lerp(end, alpha);
}

function midpointVector3(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
  return a.clone().lerp(b, 0.5);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getTextureSlot(
  material: THREE.Material | null,
  slot: AvatarVFXTextureSlot,
): THREE.Texture | null {
  if (!isMaterialWithTextures(material)) return null;
  const value = material[slot];
  return value instanceof THREE.Texture ? value : null;
}

function setTextureSlot(
  material: THREE.Material | null,
  slot: AvatarVFXTextureSlot,
  texture: THREE.Texture | null,
): void {
  if (!isMaterialWithTextures(material)) return;
  material[slot] = texture;
  material.needsUpdate = true;
}

function updateMaterialRuntime(
  material: THREE.Material | null,
  delta: number,
): void {
  if (!hasMaterialUpdate(material)) return;
  material.update(delta);
}

function getRenderableMainMaterial(object: THREE.Mesh): THREE.Material | null {
  const material = Array.isArray(object.material)
    ? (object.material[0] ?? null)
    : object.material;
  return material instanceof THREE.Material ? material : null;
}

/**
 * Whether art painted on a face skin binding's textures shows: its material
 * draws a base color texture (`map`) through the first UV set, the image face
 * anchors and clips are measured on, and an overlay can paint it. Painted
 * into MToon's shade texture alone, art would show only in shadow.
 */
function showsPaintedFaceArt(
  binding: Pick<BindingState, "textureSlots">,
  applyMode: AvatarVFXApplyMode,
): boolean {
  const map = binding.textureSlots.find((slot) => slot.slot === "map");
  return (
    map !== undefined &&
    map.texture.channel === 0 &&
    (applyMode !== "overlay" || map.canOverlay)
  );
}

/**
 * The least change, as a share of full brightness, a multiply-blended decal
 * must make in some colour channel for it to show: 8 of 255, the largest
 * channel step the review renders (`effects:render`) count as a visible
 * change. Included `shiver_undereye` (opacity 0.45, art mean about 0.69,
 * 0.85, 0.98) changes the red channel of the Included Avatars' skin under its
 * anchors by about 34/255 and of the darkest survey skin by about 25/255;
 * the neutral dark grey screen of a low-poly robot face by about 7/255.
 */
const MULTIPLY_MIN_VISIBLE_CHANGE = 8 / 255;
/** Longest side, in pixels, an image is reduced to before its mean is read. */
const COLOR_SAMPLE_SIZE = 64;

/** A colour as three channels, 0–1 each. */
type Rgb = readonly [number, number, number];

/**
 * The mean colour (0–1 per channel, weighted by alpha, on the stored values)
 * of `image` within `rect` (its pixels, clamped to the image), or null when
 * it cannot be read. The area is reduced to at most
 * {@link COLOR_SAMPLE_SIZE} pixels a side first.
 */
function meanImageColor(image: CanvasImageSource, rect: PixelRect): Rgb | null {
  const size = getImageSize(image);
  if (!size) return null;
  const x = clampNumber(Math.floor(rect.x), 0, size.width - 1);
  const y = clampNumber(Math.floor(rect.y), 0, size.height - 1);
  const width = clampNumber(Math.ceil(rect.width), 1, size.width - x);
  const height = clampNumber(Math.ceil(rect.height), 1, size.height - y);
  const scale = Math.min(1, COLOR_SAMPLE_SIZE / Math.max(width, height));
  const sampleWidth = Math.max(1, Math.round(width * scale));
  const sampleHeight = Math.max(1, Math.round(height * scale));
  try {
    const { context } = createCanvas(sampleWidth, sampleHeight);
    context.drawImage(
      image,
      x,
      y,
      width,
      height,
      0,
      0,
      sampleWidth,
      sampleHeight,
    );
    const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
    let weight = 0;
    const totals = [0, 0, 0];
    for (let at = 0; at < pixels.length; at += 4) {
      const alpha = pixels[at + 3]! / 255;
      if (alpha <= 0) continue;
      weight += alpha;
      for (let channel = 0; channel < 3; channel += 1) {
        totals[channel]! += alpha * pixels[at + channel]!;
      }
    }
    if (weight <= 0) return null;
    return [
      totals[0]! / weight / 255,
      totals[1]! / weight / 255,
      totals[2]! / weight / 255,
    ];
  } catch {
    return null;
  }
}

/** A `#rrggbb` tint as channels; white when it cannot be read. */
function tintColor(tint: string): Rgb {
  const value = Number.parseInt(tint.slice(1, 7), 16);
  if (!Number.isFinite(value)) return [1, 1, 1];
  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  ];
}

/**
 * An estimate of how much a multiply-blended decal changes the surface it is
 * painted on, as a share of full brightness in the channel it changes most:
 * multiply scales each channel of the surface by the art's, so at opacity
 * `o` a channel changes by `o × S × (1 − A × T)` from the surface's mean
 * `S`, the art's mean `A` and the tint `T` in that channel. The brightest
 * placement counts. Means, not per-pixel values, so a decal over a mixed
 * surface may still show a little where this says it does not. Null when
 * the images cannot be read.
 */
function multiplyDecalChange(args: {
  effect: AvatarVFXCatalogEntry;
  art: CanvasImageSource;
  surface: CanvasImageSource;
  placements: readonly TexturePixelPlacementInstance[];
}): number | null {
  const size = getImageSize(args.art);
  const art = size ? meanImageColor(args.art, { x: 0, y: 0, ...size }) : null;
  const surfaces = args.placements
    .map((placement) => meanImageColor(args.surface, placement.rect))
    .filter((value): value is Rgb => value !== null);
  if (!art || surfaces.length === 0) return null;
  const appearance = resolveAppearance(args.effect);
  const tint = appearance.tint ? tintColor(appearance.tint) : [1, 1, 1];
  const changes = surfaces.flatMap((surface) =>
    surface.map(
      (value, channel) => value * (1 - art[channel]! * tint[channel]!),
    ),
  );
  return appearance.opacity * Math.max(...changes);
}

function getTextureImageSource(
  texture: THREE.Texture,
): CanvasImageSource | null {
  const image = texture.image ?? texture.source?.data;
  return isCanvasImageSource(image) ? image : null;
}

function getTextureSize(texture: THREE.Texture): Size | null {
  const image = getTextureImageSource(texture);
  if (!image) return null;
  const imageRecord = image as {
    width?: number;
    height?: number;
    videoWidth?: number;
    videoHeight?: number;
    displayWidth?: number;
    displayHeight?: number;
  };
  const width =
    (typeof imageRecord.width === "number" && imageRecord.width > 0
      ? imageRecord.width
      : null) ??
    (typeof imageRecord.videoWidth === "number" && imageRecord.videoWidth > 0
      ? imageRecord.videoWidth
      : null) ??
    (typeof imageRecord.displayWidth === "number" &&
    imageRecord.displayWidth > 0
      ? imageRecord.displayWidth
      : null);
  const height =
    (typeof imageRecord.height === "number" && imageRecord.height > 0
      ? imageRecord.height
      : null) ??
    (typeof imageRecord.videoHeight === "number" && imageRecord.videoHeight > 0
      ? imageRecord.videoHeight
      : null) ??
    (typeof imageRecord.displayHeight === "number" &&
    imageRecord.displayHeight > 0
      ? imageRecord.displayHeight
      : null);
  if (!width || !height) return null;
  return { width, height };
}

function copyTextureSettings(
  source: THREE.Texture,
  target: THREE.CanvasTexture,
): void {
  target.name = source.name;
  target.colorSpace = source.colorSpace;
  target.flipY = source.flipY;
  target.wrapS = source.wrapS;
  target.wrapT = source.wrapT;
  target.magFilter = source.magFilter;
  target.minFilter = source.minFilter;
  target.anisotropy = source.anisotropy;
  target.generateMipmaps = source.generateMipmaps;
  target.premultiplyAlpha = source.premultiplyAlpha;
  target.unpackAlignment = source.unpackAlignment;
  target.offset.copy(source.offset);
  target.repeat.copy(source.repeat);
  target.center.copy(source.center);
  target.rotation = source.rotation;
  target.matrixAutoUpdate = true;
  target.needsUpdate = true;
  target.updateMatrix();
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("2D canvas context is unavailable.");
  }
  return { canvas, context };
}

function createStaticCompositeSegments(args: {
  width: number;
  height: number;
  count: number;
}): StaticCompositeSegmentState[] {
  return Array.from({ length: args.count }, () => {
    const { canvas, context } = createCanvas(args.width, args.height);
    return {
      canvas,
      context,
    };
  });
}

function toCssColor(args: {
  r: number;
  g: number;
  b: number;
  a: number;
}): string {
  return `rgba(${args.r}, ${args.g}, ${args.b}, ${args.a.toFixed(4)})`;
}

function sampleAverageTextureColor(args: {
  image: CanvasImageSource;
  width: number;
  height: number;
  region: AvatarFaceTextureFlattenRegionSnapshot;
}): AvatarVFXFlattenColorSnapshot | null {
  const regionWidth = Math.max(
    1,
    Math.round(args.width * args.region.referenceSizeUv.width),
  );
  const regionHeight = Math.max(
    1,
    Math.round(args.height * args.region.referenceSizeUv.height),
  );
  const sourceX = clampNumber(
    Math.round(args.region.uv.u * args.width - regionWidth * 0.5),
    0,
    Math.max(0, args.width - regionWidth),
  );
  const sourceY = clampNumber(
    Math.round(args.region.uv.v * args.height - regionHeight * 0.5),
    0,
    Math.max(0, args.height - regionHeight),
  );

  try {
    const { context } = createCanvas(regionWidth, regionHeight);
    context.drawImage(
      args.image,
      sourceX,
      sourceY,
      regionWidth,
      regionHeight,
      0,
      0,
      regionWidth,
      regionHeight,
    );

    const imageData = context.getImageData(0, 0, regionWidth, regionHeight);
    const pixels = imageData.data;
    let totalAlpha = 0;
    let totalR = 0;
    let totalG = 0;
    let totalB = 0;

    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = pixels[index + 3] / 255;
      if (alpha <= 0) continue;
      totalAlpha += alpha;
      totalR += pixels[index] * alpha;
      totalG += pixels[index + 1] * alpha;
      totalB += pixels[index + 2] * alpha;
    }

    if (totalAlpha <= 0) {
      return null;
    }

    const r = Math.round(totalR / totalAlpha);
    const g = Math.round(totalG / totalAlpha);
    const b = Math.round(totalB / totalAlpha);
    const a = 1;
    return {
      r,
      g,
      b,
      a,
      cssColor: toCssColor({ r, g, b, a }),
    };
  } catch {
    return null;
  }
}

function drawFeatheredFlattenEllipse(args: {
  context: CanvasContext;
  region: AvatarFaceTextureFlattenRegionSnapshot;
  fillColor: AvatarVFXFlattenColorSnapshot;
  width: number;
  height: number;
}): void {
  const centerX = args.region.uv.u * args.width;
  const centerY = args.region.uv.v * args.height;
  const radiusX = Math.max(
    1,
    args.region.referenceSizeUv.width * args.width * 0.5,
  );
  const radiusY = Math.max(
    1,
    args.region.referenceSizeUv.height * args.height * 0.5,
  );
  const innerStop = clampNumber(1 - FACE_FLATTEN_EDGE_FEATHER_RATIO, 0, 0.98);
  const opaqueColor = args.fillColor.cssColor;
  const transparentColor = toCssColor({
    r: args.fillColor.r,
    g: args.fillColor.g,
    b: args.fillColor.b,
    a: 0,
  });

  args.context.save();
  args.context.translate(centerX, centerY);
  args.context.scale(radiusX, radiusY);
  const gradient = args.context.createRadialGradient(0, 0, 0, 0, 0, 1);
  gradient.addColorStop(0, opaqueColor);
  gradient.addColorStop(innerStop, opaqueColor);
  gradient.addColorStop(1, transparentColor);
  args.context.fillStyle = gradient;
  args.context.beginPath();
  args.context.arc(0, 0, 1, 0, Math.PI * 2);
  args.context.fill();
  args.context.restore();
}

function drawHoverSkinBackdropEllipse(args: {
  context: CanvasContext;
  width: number;
  height: number;
  fillColor: AvatarVFXFlattenColorSnapshot;
  /** The share of the radius that fades out; the face cleanup's by default. */
  feather?: number;
}): void {
  const centerX = args.width * 0.5;
  const centerY = args.height * 0.5;
  const radiusX = args.width * 0.5;
  const radiusY = args.height * 0.5;
  const innerStop = clampNumber(
    1 - (args.feather ?? FACE_FLATTEN_EDGE_FEATHER_RATIO),
    0,
    0.98,
  );
  const opaqueColor = args.fillColor.cssColor;
  const transparentColor = toCssColor({
    r: args.fillColor.r,
    g: args.fillColor.g,
    b: args.fillColor.b,
    a: 0,
  });

  args.context.save();
  args.context.translate(centerX, centerY);
  args.context.scale(radiusX, radiusY);
  const gradient = args.context.createRadialGradient(0, 0, 0, 0, 0, 1);
  gradient.addColorStop(0, opaqueColor);
  gradient.addColorStop(innerStop, opaqueColor);
  gradient.addColorStop(1, transparentColor);
  args.context.fillStyle = gradient;
  args.context.beginPath();
  args.context.arc(0, 0, 1, 0, Math.PI * 2);
  args.context.fill();
  args.context.restore();
}

function createHoverSkinBackdropTexture(args: {
  fillColor: AvatarVFXFlattenColorSnapshot;
  width: number;
  height: number;
  templateTexture: THREE.Texture;
  feather?: number;
}): THREE.CanvasTexture {
  const { canvas, context } = createCanvas(args.width, args.height);
  drawHoverSkinBackdropEllipse({
    context,
    width: args.width,
    height: args.height,
    fillColor: args.fillColor,
    feather: args.feather,
  });

  const texture = new THREE.CanvasTexture(canvas);
  copyTextureSettings(args.templateTexture, texture);
  return texture;
}

function createHoverSkinBackdropMaterial(args: {
  sourceBinding: BindingState;
  fillColor: AvatarVFXFlattenColorSnapshot;
  feather?: number;
}): THREE.Material | null {
  const sourceMaterial = args.sourceBinding.originalMainMaterial;
  if (!sourceMaterial) {
    return null;
  }

  const sourceSlots = args.sourceBinding.textureSlots.filter(
    (slot) => slot.slot === "map" || slot.slot === "shadeMultiplyTexture",
  );
  const templateSlot =
    sourceSlots.find((slot) => slot.slot === "map") ?? sourceSlots[0] ?? null;
  if (!templateSlot) {
    return null;
  }

  const width = templateSlot.width || HOVER_SKIN_BACKDROP_TEXTURE_SIZE;
  const height = templateSlot.height || HOVER_SKIN_BACKDROP_TEXTURE_SIZE;
  const generatedTexture = createHoverSkinBackdropTexture({
    fillColor: args.fillColor,
    feather: args.feather,
    width,
    height,
    templateTexture: templateSlot.texture,
  });

  // A custom shader other than MToon (three-liltoon's, say) skins and blends
  // its own way and draws an opaque dark box on the unskinned card, so the
  // card gets a plain skin-coloured material instead of the face's clone.
  const cloneable =
    !(sourceMaterial instanceof THREE.ShaderMaterial) ||
    (sourceMaterial as { isMToonMaterial?: boolean }).isMToonMaterial === true;
  if (!cloneable) {
    return new THREE.MeshBasicMaterial({
      map: generatedTexture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  const materialClone = sourceMaterial.clone();
  const materialRecord = materialClone as THREE.Material &
    Record<string, unknown>;
  materialClone.transparent = true;
  materialClone.depthWrite = false;
  materialClone.side = THREE.DoubleSide;

  HOVER_BACKDROP_STRIPPED_TEXTURE_PROPS.forEach((slot) => {
    if (!(slot in materialRecord)) return;
    materialRecord[slot] = null;
  });
  if (materialRecord.emissive instanceof THREE.Color) {
    materialRecord.emissive.setRGB(0, 0, 0);
  }
  if (typeof materialRecord.emissiveIntensity === "number") {
    materialRecord.emissiveIntensity = 0;
  }
  if (materialRecord.normalScale instanceof THREE.Vector2) {
    materialRecord.normalScale.set(0, 0);
  }
  if (typeof materialRecord.bumpScale === "number") {
    materialRecord.bumpScale = 0;
  }
  if (typeof materialRecord.aoMapIntensity === "number") {
    materialRecord.aoMapIntensity = 0;
  }

  sourceSlots.forEach((slot) => {
    setTextureSlot(materialClone, slot.slot, generatedTexture);
  });
  materialClone.needsUpdate = true;
  return materialClone;
}

function toPixelRect(size: Size, rect: AvatarVFXNormalizedRect) {
  return {
    x: Math.round(size.width * rect.x),
    y: Math.round(size.height * rect.y),
    width: Math.round(size.width * rect.width),
    height: Math.round(size.height * rect.height),
  };
}

function getCombinedRect(
  left: AvatarVFXNormalizedRect,
  right: AvatarVFXNormalizedRect,
): AvatarVFXNormalizedRect {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return {
    x,
    y,
    width: maxX - x,
    height: maxY - y,
  };
}

function toPixelFloatRect(
  size: Size,
  rect: TexturePlacementInstance["rect"],
): TexturePlacementInstance["rect"] {
  return {
    x: size.width * rect.x,
    y: size.height * rect.y,
    width: size.width * rect.width,
    height: size.height * rect.height,
  };
}

function resolveOppositeSide(side: AvatarVFXSide): AvatarVFXSide {
  return side === "left" ? "right" : "left";
}

function resolvePivotFactors(pivot: AvatarFaceAnchoredVFXEntry["pivot"]): {
  x: number;
  y: number;
} {
  switch (pivot ?? "center") {
    case "top-left":
      return { x: 0, y: 0 };
    case "top-center":
      return { x: 0.5, y: 0 };
    case "top-right":
      return { x: 1, y: 0 };
    case "center-left":
      return { x: 0, y: 0.5 };
    case "center-right":
      return { x: 1, y: 0.5 };
    case "bottom-left":
      return { x: 0, y: 1 };
    case "bottom-center":
      return { x: 0.5, y: 1 };
    case "bottom-right":
      return { x: 1, y: 1 };
    case "center":
    default:
      return { x: 0.5, y: 0.5 };
  }
}

function getBilateralTextureAnchor(
  faceTextureAnchors: AvatarFaceTextureAnchorsSnapshot,
  textureAnchor: AvatarFaceAnchoredVFXEntry["anchor"],
  side: AvatarVFXSide,
): AvatarFaceTextureAnchorSnapshot | null {
  if (textureAnchor === "undereye") {
    return faceTextureAnchors.anchors.undereye[side];
  }
  if (textureAnchor === "blush") {
    return faceTextureAnchors.anchors.blush[side];
  }
  return null;
}

function resolveAnchoredTexturePlacementSize(args: {
  referenceSizeUv: AvatarFaceTextureAnchorSnapshot["referenceSizeUv"];
  effect: AvatarFaceAnchoredVFXEntry;
  imageSize: Size | null;
}): Size {
  const scaleX = resolveStaticScaleComponent(args.effect.transform.scale.x);
  const scaleY = resolveStaticScaleComponent(args.effect.transform.scale.y);
  return resolvePlacementSizeFromReferenceSize({
    referenceSize: {
      width: Math.max(0.0001, args.referenceSizeUv.width * scaleX),
      height: Math.max(0.0001, args.referenceSizeUv.height * scaleY),
    },
    imageSize: args.imageSize,
  });
}

function resolvePlacementSizeFromReferenceSize(args: {
  referenceSize: {
    width: number;
    height: number;
  };
  imageSize: Size | null;
}): Size {
  const baseWidth = Math.max(0.0001, args.referenceSize.width);
  const baseHeight = Math.max(0.0001, args.referenceSize.height);
  const imageSize = args.imageSize;
  if (!imageSize || imageSize.width <= 0 || imageSize.height <= 0) {
    return {
      width: baseWidth,
      height: baseHeight,
    };
  }

  const imageAspect = imageSize.width / imageSize.height;
  if (!Number.isFinite(imageAspect) || imageAspect <= 0) {
    return {
      width: baseWidth,
      height: baseHeight,
    };
  }

  const referenceAspect = baseWidth / baseHeight;
  if (!Number.isFinite(referenceAspect) || referenceAspect <= 0) {
    return {
      width: baseWidth,
      height: baseHeight,
    };
  }

  if (imageAspect >= referenceAspect) {
    return {
      width: Math.max(baseWidth, baseHeight * imageAspect),
      height: baseHeight,
    };
  }

  return {
    width: baseWidth,
    height: Math.max(baseHeight, baseWidth / imageAspect),
  };
}

function createAnchoredTexturePlacementRect(args: {
  anchorUv: AvatarFaceTextureAnchorSnapshot["uv"];
  referenceSizeUv: AvatarFaceTextureAnchorSnapshot["referenceSizeUv"];
  effect: AvatarFaceAnchoredVFXEntry;
  imageSize: Size | null;
  mirrorPlacementX?: boolean;
}): TexturePlacementInstance["rect"] {
  const { width, height } = resolveAnchoredTexturePlacementSize(args);
  const pivot = resolvePivotFactors(resolveTexturePivot(args.effect));
  const pivotX = args.mirrorPlacementX ? 1 - pivot.x : pivot.x;
  const offsetX =
    args.effect.transform.offset.x * (args.mirrorPlacementX ? -1 : 1);
  return {
    x: args.anchorUv.u + offsetX - width * pivotX,
    y: args.anchorUv.v + args.effect.transform.offset.y - height * pivot.y,
    width,
    height,
  };
}

/** `text` with its first letter lower-cased, to follow a colon. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Why painted face art is skipped with its own Diagnostics finding rather
 * than `effect_placement_failed`.
 */
type TexturePlacementSkip =
  | "effect_anchor_covered"
  | "effect_face_texture_hidden"
  | "effect_surface_too_dark";

/** The result of an anchored decal whose anchor lies under other surfaces. */
function coveredAnchorPlacement(anchor: string): {
  instances: TexturePlacementInstance[];
  warning: string;
  skip: TexturePlacementSkip;
} {
  return {
    instances: [],
    warning: `The ${anchor} texture anchor lies under other parts of this avatar (eyes or a nose modelled over the skin), so art painted there would not show.`,
    skip: "effect_anchor_covered",
  };
}

function resolveAnchoredTexturePlacementInstances(args: {
  effect: AvatarFaceAnchoredVFXEntry;
  faceTextureAnchors: AvatarFaceTextureAnchorsSnapshot;
  imageSize: Size | null;
}): {
  instances: TexturePlacementInstance[];
  warning?: string;
  skip?: TexturePlacementSkip;
} {
  const { effect, faceTextureAnchors } = args;
  if (faceTextureAnchors.status !== "ready") {
    return {
      instances: [],
      warning:
        faceTextureAnchors.warnings[0] ??
        "Face texture anchors are unavailable for anchored decals.",
    };
  }

  const textureAnchor = effect.anchor;

  if (textureAnchor === "mouth") {
    const mouthAnchor = faceTextureAnchors.anchors.mouth.center;
    if (!mouthAnchor) {
      return {
        instances: [],
        warning: "No mouth texture anchor was resolved for the active avatar.",
      };
    }
    if (mouthAnchor.covered) return coveredAnchorPlacement(textureAnchor);
    return {
      instances: [
        {
          label: "mouth",
          mirrorX: false,
          rect: createAnchoredTexturePlacementRect({
            anchorUv: mouthAnchor.uv,
            referenceSizeUv: mouthAnchor.referenceSizeUv,
            effect,
            imageSize: args.imageSize,
          }),
        },
      ],
    };
  }

  const leftAnchor = getBilateralTextureAnchor(
    faceTextureAnchors,
    textureAnchor,
    "left",
  );
  const rightAnchor = getBilateralTextureAnchor(
    faceTextureAnchors,
    textureAnchor,
    "right",
  );
  if (!leftAnchor || !rightAnchor) {
    return {
      instances: [],
      warning: `Both ${textureAnchor} anchors are required for the active avatar.`,
    };
  }

  if (resolveTextureLayout(effect) === "span") {
    if (leftAnchor.covered || rightAnchor.covered) {
      return coveredAnchorPlacement(textureAnchor);
    }
    const centerUv = {
      u: (leftAnchor.uv.u + rightAnchor.uv.u) * 0.5,
      v: (leftAnchor.uv.v + rightAnchor.uv.v) * 0.5,
    };
    return {
      instances: [
        {
          label: textureAnchor,
          mirrorX: false,
          rect: createAnchoredTexturePlacementRect({
            anchorUv: centerUv,
            referenceSizeUv: {
              width:
                Math.abs(leftAnchor.uv.u - rightAnchor.uv.u) +
                (leftAnchor.referenceSizeUv.width +
                  rightAnchor.referenceSizeUv.width) *
                  0.5,
              height: Math.max(
                leftAnchor.referenceSizeUv.height,
                rightAnchor.referenceSizeUv.height,
              ),
            },
            effect,
            imageSize: args.imageSize,
          }),
        },
      ],
    };
  }

  if (resolveTextureLayout(effect) !== "single") {
    return { instances: [] };
  }

  if (!("side" in effect) || !effect.side) {
    return {
      instances: [],
      warning: `Single ${textureAnchor} decals require a side.`,
    };
  }

  const primarySide = effect.side;
  const oppositeSide = resolveOppositeSide(primarySide);
  const primaryAnchor = primarySide === "left" ? leftAnchor : rightAnchor;
  const oppositeAnchor = oppositeSide === "left" ? leftAnchor : rightAnchor;
  if (
    primaryAnchor.covered ||
    (effect.requiresMirror && oppositeAnchor.covered)
  ) {
    return coveredAnchorPlacement(textureAnchor);
  }

  const instances: TexturePlacementInstance[] = [
    {
      label: primarySide,
      mirrorX: false,
      rect: createAnchoredTexturePlacementRect({
        anchorUv: primaryAnchor.uv,
        referenceSizeUv: primaryAnchor.referenceSizeUv,
        effect,
        imageSize: args.imageSize,
      }),
    },
  ];

  if (effect.requiresMirror) {
    instances.push({
      label: oppositeSide,
      mirrorX: true,
      effectMirror: true,
      rect: createAnchoredTexturePlacementRect({
        anchorUv: oppositeAnchor.uv,
        referenceSizeUv: oppositeAnchor.referenceSizeUv,
        effect,
        imageSize: args.imageSize,
        mirrorPlacementX: true,
      }),
    });
  }

  return { instances };
}

/**
 * Where a texture effect draws on one slot's canvas, in its pixels. Whole-face
 * art covers the face rectangle, clipped to the face skin's own triangles
 * when `faceClip` (read only for that art) returns their path; where the clip
 * is `faceClipRequired` (a face inside a whole-body primitive, whose body
 * shares the texture) and cannot be built, it is not drawn. Anchored decals
 * are clipped to `decalClip` when it returns one (the same faces).
 */
function resolveTextureEffectPlacements(args: {
  image: CanvasImageSource;
  effect: AvatarVFXCatalogEntry;
  size: Size;
  profile: AvatarVFXModelProfile;
  faceTextureAnchors: AvatarFaceTextureAnchorsSnapshot | null;
  faceClip?: () => Path2D | null;
  faceClipRequired?: boolean;
  decalClip?: () => Path2D | null;
}): {
  placements: TexturePixelPlacementInstance[];
  warning?: string;
  skip?: TexturePlacementSkip;
} {
  const { image, effect, size, profile, faceTextureAnchors } = args;

  if (isTextureVFXEntry(effect) && effect.targetRole === "eye_iris") {
    const eyeLayout = profile.eyeLayout;
    if (!eyeLayout) return { placements: [] };
    // One eye's cell, its clip when the layout has one, and its UV flip.
    const eye = (side: "left" | "right") => ({
      rect: toPixelRect(size, eyeLayout[side]),
      ...(eyeLayout.clip
        ? { clip: toPixelRect(size, eyeLayout.clip[side]) }
        : {}),
      ...(eyeLayout.flipped?.[side] ? { flipX: true } : {}),
    });

    if (effect.assetShape === "single_eye") {
      if (effect.side) {
        const opposite = effect.side === "left" ? "right" : "left";
        const placements: TexturePixelPlacementInstance[] = [
          {
            label: effect.side,
            mirrorX: false,
            ...eye(effect.side),
          },
        ];
        if (effect.requiresMirror) {
          placements.push({
            label: opposite,
            mirrorX: true,
            effectMirror: true,
            ...eye(opposite),
          });
        }
        return { placements };
      }

      return {
        placements: [
          {
            label: "left",
            mirrorX: false,
            ...eye("left"),
          },
          {
            label: "right",
            mirrorX: eyeLayout.mirrorRight,
            ...eye("right"),
          },
        ],
      };
    }

    const combinedRect = toPixelRect(
      size,
      getCombinedRect(eyeLayout.left, eyeLayout.right),
    );
    return {
      placements: [
        {
          label: "both",
          mirrorX: false,
          rect: combinedRect,
          ...(eyeLayout.clip
            ? {
                clip: toPixelRect(
                  size,
                  getCombinedRect(eyeLayout.clip.left, eyeLayout.clip.right),
                ),
              }
            : {}),
        },
      ],
    };
  }

  if (isAnchoredFaceTextureEffect(effect)) {
    if (!faceTextureAnchors) {
      return {
        placements: [],
        warning: "Face texture anchors are unavailable for anchored decals.",
      };
    }
    // Flipbook decals are sized from one frame, not the whole sheet.
    const imageSize = resolveArtFrameSize(image, effect.flipbook);
    const resolved = resolveAnchoredTexturePlacementInstances({
      effect,
      faceTextureAnchors,
      imageSize,
    });
    if (resolved.instances.length === 0) {
      return {
        placements: [],
        warning: resolved.warning,
        ...(resolved.skip ? { skip: resolved.skip } : {}),
      };
    }
    const clipPath = args.decalClip?.() ?? null;
    return {
      placements: resolved.instances.map((instance) => ({
        label: instance.label,
        mirrorX: instance.mirrorX,
        ...(instance.effectMirror ? { effectMirror: true } : {}),
        rect: toPixelFloatRect(size, instance.rect),
        ...(clipPath ? { clipPath } : {}),
      })),
    };
  }

  if (!isTextureVFXEntry(effect)) {
    return { placements: [] };
  }

  const faceRect = profile.faceLayout?.rect;
  if (!faceRect) return { placements: [] };
  const clipPath = args.faceClip?.() ?? null;
  if (!clipPath && args.faceClipRequired) {
    // Unclipped, the art would cover the body sharing the face's texture.
    return {
      placements: [],
      warning:
        "Whole-face art is not drawn: the face is the head of a mesh part that holds the whole body, and its outline on the texture could not be read.",
    };
  }
  return {
    placements: [
      {
        label: "face",
        mirrorX: false,
        rect: toPixelRect(size, faceRect),
        ...(clipPath ? { clipPath } : {}),
      },
    ],
  };
}

const DEFAULT_APPEARANCE: AvatarVFXAppearance = {
  opacity: 1,
  tint: null,
  blend: "normal",
};

function resolveAppearance(effect: AvatarVFXCatalogEntry): AvatarVFXAppearance {
  return effect.appearance ?? DEFAULT_APPEARANCE;
}

/** Appearance opacity × keyframe opacity × event envelope, clamped to 0–1. */
function resolveEffectiveOpacity(args: {
  effect: AvatarVFXCatalogEntry;
  animationState: AvatarVFXAnimationState;
  intensity: number;
}): number {
  const value =
    resolveAppearance(args.effect).opacity *
    args.animationState.opacity *
    args.intensity;
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

function compositeOperationForBlend(
  blend: AvatarVFXBlend,
): GlobalCompositeOperation {
  if (blend === "additive") return "lighter";
  if (blend === "multiply") return "multiply";
  return "source-over";
}

/** Multiply an image by a tint colour while keeping its alpha. */
function createTintedImage(
  image: CanvasImageSource,
  tint: string,
): HTMLCanvasElement | null {
  const size = getImageSize(image);
  if (!size) return null;
  let created: ReturnType<typeof createCanvas>;
  try {
    created = createCanvas(size.width, size.height);
  } catch {
    return null;
  }
  const { canvas, context } = created;
  context.drawImage(image, 0, 0, size.width, size.height);
  context.globalCompositeOperation = "multiply";
  context.fillStyle = tint;
  context.fillRect(0, 0, size.width, size.height);
  context.globalCompositeOperation = "destination-in";
  context.drawImage(image, 0, 0, size.width, size.height);
  return canvas;
}

/** Source rectangle of one flipbook frame, left to right then top to bottom. */
function resolveFlipbookSourceRect(
  image: CanvasImageSource,
  flipbook: AvatarVFXFlipbook | undefined,
  frame: number,
): { x: number; y: number; width: number; height: number } | null {
  const size = getImageSize(image);
  if (!size) return null;
  if (!flipbook) return { x: 0, y: 0, ...size };
  const columns = Math.max(1, flipbook.columns);
  const width = size.width / columns;
  const height = size.height / Math.max(1, flipbook.rows);
  return {
    x: (frame % columns) * width,
    y: Math.floor(frame / columns) * height,
    width,
    height,
  };
}

function applyHoverInstanceOpacity(
  instance: HoverPlaneInstanceState,
  opacity: number,
  baseOpacity: number,
): void {
  instance.material.opacity = baseOpacity * opacity;
  // The skin backdrop fades with its art so a fade never leaves a bare patch.
  if (instance.backdropMaterial) {
    instance.backdropMaterial.opacity =
      instance.backdropBaseOpacity * baseOpacity * opacity;
  }
}

function applyAnimationToHoverInstances(args: {
  instances: HoverPlaneInstanceState[];
  animationState: AvatarVFXAnimationState;
  effect: AvatarVFXCatalogEntry;
  intensity: number;
}) {
  const { instances, animationState } = args;
  const scale = Math.max(0.0001, animationState.scale);
  const opacity = animationState.opacity * args.intensity;
  const baseOpacity = resolveAppearance(args.effect).opacity;

  instances.forEach((instance) => {
    const mirrorSign = instance.mirrored ? -1 : 1;
    instance.animatedGroup.position.set(
      animationState.driftX * instance.planeWidth +
        animationState.offsetX * mirrorSign,
      animationState.driftY * instance.planeHeight + animationState.offsetY,
      0,
    );
    instance.animatedGroup.rotation.z = animationState.rotationRadians;
    instance.animatedGroup.scale.setScalar(scale);
    applyHoverInstanceOpacity(instance, opacity, baseOpacity);
    applyFlipbookFrameToTexture(
      instance.texture,
      args.effect.flipbook,
      animationState.frame,
    );
  });
}

function getTextureEffectKindOrder(effect: AvatarVFXCatalogEntry): number {
  return isAnchoredFaceTextureEffect(effect) ? 1 : 0;
}

/**
 * Draw one effect's placements onto a composite canvas. A placement with a
 * `clipPath` draws inside it only.
 */
function drawCompositedLayerCanvas(args: {
  context: CanvasContext;
  layerState: EffectLayerCanvasState;
  effect: AvatarVFXCatalogEntry;
  size: Size;
  animationState: AvatarVFXAnimationState;
  opacity: number;
  tinted: (image: CanvasImageSource) => CanvasImageSource;
}) {
  const { context, layerState, effect, size, animationState } = args;
  if (args.opacity <= 0) return;
  const appearance = resolveAppearance(effect);
  context.save();
  context.globalAlpha = args.opacity;
  context.globalCompositeOperation = compositeOperationForBlend(
    appearance.blend,
  );
  layerState.placements.forEach((placement) => {
    // The effect's mirrored copy draws its own art, unmirrored, when it has one.
    const useOtherImage =
      placement.effectMirror === true && layerState.otherImage !== null;
    const image = args.tinted(
      useOtherImage ? layerState.otherImage! : layerState.image,
    );
    const source = effect.flipbook
      ? resolveFlipbookSourceRect(
          useOtherImage ? layerState.otherImage! : layerState.image,
          effect.flipbook,
          animationState.frame,
        )
      : null;
    if (effect.flipbook && !source) return;
    // Unflipped, but still the mirrored copy: its offsets stay mirrored.
    const transform = resolveTexturePlacementTransform(
      useOtherImage ? { ...placement, mirrorX: false } : placement,
      effect,
      size,
      animationState,
    );

    context.save();
    if (placement.clip) {
      context.beginPath();
      context.rect(
        placement.clip.x,
        placement.clip.y,
        placement.clip.width,
        placement.clip.height,
      );
      context.clip();
    }
    if (placement.clipPath) context.clip(placement.clipPath);
    context.translate(transform.x, transform.y);
    // Texture decals rotate in their 2D surface; spin adds to the authored angle.
    context.rotate(transform.rotation);
    context.scale(transform.scaleX, transform.scaleY);
    if (source) {
      // Flipbooks draw one frame through a source rectangle.
      context.drawImage(
        image,
        source.x,
        source.y,
        source.width,
        source.height,
        -placement.rect.width * 0.5,
        -placement.rect.height * 0.5,
        placement.rect.width,
        placement.rect.height,
      );
    } else {
      context.drawImage(
        image,
        -placement.rect.width * 0.5,
        -placement.rect.height * 0.5,
        placement.rect.width,
        placement.rect.height,
      );
    }
    context.restore();
  });
  context.restore();
}

function getTextureSlotSnapshots(
  slots: BindingTextureState[],
): AvatarVFXTargetBindingTextureSlot[] {
  return slots.map((slot) => ({
    slot: slot.slot,
    width: slot.width,
    height: slot.height,
    sizeLabel: formatSizeLabel(slot.width, slot.height),
    canOverlay: slot.canOverlay,
  }));
}

/**
 * Where an eye's hover plane sits: part way from the eye toward the face's
 * front. An estimated eye's plane also stays at least
 * {@link EYE_HOVER_SURFACE_CLEARANCE} of the eye spacing in front of the face
 * surface measured over it (`surfaceFrontZLocal`), which a narrow face front
 * or a bulging eye shape can put in front of that point.
 */
function resolveEyeHoverPosition(
  eye: AvatarFaceEyeLandmarkSnapshot,
  surface: { frontSign: 1 | -1; spacing: number },
): THREE.Vector3 {
  const position = lerpVector3(
    toVector3(eye.centerLocal),
    toVector3(eye.projectedFrontLocal),
    EYE_HOVER_SURFACE_LERP,
  );
  // A converted MikuMikuDance model's closed lids and lashes may stand in
  // front of that point, so its plane also clears them.
  for (const front of [eye.surfaceFrontZLocal, eye.closedCover?.frontZLocal]) {
    if (front === undefined) continue;
    const clear =
      front + surface.frontSign * surface.spacing * EYE_HOVER_SURFACE_CLEARANCE;
    if ((clear - position.z) * surface.frontSign > 0) position.z = clear;
  }
  return position;
}

/** An eye landmark's closed cover as a box (see the snapshot field). */
function closedCoverBox(
  eye: AvatarFaceEyeLandmarkSnapshot,
): THREE.Box3 | undefined {
  const bounds = eye.closedCover?.boundsLocal;
  return bounds
    ? new THREE.Box3(toVector3(bounds.min), toVector3(bounds.max))
    : undefined;
}

/**
 * Eye hover planes' height: {@link EYE_HOVER_PLANE_HEIGHT}, grown for eyes
 * taller on average than {@link EYE_HOVER_REFERENCE_EYE_HEIGHT}.
 */
function resolveEyeHoverPlaneHeight(
  faceLandmarks: AvatarFaceLandmarksSnapshot,
): number {
  const heights = [faceLandmarks.eyes.left, faceLandmarks.eyes.right]
    .filter((eye) => eye !== null)
    .map((eye) => eye.boundsLocal.size.y);
  if (heights.length === 0) return EYE_HOVER_PLANE_HEIGHT;
  const mean =
    heights.reduce((sum, height) => sum + height, 0) / heights.length;
  return (
    EYE_HOVER_PLANE_HEIGHT * Math.max(1, mean / EYE_HOVER_REFERENCE_EYE_HEIGHT)
  );
}

function resolveMouthHoverPosition(args: {
  faceLandmarks: AvatarFaceLandmarksSnapshot;
  mouthAnchor: AvatarFaceTextureAnchorSnapshot;
}): THREE.Vector3 | null {
  const frontZ = args.faceLandmarks.frontZLocal;
  if (frontZ === null) {
    return null;
  }

  const localPoint = toVector3(args.mouthAnchor.localPoint);
  return lerpVector3(
    localPoint,
    new THREE.Vector3(localPoint.x, localPoint.y, frontZ),
    MOUTH_HOVER_SURFACE_LERP,
  );
}

function resolveAvatarLeftRightEdges(
  faceLandmarks: AvatarFaceLandmarksSnapshot,
): { leftX: number; rightX: number } | null {
  const faceBounds = faceLandmarks.faceBoundsLocal;
  const leftEye = faceLandmarks.eyes.left;
  if (!faceBounds || !leftEye) return null;

  const distanceToMin = Math.abs(
    leftEye.projectedFrontLocal.x - faceBounds.min.x,
  );
  const distanceToMax = Math.abs(
    leftEye.projectedFrontLocal.x - faceBounds.max.x,
  );
  if (distanceToMin <= distanceToMax) {
    return {
      leftX: faceBounds.min.x,
      rightX: faceBounds.max.x,
    };
  }
  return {
    leftX: faceBounds.max.x,
    rightX: faceBounds.min.x,
  };
}

/**
 * Where a box hover sits. Rows and columns follow the face's bounds and eyes;
 * the top-edge row sits on the face's top, and on a big-headed Avatar
 * ({@link headSized}) moves up to the top of the head, so head art clears a
 * head, hood or helmet that rises well above the face.
 */
function resolveBoxHoverPosition(args: {
  faceLandmarks: AvatarFaceLandmarksSnapshot;
  placement: AvatarVFXHoverPlacement;
  proportions: AvatarProportions;
}): THREE.Vector3 | null {
  const { faceLandmarks, placement, proportions } = args;
  const faceBounds = faceLandmarks.faceBoundsLocal;
  const leftEye = faceLandmarks.eyes.left;
  const rightEye = faceLandmarks.eyes.right;
  const frontZ = faceLandmarks.boxHoverFrontZLocal ?? faceLandmarks.frontZLocal;
  if (!faceBounds || !leftEye || !rightEye || frontZ === null) {
    return null;
  }

  const leftEyeSurface = toVector3(leftEye.projectedFrontLocal);
  const rightEyeSurface = toVector3(rightEye.projectedFrontLocal);
  const eyeMid = midpointVector3(leftEyeSurface, rightEyeSurface);
  const eyeLineY = eyeMid.y;
  const topY = faceBounds.max.y;
  const foreheadY = lerpNumber(eyeLineY, topY, 0.4);
  const topRowY = lerpNumber(eyeLineY, topY, 0.75);
  const headTopY = proportions.headBox?.max.y ?? topY;
  const topEdgeY = headSized(proportions, topY, Math.max(topY, headTopY));
  const edgeColumns = resolveAvatarLeftRightEdges(faceLandmarks);
  if (!edgeColumns) return null;

  const edgeX = (alpha: number) =>
    lerpNumber(edgeColumns.leftX, edgeColumns.rightX, alpha);

  switch (placement) {
    case "forehead-left":
      return new THREE.Vector3(leftEyeSurface.x, foreheadY, frontZ);
    case "forehead-middle":
      return new THREE.Vector3(eyeMid.x, foreheadY, frontZ);
    case "forehead-right":
      return new THREE.Vector3(rightEyeSurface.x, foreheadY, frontZ);
    case "top-left":
      return new THREE.Vector3(leftEyeSurface.x, topRowY, frontZ);
    case "top-middle":
      return new THREE.Vector3(eyeMid.x, topRowY, frontZ);
    case "top-right":
      return new THREE.Vector3(rightEyeSurface.x, topRowY, frontZ);
    case "top-edge-left-corner":
      return new THREE.Vector3(edgeColumns.leftX, topEdgeY, frontZ);
    case "top-edge-left":
      return new THREE.Vector3(edgeX(0.25), topEdgeY, frontZ);
    case "top-edge-middle":
      return new THREE.Vector3(edgeX(0.5), topEdgeY, frontZ);
    case "top-edge-right":
      return new THREE.Vector3(edgeX(0.75), topEdgeY, frontZ);
    case "top-edge-right-corner":
      return new THREE.Vector3(edgeColumns.rightX, topEdgeY, frontZ);
    default:
      return null;
  }
}

/**
 * Add an authored offset to a hover anchor point. Offsets are in the Avatar's
 * front frame (+x toward the viewer's right when facing the Avatar, +y up, +z
 * forward), the frame the plane itself faces; the head anchor keeps the
 * model's axes, so a −Z-facing (VRM 0) head flips x and z.
 */
function applyHoverPlacementOffset(
  position: THREE.Vector3,
  offset: AvatarVFXTransform["offset"],
  frontSign: 1 | -1,
): THREE.Vector3 {
  return position
    .clone()
    .add(
      new THREE.Vector3(frontSign * offset.x, offset.y, frontSign * offset.z),
    );
}

function resolveHoverPlacementInstances(args: {
  effect: AvatarHoverVFXEntry;
  faceLandmarks: AvatarFaceLandmarksSnapshot;
  faceTextureAnchors: AvatarFaceTextureAnchorsSnapshot | null;
  proportions: AvatarProportions;
}): HoverPlacementInstance[] | null {
  const { effect, faceLandmarks, faceTextureAnchors } = args;
  const frontSign = resolveHoverFrontSign(faceLandmarks);
  if (isEyeHoverVFXEntry(effect)) {
    const leftEye = faceLandmarks.eyes.left;
    const rightEye = faceLandmarks.eyes.right;
    if (!leftEye || !rightEye) return null;

    const surface = {
      frontSign,
      spacing: Math.abs(leftEye.centerLocal.x - rightEye.centerLocal.x),
    };
    const leftHover = resolveEyeHoverPosition(leftEye, surface);
    const rightHover = resolveEyeHoverPosition(rightEye, surface);
    const covers = {
      left: closedCoverBox(leftEye),
      right: closedCoverBox(rightEye),
    };
    const coverOf = (label: "left" | "right") =>
      covers[label] ? { closedCover: covers[label] } : {};
    const side = effect.side ?? "right";
    if (effect.requiresMirror) {
      const primaryPosition = side === "left" ? leftHover : rightHover;
      const oppositePosition = side === "left" ? rightHover : leftHover;
      const primaryLabel = side;
      const oppositeLabel = resolveOppositeSide(side);
      return [
        {
          label: primaryLabel,
          mirrored: false,
          ...coverOf(primaryLabel),
          position: applyHoverPlacementOffset(
            primaryPosition,
            effect.transform.offset,
            frontSign,
          ),
          referenceSizeLocal: null,
        },
        {
          label: oppositeLabel,
          mirrored: true,
          ...coverOf(oppositeLabel),
          // The mirrored eye mirrors its lateral offset (avatar-effect/2).
          position: applyHoverPlacementOffset(
            oppositePosition,
            { ...effect.transform.offset, x: -effect.transform.offset.x },
            frontSign,
          ),
          referenceSizeLocal: null,
        },
      ];
    }

    if (effect.side) {
      const singlePosition = side === "left" ? leftHover : rightHover;
      return [
        {
          label: side,
          mirrored: false,
          ...coverOf(side),
          position: applyHoverPlacementOffset(
            singlePosition,
            effect.transform.offset,
            frontSign,
          ),
          referenceSizeLocal: null,
        },
      ];
    }

    return [
      {
        label: "center",
        mirrored: false,
        ...(covers.left && covers.right
          ? { closedCover: covers.left.clone().union(covers.right) }
          : {}),
        position: applyHoverPlacementOffset(
          midpointVector3(leftHover, rightHover),
          effect.transform.offset,
          frontSign,
        ),
        referenceSizeLocal: null,
      },
    ];
  }

  if (isMouthHoverVFXEntry(effect)) {
    if (!faceTextureAnchors || faceTextureAnchors.status !== "ready") {
      return null;
    }
    const mouthAnchor = faceTextureAnchors.anchors.mouth.center;
    if (!mouthAnchor) {
      return null;
    }
    const position = resolveMouthHoverPosition({
      faceLandmarks,
      mouthAnchor,
    });
    if (!position) {
      return null;
    }
    return [
      {
        label: "mouth",
        mirrored: false,
        position: applyHoverPlacementOffset(
          position,
          effect.transform.offset,
          frontSign,
        ),
        referenceSizeLocal: mouthAnchor.referenceSizeLocal,
      },
    ];
  }

  if (isBoxHoverVFXEntry(effect)) {
    const position = resolveBoxHoverPosition({
      faceLandmarks,
      placement: effect.placement,
      proportions: args.proportions,
    });
    if (!position) return null;
    return [
      {
        label: effect.placement,
        mirrored: false,
        position: applyHoverPlacementOffset(
          position,
          effect.transform.offset,
          frontSign,
        ),
        referenceSizeLocal: null,
      },
    ];
  }

  return null;
}

/**
 * Which way the face looks along the head anchor's z axis: −1 when its front
 * is at the bounds' minimum z (VRM 0 normalized bones face −Z), +1 otherwise.
 */
function resolveHoverFrontSign(
  faceLandmarks: AvatarFaceLandmarksSnapshot,
): 1 | -1 {
  const faceBounds = faceLandmarks.faceBoundsLocal;
  const frontZ = faceLandmarks.frontZLocal;
  if (!faceBounds || frontZ === null) return 1;
  const distanceToMin = Math.abs(frontZ - faceBounds.min.z);
  const distanceToMax = Math.abs(frontZ - faceBounds.max.z);
  return distanceToMin <= distanceToMax ? -1 : 1;
}

/** The turn about y from the head anchor to the Avatar's front frame. */
function resolveHoverFacingRotationY(
  faceLandmarks: AvatarFaceLandmarksSnapshot,
): number {
  return resolveHoverFrontSign(faceLandmarks) < 0 ? Math.PI : 0;
}

/**
 * Whether hover art gets a skin backdrop: as the effect says, and by default
 * for eye art that closes the eyes of a converted MikuMikuDance model (eyes
 * with a closed cover), whose lids may be the lashes eye art hides.
 */
function hasHoverSkinBackdrop(
  effect: AvatarHoverVFXEntry,
  faceLandmarks: AvatarFaceLandmarksSnapshot | null,
): effect is AvatarEyeHoverVFXEntry | AvatarMouthHoverVFXEntry {
  if (isMouthHoverVFXEntry(effect)) return Boolean(effect.skinBackdrop);
  if (!isEyeHoverVFXEntry(effect)) return false;
  return (
    effect.skinBackdrop ??
    (shouldForceBlink(effect) &&
      Boolean(
        faceLandmarks?.eyes.left?.closedCover &&
        faceLandmarks.eyes.right?.closedCover,
      ))
  );
}

/**
 * Where a closed-eye skin patch goes, in anchor space: centred on its cover
 * and {@link CLOSED_EYE_PATCH_CLEARANCE} in front of the cover's front.
 */
function closedEyePatchCenter(
  cover: THREE.Box3,
  frontSign: 1 | -1,
): THREE.Vector3 {
  const center = cover.getCenter(new THREE.Vector3());
  center.z =
    (frontSign > 0 ? cover.max.z : cover.min.z) +
    frontSign * CLOSED_EYE_PATCH_CLEARANCE;
  return center;
}

/**
 * Put a closed-eye skin patch at `center` (anchor space) from a placement
 * root at `placementPosition` turned by `facingRotationY` about y (0 or pi).
 */
function placeCoverPatch(
  mesh: THREE.Mesh,
  center: THREE.Vector3,
  placementPosition: THREE.Vector3,
  facingRotationY: number,
): void {
  mesh.position
    .copy(center)
    .sub(placementPosition)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), -facingRotationY);
}

/**
 * Name guide instances in authoring terms, in the UI Locale; side labels
 * always use the avatar's perspective.
 */
function placementGuideLabel(
  effect: AvatarVFXCatalogEntry,
  label: string,
): string {
  if (isEyeHoverVFXEntry(effect)) return eyeGuideLabel(label);
  if (
    isMouthHoverVFXEntry(effect) ||
    (isFaceAnchoredVFXEntry(effect) && effect.anchor === "mouth")
  )
    return mouthGuideLabel();
  if (isFaceAnchoredVFXEntry(effect))
    return anchoredGuideLabel(
      effect.anchor === "undereye" ? "undereye" : "blush",
      effect.layout === "span" ? "span" : label,
    );
  if (isTextureVFXEntry(effect))
    return textureGuideLabel(effect.targetRole === "eye_iris", label);
  return boxGuideLabel(label);
}

/** An animation state that leaves the authored placement unchanged. */
const STILL_ANIMATION_STATE: AvatarVFXAnimationState = {
  scale: 1,
  rotationRadians: 0,
  driftX: 0,
  driftY: 0,
  offsetX: 0,
  offsetY: 0,
  opacity: 1,
  frame: 0,
};

/**
 * The authored corners of one hover plane: its placement, rotation and
 * scale, without its own motion, so handles hold still while the art moves.
 */
function hoverManipulationPlacement(
  instance: HoverPlaneInstanceState,
): AvatarVFXManipulationPlacement {
  instance.placementRoot.updateWorldMatrix(true, false);
  instance.staticGroup.updateMatrix();
  instance.mesh.updateMatrix();
  const matrix = instance.placementRoot.matrixWorld
    .clone()
    .multiply(instance.staticGroup.matrix)
    .multiply(instance.mesh.matrix);
  return quadManipulationPlacement({
    label: instance.label,
    mirrored: instance.mirrored,
    corners: planeImageCorners(instance.mesh.geometry, matrix),
    // The authored z turn moves +x toward +y (up), away from the image's y;
    // a flipped (mirrored) mesh reverses the image's x.
    rotationSense: instance.mesh.scale.x < 0 ? 1 : -1,
  });
}

export class AvatarVFXController {
  private readonly _avatar: Avatar;
  private readonly _sourceUrl: string | null;
  private readonly _sourceKey: string | null;
  private readonly _profile: AvatarVFXModelProfile;
  private readonly _catalogProvider: AnimaRuntimeMediaProvider;
  private readonly _catalog: readonly AvatarVFXCatalogEntry[];

  private _bindings = new Map<string, BindingState>();
  private _listeners = new Set<VFXListener>();
  private _warnings: string[] = [];
  private _issues: AvatarIssue[] = [];
  private readonly _regionHider = new PrimitiveRegionHider();
  /**
   * Every primitive by binding key, part or not: a part's regions may lie in a
   * primitive that holds no part of its own (a converted MikuMikuDance
   * model's lash mesh, shared with the brows or eyes).
   */
  private readonly _primitivesByKey = new Map<string, THREE.Mesh>();
  /** Bindings hidden for `Fcl_EYE_Iris_Hide`, or null while it is not held. */
  private _irisHideKeys: string[] | null = null;
  private _snapshot: AvatarVFXSnapshot;
  private _observationSnapshot: AvatarVFXObservationSnapshot;
  private _isDisposed = false;
  private _applyTokens = new Map<string, number>();
  private _nextAppliedOrder = 0;
  private _animationFrameAccumulatorSec = 0;
  private _flattenPreviewEyes = false;
  private _flattenPreviewMouth = false;
  private _cachedFaceFlattenState: ResolvedFaceFlattenState | null = null;
  /** Envelope values received while an effect's apply is still in flight. */
  private _pendingIntensities = new Map<string, number>();
  /** Effect and part pairs already reported as skipped, so each logs once. */
  private _reportedUnavailableParts = new Set<string>();
  /** Body, sticker and silhouette effects, which live outside face bindings. */
  private readonly _attachments: AvatarAttachmentEffects;
  /** Composites whose transform changed since their last redraw. */
  private _pendingTransformRedraws = new Set<BindingState>();
  private _lastTransformRedrawMs = -Infinity;
  /**
   * UV lookups per face mesh, built on first use for direct manipulation,
   * with the texture whose layout they follow.
   */
  private _uvLocators = new WeakMap<
    THREE.Mesh,
    { texture: THREE.Texture | null; locator: MeshUvLocator | null }
  >();
  /**
   * The primitives (binding keys) whose main material draws each texture
   * image (`Texture.source`), from the last binding rebuild.
   */
  private readonly _textureImageUsers = new Map<
    THREE.Source<unknown>,
    Set<string>
  >();
  /**
   * Whole-face clip paths per binding and slot, resolved on first use; a
   * binding rebuild makes new keys, which drops them.
   */
  private _faceSkinClips = new WeakMap<
    BindingState,
    Map<AvatarVFXTextureSlot, Path2D | null>
  >();

  constructor(
    avatar: Avatar,
    catalogProvider: AnimaRuntimeMediaProvider = EMPTY_RUNTIME_MEDIA_PROVIDER,
  ) {
    this._avatar = avatar;
    this._catalogProvider = catalogProvider;
    this._catalog = catalogProvider.listAvatarVFX();
    this._sourceUrl = avatar.sourceUrl;
    this._sourceKey = avatar.sourceKey;
    this._profile = resolveAvatarVFXModelProfile({
      sourceKey: this._sourceKey,
      sourceUrl: this._sourceUrl,
    });
    this._attachments = new AvatarAttachmentEffects(avatar, {
      // A face binding's material may be a composite clone this controller
      // owns and disposes; overlays read the binding's original instead.
      materialOf: (mesh) =>
        Array.from(this._bindings.values()).find(
          (binding) => binding.object === mesh,
        )?.originalMaterial ?? mesh.material,
    });
    this._rebuildBindings();
    this._snapshot = this._createSnapshot();
    this._observationSnapshot = this._createObservationSnapshot();
  }

  getSnapshot(): AvatarVFXSnapshot {
    return this._snapshot;
  }

  /** Return only the stable fields needed to observe active playback. */
  getObservationSnapshot(): AvatarVFXObservationSnapshot {
    return this._observationSnapshot;
  }

  /**
   * Read a creator's selected placement without applying effects or loading images.
   * Borrowed anchors/surfaces belong to the Avatar. Call while guides are visible;
   * artwork comes from the rendered mesh or the compositor's current animation state.
   */
  getPlacementGuides(
    effect: AvatarVFXCatalogEntry,
    appliedId: string,
  ): AvatarVFXPlacementGuides {
    const result: AvatarVFXPlacementGuides = {
      anchor: null,
      faceBounds: null,
      spatial: [],
      surfaces: [],
      messages: [],
      active: false,
    };
    if (this._isDisposed) return result;

    const landmarks = this._avatar.getFaceLandmarksSnapshot();
    const anchors = this._avatar.getFaceTextureAnchorsSnapshot();
    result.anchor = this._avatar.faceLandmarks?.getAnchorObject() ?? null;
    const activeBindings = Array.from(this._bindings.values()).filter(
      (binding) => binding.activeEffects.has(appliedId),
    );
    result.active = activeBindings.length > 0;
    const selected = activeBindings.length
      ? activeBindings
      : [this._resolveAutoBindingForEffect(effect)].filter(
          (binding): binding is BindingState => binding !== null,
        );
    if (!selected.length)
      result.messages.push(placementGuideMessage("noMaterialTarget"));
    else if (isTextureVFXEntry(effect)) {
      const targets = Array.from(
        new Set(
          selected.map(
            (binding) => binding.materialName ?? unnamedMaterialName(),
          ),
        ),
      );
      result.messages.push(materialTargetMessage(targets));
    }

    const referenceUv: AvatarVFXUvGuide[] = [];
    if (isHoverVFXEntry(effect)) {
      if (!result.anchor || landmarks?.status !== "ready") {
        result.messages.push(placementGuideMessage("landmarksUnavailable"));
      } else {
        const references = resolveHoverPlacementInstances({
          effect: {
            ...effect,
            transform: { ...effect.transform, offset: { x: 0, y: 0, z: 0 } },
          },
          faceLandmarks: landmarks,
          faceTextureAnchors: anchors,
          proportions: measureAvatarProportions(this._avatar.vrm),
        });
        if (!references?.length)
          result.messages.push(placementGuideMessage("hoverAnchorUnavailable"));
        if (isBoxHoverVFXEntry(effect))
          result.faceBounds = landmarks.faceBoundsLocal;
        result.anchor.updateWorldMatrix(true, false);
        const inverseAnchor = result.anchor.matrixWorld.clone().invert();
        for (const reference of references ?? []) {
          const instance = activeBindings
            .flatMap(
              (binding) =>
                binding.activeEffects.get(appliedId)?.hoverInstances ?? [],
            )
            .find((candidate) => candidate.label === reference.label);
          const artwork: AvatarFaceLandmarkVector[] = [];
          if (instance) {
            // Use the real mesh vertices through its authored, animated and facing transforms.
            instance.mesh.updateWorldMatrix(true, false);
            const matrix = inverseAnchor
              .clone()
              .multiply(instance.mesh.matrixWorld);
            const positions = instance.mesh.geometry.getAttribute("position");
            for (const index of [0, 1, 3, 2]) {
              const point = new THREE.Vector3()
                .fromBufferAttribute(positions, index)
                .applyMatrix4(matrix);
              artwork.push({ x: point.x, y: point.y, z: point.z });
            }
          }
          // Mouth placement adds hover clearance; retain the original anchor so
          // the reference-to-artwork connector also explains that depth.
          const referencePoint = isMouthHoverVFXEntry(effect)
            ? (anchors?.anchors.mouth.center?.localPoint ?? reference.position)
            : reference.position;
          result.spatial.push({
            label: placementGuideLabel(effect, reference.label),
            reference: {
              x: referencePoint.x,
              y: referencePoint.y,
              z: referencePoint.z,
            },
            source: isMouthHoverVFXEntry(effect)
              ? (anchors?.anchors.mouth.center?.source ?? "fallback")
              : "geometric",
            artwork,
          });
        }
      }
    } else if (isFaceAnchoredVFXEntry(effect)) {
      if (anchors?.status !== "ready") {
        result.messages.push(
          placementGuideMessage("textureAnchorsUnavailable"),
        );
      } else {
        const resolved = resolveAnchoredTexturePlacementInstances({
          effect,
          faceTextureAnchors: anchors,
          imageSize: null,
        });
        if (resolved.warning)
          result.messages.push(placementWarningMessage(resolved.warning));
        for (const placement of resolved.instances) {
          let reference: AvatarFaceTextureAnchorSnapshot | null;
          if (effect.anchor === "mouth") {
            reference = anchors.anchors.mouth.center;
          } else if (effect.layout === "span") {
            const left = getBilateralTextureAnchor(
              anchors,
              effect.anchor,
              "left",
            );
            const right = getBilateralTextureAnchor(
              anchors,
              effect.anchor,
              "right",
            );
            reference =
              left && right
                ? {
                    ...left,
                    side: null,
                    source:
                      left.source === "fallback" || right.source === "fallback"
                        ? "fallback"
                        : left.source,
                    localPoint: {
                      x: (left.localPoint.x + right.localPoint.x) / 2,
                      y: (left.localPoint.y + right.localPoint.y) / 2,
                      z: (left.localPoint.z + right.localPoint.z) / 2,
                    },
                    uv: {
                      u: (left.uv.u + right.uv.u) / 2,
                      v: (left.uv.v + right.uv.v) / 2,
                    },
                    referenceSizeUv: {
                      width:
                        Math.abs(left.uv.u - right.uv.u) +
                        (left.referenceSizeUv.width +
                          right.referenceSizeUv.width) /
                          2,
                      height: Math.max(
                        left.referenceSizeUv.height,
                        right.referenceSizeUv.height,
                      ),
                    },
                  }
                : null;
          } else {
            reference = getBilateralTextureAnchor(
              anchors,
              effect.anchor,
              placement.label as AvatarVFXSide,
            );
          }
          if (!reference) continue;
          result.spatial.push({
            label: placementGuideLabel(effect, placement.label),
            reference: reference.localPoint,
            source: reference.source,
            artwork: [],
          });
          referenceUv.push({
            label: placementGuideLabel(effect, placement.label),
            kind: "reference",
            shape: "polygon",
            source: reference.source,
            pivot: { x: reference.uv.u, y: reference.uv.v },
            points: rectangleGuidePoints({
              x: reference.uv.u - reference.referenceSizeUv.width / 2,
              y: reference.uv.v - reference.referenceSizeUv.height / 2,
              ...reference.referenceSizeUv,
            }),
          });
        }
      }
    }

    if (result.spatial.some((reference) => reference.source === "fallback")) {
      result.messages.push(placementGuideMessage("estimatedAnchor"));
    }
    if (result.spatial.length && !result.anchor) {
      result.messages.push(placementGuideMessage("liveAnchorUnavailable"));
    }
    if (isBoxHoverVFXEntry(effect)) return result;

    // Hover artwork lives in 3D; only its related face-flatten coverage has a UV view.
    const uvBindings = isHoverVFXEntry(effect)
      ? [this._resolveFaceFlattenBinding()].filter(
          (binding): binding is BindingState => binding !== null,
        )
      : selected;
    for (const binding of uvBindings) {
      const active = binding.activeEffects.get(appliedId);
      for (const slot of binding.textureSlots) {
        const composite = binding.textureComposite?.slotStates.get(slot.slot);
        const surface =
          composite?.canvas ?? getTextureImageSource(slot.texture);
        if (!surface) continue;
        const guides = [...referenceUv];
        if (active) {
          const layer = active.layerCanvases.get(slot.slot);
          for (const placement of layer?.placements ?? []) {
            const transform = resolveTexturePlacementTransform(
              placement,
              active.effectEntry,
              slot,
              active.animationState,
            );
            const width = placement.rect.width;
            const height = placement.rect.height;
            const pivot = isFaceAnchoredVFXEntry(active.effectEntry)
              ? resolvePivotFactors(active.effectEntry.pivot)
              : { x: 0.5, y: 0.5 };
            guides.push({
              label: placementGuideLabel(active.effectEntry, placement.label),
              kind: "artwork",
              shape: "polygon",
              points: rectangleGuidePoints({
                x: -width / 2,
                y: -height / 2,
                width,
                height,
              }).map((point) =>
                transformTexturePlacementPoint(point, transform, slot),
              ),
              pivot: transformTexturePlacementPoint(
                { x: (pivot.x - 0.5) * width, y: (pivot.y - 0.5) * height },
                transform,
                slot,
              ),
            });
          }
        }
        if (isTextureVFXEntry(effect)) {
          const references = resolveTextureEffectPlacements({
            image: surface,
            effect,
            size: slot,
            profile: this._placementProfile(),
            faceTextureAnchors: anchors,
          });
          for (const placement of references.placements) {
            guides.push({
              label: placementGuideLabel(effect, placement.label),
              kind: "reference",
              shape: "polygon",
              points: rectangleGuidePoints(placement.rect).map((point) => ({
                x: point.x / slot.width,
                y: point.y / slot.height,
              })),
            });
          }
        }

        const flatten = this._cachedFaceFlattenState;
        const hasFlatten =
          flatten?.faceBindingKey === binding.bindingKey &&
          Boolean(flatten.sampledColorsBySlot[slot.slot]) &&
          result.active;
        const regions: AvatarFaceTextureFlattenRegionSnapshot[] = [];
        if (
          hasFlatten &&
          isEyeHoverVFXEntry(effect) &&
          flatten.shouldRenderEyes
        ) {
          regions.push(...flatten.eyeRegions);
        }
        if (
          hasFlatten &&
          (isMouthHoverVFXEntry(effect) ||
            (isFaceAnchoredVFXEntry(effect) && effect.anchor === "mouth")) &&
          flatten.shouldRenderMouth &&
          flatten.mouthRegion
        ) {
          regions.push(flatten.mouthRegion);
        }
        if (regions.length && anchors?.flatten.sample.center)
          regions.push(anchors.flatten.sample.center);
        for (const region of regions) {
          guides.push({
            label: flattenGuideLabel(region.region, region.side),
            kind: region.region === "sample" ? "sample" : "flatten",
            shape: region.region === "sample" ? "polygon" : "ellipse",
            source: region.source,
            points: rectangleGuidePoints({
              x: region.uv.u - region.referenceSizeUv.width / 2,
              y: region.uv.v - region.referenceSizeUv.height / 2,
              ...region.referenceSizeUv,
            }),
          });
        }
        if (isHoverVFXEntry(effect) && !guides.length) continue;
        result.surfaces.push({
          key: `${binding.bindingKey}:${slot.slot}`,
          materialName: binding.materialName ?? unnamedMaterialName(),
          slot: slot.slot,
          image: surface,
          width: slot.width,
          height: slot.height,
          guides,
        });
      }
    }
    result.surfaces.sort(
      (a, b) => Number(b.slot === "map") - Number(a.slot === "map"),
    );
    if (
      result.surfaces.some((surface) =>
        surface.guides.some(
          (guide) =>
            (guide.kind === "flatten" || guide.kind === "sample") &&
            guide.source === "fallback",
        ),
      )
    ) {
      result.messages.push(placementGuideMessage("estimatedFlatten"));
    }
    if (!isHoverVFXEntry(effect) && !result.surfaces.length)
      result.messages.push(placementGuideMessage("noTextureSurface"));
    return result;
  }

  setFaceFlattenPreview(args: {
    previewEyes?: boolean;
    previewMouth?: boolean;
  }): void {
    if (this._isDisposed) return;

    let didChange = false;
    if (
      typeof args.previewEyes === "boolean" &&
      args.previewEyes !== this._flattenPreviewEyes
    ) {
      this._flattenPreviewEyes = args.previewEyes;
      didChange = true;
    }
    if (
      typeof args.previewMouth === "boolean" &&
      args.previewMouth !== this._flattenPreviewMouth
    ) {
      this._flattenPreviewMouth = args.previewMouth;
      didChange = true;
    }
    if (!didChange) {
      return;
    }

    this._cachedFaceFlattenState = null;
    this._refreshFaceFlattenComposite();
    this._emit();
  }

  subscribe(listener: VFXListener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /**
   * Run one apply and drop an envelope value held for it when the apply fails,
   * unless a newer apply or removal of the same ID has taken over.
   */
  private async _applyTracked(
    appliedEffectId: string,
    run: () => Promise<void>,
  ): Promise<void> {
    const before = this._applyTokens.get(appliedEffectId) ?? 0;
    try {
      await run();
    } finally {
      const after = this._applyTokens.get(appliedEffectId) ?? 0;
      if (after <= before + 1 && !this._isApplied(appliedEffectId)) {
        this._pendingIntensities.delete(appliedEffectId);
      }
    }
  }

  async applyHoverVFX(args: {
    effectId: string;
    effectEntry?: AvatarHoverVFXEntry;
    logicalEffectId?: string;
  }): Promise<void> {
    await this._applyTracked(args.effectId, () => this._applyHoverVFXNow(args));
  }

  private async _applyHoverVFXNow(args: {
    effectId: string;
    effectEntry?: AvatarHoverVFXEntry;
    logicalEffectId?: string;
  }): Promise<void> {
    const effect = this._resolveEffectSource(args.effectId, args.effectEntry);
    if (!effect) {
      this._pushWarning(
        { code: "effect_unknown", params: { effectId: args.effectId } },
        `Unknown VFX effect "${args.effectId}".`,
      );
      return;
    }
    if (!isHoverVFXEntry(effect)) {
      this._pushWarning(
        { code: "effect_wrong_kind", params: { effectId: effect.id } },
        `Effect "${effect.label}" is not a hover VFX.`,
      );
      return;
    }
    await this._applyHoverEffect(effect, undefined, args.logicalEffectId);
  }

  async applyFaceAnchoredVFX(args: {
    effectId: string;
    effectEntry?: AvatarFaceAnchoredVFXEntry;
    logicalEffectId?: string;
  }): Promise<void> {
    await this._applyTracked(args.effectId, () =>
      this._applyFaceAnchoredVFXNow(args),
    );
  }

  private async _applyFaceAnchoredVFXNow(args: {
    effectId: string;
    effectEntry?: AvatarFaceAnchoredVFXEntry;
    logicalEffectId?: string;
  }): Promise<void> {
    const effect = this._resolveEffectSource(args.effectId, args.effectEntry);
    if (!effect) {
      this._pushWarning(
        { code: "effect_unknown", params: { effectId: args.effectId } },
        `Unknown VFX effect "${args.effectId}".`,
      );
      return;
    }
    if (!isFaceAnchoredVFXEntry(effect)) {
      this._pushWarning(
        { code: "effect_wrong_kind", params: { effectId: effect.id } },
        `Effect "${effect.label}" is not a face-anchored VFX.`,
      );
      return;
    }
    await this._applyFaceAnchoredEffect(
      effect,
      undefined,
      args.logicalEffectId,
    );
  }

  async applyTextureVFX(args: {
    effectId: string;
    applyMode?: AvatarVFXApplyMode;
    effectEntry?: AvatarTextureVFXEntry;
    logicalEffectId?: string;
  }): Promise<void> {
    await this._applyTracked(args.effectId, () =>
      this._applyTextureVFXNow(args),
    );
  }

  private async _applyTextureVFXNow(args: {
    effectId: string;
    applyMode?: AvatarVFXApplyMode;
    effectEntry?: AvatarTextureVFXEntry;
    logicalEffectId?: string;
  }): Promise<void> {
    const effect = this._resolveEffectSource(args.effectId, args.effectEntry);
    if (!effect) {
      this._pushWarning(
        { code: "effect_unknown", params: { effectId: args.effectId } },
        `Unknown VFX effect "${args.effectId}".`,
      );
      return;
    }
    if (!isTextureVFXEntry(effect)) {
      this._pushWarning(
        { code: "effect_wrong_kind", params: { effectId: effect.id } },
        `Effect "${effect.label}" is not a texture VFX.`,
      );
      return;
    }
    await this._applyTextureEffect(
      effect,
      args.applyMode,
      undefined,
      args.logicalEffectId,
    );
  }

  async applyEffect(args: {
    bindingKey: string;
    effectId: string;
    applyMode?: AvatarVFXApplyMode;
    effectEntry?: AvatarVFXCatalogEntry;
    logicalEffectId?: string;
  }): Promise<void> {
    await this._applyTracked(args.effectId, () => this._applyEffectNow(args));
  }

  private async _applyEffectNow(args: {
    bindingKey: string;
    effectId: string;
    applyMode?: AvatarVFXApplyMode;
    effectEntry?: AvatarVFXCatalogEntry;
    logicalEffectId?: string;
  }): Promise<void> {
    const effectSource = this._resolveEffectSource(
      args.effectId,
      args.effectEntry,
    );
    if (!effectSource) {
      this._pushWarning(
        { code: "effect_unknown", params: { effectId: args.effectId } },
        `Unknown VFX effect "${args.effectId}".`,
      );
      return;
    }
    const binding = this._bindings.get(args.bindingKey);
    if (!binding) {
      this._pushWarning(
        { code: "effect_target_unknown", params: { effectId: args.effectId } },
        `Unknown VFX target "${args.bindingKey}".`,
      );
      return;
    }

    const effect = cloneCatalogEffectEntry({
      ...effectSource,
      id: args.effectId,
    });

    if (isHoverVFXEntry(effect)) {
      await this._applyHoverEffect(effect, binding, args.logicalEffectId);
      return;
    }
    if (isFaceAnchoredVFXEntry(effect)) {
      await this._applyFaceAnchoredEffect(
        effect,
        binding,
        args.logicalEffectId,
      );
      return;
    }
    await this._applyTextureEffect(
      effect,
      args.applyMode,
      binding,
      args.logicalEffectId,
    );
  }

  /**
   * Apply a body, sticker or silhouette effect. These coexist with face
   * effects and with each other; beyond {@link MAX_ACTIVE_ATTACHMENT_EFFECTS}
   * the oldest is removed with a diagnostic. Re-applying an ID replaces it.
   */
  async applyAttachmentVFX(args: {
    effectId: string;
    effectEntry: AvatarVFXAttachmentEntry;
    logicalEffectId?: string;
  }): Promise<void> {
    await this._applyTracked(args.effectId, () =>
      this._applyAttachmentNow(args),
    );
  }

  private async _applyAttachmentNow(args: {
    effectId: string;
    effectEntry: AvatarVFXAttachmentEntry;
    logicalEffectId?: string;
  }): Promise<void> {
    if (this._isDisposed) return;
    const appliedEffectId = args.effectId;
    const entry = args.effectEntry;
    const token = (this._applyTokens.get(appliedEffectId) ?? 0) + 1;
    this._applyTokens.set(appliedEffectId, token);

    let art: CanvasImageSource;
    try {
      art = await loadEffectImage(entry.assetPath);
    } catch (error) {
      if (this._applyTokens.get(appliedEffectId) !== token) return;
      this._pushWarning(
        {
          code: "effect_load_failed",
          params: { effectId: args.logicalEffectId ?? entry.id },
        },
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    if (this._isDisposed || this._applyTokens.get(appliedEffectId) !== token) {
      return;
    }

    const result = this._attachments.apply({
      appliedEffectId,
      effectId: args.logicalEffectId ?? entry.id,
      entry,
      art,
      intensity: this._takePendingIntensity(appliedEffectId),
    });
    if (!result.ok) {
      this._pushWarning(
        {
          code: "effect_placement_failed",
          params: { effectId: args.logicalEffectId ?? entry.id },
        },
        result.warning,
      );
      return;
    }
    // A face effect applied earlier under the same ID gives way, as a
    // re-apply of any effect does, once its replacement exists.
    this._removeAppliedEffect(appliedEffectId, { emit: false });
    for (const evicted of result.evicted) {
      // Its owner (a clip, a preview) may still remove it later; that is a no-op.
      this._pendingIntensities.delete(evicted.appliedEffectId);
      logger.warn(
        "Attachments",
        "Removed the oldest body, sticker or silhouette effect",
        {
          code: "avatar_effect_attachment_limit",
          limit: MAX_ACTIVE_ATTACHMENT_EFFECTS,
          removedEffectId: evicted.effectId,
          appliedEffectId: evicted.appliedEffectId,
          addedEffectId: args.logicalEffectId ?? entry.id,
        },
      );
      this._pushWarning(
        {
          code: "effect_attachment_limit",
          params: {
            effectId: evicted.effectId,
            limit: MAX_ACTIVE_ATTACHMENT_EFFECTS,
          },
        },
        `Removed "${evicted.effectLabel}": at most ${MAX_ACTIVE_ATTACHMENT_EFFECTS} body, sticker or silhouette effects can be active.`,
      );
    }
    this._emit();
  }

  /**
   * The face part this Avatar lacks for an effect, or null. Only an Avatar
   * with a detected part map is checked.
   */
  findUnavailableFacePart(
    effect: AvatarVFXParsedEntry,
  ): AvatarFacePartRole | null {
    const map = this._avatar.facePartMap ?? null;
    return map ? findMissingFacePart(map, effect) : null;
  }

  /**
   * Record an effect skipped for a missing face part: a structured warning
   * logged once per effect and part, kept in the snapshot for the debug panel.
   */
  reportUnavailableFacePart(
    effect: AvatarVFXParsedEntry,
    part: AvatarFacePartRole,
    logicalEffectId: string = effect.id,
  ): void {
    if (this._isDisposed) return;
    const key = `${logicalEffectId}:${part}`;
    if (this._reportedUnavailableParts.has(key)) return;
    this._reportedUnavailableParts.add(key);
    logger.warn("FaceParts", "Skipped an Avatar Effect without its face part", {
      code: "avatar_effect_face_part_unavailable",
      effectId: logicalEffectId,
      label: effect.label,
      part,
      avatar: this._sourceKey,
    });
    // An estimated eye is found, but has no iris mesh to paint.
    const estimated =
      this._avatar.facePartMap?.parts[part].source === "estimated";
    this._pushWarning(
      {
        code: estimated
          ? "effect_iris_mesh_missing"
          : "effect_face_part_missing",
        params: { effectId: logicalEffectId, part },
      },
      estimated
        ? `Skipped "${effect.label}": this avatar's ${AVATAR_FACE_PART_LABELS[part]} has no iris mesh.`
        : `Skipped "${effect.label}": this avatar has no detected ${AVATAR_FACE_PART_LABELS[part]}.`,
    );
  }

  /**
   * The profile texture placements use: its iris rectangles follow this
   * Avatar's eye landmarks when the iris texture is not laid out like VRoid's.
   */
  private _placementProfile(): AvatarVFXModelProfile {
    const eyeLayout = this._profile.eyeLayout;
    const eyes = this._avatar.getFaceLandmarksSnapshot()?.eyes;
    if (!eyeLayout || !eyes) return this._profile;
    const resolved = resolveIrisEyeLayout(eyeLayout, eyes);
    return resolved === eyeLayout
      ? this._profile
      : { ...this._profile, eyeLayout: resolved };
  }

  /**
   * The path whole-face art on a face skin slot is clipped to, in its
   * pixels; null where it covers the whole texture as before. The clip holds
   * every face skin primitive's own triangles on that image (see
   * `collectFaceSkinClipTriangles`), and is made only where it removes
   * something: another primitive's material also draws the image (an atlas),
   * or the face skin primitives drawing it hold triangles outside the face
   * (an inner mouth, eyes, the neck, lash regions). Resolved once per binding
   * and slot.
   */
  private _faceSkinClip(
    binding: BindingState,
    slot: BindingTextureState,
  ): Path2D | null {
    let bySlot = this._faceSkinClips.get(binding);
    if (!bySlot) {
      bySlot = new Map();
      this._faceSkinClips.set(binding, bySlot);
    }
    const cached = bySlot.get(slot.slot);
    if (cached !== undefined) return cached;
    const clip = this._resolveFaceSkinClip(binding, slot);
    bySlot.set(slot.slot, clip);
    return clip;
  }

  /**
   * The face skin's clip for decals and eye and mouth cleanup on a face that
   * is the head region of a primitive holding the whole body: the body shares
   * its texture, so art reaching past the face's island would paint it. Null
   * on other faces, where they draw unclipped.
   */
  private _faceRegionClip(
    binding: BindingState,
    slot: BindingTextureState,
  ): Path2D | null {
    return this._faceIsHeadRegion(binding)
      ? this._faceSkinClip(binding, slot)
      : null;
  }

  /**
   * Whether `binding` is face skin only as its head region: its primitive
   * holds the whole body (`findFaceSkinRegion`).
   */
  private _faceIsHeadRegion(binding: BindingState): boolean {
    return (
      findFaceSkinRegion(this._avatar.facePartMap, binding.bindingKey) !== null
    );
  }

  private _resolveFaceSkinClip(
    binding: BindingState,
    slot: BindingTextureState,
  ): Path2D | null {
    const vrm = this._avatar.vrm;
    const image = slot.texture.source;
    if (!vrm || !binding.targetRoles.includes("face_skin")) return null;
    const faces = Array.from(this._bindings.values()).filter((face) =>
      face.targetRoles.includes("face_skin"),
    );
    // Eye-line and lash regions inside a face primitive are never face skin.
    const regions = new Map<string, Set<number>>();
    const map = this._avatar.facePartMap;
    for (const role of DETAIL_REGION_ROLES) {
      for (const region of map?.parts[role].regions ?? []) {
        const triangles = regions.get(region.bindingKey) ?? new Set<number>();
        region.triangles.forEach((triangle) => triangles.add(triangle));
        regions.set(region.bindingKey, triangles);
      }
    }
    const sources: FaceSkinClipSource[] = faces.flatMap((face) => {
      const texture = face.textureSlots.find(
        (candidate) => candidate.texture.source === image,
      )?.texture;
      const headRegion = findFaceSkinRegion(map, face.bindingKey);
      return texture
        ? [
            {
              entry: face.entry,
              texture,
              keepVertex: headRegion
                ? null
                : createFaceVertexFilter(vrm, face.object),
              regions: regions.get(face.bindingKey) ?? new Set<number>(),
              headRegion: headRegion ? new Set(headRegion.triangles) : null,
            },
          ]
        : [];
    });
    const faceKeys = new Set(faces.map((face) => face.bindingKey));
    const shared = Array.from(this._textureImageUsers.get(image) ?? []).some(
      (key) => !faceKeys.has(key),
    );
    // Measured as drawn without effects: an effect hiding face skin collapses
    // its triangles in place, and the clip outlives that effect.
    const { triangles, complete } = this._regionHider.withRegionsShown(() =>
      collectFaceSkinClipTriangles({
        avatar: this._avatar,
        anchorObject: this._avatar.faceLandmarks?.getAnchorObject() ?? null,
        landmarks: this._avatar.getFaceLandmarksSnapshot(),
        sources,
      }),
    );
    if (!shared && complete) return null;
    // No triangle left to draw through counts as unreadable: unclipped as
    // before, or, on a face inside a whole-body primitive, not drawn.
    const dilated = dilateClipTriangles(triangles, slot);
    return dilated.length > 0 ? createClipPath(dilated) : null;
  }

  /**
   * Rebuild bindings after the Avatar's face parts change (a correction), then
   * re-apply active effects in their original order with their intensities.
   * An effect whose part is now unavailable is skipped and reported.
   */
  async refreshFaceParts(): Promise<void> {
    if (this._isDisposed) return;
    const active = new Map<string, ActiveBindingEffect>();
    for (const binding of this._bindings.values()) {
      for (const effect of binding.activeEffects.values()) {
        if (!active.has(effect.appliedEffectId)) {
          active.set(effect.appliedEffectId, effect);
        }
      }
    }
    const ordered = Array.from(active.values()).sort(
      (left, right) => left.appliedOrder - right.appliedOrder,
    );
    // A removal or newer apply during the awaited loop below bumps the token;
    // that effect is then left to its new owner instead of being restored.
    const tokens = new Map(
      ordered.map((effect) => [
        effect.appliedEffectId,
        this._applyTokens.get(effect.appliedEffectId) ?? 0,
      ]),
    );
    // Shown again before the bindings are rebuilt, then hidden again on them.
    const irisHidden = this._irisHideKeys !== null;
    this.setIrisHidden(false);
    // Body, sticker and silhouette effects use no face part and stay as they are.
    this._clearFaceEffects();
    this._bindings.forEach((binding) => {
      this._disposeTextureCompositeState(binding);
    });
    this._reportedUnavailableParts.clear();
    this._pendingTransformRedraws.clear();
    this._warnings = [];
    this._issues = [];
    this._rebuildBindings();
    if (irisHidden) this.setIrisHidden(true);
    this._emit();

    for (const effect of ordered) {
      if (this._isDisposed) return;
      if (
        (this._applyTokens.get(effect.appliedEffectId) ?? 0) !==
        tokens.get(effect.appliedEffectId)
      ) {
        continue;
      }
      const entry = effect.effectEntry;
      const part = this.findUnavailableFacePart(entry);
      if (part) {
        this.reportUnavailableFacePart(entry, part, effect.effectId);
        continue;
      }
      if (effect.intensity !== 1) {
        this._pendingIntensities.set(effect.appliedEffectId, effect.intensity);
      }
      await this._applyTracked(effect.appliedEffectId, () =>
        this._applyAutoResolvedEffect(entry, effect.applyMode, effect.effectId),
      );
    }
  }

  /**
   * Set an applied effect's event envelope (0–1), which multiplies its
   * opacity. A value for an effect that is still loading is held and used when
   * the apply finishes. Composite effects redraw on the next animation tick.
   */
  setEffectIntensity(appliedEffectId: string, value: number): void {
    if (this._isDisposed) return;
    const intensity = Number.isFinite(value)
      ? Math.min(1, Math.max(0, value))
      : 1;
    if (this._attachments.setIntensity(appliedEffectId, intensity)) return;
    for (const binding of this._bindings.values()) {
      const active = binding.activeEffects.get(appliedEffectId);
      if (!active) continue;
      if (active.intensity === intensity) return;
      const previousIntensity = active.intensity;
      active.intensity = intensity;
      this._syncEffectFaceChanges(binding, active, previousIntensity);
      if (active.renderMode === "hover_plane") {
        applyAnimationToHoverInstances({
          instances: active.hoverInstances,
          animationState: active.animationState,
          effect: active.effectEntry,
          intensity,
        });
        return;
      }
      // A fading composite joins the animated layers so each tick redraws it;
      // at a steady full intensity it returns to the static cache.
      const animated = active.hasOwnMotion || intensity !== 1;
      if (active.isAnimated !== animated) {
        active.isAnimated = animated;
        this._markTextureCompositeStaticDirty(binding);
        this._redrawBindingTextureComposite(binding);
      }
      return;
    }
    this._pendingIntensities.set(appliedEffectId, intensity);
  }

  /**
   * Change an applied effect's placement in place: the art is not reloaded,
   * and its motion clock, fade and material stay. Hover, body and sticker
   * planes move immediately; a composite redraws at most at 30 FPS, the rest
   * on the next {@link update} tick. Returns false when the effect is not
   * applied or the transform is for another attachment.
   */
  updateEffectTransform(
    appliedEffectId: string,
    transform: AvatarVFXEffectTransform,
  ): boolean {
    if (this._isDisposed) return false;
    if (transform.kind !== "face") {
      return this._attachments.updateTransform(appliedEffectId, transform);
    }
    let updated = false;
    for (const binding of this._bindings.values()) {
      const active = binding.activeEffects.get(appliedEffectId);
      if (!active) continue;
      const effect = {
        ...active.effectEntry,
        transform: cloneEffectTransform(transform.transform),
      } as AvatarVFXCatalogEntry;
      if (active.renderMode === "hover_plane") {
        if (
          !isHoverVFXEntry(effect) ||
          !this._updateHoverTransform(active, effect)
        )
          continue;
        active.effectEntry = effect;
        applyAnimationToHoverInstances({
          instances: active.hoverInstances,
          animationState: active.animationState,
          effect,
          intensity: active.intensity,
        });
        updated = true;
        continue;
      }
      const anchors = isAnchoredFaceTextureEffect(effect)
        ? this._avatar.getFaceTextureAnchorsSnapshot()
        : null;
      // Anchored decals bake offset and scale into their placement rectangles.
      for (const layer of active.layerCanvases.values()) {
        const slot = binding.textureSlots.find(
          (candidate) => candidate.slot === layer.slot,
        );
        const resolved = resolveTextureEffectPlacements({
          image: layer.image,
          effect,
          size: layer,
          profile: this._placementProfile(),
          faceTextureAnchors: anchors,
          faceClip: () => (slot ? this._faceSkinClip(binding, slot) : null),
          faceClipRequired: this._faceIsHeadRegion(binding),
          decalClip: () => (slot ? this._faceRegionClip(binding, slot) : null),
        });
        if (resolved.placements.length) layer.placements = resolved.placements;
      }
      active.effectEntry = effect;
      this._markTextureCompositeStaticDirty(binding);
      this._redrawTransformedComposite(binding);
      updated = true;
    }
    return updated;
  }

  /**
   * Where an applied effect's art is drawn for `camera`, for creator handles
   * and dragging. Null for silhouettes and effects that are not applied.
   */
  getManipulationFrame(
    appliedEffectId: string,
    camera: THREE.Camera,
  ): AvatarVFXManipulationFrame | null {
    if (this._isDisposed) return null;
    const attachment = this._attachments.manipulationFrame(
      appliedEffectId,
      camera,
    );
    if (attachment) return attachment;
    for (const binding of this._bindings.values()) {
      const active = binding.activeEffects.get(appliedEffectId);
      if (!active) continue;
      if (active.renderMode === "hover_plane") {
        const anchor = this._avatar.faceLandmarks?.getAnchorObject() ?? null;
        const faceLandmarks = this._avatar.getFaceLandmarksSnapshot();
        if (!anchor || faceLandmarks?.status !== "ready") return null;
        anchor.updateWorldMatrix(true, false);
        return {
          attachment: "face_landmark",
          placements: active.hoverInstances.map((instance) =>
            hoverManipulationPlacement(instance),
          ),
          // Offsets are in the Avatar's front frame, not the head's model axes.
          offsetSpace: anchor.matrixWorld
            .clone()
            .multiply(
              new THREE.Matrix4().makeRotationY(
                resolveHoverFacingRotationY(faceLandmarks),
              ),
            ),
          surface: null,
          unitLength: null,
        };
      }
      return {
        attachment: "face_surface",
        placements: this._surfaceManipulationPlacements(binding, active),
        offsetSpace: null,
        surface: binding.object,
        unitLength: null,
      };
    }
    return null;
  }

  removeEffect(appliedEffectId: string): void {
    if (this._isDisposed) return;
    this._pendingIntensities.delete(appliedEffectId);
    // Invalidate an in-flight image load as well as any already-applied layer.
    this._applyTokens.set(
      appliedEffectId,
      (this._applyTokens.get(appliedEffectId) ?? 0) + 1,
    );
    if (this._attachments.remove(appliedEffectId)) {
      this._emit();
      return;
    }
    this._removeAppliedEffect(appliedEffectId);
  }

  clearAllEffects(): void {
    if (this._isDisposed) return;
    this._attachments.clear();
    this._clearFaceEffects();
  }

  /** Remove every face effect, restoring bindings; attachments stay. */
  private _clearFaceEffects(): void {
    this._bindings.forEach((binding) => {
      this._restoreBinding(binding);
    });
    this._syncForcedBlinkExpression();
    this._emit();
  }

  /** Whether an applied ID is active as a face or attachment effect. */
  private _isApplied(appliedEffectId: string): boolean {
    return (
      this._attachments.has(appliedEffectId) ||
      Array.from(this._bindings.values()).some((binding) =>
        binding.activeEffects.has(appliedEffectId),
      )
    );
  }

  update(delta: number): void {
    if (this._isDisposed || !Number.isFinite(delta) || delta <= 0) return;

    this._animationFrameAccumulatorSec += delta;
    const shouldAdvanceAnimationFrame =
      this._animationFrameAccumulatorSec >= VFX_ANIMATION_FRAME_INTERVAL_SEC;
    if (shouldAdvanceAnimationFrame) {
      this._animationFrameAccumulatorSec =
        this._animationFrameAccumulatorSec % VFX_ANIMATION_FRAME_INTERVAL_SEC;
    }
    this._attachments.update(delta, shouldAdvanceAnimationFrame);

    this._bindings.forEach((binding) => {
      // A transform edit made within the last frame interval redraws on this tick.
      let shouldRedrawTextureComposite =
        shouldAdvanceAnimationFrame &&
        this._pendingTransformRedraws.delete(binding);
      // The flush counts toward the transform redraw cap.
      if (shouldRedrawTextureComposite)
        this._lastTransformRedrawMs = performance.now();

      binding.activeEffects.forEach((activeEffect) => {
        if (activeEffect.isAnimated) {
          activeEffect.elapsedSec += delta;
        }

        activeEffect.hoverRuntimeMaterials.forEach((material) => {
          updateMaterialRuntime(material, delta);
        });

        if (!shouldAdvanceAnimationFrame || !activeEffect.isAnimated) {
          return;
        }

        activeEffect.animationState = evaluateAvatarVFXAnimation({
          elapsedSec: activeEffect.elapsedSec,
          config: activeEffect.animationConfig,
          keyframes: activeEffect.effectEntry.keyframes,
          flipbook: activeEffect.effectEntry.flipbook,
        });

        if (activeEffect.renderMode === "texture") {
          shouldRedrawTextureComposite = true;
          return;
        }

        applyAnimationToHoverInstances({
          instances: activeEffect.hoverInstances,
          animationState: activeEffect.animationState,
          effect: activeEffect.effectEntry,
          intensity: activeEffect.intensity,
        });
      });

      if (shouldRedrawTextureComposite) {
        this._redrawBindingTextureComposite(binding);
      }

      if (binding.textureComposite) {
        updateMaterialRuntime(binding.textureComposite.materialClone, delta);
      }
    });
  }

  dispose(): void {
    if (this._isDisposed) return;
    this.setIrisHidden(false);
    this._pendingTransformRedraws.clear();
    this.clearAllEffects();
    this._regionHider.restoreAll();
    this._listeners.clear();
    this._bindings.clear();
    this._primitivesByKey.clear();
    this._applyTokens.clear();
    this._pendingIntensities.clear();
    this._nextAppliedOrder = 0;
    this._warnings = [];
    this._issues = [];
    this._snapshot = this._createSnapshot();
    this._observationSnapshot = this._createObservationSnapshot();
    this._isDisposed = true;
  }

  /** Apply an entry (whose id is its applied id) to its automatic binding. */
  private _applyAutoResolvedEffect(
    effect: AvatarVFXCatalogEntry,
    applyMode: AvatarVFXApplyMode | null,
    logicalEffectId: string,
  ): Promise<void> {
    if (isHoverVFXEntry(effect)) {
      return this._applyHoverEffect(effect, undefined, logicalEffectId);
    }
    if (isFaceAnchoredVFXEntry(effect)) {
      return this._applyFaceAnchoredEffect(effect, undefined, logicalEffectId);
    }
    return this._applyTextureEffect(
      effect,
      applyMode ?? undefined,
      undefined,
      logicalEffectId,
    );
  }

  /** Move, scale and turn hover planes in place for a new transform. */
  private _updateHoverTransform(
    active: ActiveBindingEffect,
    effect: AvatarHoverVFXEntry,
  ): boolean {
    const faceLandmarks = this._avatar.getFaceLandmarksSnapshot();
    if (faceLandmarks?.status !== "ready") return false;
    const placements = resolveHoverPlacementInstances({
      effect,
      faceLandmarks,
      faceTextureAnchors: this._avatar.getFaceTextureAnchorsSnapshot(),
      proportions: measureAvatarProportions(this._avatar.vrm),
    });
    if (!placements) return false;
    const scaleX = resolveStaticScaleComponent(effect.transform.scale.x);
    const scaleY = resolveStaticScaleComponent(effect.transform.scale.y);
    const scaleZ = resolveStaticScaleComponent(effect.transform.scale.z);
    for (const instance of active.hoverInstances) {
      const placement = placements.find(
        (candidate) => candidate.label === instance.label,
      );
      if (!placement) continue;
      instance.placementRoot.position.copy(placement.position);
      if (instance.coverPatch) {
        placeCoverPatch(
          instance.coverPatch.mesh,
          instance.coverPatch.center,
          placement.position,
          instance.placementRoot.rotation.y,
        );
      }
      instance.staticGroup.rotation.set(
        effect.transform.rotation.x,
        effect.transform.rotation.y,
        effect.transform.rotation.z,
      );
      const mirrorScale = instance.mesh.scale.x < 0 ? -1 : 1;
      instance.mesh.scale.set(mirrorScale * scaleX, scaleY, scaleZ);
      instance.backdropMesh?.scale.set(
        (instance.mirrored ? -1 : 1) * scaleX,
        scaleY,
        scaleZ,
      );
      instance.planeWidth = instance.baseWidth * scaleX;
      instance.planeHeight = instance.baseHeight * scaleY;
    }
    return true;
  }

  /** Redraw now when the last transform redraw is a frame old; otherwise on the next tick. */
  private _redrawTransformedComposite(binding: BindingState): void {
    const now = performance.now();
    if (now - this._lastTransformRedrawMs >= TRANSFORM_REDRAW_INTERVAL_MS) {
      this._lastTransformRedrawMs = now;
      this._pendingTransformRedraws.delete(binding);
      this._redrawBindingTextureComposite(binding);
      return;
    }
    this._pendingTransformRedraws.add(binding);
  }

  /** The drawn corners of a composite effect, mapped from UV onto the surface. */
  private _surfaceManipulationPlacements(
    binding: BindingState,
    active: ActiveBindingEffect,
  ): AvatarVFXManipulationPlacement[] {
    const layer =
      active.layerCanvases.get("map") ??
      active.layerCanvases.values().next().value;
    if (!layer) return [];
    // The layer's original texture: its transform maps the mesh's UVs.
    const texture =
      binding.textureSlots.find((slot) => slot.slot === layer.slot)?.texture ??
      null;
    let cached = this._uvLocators.get(binding.object);
    if (!cached || cached.texture !== texture) {
      cached = {
        texture,
        locator: MeshUvLocator.create(
          binding.object,
          TextureUvMapping.of(texture),
        ),
      };
      this._uvLocators.set(binding.object, cached);
    }
    const locator = cached.locator;
    if (!locator) return [];
    const size = { width: layer.width, height: layer.height };
    const placements: AvatarVFXManipulationPlacement[] = [];
    for (const placement of layer.placements) {
      // Match the compositor: the other-eye art is drawn unflipped.
      const mirrorX =
        placement.effectMirror === true && layer.otherImage !== null
          ? false
          : placement.mirrorX;
      // The authored placement, without its own motion.
      const transform = resolveTexturePlacementTransform(
        { ...placement, mirrorX },
        active.effectEntry,
        size,
        STILL_ANIMATION_STATE,
      );
      const halfWidth = placement.rect.width / 2;
      const halfHeight = placement.rect.height / 2;
      const corners = [
        { x: -halfWidth, y: -halfHeight },
        { x: halfWidth, y: -halfHeight },
        { x: halfWidth, y: halfHeight },
        { x: -halfWidth, y: halfHeight },
      ].map((point) =>
        locator.toWorld(transformTexturePlacementPoint(point, transform, size)),
      );
      if (corners.some((corner) => corner === null)) continue;
      // A cell with mirrored UVs negates offsets and turns as well as the
      // art, so each sense reverses once more there.
      const flipped = placement.flipX === true;
      const flippedArt = transform.scaleX < 0;
      placements.push(
        quadManipulationPlacement({
          label: placement.label,
          mirrored: (placement.effectMirror === true) !== flipped,
          corners: corners as AvatarVFXManipulationPlacement["corners"],
          // The canvas turns +x toward +y (down); a flipped copy reverses it.
          rotationSense: flippedArt !== flipped ? -1 : 1,
        }),
      );
    }
    return placements;
  }

  private _resolveEffectSource(
    effectId: string,
    effectEntry?: AvatarVFXCatalogEntry,
  ): AvatarVFXCatalogEntry | null {
    const catalogEffect = this._catalogProvider.resolveAvatarVFX(effectId);
    return effectEntry ?? catalogEffect ?? null;
  }

  private async _applyHoverEffect(
    effect: AvatarHoverVFXEntry,
    bindingOverride?: BindingState,
    logicalEffectId = effect.id,
  ): Promise<void> {
    const binding =
      bindingOverride ?? this._resolveAutoBindingForEffect(effect) ?? null;
    if (!binding) {
      this._pushWarning(
        { code: "effect_target_unresolved", params: { effectId: effect.id } },
        `No compatible target was resolved for "${effect.label}".`,
      );
      return;
    }

    await this._applyResolvedEffectToBinding({
      binding,
      effect,
      applyMode: null,
      logicalEffectId,
    });
  }

  private async _applyFaceAnchoredEffect(
    effect: AvatarFaceAnchoredVFXEntry,
    bindingOverride?: BindingState,
    logicalEffectId = effect.id,
  ): Promise<void> {
    const binding =
      bindingOverride ?? this._resolveAutoBindingForEffect(effect) ?? null;
    if (!binding) {
      this._pushWarning(
        { code: "effect_target_unresolved", params: { effectId: effect.id } },
        `No compatible target was resolved for "${effect.label}".`,
      );
      return;
    }

    await this._applyResolvedEffectToBinding({
      binding,
      effect,
      applyMode: "overlay",
      logicalEffectId,
    });
  }

  private async _applyTextureEffect(
    effect: AvatarTextureVFXEntry,
    applyModeOverride?: AvatarVFXApplyMode,
    bindingOverride?: BindingState,
    logicalEffectId = effect.id,
  ): Promise<void> {
    const binding =
      bindingOverride ??
      this._resolveAutoBindingForEffect(effect, applyModeOverride) ??
      null;
    if (!binding) {
      this._pushWarning(
        { code: "effect_target_unresolved", params: { effectId: effect.id } },
        `No compatible target was resolved for "${effect.label}".`,
      );
      return;
    }

    await this._applyResolvedEffectToBinding({
      binding,
      effect,
      applyMode: applyModeOverride ?? effect.applyMode,
      logicalEffectId,
    });
  }

  private async _applyResolvedEffectToBinding(args: {
    binding: BindingState;
    effect: AvatarVFXCatalogEntry;
    applyMode: AvatarVFXApplyMode | null;
    logicalEffectId: string;
  }): Promise<void> {
    if (this._isDisposed) return;

    const { binding, effect, applyMode, logicalEffectId } = args;
    if (isAnchoredFaceTextureEffect(effect) && applyMode !== "overlay") {
      binding.warning = `Anchored face decals require overlay mode.`;
      this._pushWarning(
        { code: "effect_overlay_required", params: { effectId: effect.id } },
        `Anchored face decals require overlay mode for "${effect.label}".`,
      );
      return;
    }

    if (!this._bindingServes(binding, effect)) {
      binding.warning = `Effect "${effect.label}" does not target ${binding.targetRole}.`;
      this._pushWarning(
        {
          code: "effect_target_incompatible",
          params: { effectId: effect.id, targetRole: binding.targetRole },
        },
        `Effect "${effect.label}" is not compatible with ${binding.targetRole}.`,
      );
      return;
    }

    const renderMode = resolveEffectRenderMode(effect);
    const isAnchoredTextureEffect = isAnchoredFaceTextureEffect(effect);
    const requiresFaceTextureAnchors =
      isAnchoredTextureEffect || isMouthHoverVFXEntry(effect);
    const faceTextureAnchors = requiresFaceTextureAnchors
      ? this._avatar.getFaceTextureAnchorsSnapshot()
      : null;
    if (
      requiresFaceTextureAnchors &&
      faceTextureAnchors?.status === "ready" &&
      faceTextureAnchors.faceBindingKey &&
      faceTextureAnchors.faceBindingKey !== binding.bindingKey
    ) {
      binding.warning = isAnchoredTextureEffect
        ? `Anchored face decals require the resolved face skin binding.`
        : `Mouth hover effects require the resolved face skin binding.`;
      this._pushWarning(
        { code: "effect_face_skin_required", params: { effectId: effect.id } },
        isAnchoredTextureEffect
          ? `Anchored face decals require the resolved face skin binding for "${effect.label}".`
          : `Mouth hover effects require the resolved face skin binding for "${effect.label}".`,
      );
      return;
    }

    const animationPreset = deriveAvatarVFXAnimationPreset(
      effect.animationConfig,
    );
    const animationConfig = resolveAvatarVFXAnimationConfig(
      effect.animationConfig,
    );
    const isAnimated = isAnimatedEffect(effect, animationConfig);
    const initialAnimationState = evaluateAvatarVFXAnimation({
      elapsedSec: 0,
      config: animationConfig,
      keyframes: effect.keyframes,
      flipbook: effect.flipbook,
    });

    const appliedEffectId = effect.id;
    const effectRegion = getAvatarVFXRegion(effect);
    const token = (this._applyTokens.get(appliedEffectId) ?? 0) + 1;
    this._applyTokens.set(appliedEffectId, token);

    let effectImage: CanvasImageSource;
    let otherImage: CanvasImageSource | null = null;
    try {
      [effectImage, otherImage] = await Promise.all([
        loadEffectImage(effect.assetPath),
        effect.otherEyeAssetPath
          ? loadEffectImage(effect.otherEyeAssetPath)
          : Promise.resolve(null),
      ]);
    } catch (error) {
      if (this._applyTokens.get(appliedEffectId) !== token) return;
      binding.warning = error instanceof Error ? error.message : String(error);
      this._pushWarning(
        { code: "effect_load_failed", params: { effectId: effect.id } },
        binding.warning,
      );
      return;
    }

    if (this._isDisposed || this._applyTokens.get(appliedEffectId) !== token) {
      return;
    }
    if (this._bindings.get(binding.bindingKey) !== binding) {
      // Face parts were rebuilt while the image loaded: this binding, its
      // placement and anchors are stale, so apply again on the new bindings.
      const part = this.findUnavailableFacePart(effect);
      if (part) {
        this._pendingIntensities.delete(appliedEffectId);
        this.reportUnavailableFacePart(effect, part, logicalEffectId);
        return;
      }
      await this._applyAutoResolvedEffect(effect, applyMode, logicalEffectId);
      return;
    }
    // A body, sticker or silhouette effect under the same ID gives way.
    if (this._attachments.remove(appliedEffectId)) this._emit();

    if (renderMode === "hover_plane") {
      if (!isHoverVFXEntry(effect)) {
        binding.warning = `Effect "${effect.label}" is not a hover VFX.`;
        this._pushWarning(
          { code: "effect_wrong_kind", params: { effectId: effect.id } },
          binding.warning,
        );
        return;
      }
      const hoverEffectState = this._createHoverEffectGroup({
        binding,
        effect,
        effectImage,
        otherImage,
      });
      if (!hoverEffectState) {
        binding.warning =
          binding.warning ??
          `Unable to resolve hover placement for "${effect.label}".`;
        this._pushWarning(
          { code: "effect_placement_failed", params: { effectId: effect.id } },
          binding.warning,
        );
        return;
      }

      if (isAvatarVFXRegionStackable(effectRegion)) {
        this._removeAppliedEffect(appliedEffectId, { emit: false });
      } else {
        this._removeAppliedEffectsInRegion(effectRegion, { emit: false });
      }
      const intensity = this._takePendingIntensity(appliedEffectId);
      const autoDisabledRoles = getAutoDisabledRoles(effect);
      const disabledBindingKeys = this._applyAutoDisabledBindings(
        appliedEffectId,
        binding,
        intensity >= FACE_CHANGE_MIN_INTENSITY ? autoDisabledRoles : [],
      );
      const forcesBlink = shouldForceBlink(effect);
      binding.activeEffects.set(appliedEffectId, {
        appliedEffectId,
        effectId: logicalEffectId,
        effectEntry: effect,
        applyMode,
        animationPreset,
        animationConfig,
        renderMode,
        forcesBlink,
        layerCanvases: new Map(),
        hoverGroup: hoverEffectState.group,
        hoverInstances: hoverEffectState.instances,
        hoverRuntimeMaterials: hoverEffectState.runtimeMaterials,
        autoDisabledRoles,
        disabledBindingKeys,
        elapsedSec: 0,
        isAnimated,
        hasOwnMotion: isAnimated,
        animationState: initialAnimationState,
        appliedOrder: ++this._nextAppliedOrder,
        intensity,
        tintedImages: new Map(),
      });
      this._cachedFaceFlattenState = null;
      applyAnimationToHoverInstances({
        instances: hoverEffectState.instances,
        animationState: initialAnimationState,
        effect,
        intensity,
      });
      binding.warning = null;
      if (isEyeHoverVFXEntry(effect) || isMouthHoverVFXEntry(effect)) {
        this._refreshFaceFlattenComposite();
      }
      this._syncForcedBlinkExpression();
      this._emit();
      return;
    }

    if (!applyMode) {
      binding.warning = `Effect "${effect.label}" does not define a texture apply mode.`;
      this._pushWarning(
        { code: "effect_wrong_kind", params: { effectId: effect.id } },
        binding.warning,
      );
      return;
    }

    const builtLayerCanvases = this._buildTextureLayerCanvases({
      binding,
      effect,
      applyMode,
      effectImage,
      otherImage,
      faceTextureAnchors,
    });
    if (builtLayerCanvases.layerCanvases.size === 0) {
      // A skip names the effect, then why (a sentence of its own elsewhere).
      binding.warning = builtLayerCanvases.skip
        ? `Skipped "${effect.label}": ${lowerFirst(builtLayerCanvases.warning ?? "")}`
        : (builtLayerCanvases.warning ??
          `No compatible ${applyMode} texture slots were available.`);
      this._pushWarning(
        {
          code: builtLayerCanvases.skip ?? "effect_placement_failed",
          params: { effectId: effect.id },
        },
        binding.warning,
      );
      return;
    }

    if (isAvatarVFXRegionStackable(effectRegion)) {
      this._removeAppliedEffect(appliedEffectId, { emit: false });
    } else {
      this._removeAppliedEffectsInRegion(effectRegion, { emit: false });
    }
    this._markTextureCompositeStaticDirty(binding);
    const intensity = this._takePendingIntensity(appliedEffectId);
    const autoDisabledRoles = getAutoDisabledRoles(effect);
    const disabledBindingKeys = this._applyAutoDisabledBindings(
      appliedEffectId,
      binding,
      intensity >= FACE_CHANGE_MIN_INTENSITY ? autoDisabledRoles : [],
    );
    const forcesBlink = shouldForceBlink(effect);
    binding.activeEffects.set(appliedEffectId, {
      appliedEffectId,
      effectId: logicalEffectId,
      effectEntry: effect,
      applyMode,
      animationPreset,
      animationConfig,
      renderMode,
      forcesBlink,
      layerCanvases: builtLayerCanvases.layerCanvases,
      hoverGroup: null,
      hoverInstances: [],
      hoverRuntimeMaterials: [],
      autoDisabledRoles,
      disabledBindingKeys,
      elapsedSec: 0,
      isAnimated,
      hasOwnMotion: isAnimated,
      animationState: initialAnimationState,
      appliedOrder: ++this._nextAppliedOrder,
      intensity,
      tintedImages: new Map(),
    });
    this._cachedFaceFlattenState = null;
    const appliedEffect = binding.activeEffects.get(appliedEffectId);
    if (appliedEffect && appliedEffect.intensity !== 1) {
      // A fade already in progress redraws on each animation tick.
      appliedEffect.isAnimated = true;
    }

    const redrawSucceeded = this._redrawBindingTextureComposite(binding);
    if (!redrawSucceeded) {
      this._removeAppliedEffect(appliedEffectId, { emit: false });
      binding.warning =
        binding.warning ??
        `Unable to composite texture VFX for "${binding.materialName ?? binding.bindingKey}".`;
      this._pushWarning(
        { code: "effect_placement_failed", params: { effectId: effect.id } },
        binding.warning,
      );
      return;
    }

    binding.warning = null;
    this._syncForcedBlinkExpression();
    this._emit();
  }

  private _buildTextureLayerCanvases(args: {
    binding: BindingState;
    effect: AvatarVFXCatalogEntry;
    applyMode: AvatarVFXApplyMode;
    effectImage: CanvasImageSource;
    otherImage: CanvasImageSource | null;
    faceTextureAnchors: AvatarFaceTextureAnchorsSnapshot | null;
  }): {
    layerCanvases: Map<AvatarVFXTextureSlot, EffectLayerCanvasState>;
    warning: string | null;
    skip?: TexturePlacementSkip;
  } {
    const layerCanvases = new Map<
      AvatarVFXTextureSlot,
      EffectLayerCanvasState
    >();
    if (
      getAvatarVFXTargetRole(args.effect) === "face_skin" &&
      !showsPaintedFaceArt(args.binding, args.applyMode)
    ) {
      return {
        layerCanvases,
        warning:
          "The face skin's material shows no base color texture through its first UV set, so art painted on it would not show.",
        skip: "effect_face_texture_hidden",
      };
    }
    let textureDrawWarning: string | null = null;
    let skip: TexturePlacementSkip | undefined;

    args.binding.textureSlots.forEach((slotState) => {
      if (args.applyMode === "overlay" && !slotState.canOverlay) {
        return;
      }

      const drawResult = resolveTextureEffectPlacements({
        image: args.effectImage,
        effect: args.effect,
        size: { width: slotState.width, height: slotState.height },
        profile: this._placementProfile(),
        faceTextureAnchors: args.faceTextureAnchors,
        faceClip: () => this._faceSkinClip(args.binding, slotState),
        faceClipRequired: this._faceIsHeadRegion(args.binding),
        decalClip: () => this._faceRegionClip(args.binding, slotState),
      });
      if (drawResult.placements.length === 0) {
        textureDrawWarning = textureDrawWarning ?? drawResult.warning ?? null;
        skip = skip ?? drawResult.skip;
        return;
      }

      layerCanvases.set(slotState.slot, {
        slot: slotState.slot,
        image: args.effectImage,
        otherImage: args.otherImage,
        placements: drawResult.placements,
        width: slotState.width,
        height: slotState.height,
      });
    });

    // Multiply art darkens: on a surface too dark it changes nothing visible.
    const mapLayer = layerCanvases.get("map");
    const mapTexture = args.binding.textureSlots.find(
      (slot) => slot.slot === "map",
    )?.texture;
    const surface = mapTexture ? getTextureImageSource(mapTexture) : null;
    if (
      mapLayer &&
      surface &&
      isAnchoredFaceTextureEffect(args.effect) &&
      resolveAppearance(args.effect).blend === "multiply"
    ) {
      const change = multiplyDecalChange({
        effect: args.effect,
        art: args.effectImage,
        surface,
        placements: mapLayer.placements,
      });
      if (change !== null && change < MULTIPLY_MIN_VISIBLE_CHANGE) {
        return {
          layerCanvases: new Map(),
          warning:
            "It darkens the face where it is painted, and the face there is too dark for the change to show.",
          skip: "effect_surface_too_dark",
        };
      }
    }

    return {
      layerCanvases,
      warning: textureDrawWarning,
      ...(layerCanvases.size === 0 && skip ? { skip } : {}),
    };
  }

  private _resolveAutoBindingForEffect(
    effect: AvatarVFXCatalogEntry,
    applyModeOverride?: AvatarVFXApplyMode,
  ): BindingState | null {
    const applyMode = applyModeOverride ?? getAvatarVFXApplyMode(effect);

    if (isFaceAnchoredVFXEntry(effect)) {
      const anchors = this._avatar.getFaceTextureAnchorsSnapshot();
      if (anchors?.status === "ready" && anchors.faceBindingKey) {
        return this._bindings.get(anchors.faceBindingKey) ?? null;
      }
    }

    if (isMouthHoverVFXEntry(effect)) {
      const anchors = this._avatar.getFaceTextureAnchorsSnapshot();
      if (anchors?.status === "ready" && anchors.faceBindingKey) {
        return this._bindings.get(anchors.faceBindingKey) ?? null;
      }
      return null;
    }

    if (isBoxHoverVFXEntry(effect)) {
      const faceLandmarks = this._avatar.getFaceLandmarksSnapshot();
      if (faceLandmarks?.status === "ready" && faceLandmarks.faceBindingKey) {
        return this._bindings.get(faceLandmarks.faceBindingKey) ?? null;
      }
    }

    if (getAvatarVFXTargetRole(effect) === "face_skin") {
      const anchors = this._avatar.getFaceTextureAnchorsSnapshot();
      if (anchors?.status === "ready" && anchors.faceBindingKey) {
        return this._bindings.get(anchors.faceBindingKey) ?? null;
      }
      const faceLandmarks = this._avatar.getFaceLandmarksSnapshot();
      if (faceLandmarks?.status === "ready" && faceLandmarks.faceBindingKey) {
        return this._bindings.get(faceLandmarks.faceBindingKey) ?? null;
      }
    }

    if (isEyeHoverVFXEntry(effect) && this._eyePlanesOnFace()) {
      return this._resolveFaceFlattenBinding();
    }

    return (
      Array.from(this._bindings.values()).find((binding) => {
        if (!binding.targetRoles.includes(getAvatarVFXTargetRole(effect))) {
          return false;
        }
        if (applyMode === "overlay") {
          return binding.textureSlots.some((slot) => slot.canOverlay);
        }
        if (applyMode === "replace") {
          return binding.textureSlots.length > 0;
        }
        return true;
      }) ?? null
    );
  }

  /**
   * Whether `binding` can hold `effect`: it serves the effect's target role,
   * or the effect is an eye plane on an Avatar whose eyes have no iris mesh
   * part (see {@link _eyePlanesOnFace}) and the binding is face skin.
   */
  private _bindingServes(
    binding: BindingState,
    effect: AvatarVFXCatalogEntry,
  ): boolean {
    if (binding.targetRoles.includes(getAvatarVFXTargetRole(effect))) {
      return true;
    }
    return (
      isEyeHoverVFXEntry(effect) &&
      binding.targetRoles.includes("face_skin") &&
      this._eyePlanesOnFace()
    );
  }

  /**
   * Whether eye planes are held by the face skin binding: the eyes' positions
   * are estimated (painted or merged into the face primitive) and no binding
   * is an iris. The planes hang from the head anchor either way.
   */
  private _eyePlanesOnFace(): boolean {
    return (
      hasEstimatedEyes(this._avatar.facePartMap ?? null) &&
      !Array.from(this._bindings.values()).some((binding) =>
        binding.targetRoles.includes("eye_iris"),
      )
    );
  }

  private _resolveFaceFlattenBinding(): BindingState | null {
    const anchors = this._avatar.getFaceTextureAnchorsSnapshot();
    if (anchors?.status === "ready" && anchors.faceBindingKey) {
      return this._bindings.get(anchors.faceBindingKey) ?? null;
    }
    const faceLandmarks = this._avatar.getFaceLandmarksSnapshot();
    if (faceLandmarks?.status === "ready" && faceLandmarks.faceBindingKey) {
      return this._bindings.get(faceLandmarks.faceBindingKey) ?? null;
    }
    return (
      Array.from(this._bindings.values()).find((binding) =>
        binding.targetRoles.includes("face_skin"),
      ) ?? null
    );
  }

  private _hasAutoFaceFlattenEyes(): boolean {
    return Array.from(this._bindings.values()).some((binding) =>
      Array.from(binding.activeEffects.values()).some(
        ({ effectEntry, intensity }) =>
          intensity >= FACE_CHANGE_MIN_INTENSITY &&
          isEyeHoverVFXEntry(effectEntry) &&
          (effectEntry.faceCleanup ?? true),
      ),
    );
  }

  private _hasAutoFaceFlattenMouth(): boolean {
    return Array.from(this._bindings.values()).some((binding) =>
      Array.from(binding.activeEffects.values()).some(
        ({ effectEntry, intensity }) =>
          intensity >= FACE_CHANGE_MIN_INTENSITY &&
          ((isFaceAnchoredVFXEntry(effectEntry) &&
            effectEntry.anchor === "mouth") ||
            isMouthHoverVFXEntry(effectEntry)) &&
          (effectEntry.faceCleanup ?? true),
      ),
    );
  }

  private _resolveFaceFlattenState(
    binding: BindingState | null,
  ): ResolvedFaceFlattenState {
    const previewEyes = this._flattenPreviewEyes;
    const previewMouth = this._flattenPreviewMouth;
    const autoEyes = this._hasAutoFaceFlattenEyes();
    const autoMouth = this._hasAutoFaceFlattenMouth();
    const activeEyes = previewEyes || autoEyes;
    const activeMouth = previewMouth || autoMouth;

    if (!binding || !binding.targetRoles.includes("face_skin")) {
      return {
        status: "unavailable",
        faceBindingKey: binding?.bindingKey ?? null,
        previewEyes,
        previewMouth,
        autoEyes,
        autoMouth,
        activeEyes,
        activeMouth,
        sampledColor: null,
        sampledColorsBySlot: {},
        warning: "No face skin binding is available for flatten preview.",
        shouldRenderEyes: false,
        shouldRenderMouth: false,
        eyeRegions: [],
        mouthRegion: null,
      };
    }

    const anchors = this._avatar.getFaceTextureAnchorsSnapshot();
    if (!anchors || anchors.status !== "ready") {
      return {
        status: "unavailable",
        faceBindingKey: binding.bindingKey,
        previewEyes,
        previewMouth,
        autoEyes,
        autoMouth,
        activeEyes,
        activeMouth,
        sampledColor: null,
        sampledColorsBySlot: {},
        warning:
          anchors?.warnings[0] ??
          "Face texture anchors are unavailable for flatten preview.",
        shouldRenderEyes: false,
        shouldRenderMouth: false,
        eyeRegions: [],
        mouthRegion: null,
      };
    }

    if (
      anchors.faceBindingKey &&
      anchors.faceBindingKey !== binding.bindingKey
    ) {
      return {
        status: "unavailable",
        faceBindingKey: anchors.faceBindingKey,
        previewEyes,
        previewMouth,
        autoEyes,
        autoMouth,
        activeEyes,
        activeMouth,
        sampledColor: null,
        sampledColorsBySlot: {},
        warning:
          "Flatten preview requires the resolved face texture anchor binding.",
        shouldRenderEyes: false,
        shouldRenderMouth: false,
        eyeRegions: [],
        mouthRegion: null,
      };
    }

    const flattenTargetSlots = binding.textureSlots.filter(
      (slot) => slot.slot === "map" || slot.slot === "shadeMultiplyTexture",
    );
    if (flattenTargetSlots.length === 0) {
      return {
        status: "unavailable",
        faceBindingKey: binding.bindingKey,
        previewEyes,
        previewMouth,
        autoEyes,
        autoMouth,
        activeEyes,
        activeMouth,
        sampledColor: null,
        sampledColorsBySlot: {},
        warning:
          "The resolved face skin binding does not expose a supported flatten texture slot.",
        shouldRenderEyes: false,
        shouldRenderMouth: false,
        eyeRegions: [],
        mouthRegion: null,
      };
    }

    const sampleRegion = anchors.flatten.sample.center;
    const eyeRegions = [
      anchors.flatten.eyes.left,
      anchors.flatten.eyes.right,
    ].filter(
      (region): region is AvatarFaceTextureFlattenRegionSnapshot =>
        region !== null,
    );
    const mouthRegion = anchors.flatten.mouth.center;
    const sampledColorsBySlot: Partial<
      Record<AvatarVFXTextureSlot, AvatarVFXFlattenColorSnapshot>
    > = {};

    if (sampleRegion) {
      flattenTargetSlots.forEach((slot) => {
        const source = getTextureImageSource(slot.texture);
        if (!source) {
          return;
        }
        const sampledColor = sampleAverageTextureColor({
          image: source,
          width: slot.width,
          height: slot.height,
          region: sampleRegion,
        });
        if (!sampledColor) {
          return;
        }
        sampledColorsBySlot[slot.slot] = sampledColor;
      });
    }

    const sampledColor =
      sampledColorsBySlot.map ??
      sampledColorsBySlot.shadeMultiplyTexture ??
      null;

    let warning: string | null = null;
    if (!sampleRegion) {
      warning = "No flatten sample region was resolved on the face texture.";
    } else if (!sampledColor) {
      warning =
        "Unable to sample a face flatten color from the available face texture slots.";
    }

    return {
      status: "ready",
      faceBindingKey: binding.bindingKey,
      previewEyes,
      previewMouth,
      autoEyes,
      autoMouth,
      activeEyes,
      activeMouth,
      sampledColor,
      sampledColorsBySlot,
      warning,
      shouldRenderEyes: activeEyes && eyeRegions.length > 0,
      shouldRenderMouth: activeMouth && Boolean(mouthRegion),
      eyeRegions,
      mouthRegion,
    };
  }

  private _getCachedFaceFlattenState(
    binding: BindingState | null,
  ): ResolvedFaceFlattenState {
    if (
      this._cachedFaceFlattenState &&
      this._cachedFaceFlattenState.faceBindingKey ===
        (binding?.bindingKey ?? null)
    ) {
      return this._cachedFaceFlattenState;
    }
    const nextState = this._resolveFaceFlattenState(binding);
    this._cachedFaceFlattenState = nextState;
    return nextState;
  }

  private _refreshFaceFlattenComposite(): void {
    this._cachedFaceFlattenState = null;
    const faceBinding = this._resolveFaceFlattenBinding();
    if (!faceBinding) {
      return;
    }
    this._markTextureCompositeStaticDirty(faceBinding);
    this._redrawBindingTextureComposite(faceBinding);
  }

  private _rebuildBindings() {
    // Part regions may change with the rebuild; nothing stays hidden across it.
    this._regionHider.restoreAll();
    const runtimeResult = buildRuntimePrimitiveBindings(this._avatar);
    this._warnings = [...runtimeResult.warnings];
    this._issues = runtimeResult.warnings.length
      ? [{ code: "scene_bindings_unavailable" }]
      : [];
    this._cachedFaceFlattenState = null;
    this._bindings.clear();
    this._primitivesByKey.clear();
    for (const entry of runtimeResult.entries)
      this._primitivesByKey.set(entry.bindingKey, entry.object);

    // Roles come from the Avatar's face part map (spec signals, then names,
    // then corrections); an Avatar without a map uses name matching.
    const partMap = this._avatar.facePartMap ?? null;
    this._textureImageUsers.clear();
    runtimeResult.entries.forEach((entry) => {
      const mainMaterial = getRenderableMainMaterial(entry.object);
      // Every primitive drawing each image, part or not, to tell an atlas.
      SUPPORTED_TEXTURE_SLOTS.forEach((slot) => {
        const image =
          mainMaterial && getTextureSlot(mainMaterial, slot)?.source;
        if (!image) return;
        const users = this._textureImageUsers.get(image) ?? new Set<string>();
        users.add(entry.bindingKey);
        this._textureImageUsers.set(image, users);
      });
      const targetRoles = partMap
        ? resolveFacePartTargetRoles(partMap, entry.bindingKey)
        : [matchAvatarTargetRole(entry.materialName, this._profile)].filter(
            (role): role is AvatarVFXTargetRole => role !== null,
          );
      const targetRole = targetRoles[0];
      if (!mainMaterial || !targetRole) return;

      const textureSlots: BindingTextureState[] = [];
      SUPPORTED_TEXTURE_SLOTS.forEach((slot) => {
        const texture = getTextureSlot(mainMaterial, slot);
        if (!texture) return;
        const size = getTextureSize(texture);
        if (!size) return;
        textureSlots.push({
          slot,
          texture,
          width: size.width,
          height: size.height,
          canOverlay: Boolean(getTextureImageSource(texture)),
        });
      });

      const availableEffectIds = this._catalog
        .filter((effect) =>
          targetRoles.includes(getAvatarVFXTargetRole(effect)),
        )
        .map((effect) => effect.id);

      // Creator effects arrive after discovery and may suppress any recognized
      // role, including untextured lines or lashes absent from the mounted catalog.
      this._bindings.set(entry.bindingKey, {
        entry,
        bindingKey: entry.bindingKey,
        targetRole,
        targetRoles,
        materialIndex: entry.materialIndex,
        materialName: entry.materialName,
        objectName: entry.objectName,
        objectType: entry.objectType,
        object: entry.object,
        originalVisible: entry.originalVisible,
        originalMaterial: entry.object.material,
        originalMainMaterial: mainMaterial,
        textureSlots,
        availableEffectIds,
        autoDisableSources: new Set<string>(),
        visibleBeforeAutoDisable: null,
        warning: null,
        activeEffects: new Map(),
        textureComposite: null,
      });
    });
  }

  private _getSortedActiveEffects(
    binding: BindingState,
  ): ActiveBindingEffect[] {
    return Array.from(binding.activeEffects.values()).sort(
      (left, right) => left.appliedOrder - right.appliedOrder,
    );
  }

  private _getSortedTextureEffects(
    binding: BindingState,
  ): ActiveBindingEffect[] {
    return this._getSortedActiveEffects(binding)
      .filter((effect) => effect.renderMode === "texture")
      .sort((left, right) => {
        const kindOrderDiff =
          getTextureEffectKindOrder(left.effectEntry) -
          getTextureEffectKindOrder(right.effectEntry);
        if (kindOrderDiff !== 0) {
          return kindOrderDiff;
        }
        return left.appliedOrder - right.appliedOrder;
      });
  }

  private _ensureTextureCompositeState(
    binding: BindingState,
    materialClone: THREE.Material,
  ): BindingTextureCompositeState {
    if (binding.textureComposite?.materialClone === materialClone) {
      return binding.textureComposite;
    }
    if (binding.textureComposite) {
      this._disposeTextureCompositeState(binding);
    }
    const nextState: BindingTextureCompositeState = {
      materialClone,
      slotStates: new Map(),
      staticCacheDirty: true,
    };
    binding.textureComposite = nextState;
    return nextState;
  }

  private _markTextureCompositeStaticDirty(binding: BindingState): void {
    if (!binding.textureComposite) {
      return;
    }
    binding.textureComposite.staticCacheDirty = true;
  }

  private _ensureCompositeSlotState(args: {
    binding: BindingState;
    slotState: BindingTextureState;
    materialClone: THREE.Material;
  }): CompositeTextureSlotState {
    const compositeState = this._ensureTextureCompositeState(
      args.binding,
      args.materialClone,
    );
    const existing = compositeState.slotStates.get(args.slotState.slot) ?? null;
    if (
      existing &&
      existing.width === args.slotState.width &&
      existing.height === args.slotState.height
    ) {
      return existing;
    }
    if (existing) {
      existing.texture.dispose();
      compositeState.slotStates.delete(args.slotState.slot);
    }

    const { canvas, context } = createCanvas(
      args.slotState.width,
      args.slotState.height,
    );
    const texture = new THREE.CanvasTexture(canvas);
    copyTextureSettings(args.slotState.texture, texture);
    const nextState: CompositeTextureSlotState = {
      slot: args.slotState.slot,
      canvas,
      context,
      texture,
      staticSegments: [],
      width: args.slotState.width,
      height: args.slotState.height,
      baseDrawn: false,
      baseClips: [],
    };
    compositeState.slotStates.set(args.slotState.slot, nextState);
    return nextState;
  }

  private _ensureStaticCompositeSegments(args: {
    compositeSlotState: CompositeTextureSlotState;
    width: number;
    height: number;
    count: number;
  }): StaticCompositeSegmentState[] {
    const { compositeSlotState, width, height, count } = args;
    const segments = compositeSlotState.staticSegments;
    const canReuse =
      segments.length === count &&
      compositeSlotState.width === width &&
      compositeSlotState.height === height;
    if (canReuse) {
      return segments;
    }

    const nextSegments = createStaticCompositeSegments({
      width,
      height,
      count,
    });
    compositeSlotState.staticSegments = nextSegments;
    return nextSegments;
  }

  private _disposeTextureCompositeState(binding: BindingState): void {
    const compositeState = binding.textureComposite;
    if (!compositeState) {
      return;
    }

    compositeState.slotStates.forEach((slotState) => {
      slotState.texture.dispose();
    });
    binding.textureSlots.forEach((slotState) => {
      setTextureSlot(
        compositeState.materialClone,
        slotState.slot,
        slotState.texture,
      );
    });
    binding.object.material = binding.originalMaterial;
    compositeState.materialClone.dispose();
    binding.textureComposite = null;
  }

  private _redrawBindingTextureComposite(binding: BindingState): boolean {
    const textureEffects = this._getSortedTextureEffects(binding);
    const flattenState = this._getCachedFaceFlattenState(binding);
    const shouldRenderFlatten =
      flattenState.shouldRenderEyes || flattenState.shouldRenderMouth;
    if (textureEffects.length === 0 && !shouldRenderFlatten) {
      this._disposeTextureCompositeState(binding);
      return true;
    }

    const materialClone = this._ensureOverrideMaterial(binding);
    if (!materialClone) {
      binding.warning = `Unable to clone material for "${binding.materialName ?? binding.bindingKey}".`;
      return false;
    }
    const compositeState = this._ensureTextureCompositeState(
      binding,
      materialClone,
    );
    const activeSlots = new Set<AvatarVFXTextureSlot>();

    binding.textureSlots.forEach((slotState) => {
      const slotEffects = textureEffects.filter((effect) =>
        effect.layerCanvases.has(slotState.slot),
      );
      const clipPathsOf = (effect: ActiveBindingEffect) =>
        (effect.layerCanvases.get(slotState.slot)?.placements ?? []).flatMap(
          (placement) => (placement.clipPath ? [placement.clipPath] : []),
        );
      // A replacement below full opacity shows the original slot beneath it,
      // and one clipped to the face keeps the rest of a shared texture.
      const shouldDrawBaseTexture =
        slotEffects.length === 0 ||
        slotEffects.every(
          (effect) =>
            effect.applyMode === "overlay" ||
            this._resolveActiveEffectOpacity(effect) < 1 ||
            clipPathsOf(effect).length > 0,
        );
      // An opaque clipped replacement hides the original inside its clip (an
      // unclipped one leaves it out entirely), whichever static segment the
      // art itself lands in.
      const baseClips = slotEffects
        .filter(
          (effect) =>
            effect.applyMode === "replace" &&
            this._resolveActiveEffectOpacity(effect) >= 1,
        )
        .flatMap(clipPathsOf);
      const flattenColorForSlot =
        flattenState.sampledColorsBySlot[slotState.slot] ?? null;
      const shouldApplyFlattenToSlot =
        shouldRenderFlatten &&
        flattenColorForSlot !== null &&
        (slotState.slot === "map" ||
          slotState.slot === "shadeMultiplyTexture") &&
        shouldDrawBaseTexture;

      if (slotEffects.length === 0 && !shouldApplyFlattenToSlot) {
        const existingSlot =
          compositeState.slotStates.get(slotState.slot) ?? null;
        if (existingSlot) {
          existingSlot.texture.dispose();
          compositeState.slotStates.delete(slotState.slot);
        }
        setTextureSlot(materialClone, slotState.slot, slotState.texture);
        return;
      }

      const compositeSlotState = this._ensureCompositeSlotState({
        binding,
        slotState,
        materialClone,
      });
      activeSlots.add(slotState.slot);

      const animatedEffects = slotEffects.filter((effect) => effect.isAnimated);
      const shouldRebuildStaticCache =
        compositeState.staticCacheDirty ||
        compositeSlotState.baseDrawn !== shouldDrawBaseTexture ||
        compositeSlotState.baseClips.length !== baseClips.length ||
        baseClips.some((path, at) => compositeSlotState.baseClips[at] !== path);
      compositeSlotState.baseDrawn = shouldDrawBaseTexture;
      compositeSlotState.baseClips = baseClips;
      if (shouldRebuildStaticCache) {
        const staticSegments = this._ensureStaticCompositeSegments({
          compositeSlotState,
          width: slotState.width,
          height: slotState.height,
          count: animatedEffects.length + 1,
        });

        staticSegments.forEach((segment) => {
          segment.context.clearRect(0, 0, slotState.width, slotState.height);
        });

        if (shouldDrawBaseTexture) {
          const originalSource = getTextureImageSource(slotState.texture);
          if (originalSource) {
            staticSegments[0]?.context.drawImage(
              originalSource,
              0,
              0,
              slotState.width,
              slotState.height,
            );
          }
        }

        if (shouldApplyFlattenToSlot && staticSegments[0]) {
          const context = staticSegments[0].context;
          // On a face inside a whole-body primitive the cleanup keeps to the
          // face, like its decals.
          const regionClip = this._faceRegionClip(binding, slotState);
          context.save();
          if (regionClip) context.clip(regionClip);
          if (flattenState.shouldRenderEyes) {
            flattenState.eyeRegions.forEach((region) => {
              if (!flattenColorForSlot) return;
              drawFeatheredFlattenEllipse({
                context,
                region,
                fillColor: flattenColorForSlot,
                width: slotState.width,
                height: slotState.height,
              });
            });
          }
          if (
            flattenState.shouldRenderMouth &&
            flattenState.mouthRegion &&
            flattenColorForSlot
          ) {
            drawFeatheredFlattenEllipse({
              context,
              region: flattenState.mouthRegion,
              fillColor: flattenColorForSlot,
              width: slotState.width,
              height: slotState.height,
            });
          }
          context.restore();
        }

        const base = staticSegments[0]?.context;
        if (shouldDrawBaseTexture && base) {
          for (const path of baseClips) {
            base.save();
            base.clip(path);
            base.clearRect(0, 0, slotState.width, slotState.height);
            base.restore();
          }
        }

        let staticSegmentIndex = 0;
        slotEffects.forEach((effect) => {
          if (effect.isAnimated) {
            staticSegmentIndex += 1;
            return;
          }
          const layerState = effect.layerCanvases.get(slotState.slot);
          if (!layerState) {
            return;
          }
          const segment = staticSegments[staticSegmentIndex];
          if (!segment) {
            return;
          }
          drawCompositedLayerCanvas({
            context: segment.context,
            layerState,
            effect: effect.effectEntry,
            size: {
              width: slotState.width,
              height: slotState.height,
            },
            animationState: effect.animationState,
            opacity: this._resolveActiveEffectOpacity(effect),
            tinted: (image) => this._tintedEffectImage(effect, image),
          });
        });
      }

      if (!shouldRebuildStaticCache && animatedEffects.length === 0) {
        return;
      }

      compositeSlotState.context.clearRect(
        0,
        0,
        slotState.width,
        slotState.height,
      );
      const staticSegments = this._ensureStaticCompositeSegments({
        compositeSlotState,
        width: slotState.width,
        height: slotState.height,
        count: animatedEffects.length + 1,
      });
      staticSegments.forEach((segment, index) => {
        compositeSlotState.context.drawImage(
          segment.canvas,
          0,
          0,
          slotState.width,
          slotState.height,
        );
        const animatedEffect = animatedEffects[index];
        if (!animatedEffect) {
          return;
        }
        const layerState = animatedEffect.layerCanvases.get(slotState.slot);
        if (!layerState) {
          return;
        }
        drawCompositedLayerCanvas({
          context: compositeSlotState.context,
          layerState,
          effect: animatedEffect.effectEntry,
          size: {
            width: slotState.width,
            height: slotState.height,
          },
          animationState: animatedEffect.animationState,
          opacity: this._resolveActiveEffectOpacity(animatedEffect),
          tinted: (image) => this._tintedEffectImage(animatedEffect, image),
        });
      });

      compositeSlotState.texture.needsUpdate = true;
      setTextureSlot(materialClone, slotState.slot, compositeSlotState.texture);
    });

    Array.from(compositeState.slotStates.keys()).forEach((slot) => {
      if (activeSlots.has(slot)) {
        return;
      }
      const existingSlot = compositeState.slotStates.get(slot);
      if (!existingSlot) {
        return;
      }
      existingSlot.texture.dispose();
      compositeState.slotStates.delete(slot);
    });

    materialClone.needsUpdate = true;
    compositeState.staticCacheDirty = false;
    return activeSlots.size > 0;
  }

  private _resolveActiveEffectOpacity(effect: ActiveBindingEffect): number {
    return resolveEffectiveOpacity({
      effect: effect.effectEntry,
      animationState: effect.animationState,
      intensity: effect.intensity,
    });
  }

  /** Return the effect's image tinted by its appearance, cached per image. */
  private _tintedEffectImage(
    effect: ActiveBindingEffect,
    image: CanvasImageSource,
  ): CanvasImageSource {
    const tint = resolveAppearance(effect.effectEntry).tint;
    if (!tint) return image;
    const cached = effect.tintedImages.get(image);
    if (cached) return cached;
    const tinted = createTintedImage(image, tint);
    if (!tinted) return image;
    effect.tintedImages.set(image, tinted);
    return tinted;
  }

  /** Consume an envelope value set before the effect finished applying. */
  private _takePendingIntensity(appliedEffectId: string): number {
    const pending = this._pendingIntensities.get(appliedEffectId);
    this._pendingIntensities.delete(appliedEffectId);
    return pending ?? 1;
  }

  private _ensureOverrideMaterial(
    binding: BindingState,
  ): THREE.Material | null {
    if (binding.textureComposite?.materialClone) {
      return binding.textureComposite.materialClone;
    }

    const originalMainMaterial = binding.originalMainMaterial;
    if (!originalMainMaterial) return null;

    const materialClone = originalMainMaterial.clone();
    if (Array.isArray(binding.originalMaterial)) {
      const nextMaterial = [...binding.originalMaterial];
      nextMaterial[0] = materialClone;
      binding.object.material = nextMaterial;
    } else {
      binding.object.material = materialClone;
    }
    materialClone.needsUpdate = true;
    return materialClone;
  }

  private _restoreBinding(binding: BindingState) {
    const activeEffectIds = Array.from(binding.activeEffects.keys());
    activeEffectIds.forEach((appliedEffectId) => {
      this._removeAppliedEffect(appliedEffectId, { emit: false });
    });
    binding.warning = null;
  }

  private _removeAppliedEffect(
    appliedEffectId: string,
    options?: { emit?: boolean },
  ): boolean {
    if (!appliedEffectId) {
      return false;
    }

    for (const binding of this._bindings.values()) {
      const activeEffect = binding.activeEffects.get(appliedEffectId) ?? null;
      if (!activeEffect) {
        continue;
      }

      this._releaseActiveEffectResources(binding, activeEffect);
      binding.activeEffects.delete(appliedEffectId);
      this._cachedFaceFlattenState = null;

      if (
        activeEffect.renderMode === "texture" ||
        binding.textureComposite !== null
      ) {
        this._markTextureCompositeStaticDirty(binding);
        this._redrawBindingTextureComposite(binding);
      }
      if (
        isEyeHoverVFXEntry(activeEffect.effectEntry) ||
        isMouthHoverVFXEntry(activeEffect.effectEntry)
      ) {
        this._refreshFaceFlattenComposite();
      }

      this._syncForcedBlinkExpression();
      if (options?.emit !== false) {
        this._emit();
      }
      return true;
    }

    return false;
  }

  private _removeAppliedEffectsInRegion(
    region: AvatarVFXRegion,
    options?: { emit?: boolean },
  ): number {
    const appliedEffectIds = new Set<string>();

    for (const binding of this._bindings.values()) {
      for (const activeEffect of binding.activeEffects.values()) {
        if (getAvatarVFXRegion(activeEffect.effectEntry) !== region) {
          continue;
        }
        appliedEffectIds.add(activeEffect.appliedEffectId);
      }
    }

    let removedCount = 0;
    for (const appliedEffectId of appliedEffectIds) {
      if (this._removeAppliedEffect(appliedEffectId, { emit: false })) {
        removedCount += 1;
      }
    }

    if (removedCount > 0 && options?.emit !== false) {
      this._emit();
    }

    return removedCount;
  }

  private _releaseActiveEffectResources(
    binding: BindingState,
    activeEffect: ActiveBindingEffect,
  ): void {
    this._releaseAutoDisabledBindings(activeEffect);
    if (activeEffect.hoverGroup) {
      activeEffect.hoverGroup.removeFromParent();
      disposeObjectTree(activeEffect.hoverGroup);
    }
    if (
      binding.activeEffects.size === 1 &&
      activeEffect.renderMode === "texture"
    ) {
      this._disposeTextureCompositeState(binding);
    }
  }

  /**
   * Hold the blink override at the strongest envelope of the effects that
   * close the eyes, so a fading effect opens and closes them gradually.
   */
  private _syncForcedBlinkExpression(): void {
    let weight = 0;
    for (const binding of this._bindings.values()) {
      for (const effect of binding.activeEffects.values()) {
        if (effect.forcesBlink) weight = Math.max(weight, effect.intensity);
      }
    }
    if (weight > 0) {
      this._avatar.setExpression(EYE_HOVER_FORCE_BLINK_EXPRESSION, weight);
      return;
    }
    this._avatar.clearExpressionOverride(EYE_HOVER_FORCE_BLINK_EXPRESSION);
  }

  /**
   * Follow an envelope change with the effect's face changes: the blink weight
   * tracks it, while hidden parts and face cleanup switch at
   * {@link FACE_CHANGE_MIN_INTENSITY}.
   */
  private _syncEffectFaceChanges(
    binding: BindingState,
    active: ActiveBindingEffect,
    previousIntensity: number,
  ): void {
    if (active.forcesBlink) this._syncForcedBlinkExpression();
    const wasOn = previousIntensity >= FACE_CHANGE_MIN_INTENSITY;
    const isOn = active.intensity >= FACE_CHANGE_MIN_INTENSITY;
    if (wasOn === isOn) return;
    if (isOn) {
      active.disabledBindingKeys = this._applyAutoDisabledBindings(
        active.appliedEffectId,
        binding,
        active.autoDisabledRoles,
      );
    } else {
      this._releaseAutoDisabledBindings(active);
      active.disabledBindingKeys = [];
    }
    const entry = active.effectEntry;
    if (
      isEyeHoverVFXEntry(entry) ||
      isMouthHoverVFXEntry(entry) ||
      (isFaceAnchoredVFXEntry(entry) && entry.anchor === "mouth")
    ) {
      this._refreshFaceFlattenComposite();
    }
    this._emit();
  }

  private _applyAutoDisabledBindings(
    sourceEffectId: string,
    sourceBinding: BindingState | null,
    disableTargetRoles: AvatarVFXTargetRole[],
  ): string[] {
    if (disableTargetRoles.length === 0) return [];
    this._hideRegions(sourceEffectId, sourceBinding, disableTargetRoles);

    const map = this._avatar.facePartMap;
    const disabledBindingKeys: string[] = [];
    this._bindings.forEach((binding) => {
      if (binding.bindingKey === sourceBinding?.bindingKey) return;
      // Face skin that is only a head region is hidden as that region, not
      // with the whole body its primitive holds.
      const roles = findFaceSkinRegion(map, binding.bindingKey)
        ? binding.targetRoles.filter((role) => role !== "face_skin")
        : binding.targetRoles;
      if (!bindingIsHiddenByRoles(roles, disableTargetRoles)) {
        return;
      }
      if (binding.autoDisableSources.size === 0) {
        binding.visibleBeforeAutoDisable = binding.object.visible;
      }
      binding.autoDisableSources.add(sourceEffectId);
      binding.object.visible = false;
      disabledBindingKeys.push(binding.bindingKey);
    });
    return disabledBindingKeys;
  }

  /**
   * Hide the irises while `Fcl_EYE_Iris_Hide` is held on a model without a
   * shape of that name (`irisHideExpression.ts`), as eye effects hide parts:
   * counted with them, and applied again when the face parts are rebuilt.
   */
  setIrisHidden(hidden: boolean): void {
    if (this._isDisposed || hidden === (this._irisHideKeys !== null)) return;
    if (hidden) {
      this._irisHideKeys = this._applyAutoDisabledBindings(
        IRIS_HIDE_SOURCE,
        null,
        ["eye_iris"],
      );
      if (this._irisHideKeys.length === 0) {
        // No iris was found, or it shares a mesh part with the face skin.
        this._pushWarning(
          { code: "iris_hide_unavailable" },
          "Fcl_EYE_Iris_Hide plays, but no iris mesh part can be hidden on this Avatar.",
        );
      }
    } else {
      this._releaseAutoDisabledBindings({
        appliedEffectId: IRIS_HIDE_SOURCE,
        disabledBindingKeys: this._irisHideKeys ?? [],
      });
      this._irisHideKeys = null;
    }
  }

  /**
   * Draw every hidden eye-detail region again, before the face parts are
   * measured anew; `refreshFaceParts` then hides what active effects need.
   */
  restoreHiddenRegions(): void {
    this._regionHider.restoreAll();
  }

  /**
   * Hide the parts kept as regions of shared primitives (part `regions`),
   * which hiding whole primitives cannot reach: eye lines and lashes inside
   * the face or eye primitives, or inside a primitive holding no part (a lash
   * mesh shared with the brows), and face skin that is the head region of a
   * primitive holding the whole body. The face the effect's own art is on
   * (`sourceBinding`) stays visible, as a hidden binding would.
   */
  private _hideRegions(
    sourceEffectId: string,
    sourceBinding: BindingState | null,
    roles: readonly AvatarVFXTargetRole[],
  ): void {
    const map = this._avatar.facePartMap;
    if (!map) return;
    for (const role of HIDDEN_REGION_ROLES) {
      if (!roles.includes(role)) continue;
      for (const region of map.parts[role].regions ?? []) {
        if (
          role === "face_skin" &&
          region.bindingKey === sourceBinding?.bindingKey
        ) {
          continue;
        }
        const object =
          this._bindings.get(region.bindingKey)?.object ??
          this._primitivesByKey.get(region.bindingKey);
        if (!object) continue;
        const hidden = this._regionHider.hide(
          sourceEffectId,
          object.geometry,
          region.triangles,
        );
        if (!hidden) {
          this._pushWarning(
            {
              code: "eye_detail_not_hidden",
              params: { effectId: sourceEffectId, part: role },
            },
            `Could not hide the ${AVATAR_FACE_PART_LABELS[role]} inside ${region.bindingKey}: the primitive is not indexed.`,
          );
        }
      }
    }
  }

  private _releaseAutoDisabledBindings(
    activeEffect: Pick<
      ActiveBindingEffect,
      "appliedEffectId" | "disabledBindingKeys"
    >,
  ): void {
    this._regionHider.release(activeEffect.appliedEffectId);
    const disabledBindingKeys = activeEffect.disabledBindingKeys;
    disabledBindingKeys.forEach((bindingKey) => {
      const binding = this._bindings.get(bindingKey);
      if (!binding) return;
      binding.autoDisableSources.delete(activeEffect.appliedEffectId);
      if (binding.autoDisableSources.size > 0) return;
      binding.object.visible =
        binding.visibleBeforeAutoDisable ?? binding.originalVisible;
      binding.visibleBeforeAutoDisable = null;
    });
  }

  private _createHoverEffectGroup(args: {
    binding: BindingState;
    effect: AvatarHoverVFXEntry;
    effectImage: CanvasImageSource;
    otherImage: CanvasImageSource | null;
  }): HoverEffectGroupState | null {
    const { binding, effect, effectImage, otherImage } = args;
    const faceLandmarks = this._avatar.getFaceLandmarksSnapshot();
    const faceTextureAnchors = this._avatar.getFaceTextureAnchorsSnapshot();
    const anchorObject = this._avatar.faceLandmarks?.getAnchorObject() ?? null;
    if (!faceLandmarks || faceLandmarks.status !== "ready" || !anchorObject) {
      binding.warning =
        "Face landmarks are unavailable for hover-plane VFX placement.";
      return null;
    }

    if (isEyeHoverVFXEntry(effect) && !this._bindingServes(binding, effect)) {
      binding.warning = `Effect "${effect.label}" requires an eye iris target.`;
      return null;
    }
    if (
      isBoxHoverVFXEntry(effect) &&
      !binding.targetRoles.includes("face_skin")
    ) {
      binding.warning = `Effect "${effect.label}" requires a face skin target.`;
      return null;
    }
    if (
      isMouthHoverVFXEntry(effect) &&
      !binding.targetRoles.includes("face_skin")
    ) {
      binding.warning = `Effect "${effect.label}" requires a face skin target.`;
      return null;
    }
    if (isMouthHoverVFXEntry(effect)) {
      if (!faceTextureAnchors || faceTextureAnchors.status !== "ready") {
        binding.warning =
          faceTextureAnchors?.warnings[0] ??
          "Face texture anchors are unavailable for mouth hover placement.";
        return null;
      }
      if (
        faceTextureAnchors.faceBindingKey &&
        faceTextureAnchors.faceBindingKey !== binding.bindingKey
      ) {
        binding.warning = `Effect "${effect.label}" requires the resolved face skin binding.`;
        return null;
      }
      if (!faceTextureAnchors.anchors.mouth.center) {
        binding.warning = `Effect "${effect.label}" requires a resolved mouth anchor.`;
        return null;
      }
    }

    const proportions = measureAvatarProportions(this._avatar.vrm);
    const placements = resolveHoverPlacementInstances({
      effect,
      faceLandmarks,
      faceTextureAnchors,
      proportions,
    });
    if (!placements || placements.length === 0) {
      binding.warning = `Effect "${effect.label}" did not resolve any hover placements.`;
      return null;
    }

    // A flipbook plane takes its aspect from one frame, not the whole sheet.
    const imageSize = resolveArtFrameSize(effectImage, effect.flipbook);
    if (!imageSize) {
      binding.warning = `Effect "${effect.label}" has no readable image size.`;
      return null;
    }

    const staticScaleX = resolveStaticScaleComponent(effect.transform.scale.x);
    const staticScaleY = resolveStaticScaleComponent(effect.transform.scale.y);
    const staticScaleZ = resolveStaticScaleComponent(effect.transform.scale.z);
    const hoverBackdropSourceBinding = hasHoverSkinBackdrop(
      effect,
      faceLandmarks,
    )
      ? this._resolveFaceFlattenBinding()
      : null;
    const hoverSkinBackdropColor = hoverBackdropSourceBinding
      ? this._getCachedFaceFlattenState(hoverBackdropSourceBinding).sampledColor
      : null;
    if (
      hasHoverSkinBackdrop(effect, faceLandmarks) &&
      !hoverSkinBackdropColor
    ) {
      this._pushWarning(
        {
          code: "effect_skin_color_unavailable",
          params: { effectId: effect.id },
        },
        `Unable to sample a face skin color for hover backdrop on "${effect.label}".`,
      );
    }
    const resolvedPlacements = placements
      .map((placement) => {
        if (isEyeHoverVFXEntry(effect)) {
          const planeHeight = resolveEyeHoverPlaneHeight(faceLandmarks);
          return {
            placement,
            planeSize: {
              width:
                planeHeight * (imageSize.width / Math.max(1, imageSize.height)),
              height: planeHeight,
            },
          };
        }
        if (isBoxHoverVFXEntry(effect)) {
          const planeHeight =
            BOX_HOVER_PLANE_HEIGHT *
            headSized(proportions, 1, proportions.headScale);
          return {
            placement,
            planeSize: {
              width:
                planeHeight * (imageSize.width / Math.max(1, imageSize.height)),
              height: planeHeight,
            },
          };
        }
        if (!placement.referenceSizeLocal) {
          return null;
        }
        return {
          placement,
          planeSize: resolvePlacementSizeFromReferenceSize({
            referenceSize: placement.referenceSizeLocal,
            imageSize,
          }),
        };
      })
      .filter(
        (
          value,
        ): value is {
          placement: HoverPlacementInstance;
          planeSize: Size;
        } => value !== null,
      );
    if (resolvedPlacements.length !== placements.length) {
      binding.warning = `Effect "${effect.label}" did not resolve any hover plane size.`;
      return null;
    }

    const appearance = resolveAppearance(effect);
    const texture = createTextureFromImage(effectImage);
    const otherTexture = otherImage ? createTextureFromImage(otherImage) : null;
    for (const value of [texture, otherTexture]) {
      if (value) applyFlipbookFrameToTexture(value, effect.flipbook, 0);
    }
    const facingRotationY = resolveHoverFacingRotationY(faceLandmarks);

    const group = new THREE.Group();
    group.name = `AvatarHoverVFX:${effect.id}`;
    group.renderOrder = HOVER_RENDER_ORDER;
    group.frustumCulled = false;
    const instances: HoverPlaneInstanceState[] = [];
    const runtimeMaterials: THREE.Material[] = [];

    resolvedPlacements.forEach(({ placement, planeSize }) => {
      const geometry = new THREE.PlaneGeometry(
        planeSize.width,
        planeSize.height,
      );
      // The mirrored eye uses its own art, unmirrored, when the effect has one.
      const usesOtherArt = placement.mirrored && otherTexture !== null;
      const placementTexture = usesOtherArt ? otherTexture : texture;
      const mirrorScale = placement.mirrored && !usesOtherArt ? -1 : 1;
      const material = new THREE.MeshBasicMaterial({
        map: placementTexture,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        opacity: appearance.opacity,
      });
      if (appearance.tint) material.color.set(appearance.tint);
      configureEffectBlend(material, appearance.blend);
      const placementRoot = new THREE.Group();
      placementRoot.name = `${effect.id}:${placement.label}:anchor`;
      placementRoot.position.copy(placement.position);
      placementRoot.rotation.y = facingRotationY;
      placementRoot.renderOrder = HOVER_RENDER_ORDER;
      placementRoot.frustumCulled = false;

      const animatedGroup = new THREE.Group();
      animatedGroup.name = `${effect.id}:${placement.label}:animated`;
      animatedGroup.renderOrder = HOVER_RENDER_ORDER;
      animatedGroup.frustumCulled = false;

      // Rotate the image and its backdrop together without animation overwriting it.
      const staticGroup = new THREE.Group();
      staticGroup.rotation.set(
        effect.transform.rotation.x,
        effect.transform.rotation.y,
        effect.transform.rotation.z,
      );
      animatedGroup.add(staticGroup);

      let backdropMaterialForFade: THREE.Material | null = null;
      let backdropMeshForUpdate: THREE.Mesh | null = null;
      let coverPatch: HoverPlaneInstanceState["coverPatch"] = null;
      const cover = isEyeHoverVFXEntry(effect) ? placement.closedCover : null;
      if (hoverSkinBackdropColor && hoverBackdropSourceBinding && cover) {
        // A closed-eye patch: the eye's closed cover, whatever the art's size.
        const size = cover.getSize(new THREE.Vector3());
        const spacing = Math.abs(
          (faceLandmarks.eyes.left?.centerLocal.x ?? 0) -
            (faceLandmarks.eyes.right?.centerLocal.x ?? 0),
        );
        const patchMaterial = createHoverSkinBackdropMaterial({
          sourceBinding: hoverBackdropSourceBinding,
          fillColor: hoverSkinBackdropColor,
          feather: CLOSED_EYE_PATCH_FEATHER,
        });
        if (patchMaterial) {
          const patch = new THREE.Mesh(
            new THREE.PlaneGeometry(
              Math.min(
                size.x * CLOSED_EYE_PATCH_SCALE,
                spacing * CLOSED_EYE_PATCH_MAX_SHARE.width,
              ),
              Math.min(
                size.y * CLOSED_EYE_PATCH_SCALE,
                spacing * CLOSED_EYE_PATCH_MAX_SHARE.height,
              ),
            ),
            patchMaterial,
          );
          patch.name = `${effect.id}:${placement.label}:closed-eye-patch`;
          const center = closedEyePatchCenter(
            cover,
            resolveHoverFrontSign(faceLandmarks),
          );
          placeCoverPatch(patch, center, placement.position, facingRotationY);
          patch.renderOrder = HOVER_RENDER_ORDER - 1;
          patch.frustumCulled = false;
          // three sorts by the nearest group's render order first: the art's
          // static group has none, so the patch's group has none either and
          // the patch draws just before the art.
          const patchGroup = new THREE.Group();
          patchGroup.name = `${effect.id}:${placement.label}:closed-eye`;
          patchGroup.add(patch);
          placementRoot.add(patchGroup);
          runtimeMaterials.push(patchMaterial);
          backdropMaterialForFade = patchMaterial;
          coverPatch = { mesh: patch, center };
        }
      } else if (hoverSkinBackdropColor && hoverBackdropSourceBinding) {
        const backdropGeometry = new THREE.PlaneGeometry(
          planeSize.width * HOVER_SKIN_BACKDROP_WIDTH_SCALE,
          planeSize.height * HOVER_SKIN_BACKDROP_HEIGHT_SCALE,
        );
        const backdropMaterial = createHoverSkinBackdropMaterial({
          sourceBinding: hoverBackdropSourceBinding,
          fillColor: hoverSkinBackdropColor,
        });
        if (backdropMaterial) {
          const backdropMesh = new THREE.Mesh(
            backdropGeometry,
            backdropMaterial,
          );
          backdropMesh.name = `${effect.id}:${placement.label}:backdrop`;
          backdropMesh.position.z = HOVER_SKIN_BACKDROP_Z_OFFSET;
          backdropMesh.scale.set(
            (placement.mirrored ? -1 : 1) * staticScaleX,
            staticScaleY,
            staticScaleZ,
          );
          backdropMesh.renderOrder = HOVER_RENDER_ORDER - 1;
          backdropMesh.frustumCulled = false;
          staticGroup.add(backdropMesh);
          runtimeMaterials.push(backdropMaterial);
          backdropMaterialForFade = backdropMaterial;
          backdropMeshForUpdate = backdropMesh;
        }
      }

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `${effect.id}:${placement.label}`;
      mesh.scale.set(mirrorScale * staticScaleX, staticScaleY, staticScaleZ);
      mesh.renderOrder = HOVER_RENDER_ORDER;
      mesh.frustumCulled = false;
      staticGroup.add(mesh);
      placementRoot.add(animatedGroup);
      group.add(placementRoot);
      instances.push({
        label: placement.label,
        mesh,
        placementRoot,
        animatedGroup,
        staticGroup,
        backdropMesh: backdropMeshForUpdate,
        coverPatch,
        baseWidth: planeSize.width,
        baseHeight: planeSize.height,
        planeWidth: planeSize.width * staticScaleX,
        planeHeight: planeSize.height * staticScaleY,
        mirrored: placement.mirrored,
        material,
        texture: placementTexture,
        backdropMaterial: backdropMaterialForFade,
        backdropBaseOpacity: backdropMaterialForFade?.opacity ?? 1,
      });
      if (backdropMaterialForFade) {
        backdropMaterialForFade.opacity *= appearance.opacity;
      }
    });

    if (
      otherTexture &&
      !instances.some((value) => value.texture === otherTexture)
    ) {
      otherTexture.dispose();
    }
    anchorObject.add(group);
    binding.warning = null;
    return {
      group,
      instances,
      runtimeMaterials,
    };
  }

  private _createSnapshot(): AvatarVFXSnapshot {
    const flatten = this._createFlattenSnapshot();
    const targetBindings: AvatarVFXTargetBindingSnapshot[] = Array.from(
      this._bindings.values(),
    )
      .map((binding) => {
        const activeEffects = this._getSortedActiveEffects(binding);
        const topEffect =
          activeEffects.length > 0
            ? (activeEffects[activeEffects.length - 1] ?? null)
            : null;
        return {
          bindingKey: binding.bindingKey,
          targetRole: binding.targetRole,
          targetRoles: [...binding.targetRoles],
          materialIndex: binding.materialIndex,
          materialName: binding.materialName,
          objectName: binding.objectName,
          objectType: binding.objectType,
          textureSlots: getTextureSlotSnapshots(binding.textureSlots),
          availableEffectIds: binding.availableEffectIds,
          activeEffectId: topEffect?.effectId ?? null,
          activeEffectIds: activeEffects.map((effect) => effect.effectId),
          activeEffectCount: activeEffects.length,
          activeAnimationPreset: topEffect?.animationPreset ?? null,
          activeApplyMode: topEffect?.applyMode ?? null,
          warning: binding.warning,
        };
      })
      .sort((a, b) => {
        if (a.targetRole !== b.targetRole) {
          return a.targetRole.localeCompare(b.targetRole);
        }
        return (a.materialName ?? "").localeCompare(b.materialName ?? "");
      });

    const activeEffects: AvatarVFXAppliedEffectSnapshot[] = Array.from(
      this._bindings.values(),
    ).flatMap((binding) =>
      this._getSortedActiveEffects(binding).map((activeEffect) => {
        const resolvedEffect = cloneCatalogEffectEntry(
          activeEffect.effectEntry,
        );
        return {
          appliedEffectId: activeEffect.appliedEffectId,
          bindingKey: binding.bindingKey,
          targetRole: binding.targetRole,
          materialName: binding.materialName,
          effectId: activeEffect.effectId,
          effectLabel: resolvedEffect.label,
          renderMode: activeEffect.renderMode,
          animationPreset: activeEffect.animationPreset,
          applyMode:
            activeEffect.applyMode ?? getAvatarVFXApplyMode(resolvedEffect),
          effect: resolvedEffect,
          transform: cloneEffectTransform(resolvedEffect.transform),
          animationConfig: activeEffect.animationConfig,
        };
      }),
    );

    return {
      catalog: [...this._catalog],
      targetBindings,
      activeEffects,
      attachmentEffects: this._attachments.snapshot(),
      flatten,
      warnings: [...this._warnings],
      issues: [...this._issues],
    };
  }

  private _createObservationSnapshot(): AvatarVFXObservationSnapshot {
    return {
      activeEffects: [
        ...Array.from(this._bindings.values()).flatMap((binding) =>
          this._getSortedActiveEffects(binding).map((effect) => ({
            effectId: effect.effectId,
            targetRole: binding.targetRole,
            animationPreset: effect.animationPreset,
            renderMode: effect.renderMode,
          })),
        ),
        ...this._attachments.snapshot().map((effect) => ({
          effectId: effect.effectId,
          targetRole: effect.attachmentKind,
          animationPreset: effect.animationPreset,
          renderMode: effect.renderMode,
        })),
      ],
      warningCount: this._warnings.length,
    };
  }

  private _createFlattenSnapshot(): AvatarVFXFaceFlattenSnapshot {
    const state = this._getCachedFaceFlattenState(
      this._resolveFaceFlattenBinding(),
    );
    return {
      status: state.status,
      faceBindingKey: state.faceBindingKey,
      previewEyes: state.previewEyes,
      previewMouth: state.previewMouth,
      autoEyes: state.autoEyes,
      autoMouth: state.autoMouth,
      activeEyes: state.activeEyes,
      activeMouth: state.activeMouth,
      sampledColor: state.sampledColor,
      warning: state.warning,
    };
  }

  /** Record a finding as dev-panel text and as a stable code, then emit. */
  private _pushWarning(issue: AvatarIssue, message: string) {
    addAvatarIssue(this._issues, issue);
    this._warnings = Array.from(
      new Set(
        [...this._warnings, message]
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      ),
    );
    this._emit();
  }

  private _emit() {
    this._snapshot = this._createSnapshot();
    this._observationSnapshot = this._createObservationSnapshot();
    if (this._isDisposed) return;
    this._listeners.forEach((listener) => {
      listener();
    });
  }
}

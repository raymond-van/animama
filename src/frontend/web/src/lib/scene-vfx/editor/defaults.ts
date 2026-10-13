import { getSceneFocusLinesVFXPresetById } from "@/lib/scene-vfx/presets";
import type {
  SceneBackgroundLinesScreen,
  SceneBackgroundRaysScreen,
} from "@/lib/scene-vfx/types";
import type {
  SceneEffectEditorBackground,
  SceneEffectEditorDocument,
  SceneEffectEditorFocus,
  SceneEffectEditorScatter,
} from "./types";
import { SCENE_EFFECT_EDITOR_SCHEMA } from "./types";

/** Default Anima-theme background used by the live chat canvas. */
export const DEFAULT_SCENE_SOLID_COLOR = "#faf9f5";

/** Default Anima-theme primary blue used by the Scene pattern layer. */
export const DEFAULT_SCENE_PATTERN_COLOR = "#87ceeb";

export function createDefaultSceneEffectDocument(): SceneEffectEditorDocument {
  return {
    schema: SCENE_EFFECT_EDITOR_SCHEMA,
    name: "",
    description: "",
    kind: "background_layers",
    durationMs: 5000,
    coverUiOverlays: false,
    dismissOnInput: true,
    sound: null,
    background: emptyBackground(),
    focus: defaultFocus(),
  };
}

/** Rays radiating from behind the head, turning once a minute. */
export function defaultSceneRaysScreen(
  enabled = false,
): SceneBackgroundRaysScreen {
  return {
    enabled,
    kind: "rays",
    color: "#ffffff",
    opacity: 0.4,
    count: 20,
    centerX: 0.5,
    centerY: 0.3,
    spiky: false,
    turnSeconds: 60,
    throbPerSec: 0,
    seed: 1,
  };
}

/** Lines hanging from the top edge, swaying slowly. */
export function defaultSceneLinesScreen(
  enabled = false,
): SceneBackgroundLinesScreen {
  return {
    enabled,
    kind: "lines",
    color: "#1d2a40",
    opacity: 0.5,
    count: 34,
    minLength: 0.2,
    maxLength: 0.7,
    minWidthPx: 1.5,
    maxWidthPx: 3,
    swaySeconds: 5,
    seed: 1,
  };
}

/** A new scatter layer: still items, kept clear of the face, twinkling. */
export function defaultSceneScatter(seed = 1): SceneEffectEditorScatter {
  return {
    enabled: true,
    items: [],
    count: 12,
    seed,
    minSize: 24,
    maxSize: 48,
    minRotationDeg: 0,
    maxRotationDeg: 0,
    minOpacity: 0.8,
    maxOpacity: 1,
    regionTop: 0,
    regionBottom: 1,
    keepFaceClear: true,
    direction: "static",
    speedPxPerSec: 0,
    minSpinDegPerSec: 0,
    maxSpinDegPerSec: 0,
    alternateSpin: false,
    pulse: "twinkle",
  };
}

/** The optional layers (C1–C6), all off: a background without them. */
export function defaultSceneOptionalLayers(): Pick<
  SceneEffectEditorBackground,
  "gradient" | "tile" | "screen" | "scatters" | "flash"
> {
  return {
    gradient: {
      enabled: false,
      type: "radial",
      angleDeg: 180,
      centerX: 0.5,
      centerY: 0.3,
      stops: [
        { color: "#ffffff", position: 0 },
        { color: DEFAULT_SCENE_PATTERN_COLOR, position: 1 },
      ],
    },
    tile: {
      enabled: false,
      image: null,
      size: 160,
      opacity: 0.4,
      direction: "up",
      speedPxPerSec: 8,
    },
    screen: defaultSceneRaysScreen(),
    scatters: [],
    flash: { enabled: false, color: "#ffffff", durationMs: 260 },
  };
}

/** Start new documents with the three independently editable layers enabled. */
function emptyBackground(): SceneEffectEditorBackground {
  return {
    ...defaultSceneOptionalLayers(),
    solid: { enabled: true, color: DEFAULT_SCENE_SOLID_COLOR },
    pattern: {
      enabled: true,
      pattern: "polkadot",
      color: DEFAULT_SCENE_PATTERN_COLOR,
      size: 32,
      spacing: 32,
      opacity: 0.35,
    },
    marquee: {
      enabled: true,
      items: [],
      itemSize: 96,
      gap: 40,
      rowGap: 64,
      direction: "static",
      itemRotationMode: "upright",
      itemRotationOffsetDeg: 0,
      speedPxPerSec: 0,
      opacity: 1,
    },
  };
}

/** Focus lines start as the bundled Dark focus preset. */
function defaultFocus(): SceneEffectEditorFocus {
  const entry = getSceneFocusLinesVFXPresetById("dark");
  return {
    renderPlacement: entry.renderPlacement,
    lineCount: entry.lineCount,
    color: entry.color,
    opacity: entry.opacity,
    baseThicknessPx: entry.baseThicknessPx,
    thicknessVariationPx: entry.thicknessVariationPx,
    lengthVariation: entry.lengthVariation,
    overscanPx: entry.overscanPx,
    target: structuredClone(entry.target),
    animation: { ...entry.animation },
    seed: entry.seed ?? null,
  };
}

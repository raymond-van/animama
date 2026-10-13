import { getSceneFocusLinesVFXPresetById } from "@/lib/scene-vfx/presets";
import type {
  SceneBackgroundFlashLayer,
  SceneBackgroundGradientLayer,
  SceneBackgroundLinesScreen,
  SceneBackgroundMarqueeLayer,
  SceneBackgroundPatternLayer,
  SceneBackgroundRaysScreen,
  SceneBackgroundScreenLayer,
  SceneBackgroundSolidLayer,
} from "@/lib/scene-vfx/types";
import affectionLove from "../../../../../../../content/included/vfx/scene/scene-vfx-emotion-love/scene-vfx-emotion-love.json";
import alarmFear from "../../../../../../../content/included/vfx/scene/scene-vfx-emotion-fear/scene-vfx-emotion-fear.json";
import delightJoy from "../../../../../../../content/included/vfx/scene/scene-vfx-emotion-joy/scene-vfx-emotion-joy.json";
import driveOptimism from "../../../../../../../content/included/vfx/scene/scene-vfx-emotion-optimism/scene-vfx-emotion-optimism.json";
import esteemConfidence from "../../../../../../../content/included/vfx/scene/scene-vfx-emotion-confidence/scene-vfx-emotion-confidence.json";
import gloomSadness from "../../../../../../../content/included/vfx/scene/scene-vfx-emotion-sadness/scene-vfx-emotion-sadness.json";
import rejectionAnger from "../../../../../../../content/included/vfx/scene/scene-vfx-emotion-anger/scene-vfx-emotion-anger.json";
import revulsionDisgust from "../../../../../../../content/included/vfx/scene/scene-vfx-emotion-disgust/scene-vfx-emotion-disgust.json";
import type {
  SceneEffectBackgroundTemplateId,
  SceneEffectEditorBackground,
  SceneEffectEditorDocument,
  SceneEffectEditorFocus,
  SceneEffectEditorScatter,
  SceneEffectFocusTemplateId,
  SceneEffectTemplateId,
} from "./types";
import { SCENE_EFFECT_EDITOR_SCHEMA } from "./types";

/** Default Anima-theme background used by the live chat canvas. */
export const DEFAULT_SCENE_SOLID_COLOR = "#faf9f5";

/** Default Anima-theme primary blue used by the Scene pattern layer. */
export const DEFAULT_SCENE_PATTERN_COLOR = "#87ceeb";

/** The layers of an Included background a template takes: those drawn in code. */
type IncludedSceneBackgroundDefinition = {
  solid: SceneBackgroundSolidLayer;
  pattern: SceneBackgroundPatternLayer;
  marquee: Omit<SceneBackgroundMarqueeLayer, "items">;
  gradient?: SceneBackgroundGradientLayer;
  screen?: SceneBackgroundScreenLayer;
  flash?: SceneBackgroundFlashLayer;
};

const definition = (descriptor: { definition: unknown }) =>
  descriptor.definition as IncludedSceneBackgroundDefinition;

/**
 * Each background template's source: one Included emotion background per
 * Scene family, read at build time, so a template follows its Included effect.
 */
const BACKGROUND_TEMPLATE_SOURCES: Record<
  SceneEffectBackgroundTemplateId,
  IncludedSceneBackgroundDefinition
> = {
  "shoujo-bloom": definition(affectionLove),
  radiance: definition(esteemConfidence),
  "festive-pop": definition(delightJoy),
  anticipation: definition(driveOptimism),
  shock: definition(alarmFear),
  rage: definition(rejectionAnger),
  queasy: definition(revulsionDisgust),
  gloom: definition(gloomSadness),
};

export const SCENE_EFFECT_TEMPLATE_OPTIONS: Array<{
  id: SceneEffectTemplateId;
  label: string;
  kind: "background_layers" | "focus_lines";
}> = [
  { id: "shoujo-bloom", label: "Shoujo Bloom", kind: "background_layers" },
  { id: "radiance", label: "Radiance", kind: "background_layers" },
  { id: "festive-pop", label: "Festive Pop", kind: "background_layers" },
  { id: "anticipation", label: "Anticipation", kind: "background_layers" },
  { id: "shock", label: "Shock", kind: "background_layers" },
  { id: "rage", label: "Rage", kind: "background_layers" },
  { id: "queasy", label: "Queasy", kind: "background_layers" },
  { id: "gloom", label: "Gloom", kind: "background_layers" },
  { id: "dark", label: "Dark Focus", kind: "focus_lines" },
  { id: "light-streak", label: "Light Streak", kind: "focus_lines" },
];

function isFocusTemplate(
  templateId: SceneEffectTemplateId,
): templateId is SceneEffectFocusTemplateId {
  return templateId === "dark" || templateId === "light-streak";
}

/** Clone a template into a private, independently editable draft. */
export function sceneEffectTemplate(
  templateId: SceneEffectTemplateId,
): Pick<SceneEffectEditorDocument, "kind" | "background" | "focus"> {
  return isFocusTemplate(templateId)
    ? {
        kind: "focus_lines",
        background: emptyBackground(),
        focus: defaultFocus(templateId),
      }
    : {
        kind: "background_layers",
        background: templateBackground(templateId),
        focus: defaultFocus("dark"),
      };
}

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
    focus: defaultFocus("dark"),
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

/**
 * A background template: its Included background's solid, pattern, gradient,
 * rays or lines and flash. The tile, scatter and marquee art belong to the
 * Included effect, so a template starts without images.
 */
function templateBackground(
  templateId: SceneEffectBackgroundTemplateId,
): SceneEffectEditorBackground {
  const source = structuredClone(BACKGROUND_TEMPLATE_SOURCES[templateId]);
  const optional = defaultSceneOptionalLayers();
  return {
    ...optional,
    solid: source.solid,
    pattern: source.pattern,
    marquee: { ...source.marquee, items: [] },
    gradient: source.gradient ?? optional.gradient,
    screen: source.screen ?? optional.screen,
    flash: source.flash ?? optional.flash,
  };
}

function defaultFocus(
  templateId: SceneEffectFocusTemplateId,
): SceneEffectEditorFocus {
  const entry = getSceneFocusLinesVFXPresetById(templateId);
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

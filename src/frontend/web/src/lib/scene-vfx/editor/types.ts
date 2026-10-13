import type { PyExactContentSource } from "@/lib/content/catalogTypes";
import type {
  SceneBackgroundDirection,
  SceneBackgroundFlashLayer,
  SceneBackgroundGradientLayer,
  SceneBackgroundItemRotationMode,
  SceneBackgroundPatternLayer,
  SceneBackgroundScatterLayer,
  SceneBackgroundScreenLayer,
  SceneBackgroundSolidLayer,
  SceneBackgroundTileLayer,
  SceneFocusLinesAnimation,
  SceneFocusLinesRenderPlacement,
  SceneFocusLinesTarget,
  SceneLegacyEmojiItem,
  SceneVFXKind,
} from "@/lib/scene-vfx/types";

export const SCENE_EFFECT_EDITOR_SCHEMA =
  "animama/scene-effect-editor/1" as const;

export type SceneEffectEditorImage = {
  logicalName: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string | null;
};

export type SceneEffectEditorImageResource = {
  logicalName: string;
  file: File;
  sha256: string;
};

export type SceneEffectEditorSound = {
  alias: string;
  label: string;
  source: PyExactContentSource;
};

/**
 * A Twemoji item from a Scene saved before the sticker set. Animama no longer
 * provides Twemoji, so the creator shows it as missing and refuses Save until
 * it is replaced with a sticker or image, or removed.
 */
export type SceneEffectEditorLegacyEmojiItem = SceneLegacyEmojiItem;

export type SceneEffectEditorImageItem = {
  id: string;
  kind: "image";
  label: string;
  image: SceneEffectEditorImage;
};

export type SceneEffectEditorMarqueeItem =
  | SceneEffectEditorImageItem
  | SceneEffectEditorLegacyEmojiItem;

export type SceneEffectEditorMarquee = {
  enabled: boolean;
  items: SceneEffectEditorMarqueeItem[];
  itemSize: number;
  gap: number;
  rowGap: number;
  direction: SceneBackgroundDirection;
  itemRotationMode: SceneBackgroundItemRotationMode;
  itemRotationOffsetDeg: number;
  speedPxPerSec: number;
  opacity: number;
};

/** A tile names a private image; it has none until one is chosen. */
export type SceneEffectEditorTile = Omit<SceneBackgroundTileLayer, "src"> & {
  image: SceneEffectEditorImage | null;
};

/** Scattered items are the effect's own images, as marquee items are. */
export type SceneEffectEditorScatter = Omit<
  SceneBackgroundScatterLayer,
  "items"
> & {
  items: SceneEffectEditorMarqueeItem[];
};

export type SceneEffectEditorBackground = {
  solid: SceneBackgroundSolidLayer;
  pattern: SceneBackgroundPatternLayer;
  marquee: SceneEffectEditorMarquee;
  gradient: SceneBackgroundGradientLayer;
  tile: SceneEffectEditorTile;
  screen: SceneBackgroundScreenLayer;
  /** Up to `SCENE_EFFECT_LIMITS.scatter.layers` scatter layers, in order. */
  scatters: SceneEffectEditorScatter[];
  flash: SceneBackgroundFlashLayer;
};

export type SceneEffectEditorFocus = {
  renderPlacement: SceneFocusLinesRenderPlacement;
  lineCount: number;
  color: string;
  opacity: number;
  baseThicknessPx: number;
  thicknessVariationPx: number;
  lengthVariation: number;
  overscanPx: number;
  target: SceneFocusLinesTarget;
  animation: SceneFocusLinesAnimation;
  seed: number | null;
};

export type SceneEffectEditorDocument = {
  schema: typeof SCENE_EFFECT_EDITOR_SCHEMA;
  name: string;
  description: string;
  kind: SceneVFXKind;
  durationMs: number | null;
  coverUiOverlays: boolean;
  dismissOnInput: boolean;
  sound: SceneEffectEditorSound | null;
  background: SceneEffectEditorBackground;
  focus: SceneEffectEditorFocus;
};

export type SceneEffectValidationIssue = {
  field: string;
  severity: "error" | "warning";
  message: string;
};

export type SceneEffectEditorAction =
  | { type: "replace"; document: SceneEffectEditorDocument }
  | { type: "set-kind"; kind: SceneVFXKind }
  | {
      type: "patch";
      patch: Partial<
        Omit<SceneEffectEditorDocument, "schema" | "background" | "focus">
      >;
    }
  | {
      type: "patch-background";
      patch: Partial<SceneEffectEditorBackground>;
    }
  | {
      type: "patch-solid";
      patch: Partial<SceneBackgroundSolidLayer>;
    }
  | {
      type: "patch-pattern";
      patch: Partial<SceneBackgroundPatternLayer>;
    }
  | {
      type: "patch-marquee";
      patch: Partial<SceneEffectEditorMarquee>;
    }
  | { type: "set-marquee-items"; items: SceneEffectEditorMarqueeItem[] }
  | { type: "patch-focus"; patch: Partial<SceneEffectEditorFocus> }
  | { type: "set-focus-target"; target: SceneFocusLinesTarget }
  | {
      type: "patch-focus-animation";
      patch: Partial<SceneFocusLinesAnimation>;
    };

export type SceneEffectEditorExport = {
  schema: typeof SCENE_EFFECT_EDITOR_SCHEMA;
  document: SceneEffectEditorDocument;
};

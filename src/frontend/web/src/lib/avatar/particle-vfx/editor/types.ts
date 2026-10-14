import type {
  ParticleVFXAnchor,
  ParticleVFXPerformanceBudget,
  ParticleVFXPreloadTier,
  ParticleVFXShapeAutoFit,
  ParticleVFXTransform,
  ParticleVFXTransformAxisTriple,
} from "../types";
import type { ParticleVFXColourTransform } from "./colourPixels";

export type JsonObject = Record<string, unknown>;
export type JsonArray = unknown[];

export type ParticleVFXEditorShapeType =
  | "point"
  | "sphere"
  | "cone"
  | "rectangle";

export type ParticleVFXEditorEmitterMode = 0 | 1 | 2 | 3;

export type ParticleVFXEditorRenderMode = 0 | 1 | 2 | 3 | 4 | 5;

export type ParticleVFXEditorBlending = "normal" | "additive";

export type ParticleVFXEditorTextureRole =
  | "glow"
  | "spark"
  | "smoke"
  | "trail"
  | "symbol";

export type ParticleVFXEditorFrameOverLifePreset = {
  startFrame: number;
  endFrame: number;
};

export type ParticleVFXEditorTextureAtlas = {
  uTileCount: number;
  vTileCount: number;
  frameCount?: number;
  blendTiles?: boolean;
  frameOverLife?: ParticleVFXEditorFrameOverLifePreset;
};

export type ParticleVFXEditorTextureManifestEntry = {
  id: string;
  label: string;
  fileName: string;
  role: ParticleVFXEditorTextureRole;
  recommendedBlending: ParticleVFXEditorBlending;
  recommendedRenderMode: ParticleVFXEditorRenderMode;
  atlas?: ParticleVFXEditorTextureAtlas;
};

export type ParticleVFXEditorTextureEntry =
  ParticleVFXEditorTextureManifestEntry & {
    relativeUrl: string;
    publicUrl: string;
  };

export type ParticleVFXEditorValueRange = {
  min: number;
  max: number;
};

export type ParticleVFXEditorValueGeneratorDraft =
  | {
      mode: "constant";
      value: number;
    }
  | {
      mode: "range";
      min: number;
      max: number;
    }
  | {
      mode: "linear";
      start: number;
      end: number;
    }
  | {
      mode: "unsupported";
      raw: JsonObject;
      label: string;
      fallbackValue: number;
    };

export type ParticleVFXEditorValueBehaviorDraft =
  | {
      mode: "off";
      value: ParticleVFXEditorValueGeneratorDraft;
    }
  | {
      mode: "enabled";
      value: ParticleVFXEditorValueGeneratorDraft;
    }
  | {
      mode: "unsupported";
      raw: JsonObject;
      label: string;
      value: ParticleVFXEditorValueGeneratorDraft;
    };

export type ParticleVFXEditorLimitSpeedOverLifeDraft =
  | {
      mode: "off";
      speed: ParticleVFXEditorValueGeneratorDraft;
      dampen: number;
    }
  | {
      mode: "enabled";
      speed: ParticleVFXEditorValueGeneratorDraft;
      dampen: number;
    }
  | {
      mode: "unsupported";
      raw: JsonObject;
      label: string;
      speed: ParticleVFXEditorValueGeneratorDraft;
      dampen: number;
    };

export type ParticleVFXEditorOrbitOverLifeDraft =
  | {
      mode: "off";
      orbitSpeed: ParticleVFXEditorValueGeneratorDraft;
      axis: ParticleVFXTransformAxisTriple;
    }
  | {
      mode: "enabled";
      orbitSpeed: ParticleVFXEditorValueGeneratorDraft;
      axis: ParticleVFXTransformAxisTriple;
    }
  | {
      mode: "unsupported";
      raw: JsonObject;
      label: string;
      orbitSpeed: ParticleVFXEditorValueGeneratorDraft;
      axis: ParticleVFXTransformAxisTriple;
    };

export type ParticleVFXEditorNoiseDraft =
  | {
      mode: "off";
      frequency: ParticleVFXEditorValueGeneratorDraft;
      power: ParticleVFXEditorValueGeneratorDraft;
      positionAmount: ParticleVFXEditorValueGeneratorDraft;
      rotationAmount: ParticleVFXEditorValueGeneratorDraft;
    }
  | {
      mode: "enabled";
      frequency: ParticleVFXEditorValueGeneratorDraft;
      power: ParticleVFXEditorValueGeneratorDraft;
      positionAmount: ParticleVFXEditorValueGeneratorDraft;
      rotationAmount: ParticleVFXEditorValueGeneratorDraft;
    }
  | {
      mode: "unsupported";
      raw: JsonObject;
      label: string;
      frequency: ParticleVFXEditorValueGeneratorDraft;
      power: ParticleVFXEditorValueGeneratorDraft;
      positionAmount: ParticleVFXEditorValueGeneratorDraft;
      rotationAmount: ParticleVFXEditorValueGeneratorDraft;
    };

export type ParticleVFXEditorTurbulenceFieldDraft =
  | {
      mode: "off";
      scale: ParticleVFXTransformAxisTriple;
      octaves: number;
      velocityMultiplier: ParticleVFXTransformAxisTriple;
      timeScale: ParticleVFXTransformAxisTriple;
    }
  | {
      mode: "enabled";
      scale: ParticleVFXTransformAxisTriple;
      octaves: number;
      velocityMultiplier: ParticleVFXTransformAxisTriple;
      timeScale: ParticleVFXTransformAxisTriple;
    }
  | {
      mode: "unsupported";
      raw: JsonObject;
      label: string;
      scale: ParticleVFXTransformAxisTriple;
      octaves: number;
      velocityMultiplier: ParticleVFXTransformAxisTriple;
      timeScale: ParticleVFXTransformAxisTriple;
    };

export type ParticleVFXEditorRotation3DOverLifeDraft =
  | {
      mode: "off";
    }
  | {
      mode: "axis-angle";
      axis: ParticleVFXTransformAxisTriple;
      angle: ParticleVFXEditorValueGeneratorDraft;
    }
  | {
      mode: "euler";
      angleX: ParticleVFXEditorValueGeneratorDraft;
      angleY: ParticleVFXEditorValueGeneratorDraft;
      angleZ: ParticleVFXEditorValueGeneratorDraft;
      eulerOrder: string;
    }
  | {
      mode: "random";
    }
  | {
      mode: "unsupported";
      raw: JsonObject;
      label: string;
    };

export type ParticleVFXEditorAdvancedBehaviorsDraft = {
  speedOverLife: ParticleVFXEditorValueBehaviorDraft;
  rotationOverLife: ParticleVFXEditorValueBehaviorDraft;
  rotation3DOverLife: ParticleVFXEditorRotation3DOverLifeDraft;
  orbitOverLife: ParticleVFXEditorOrbitOverLifeDraft;
  noise: ParticleVFXEditorNoiseDraft;
  turbulenceField: ParticleVFXEditorTurbulenceFieldDraft;
  limitSpeedOverLife: ParticleVFXEditorLimitSpeedOverLifeDraft;
  widthOverLength: ParticleVFXEditorValueBehaviorDraft;
};

export type ParticleVFXEditorEmitterTemplateId =
  | "pop"
  | "aura"
  | "smoke-fade"
  | "speed-streak"
  | "sparkle-burst";

export type ParticleVFXEditorColor = {
  r: number;
  g: number;
  b: number;
  a: number;
};

export type ParticleVFXEditorColorThemePresetId =
  | "affection"
  | "magic-sparkle"
  | "surprise"
  | "sadness"
  | "sleep"
  | "neutral-soft";

export type ParticleVFXEditorColorStop = {
  position: number;
  color: ParticleVFXEditorColor;
};

export type ParticleVFXEditorStartColorDraft =
  | {
      mode: "fixed";
      color: ParticleVFXEditorColor;
    }
  | {
      mode: "range";
      from: ParticleVFXEditorColor;
      to: ParticleVFXEditorColor;
    }
  | {
      mode: "theme";
      presetId: ParticleVFXEditorColorThemePresetId;
      from: ParticleVFXEditorColor;
      to: ParticleVFXEditorColor;
    }
  | {
      mode: "unsupported";
      raw: JsonObject;
      fallbackColor: ParticleVFXEditorColor;
      label: string;
    };

export type ParticleVFXEditorColorOverLifeDraft =
  | {
      mode: "off";
    }
  | {
      mode: "fade";
      stops: ParticleVFXEditorColorStop[];
    }
  | {
      mode: "gradient";
      stops: ParticleVFXEditorColorStop[];
    }
  | {
      mode: "random-gradient";
      gradientA: ParticleVFXEditorColorStop[];
      gradientB: ParticleVFXEditorColorStop[];
    }
  | {
      mode: "unsupported";
      raw: JsonObject;
      label: string;
    };

export type ParticleVFXEditorFrameOverLifeDraft =
  | {
      mode: "off";
      startFrame: number;
      endFrame: number;
    }
  | {
      mode: "linear";
      startFrame: number;
      endFrame: number;
    }
  | {
      mode: "unsupported";
      raw: JsonObject;
      label: string;
      startFrame: number;
      endFrame: number;
    };

export type ParticleVFXEditorColorThemePreset = {
  id: ParticleVFXEditorColorThemePresetId;
  label: string;
  description: string;
  from: ParticleVFXEditorColor;
  to: ParticleVFXEditorColor;
  gradientStops: ParticleVFXEditorColorStop[];
  randomGradientA: ParticleVFXEditorColorStop[];
  randomGradientB: ParticleVFXEditorColorStop[];
};

export type ParticleVFXEditorBurstDraft = {
  time: number;
  count: ParticleVFXEditorValueRange;
  interval: number;
  cycle: number;
  probability: number;
};

export type ParticleVFXEditorShapeDraft = {
  type: ParticleVFXEditorShapeType | "unsupported";
  radius: number;
  width: number;
  height: number;
  arc: number;
  thickness: number;
  angle: number;
  mode: ParticleVFXEditorEmitterMode;
  spread: number;
  speed: ParticleVFXEditorValueRange;
};

export type ParticleVFXEditorRendererDraft = {
  renderMode: number;
  blending: ParticleVFXEditorBlending;
  opacity: number;
  depthWrite: boolean;
  depthTest: boolean;
  alphaTest: number;
  renderOrder: number;
  uTileCount: number;
  vTileCount: number;
  blendTiles: boolean;
  softParticles: boolean;
  softNearFade: number;
  softFarFade: number;
  speedFactor: number;
  lengthFactor: number;
  trailStartLength: ParticleVFXEditorValueGeneratorDraft;
  trailFollowLocalOrigin: boolean;
};

export type ParticleVFXEmitterDraft = {
  path: string;
  uuid: string | null;
  name: string;
  /** Null inherits the effect or clip event anchor. */
  anchor: ParticleVFXAnchor | null;
  localPosition: ParticleVFXTransformAxisTriple;
  durationSec: number | null;
  looping: boolean;
  worldSpace: boolean;
  emissionOverTime: ParticleVFXEditorValueRange | null;
  emissionOverDistance: ParticleVFXEditorValueRange | null;
  startRotation: ParticleVFXEditorValueRange | null;
  burstCount: ParticleVFXEditorValueRange | null;
  burst: ParticleVFXEditorBurstDraft | null;
  startLife: ParticleVFXEditorValueRange | null;
  startSpeed: ParticleVFXEditorValueRange | null;
  startSize: ParticleVFXEditorValueRange | null;
  startColor: ParticleVFXEditorColor | null;
  startColorGenerator: ParticleVFXEditorStartColorDraft;
  textureId: string | null;
  textureUrl: string | null;
  shape: ParticleVFXEditorShapeDraft;
  renderer: ParticleVFXEditorRendererDraft;
  hasSizeOverLife: boolean;
  hasColorOverLife: boolean;
  colorOverLife: ParticleVFXEditorColorOverLifeDraft;
  frameOverLife: ParticleVFXEditorFrameOverLifeDraft;
  advancedBehaviors: ParticleVFXEditorAdvancedBehaviorsDraft;
  forceOverLife: {
    x: ParticleVFXEditorValueRange | null;
    y: ParticleVFXEditorValueRange | null;
    z: ParticleVFXEditorValueRange | null;
  } | null;
};

export type ParticleVFXEditorCatalogDraft = {
  id: string;
  label: string;
  description: string;
  assetPath: string;
  defaultAnchor: ParticleVFXAnchor;
  defaultFollowAnchor: boolean;
  defaultDurationSec: number;
  defaultTransform: ParticleVFXTransform;
  preloadTier: ParticleVFXPreloadTier;
  performanceBudget: ParticleVFXPerformanceBudget;
  shapeAutoFit?: ParticleVFXShapeAutoFit;
};

/**
 * Bytes of one texture the effect carries itself: an imported PNG, or a
 * texture file of a saved effect. Built-in textures need no entry.
 */
export type ParticleVFXEditorTextureFile = {
  blob: Blob;
  sha256: string;
  width: number;
  height: number;
};

/** One of Simple mode's broad Particle controls. */
export type ParticleVFXSimpleControl = "amount" | "size" | "speed" | "spread";

/**
 * Simple mode's control positions, as percentages of the reference: 100
 * leaves a control's fields as the reference has them.
 */
export type ParticleVFXSimpleFactors = Record<ParticleVFXSimpleControl, number>;

/** The effect a Simple control scales: its settings and its Quarks JSON. */
export type ParticleVFXSimpleReference = {
  catalog: ParticleVFXEditorCatalogDraft;
  quarksJson: JsonObject;
};

/** One of Simple mode's colour theme swatches; see `colourTheme.ts`. */
export type ParticleVFXColourThemeId =
  | "original"
  | "rose"
  | "gold"
  | "mint"
  | "sky"
  | "violet"
  | "white";

/**
 * A colour theme applied to the reference: the transform every emitter
 * colour and every recoloured texture got, and the copy each recoloured
 * texture of the reference is replaced with. Near-grey textures have no copy.
 */
export type ParticleVFXSimpleTheme = {
  id: Exclude<ParticleVFXColourThemeId, "original">;
  transform: ParticleVFXColourTransform;
  /** Reference image path → its recoloured copy's path (both `textures/…`). */
  textures: Readonly<Record<string, string>>;
};

/**
 * Simple mode's state on a draft: the reference the controls scale (the
 * effect when a Simple control was first used after opening or after the
 * last other edit), where each control is, and the colour theme (null is
 * Original). See `simpleControls.ts`.
 */
export type ParticleVFXSimpleState = {
  reference: ParticleVFXSimpleReference;
  factors: ParticleVFXSimpleFactors;
  theme: ParticleVFXSimpleTheme | null;
};

export type ParticleVFXEditorDraft = {
  source: "catalog" | "imported" | "new";
  sourceEffectId: string | null;
  sourceAssetPath: string;
  catalog: ParticleVFXEditorCatalogDraft;
  quarksJson: JsonObject;
  emitters: ParticleVFXEmitterDraft[];
  /**
   * Texture bytes by the package-relative path the Quarks images use
   * (`textures/<file>`). It may also hold textures only Simple's reference
   * uses (the originals of a colour theme's copies). A draft never uses one
   * path for two different images; undo and redo restore the table with the
   * JSON.
   */
  textureFiles: Readonly<Record<string, ParticleVFXEditorTextureFile>>;
  /**
   * Simple mode's reference, control positions and colour theme; null is
   * every control at 100 % and Original. Undo, redo and recovery keep it;
   * Save and the unsaved-changes check ignore it, because the scaled and
   * recoloured values are already in the effect.
   */
  simple: ParticleVFXSimpleState | null;
};

export type ParticleVFXEditorValidationIssue = {
  severity: "error" | "warning";
  code:
    | "invalid-emitter-anchor"
    | "invalid-json"
    | "missing-object"
    | "missing-emitter"
    | "invalid-texture-url"
    | "remote-texture-url"
    | "embedded-texture-url"
    | "missing-texture"
    | "blob-texture-url"
    | "unsupported-shape"
    | "unsupported-render-mode"
    | "unsupported-behavior-settings"
    | "trail-settings-missing"
    | "width-over-length-without-trail"
    | "rotation-3d-without-mesh"
    | "atlas-tiles-missing"
    | "atlas-grid-limit"
    | "atlas-metadata-mismatch"
    | "frame-over-life-without-atlas"
    | "frame-range-out-of-bounds"
    | "invalid-duration"
    | "duration-over-budget"
    | "looping-not-allowed"
    | "world-space-emitter"
    | "particle-budget-exceeded"
    | "asset-runtime-id"
    | "asset-manifest-limit"
    | "asset-resource-limit"
    | "asset-node-limit"
    | "asset-system-limit"
    | "asset-duration-limit"
    | "asset-looping-metadata"
    | "unresolved-texture"
    | "unsafe-texture-reference"
    | "ambiguous-texture-filename"
    | "unsupported-asset-structure"
    | "invalid-runtime-defaults";
  message: string;
  target: string;
};

export type ParticleVFXContentReadiness = {
  ready: boolean;
  issues: readonly ParticleVFXEditorValidationIssue[];
  uniqueTextureReferences: readonly string[];
  estimatedManifestBytes: number;
};

export type ParticleVFXEmitterPatch = Partial<{
  name: string;
  anchor: ParticleVFXAnchor | null;
  localPosition: Partial<ParticleVFXTransformAxisTriple>;
  durationSec: number;
  looping: boolean;
  worldSpace: boolean;
  emissionOverTime: ParticleVFXEditorValueRange;
  emissionOverDistance: ParticleVFXEditorValueRange;
  startRotation: ParticleVFXEditorValueRange;
  burst: Partial<ParticleVFXEditorBurstDraft>;
  burstCount: ParticleVFXEditorValueRange;
  startLife: ParticleVFXEditorValueRange;
  startSpeed: ParticleVFXEditorValueRange;
  startSize: ParticleVFXEditorValueRange;
  startColor: Partial<ParticleVFXEditorColor>;
  startColorGenerator: ParticleVFXEditorStartColorDraft;
  textureId: string;
  /** Use a texture the effect carries, by its package-relative path. */
  textureReference: string;
  shape: Partial<ParticleVFXEditorShapeDraft> & {
    type?: ParticleVFXEditorShapeType;
  };
  renderer: Partial<ParticleVFXEditorRendererDraft>;
  emitterTemplateId: ParticleVFXEditorEmitterTemplateId;
  sizeOverLife: boolean;
  colorOverLife: boolean;
  colorOverLifeDraft: ParticleVFXEditorColorOverLifeDraft;
  frameOverLifeDraft: ParticleVFXEditorFrameOverLifeDraft;
  advancedBehaviors: Partial<ParticleVFXEditorAdvancedBehaviorsDraft>;
  forceOverLifeEnabled: boolean;
  forceOverLife: {
    x?: ParticleVFXEditorValueRange;
    y?: ParticleVFXEditorValueRange;
    z?: ParticleVFXEditorValueRange;
  };
}>;

export type ParticleVFXEditorExport = {
  assetFileName: string;
  assetPath: string;
  quarksJson: string;
  /** The effect with its name and settings, for the creator's Import. */
  creatorDocument: string;
  catalogEntrySnippet: string;
  clipEventSnippet: string;
};

export type ParticleVFXCreatorPreviewPlacement = {
  position: ParticleVFXTransformAxisTriple;
  rotation: ParticleVFXTransformAxisTriple;
  scale: ParticleVFXTransformAxisTriple;
  resolvedAnchor: ParticleVFXAnchor | null;
  boneName: string | null;
  warning: string | null;
  autoFit: {
    kind: "avatarBoundsRectangle";
    width: number;
    height: number;
  } | null;
};

export type ParticleVFXEditorExportJsonViewerPayload = {
  value: unknown | null;
  error: string | null;
};

export type EmitterNodeRef = {
  path: string;
  object: JsonObject;
};

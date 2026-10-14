import { getParticleVFXCatalogEntryById } from "../catalog";
import { cloneParticleVFXShapeAutoFit } from "../autoFit";
import {
  cloneParticleVFXTransform,
  createDefaultParticleVFXTransform,
} from "../runtime";
import {
  DEFAULT_IMPORTED_CATALOG_DRAFT,
  DEFAULT_NEW_EFFECT_ID,
  DEFAULT_TEXTURE_ID,
} from "./constants";
import {
  cloneColorOverLifeDraft,
  cloneStartColorDraft,
  createDefaultColorOverLifeDraft,
  getStartColorDraftPreviewColor,
  readColorOverLifeDraft,
  readStartColorDraft,
  setColorOverLifeDraft,
  startColorDraftToGenerator,
} from "./colors";
import {
  collectEmitterNodes,
  createBlankParticleVFXJson,
  createParticleEmitterNode,
  ensureQuarksRootObject,
  findEmitterNode,
  readEmitterName,
  readFirstBurst,
  readObjectLocalPosition,
  removeEmitterNode,
  setFirstBurst,
  setFirstBurstCount,
  setObjectLocalPosition,
} from "./emitters";
import {
  cloneJsonObject,
  ensureJsonArrayProperty,
  ensureJsonObjectProperty,
  isJsonObject,
  makeEmitterUuid,
  readJsonObject,
} from "./json";
import {
  cloneValueRange,
  generatorToValueRange,
  readFiniteNumber,
  roundEditorNumber,
  valueRangeToGenerator,
} from "./numbers";
import {
  cloneFrameOverLifeDraft,
  findBehavior,
  findForceOverLifeBehavior,
  readFrameOverLifeDraft,
  setFrameOverLifeDraft,
  setBehaviorEnabled,
} from "./behaviors";
import {
  cloneAdvancedBehaviorsDraft,
  createDefaultAdvancedBehaviorsDraft,
  readAdvancedBehaviorsDraft,
  setAdvancedBehaviorsDraft,
} from "./advancedBehaviors";
import { applyParticleVFXEmitterTemplate } from "./emitterTemplates";
import { patchRenderer, readRendererDraft } from "./renderer";
import { readShapeDraft, shapeToJson } from "./shapes";
import {
  ensureEmitterMaterialAssets,
  readEmitterTexture,
  setEmitterImageUrl,
  setEmitterTexture,
  setEmitterTextureReference,
} from "./textures";
import type {
  EmitterNodeRef,
  JsonObject,
  ParticleVFXEditorCatalogDraft,
  ParticleVFXEditorColorOverLifeDraft,
  ParticleVFXEditorDraft,
  ParticleVFXEditorTextureFile,
  ParticleVFXEditorValidationIssue,
  ParticleVFXEmitterDraft,
  ParticleVFXEmitterPatch,
} from "./types";
import type { ParticleVFXCatalogEntry } from "../types";
import { isParticleVFXAnchor } from "../runtime";

export function parseParticleVFXEditorJson(
  value: string,
): JsonObject | ParticleVFXEditorValidationIssue {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isJsonObject(parsed)) {
      return {
        severity: "error",
        code: "invalid-json",
        message: "Quarks JSON must be an object.",
        target: "json",
      };
    }
    return parsed;
  } catch (error) {
    return {
      severity: "error",
      code: "invalid-json",
      message:
        error instanceof Error
          ? `Quarks JSON could not parse: ${error.message}`
          : "Quarks JSON could not parse.",
      target: "json",
    };
  }
}

export function createParticleVFXEditorDraftFromBlank(
  textureId = DEFAULT_TEXTURE_ID,
): ParticleVFXEditorDraft {
  const catalog: ParticleVFXEditorCatalogDraft = {
    ...DEFAULT_IMPORTED_CATALOG_DRAFT,
    id: DEFAULT_NEW_EFFECT_ID,
    label: "",
    description: "",
    assetPath: `/effects/vfx/quark/${DEFAULT_NEW_EFFECT_ID}.json`,
    defaultDurationSec: 1.2,
    defaultTransform: createDefaultParticleVFXTransform(),
  };
  return createParticleVFXEditorDraft({
    source: "new",
    sourceEffectId: null,
    sourceAssetPath: catalog.assetPath,
    catalog,
    quarksJson: createBlankParticleVFXJson(catalog, textureId),
  });
}

/**
 * A draft of an Included Particle Effect's manifest with its catalog defaults;
 * an unknown ID keeps the imported-effect defaults instead of borrowing
 * another effect's.
 */
export function createParticleVFXEditorDraftFromCatalog(
  effectId: string,
  quarksJson: unknown,
): ParticleVFXEditorDraft {
  const catalogEntry = getParticleVFXCatalogEntryById(effectId);
  return createParticleVFXEditorDraft({
    source: "catalog",
    sourceEffectId: catalogEntry?.id ?? null,
    sourceAssetPath: catalogEntry?.assetPath ?? "",
    catalog: catalogEntry
      ? catalogEntryToEditorDraft(catalogEntry)
      : DEFAULT_IMPORTED_CATALOG_DRAFT,
    quarksJson,
  });
}

export function createParticleVFXEditorDraftFromImport(
  quarksJson: unknown,
  overrides: Partial<ParticleVFXEditorCatalogDraft> = {},
  textureFiles: ParticleVFXEditorDraft["textureFiles"] = {},
): ParticleVFXEditorDraft {
  return createParticleVFXEditorDraft({
    textureFiles,
    source: "imported",
    sourceEffectId: null,
    sourceAssetPath:
      overrides.assetPath ?? DEFAULT_IMPORTED_CATALOG_DRAFT.assetPath,
    catalog: {
      ...DEFAULT_IMPORTED_CATALOG_DRAFT,
      ...overrides,
      defaultTransform: overrides.defaultTransform
        ? cloneParticleVFXTransform(overrides.defaultTransform)
        : cloneParticleVFXTransform(
            DEFAULT_IMPORTED_CATALOG_DRAFT.defaultTransform,
          ),
      performanceBudget: {
        ...DEFAULT_IMPORTED_CATALOG_DRAFT.performanceBudget,
        ...overrides.performanceBudget,
      },
      shapeAutoFit: cloneParticleVFXShapeAutoFit(overrides.shapeAutoFit),
    },
    quarksJson,
  });
}

export function addParticleVFXEditorEmitter(
  draft: ParticleVFXEditorDraft,
): ParticleVFXEditorDraft {
  const next = cloneParticleVFXEditorDraft(draft);
  const root = ensureQuarksRootObject(next.quarksJson, next.catalog.label);
  const children = ensureJsonArrayProperty(root, "children");
  const index = children.length + 1;
  const previous = next.emitters.at(-1);
  const textureId = previous?.textureId ?? DEFAULT_TEXTURE_ID;
  const node = createParticleEmitterNode({
    effectId: next.catalog.id,
    index,
    name: `emitter-${index}`,
    textureId,
    materialAssets: ensureEmitterMaterialAssets(
      next.quarksJson,
      next.catalog.id,
      index,
      textureId,
    ),
  });
  // Follow an emitter whose texture the effect carries with the same art.
  if (previous && !previous.textureId && previous.textureUrl) {
    setEmitterTextureReference(
      next.quarksJson,
      ensureJsonObjectProperty(node, "ps"),
      previous.textureUrl,
    );
  }
  children.push(node);
  return refreshParticleVFXEditorDraft(next);
}

export function duplicateParticleVFXEditorEmitter(
  draft: ParticleVFXEditorDraft,
  emitterPath: string,
): ParticleVFXEditorDraft {
  const next = cloneParticleVFXEditorDraft(draft);
  const root = ensureQuarksRootObject(next.quarksJson, next.catalog.label);
  const children = ensureJsonArrayProperty(root, "children");
  const emitter = findEmitterNode(next.quarksJson, emitterPath);
  if (!emitter) return next;

  const index = children.length + 1;
  const duplicate = cloneJsonObject(emitter);
  duplicate.uuid = makeEmitterUuid(next.catalog.id, index);
  duplicate.name = `${readEmitterName(emitter, index)} Copy`;
  const ps = ensureJsonObjectProperty(duplicate, "ps");
  const source = collectEmitterDraft(
    next.quarksJson,
    {
      path: emitterPath,
      object: emitter,
    },
    index - 1,
  );
  const materialAssets = ensureEmitterMaterialAssets(
    next.quarksJson,
    next.catalog.id,
    index,
    source.textureId ?? DEFAULT_TEXTURE_ID,
  );
  ps.material = materialAssets.materialUuid;
  // The copied atlas settings stay; only the image needs carrying over.
  if (!source.textureId && source.textureUrl)
    setEmitterImageUrl(next.quarksJson, ps, source.textureUrl);
  children.push(duplicate);
  return refreshParticleVFXEditorDraft(next);
}

export function removeParticleVFXEditorEmitter(
  draft: ParticleVFXEditorDraft,
  emitterPath: string,
): ParticleVFXEditorDraft {
  const next = cloneParticleVFXEditorDraft(draft);
  const root = readJsonObject(next.quarksJson.object);
  if (!root) return next;
  removeEmitterNode(root, "/object", emitterPath);
  return refreshParticleVFXEditorDraft(next);
}

export function updateParticleVFXEditorCatalogDraft(
  draft: ParticleVFXEditorDraft,
  patch: Partial<ParticleVFXEditorCatalogDraft>,
): ParticleVFXEditorDraft {
  const next = cloneParticleVFXEditorDraft(draft);
  next.catalog = {
    ...next.catalog,
    ...patch,
    defaultTransform: patch.defaultTransform
      ? cloneParticleVFXTransform(patch.defaultTransform)
      : next.catalog.defaultTransform,
    performanceBudget: patch.performanceBudget
      ? {
          ...next.catalog.performanceBudget,
          ...patch.performanceBudget,
        }
      : next.catalog.performanceBudget,
    shapeAutoFit: Object.prototype.hasOwnProperty.call(patch, "shapeAutoFit")
      ? cloneParticleVFXShapeAutoFit(patch.shapeAutoFit)
      : next.catalog.shapeAutoFit,
  };
  return refreshParticleVFXEditorDraft(next);
}

export function applyParticleVFXEmitterPatch(
  draft: ParticleVFXEditorDraft,
  emitterPath: string,
  patch: ParticleVFXEmitterPatch,
): ParticleVFXEditorDraft {
  const next = cloneParticleVFXEditorDraft(draft);
  const emitter = findEmitterNode(next.quarksJson, emitterPath);
  if (!emitter) return next;

  const ps = ensureJsonObjectProperty(emitter, "ps");
  if (patch.emitterTemplateId) {
    applyParticleVFXEmitterTemplate(
      next.quarksJson,
      ps,
      patch.emitterTemplateId,
    );
  }
  if (typeof patch.name === "string") {
    emitter.name = patch.name.trim() || "emitter";
  }
  if (patch.anchor !== undefined) {
    const userData = ensureJsonObjectProperty(emitter, "userData");
    if (patch.anchor === null) delete userData.animamaParticleAnchor;
    else userData.animamaParticleAnchor = patch.anchor;
  }
  if (patch.localPosition) {
    setObjectLocalPosition(emitter, {
      ...readObjectLocalPosition(emitter),
      ...patch.localPosition,
    });
  }
  if (typeof patch.durationSec === "number") {
    ps.duration = roundEditorNumber(patch.durationSec);
  }
  if (typeof patch.looping === "boolean") {
    ps.looping = patch.looping;
  }
  if (typeof patch.worldSpace === "boolean") {
    ps.worldSpace = patch.worldSpace;
  }
  if (patch.emissionOverTime) {
    ps.emissionOverTime = valueRangeToGenerator(patch.emissionOverTime);
  }
  if (patch.emissionOverDistance) {
    ps.emissionOverDistance = valueRangeToGenerator(patch.emissionOverDistance);
  }
  if (patch.startLife) {
    ps.startLife = valueRangeToGenerator(patch.startLife);
  }
  if (patch.startSpeed) {
    ps.startSpeed = valueRangeToGenerator(patch.startSpeed);
  }
  if (patch.startSize) {
    ps.startSize = valueRangeToGenerator(patch.startSize);
  }
  if (patch.startRotation) {
    ps.startRotation = valueRangeToGenerator(patch.startRotation);
  }
  if (patch.startColorGenerator) {
    ps.startColor = startColorDraftToGenerator(patch.startColorGenerator);
  }
  if (patch.startColor) {
    const currentColor = getStartColorDraftPreviewColor(
      readStartColorDraft(ps.startColor),
    );
    ps.startColor = startColorDraftToGenerator({
      mode: "fixed",
      color: {
        ...currentColor,
        ...patch.startColor,
      },
    });
  }
  if (patch.textureId) {
    setEmitterTexture(next.quarksJson, ps, patch.textureId);
  }
  if (patch.textureReference) {
    setEmitterTextureReference(next.quarksJson, ps, patch.textureReference);
  }
  if (patch.shape) {
    ps.shape = shapeToJson({
      ...readShapeDraft(ps.shape),
      ...patch.shape,
    });
  }
  if (patch.renderer) {
    patchRenderer(next.quarksJson, ps, patch.renderer);
  }
  if (patch.burst) {
    setFirstBurst(ps, patch.burst);
  }
  if (patch.burstCount) {
    setFirstBurstCount(ps, patch.burstCount);
  }
  if (typeof patch.forceOverLifeEnabled === "boolean") {
    setBehaviorEnabled(ps, "ForceOverLife", patch.forceOverLifeEnabled);
  }
  if (typeof patch.sizeOverLife === "boolean") {
    setBehaviorEnabled(ps, "SizeOverLife", patch.sizeOverLife);
  }
  if (typeof patch.colorOverLife === "boolean") {
    setColorOverLifeDraft(
      ps,
      patch.colorOverLife ? createDefaultColorOverLifeDraft() : { mode: "off" },
    );
  }
  if (patch.colorOverLifeDraft) {
    setColorOverLifeDraft(ps, patch.colorOverLifeDraft);
  }
  if (patch.frameOverLifeDraft) {
    setFrameOverLifeDraft(ps, patch.frameOverLifeDraft);
  }
  if (patch.advancedBehaviors) {
    setAdvancedBehaviorsDraft(ps, patch.advancedBehaviors);
  }
  if (patch.forceOverLife) {
    const force = findForceOverLifeBehavior(ps);
    if (force) {
      if (patch.forceOverLife.x) {
        force.x = valueRangeToGenerator(patch.forceOverLife.x);
      }
      if (patch.forceOverLife.y) {
        force.y = valueRangeToGenerator(patch.forceOverLife.y);
      }
      if (patch.forceOverLife.z) {
        force.z = valueRangeToGenerator(patch.forceOverLife.z);
      }
    }
  }

  return refreshParticleVFXEditorDraft(next);
}

export function cloneParticleVFXEditorDraft(
  draft: ParticleVFXEditorDraft,
): ParticleVFXEditorDraft {
  return {
    source: draft.source,
    sourceEffectId: draft.sourceEffectId,
    sourceAssetPath: draft.sourceAssetPath,
    catalog: {
      ...draft.catalog,
      defaultTransform: cloneParticleVFXTransform(
        draft.catalog.defaultTransform,
      ),
      performanceBudget: { ...draft.catalog.performanceBudget },
      shapeAutoFit: cloneParticleVFXShapeAutoFit(draft.catalog.shapeAutoFit),
    },
    quarksJson: cloneJsonObject(draft.quarksJson),
    // Entries are immutable; a changed table is always a new object.
    textureFiles: draft.textureFiles,
    // Never changed in place: a Simple control replaces the whole state.
    simple: draft.simple,
    emitters: draft.emitters.map((emitter) => ({
      ...emitter,
      localPosition: { ...emitter.localPosition },
      emissionOverTime: cloneValueRange(emitter.emissionOverTime),
      emissionOverDistance: cloneValueRange(emitter.emissionOverDistance),
      startRotation: cloneValueRange(emitter.startRotation),
      burstCount: cloneValueRange(emitter.burstCount),
      burst: emitter.burst
        ? {
            ...emitter.burst,
            count: cloneValueRange(emitter.burst.count) ?? {
              min: 0,
              max: 0,
            },
          }
        : null,
      startLife: cloneValueRange(emitter.startLife),
      startSpeed: cloneValueRange(emitter.startSpeed),
      startSize: cloneValueRange(emitter.startSize),
      startColor: emitter.startColor ? { ...emitter.startColor } : null,
      startColorGenerator: cloneStartColorDraft(emitter.startColorGenerator),
      shape: {
        ...emitter.shape,
        speed: cloneValueRange(emitter.shape.speed) ?? { min: 1, max: 1 },
      },
      renderer: { ...emitter.renderer },
      colorOverLife: cloneColorOverLifeDraft(emitter.colorOverLife),
      frameOverLife: cloneFrameOverLifeDraft(emitter.frameOverLife),
      advancedBehaviors: cloneAdvancedBehaviorsDraft(emitter.advancedBehaviors),
      forceOverLife: emitter.forceOverLife
        ? {
            x: cloneValueRange(emitter.forceOverLife.x),
            y: cloneValueRange(emitter.forceOverLife.y),
            z: cloneValueRange(emitter.forceOverLife.z),
          }
        : null,
    })),
  };
}

function createParticleVFXEditorDraft(args: {
  source: ParticleVFXEditorDraft["source"];
  sourceEffectId: string | null;
  sourceAssetPath: string;
  catalog: ParticleVFXEditorCatalogDraft;
  quarksJson: unknown;
  textureFiles?: Readonly<Record<string, ParticleVFXEditorTextureFile>>;
}): ParticleVFXEditorDraft {
  const quarksJson = isJsonObject(args.quarksJson)
    ? cloneJsonObject(args.quarksJson)
    : {};
  return refreshParticleVFXEditorDraft({
    source: args.source,
    sourceEffectId: args.sourceEffectId,
    sourceAssetPath: args.sourceAssetPath,
    catalog: {
      ...args.catalog,
      defaultTransform: cloneParticleVFXTransform(
        args.catalog.defaultTransform,
      ),
      performanceBudget: { ...args.catalog.performanceBudget },
      shapeAutoFit: cloneParticleVFXShapeAutoFit(args.catalog.shapeAutoFit),
    },
    quarksJson,
    emitters: [],
    textureFiles: args.textureFiles ?? {},
    simple: null,
  });
}

/**
 * The draft with its settings and Quarks JSON replaced by `effect` (copies
 * the draft now owns) and its emitters read again. Its source, textures and
 * Simple state stay.
 */
export function replaceParticleVFXEditorEffect(
  draft: ParticleVFXEditorDraft,
  effect: Pick<ParticleVFXEditorDraft, "catalog" | "quarksJson">,
): ParticleVFXEditorDraft {
  return refreshParticleVFXEditorDraft({
    ...draft,
    catalog: effect.catalog,
    quarksJson: effect.quarksJson,
  });
}

function refreshParticleVFXEditorDraft(
  draft: ParticleVFXEditorDraft,
): ParticleVFXEditorDraft {
  return {
    ...draft,
    emitters: collectParticleVFXEmitterDrafts(draft.quarksJson),
  };
}

function catalogEntryToEditorDraft(
  entry: ParticleVFXCatalogEntry,
): ParticleVFXEditorCatalogDraft {
  return {
    id: entry.id,
    label: entry.label,
    description: entry.description,
    assetPath: entry.assetPath,
    defaultAnchor: entry.defaultAnchor,
    defaultFollowAnchor: entry.defaultFollowAnchor,
    defaultDurationSec: entry.defaultDurationSec,
    defaultTransform: cloneParticleVFXTransform(entry.defaultTransform),
    preloadTier: entry.preloadTier,
    performanceBudget: { ...entry.performanceBudget },
    shapeAutoFit: cloneParticleVFXShapeAutoFit(entry.shapeAutoFit),
  };
}

function collectParticleVFXEmitterDrafts(
  quarksJson: JsonObject,
): ParticleVFXEmitterDraft[] {
  return collectEmitterNodes(quarksJson).map((node, index) =>
    collectEmitterDraft(quarksJson, node, index),
  );
}

function collectEmitterDraft(
  quarksJson: JsonObject,
  { path, object }: EmitterNodeRef,
  index: number,
): ParticleVFXEmitterDraft {
  const ps = readJsonObject(object.ps);
  const anchor = readJsonObject(object.userData)?.animamaParticleAnchor;
  const force = ps ? findForceOverLifeBehavior(ps) : null;
  const burst = readFirstBurst(ps);
  const texture = ps ? readEmitterTexture(quarksJson, ps) : null;
  const startColorGenerator = readStartColorDraft(ps?.startColor);
  const colorOverLife: ParticleVFXEditorColorOverLifeDraft = ps
    ? readColorOverLifeDraft(ps)
    : { mode: "off" };
  return {
    path,
    uuid: typeof object.uuid === "string" ? object.uuid : null,
    name: readEmitterName(object, index + 1),
    anchor: isParticleVFXAnchor(anchor) ? anchor : null,
    localPosition: readObjectLocalPosition(object),
    durationSec: readFiniteNumber(ps?.duration),
    looping: ps?.looping === true,
    worldSpace: ps?.worldSpace === true,
    emissionOverTime: generatorToValueRange(ps?.emissionOverTime),
    emissionOverDistance: generatorToValueRange(ps?.emissionOverDistance),
    startRotation: generatorToValueRange(ps?.startRotation),
    burstCount: burst?.count ?? null,
    burst,
    startLife: generatorToValueRange(ps?.startLife),
    startSpeed: generatorToValueRange(ps?.startSpeed),
    startSize: generatorToValueRange(ps?.startSize),
    startColor: getStartColorDraftPreviewColor(startColorGenerator),
    startColorGenerator,
    textureId: texture?.id ?? null,
    textureUrl: texture?.url ?? null,
    shape: readShapeDraft(ps?.shape),
    renderer: readRendererDraft(quarksJson, ps),
    hasSizeOverLife: ps ? !!findBehavior(ps, "SizeOverLife") : false,
    hasColorOverLife: colorOverLife.mode !== "off",
    colorOverLife,
    frameOverLife: ps
      ? readFrameOverLifeDraft(ps)
      : { mode: "off", startFrame: 0, endFrame: 0 },
    advancedBehaviors: ps
      ? readAdvancedBehaviorsDraft(ps)
      : createDefaultAdvancedBehaviorsDraft(),
    forceOverLife: force
      ? {
          x: generatorToValueRange(force.x),
          y: generatorToValueRange(force.y),
          z: generatorToValueRange(force.z),
        }
      : null,
  };
}

import type {
  ParticleVFXEditorCatalogDraft,
  ParticleVFXEditorTextureFile,
  ParticleVFXSimpleState,
  ParticleVFXSimpleTheme,
} from "@/lib/avatar/particle-vfx";
import { isParticleVFXColourThemeId } from "@/lib/avatar/particle-vfx/editor/colourTheme";
import {
  PARTICLE_VFX_SIMPLE_CONTROLS,
  PARTICLE_VFX_SIMPLE_RANGES,
} from "@/lib/avatar/particle-vfx/editor/simpleControls";
import type { JsonObject } from "@/lib/avatar/particle-vfx/editor/types";
import { PARTICLE_TEXTURE_LIMITS } from "@/lib/effects/effectArtLimits";
import {
  createCreatorRecoveryStore,
  creatorRecoveryTextBytes,
  recoveryRecordObject,
} from "./creatorRecoveryStore";

export const PARTICLE_VFX_RECOVERY_SCHEMA =
  "animama/particle-effect-recovery/5";
/**
 * Earlier records still restore: version 4 without a colour theme
 * (Original), version 3 without Simple state (its controls at 100 %),
 * version 2 also without texture files.
 */
const PARTICLE_VFX_RECOVERY_SIMPLE_WITHOUT_THEME =
  "animama/particle-effect-recovery/4";
const PARTICLE_VFX_RECOVERY_EARLIER_SCHEMAS = new Set([
  PARTICLE_VFX_RECOVERY_SIMPLE_WITHOUT_THEME,
  "animama/particle-effect-recovery/3",
  "animama/particle-effect-recovery/2",
]);
const MAX_RECOVERY_JSON_BYTES = 5 * 1024 * 1024;
/** The JSON plus every texture an effect may carry. */
export const PARTICLE_VFX_RECOVERY_MAX_BYTES =
  MAX_RECOVERY_JSON_BYTES + PARTICLE_TEXTURE_LIMITS.totalBytes;
const LOCAL_STORAGE_FALLBACK_MAX_BYTES = 1024 * 1024;

/**
 * One texture the draft uses, with its bytes: the effect's, and Simple's
 * reference's (a colour theme's originals), so Original still works.
 */
export type ParticleVFXRecoveryTexture = ParticleVFXEditorTextureFile & {
  reference: string;
};

/** Raw authoring state: no delivery capabilities, only the texture Blobs. */
export type ParticleVFXRecovery = {
  schema: typeof PARTICLE_VFX_RECOVERY_SCHEMA;
  userId: string;
  documentKey: string;
  source: { itemId: string } | null;
  operationId: string;
  /** Kept for record compatibility; Save derives file operations itself. */
  fileOperationIds: readonly string[];
  displayName: string;
  catalog: ParticleVFXEditorCatalogDraft;
  quarksJson: JsonObject;
  textures: readonly ParticleVFXRecoveryTexture[];
  /**
   * Simple mode's reference (settings and Quarks JSON only; its textures are
   * among `textures`), control positions and colour theme, or null at 100 %
   * and Original.
   */
  simple: ParticleVFXSimpleState | null;
  updatedAt: string;
};

/** The localStorage fallback keeps everything except the texture bytes. */
function metadata(recovery: ParticleVFXRecovery): ParticleVFXRecovery {
  return { ...recovery, textures: [] };
}

/**
 * Particle Effect drafts with the texture Blobs they use, in IndexedDB. The
 * storage names predate the shared store and must not change, or existing
 * drafts are lost.
 */
export const particleVFXRecoveryStore = createCreatorRecoveryStore({
  databaseName: "animama-content-creator-recovery",
  storeName: "particle-vfx",
  fallbackKeyPrefix: "anima.particleVfxCreator.recovery.v1",
  maxBytes: PARTICLE_VFX_RECOVERY_MAX_BYTES,
  messages: {
    tooLarge:
      "This effect is too large for browser crash recovery. Save can still continue.",
    unavailable:
      "Browser crash recovery is unavailable. Keep this tab open until Save finishes.",
    metadataOnly: (recovery: ParticleVFXRecovery) =>
      recovery.textures.length
        ? "Texture files could not be stored for crash recovery. Choose the missing textures again after restoring this draft."
        : null,
  },
  codec: {
    measure: (recovery: ParticleVFXRecovery) =>
      creatorRecoveryTextBytes(JSON.stringify(metadata(recovery))) +
      recovery.textures.reduce((sum, texture) => sum + texture.blob.size, 0),
    toDatabase: (recovery: ParticleVFXRecovery) => recovery,
    toFallback: (recovery: ParticleVFXRecovery) => {
      const text = JSON.stringify(metadata(recovery));
      return creatorRecoveryTextBytes(text) <= LOCAL_STORAGE_FALLBACK_MAX_BYTES
        ? { text, metadataOnly: recovery.textures.length > 0 }
        : null;
    },
    parse: parseParticleVFXRecovery,
  },
});

function parseTextures(value: unknown): ParticleVFXRecoveryTexture[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const texture = recoveryRecordObject(entry);
    if (
      !texture ||
      typeof texture.reference !== "string" ||
      !(texture.blob instanceof Blob) ||
      typeof texture.sha256 !== "string" ||
      typeof texture.width !== "number" ||
      typeof texture.height !== "number"
    )
      return [];
    return [
      {
        reference: texture.reference,
        blob: texture.blob,
        sha256: texture.sha256,
        width: texture.width,
        height: texture.height,
      },
    ];
  });
}

/**
 * A colour theme from a record: `undefined` when it is unreadable. A theme
 * names its swatch, its transform and, for each recoloured texture, its copy.
 */
function parseSimpleTheme(
  value: unknown,
): ParticleVFXSimpleTheme | null | undefined {
  if (value === null) return null;
  const theme = recoveryRecordObject(value);
  const recorded = recoveryRecordObject(theme?.transform);
  const textures = recoveryRecordObject(theme?.textures);
  const transform: ParticleVFXSimpleTheme["transform"] | null =
    recorded?.kind === "desaturate"
      ? { kind: "desaturate" }
      : recorded?.kind === "rotate" &&
          typeof recorded.degrees === "number" &&
          Number.isFinite(recorded.degrees)
        ? { kind: "rotate", degrees: recorded.degrees }
        : null;
  if (
    !theme ||
    !isParticleVFXColourThemeId(theme.id) ||
    theme.id === "original" ||
    !transform ||
    !textures ||
    !Object.values(textures).every((path) => typeof path === "string")
  )
    return undefined;
  return {
    id: theme.id,
    transform,
    textures: textures as Record<string, string>,
  };
}

/**
 * Simple state from a record; anything unreadable restores at 100 % and
 * Original (the recorded effect becomes the next reference). Records before
 * version 5 have no theme.
 */
function parseSimpleState(
  value: unknown,
  withTheme: boolean,
): ParticleVFXSimpleState | null {
  const simple = recoveryRecordObject(value);
  const reference = recoveryRecordObject(simple?.reference);
  const factors = recoveryRecordObject(simple?.factors);
  const theme = withTheme ? parseSimpleTheme(simple?.theme ?? null) : null;
  if (
    !reference ||
    !factors ||
    theme === undefined ||
    !recoveryRecordObject(reference.catalog) ||
    !recoveryRecordObject(reference.quarksJson) ||
    !PARTICLE_VFX_SIMPLE_CONTROLS.every((control) => {
      const value = factors[control];
      const range = PARTICLE_VFX_SIMPLE_RANGES[control];
      return (
        typeof value === "number" && value >= range.min && value <= range.max
      );
    })
  )
    return null;
  return {
    reference: {
      catalog: reference.catalog as ParticleVFXEditorCatalogDraft,
      quarksJson: reference.quarksJson as JsonObject,
    },
    factors: Object.fromEntries(
      PARTICLE_VFX_SIMPLE_CONTROLS.map((control) => [
        control,
        factors[control] as number,
      ]),
    ) as ParticleVFXSimpleState["factors"],
    theme,
  };
}

function parseParticleVFXRecovery(
  value: unknown,
  identity: { userId: string; documentKey: string },
): ParticleVFXRecovery | null {
  const record = recoveryRecordObject(value);
  if (
    !record ||
    (record.schema !== PARTICLE_VFX_RECOVERY_SCHEMA &&
      !PARTICLE_VFX_RECOVERY_EARLIER_SCHEMAS.has(String(record.schema))) ||
    record.userId !== identity.userId ||
    record.documentKey !== identity.documentKey ||
    typeof record.operationId !== "string" ||
    typeof record.displayName !== "string" ||
    typeof record.updatedAt !== "string" ||
    !Array.isArray(record.fileOperationIds) ||
    !record.fileOperationIds.every((id) => typeof id === "string") ||
    !recoveryRecordObject(record.catalog) ||
    !recoveryRecordObject(record.quarksJson)
  ) {
    return null;
  }
  const source = recoveryRecordObject(record.source);
  return {
    schema: PARTICLE_VFX_RECOVERY_SCHEMA,
    userId: identity.userId,
    documentKey: identity.documentKey,
    source:
      typeof source?.itemId === "string" ? { itemId: source.itemId } : null,
    operationId: record.operationId,
    fileOperationIds: record.fileOperationIds as string[],
    displayName: record.displayName,
    catalog: record.catalog as ParticleVFXEditorCatalogDraft,
    quarksJson: record.quarksJson as JsonObject,
    textures: parseTextures(record.textures),
    simple:
      record.schema === PARTICLE_VFX_RECOVERY_SCHEMA ||
      record.schema === PARTICLE_VFX_RECOVERY_SIMPLE_WITHOUT_THEME
        ? parseSimpleState(
            record.simple,
            record.schema === PARTICLE_VFX_RECOVERY_SCHEMA,
          )
        : null,
    updatedAt: record.updatedAt,
  };
}

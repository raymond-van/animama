import type {
  ParticleVFXEditorCatalogDraft,
  ParticleVFXEditorTextureFile,
  ParticleVFXSimpleState,
} from "@/lib/avatar/particle-vfx";
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
  "animama/particle-effect-recovery/4";
/**
 * Earlier records still restore: version 3 without Simple state (its
 * controls at 100 %), version 2 also without texture files.
 */
const PARTICLE_VFX_RECOVERY_EARLIER_SCHEMAS = new Set([
  "animama/particle-effect-recovery/3",
  "animama/particle-effect-recovery/2",
]);
const MAX_RECOVERY_JSON_BYTES = 5 * 1024 * 1024;
/** The JSON plus every texture an effect may carry. */
export const PARTICLE_VFX_RECOVERY_MAX_BYTES =
  MAX_RECOVERY_JSON_BYTES + PARTICLE_TEXTURE_LIMITS.totalBytes;
const LOCAL_STORAGE_FALLBACK_MAX_BYTES = 1024 * 1024;

/** One texture the draft uses, with its bytes. */
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
   * the draft's) and control positions, or null at 100 %.
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

/** Simple state from a record; anything unreadable restores at 100 %. */
function parseSimpleState(value: unknown): ParticleVFXSimpleState | null {
  const simple = recoveryRecordObject(value);
  const reference = recoveryRecordObject(simple?.reference);
  const factors = recoveryRecordObject(simple?.factors);
  if (
    !reference ||
    !factors ||
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
      record.schema === PARTICLE_VFX_RECOVERY_SCHEMA
        ? parseSimpleState(record.simple)
        : null,
    updatedAt: record.updatedAt,
  };
}

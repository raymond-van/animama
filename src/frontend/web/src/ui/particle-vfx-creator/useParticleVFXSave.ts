"use client";

import {
  createParticleVFXEditorDraftFromImport,
  isNeutralParticleVFXSimpleFactors,
  referencedParticleVFXTextureFiles,
  type ParticleVFXEditorDraft,
} from "@/lib/avatar/particle-vfx";
import { buildParticleVFXContentPackage } from "@/lib/content/particleVFXContentPackage";
import {
  PARTICLE_VFX_RECOVERY_SCHEMA,
  particleVFXRecoveryStore,
  type ParticleVFXRecovery,
} from "@/lib/content/particleVFXRecovery";
import { useParticleEffect } from "@/query/hooks/useEffects";
import {
  useCreatorSave,
  type CreatorSaveAdapter,
} from "@/ui/content-creator/useCreatorSave";
import { particleVFXDocumentFingerprint } from "./particleVFXDocument";

const MANIFEST_PATH = "particle.json";

/**
 * Particle Effect package, recovery record and routes for the shared Save.
 * Packaging may adjust the effect; those notices are reviewed before the
 * next Save continues. The package holds the effect only: Simple mode's
 * reference and control positions are kept by recovery, not saved, and the
 * saved draft returns Simple to 100 %.
 */
export const particleVFXSaveAdapter: CreatorSaveAdapter<
  ParticleVFXEditorDraft,
  ParticleVFXRecovery
> = {
  kind: "particle_effect",
  defaultName: "New Particle FX",
  savedMessage: "Particle Effect saved.",
  pausedMessage: "Save paused. Retry will continue from the preserved draft.",
  store: particleVFXRecoveryStore,
  fingerprint: particleVFXDocumentFingerprint,
  name: (draft) => draft.catalog.label,
  withName: (draft, label) => ({
    ...draft,
    catalog: { ...draft.catalog, label },
  }),
  validateName: (name) =>
    name.length > 120
      ? {
          message:
            "Give this Particle VFX a name between 1 and 120 characters.",
          field: "name",
        }
      : null,
  async buildPayload({ snapshot: draft, name, target, signal, progress }) {
    const packageFiles = await buildParticleVFXContentPackage({
      draft,
      resources: [],
      signal,
    });
    progress("uploading");
    return {
      files: [
        packageFiles.manifestFile,
        ...packageFiles.textures.map(({ file }) => file),
      ],
      companionPaths: [
        MANIFEST_PATH,
        ...packageFiles.textures.map(
          ({ packageReference }) => packageReference,
        ),
      ],
      descriptor: {
        schema_version: 1,
        id: target.logicalKey,
        content_type: "particle_effect",
        name,
        description: draft.catalog.description.trim() || null,
        runtime_defaults: packageFiles.authoringManifest.runtime_defaults ?? {},
        authoring: packageFiles.authoringManifest,
        files: [
          { path: MANIFEST_PATH, role: "manifest" },
          ...packageFiles.textures.map(({ packageReference }) => ({
            path: packageReference,
            role: "texture",
          })),
        ],
      },
      savedSnapshot: packageFiles.normalizedDraft,
      notices: packageFiles.notices,
    };
  },
  toRecovery: ({
    userId,
    documentKey,
    itemId,
    session,
    snapshot,
    updatedAt,
  }) => ({
    schema: PARTICLE_VFX_RECOVERY_SCHEMA,
    userId,
    documentKey,
    source: itemId ? { itemId } : null,
    operationId: session.operationId,
    fileOperationIds: [`${session.operationId}-manifest`],
    displayName: snapshot.catalog.label,
    catalog: snapshot.catalog,
    quarksJson: snapshot.quarksJson,
    textures: Object.entries(referencedParticleVFXTextureFiles(snapshot)).map(
      ([reference, file]) => ({ reference, ...file }),
    ),
    // At 100 % the reference is the effect itself, so it need not be kept.
    simple:
      snapshot.simple &&
      !isNeutralParticleVFXSimpleFactors(snapshot.simple.factors)
        ? snapshot.simple
        : null,
    updatedAt,
  }),
  // A record the current editor cannot import throws and is discarded. A
  // texture whose bytes were not kept shows as missing until it is chosen.
  fromRecovery: (record) => ({
    snapshot: {
      ...createParticleVFXEditorDraftFromImport(
        record.quarksJson,
        record.catalog,
        Object.fromEntries(
          record.textures.map(({ reference, ...file }) => [reference, file]),
        ),
      ),
      simple: record.simple,
    },
    operationId: record.operationId,
  }),
  editRoute: (itemId) => ({
    to: "/particle-effects/$particleEffectId/edit",
    params: { particleEffectId: itemId },
  }),
};

/** Save one Particle Effect directly into the editable Content Catalog. */
export function useParticleVFXSave(
  args: Omit<
    Parameters<
      typeof useCreatorSave<ParticleVFXEditorDraft, ParticleVFXRecovery>
    >[0],
    "adapter" | "existing"
  >,
) {
  const existing = useParticleEffect(args.itemId ?? null).data;
  return useCreatorSave({ ...args, adapter: particleVFXSaveAdapter, existing });
}

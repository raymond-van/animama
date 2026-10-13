import type { Client } from "@animama/runtime-contracts/sdk";

import {
  loadParticleVFXTextureFiles,
  type ParticleVFXEditorDraft,
} from "@/lib/avatar/particle-vfx";
import { createParticleVFXEditorDraftFromContent } from "@/lib/avatar/particle-vfx/editor/content";
import { previewCatalogItem } from "@/lib/content/catalogApi";
import {
  contentPreviewPrimaryFile,
  fetchContentPreviewFile,
} from "@/lib/content/contentPreview";
import { findIncludedTemplateItem } from "@/lib/content/includedTemplateItem";
import { findParticleEffectTemplate } from "@/lib/effects/effectTemplates";

/**
 * Open a catalog Particle Effect as an editor draft named `name`: its Quarks
 * manifest, its runtime settings and every texture file it carries. The
 * textures become the draft's own files, so Save and browser recovery keep
 * them; the item itself is never changed.
 */
export async function loadParticleVFXCatalogDraft(
  apiClient: Client,
  args: {
    itemId: string;
    name: string;
    description: string;
    signal: AbortSignal;
  },
): Promise<ParticleVFXEditorDraft> {
  const { signal } = args;
  const preview = await previewCatalogItem(
    apiClient,
    args.itemId,
    signal,
    "particle_effect",
  );
  const manifest = contentPreviewPrimaryFile(preview, "manifest");
  if (!manifest) throw new Error("The Particle Effect manifest is missing.");
  const response = await fetchContentPreviewFile(preview, manifest, {
    signal,
  });
  if (!response.ok) throw new Error("The Particle Effect could not be loaded.");
  const payload: unknown = await response.json();
  const textureFiles = await loadParticleVFXTextureFiles(
    preview.files
      // A Quarks image may name a file registered as an image too.
      .filter(
        (file) =>
          (file.role === "texture" || file.role === "image") &&
          file.logical_path,
      )
      .map((file) => ({
        logicalPath: file.logical_path!,
        download: async () => {
          const download = await fetchContentPreviewFile(preview, file, {
            signal,
          });
          if (!download.ok)
            throw new Error("A Particle Effect texture could not be loaded.");
          return download.blob();
        },
      })),
  );
  return createParticleVFXEditorDraftFromContent(
    payload,
    {
      item_id: args.itemId,
      name: args.name,
      description: args.description,
      // The typed preview carries the item's runtime defaults.
      metadata: preview.metadata,
    },
    textureFiles,
  );
}

/**
 * A new, unsaved Local draft copied from a Particle template's Included
 * effect, with its settings and textures. It gets a name no catalog item
 * uses, so its first Save creates a separate Local item.
 */
export async function loadParticleEffectTemplate(
  apiClient: Client,
  templateId: string,
  signal: AbortSignal,
): Promise<ParticleVFXEditorDraft> {
  const template = findParticleEffectTemplate(templateId);
  if (!template)
    throw new Error("This Particle Effect template is unavailable.");
  const { item, draftName } = await findIncludedTemplateItem(
    apiClient,
    "particle_effect",
    template,
    signal,
  );
  return loadParticleVFXCatalogDraft(apiClient, {
    itemId: item.item_id,
    name: draftName,
    description: item.description ?? "",
    signal,
  });
}

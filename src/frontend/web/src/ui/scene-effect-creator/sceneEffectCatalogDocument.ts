import type { Client } from "@animama/runtime-contracts/sdk";

import { previewCatalogItem } from "@/lib/content/catalogApi";
import { fetchContentPreviewFile } from "@/lib/content/contentPreview";
import { sha256File } from "@/lib/content/contentUploads";
import { findIncludedTemplateItem } from "@/lib/content/includedTemplateItem";
import { previewSoundForCopy } from "@/lib/content/previewSound";
import { findLogicalResourceFile } from "@/lib/content/typedLogicalResources";
import { findSceneEffectTemplate } from "@/lib/effects/effectTemplates";
import {
  createSceneEffectDocumentFromDefinition,
  type SceneEffectEditorDocument,
  type SceneEffectEditorImage,
  type SceneEffectEditorImageResource,
} from "@/lib/scene-vfx/editor";

import type { SceneEffectHistorySnapshot } from "./sceneEffectCreatorBehavior";

/**
 * Open a catalog Scene Effect as an editor document named `name`, downloading
 * every image it registers as the document's own File, so Save, undo and
 * browser recovery keep them; the item itself is never changed.
 */
export async function hydrateSceneEffect(
  apiClient: Client,
  args: {
    itemId: string;
    name: string;
    description: string;
    signal: AbortSignal;
  },
): Promise<{
  document: SceneEffectEditorDocument;
  images: SceneEffectEditorImageResource[];
}> {
  const preview = await previewCatalogItem(
    apiClient,
    args.itemId,
    args.signal,
    "scene_effect",
  );
  const metadata = object(preview.metadata);
  const definition = metadata?.definition ?? object(metadata?.spec)?.definition;
  const logicalFiles = object(metadata?.logical_resource_files) ?? {};
  const imageMetadata = new Map<string, SceneEffectEditorImage>();
  const resources: SceneEffectEditorImageResource[] = [];
  for (const [logicalName, rawIdentity] of Object.entries(logicalFiles)) {
    const identity = object(rawIdentity);
    const file =
      preview.files.find((candidate) => candidate.filename === logicalName) ??
      findLogicalResourceFile(preview.files, identity ?? {});
    if (!file)
      throw new Error(`The content image ${logicalName} is unavailable.`);
    const response = await fetchContentPreviewFile(preview, file, {
      signal: args.signal,
    });
    if (!response.ok)
      throw new Error(
        `The content image ${logicalName} could not be downloaded.`,
      );
    const blob = await response.blob();
    const imageFile = new File([blob], file.filename, {
      type: file.media_type,
    });
    const sha256 =
      file.sha256 || (await sha256File(imageFile, { signal: args.signal }));
    imageMetadata.set(logicalName, {
      logicalName,
      originalName: file.filename,
      contentType: file.media_type,
      sizeBytes: file.size_bytes,
      sha256,
    });
    resources.push({ logicalName, file: imageFile, sha256 });
  }
  return {
    document: createSceneEffectDocumentFromDefinition({
      name: args.name,
      description: args.description,
      definition,
      images: imageMetadata,
      sound: previewSoundForCopy(preview).sound,
    }),
    images: resources,
  };
}

/**
 * A new, unsaved Local draft copied from a Scene template's Included effect
 * (an emotion background or a focus-line preset), with its layers and every
 * image. It gets a name no catalog item uses, so its first Save creates a
 * separate Local item.
 */
export async function loadSceneEffectTemplate(
  apiClient: Client,
  templateId: string,
  signal: AbortSignal,
): Promise<SceneEffectHistorySnapshot> {
  const template = findSceneEffectTemplate(templateId);
  if (!template) throw new Error("This Scene Effect template is unavailable.");
  const { item, draftName } = await findIncludedTemplateItem(
    apiClient,
    "scene_effect",
    template,
    signal,
  );
  const { document, images } = await hydrateSceneEffect(apiClient, {
    itemId: item.item_id,
    name: draftName,
    description: item.description ?? "",
    signal,
  });
  return { document, imageResources: images };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

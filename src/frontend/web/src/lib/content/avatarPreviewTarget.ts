import type { ItemRevisionRef } from "@animama/runtime-contracts/api-types";
import { getAvatarContent, type Client } from "@animama/runtime-contracts/sdk";

import type { PyContentPreview } from "@/lib/content/catalogTypes";
import type { ContentPreviewTarget } from "@/lib/content-preview/types";
import { portraitRetakeTarget } from "@/lib/avatar/portrait/retakeTarget";
import type { RuntimeCatalogEntry } from "@/lib/runtime-content/types";
import { previewCatalogItem } from "./catalogApi";
import { contentPreviewFileUrl } from "./contentPreview";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** An exact Avatar preview as a runtime Avatar entry the loaders accept. */
function avatarPreviewEntry(
  preview: PyContentPreview,
  displayName: string,
): RuntimeCatalogEntry {
  const metadata = object(preview.metadata);
  const files = preview.files.map((file) => ({
    role: file.role === "vrm" ? "model" : file.role,
    ordinal: file.ordinal,
    filename: file.filename,
    content_type: file.media_type,
    size_bytes: file.size_bytes,
    // The VRM digest lets the preview Avatar apply a saved face part correction.
    sha256: file.sha256,
    content_revision: file.sha256,
    url: contentPreviewFileUrl(preview, file),
  }));
  return {
    slot: "primary_model",
    runtime_id: `preview-avatar-${preview.preview_id}`,
    kind: "avatar_model",
    display_name: displayName,
    description: displayName,
    config_schema_version: 1,
    config: {
      ...object(object(metadata.spec).presentation),
      // The Avatar item, so the preview loads with its saved settings.
      ...(preview.item_id ? { avatar_catalog_item_id: preview.item_id } : {}),
      // Its saved face part correction, as the Anima runtime entry carries it.
      ...(metadata.face_parts ? { face_parts: metadata.face_parts } : {}),
    },
    content_revision: preview.revision,
    source: { type: "authorized_files", files },
  };
}

/**
 * An Avatar item's runtime entry from a fresh exact preview, for a load
 * outside the preview dock (Diagnostics, the Library's Avatar settings).
 */
export async function avatarItemRuntimeEntry(
  apiClient: Client,
  itemId: string,
  signal?: AbortSignal,
): Promise<RuntimeCatalogEntry> {
  const preview = await previewCatalogItem(apiClient, itemId, signal, "avatar");
  return avatarPreviewEntry(preview, "");
}

/**
 * The previewed Local Avatar revision when its portrait is missing or was
 * captured from another revision (after Replace VRM, for example), so the
 * Dock can capture it again. Null for an Included Avatar or a current one.
 */
export async function avatarPreviewPortraitRetake(
  apiClient: Client,
  preview: PyContentPreview,
  signal?: AbortSignal,
): Promise<ItemRevisionRef | null> {
  if (!preview.item_id) return null;
  const { data } = await getAvatarContent({
    client: apiClient,
    path: { item_id: preview.item_id },
    signal,
    responseValidator: undefined,
    throwOnError: true,
  });
  return portraitRetakeTarget(
    { item_id: preview.item_id, revision_sha256: preview.revision_sha256 },
    [data],
  );
}

/** Adapt an exact Avatar preview to the shared single-Canvas preview dock. */
export function avatarPreviewTarget(
  preview: PyContentPreview,
  displayName: string,
  portraitRetake?: ItemRevisionRef | null,
): ContentPreviewTarget {
  const entry = avatarPreviewEntry(preview, displayName);
  return {
    ...(portraitRetake ? { portraitRetake } : {}),
    key: `typed-avatar:${preview.preview_id}:${preview.revision}`,
    sourceType: "resolved_entry",
    entry,
    kind: "avatar_model",
    displayName,
    versionLabel: preview.revision,
    slot: "primary_model",
    runtimeId: entry.runtime_id,
    configSchemaVersion: 1,
    config: entry.config,
  };
}

import { contentSlug } from "./nameIdentifiers";
import type { Client } from "@animama/runtime-contracts/sdk";
import {
  deleteContentItemV1ContentItemsItemIdDelete,
  getContentItemUsageV1ContentItemsItemIdUsageGet,
  getContentItemV1ContentItemsItemIdGet,
  getGesture,
  getReaction,
  listContentCatalogV1ContentCatalogGet,
  previewAppearanceContent,
  previewAvatarContent,
  saveAvatarEffect,
  previewAvatarEffect,
  previewGesture,
  previewParticleEffect,
  previewPose,
  previewReaction,
  previewSceneEffect,
  previewSoundEffect,
  previewVoiceContent,
  saveAppearanceContent,
  saveAvatarContent,
  saveGesture,
  saveParticleEffect,
  savePose,
  saveReaction,
  saveSceneEffect,
  saveSoundEffect,
  saveVoiceContent,
} from "@animama/runtime-contracts/sdk";
import type {
  PyAppearance,
  PyAvatarContent,
  PyAvatarEffect,
  PyContentItem,
  PyGesture,
  PyParticleEffect,
  PyPose,
  PyReaction,
  PySceneEffect,
  PySoundEffect,
  PyTypedContentPreview,
  PyVoiceContent,
} from "@animama/runtime-contracts/api-types";
import type { ContentKind, PyContentPreview } from "@/lib/content/catalogTypes";
import {
  ContentDeleteError,
  type PyContentUsage,
} from "@/lib/content/contentDeletion";
import { toContentSaveApiError } from "@/lib/content/contentSaveErrors";
import { typedLogicalResourceFiles } from "@/lib/content/typedLogicalResources";
import { typedComponentPreviewMetadata } from "@/lib/content/typedPreviewAdapters";
import { sdkResultError } from "@/query/sdkResultError";

type TypedCatalogTransport =
  | (PyGesture & { kind: "gesture" })
  | (PyReaction & { kind: "reaction" })
  | (PyPose & { kind: "pose" })
  | (PyParticleEffect & { kind: "particle_effect" })
  | (PyAvatarEffect & { kind: "avatar_effect" })
  | (PySceneEffect & { kind: "scene_effect" })
  | (PySoundEffect & { kind: "sound_effect" })
  | (PyAvatarContent & { kind: "avatar" })
  | (PyAppearance & { kind: "appearance" })
  | (PyVoiceContent & { kind: "voice" });

export type CatalogSaveInput = {
  kind: ContentKind;
  entryName: string;
  files: File[];
  operationId?: string;
  catalogItemId?: string | null;
  expectedRevision?: string | null;
  descriptor?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  companionPaths?: string[];
};

type ContentSaveResponse<T> = {
  data: T | undefined;
  error: unknown;
  response?: Response;
};

/** Preserve generated-client HTTP context while exposing one real Save error. */
async function contentSaveData<T>(
  request: Promise<ContentSaveResponse<T>>,
): Promise<T> {
  let result: ContentSaveResponse<T>;
  try {
    result = await request;
  } catch (cause) {
    throw toContentSaveApiError(cause);
  }
  // A lost reply is uncertain: keep the operation ID and draft for receipt-based retry.
  // The generated client returns fetch failures without an HTTP response.
  if (!result.response) {
    throw toContentSaveApiError(
      result.error ?? new TypeError("Failed to fetch"),
    );
  }
  if (result.error !== undefined) {
    throw toContentSaveApiError(result.error, result.response.status);
  }
  if (result.data === undefined) {
    throw toContentSaveApiError({}, result.response.status);
  }
  return result.data;
}

/** Build a portable logical key for a newly authored Local item. */
export function localContentLogicalKey(
  kind: ContentKind,
  name: string,
): string {
  return `local:${kind.replaceAll("_", "-")}:${contentSlug(name)}`;
}

function typedMetadata(item: TypedCatalogTransport): Record<string, unknown> {
  const common = {
    schema_version: 1,
    content_type: item.kind,
    content_id: item.logical_key,
    name: item.name,
    description: item.description,
    dependencies: item.dependencies ?? [],
    files: item.files ?? [],
    logical_resource_files: typedLogicalResourceFiles(item),
  };
  switch (item.kind) {
    case "gesture":
      return {
        ...common,
        semantic_key: item.semantic_key,
        implementation: item.implementation,
        config: item.config,
      };
    case "reaction":
      return {
        ...common,
        ...(item.emotion && item.intensity
          ? {
              placement_hint: {
                emotion: item.emotion,
                intensity: item.intensity,
              },
            }
          : {}),
        implementation: item.implementation,
        config: item.config,
      };
    case "pose":
      return { ...common, id: item.pose_id };
    case "particle_effect":
      return {
        ...common,
        runtime_defaults: item.runtime_defaults,
        definition: item.definition,
      };
    case "avatar_effect":
    case "scene_effect":
      return {
        ...common,
        runtime_defaults: item.runtime_defaults,
        technical_source: item.technical_source,
        definition: item.definition,
      };
    case "sound_effect":
      return {
        ...common,
        duration_seconds: item.duration_seconds,
        codec: item.codec,
        defaults: item.defaults,
      };
    case "avatar":
      return {
        ...common,
        compatibility: item.compatibility,
        // The saved correction, so a preview loads the parts chat uses.
        face_parts: item.face_parts ?? null,
      };
    case "appearance":
      return {
        ...common,
        width: item.width,
        height: item.height,
        avatar_model: item.avatar_model,
        presentation: item.presentation,
      };
    case "voice":
      return {
        ...common,
        codec: item.codec,
        language: item.language,
        sample_rate_hz: item.sample_rate_hz,
      };
  }
}

/** Temporary creator-view adapter; product semantics still come from typed responses. */
export function typedCatalogTransportItem(
  item: TypedCatalogTransport,
): PyContentItem {
  return {
    item_id: item.item_id,
    source: item.source,
    scope: item.source === "included" ? "included" : "owner",
    kind: item.kind,
    // Typed product contracts intentionally do not expose host locators.
    relative_locator: "",
    logical_key: item.logical_key ?? null,
    display_name: item.name,
    status: "valid",
    revision_sha256: item.revision_sha256,
    dependencies: (item.dependencies ?? []).map((dependency) => dependency.ref),
    provenance: {},
    metadata: typedMetadata(item),
    diagnostics: [],
    files: (item.files ?? []).map((file) => ({
      ...file,
      relative_path: file.filename,
    })),
    scanned_at: null,
    name: item.name,
    description: item.description ?? null,
    semantic_key: item.kind === "gesture" ? item.semantic_key : null,
    implementation_kind:
      item.kind === "gesture" || item.kind === "reaction"
        ? item.implementation.kind
        : null,
    origin: item.source,
    editable: item.editable,
    selection: {
      type: "catalog",
      catalog_item_id: item.item_id,
      logical_key: item.logical_key ?? null,
    },
  };
}

/** Save ordinary editable files through the one neutral Content endpoint. */
export async function saveCatalogItem(
  apiClient: Client,
  input: CatalogSaveInput,
): Promise<PyContentItem> {
  const body = {
    operation_id: input.operationId ?? crypto.randomUUID(),
    files: input.files,
    catalog_item_id: input.catalogItemId ?? undefined,
    expected_revision: input.expectedRevision ?? undefined,
    descriptor_json: input.descriptor
      ? `${JSON.stringify(input.descriptor, null, 2)}\n`
      : undefined,
    metadata_json: input.metadata
      ? `${JSON.stringify(input.metadata, null, 2)}\n`
      : undefined,
    companion_paths_json: JSON.stringify(input.companionPaths ?? []),
  };
  const typedOptions = {
    path: { entry_name: input.entryName },
    body,
    requestValidator: undefined,
    responseValidator: undefined,
    throwOnError: false as const,
  };
  let item: TypedCatalogTransport;
  switch (input.kind) {
    case "gesture":
      item = {
        ...(await contentSaveData(
          saveGesture({ ...typedOptions, client: apiClient }),
        )),
        kind: "gesture",
      };
      break;
    case "reaction":
      item = {
        ...(await contentSaveData(
          saveReaction({ ...typedOptions, client: apiClient }),
        )),
        kind: "reaction",
      };
      break;
    case "pose":
      item = {
        ...(await contentSaveData(
          savePose({ ...typedOptions, client: apiClient }),
        )),
        kind: "pose",
      };
      break;
    case "particle_effect":
      item = {
        ...(await contentSaveData(
          saveParticleEffect({ ...typedOptions, client: apiClient }),
        )),
        kind: "particle_effect",
      };
      break;
    case "avatar_effect":
      item = {
        ...(await contentSaveData(
          saveAvatarEffect({ ...typedOptions, client: apiClient }),
        )),
        kind: "avatar_effect",
      };
      break;
    case "scene_effect":
      item = {
        ...(await contentSaveData(
          saveSceneEffect({ ...typedOptions, client: apiClient }),
        )),
        kind: "scene_effect",
      };
      break;
    case "sound_effect":
      item = {
        ...(await contentSaveData(
          saveSoundEffect({ ...typedOptions, client: apiClient }),
        )),
        kind: "sound_effect",
      };
      break;
    case "avatar":
      item = {
        ...(await contentSaveData(
          saveAvatarContent({ ...typedOptions, client: apiClient }),
        )),
        kind: "avatar",
      };
      break;
    case "appearance":
      item = {
        ...(await contentSaveData(
          saveAppearanceContent({ ...typedOptions, client: apiClient }),
        )),
        kind: "appearance",
      };
      break;
    case "voice":
      item = {
        ...(await contentSaveData(
          saveVoiceContent({ ...typedOptions, client: apiClient }),
        )),
        kind: "voice",
      };
      break;
    case "anima":
      throw new Error(
        "Portable Anima content is reserved for the Base Anima phase.",
      );
  }
  return typedCatalogTransportItem(item);
}

/** Preview one known family without falling back to generic metadata routes. */
export async function previewTypedCatalogItem(
  apiClient: Client,
  kind: Exclude<ContentKind, "anima">,
  itemId: string,
  signal?: AbortSignal,
): Promise<PyTypedContentPreview> {
  const options = {
    path: { item_id: itemId },
    signal,
    responseValidator: undefined,
    throwOnError: true as const,
  };
  switch (kind) {
    case "gesture":
      return (await previewGesture({ ...options, client: apiClient })).data;
    case "reaction":
      return (await previewReaction({ ...options, client: apiClient })).data;
    case "pose":
      return (await previewPose({ ...options, client: apiClient })).data;
    case "particle_effect":
      return (await previewParticleEffect({ ...options, client: apiClient }))
        .data;
    case "avatar_effect":
      return (await previewAvatarEffect({ ...options, client: apiClient }))
        .data;
    case "scene_effect":
      return (await previewSceneEffect({ ...options, client: apiClient })).data;
    case "sound_effect":
      return (await previewSoundEffect({ ...options, client: apiClient })).data;
    case "avatar":
      return (await previewAvatarContent({ ...options, client: apiClient }))
        .data;
    case "appearance":
      return (await previewAppearanceContent({ ...options, client: apiClient }))
        .data;
    case "voice":
      return (await previewVoiceContent({ ...options, client: apiClient }))
        .data;
  }
}

export function typedPreviewTransport(
  preview: PyTypedContentPreview,
): PyContentPreview {
  const item = typedCatalogTransportItem(preview.item);
  return {
    preview_id: preview.preview_id,
    item_id: item.item_id,
    revision: preview.revision_sha256,
    revision_sha256: preview.revision_sha256,
    expires_at: preview.expires_at,
    files: preview.files,
    item,
    metadata: {
      ...typedMetadata(preview.item),
      ...typedComponentPreviewMetadata(preview),
    },
  };
}

export async function previewCatalogItem(
  apiClient: Client,
  itemId: string,
  signal?: AbortSignal,
  knownKind?: Exclude<ContentKind, "anima">,
): Promise<PyContentPreview> {
  const kind = knownKind ?? (await getCatalogItem(apiClient, itemId)).kind;
  if (kind === "anima") {
    throw new Error("Portable Anima previews are not available yet.");
  }
  return typedPreviewTransport(
    await previewTypedCatalogItem(
      apiClient,
      kind as Exclude<ContentKind, "anima">,
      itemId,
      signal,
    ),
  );
}

export async function getCatalogItem(
  apiClient: Client,
  itemId: string,
): Promise<PyContentItem> {
  return (
    await getContentItemV1ContentItemsItemIdGet({
      client: apiClient,
      path: { item_id: itemId },
      responseValidator: undefined,
      throwOnError: true,
    })
  ).data;
}

/** Read an editable Action through its exact typed product contract. */
export async function getTypedActionCatalogItem(
  apiClient: Client,
  kind: "gesture" | "reaction",
  itemId: string,
): Promise<PyContentItem> {
  const options = {
    path: { item_id: itemId },
    responseValidator: undefined,
    throwOnError: true as const,
  };
  const item =
    kind === "gesture"
      ? {
          ...(await getGesture({ ...options, client: apiClient })).data,
          kind: "gesture" as const,
        }
      : {
          ...(await getReaction({ ...options, client: apiClient })).data,
          kind: "reaction" as const,
        };
  return typedCatalogTransportItem(item);
}

export async function listCatalogItems(
  apiClient: Client,
  kind?: ContentKind,
  signal?: AbortSignal,
) {
  const catalog = (
    await listContentCatalogV1ContentCatalogGet({
      client: apiClient,
      signal,
      responseValidator: undefined,
      throwOnError: true,
    })
  ).data;
  return kind
    ? catalog.items.filter((item) => item.kind === kind)
    : catalog.items;
}

/**
 * Delete one owned Local item at the revision it was shown at. A 404 means it
 * is already gone (deleted elsewhere), the outcome asked for. Any other
 * refusal throws `ContentDeleteError`; a request that got no response throws
 * the transport error.
 */
export async function deleteCatalogItem(
  apiClient: Client,
  itemId: string,
  expectedRevision: string,
): Promise<void> {
  const result = await deleteContentItemV1ContentItemsItemIdDelete({
    client: apiClient,
    path: { item_id: itemId },
    query: { expected_revision: expectedRevision },
    responseValidator: undefined,
    throwOnError: false,
  });
  if (result.response?.status === 404) return;
  if (result.error !== undefined || !result.response?.ok)
    throw sdkResultError(
      result,
      (status, error) => new ContentDeleteError(status, error),
    );
}

/**
 * What keeps an owned Local item from being deleted, read before Delete is
 * offered (R15). An empty list means Delete is not refused as in use. Any
 * refusal, such as 404 for an item Delete would not accept, throws
 * `ContentDeleteError`.
 */
export async function getCatalogItemUsage(
  apiClient: Client,
  itemId: string,
  signal?: AbortSignal,
): Promise<PyContentUsage[]> {
  const result = await getContentItemUsageV1ContentItemsItemIdUsageGet({
    client: apiClient,
    path: { item_id: itemId },
    signal,
    responseValidator: undefined,
    throwOnError: false,
  });
  if (result.error !== undefined || !result.data)
    throw sdkResultError(
      result,
      (status, error) => new ContentDeleteError(status, error),
    );
  return result.data.used_by;
}

import { useProductApiClient } from "@animama/product-ui";
import type { Client } from "@animama/runtime-contracts/sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PyVoiceContent } from "@animama/runtime-contracts/api-types";
import {
  getContentItemV1ContentItemsItemIdGet,
  saveVoiceContent,
} from "@animama/runtime-contracts/sdk";
import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import {
  ContentSaveApiError,
  toContentSaveApiError,
} from "@/lib/content/contentSaveErrors";
import {
  loadVoiceCloneFile,
  POCKET_VOICE_CLONE_CODEC,
  voiceCloneName,
  type PreparedVoiceClone,
} from "@/lib/speech/pocket/voice-clones";
import { queryKeys } from "@/query/keys";
import { invalidateVoiceCloneConsumers } from "@/query/animaLoadoutInvalidation";
import { sdkResultError } from "@/query/sdkResultError";

/** Save captured bytes and identity unchanged; callers retain the prepared value for retries. */
export async function savePreparedVoiceClone(
  apiClient: Client,
  input: PreparedVoiceClone,
): Promise<PyVoiceContent> {
  try {
    const result = await saveVoiceContent({
      client: apiClient,
      path: { entry_name: input.entryName },
      body: {
        operation_id: input.operationId,
        catalog_item_id: input.catalogItemId,
        expected_revision: input.expectedRevision,
        descriptor_json: JSON.stringify(input.descriptor),
        companion_paths_json: JSON.stringify(
          input.descriptor.files.map((file) => file.path),
        ),
        files: input.files,
      },
      requestValidator: undefined,
      responseValidator: undefined,
      throwOnError: false,
    });
    if (result.error !== undefined || !result.data) {
      throw sdkResultError(result, (status, error) =>
        toContentSaveApiError(error, status),
      );
    }
    return result.data;
  } catch (error) {
    throw toContentSaveApiError(error);
  }
}

function requireEditableClone(clone: PyVoiceContent) {
  if (
    !clone.editable ||
    clone.source !== "local" ||
    clone.codec !== POCKET_VOICE_CLONE_CODEC
  ) {
    throw new Error("Only saved Local voice clones can be changed.");
  }
}

/** Rename through typed Save, retaining the encoded catalog, optional original and provenance. */
export async function renameSavedVoiceClone(
  apiClient: Client,
  {
    clone,
    name,
    operationId = crypto.randomUUID(),
  }: {
    clone: PyVoiceContent;
    name: string;
    operationId?: string;
  },
): Promise<PyVoiceContent> {
  requireEditableClone(clone);
  const displayName = voiceCloneName(name);
  try {
    const { data: current } = await getContentItemV1ContentItemsItemIdGet({
      client: apiClient,
      path: { item_id: clone.item_id },
      responseValidator: undefined,
      throwOnError: true,
    });
    if (current.revision_sha256 !== clone.revision_sha256) {
      throw new ContentSaveApiError(
        409,
        "catalog_revision_conflict",
        "This voice changed. Reload the voice library before renaming it.",
      );
    }
    // The typed inventory also contains the descriptor; Save generates that file.
    const files = (clone.files ?? []).filter(
      (file) =>
        file.role === "source_sample" || file.role === "pocket_voice_catalog",
    );
    if (
      files.filter((file) => file.role === "pocket_voice_catalog").length !==
        1 ||
      files.filter((file) => file.role === "source_sample").length > 1
    ) {
      throw new Error(
        "This voice requires one encoded catalog and at most one original recording.",
      );
    }
    const retainedFiles = await Promise.all(
      files.map(
        async (file) =>
          new File([await loadVoiceCloneFile(apiClient, file)], file.filename, {
            type: file.media_type,
          }),
      ),
    );
    return await savePreparedVoiceClone(apiClient, {
      entryName: current.relative_locator.split("/").at(-1) || clone.item_id,
      operationId,
      catalogItemId: clone.item_id,
      expectedRevision: clone.revision_sha256,
      descriptor: {
        ...current.metadata,
        name: displayName,
        files: files.map((file) => ({
          path: file.logical_path,
          role: file.role,
        })),
      },
      files: retainedFiles,
    });
  } catch (error) {
    throw toContentSaveApiError(error);
  }
}

/**
 * Shared library mutations never equip a clone or change provider
 * preferences. A clone is deleted through the shared content delete
 * (`useDeleteContentItem`).
 */
export function useVoiceCloneActions() {
  const apiClient = useProductApiClient();

  const owner = useRuntimeCacheKey();
  const client = useQueryClient();
  const refresh = async () => {
    if (!owner) return;
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.voiceContent.all(owner) }),
      client.invalidateQueries({ queryKey: queryKeys.content.catalog(owner) }),
    ]);
  };
  return {
    saveVoiceClone: useMutation({
      mutationFn: savePreparedVoiceClone.bind(null, apiClient),
      onSuccess: refresh,
    }),
    renameVoiceClone: useMutation({
      mutationFn: renameSavedVoiceClone.bind(null, apiClient),
      onSuccess: async (clone: PyVoiceContent) => {
        await Promise.all([
          refresh(),
          owner
            ? invalidateVoiceCloneConsumers(client, owner, clone.item_id)
            : Promise.resolve(),
        ]);
      },
    }),
  };
}

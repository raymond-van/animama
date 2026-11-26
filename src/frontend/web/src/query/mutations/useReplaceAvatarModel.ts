import { useProductApiClient } from "@animama/product-ui";
import type { PyAvatarContent } from "@animama/runtime-contracts/api-types";
import { saveAvatarContent } from "@animama/runtime-contracts/sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import {
  ContentSaveApiError,
  toContentSaveApiError,
} from "@/lib/content/contentSaveErrors";
import { queryKeys } from "@/query/keys";
import { invalidateAvatarPortraitPresentation } from "./avatarPortraitMutationCache";

export type ReplaceAvatarModelInput = {
  itemId: string;
  /** The Avatar revision the owner reviewed; the server refuses a newer one. */
  expectedRevision: string;
  file: File;
  /**
   * Kept with the same inputs across an uncertain retry, so the server
   * replays its saved result instead of writing again.
   */
  operationId: string;
};

/**
 * Replace a Local Avatar's VRM in place: the same item gets a new revision,
 * so every Anima that uses it loads the new model on its next runtime mount.
 * The Avatar's sidecar (name, description, identity) is left as it is; a
 * face part correction stamped with the old file's digest stops applying.
 */
export function useReplaceAvatarModel() {
  const client = useProductApiClient();
  const queryClient = useQueryClient();
  const owner = useRuntimeCacheKey();
  return useMutation<
    PyAvatarContent,
    ContentSaveApiError,
    ReplaceAvatarModelInput
  >({
    mutationFn: async ({ itemId, expectedRevision, file, operationId }) => {
      const response = await saveAvatarContent({
        client,
        // An existing item keeps its own file, so the route only needs a
        // valid path segment here; a Local item id always is one, unlike a
        // display or hand-copied file name.
        path: { entry_name: itemId },
        signal: AbortSignal.timeout(120_000),
        body: {
          operation_id: operationId,
          files: [file],
          catalog_item_id: itemId,
          expected_revision: expectedRevision,
        },
        requestValidator: undefined,
        responseValidator: undefined,
        throwOnError: false,
      });
      if (!response.data)
        throw toContentSaveApiError(
          response.error,
          response.response?.status ?? null,
        );
      return response.data;
    },
    onSuccess: () => {
      if (!owner) return;
      // Cards, profile fallbacks, the face part state and sharing views follow
      // the new revision; Anima pages read the next runtime. A mounted chat
      // stays on the runtime it prepared until it remounts.
      void invalidateAvatarPortraitPresentation(queryClient, owner);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.content.all(owner),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.animaLoadouts.runtimes(owner),
      });
    },
    retry: false,
  });
}

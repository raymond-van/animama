import { useProductApiClient } from "@animama/product-ui";
import type { PyAvatarContent } from "@animama/runtime-contracts/api-types";
import { saveAvatarContent } from "@animama/runtime-contracts/sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getI18n } from "react-i18next";

import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { getCatalogItem } from "@/lib/content/catalogApi";
import {
  ContentSaveApiError,
  toContentSaveApiError,
} from "@/lib/content/contentSaveErrors";
import { queryKeys } from "@/query/keys";
import { invalidateAvatarPortraitPresentation } from "./avatarPortraitMutationCache";

export type ReplaceAvatarModelInput = {
  itemId: string;
  /** The Avatar revision the owner reviewed; a newer one refuses the write. */
  expectedRevision: string;
  file: File;
  /** Kept across an uncertain retry so the server replays its receipt. */
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
      // The save route names its destination; an existing item keeps its own
      // file, so send that file's name rather than a display name the route
      // might not accept as a path segment.
      const stored = await getCatalogItem(client, itemId).catch((cause) => {
        throw toContentSaveApiError(cause);
      });
      if (stored.revision_sha256 !== expectedRevision)
        throw new ContentSaveApiError(
          409,
          "catalog_revision_conflict",
          getI18n().t("errors:contentSave.catalog_revision_conflict"),
        );
      const entryName = (stored.relative_locator.split("/").at(-1) ?? "")
        .replace(/\.vrm$/i, "")
        .trim();
      const response = await saveAvatarContent({
        client,
        path: { entry_name: entryName || itemId },
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
      // Cards, profile fallbacks and the face part state follow the new
      // revision; Anima pages read the next runtime. A mounted chat stays on
      // the runtime it prepared until it remounts.
      void invalidateAvatarPortraitPresentation(queryClient, owner);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.animaLoadouts.runtimes(owner),
      });
    },
    retry: false,
  });
}

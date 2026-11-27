import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type { ItemRevisionRef } from "@animama/runtime-contracts/api-types";
import { saveAvatarPortrait } from "@animama/runtime-contracts/sdk";
import { useProductApiClient } from "@animama/product-ui";
import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import {
  AVATAR_PORTRAIT_CAPTURE_PRESET_VERSION,
  AVATAR_PORTRAIT_RENDERER_VERSION,
} from "@/lib/avatar/portrait/captureAvatarPortrait";
import { bumpAvatarPortraitVersion } from "@/stores/avatar-portrait-version-store";
import { invalidateAvatarPortraitPresentation } from "./avatarPortraitMutationCache";

/**
 * Save a captured portrait as the Local Avatar's one portrait, fenced by the
 * Avatar revision it was captured from, then refresh every surface showing it.
 */
export function useSaveAvatarPortrait() {
  const client = useProductApiClient();
  const queryClient = useQueryClient();
  const userId = useRuntimeCacheKey();
  return useCallback(
    async (target: ItemRevisionRef, blob: Blob, signal: AbortSignal) => {
      await saveAvatarPortrait({
        client,
        path: { item_id: target.item_id },
        body: {
          // The endpoint keeps the file's `.webp` name; a bare Blob has none.
          file: new File([blob], "portrait.webp", { type: "image/webp" }),
          operation_id: `avatar-portrait-${crypto.randomUUID()}`,
          expected_avatar_revision: target.revision_sha256,
          renderer_version: AVATAR_PORTRAIT_RENDERER_VERSION,
          capture_preset_version: AVATAR_PORTRAIT_CAPTURE_PRESET_VERSION,
        },
        signal,
        throwOnError: true,
        // The generated multipart schema types `file` as a string.
        requestValidator: undefined,
        responseValidator: undefined,
      });
      // The portrait keeps its file URL; images showing it need a new one.
      bumpAvatarPortraitVersion(target.item_id);
      // Not awaited: a slow refetch must not count against the capture's timeout.
      if (userId)
        void invalidateAvatarPortraitPresentation(queryClient, userId);
    },
    [client, queryClient, userId],
  );
}

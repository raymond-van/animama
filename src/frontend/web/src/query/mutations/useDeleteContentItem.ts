import { useProductApiClient } from "@animama/product-ui";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { deleteCatalogItem } from "@/lib/content/catalogApi";
import type { ContentKind } from "@/lib/content/catalogTypes";
import type { ContentDeleteRequest } from "@/lib/content/contentDeletion";
import { queryKeys } from "@/query/keys";

/**
 * The views that list one kind of content: its Library family, the pickers
 * that offer it and the neutral catalog. A Local Avatar delete also removes
 * its unused portrait Appearance, so Avatars refresh Appearance views too.
 */
export function contentKindQueryKeys(
  owner: string,
  kind: ContentKind,
): QueryKey[] {
  const catalog = queryKeys.content.catalog(owner);
  switch (kind) {
    case "avatar":
      return [
        catalog,
        queryKeys.avatarCatalog.all(owner),
        queryKeys.avatars.all(owner),
        queryKeys.appearanceImages.all(owner),
        queryKeys.animaCreation.all(owner),
      ];
    case "gesture":
      return [
        catalog,
        queryKeys.gestures.all(owner),
        queryKeys.animaCreation.all(owner),
      ];
    case "reaction":
      return [
        catalog,
        queryKeys.reactions.all(owner),
        queryKeys.animaCreation.all(owner),
      ];
    case "pose":
      return [catalog, queryKeys.poses.all(owner)];
    case "particle_effect":
      return [catalog, queryKeys.particleEffects.all(owner)];
    case "avatar_effect":
      return [catalog, queryKeys.avatarEffects.all(owner)];
    case "scene_effect":
      return [catalog, queryKeys.sceneEffects.all(owner)];
    case "sound_effect":
      return [catalog, queryKeys.soundEffects.all(owner)];
    case "appearance":
      return [catalog, queryKeys.appearanceImages.all(owner)];
    case "voice":
      return [catalog, queryKeys.voiceContent.all(owner)];
    case "anima":
      return [catalog];
  }
}

/** Refresh every view of one kind of content after a delete attempt. */
export async function refreshContentKind(
  client: QueryClient,
  owner: string,
  kind: ContentKind,
): Promise<void> {
  await Promise.all(
    contentKindQueryKeys(owner, kind).map((queryKey) =>
      client.invalidateQueries({ queryKey }),
    ),
  );
}

/**
 * Delete one owned Local item of any kind at the revision it was shown at
 * (issue #950). Its kind's views refresh whether the delete succeeds or is
 * refused: a refusal usually means the item changed or is in use, and the
 * refresh lets a retry, and the views, use the item as it is now.
 */
export function useDeleteContentItem() {
  const apiClient = useProductApiClient();
  const owner = useRuntimeCacheKey();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: ContentDeleteRequest) =>
      deleteCatalogItem(apiClient, request.itemId, request.revision),
    onSettled: (_data, _error, request) =>
      owner ? refreshContentKind(client, owner, request.kind) : undefined,
  });
}

import { useProductApiClient } from "@animama/product-ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useRuntimeCacheKey } from "@/app/runtime/RuntimeOwnerContext";
import { getCatalogItem, getCatalogItemUsage } from "@/lib/content/catalogApi";
import type { ContentKind } from "@/lib/content/catalogTypes";
import {
  ContentDeleteError,
  type PyContentUsage,
} from "@/lib/content/contentDeletion";
import { queryKeys } from "@/query/keys";
import { refreshContentKind } from "@/query/mutations/useDeleteContentItem";

/** What the delete dialog learns about an item before Delete is offered. */
export type ContentDeletePreflight =
  | {
      available: true;
      /** What keeps the item from being deleted; empty when nothing does. */
      usedBy: PyContentUsage[];
      /** The item's current revision when the caller did not know it. */
      revision: string | null;
    }
  /** The server would not delete it: already gone, or not owned Local content. */
  | { available: false };

/** One open delete dialog's read; it is never shared or kept. */
const preflightKey = (owner: string, itemId: string) =>
  [...queryKeys.content.all(owner), "delete-preflight", itemId] as const;

/**
 * Read what uses an item before its delete is confirmed (R15), and its
 * revision when the caller has none (Library Avatar rows carry no revision).
 * It reads while `open`, afresh each time the dialog opens; a closing dialog
 * keeps the item it showed and its result. An item that is already gone
 * refreshes its kind's views, so they stop listing it.
 */
export function useContentDeletePreflight(
  target: {
    itemId: string;
    kind: ContentKind;
    revision: string | null;
  } | null,
  open: boolean,
) {
  const apiClient = useProductApiClient();
  const owner = useRuntimeCacheKey();
  const client = useQueryClient();
  const itemId = target?.itemId ?? "__none__";
  const kind = target?.kind ?? "anima";
  const knownRevision = target?.revision ?? null;
  return useQuery<ContentDeletePreflight>({
    queryKey: preflightKey(owner ?? "__anon__", itemId),
    enabled: Boolean(owner && target && open),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      let usedBy: PyContentUsage[];
      try {
        usedBy = await getCatalogItemUsage(apiClient, itemId, signal);
      } catch (error) {
        if (error instanceof ContentDeleteError && error.status === 404) {
          if (owner) void refreshContentKind(client, owner, kind);
          return { available: false };
        }
        throw error;
      }
      // Usage answered, so the item exists and Delete would accept it.
      const revision =
        knownRevision ??
        (await getCatalogItem(apiClient, itemId)).revision_sha256;
      return { available: true, usedBy, revision };
    },
  });
}

import type { Client } from "@animama/runtime-contracts/sdk";

import { listCatalogItems } from "./catalogApi";
import type { ContentKind } from "./catalogTypes";
import { createUniqueContentName } from "./uniqueContentName";

/**
 * The Included catalog item an effect template copies (matched by its
 * content ID), and an unused name for the new Local draft started from it,
 * for example "Heart Burst 1". Throws when this installation lacks the item.
 */
export async function findIncludedTemplateItem(
  apiClient: Client,
  kind: ContentKind,
  template: { contentId: string; name: string },
  signal: AbortSignal,
) {
  const items = await listCatalogItems(apiClient, kind, signal);
  const item = items.find(
    (candidate) =>
      candidate.source === "included" &&
      candidate.logical_key === template.contentId,
  );
  if (!item)
    throw new Error(`${template.name} is not available in this installation.`);
  return {
    item,
    draftName: createUniqueContentName(
      item.name,
      items.map((candidate) => candidate.name),
    ),
  };
}

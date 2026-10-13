import type { Client } from "@animama/runtime-contracts/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { findIncludedTemplateItem } from "./includedTemplateItem";

const catalog = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
  kinds: [] as unknown[],
}));

vi.mock("./catalogApi", () => ({
  listCatalogItems: async (_client: unknown, kind: unknown) => {
    catalog.kinds.push(kind);
    return catalog.items;
  },
}));

const apiClient = {} as Client;
const heartBurst = {
  contentId: "builtin:particle-effect:heart-burst",
  name: "Heart Burst",
};

describe("findIncludedTemplateItem", () => {
  beforeEach(() => {
    catalog.kinds = [];
    catalog.items = [
      {
        item_id: "local-heart",
        source: "local",
        logical_key: "builtin:particle-effect:heart-burst",
        name: "Heart Burst 1",
      },
      {
        item_id: "included-heart",
        source: "included",
        logical_key: "builtin:particle-effect:heart-burst",
        name: "Heart Burst",
      },
    ];
  });

  it("finds the Included item by content ID and names its draft with an unused name", async () => {
    const found = await findIncludedTemplateItem(
      apiClient,
      "particle_effect",
      heartBurst,
      new AbortController().signal,
    );

    expect(catalog.kinds).toEqual(["particle_effect"]);
    expect(found.item.item_id).toBe("included-heart");
    // "Heart Burst" and "Heart Burst 1" are taken.
    expect(found.draftName).toBe("Heart Burst 2");
  });

  it("reports a template whose Included item this installation lacks", async () => {
    catalog.items = catalog.items.filter((item) => item.source !== "included");

    await expect(
      findIncludedTemplateItem(
        apiClient,
        "particle_effect",
        heartBurst,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Heart Burst is not available in this installation.");
  });
});

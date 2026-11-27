import { describe, expect, it } from "vitest";

import type { PyAnimaListItem } from "@/lib/content/catalogTypes";
import type { AnimaRuntimeCatalogSnapshot } from "@/lib/runtime-content/types";
import {
  contentCreatorCatalogAvatarItemId,
  contentCreatorIncludedAvatarSource,
  contentCreatorModelCatalogItemId,
  contentCreatorModelPreviewTarget,
  contentCreatorModelSourceFromAnima,
  contentCreatorOwnAvatarSource,
  selectContentCreatorPreviewAnima,
} from "./contentCreatorModelPreview";

function anima(id: string): PyAnimaListItem {
  return {
    id,
    display_name: id,
    aggregate_revision: 1,
    identity_status: "ready",
    presentation: {
      anima_id: id,
      presentation_revision: `presentation:${id}`,
      display_name: id,
    },
  };
}

function runtime(): AnimaRuntimeCatalogSnapshot {
  return {
    schema_version: 1,
    effective_revision: "runtime-7",
    loadout_revision: 7,
    app_catalog_version: 1,
    avatar_model: {
      slot: "primary_model",
      runtime_id: "primary",
      kind: "avatar_model",
      display_name: "Equipped Model",
      description: null,
      config_schema_version: 1,
      config: {},
      content_revision: "model-3",
      source: {
        type: "public_url",
        url: "/vrm/Annie.vrm",
      },
    },
    idle_animations: [],
    gestures: [],
    poses: [],
    reactions: [],
    particle_vfx: [],
    avatar_vfx: [],
    scene_background_vfx: [],
    scene_focus_vfx: [],
    background_image: null,
    profile_image: null,
    sfx: [],
    warnings: [],
  };
}

describe("Content Creator model preview", () => {
  it("selects remembered, stale fallback, and no-Anima states deterministically", () => {
    const animas = [anima("anima-a"), anima("anima-b")];

    expect(selectContentCreatorPreviewAnima(animas, "anima-b")).toMatchObject({
      anima: { id: "anima-b" },
      status: "remembered",
    });
    expect(selectContentCreatorPreviewAnima(animas, "deleted")).toMatchObject({
      anima: { id: "anima-a" },
      status: "stale_fallback",
    });
    expect(selectContentCreatorPreviewAnima([], "deleted")).toEqual({
      anima: null,
      status: "none",
    });
  });

  it("requires the exact immutable resolved model revision", () => {
    const selectedRuntime = runtime();
    const source = contentCreatorModelSourceFromAnima(
      "anima-a",
      selectedRuntime,
    );

    expect(
      contentCreatorModelPreviewTarget({
        source,
        animaId: "anima-a",
        runtime: selectedRuntime,
        ownerKey: "particle-vfx-creator",
      }),
    ).toMatchObject({
      sourceType: "resolved_entry",
      entry: { content_revision: "model-3" },
    });
    expect(
      contentCreatorModelPreviewTarget({
        source,
        animaId: "anima-b",
        runtime: selectedRuntime,
        ownerKey: "particle-vfx-creator",
      }),
    ).toBeNull();
  });

  it("previews an Included or own Avatar through its catalog item", () => {
    const item = { catalog_item_id: "item-1", name: "Fox" };
    const own = contentCreatorOwnAvatarSource(item);
    const included = contentCreatorIncludedAvatarSource(item);
    expect(own).toMatchObject({
      key: "own:item-1",
      sourceType: "own_avatar",
      itemId: "item-1",
      displayName: "Fox",
      sourceLabel: "My Avatar",
      versionLabel: "Your Avatar",
    });
    // One Avatar listed both ways is two different choices.
    expect(own.key).not.toBe(included.key);
    expect(own.runtimeId).not.toBe(included.runtimeId);
    for (const source of [own, included]) {
      expect(contentCreatorCatalogAvatarItemId(source)).toBe("item-1");
      expect(contentCreatorModelCatalogItemId(source)).toBe("item-1");
      // Neither resolves through an Anima's runtime.
      expect(
        contentCreatorModelPreviewTarget({
          source,
          animaId: "anima-a",
          runtime: runtime(),
          ownerKey: "pose-creator",
        }),
      ).toBeNull();
    }
  });

  it("previews an Anima's model through that Anima's runtime, not a catalog item", () => {
    const source = contentCreatorModelSourceFromAnima("anima-a", runtime());
    expect(contentCreatorCatalogAvatarItemId(source)).toBeNull();
    expect(contentCreatorCatalogAvatarItemId(null)).toBeNull();
    expect(contentCreatorModelCatalogItemId(source)).toBeNull();
  });
});

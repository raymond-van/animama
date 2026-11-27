import { describe, expect, it } from "vitest";
import type { LibraryProductCard } from "./libraryPresentation";
import {
  avatarLibraryDescription,
  effectLibraryCard,
  filterAndSortLibraryGestures,
  libraryProductActionPolicy,
  libraryProductMetadata,
  libraryRowPresentation,
  actionLibraryCard,
  contentRowDescription,
  poseLibraryCard,
} from "./libraryPresentation";

function card(
  family: LibraryProductCard["family"],
  origin: LibraryProductCard["origin"] = "Built-in",
): LibraryProductCard {
  return {
    key: `${family}:one`,
    itemId: `${family}-one`,
    family,
    name: "Example",
    description: "Example description",
    origin,
    sourceLabel: "Included",
    updateAvailable: family === "gesture",
    equippedCount: family === "gesture" ? 2 : 0,
    includedCount: family === "gesture" ? 3 : 0,
    source: {
      type: "builtin",
      content_id: `builtin:${family}:one`,
      version: 2,
    },
  };
}

describe("Library product presentation", () => {
  it("offers Pose editing without equipment or Reaction insertion", () => {
    expect(libraryProductActionPolicy(card("pose", "Mine"))).toMatchObject({
      preview: true,
      manage: false,
      edit: true,
      useInGesture: false,
      useInReaction: false,
    });
    expect(libraryProductActionPolicy(card("pose"))).toMatchObject({
      preview: true,
      manage: false,
      edit: true,
      useInGesture: false,
      useInReaction: false,
    });
  });
  it("never needs a technical file kind to present a Gesture", () => {
    const card = actionLibraryCard("gesture", {
      item_id: "gesture-1",
      name: "Sparkle Wave",
      description: "A bright greeting",
      origin: "builtin",
      source: {
        type: "builtin",
        content_id: "builtin:gesture:wave",
        version: 1,
      },
      state: "ready",
      semantic_key: "sparkle_wave",
      update_available: false,
      created_at: null,
      updated_at: null,
    });
    expect(card).toMatchObject({
      family: "gesture",
      name: "Sparkle Wave",
      origin: "Built-in",
    });
    expect(card).not.toHaveProperty("kind");
  });

  it("reads a listed Reaction's suggested emotion and intensity", () => {
    const card = actionLibraryCard("reaction", {
      item_id: "reaction-1",
      name: "Joy Reaction 4",
      description: null,
      origin: "builtin",
      source: {
        type: "builtin",
        content_id: "builtin:reaction:joy-4",
        version: 1,
      },
      state: "ready",
      emotion: "joy",
      intensity: 4,
      update_available: false,
      created_at: null,
      updated_at: null,
    });
    expect(card).toMatchObject({ emotion: "joy", intensity: 4 });
    // The row names the suggested cell with the intensity labels.
    expect(libraryProductMetadata(card)).toEqual(["Joy · Intense"]);
  });

  it.each(["gesture", "reaction"] as const)(
    "keeps %s Preview and Add/Manage domain actions",
    (family) => {
      expect(libraryProductActionPolicy(card(family))).toEqual({
        preview: true,
        manage: true,
        edit: true,
        useInGesture: false,
        useInReaction: false,
        delete: false,
      });
    },
  );

  it.each([
    "gesture",
    "reaction",
    "pose",
    "particle",
    "avatar-effect",
    "scene",
    "sound",
  ] as const)("offers Delete on a Local %s with a revision only", (family) => {
    const local = { ...card(family, "Mine"), revision: "r1" };
    expect(libraryProductActionPolicy(local).delete).toBe(true);
    // Included content is read-only.
    expect(
      libraryProductActionPolicy({ ...card(family), revision: "r1" }).delete,
    ).toBe(false);
    // An item whose files could not be read has no revision to delete at.
    expect(
      libraryProductActionPolicy({ ...local, revision: null }).delete,
    ).toBe(false);
  });

  it("carries each family's revision for a fenced delete", () => {
    expect(
      effectLibraryCard("sound", {
        item_id: "bell",
        name: "Bell",
        description: null,
        origin: "owned",
        source: null,
        state: "ready",
        revision_sha256: "sound-revision",
        created_at: null,
        updated_at: null,
      }).revision,
    ).toBe("sound-revision");
    expect(
      poseLibraryCard({
        item_id: "wave",
        pose_id: "local:pose:wave",
        name: "Wave",
        source: "local",
        editable: true,
        revision_sha256: "pose-revision",
      } as Parameters<typeof poseLibraryCard>[0]).revision,
    ).toBe("pose-revision");
  });

  it("explains why a non-portable Action cannot be edited", () => {
    const gesture = libraryProductActionPolicy({
      ...card("gesture"),
      nonPortable: true,
    });
    expect(gesture).toMatchObject({ preview: true, manage: true, edit: false });
    expect(gesture.editUnavailableReason).toMatch(/use here only/);
    expect(
      actionLibraryCard("gesture", {
        item_id: "sway",
        name: "Sway",
        description: null,
        origin: "builtin",
        source: null,
        state: "ready",
        created_at: null,
        updated_at: null,
        portability: "non-portable",
      } as never).nonPortable,
    ).toBe(true);
  });

  it.each(["particle", "avatar-effect", "scene", "sound"] as const)(
    "keeps %s reusable component actions",
    (family) => {
      expect(libraryProductActionPolicy(card(family))).toMatchObject({
        preview: true,
        manage: false,
        useInGesture: true,
        useInReaction: true,
      });
    },
  );

  it("offers Edit for every owned ready product with a typed editor", () => {
    expect(libraryProductActionPolicy(card("gesture", "Mine")).edit).toBe(true);
    expect(libraryProductActionPolicy(card("particle", "Mine")).edit).toBe(
      true,
    );
    expect(libraryProductActionPolicy(card("sound", "Mine")).edit).toBe(true);
    expect(libraryProductActionPolicy(card("avatar-effect", "Mine")).edit).toBe(
      true,
    );
    expect(libraryProductActionPolicy(card("scene", "Mine")).edit).toBe(true);
    expect(
      libraryProductActionPolicy({ ...card("gesture", "Mine"), source: null })
        .edit,
    ).toBe(false);
  });

  it("labels a ready owned Effect as Local", () => {
    const result = effectLibraryCard("avatar-effect", {
      item_id: "avatar-effect-1",
      name: "Star Eyes",
      description: "Stars over both eyes",
      origin: "owned",
      source: {
        type: "catalog",
        catalog_item_id: "avatar-effect-1",
        logical_key: "local:avatar-effect:star-eyes",
      },
      state: "ready",
      created_at: null,
      updated_at: null,
    });

    expect(result.sourceLabel).toBe("Local");
  });

  it("drops an Effect's preview sources only when the runtime offers no previews", () => {
    const particle = {
      item_id: "particle-1",
      name: "Sparkles",
      description: null,
      origin: "builtin" as const,
      source: null,
      state: "ready" as const,
      created_at: null,
      updated_at: null,
      thumbnail_url: "/v1/content/files/texture?variant=thumbnail",
      particle_thumbnail: {
        manifestUrl: "/v1/content/files/manifest",
        texturePath: "texture.png",
        revision: "r1",
      },
    };

    expect(effectLibraryCard("particle", particle)).toMatchObject({
      thumbnailUrl: particle.thumbnail_url,
      particleThumbnail: particle.particle_thumbnail,
    });
    const withheld = effectLibraryCard("particle", particle, false);
    expect(withheld).not.toHaveProperty("thumbnailUrl");
    expect(withheld).not.toHaveProperty("particleThumbnail");
  });

  it("keeps statuses in badges without repeating origin metadata", () => {
    const gesture = card("gesture");
    expect(libraryProductMetadata(gesture)).toEqual([]);
    expect(libraryRowPresentation(gesture)).toMatchObject({
      family: "gesture",
      includedCount: 3,
      updateAvailable: true,
      equippedCount: 2,
    });
  });

  it("filters and sorts Gestures with the Anima Loadout choices", () => {
    const custom = {
      ...card("gesture", "Mine"),
      key: "gesture:custom",
      name: "Wave",
      updateAvailable: false,
      equippedCount: 0,
    };
    const starter = {
      ...card("gesture", "Built-in"),
      key: "gesture:starter",
      name: "Bow",
    };

    expect(
      filterAndSortLibraryGestures([starter, custom], {
        gestureUpdatesOnly: false,
        gestureStatus: "all",
        gestureSort: "custom-first",
      }).map((gesture) => gesture.key),
    ).toEqual(["gesture:custom", "gesture:starter"]);
    expect(
      filterAndSortLibraryGestures([starter, custom], {
        gestureUpdatesOnly: false,
        gestureStatus: "unequipped",
        gestureSort: "name-asc",
      }).map((gesture) => gesture.name),
    ).toEqual(["Wave"]);
    expect(
      filterAndSortLibraryGestures([starter, custom], {
        gestureUpdatesOnly: true,
        gestureStatus: "equipped",
        gestureSort: "name-desc",
      }).map((gesture) => gesture.name),
    ).toEqual(["Bow"]);
  });

  it("turns Avatar identity markdown into a concise row description", () => {
    expect(
      avatarLibraryDescription(
        "# Annie\n\n## Appearance\nAnnie has short dark hair.\n\n## Personality",
      ),
    ).toBe("Annie has short dark hair.");
    expect(avatarLibraryDescription("# Empty")).toBe("");
    expect(contentRowDescription("Reusable avatar pose clip")).toBe("");
    expect(contentRowDescription("Orbiting question marks and dots.")).toBe(
      "Orbiting question marks and dots.",
    );
  });
});

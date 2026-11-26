import { describe, expect, it } from "vitest";

import type {
  PyAnimaRuntime,
  PyRuntimeAvatar,
} from "@/lib/content/catalogTypes";
import { AnimaRuntimeCatalog } from "./AnimaRuntimeCatalog";
import { runtimeAvatarItemRevision } from "./runtimeAvatarFaceParts";
import { adaptRuntimeSnapshot } from "./runtimeSnapshotAdapter";

function avatar(): PyRuntimeAvatar {
  return {
    source: {
      type: "catalog_item",
      item_id: "avatar-test",
      source: "included",
      revision: "builtin:avatar-test:1",
    },
    avatar_id: "avatar-test",
    revision: "builtin:avatar-test:1",
    files: [],
  };
}

function descriptor(): PyAnimaRuntime["content_descriptor"] {
  return {
    revision: "rcd1-test",
    total_bytes: 0,
    roots: [],
    entries: [],
    members: [],
    diagnostics: [],
  };
}

/** An admitted Reaction as the runtime lists it: once, however many cells hold it. */
function runtimeReaction(
  itemId: string,
  files = true,
): NonNullable<PyAnimaRuntime["reactions"]>[number] {
  return {
    binding_id: `reaction:${itemId}`,
    runtime_root_id: `root-${itemId}`,
    content_type: "reaction",
    source: {
      type: "catalog_item",
      item_id: itemId,
      source: "local",
      revision: `${itemId}-revision`,
    },
    name: itemId,
    // Only the document's suggestion; the pools decide where it plays.
    emotion: "joy",
    intensity: 1,
    implementation: { kind: "anima_clip", file_role: "sequence" },
    config: {},
    reference_map: {},
    files: files
      ? [
          {
            file_ref: `${itemId}-sequence`,
            role: "sequence",
            ordinal: 1,
            filename: `${itemId}.json`,
            media_type: "application/json",
            size_bytes: 64,
            sha256: "c".repeat(64),
            url: `/runtime/${itemId}`,
          },
        ]
      : [],
  };
}

describe("adaptRuntimeSnapshot", () => {
  it("adapts each Reaction once and maps its cells to pools of runtime ids", () => {
    const runtime = adaptRuntimeSnapshot({
      catalog_version: 1,
      loadout_revision: 4,
      effective_revision: "tr1-reaction-pools",
      lease_expires_at: "2026-08-11T00:00:00Z",
      content_descriptor: descriptor(),
      avatar: avatar(),
      gestures: [],
      reactions: [
        runtimeReaction("cheer"),
        runtimeReaction("grin"),
        // Listed without files, so it did not mount and plays nowhere.
        runtimeReaction("broken", false),
      ],
      reaction_cells: {
        joy: { "1": ["cheer"], "4": ["cheer", "grin", "broken"] },
        // Absent from the runtime's Reactions: it was left out with a diagnostic.
        anger: { "2": ["missing"] },
        sadness: { "3": [] },
      },
      particle_effects: [],
      avatar_effects: [],
      scene_effects: [],
      sound_effects: [],
      warnings: [],
    } satisfies PyAnimaRuntime);

    // A Reaction in two cells is one runtime entry, named by its binding.
    expect(runtime.reactions.map((entry) => entry.runtime_id)).toEqual([
      "reaction:cheer",
      "reaction:grin",
    ]);
    expect(runtime.reaction_pools).toEqual({
      joy: {
        "1": ["reaction:cheer"],
        "4": ["reaction:cheer", "reaction:grin"],
      },
      anger: {},
      sadness: {},
    });
  });

  it("projects no pools when the runtime has no Reaction cells", () => {
    const runtime = adaptRuntimeSnapshot({
      catalog_version: 1,
      loadout_revision: 1,
      effective_revision: "tr1-no-cells",
      lease_expires_at: "2026-08-11T00:00:00Z",
      content_descriptor: descriptor(),
      avatar: avatar(),
      gestures: [],
      reactions: [runtimeReaction("cheer")],
      particle_effects: [],
      avatar_effects: [],
      scene_effects: [],
      sound_effects: [],
      warnings: [],
    } satisfies PyAnimaRuntime);

    expect(runtime.reaction_pools).toEqual({});
  });

  it("maps an Included Avatar through its registered catalog file", () => {
    const runtime = adaptRuntimeSnapshot({
      catalog_version: 1,
      loadout_revision: 1,
      effective_revision: "tr1-avatar",
      lease_expires_at: "2026-08-11T00:00:00Z",
      content_descriptor: descriptor(),
      avatar: {
        ...avatar(),
        files: [
          {
            file_ref: "included-avatar-vrm",
            role: "vrm",
            ordinal: 1,
            filename: "Annie.vrm",
            media_type: "model/gltf-binary",
            size_bytes: 100,
            sha256: "a".repeat(64),
            url: "/v1/content/files/included-avatar-vrm",
          },
        ],
      },
      gestures: [],
      reactions: [],
      particle_effects: [],
      avatar_effects: [],
      scene_effects: [],
      sound_effects: [],
      warnings: [],
    } satisfies PyAnimaRuntime);

    expect(runtime.avatar_model?.source).toMatchObject({
      type: "authorized_files",
      files: [
        {
          role: "vrm",
          filename: "Annie.vrm",
          url: "/v1/content/files/included-avatar-vrm",
        },
      ],
    });
    // The mounted item and revision, so a portrait names what is on screen.
    expect(runtimeAvatarItemRevision(runtime.avatar_model)).toEqual({
      item_id: "avatar-test",
      revision_sha256: "builtin:avatar-test:1",
    });
  });

  it("mounts a private Gesture and its aliased support without equip rows", () => {
    const runtime = adaptRuntimeSnapshot({
      catalog_version: 1,
      loadout_revision: 2,
      effective_revision: "tr1-two",
      lease_expires_at: "2026-08-11T00:00:00Z",
      content_descriptor: descriptor(),
      avatar: avatar(),
      gestures: [
        {
          binding_id: "gesture-one",
          content_type: "gesture",
          source: {
            type: "catalog_item",
            item_id: "gesture-item",
            source: "local",
            revision: "gesture-release",
          },
          name: "Sparkle wave",
          semantic_key: "sparkle_wave",
          implementation: { kind: "anima_clip" },
          config: {},
          reference_map: { sparkle: "pe-one" },
          files: [
            {
              file_ref: "root-file",
              role: "sequence",
              ordinal: 1,
              filename: "wave.json",
              media_type: "application/json",
              size_bytes: 12,
              sha256: "a".repeat(64),
              url: "/root-file",
            },
          ],
        },
      ],
      reactions: [],
      particle_effects: [
        {
          runtime_id: "pe-one",
          content_type: "particle_effect",
          source: {
            type: "catalog_item",
            item_id: "particle-item",
            source: "local",
            revision: "particle-release",
          },
          name: "Sparkle",
          config: {},
          files: [
            {
              file_ref: "support-file",
              role: "effect",
              ordinal: 1,
              filename: "sparkle.json",
              media_type: "application/json",
              size_bytes: 10,
              sha256: "b".repeat(64),
              url: "/support-file",
            },
          ],
        },
      ],
      avatar_effects: [],
      scene_effects: [],
      sound_effects: [],
      warnings: [],
    } satisfies PyAnimaRuntime);

    expect(runtime.effective_revision).toBe("tr1-two");
    expect(runtime.gestures.map((entry) => entry.runtime_id)).toContain(
      "sparkle_wave",
    );
    expect(runtime.particle_vfx.map((entry) => entry.runtime_id)).toContain(
      "pe-one",
    );
    expect(runtime.gestures[0]?.config.runtime_reference_map).toEqual({
      sparkle: "pe-one",
    });
  });

  it("mounts Included roots and supports from registered files", () => {
    const runtime = adaptRuntimeSnapshot({
      catalog_version: 1,
      loadout_revision: 2,
      effective_revision: "tr1-builtin",
      lease_expires_at: "2026-08-11T00:00:00Z",
      content_descriptor: descriptor(),
      avatar: avatar(),
      gestures: [
        {
          binding_id: "gesture-builtin",
          content_type: "gesture",
          source: {
            type: "catalog_item",
            item_id: "builtin:gesture:exclaim_frustrated",
            source: "included",
            revision: "included-gesture-revision",
          },
          name: "Exclaim Frustrated",
          semantic_key: "exclaim_frustrated",
          implementation: {
            kind: "vrma",
          },
          config: {},
          reference_map: { angry: "avatar-angry" },
          files: [
            {
              file_ref: "included-gesture",
              role: "animation",
              ordinal: 1,
              filename: "exclaim_frustrated.vrma",
              media_type: "model/gltf-binary",
              size_bytes: 100,
              sha256: "b".repeat(64),
              url: "/v1/content/files/included-gesture",
            },
          ],
        },
      ],
      reactions: [],
      particle_effects: [],
      avatar_effects: [
        {
          runtime_id: "avatar-angry",
          content_type: "avatar_effect",
          source: {
            type: "catalog_item",
            item_id: "builtin:avatar-effect:angry",
            source: "included",
            revision: "included-avatar-effect-revision",
          },
          name: "Angry",
          config: {},
          definition: {
            schema: "animama/avatar-effect/2",
            region: "emote",
            attachment: {
              kind: "face_landmark",
              landmark: "forehead",
              position: "left",
            },
            art: { image: "angry.png" },
          },
          logical_resource_urls: {
            "angry.png": "/v1/content/files/included-avatar-effect-image",
          },
          files: [
            {
              file_ref: "included-avatar-effect-image",
              role: "image",
              ordinal: 1,
              filename: "angry.png",
              media_type: "image/png",
              size_bytes: 100,
              sha256: "c".repeat(64),
              url: "/v1/content/files/included-avatar-effect-image",
            },
          ],
        },
      ],
      scene_effects: [],
      sound_effects: [],
      warnings: [],
    } as PyAnimaRuntime);

    expect(runtime.gestures.map((entry) => entry.runtime_id)).toContain(
      "exclaim_frustrated",
    );
    expect(runtime.avatar_vfx.map((entry) => entry.runtime_id)).toContain(
      "avatar-angry",
    );
  });

  it("keeps registered effect bytes inside an authored reaction closure", async () => {
    const runtime = adaptRuntimeSnapshot({
      catalog_version: 1,
      loadout_revision: 2,
      effective_revision: "tr1-reaction-vfx",
      lease_expires_at: "2026-08-11T00:00:00Z",
      content_descriptor: descriptor(),
      avatar: avatar(),
      gestures: [],
      reactions: [
        {
          binding_id: "reaction:reaction-item",
          content_type: "reaction",
          source: {
            type: "catalog_item",
            item_id: "reaction-item",
            source: "included",
            revision: "reaction-revision",
          },
          name: "Joy Reaction 3",
          semantic_key: "joy-3",
          emotion: "joy",
          intensity: 3,
          implementation: { kind: "anima_clip", file_role: "sequence" },
          config: {},
          reference_map: {
            "emote_!": "emote",
            "scene-vfx-emotion-joy": "scene-joy",
          },
          files: [
            {
              file_ref: "reaction-sequence",
              role: "sequence",
              ordinal: 1,
              filename: "joy-3.json",
              media_type: "application/json",
              size_bytes: 512,
              sha256: "d".repeat(64),
              url: "/runtime/reaction-sequence",
            },
          ],
        },
      ],
      particle_effects: [],
      avatar_effects: [
        {
          runtime_id: "emote",
          content_type: "avatar_effect",
          source: {
            type: "catalog_item",
            item_id: "avatar-effect-item",
            source: "included",
            revision: "avatar-effect-revision",
          },
          name: "Emote !",
          config: {},
          definition: {
            schema: "animama/avatar-effect/2",
            region: "emote",
            attachment: {
              kind: "face_landmark",
              landmark: "forehead",
              position: "left",
            },
            art: { image: "emote.png" },
          },
          logical_resource_urls: {
            "emote.png": "/runtime/avatar-emote-image",
          },
          files: [
            {
              file_ref: "avatar-emote-image",
              role: "image",
              ordinal: 1,
              filename: "emote.png",
              media_type: "image/png",
              size_bytes: 128,
              sha256: "e".repeat(64),
              url: "/runtime/avatar-emote-image",
            },
          ],
        },
      ],
      scene_effects: [
        {
          runtime_id: "scene-joy",
          content_type: "scene_effect",
          source: {
            type: "catalog_item",
            item_id: "scene-effect-item",
            source: "included",
            revision: "scene-effect-revision",
          },
          name: "Emotion Joy",
          config: {},
          definition: {
            schema: "animama/scene-effect/1",
            kind: "background_layers",
            solid: { enabled: true, color: "#ffffff" },
            pattern: { enabled: false },
            marquee: { enabled: false, items: [] },
          },
          files: [],
        },
      ],
      sound_effects: [],
      warnings: [],
    } as PyAnimaRuntime);

    expect(runtime.avatar_vfx[0]?.source).toMatchObject({
      type: "authorized_files",
      files: [expect.objectContaining({ url: "/runtime/avatar-emote-image" })],
    });
    expect(runtime.scene_background_vfx[0]?.source).toEqual({
      type: "authorized_files",
      files: [],
      logical_resource_urls: {},
    });
    expect(runtime.warnings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "support_files_unavailable" }),
      ]),
    );

    const catalog = new AnimaRuntimeCatalog(runtime, {
      fetcher: async () =>
        new Response(
          JSON.stringify({
            schema: "animaPoseClip/2.0",
            id: "joy-3",
            name: "Joy Reaction 3",
            duration: 1,
            beats: [],
            events: [
              {
                id: "avatar-emote",
                time: 0,
                kind: "avatar_vfx",
                effectId: "emote_!",
              },
              {
                id: "scene-joy",
                time: 0,
                kind: "scene_vfx",
                sceneKind: "background_layers",
                presetId: "scene-vfx-emotion-joy",
              },
            ],
          }),
          { status: 200 },
        ),
    });

    await expect(
      catalog.loadReactionClip("reaction:reaction-item"),
    ).resolves.toMatchObject({
      events: [
        expect.objectContaining({ effectId: "emote" }),
        expect.objectContaining({ presetId: "scene-joy" }),
      ],
    });
  });

  it("uses a private Scene definition to select the focus lane", () => {
    const runtime = adaptRuntimeSnapshot({
      catalog_version: 1,
      loadout_revision: 3,
      effective_revision: "tr1-private-scene",
      lease_expires_at: "2026-08-11T00:00:00Z",
      content_descriptor: descriptor(),
      avatar: avatar(),
      gestures: [],
      reactions: [],
      particle_effects: [],
      avatar_effects: [],
      scene_effects: [
        {
          runtime_id: "scene-focus-private",
          content_type: "scene_effect",
          source: {
            type: "catalog_item",
            item_id: "scene-item",
            source: "local",
            revision: "scene-release",
          },
          name: "Focus",
          config: {},
          definition: { kind: "focus_lines" },
          files: [
            {
              file_ref: "private-scene-definition",
              role: "definition",
              ordinal: 1,
              filename: "focus.json",
              media_type: "application/json",
              size_bytes: 100,
              sha256: "d".repeat(64),
              url: "/v1/content/files/private-scene-definition",
            },
          ],
        },
      ],
      sound_effects: [],
      warnings: [],
    } as PyAnimaRuntime);

    expect(runtime.scene_focus_vfx).toHaveLength(1);
    expect(runtime.scene_background_vfx).toHaveLength(0);
    expect(runtime.scene_focus_vfx[0]?.definition).toEqual({
      kind: "focus_lines",
    });
  });

  it("replaces compatibility presentation with the exact Avatar and Appearance releases", () => {
    const runtime = adaptRuntimeSnapshot({
      catalog_version: 1,
      loadout_revision: 3,
      effective_revision: "tr1-appearance",
      lease_expires_at: "2026-08-11T00:00:00Z",
      content_descriptor: descriptor(),
      avatar: {
        source: {
          type: "catalog_item",
          item_id: "avatar-private",
          source: "local",
          revision: "avatar-release-digest",
        },
        avatar_id: "avatar-private",
        revision: "avatar-release-digest",
        files: [
          {
            file_ref: "avatar-file",
            role: "vrm",
            ordinal: 1,
            filename: "avatar.vrm",
            media_type: "model/gltf-binary",
            size_bytes: 100,
            sha256: "c".repeat(64),
            url: "/runtime/avatar-file",
          },
        ],
      },
      appearances: [
        {
          binding_id: "profile-binding",
          use: "profile",
          source: {
            type: "catalog_item",
            item_id: "profile-item",
            source: "local",
            revision: "profile-release-digest",
          },
          revision: "profile-release-digest",
          width: 512,
          height: 512,
          presentation: {
            fit: "cover",
            focal_x: 0.25,
            focal_y: 0.75,
            zoom: 1.2,
          },
          files: [
            {
              file_ref: "profile-file",
              role: "image",
              ordinal: 1,
              filename: "profile.webp",
              media_type: "image/webp",
              size_bytes: 25,
              sha256: "d".repeat(64),
              url: "/runtime/profile-file",
            },
          ],
        },
      ],
      gestures: [],
      reactions: [],
      particle_effects: [],
      avatar_effects: [],
      scene_effects: [],
      sound_effects: [],
      warnings: [],
    } satisfies PyAnimaRuntime);

    expect(runtime.avatar_model?.source.type).toBe("authorized_files");
    expect(runtime.avatar_model?.source).toMatchObject({
      files: [{ url: "/runtime/avatar-file" }],
    });
    expect(runtime.profile_image).toMatchObject({
      runtime_id: "profile",
      config: { fit: "cover", focal_x: 0.25, focal_y: 0.75, zoom: 1.2 },
      source: { files: [{ url: "/runtime/profile-file" }] },
    });
    expect(runtime.background_image).toBeNull();
  });
});

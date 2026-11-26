import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PyGesture,
  PyActionPreview,
  PyReaction,
} from "@/lib/content/catalogTypes";
import { createGestureDocument } from "@/ui/gesture-editor/gestureDocument";
import { createReactionDocument } from "@/ui/reaction-editor/reactionDocument";
import { unsupportedAnimaPoseClipFormatMessage } from "@/lib/avatar/poses/animaPoseClip";
import {
  isCustomizableStarterAction,
  actionDocumentFromPreview,
  removedActionEffects,
  starterGestureSemanticKey,
} from "./actionDocumentLoader";
import { unresolvedActionReferences } from "./actionProject";

afterEach(() => vi.unstubAllGlobals());

function item(input: {
  intent: "gesture" | "reaction";
  id: string;
  name: string;
}): PyGesture | PyReaction {
  return {
    item_id: input.id,
    name: input.name,
    description: "Starter description",
    catalog_source: "included",
    logical_key: input.id,
    origin: "builtin",
    source: { type: "builtin", content_id: input.id, version: 1 },
    state: "ready",
    revision: 1,
    created_at: null,
    updated_at: null,
    update_available: false,
    included_resource_counts: {},
    ...(input.intent === "gesture" ? { semantic_key: "starter_key" } : {}),
  } as PyGesture | PyReaction;
}

function preview(input: {
  intent: "gesture" | "reaction";
  id: string;
  key: string;
  semanticKey?: string;
}): PyActionPreview {
  return {
    preview_id: `preview:${input.id}`,
    revision: "revision-1",
    revision_sha256: "revision-1",
    expires_at: "2026-08-16T12:00:00Z",
    files: [],
    metadata: {},
    closure: {
      root: {
        content_type: input.intent,
        catalog_source: "included",
        source: { type: "builtin", content_id: input.id, version: 1 },
        name: input.id,
        description: "Starter AI description",
        semantic_key: input.semanticKey,
        placement_hint: { emotion: "admiration", intensity: 2 },
        implementation: {
          kind: "anima_clip",
          technical_source: {
            type: "runtime_catalog",
            catalog:
              input.intent === "gesture"
                ? "avatar_pose_clips"
                : "avatar_reaction_clips",
            key: input.key,
          },
        },
        reference_map: { sparkle: "support-1" },
        files: [],
      },
      supports: [
        {
          runtime_id: "support-1",
          content_type: "particle_effect",
          source: {
            type: "builtin",
            content_id: "builtin:particle-effect:hearts",
            version: 1,
          },
        },
      ],
      revision: "revision-1",
      diagnostics: [],
    },
  } as PyActionPreview;
}

function ownedReaction(): PyReaction {
  return {
    ...(item({
      intent: "reaction",
      id: "reaction-owned",
      name: "My Reaction",
    }) as PyReaction),
    origin: "owned",
    catalog_source: "local",
    logical_key: "local:reaction:my-reaction",
    source: {
      type: "catalog",
      catalog_item_id: "reaction-owned",
      logical_key: "local:reaction:my-reaction",
    },
    metadata: { notes: "Saved reaction" },
  } as PyReaction;
}

function privateReactionPreview(): PyActionPreview {
  return {
    preview_id: "preview-private",
    revision: "revision-private",
    revision_sha256: "revision-private",
    expires_at: "2026-08-16T12:00:00Z",
    files: [],
    metadata: {},
    closure: {
      root: {
        content_type: "reaction",
        catalog_source: "local",
        source: {
          type: "catalog",
          catalog_item_id: "reaction-owned",
          logical_key: "local:reaction:my-reaction",
        },
        name: "My Reaction",
        // The projected description is already the AI selection description.
        description: "Saved AI selection description",
        placement_hint: { emotion: "joy", intensity: 2 },
        implementation: { kind: "anima_clip" },
        reference_map: { sparkle: "support-1" },
        files: [
          {
            source_key: "local:reaction:my-reaction",
            role: "sequence",
            ordinal: 1,
            file_ref: "sequence-ref",
          },
        ],
      },
      supports: [
        {
          runtime_id: "support-1",
          content_type: "particle_effect",
          source: {
            type: "builtin",
            content_id: "builtin:particle-effect:sparkle",
            version: 1,
          },
        },
      ],
      revision: "revision-private",
      diagnostics: [],
    },
  } as PyActionPreview;
}

describe("Starter action customization", () => {
  it("offers built-in pose clips but excludes built-in VRMA Gestures", () => {
    expect(
      isCustomizableStarterAction(
        item({
          intent: "gesture",
          id: "builtin:gesture:shy-finger-poke-loop",
          name: "Shy Finger Poke Loop",
        }),
        "gesture",
      ),
    ).toBe(true);
    expect(
      isCustomizableStarterAction(
        item({
          intent: "gesture",
          id: "builtin:gesture:explain",
          name: "Explain",
        }),
        "gesture",
      ),
    ).toBe(false);
  });

  it("never offers a non-portable Starter for customization", () => {
    expect(
      isCustomizableStarterAction(
        {
          ...item({
            intent: "gesture",
            id: "builtin:gesture:shy-finger-poke-loop",
            name: "Shy Finger Poke Loop",
          }),
          portability: "non-portable",
        },
        "gesture",
      ),
    ).toBe(false);
  });

  it("hydrates a Starter Reaction as a new document with exact dependencies", async () => {
    const starter = item({
      intent: "reaction",
      id: "builtin:reaction:admiration-2",
      name: "Admiration Reaction 2",
    });
    const document = await actionDocumentFromPreview({
      intent: "reaction",
      item: starter,
      preview: preview({
        intent: "reaction",
        id: starter.item_id,
        key: "admiration-2",
      }),
      base: createReactionDocument(),
      customizeStarter: true,
      semanticSuffix: "abcdef12",
    });

    expect(document.name).toBe("Admiration Reaction 2 Custom");
    expect(document.implementation).toBe("anima_clip");
    expect(document.suggestedEmotion).toBe("admiration");
    expect(document.suggestedIntensity).toBe(2);
    expect(document.dependencies).toEqual([
      {
        alias: "sparkle",
        content_type: "particle_effect",
        source: {
          type: "builtin",
          content_id: "builtin:particle-effect:hearts",
          version: 1,
        },
      },
    ]);
    expect(document.sequence.schema).toBe("animaPoseClip/2.0");
    expect(document.sequence.id).toBe("admiration-reaction-2-custom");
    expect(document.sequence.name).toBe("Admiration Reaction 2 Custom");
    expect(document.notes).toContain("Customized from Starter");
  });

  it("leaves a licensed built-in sound out of a customized copy", async () => {
    const starter = item({
      intent: "reaction",
      id: "builtin:reaction:admiration-2",
      name: "Admiration Reaction 2",
    });
    const starterPreview = preview({
      intent: "reaction",
      id: starter.item_id,
      key: "admiration-2",
    });
    const closure = starterPreview.closure as unknown as {
      root: { reference_map: Record<string, string> };
      supports: unknown[];
    };
    closure.root.reference_map.chime = "support-2";
    closure.supports.push({
      runtime_id: "support-2",
      content_type: "sound_effect",
      portability: "non-portable",
      source: {
        type: "catalog",
        catalog_item_id: "licensed-sound",
      },
    });
    const document = await actionDocumentFromPreview({
      intent: "reaction",
      item: starter,
      preview: starterPreview,
      base: createReactionDocument(),
      customizeStarter: true,
      semanticSuffix: "abcdef12",
    });

    expect(document.dependencies.map((value) => value.alias)).toEqual([
      "sparkle",
    ]);
  });

  it("leaves a built-in Action's licensed sound events out of a customized copy", async () => {
    const starter = item({
      intent: "gesture",
      id: "builtin:gesture:wave-pop",
      name: "Wave Pop",
    });
    const starterPreview = preview({
      intent: "gesture",
      id: starter.item_id,
      key: "wave-pop",
    });
    const root = (
      starterPreview.closure as unknown as { root: Record<string, unknown> }
    ).root;
    root.implementation = { kind: "anima_clip" };
    root.files = [{ role: "sequence", ordinal: 1, file_ref: "sequence-ref" }];
    // ``chime`` is installed but licensed; ``pop`` isn't in this build.
    (root.reference_map as Record<string, string>).chime = "support-2";
    root.missing_references = { pop: "builtin:sound-effect:pop" };
    (
      starterPreview.closure as unknown as { supports: unknown[] }
    ).supports.push({
      runtime_id: "support-2",
      content_type: "sound_effect",
      portability: "non-portable",
      source: { type: "catalog", catalog_item_id: "licensed-sound" },
    });
    const sequence = {
      schema: "animaPoseClip/2.0",
      id: "wave-pop",
      name: "Wave Pop",
      duration: 1,
      beats: [],
      events: [
        { id: "chime", kind: "sfx", time: 0, cueId: "chime" },
        { id: "pop", kind: "sfx", time: 0.2, cueId: "pop" },
        { id: "spark", kind: "particle_vfx", time: 0, effectId: "sparkle" },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(sequence))),
    );

    const document = await actionDocumentFromPreview({
      intent: "gesture",
      item: starter,
      preview: starterPreview,
      base: createGestureDocument(),
      customizeStarter: true,
      semanticSuffix: "abcdef12",
    });

    expect(
      (document.sequence.events as { id: string }[]).map((event) => event.id),
    ).toEqual(["spark"]);
    expect(
      unresolvedActionReferences(document.sequence, document.dependencies),
    ).toEqual([]);
    // A sound left behind is not a removed effect to repair.
    expect(removedActionEffects(starterPreview)).toEqual([]);
  });

  it("reconstructs exact sources from readable Included dependency refs", async () => {
    const starter = item({
      intent: "reaction",
      id: "builtin:reaction:confusion-3",
      name: "Confusion Reaction 3",
    });
    const starterPreview = preview({
      intent: "reaction",
      id: starter.item_id,
      key: "confusion-3",
    });
    const starterClosure = starterPreview.closure as {
      root: {
        reference_map: Record<string, string>;
        dependencies: unknown[];
      };
      supports: unknown[];
    };
    starterClosure.root.reference_map = {
      "emote_!": "builtin:avatar-effect:emote",
      "question-orbit": "builtin:particle-effect:question-orbit",
    };
    starterClosure.root.dependencies = [
      {
        ref: "builtin:avatar-effect:emote",
        alias: "emote_!",
        content_type: "avatar_effect",
        config: {},
      },
      {
        ref: "builtin:particle-effect:question-orbit",
        alias: "question-orbit",
        content_type: "particle_effect",
        config: {},
      },
    ];
    starterClosure.supports = [];

    const document = await actionDocumentFromPreview({
      intent: "reaction",
      item: starter,
      preview: starterPreview,
      base: createReactionDocument(),
      customizeStarter: true,
      semanticSuffix: "abcdef12",
    });

    expect(document.dependencies).toEqual([
      {
        alias: "emote_!",
        content_type: "avatar_effect",
        source: {
          type: "builtin",
          content_id: "builtin:avatar-effect:emote",
          version: 1,
        },
        config: {},
      },
      {
        alias: "question-orbit",
        content_type: "particle_effect",
        source: {
          type: "builtin",
          content_id: "builtin:particle-effect:question-orbit",
          version: 1,
        },
        config: {},
      },
    ]);
  });

  it("gives a Starter Gesture fork a distinct valid model selector", async () => {
    const starter = item({
      intent: "gesture",
      id: "builtin:gesture:shy-finger-poke-loop",
      name: "Shy Finger Poke Loop",
    });
    const document = await actionDocumentFromPreview({
      intent: "gesture",
      item: starter,
      preview: preview({
        intent: "gesture",
        id: starter.item_id,
        key: "shy-finger-poke-loop",
        semanticKey: "shy-finger-poke-loop",
      }),
      base: createGestureDocument(),
      customizeStarter: true,
      semanticSuffix: "abcdef12",
    });

    expect(document.semanticKey).toBe("shy_finger_poke_loop_custom_abcdef12");
    expect(document.semanticKey).not.toBe("shy-finger-poke-loop");
    expect(document.semanticKey).toMatch(/^[a-z0-9_]{1,64}$/);
  });

  it("loads Included VRMA metadata as a distinct unsaved Local document", async () => {
    const starter = item({
      intent: "gesture",
      id: "builtin:gesture:explain",
      name: "Explain",
    });
    const source = preview({
      intent: "gesture",
      id: starter.item_id,
      key: "explain",
      semanticKey: "explain",
    });
    (source.closure as { root: Record<string, unknown> }).root.implementation =
      { kind: "vrma" };
    const document = await actionDocumentFromPreview({
      intent: "gesture",
      item: starter,
      preview: source,
      base: createGestureDocument(),
      customizeStarter: true,
      semanticSuffix: "abcdef12",
    });
    expect(document.implementation).toBe("vrma");
    expect(document.name).toBe("Explain Custom");
    expect(document.semanticKey).toBe("explain_custom_abcdef12");
  });
  it("bounds generated custom selectors to the backend limit", () => {
    expect(starterGestureSemanticKey("x".repeat(100), "abcdef12")).toHaveLength(
      64,
    );
  });
});

describe("owned action reopening", () => {
  it.each([1024 * 1024, 2 * 1024 * 1024 + 1])(
    "uses the runtime clip byte bound when reopening a %s-byte sequence",
    async (size) => {
      const sequence = JSON.stringify({
        schema: "animaPoseClip/2.0",
        id: "saved-reaction",
        name: "Saved Reaction",
        duration: 1,
        beats: [{ id: "smile", label: "Smile", time: 0 }],
        expressions: { happy: [{ beat: "smile", v: 1 }] },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(
          async () =>
            new Response(sequence + " ".repeat(size - sequence.length), {
              headers: {
                "Content-Type": "application/json",
                "Content-Length": String(size),
              },
            }),
        ),
      );
      const reopened = actionDocumentFromPreview({
        intent: "reaction",
        item: ownedReaction(),
        preview: privateReactionPreview(),
        base: createReactionDocument(),
      });
      if (size > 2 * 1024 * 1024) {
        await expect(reopened).rejects.toThrow(/too large|exceeds|size/i);
      } else {
        await expect(reopened).resolves.toMatchObject({
          sequence: { schema: "animaPoseClip/2.0" },
        });
      }
    },
  );
  it.each(["local", "included"])(
    "reopens converted %s Action-owned sequence and promoted effect references",
    async (catalogSource) => {
      const source = privateReactionPreview();
      const root = (source.closure as { root: Record<string, unknown> }).root;
      root.catalog_source = catalogSource;
      root.implementation = {
        kind: "anima_clip",
        technical_source: { type: "file", file_ref: "sequence-ref" },
      };
      const sequence = {
        schema: "animaPoseClip/2.0",
        id: "converted",
        name: "Converted",
        duration: 1,
        beats: [],
        events: [
          {
            id: "sparkle",
            kind: "particle_vfx",
            time: 0,
            effectId: "sparkle",
            duration: 0.5,
          },
        ],
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(sequence))),
      );
      const document = await actionDocumentFromPreview({
        intent: "reaction",
        item: ownedReaction(),
        preview: source,
        base: createReactionDocument(),
      });
      expect(document.sequence.events).toEqual(sequence.events);
      expect(document.dependencies).toContainEqual(
        expect.objectContaining({
          alias: "sparkle",
          content_type: "particle_effect",
        }),
      );
    },
  );

  it("reopens a Local Action that uses a removed Included effect and reports it", async () => {
    const source = privateReactionPreview();
    const root = (source.closure as { root: Record<string, unknown> }).root;
    root.implementation = {
      kind: "anima_clip",
      technical_source: { type: "file", file_ref: "sequence-ref" },
    };
    root.missing_references = { joy: "builtin:scene-effect:background:joy" };
    root.reference_map = {};
    // An authored record in the legacy shape must not declare it again.
    root.dependencies = [
      {
        alias: "joy",
        content_type: "scene_effect",
        ref: "builtin:scene-effect:background:joy",
      },
    ];
    const sequence = {
      schema: "animaPoseClip/2.0",
      id: "cheer",
      name: "Cheer",
      duration: 1,
      beats: [],
      events: [
        {
          id: "bg",
          kind: "scene_vfx",
          time: 0,
          presetId: "joy",
          sceneKind: "background_layers",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(sequence))),
    );
    const document = await actionDocumentFromPreview({
      intent: "reaction",
      item: ownedReaction(),
      preview: source,
      base: createReactionDocument(),
    });
    expect(removedActionEffects(source)).toEqual([
      { alias: "joy", ref: "builtin:scene-effect:background:joy" },
    ]);
    expect(document.dependencies).toEqual([]);
    // The creator's repair check reports the event that now plays nothing.
    expect(
      unresolvedActionReferences(document.sequence, document.dependencies),
    ).toEqual([
      expect.objectContaining({ alias: "joy", contentType: "scene_effect" }),
    ]);
  });

  it("reopens an unassigned reaction without inventing a suggestion", async () => {
    const source = privateReactionPreview();
    const closure = source.closure as { root: Record<string, unknown> };
    delete closure.root.placement_hint;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            schema: "animaPoseClip/2.0",
            id: "unassigned",
            name: "Unassigned",
            duration: 1,
            beats: [{ id: "neutral", label: "Neutral", time: 0 }],
            expressions: { happy: [{ v: 0, beat: "neutral" }] },
          }),
        ),
      ),
    );
    const document = await actionDocumentFromPreview({
      intent: "reaction",
      item: ownedReaction(),
      preview: source,
      base: createReactionDocument("joy", 3),
    });
    expect(document.suggestedEmotion).toBe("");
  });
  it("restores expression and effect keyframes plus exact dependencies", async () => {
    const sequence = {
      schema: "animaPoseClip/2.0",
      id: "saved-reaction",
      name: "Saved Reaction",
      duration: 1.2,
      beats: [
        { id: "happy", label: "Happy", time: 0.2 },
        { id: "surprised", label: "Surprised", time: 0.8 },
      ],
      expressions: {
        happy: [
          { v: 0.8, beat: "happy" },
          { v: 0, beat: "surprised" },
        ],
        surprised: [
          { v: 0, beat: "happy" },
          { v: 1, beat: "surprised" },
        ],
      },
      events: [
        {
          id: "sparkle-event",
          time: 0.5,
          kind: "particle_vfx",
          effectId: "sparkle",
          duration: 0.4,
        },
      ],
    };
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(sequence), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const document = await actionDocumentFromPreview({
      intent: "reaction",
      item: ownedReaction(),
      preview: privateReactionPreview(),
      base: createReactionDocument(),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/v1/content/previews/preview-private/revisions/revision-private/files/sequence-ref",
      ),
      expect.objectContaining({
        credentials: "same-origin",
      }),
    );
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("Authorization"),
    ).toBe(false);
    expect(document.sequence).toEqual({
      ...sequence,
      id: "my-reaction",
      name: "My Reaction",
    });
    expect(document.aiDescription).toBe("Saved AI selection description");
    expect(document.dependencies).toEqual([
      {
        alias: "sparkle",
        content_type: "particle_effect",
        source: {
          type: "builtin",
          content_id: "builtin:particle-effect:sparkle",
          version: 1,
        },
      },
    ]);
  });

  it.each([
    [
      "the retired 1.0 format",
      {
        schema: "animaPoseClip/1.0",
        id: "legacy",
        name: "Legacy",
        duration: 1,
        poses: { neutral: {} },
        poseKeyframes: [{ time: 0, pose: "neutral" }],
      },
      unsupportedAnimaPoseClipFormatMessage("animaPoseClip/1.0"),
    ],
    [
      "an unknown format",
      { schema: "animaPoseClip/9.0", id: "future", name: "Future" },
      unsupportedAnimaPoseClipFormatMessage("animaPoseClip/9.0"),
    ],
  ])(
    "rejects an owned sequence in %s instead of opening it",
    async (_label, sequence, message) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(sequence))),
      );
      await expect(
        actionDocumentFromPreview({
          intent: "reaction",
          item: ownedReaction(),
          preview: privateReactionPreview(),
          base: createReactionDocument(),
        }),
      ).rejects.toThrow(message);
    },
  );
});

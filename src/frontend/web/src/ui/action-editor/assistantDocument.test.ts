import { describe, expect, it } from "vitest";

import { createGestureDocument } from "@/ui/gesture-editor/gestureDocument";
import { createReactionDocument } from "@/ui/reaction-editor/reactionDocument";
import {
  gestureProject,
  reactionProject,
  softJoyClip,
  waveHelloClip,
} from "@/ui/generate/testing/generationFixtures";
import type { ActionDocument } from "./actionDocument";
import {
  applyAssistantProject,
  assistantDocumentFingerprint,
  assistantRunDocument,
  documentHasTimelineEvents,
} from "./assistantDocument";

const EFFECT_EVENT = {
  id: "avatar-star",
  time: 0.1,
  kind: "avatar_vfx",
  effectId: "star",
};
const STAR = {
  alias: "star",
  content_type: "avatar_effect" as const,
  source: { type: "builtin" as const, content_id: "builtin:x", version: 1 },
};
const TALKING = {
  lifetime: {
    kind: "whileInteractionPhase",
    phases: ["talking"],
    scope: "activeRun",
  },
};

function savedGesture(overrides: Partial<ActionDocument> = {}): ActionDocument {
  return {
    ...createGestureDocument(),
    name: "My Wave",
    aiDescription: "Use for hello.",
    semanticKey: "my_wave",
    sequence: { ...waveHelloClip(), id: "my-wave", name: "My Wave" },
    ...overrides,
  };
}

function savedReaction(
  overrides: Partial<ActionDocument> = {},
): ActionDocument {
  return {
    ...createReactionDocument("joy", 2),
    name: "My Joy",
    sequence: {
      ...softJoyClip(),
      id: "my-joy",
      name: "My Joy",
      role: "reaction",
      playback: TALKING,
      events: [EFFECT_EVENT],
    },
    dependencies: [STAR],
    ...overrides,
  };
}

describe("assistantRunDocument", () => {
  it("sends the item as it stands, as a project", () => {
    const document = savedGesture();
    const sent = assistantRunDocument(document)!;
    expect(sent).toMatchObject({
      schema: "animamaActionProject/1.0",
      intent: "gesture",
      name: "My Wave",
      aiDescription: "Use for hello.",
      semanticKey: "my_wave",
      notes: "",
      dependencies: [],
    });
    expect(sent.sequence).toEqual(document.sequence);
    // A copy: the creator's own document is never handed out.
    expect(sent.sequence).not.toBe(document.sequence);
  });

  it("leaves out what the assistant does not author", () => {
    const sent = assistantRunDocument(savedReaction())!;
    const sequence = sent.sequence as Record<string, unknown>;
    expect(sequence).not.toHaveProperty("events");
    expect(sequence).not.toHaveProperty("playback");
    expect(sequence).not.toHaveProperty("role");
    expect(sequence.expressions).toEqual(softJoyClip().expressions);
    expect(sent.dependencies).toEqual([]);
    expect(sent).toMatchObject({
      intent: "reaction",
      suggestedEmotion: "joy",
      suggestedIntensity: 2,
    });
  });

  it("sends only fields the clip format defines, and keeps the rest for the item", () => {
    const current = savedGesture();
    current.sequence = {
      ...current.sequence,
      generator: { tool: "an exporter", version: 3 },
    };
    const sent = assistantRunDocument(current)!;
    expect(sent.sequence).not.toHaveProperty("generator");

    const next = applyAssistantProject(
      current,
      gestureProject({
        sequence: { ...waveHelloClip(), duration: 3.1, generator: "theirs" },
      }),
      { identityExists: true },
    );
    // The item's own metadata comes back; the result's is not taken.
    expect(next.sequence.generator).toEqual({
      tool: "an exporter",
      version: 3,
    });
    expect(next.sequence.duration).toBe(3.1);
  });

  it("sends nothing for an empty new item, which is written anew", () => {
    expect(assistantRunDocument(createGestureDocument())).toBeNull();
    expect(assistantRunDocument(createReactionDocument())).toBeNull();
    expect(
      assistantRunDocument(savedGesture({ implementation: "vrma" })),
    ).toBeNull();
    // An unnamed item with a timeline is still revised, as it stands.
    expect(assistantRunDocument(savedGesture({ name: "  " }))).toMatchObject({
      name: "",
    });
  });
});

describe("applyAssistantProject", () => {
  it("replaces the timeline and keeps a saved item's identity", () => {
    const current = savedGesture();
    const result = gestureProject({
      name: "Renamed By The Assistant",
      aiDescription: "Another description.",
      semanticKey: "renamed",
      sequence: { ...waveHelloClip(), duration: 3.1 },
    });

    const next = applyAssistantProject(current, result, {
      identityExists: true,
    });

    expect(next.sequence.duration).toBe(3.1);
    expect([next.name, next.aiDescription, next.semanticKey]).toEqual([
      "My Wave",
      "Use for hello.",
      "my_wave",
    ]);
    // The clip carries the item's own name and id, as the creator keeps them.
    expect([next.sequence.name, next.sequence.id]).toEqual([
      "My Wave",
      "my-wave",
    ]);
    expect(current.sequence.duration).not.toBe(3.1);
  });

  it("fills the details a new item does not have yet", () => {
    const gesture = applyAssistantProject(
      createGestureDocument(),
      gestureProject(),
      { identityExists: false },
    );
    expect([gesture.name, gesture.aiDescription]).toEqual([
      "Shy Wave",
      "A small, shy wave with a smile.",
    ]);
    // A new Gesture's Selector ID follows its name, as when it is typed.
    expect(gesture.semanticKey).toBe("shy_wave");

    const reaction = applyAssistantProject(
      createReactionDocument(),
      reactionProject(),
      { identityExists: false },
    );
    expect([
      reaction.name,
      reaction.suggestedEmotion,
      reaction.suggestedIntensity,
    ]).toEqual(["Soft Joy", "joy", 2]);
  });

  it("keeps the item's effects, lifetime, role and dependencies", () => {
    const current = savedReaction();
    const longer = { ...softJoyClip(), duration: 2.4 };

    const next = applyAssistantProject(
      current,
      reactionProject({
        suggestedEmotion: "sadness",
        suggestedIntensity: 4,
        sequence: longer,
      }),
      { identityExists: true },
    );

    expect(next.sequence).toMatchObject({
      duration: 2.4,
      role: "reaction",
      playback: TALKING,
      events: [EFFECT_EVENT],
    });
    expect(next.dependencies).toEqual([STAR]);
    // Where the Reaction fits stays the person's choice.
    expect([next.suggestedEmotion, next.suggestedIntensity]).toEqual([
      "joy",
      2,
    ]);
    expect(documentHasTimelineEvents(next)).toBe(true);
    expect(documentHasTimelineEvents(savedGesture())).toBe(false);
  });

  it("refuses a result of another kind, or a Reaction that moves the body", () => {
    expect(() =>
      applyAssistantProject(savedGesture(), reactionProject(), {
        identityExists: true,
      }),
    ).toThrow();
    expect(() =>
      applyAssistantProject(
        savedReaction(),
        reactionProject({ sequence: waveHelloClip() }),
        { identityExists: true },
      ),
    ).toThrow();
    expect(() =>
      applyAssistantProject(savedGesture(), softJoyClip(), {
        identityExists: true,
      }),
    ).toThrow();
  });

  it("tells a document from one that was edited meanwhile", () => {
    const sent = savedGesture();
    const untouched = savedGesture({ name: "Renamed meanwhile" });
    const edited = savedGesture({
      sequence: { ...sent.sequence, duration: 9 },
    });
    // Only what the creator's history holds counts: the timeline and its
    // dependencies, not the item's name.
    expect(assistantDocumentFingerprint(untouched)).toBe(
      assistantDocumentFingerprint(sent),
    );
    expect(assistantDocumentFingerprint(edited)).not.toBe(
      assistantDocumentFingerprint(sent),
    );
  });
});

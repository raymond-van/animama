import { describe, expect, it } from "vitest";

import { unsupportedAnimaPoseClipFormatMessage } from "@/lib/avatar/poses/animaPoseClip";
import { createActionDocument } from "./actionDocument";
import {
  createActionProject,
  parseActionImport,
  ACTION_PROJECT_SCHEMA,
  unresolvedActionReferences,
} from "./actionProject";

function addNeutralKeyframe(document: ReturnType<typeof createActionDocument>) {
  // A clip needs a key: a light smile.
  document.sequence.beats = [{ id: "neutral", label: "Neutral", time: 0 }];
  document.sequence.expressions = { happy: [{ v: 0.2, beat: "neutral" }] };
  return document;
}

const LEGACY_SEQUENCE = {
  schema: "animaPoseClip/1.0",
  id: "legacy",
  name: "Legacy",
  duration: 1,
  poses: { neutral: { expressions: { happy: 0.2 } } },
  poseKeyframes: [{ time: 0, pose: "neutral" }],
};

describe("typed action project JSON", () => {
  it("round-trips a reaction without inventing a placement suggestion", () => {
    const document = addNeutralKeyframe(createActionDocument("reaction"));
    document.name = "Unassigned reaction";
    const imported = parseActionImport(
      createActionProject(document),
      "reaction",
    );
    expect(imported.kind).toBe("project");
    if (imported.kind === "project")
      expect(imported.project.suggestedEmotion).toBe("");
  });
  it("reads a legacy project description as its AI description", () => {
    const document = addNeutralKeyframe(createActionDocument("gesture"));
    document.name = "Wave";
    const legacy: Record<string, unknown> = {
      ...createActionProject(document),
      description: "Greet the user.",
    };
    delete legacy.aiDescription;
    const imported = parseActionImport(legacy, "gesture");
    expect(imported.kind).toBe("project");
    if (imported.kind !== "project") return;
    expect(imported.project.aiDescription).toBe("Greet the user.");
    expect(imported.project).not.toHaveProperty("description");
  });

  it("imports ordinary animaPoseClip JSON directly", () => {
    const document = addNeutralKeyframe(createActionDocument("gesture"));
    const imported = parseActionImport(document.sequence, "gesture");
    expect(imported.kind).toBe("clip");
    if (imported.kind === "clip") {
      expect(imported.sequence.schema).toBe("animaPoseClip/2.0");
    }
  });

  it("rejects a retired animaPoseClip/1.0 clip or project", () => {
    const message = unsupportedAnimaPoseClipFormatMessage("animaPoseClip/1.0");
    expect(() => parseActionImport(LEGACY_SEQUENCE, "gesture")).toThrow(
      message,
    );
    const document = addNeutralKeyframe(createActionDocument("gesture"));
    document.name = "Legacy Gesture";
    const project = createActionProject(document);
    expect(() =>
      parseActionImport({ ...project, sequence: LEGACY_SEQUENCE }, "gesture"),
    ).toThrow(message);
  });

  it("round-trips exact dependencies without exposing editor workflow state", () => {
    const document = createActionDocument("gesture");
    document.name = "Sparkle Wave";
    document.dependencies = [
      {
        alias: "sparkles",
        content_type: "particle_effect",
        source: {
          type: "catalog",
          catalog_item_id: "particle-1",
          logical_key: "local:particle-effect:sparkles",
        },
      },
    ];
    document.sequence.events = [
      {
        id: "sparkles-1",
        time: 0,
        kind: "particle_vfx",
        effectId: "sparkles",
      },
    ];

    const project = createActionProject(document);
    expect(project.schema).toBe(ACTION_PROJECT_SCHEMA);
    expect(project).not.toHaveProperty("draftRevision");
    expect(project.sequence.id).toBe("sparkle-wave");
    expect(project.sequence.name).toBe("Sparkle Wave");
    const imported = parseActionImport(project, "gesture");
    expect(imported.kind).toBe("project");
    if (imported.kind === "project") {
      expect(imported.project.dependencies).toEqual(document.dependencies);
    }
  });

  it("rejects a project opened by the wrong product editor", () => {
    const project = createActionProject(
      addNeutralKeyframe(createActionDocument("gesture")),
    );
    expect(() => parseActionImport(project, "reaction")).toThrow(
      /cannot open in the reaction editor/,
    );
  });
});

describe("imported clip dependency repair", () => {
  it("classifies unresolved aliases by their event kind", () => {
    expect(
      unresolvedActionReferences(
        {
          events: [
            {
              id: "p",
              time: 0,
              kind: "particle_vfx",
              effectId: "sparkles",
            },
            { id: "s", time: 0, kind: "sfx", cueId: "ding" },
          ],
        },
        [],
      ),
    ).toEqual([
      { alias: "ding", contentType: "sound_effect" },
      { alias: "sparkles", contentType: "particle_effect" },
    ]);
  });
});

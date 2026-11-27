import { describe, expect, it } from "vitest";
import { createActionDocument } from "@/ui/action-editor/actionDocument";
import { actionDescriptorFor } from "./useActionEditorActions";

describe("reaction sidecar placement", () => {
  it("omits placement when no suggestion is chosen or when it is cleared", () => {
    const document = createActionDocument("reaction");
    expect(
      actionDescriptorFor(document, "local:reaction:test").descriptor,
    ).not.toHaveProperty("placement_hint");
    document.suggestedEmotion = "joy";
    document.suggestedIntensity = 3;
    expect(
      actionDescriptorFor(document, "local:reaction:test").descriptor,
    ).toHaveProperty("placement_hint", { emotion: "joy", intensity: 3 });
    document.suggestedEmotion = "";
    expect(
      actionDescriptorFor(document, "local:reaction:test").descriptor,
    ).not.toHaveProperty("placement_hint");
  });
});

describe("action sidecar description", () => {
  it("saves only the AI description, so a reopened Action never keeps a stale copy", () => {
    // A draft recovered from before this change may still carry the old field.
    const document = Object.assign(createActionDocument("gesture"), {
      description: "Old text.",
    });
    document.aiDescription = "Edited text.";
    const { descriptor } = actionDescriptorFor(document, "local:gesture:test");
    expect(descriptor).not.toHaveProperty("description");
    expect(descriptor).toHaveProperty("ai_description", "Edited text.");
  });
});

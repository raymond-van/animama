import { SparklesIcon } from "lucide-react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CreatorModeSwitch } from "./CreatorModeSwitch";
import { CreatorToolbar } from "./CreatorToolbar";

const props = {
  typeLabel: "Avatar FX",
  typeIcon: <SparklesIcon />,
  documentName: "Eye sparkle",
  onDocumentNameChange: () => undefined,
  status: { label: "Saved", tone: "saved" as const },
  onNew: () => undefined,
  onImport: () => undefined,
  onJson: () => undefined,
  onSave: () => undefined,
  saveDisabled: true,
  saveBusy: false,
  saveLabel: "Save",
};

describe("FX document toolbar", () => {
  it("shows actionable validation beside the name without a healthy checkmark", () => {
    const html = renderToString(
      <CreatorToolbar
        {...props}
        validationMessages={[
          "Choose an image.",
          "Choose an image.",
          "Fix the anchor.",
        ]}
      />,
    );
    expect(html).toContain('aria-label="2 validation issues"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("text-destructive");
    const healthy = renderToString(
      <CreatorToolbar {...props} validationMessages={[]} />,
    );
    expect(healthy).not.toContain("validation issues");
    expect(healthy).not.toContain("lucide-check");
  });
  it("exposes the inline name and accessible names for icon-only controls", () => {
    const html = renderToString(
      <CreatorToolbar {...props} contentType="avatar_effect" />,
    );
    expect(html).toContain('aria-label="Avatar FX name"');
    expect(html).toContain('value="Eye sparkle"');
    expect(html).toContain('aria-label="Load Avatar FX"');
    expect(html).toContain('aria-label="Import"');
    expect(html).toContain('aria-label="View JSON"');
    expect(html).toContain('aria-label="More creator actions"');
    expect(html).toContain('aria-label="Saved"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Save"/);
  });

  it("places a labelled Simple | Advanced switch before the domain actions and Save", () => {
    const html = renderToString(
      <CreatorToolbar
        {...props}
        modeControl={
          <CreatorModeSwitch value="simple" onValueChange={() => undefined} />
        }
        domainActions={<button type="button">Use in a Gesture</button>}
      />,
    );
    expect(html).toMatch(/role="tablist"[^>]*aria-label="Creator mode"/);
    expect(html).toMatch(
      /role="tab"[^>]*aria-selected="true"[^>]*>Simple<\/button>/,
    );
    expect(html).toMatch(
      /role="tab"[^>]*aria-selected="false"[^>]*>Advanced<\/button>/,
    );
    const order = ["Creator mode", "Use in a Gesture", 'aria-label="Save"'].map(
      (marker) => html.indexOf(marker),
    );
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(order[0]).toBeGreaterThan(-1);
  });

  it("exposes history actions with their disabled availability", () => {
    const html = renderToString(
      <CreatorToolbar
        {...props}
        history={{
          canUndo: false,
          canRedo: true,
          undo: () => undefined,
          redo: () => undefined,
        }}
      />,
    );
    expect(html).toMatch(/aria-label="Undo[^"]*"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="Redo[^"]*"/);
  });

  it("retains field validation and actionable failure details", () => {
    const html = renderToString(
      <CreatorToolbar
        {...props}
        documentNameInvalid
        status={{
          label: "Save failed",
          tone: "error",
          tooltip: "Choose a name.",
        }}
      />,
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-label="Save failed: Choose a name."');
  });
});

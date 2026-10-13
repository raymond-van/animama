// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createParticleVFXEditorDraftFromBlank } from "@/lib/avatar/particle-vfx";
import { withRuntime } from "@/test/runtime-markup";
import { CREATOR_TEMPLATE_DRAFT_BASELINE } from "@/ui/content-creator/useCreatorTemplateStart";

import { ParticleVFXCreatorPage } from "./ParticleVFXCreatorPage";
import { particleVFXDocumentFingerprint } from "./particleVFXDocument";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type SaveArgs = {
  recoveryKey?: string;
  dirty: boolean;
  onRestore: (draft: unknown) => void;
};
type TemplateStartArgs = {
  templateId: string | undefined;
  fingerprint: unknown;
  recoveredDraft: unknown;
  baselineRef: { current: string };
};

const fixture = vi.hoisted(() => ({
  save: null as SaveArgs | null,
  start: null as TemplateStartArgs | null,
}));

vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ status: "idle" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/app/runtime/RuntimeOwnerContext", () => ({
  useRuntimeOwnerId: () => "owner",
  useRuntimeCacheKey: () => "fixture-session",
}));
vi.mock("@/query/hooks/useEffects", () => ({
  useParticleEffect: () => ({ data: undefined, isError: false }),
}));
vi.mock("./useParticleVFXSave", () => ({
  useParticleVFXSave: (args: SaveArgs) => {
    fixture.save = args;
    return { recoveryReady: false, recovered: false, notices: [] };
  },
}));
vi.mock("@/ui/content-creator/useCreatorTemplateStart", async (original) => ({
  ...(await original<
    typeof import("@/ui/content-creator/useCreatorTemplateStart")
  >()),
  useCreatorTemplateStart: (args: TemplateStartArgs) => {
    fixture.start = args;
    return {
      status: args.templateId ? "loading" : "inactive",
      seedError: null,
      starting: false,
      continueDraft: vi.fn(),
      startFromTemplate: vi.fn(),
    };
  },
}));
vi.mock("@/ui/content-creator/useContentCreatorModelPreview", () => ({
  useContentCreatorModelPreview: () => ({ modelOptions: [] }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** Render the page; `rerender` renders it again with the same state. */
function render(props: { itemId?: string; templateId?: string }) {
  container = document.createElement("div");
  document.body.append(container);
  const page = () => withRuntime(<ParticleVFXCreatorPage {...props} />);
  act(() => {
    root = createRoot(container!);
    root.render(page());
  });
  return { rerender: () => act(() => root!.render(page())) };
}

describe("Particle Effect creator template start", () => {
  beforeEach(() => {
    fixture.save = null;
    fixture.start = null;
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("seeds a template route from its template under the template's own recovery key", () => {
    render({ templateId: "heart-burst" });

    expect(container!.textContent).toContain("Loading template…");
    expect(fixture.save?.recoveryKey).toBe("new:template:heart-burst");
    expect(fixture.start).toMatchObject({ templateId: "heart-burst" });
    expect(fixture.start?.fingerprint).toBe(particleVFXDocumentFingerprint);
  });

  it("holds a recovered template draft for the continue-or-discard choice", () => {
    render({ templateId: "heart-burst" });
    const recovered = createParticleVFXEditorDraftFromBlank();

    act(() => fixture.save!.onRestore(recovered));

    expect(fixture.start?.recoveredDraft).toBe(recovered);
    // It is not installed: the template is still loading.
    expect(container!.textContent).toContain("Loading template…");
  });

  it("marks a template draft unsaved through the shared baseline", () => {
    const page = render({ templateId: "heart-burst" });
    expect(fixture.save?.dirty).toBe(false);

    // Starting the template sets the page's baseline, which no draft equals.
    fixture.start!.baselineRef.current = CREATOR_TEMPLATE_DRAFT_BASELINE;
    page.rerender();

    expect(fixture.save?.dirty).toBe(true);
  });

  it("keeps the default recovery key on a route without a template", () => {
    render({ itemId: "particle-1" });

    expect(fixture.save?.recoveryKey).toBeUndefined();
    expect(fixture.start?.templateId).toBeUndefined();
  });
});

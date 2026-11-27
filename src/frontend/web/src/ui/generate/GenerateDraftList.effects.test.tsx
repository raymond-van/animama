// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import { privateStateResets } from "@/app/runtime/private-module-state";
import type { DraftEffectsInfo } from "./draftEffects";
import { GenerateDraftList } from "./GenerateDraftList";
import {
  effectGestureProject,
  generationDraft,
  jsonResponse,
  sparkleDependency,
} from "./testing/generationFixtures";
import {
  click,
  renderInRuntime,
  settle,
  type MountedNode,
} from "./testing/generationHarness";
import { createGestureLibraryServer } from "./testing/gestureLibraryServer";
import { validateDraft, type DraftWorker } from "./useDraftWorker";

/**
 * Saving several drafts with the real save (R7.3, R7.4): the list over a
 * stand-in for the Library, so what reaches it for a draft that plays
 * effects can be read.
 */
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
// The real hash runs in a Web Worker, which this environment lacks.
vi.mock("@/lib/content/contentUploads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/content/contentUploads")>()),
  sha256File: (await import("./testing/generationFixtures")).sha256FileInline,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

const plain = generationDraft({ id: "draft-1", status: "ready" });
const sparkling = generationDraft({
  id: "draft-2",
  position: 1,
  status: "ready",
  project: effectGestureProject({
    name: "Sparkling Wave",
    semanticKey: "sparkling_wave",
  }),
});
const DRAFTS = [plain, sparkling];

let library: ReturnType<typeof createGestureLibraryServer>;
let marked: string[] = [];
let mounted: MountedNode | null = null;

async function fetch(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const mark = /^\/v1\/generation\/drafts\/([^/]+):mark-saved$/.exec(pathname);
  if (mark) {
    const { item_id } = (await request.json()) as { item_id: string };
    marked.push(mark[1]!);
    return jsonResponse({
      ...DRAFTS.find(({ id }) => id === mark[1]),
      saved_item_id: item_id,
    });
  }
  const answer = await library.handle(request);
  if (!answer) throw new Error(`Unexpected request: ${request.url}`);
  return answer;
}

function worker(drafts: readonly PyGenerationDraft[]): DraftWorker {
  return {
    validations: Object.fromEntries(
      drafts.map((draft) => [draft.id, validateDraft(draft)]),
    ),
    checkingDraftId: null,
    failures: {},
    retryCheck: () => {},
    frames: { status: "idle", draftId: null },
  };
}

function open(effects: ReadonlyMap<string, DraftEffectsInfo>) {
  mounted = renderInRuntime(
    <GenerateDraftList
      drafts={DRAFTS}
      worker={worker(DRAFTS)}
      selectedDraftId={null}
      onSelect={() => {}}
      running={false}
      effects={effects}
    />,
    { fetch },
  );
  document.body.append(mounted.container);
}

const find = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const cards = () => [
  ...document.querySelectorAll<HTMLElement>(
    '[data-testid="generate-draft-card"]',
  ),
];
const PLAYS: ReadonlyMap<string, DraftEffectsInfo> = new Map([
  ["draft-2", { aliases: ["sparkle"], missing: [] }],
]);

beforeEach(() => {
  library = createGestureLibraryServer();
  marked = [];
});
afterEach(() => {
  mounted?.unmount();
  mounted?.container.remove();
  mounted = null;
  for (const reset of privateStateResets()) reset();
});

describe("saving several drafts, one of which plays an effect", () => {
  /** What the Library received for the draft that plays the effect. */
  const expectEffectSaved = () => {
    const save = library.saves.find(
      ({ entryName }) => entryName === "Sparkling Wave",
    )!;
    expect(save.descriptor.dependencies).toEqual([
      {
        ref: "local:avatar-effect:sparkle",
        alias: "sparkle",
        content_type: "avatar_effect",
        source: sparkleDependency().source,
        config: {},
      },
    ]);
    expect(save.file.clip.events).toMatchObject([
      { kind: "avatar_vfx", effectId: "sparkle", time: 0, duration: 0.5 },
    ]);
  };

  it("records the effect's dependency and event with Save all", async () => {
    open(PLAYS);
    await click(find("generate-drafts-save-all"));
    await settle(20);

    expect(library.saves.map(({ entryName }) => entryName)).toEqual([
      "Shy Wave",
      "Sparkling Wave",
    ]);
    expectEffectSaved();
    // The draft without effects is saved without any dependency.
    expect(library.saves[0]!.descriptor.dependencies).toEqual([]);
    expect(library.saves[0]!.file.clip).not.toHaveProperty("events");
    expect(marked).toEqual(["draft-1", "draft-2"]);
    expect(find("generate-drafts-save-summary")!.dataset).toMatchObject({
      saved: "2",
      failed: "0",
      skipped: "0",
    });
  });

  it("records them with Save selected", async () => {
    open(PLAYS);
    await click(
      cards()[1]!.querySelector('[data-testid="generate-draft-mark"]'),
    );
    await click(find("generate-drafts-save-selected"));
    await settle(20);

    expect(library.saves.map(({ entryName }) => entryName)).toEqual([
      "Sparkling Wave",
    ]);
    expectEffectSaved();
    expect(marked).toEqual(["draft-2"]);
  });

  it("sends nothing to the Library for a draft whose effect is gone", async () => {
    open(
      new Map([["draft-2", { aliases: ["sparkle"], missing: ["sparkle"] }]]),
    );
    await click(find("generate-drafts-save-all"));
    await settle(20);

    expect(library.saves.map(({ entryName }) => entryName)).toEqual([
      "Shy Wave",
    ]);
    expect(marked).toEqual(["draft-1"]);
    expect(find("generate-drafts-save-summary")!.dataset).toMatchObject({
      saved: "1",
      failed: "0",
      skipped: "1",
    });
  });
});

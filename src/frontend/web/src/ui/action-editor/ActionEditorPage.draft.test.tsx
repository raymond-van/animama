// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCapabilities } from "@animama/runtime-contracts";

import { privateStateResets } from "@/app/runtime/private-module-state";
import {
  effectGestureProject,
  generationDraft,
  generationSnapshot,
  gestureProject,
  jsonResponse,
  sparkleDependency,
  waveHelloClip,
} from "@/ui/generate/testing/generationFixtures";
import {
  generationCapabilities,
  renderInRuntime,
  settle,
  type MountedNode,
} from "@/ui/generate/testing/generationHarness";
import { ActionEditorPage } from "./ActionEditorPage";
import {
  useActionEditorWorkspace,
  type ActionEditorWorkspaceValue,
} from "./ActionEditorWorkspaceContext";

type Location = { pathname: string; search: Record<string, unknown> };
type BlockerOptions = {
  shouldBlockFn: (navigation: { current: Location; next: Location }) => boolean;
};

const workspace = vi.hoisted(() => ({
  value: null as unknown,
}));
const preview = vi.hoisted(() => ({
  /** The dependencies the page last asked the component previews for. */
  dependencies: [] as readonly unknown[],
  /** The sandbox entries the preview provider was last given. */
  sandboxEntries: [] as readonly Record<string, unknown>[],
}));
const router = vi.hoisted(() => ({
  /** What the page last gave the router's blocker. */
  blocker: null as unknown,
  navigate: (() => Promise.resolve()) as (options: unknown) => Promise<void>,
}));
const idleList = {
  data: undefined,
  isPending: false,
  error: null,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: async () => undefined,
  refetch: async () => undefined,
};

// The page is the creator's orchestration; its visual workspace, preview and
// router are stood in for, so the document it holds can be read.
vi.mock("./ActionEditorWorkspace", () => ({
  ActionEditorWorkspace: () => {
    workspace.value = useActionEditorWorkspace();
    return null;
  },
}));
vi.mock("./ActionEditorPreviewProvider", () => ({
  ActionEditorPreviewProvider: ({
    children,
    sandboxEntries,
  }: {
    children: unknown;
    sandboxEntries: readonly Record<string, unknown>[];
  }) => {
    preview.sandboxEntries = sandboxEntries;
    return children;
  },
}));
vi.mock("@/ui/content-preview/ContentPreviewDockProvider", () => ({
  ContentPreviewExclusiveCanvasGate: ({ children }: { children: unknown }) =>
    children,
}));
vi.mock("@/ui/action-manage/ActionManageDialog", () => ({
  ActionManageDialog: () => null,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useBlocker: (options: unknown) => {
    router.blocker = options;
    return { status: "idle" };
  },
  useNavigate: () => (options: unknown) => router.navigate(options),
}));
vi.mock("@/query/hooks/useEffects", () => ({
  useParticleEffects: () => idleList,
  useSoundEffects: () => idleList,
  useAvatarEffectsPage: () => idleList,
  useSceneEffectsPage: () => idleList,
  useActionComponent: () => ({ data: undefined, isPending: false }),
}));
vi.mock("@/query/hooks/useActions", () => ({
  useAction: () => ({ data: undefined }),
}));
// Every dependency resolves to a preview of its own kind, as the Library's
// preview route answers for content it holds.
vi.mock("@/query/hooks/useActionComponentPreviews", async () => {
  const { useMemo } = await import("react");
  return {
    useActionComponentPreviews: (
      dependencies: readonly {
        alias: string;
        content_type: string;
        source: { catalog_item_id?: string };
      }[],
    ) => {
      preview.dependencies = dependencies;
      const previews = useMemo(
        () =>
          dependencies.map((dependency) => ({
            dependency,
            preview: {
              preview_id: `preview-${dependency.alias}`,
              revision: "revision-1",
              revision_sha256: "revision-1",
              expires_at: "2026-11-27T12:00:00Z",
              files: [],
              metadata: {
                content_type: dependency.content_type,
                item_id: dependency.source.catalog_item_id,
                name: dependency.alias,
              },
            },
          })),
        [dependencies],
      );
      return { previews, pending: false, diagnostics: [], errors: [] };
    },
  };
});
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const server = {
  snapshot: generationSnapshot(),
  reads: [] as string[],
  fail: false,
};
async function fetch(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  server.reads.push(pathname);
  if (server.fail)
    return jsonResponse({ detail: { code: "generation_not_found" } }, 404);
  return jsonResponse(server.snapshot);
}

let mounted: MountedNode;
const current = () => workspace.value as ActionEditorWorkspaceValue;

async function open(
  initialDraft?: { conversationId: string; draftId: string },
  capabilities?: RuntimeCapabilities,
) {
  mounted = renderInRuntime(
    <ActionEditorPage intent="gesture" initialDraft={initialDraft} />,
    { fetch, capabilities },
  );
  await settle();
}

/** Whether the creator asks before this navigation leaves its document. */
const asksBeforeLeaving = (from: Location, to: Location) =>
  (router.blocker as BlockerOptions).shouldBlockFn({ current: from, next: to });
const NEW_GESTURE = "/gestures/new";
const opened = (draft: string): Location => ({
  pathname: NEW_GESTURE,
  search: { draft, conversation: "conversation-1" },
});
const BLANK: Location = { pathname: NEW_GESTURE, search: {} };

beforeEach(() => {
  workspace.value = null;
  preview.dependencies = [];
  preview.sandboxEntries = [];
  router.blocker = null;
  router.navigate = () => Promise.resolve();
  server.snapshot = generationSnapshot({ drafts: [generationDraft()] });
  server.reads = [];
  server.fail = false;
  window.localStorage.clear();
});

afterEach(() => {
  mounted.unmount();
  for (const reset of privateStateResets()) reset();
});

describe("opening an assistant draft in the Gesture creator", () => {
  const DRAFT = { conversationId: "conversation-1", draftId: "draft-1" };

  it("starts a new Gesture blank and clean without a draft", async () => {
    await open();
    expect(current().document.name).toBe("");
    expect(current().dirty).toBe(false);
    expect(current().timelineSession).toBe(0);
    // No assistant route is read by an ordinary new Gesture.
    expect(server.reads).toEqual([]);
  });

  it("loads the draft's project through the import path, as an unsaved document", async () => {
    await open(DRAFT);

    expect(server.reads).toEqual([
      "/v1/generation/conversations/conversation-1",
    ]);
    const { document } = current();
    expect(document).toMatchObject({
      intent: "gesture",
      name: "Shy Wave",
      aiDescription: "A small, shy wave with a smile.",
      semanticKey: "shy_wave",
      implementation: "anima_clip",
    });
    // The timeline was replaced by the draft's clip, with its editable beats.
    expect(current().timelineSession).toBe(1);
    expect(
      (document.sequence.beats as { id: string }[]).map(({ id }) => id),
    ).toEqual(["start", "raise", "wave", "lower", "settle"]);
    // Unsaved: nothing in the Library yet, and leaving asks first.
    expect(current().dirty).toBe(true);
    expect(current().itemId).toBeUndefined();
    expect(current().identityExists).toBe(false);
    expect(current().error).toBeNull();
  });

  it("arrives with a draft's effects and plays them through the creator's own sandbox entries", async () => {
    server.snapshot = generationSnapshot({
      drafts: [generationDraft({ project: effectGestureProject() })],
    });
    await open(DRAFT);

    // The document holds the draft's events and the dependencies that pin them.
    const { document } = current();
    expect(document.sequence.events).toEqual([
      {
        id: "effect-1",
        time: 0,
        kind: "avatar_vfx",
        effectId: "sparkle",
        duration: 0.5,
      },
    ]);
    expect(document.dependencies).toEqual([sparkleDependency()]);
    expect(current().error).toBeNull();
    expect(current().dirty).toBe(true);
    // Nothing is unresolved: every alias an event names is declared.
    expect(current().issues.map(({ field }) => field)).not.toContain(
      "dependencies",
    );

    // The creator resolves those dependencies itself and mounts each effect
    // in its preview under the alias the events name.
    expect(preview.dependencies).toEqual([sparkleDependency()]);
    expect(preview.sandboxEntries).toMatchObject([
      { slot: "avatar_vfx", runtime_id: "sparkle" },
    ]);
  });

  it("opens a draft without effects with nothing mounted for them", async () => {
    await open(DRAFT);
    expect(current().document.dependencies).toEqual([]);
    expect(preview.dependencies).toEqual([]);
    expect(preview.sandboxEntries).toEqual([]);
  });

  it("imports the draft once, keeping later edits", async () => {
    await open(DRAFT);
    const { timelineSession } = current();
    // The conversation is read again in the background; nothing is re-imported.
    await mounted.queryClient.invalidateQueries();
    await settle();
    expect(current().timelineSession).toBe(timelineSession);
  });

  it.each([
    ["was discarded", () => (server.snapshot = generationSnapshot())],
    [
      "holds no project",
      () =>
        (server.snapshot = generationSnapshot({
          drafts: [generationDraft({ project: null, status: "failed" })],
        })),
    ],
    ["cannot be read", () => (server.fail = true)],
  ])("says so and stays blank when the draft %s", async (_label, arrange) => {
    arrange();
    await open(DRAFT);
    expect(current().error).toBe("This content could not be reopened.");
    expect(current().document.name).toBe("");
    expect(current().dirty).toBe(false);
  });

  it("says so, without waiting for ever, where the runtime has no assistant", async () => {
    // A link kept from a runtime that offered the assistant.
    await open(DRAFT, { ...generationCapabilities, content_generation: false });
    expect(server.reads).toEqual([]);
    expect(current().error).toBe("This content could not be reopened.");
    // The creator is usable: a blank, clean new Gesture.
    expect(current().document.name).toBe("");
    expect(current().dirty).toBe(false);
  });

  it("refuses a draft whose project the import refuses, with its reason", async () => {
    server.snapshot = generationSnapshot({
      drafts: [
        generationDraft({
          project: gestureProject({
            sequence: { ...waveHelloClip(), beats: "none" },
          }),
        }),
      ],
    });
    await open(DRAFT);
    expect(current().error).toBeTruthy();
    expect(current().dirty).toBe(false);
  });
});

describe("leaving a Gesture opened from an assistant draft", () => {
  const DRAFT = { conversationId: "conversation-1", draftId: "draft-1" };

  it("asks before the same route opens without the draft, which would start a blank editor", async () => {
    await open(DRAFT);
    expect(current().dirty).toBe(true);
    // The sidebar's Create → Gesture: the same pathname, no draft.
    expect(asksBeforeLeaving(opened("draft-1"), BLANK)).toBe(true);
    // Another draft is another document as well.
    expect(asksBeforeLeaving(opened("draft-1"), opened("draft-2"))).toBe(true);
    // As before for any other page.
    expect(
      asksBeforeLeaving(opened("draft-1"), {
        pathname: "/generate",
        search: {},
      }),
    ).toBe(true);
  });

  it("asks before a draft replaces an edited new Gesture on the same route", async () => {
    await open();
    act(() =>
      current().setDocument((document) => ({ ...document, name: "Mine" })),
    );
    expect(current().dirty).toBe(true);
    // Back to the entry that opened a draft.
    expect(asksBeforeLeaving(BLANK, opened("draft-1"))).toBe(true);
  });

  it("does not ask when the document stays the same one, or is clean", async () => {
    await open(DRAFT);
    // The same draft again: the editor is not replaced.
    expect(asksBeforeLeaving(opened("draft-1"), opened("draft-1"))).toBe(false);
    expect(
      asksBeforeLeaving(opened("draft-1"), {
        ...opened("draft-1"),
        search: { ...opened("draft-1").search, component: "effect-1" },
      }),
    ).toBe(false);
    mounted.unmount();

    await open();
    expect(current().dirty).toBe(false);
    expect(asksBeforeLeaving(BLANK, opened("draft-1"))).toBe(false);
  });

  it("lets the creator's own New through, which already asked", async () => {
    await open(DRAFT);
    let asked: boolean | null = null;
    router.navigate = async () => {
      asked = asksBeforeLeaving(opened("draft-1"), BLANK);
    };
    await act(() => current().startNew());
    expect(asked).toBe(false);
  });
});

import type { ReactNode } from "react";
import { renderToString } from "@/test/runtime-markup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAnimaPoseClipProgram } from "@/lib/avatar/poses/animaPoseClip/program";
import {
  POSE_CREATOR_CLIP_VALIDATION_OPTIONS,
  usePoseCreatorStore,
} from "@/stores/pose-creator-store";
import { buildAnimaPoseClipFromPoseCreatorDraft } from "@/ui/pose-creator/poseCreatorClipAuthoring";
import {
  ActionEditorWorkspace,
  captureActionEditorPoseAtPlayhead,
} from "./ActionEditorWorkspace";
import { createActionDocument } from "./actionDocument";

vi.mock("@/query/hooks/usePoses", () => ({
  usePoses: () => ({
    data: { items: [] },
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

const harness = vi.hoisted(() => ({
  mode: "pose",
  previewBasePose: undefined as string | undefined,
  document: null as ReturnType<typeof createActionDocument> | null,
  subscriptions: [] as Array<(onChange: () => void) => () => void>,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  // Exercise client snapshots in SSR without a DOM/WebGL implementation.
  useSyncExternalStore: (
    subscribe: (onChange: () => void) => () => void,
    getSnapshot: () => unknown,
  ) => {
    harness.subscriptions.push(subscribe);
    return getSnapshot();
  },
}));
vi.mock("./ActionCatalogDrag", () => ({
  ActionCatalogDragProvider: ({ children }: { children: ReactNode }) =>
    children,
}));
vi.mock("./ActionEditorWorkspaceContext", () => ({
  useActionEditorWorkspace: () => ({
    document: harness.document,
    mode: harness.mode,
    busy: false,
    history: { canUndo: false, canRedo: false },
    dependencySections: [],
  }),
}));
vi.mock("./ActionEditorPreviewProvider", () => ({
  useActionEditorPreview: () => ({}),
}));
vi.mock("./ActionEditorScene", () => ({
  ActionEditorScene: () => <div data-scene />,
}));
vi.mock("./ActionEditorHeader", () => ({ ActionEditorHeader: () => null }));
// The assistant's control reads the runtime and draws on a WebGL canvas.
vi.mock("@/ui/generate/creator/CreatorGenerateControl", () => ({
  CreatorGenerateControl: ({ bottom }: { bottom: number }) => (
    <div data-generate-control={bottom} />
  ),
}));
vi.mock("@/ui/generate/GenerationPreviewRendererBridge", () => ({
  GenerationPreviewRendererBridge: () => null,
}));
vi.mock("./ActionEditorEffectsPanel", () => ({
  ActionEditorEffectsPanel: () => null,
}));
vi.mock("./ActionTimelineEditor", () => ({
  ActionTimelineDocumentSync: () => null,
  ActionTimelineEditor: () => <div data-timeline />,
}));
vi.mock("./ActionEditorPrimitives", () => ({
  ActionEditorBoneSection: ({
    variant,
    handToggle,
  }: {
    variant: string;
    handToggle?: ReactNode;
  }) => <div data-bones={variant}>{handToggle}</div>,
  ActionEditorClipInspector: () => null,
  ActionEditorClipPreviewSync: ({
    previewBasePose,
  }: {
    previewBasePose?: string;
  }) => {
    harness.previewBasePose = previewBasePose;
    return null;
  },
  ActionEditorExpressionSection: () => <div data-expressions />,
  ActionEditorPreviewSettings: () => null,
}));
vi.mock("@/ui/avatar-preview/PlaybackObservationOutput", () => ({
  PlaybackObservationOutput: () => null,
}));
vi.mock("@/ui/creator-history/CreatorHistory", () => ({
  CreatorHistoryShortcut: () => null,
}));

let media: EventTarget & { matches: boolean };
beforeEach(() => {
  usePoseCreatorStore.getState().resetWorkspace();
  harness.mode = "pose";
  harness.document = createActionDocument("gesture");
  harness.subscriptions = [];
  media = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal("window", { matchMedia: vi.fn(() => media) });
});
afterEach(() => vi.unstubAllGlobals());

describe("Action editor viewport ownership", () => {
  it.each([true, false])(
    "offers Hands only in Gesture Pose mode (desktop=%s)",
    (desktop) => {
      media.matches = desktop;
      expect(renderToString(<ActionEditorWorkspace />)).toContain(
        "Show hand authoring",
      );
      harness.mode = "clip";
      expect(renderToString(<ActionEditorWorkspace />)).not.toContain(
        "Show hand authoring",
      );
      harness.mode = "pose";
      harness.document = createActionDocument("reaction");
      expect(renderToString(<ActionEditorWorkspace />)).not.toContain(
        "Show hand authoring",
      );
    },
  );
  it.each([true, false])(
    "mounts one scene and one pose toolset when desktop is %s",
    (desktop) => {
      media.matches = desktop;
      const html = renderToString(<ActionEditorWorkspace />);
      expect(html.match(/data-scene=/g)).toHaveLength(1);
      expect(html.match(/data-bones=/g)).toHaveLength(1);
      expect(html).toContain(
        `data-bones="${desktop ? "workspace" : "mobile"}"`,
      );
      expect(html.includes('aria-label="Authoring tools"')).toBe(!desktop);
    },
  );

  it.each([
    ["gesture", "clip", true],
    ["gesture", "clip", false],
    ["reaction", "reaction", true],
    ["reaction", "reaction", false],
  ] as const)(
    "mounts one %s timeline in %s mode (desktop=%s)",
    (intent, mode, desktop) => {
      harness.document = createActionDocument(intent);
      harness.mode = mode;
      media.matches = desktop;
      const html = renderToString(<ActionEditorWorkspace />);
      expect(html.match(/data-scene=/g)).toHaveLength(1);
      expect(html.match(/data-timeline=/g)).toHaveLength(1);
      expect(html).not.toContain("data-bones=");
      // One Generate control in each creator, 8px above the open timeline
      // (170px tall, 20px from the edge); the narrow layout has none.
      expect(html.match(/data-generate-control=/g) ?? []).toHaveLength(
        desktop ? 1 : 0,
      );
      if (desktop) expect(html).toContain('data-generate-control="198"');
    },
  );

  it("switches layout on the lg media change without changing the authored draft", () => {
    usePoseCreatorStore.getState().setBoneDraft("leftUpperArm", {
      baseQuaternion: [0, 0, 0, 1],
      rotationDegrees: { x: 35, y: 0, z: 0 },
    });
    const before = usePoseCreatorStore.getState();
    renderToString(<ActionEditorWorkspace />);
    const onChange = vi.fn();
    const cleanups = harness.subscriptions.map((subscribe) =>
      subscribe(onChange),
    );
    media.matches = false;
    media.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenCalledOnce();
    const html = renderToString(<ActionEditorWorkspace />);
    expect(html.match(/data-scene=/g)).toHaveLength(1);
    expect(html).toContain('data-bones="mobile"');
    expect(usePoseCreatorStore.getState()).toBe(before);
    cleanups.forEach((cleanup) => cleanup());
    media.matches = true;
    media.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenCalledOnce();
    expect(window.matchMedia).toHaveBeenCalledWith("(min-width: 1024px)");
  });
});

it("captures the current copied pose when a timeline has no external base", () => {
  const store = usePoseCreatorStore.getState();
  store.hydrateClipDocument({
    schema: "animaPoseClip/2.0",
    id: "copied",
    name: "Copied",
    duration: 1,
    beats: [{ id: "start", label: "Start", time: 0 }],
    hipsPosition: {
      x: [{ v: 0, beat: "start" }],
      y: [{ v: 0.4, beat: "start" }],
      z: [{ v: 0, beat: "start" }],
    },
    expressions: { happy: [{ v: 0.6, beat: "start" }] },
  });
  store.setClipCurrentTime(0.5);
  expect(captureActionEditorPoseAtPlayhead()).toBe(true);
  const { clipDraft, clipUndoHistory } = usePoseCreatorStore.getState();
  expect(clipDraft.keyframes.map(({ time }) => time)).toEqual([0, 0.5]);
  const clip = buildAnimaPoseClipFromPoseCreatorDraft(
    clipDraft,
    POSE_CREATOR_CLIP_VALIDATION_OPTIONS,
  )!;
  expect(clip).not.toHaveProperty("basePose");
  expect(
    createAnimaPoseClipProgram(clip, { resolvePose: () => null }).sample(0.5)
      .sample,
  ).toMatchObject({
    humanoid: { hips: { position: [0, 0.4, 0] } },
    expressions: { happy: 0.6 },
  });
  expect(clipDraft.basePose).toBe("");
  expect(clipUndoHistory).toHaveLength(1);
});

it.each(["gesture", "reaction"] as const)(
  "selects a preview-only base for %s",
  (intent) => {
    harness.document = createActionDocument(intent);
    harness.mode = intent === "reaction" ? "reaction" : "clip";
    renderToString(<ActionEditorWorkspace />);
    expect(harness.previewBasePose).toBe(
      intent === "reaction" ? "relaxedRest" : undefined,
    );
  },
);

// @vitest-environment happy-dom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PreparedContentPreview } from "@/lib/content-preview/preparation";
import type {
  ContentPreviewTarget,
  ContentPreviewView,
} from "@/lib/content-preview/types";
import type {
  AnimaRuntimeCatalogSnapshot,
  RuntimeCatalogEntry,
} from "@/lib/runtime-content/types";
import { ContentPreviewHost } from "./ContentPreviewHost";

type SceneRender = {
  targetKey: string;
  avatarRevision: string;
  active: boolean;
  playRequest: number;
  resetCameraRequest: number;
};

const harness = vi.hoisted(() => ({
  dock: {
    target: null as ContentPreviewTarget | null,
    view: "docked" as ContentPreviewView,
  },
  prepared: new Map<string, PreparedContentPreview>(),
  sceneMounts: 0,
  sceneUnmounts: 0,
  sceneRenders: [] as SceneRender[],
}));

vi.mock("./ContentPreviewDockProvider", () => ({
  useContentPreviewDock: () => ({
    ...harness.dock,
    minimize: vi.fn(),
    restore: vi.fn(),
    toggleExpanded: vi.fn(),
    expireSession: vi.fn(),
    returnFocusToInvoker: vi.fn(),
  }),
}));
vi.mock("./usePreparedContentPreview", () => ({
  // Mirror the real hook: inactive Docks prepare nothing, and an unchanged
  // target keeps its prepared identity.
  usePreparedContentPreview: (
    target: ContentPreviewTarget | null,
    options?: { enabled?: boolean },
  ) => ({
    prepared:
      target && options?.enabled !== false
        ? (harness.prepared.get(target.key) ?? null)
        : null,
    isPending: false,
    error: null,
    retry: async () => undefined,
  }),
}));
vi.mock("./ContentPreviewScene", () => ({
  ContentPreviewScene: (props: {
    target: ContentPreviewTarget;
    avatarEntry: RuntimeCatalogEntry;
    active: boolean;
    playRequest: number;
    resetCameraRequest: number;
  }) => {
    useEffect(() => {
      harness.sceneMounts += 1;
      return () => {
        harness.sceneUnmounts += 1;
      };
    }, []);
    harness.sceneRenders.push({
      targetKey: props.target.key,
      avatarRevision: props.avatarEntry.content_revision,
      active: props.active,
      playRequest: props.playRequest,
      resetCameraRequest: props.resetCameraRequest,
    });
    return <div data-testid="content-preview-scene" />;
  },
}));
vi.mock("@/lib/runtime-content/AnimaRuntimeCatalog", () => ({
  AnimaRuntimeCatalog: class {
    dispose() {}
  },
}));
vi.mock("@/lib/runtime-content/runtimeSnapshotAdapter", () => ({
  adaptRuntimeSnapshot: (snapshot: unknown) => snapshot,
}));
vi.mock("@/query/hooks/useAnimas", () => ({
  useAnimas: () => ({
    data: [{ id: "anima-1", name: "Annie" }],
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/query/hooks/useAnimaRuntimeCatalog", () => ({
  useAnimaRuntimeCatalog: () => ({
    data: animaRuntime,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/lib/anima-profile", () => ({
  getAnimaDisplayName: (anima: { name: string }) => anima.name,
}));
vi.mock("@/ui/settings/SettingsProvider", () => ({
  useSettings: () => ({
    userSettings: { last_active_anima_id: "anima-1" },
    isLoading: false,
  }),
}));
vi.mock("@/ui/app/AppShell", () => ({ useOptionalAppShell: () => null }));
vi.mock("@/ui/app/RuntimeFeatureGate", () => ({
  RuntimeFeatureGate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/ui/avatar-preview/PlaybackObservationOutput", () => ({
  PlaybackObservationOutput: () => null,
}));
vi.mock("@/ui/main/canvas/TransformPanel", () => ({
  TransformPanel: () => null,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="#">{children}</a>,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function entry(
  kind: RuntimeCatalogEntry["kind"],
  slot: RuntimeCatalogEntry["slot"],
  runtimeId: string,
  revision: string,
): RuntimeCatalogEntry {
  return {
    slot,
    runtime_id: runtimeId,
    kind,
    display_name: runtimeId,
    description: null,
    config_schema_version: 1,
    config: {},
    content_revision: revision,
    source: { type: "public_url", url: `/fixtures/${runtimeId}` },
  };
}

function runtime(avatarRevision: string): AnimaRuntimeCatalogSnapshot {
  return {
    effective_revision: "runtime-1",
    loadout_revision: 1,
    app_catalog_version: 1,
    avatar_model: entry(
      "avatar_model",
      "primary_model",
      "annie",
      avatarRevision,
    ),
    idle_animations: [],
    gestures: [],
    poses: [],
    reactions: [],
    particle_vfx: [],
    avatar_vfx: [],
    scene_background_vfx: [],
    scene_focus_vfx: [],
    background_image: null,
    profile_image: null,
    sfx: [],
    warnings: [],
  } as AnimaRuntimeCatalogSnapshot;
}

const animaRuntime = runtime("avatar-r1");

/** A Library Gesture target; the Dock adds the remembered Anima's context. */
function gesture(runtimeId: string): ContentPreviewTarget {
  const resolved = entry("anima_pose_clip", "gesture", runtimeId, runtimeId);
  return {
    key: `gesture:${runtimeId}`,
    sourceType: "resolved_entry",
    entry: resolved,
    kind: "anima_pose_clip",
    displayName: runtimeId,
    versionLabel: "Exact typed release",
    slot: "gesture",
    runtimeId,
    configSchemaVersion: 1,
    config: {},
  };
}

/** Register what preparation returns for the Dock's contextual target. */
function prepare(
  target: ContentPreviewTarget,
  avatarRevision = "avatar-r1",
): string {
  const key = `${target.key}:anima:anima-1:${animaRuntime.effective_revision}`;
  const contextual = {
    ...target,
    key,
    animaContext: { animaId: "anima-1", runtime: animaRuntime },
  };
  harness.prepared.set(key, {
    target: contextual,
    runtime: runtime(avatarRevision),
    entry: (target as { entry: RuntimeCatalogEntry }).entry,
    entryKey: `${key}:entry`,
  } as PreparedContentPreview);
  return key;
}

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => root.render(<ContentPreviewHost />));
}

function show(target: ContentPreviewTarget, view: ContentPreviewView) {
  harness.dock.target = target;
  harness.dock.view = view;
  render();
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
  harness.dock.target = null;
  harness.dock.view = "docked";
  harness.prepared.clear();
  harness.sceneMounts = 0;
  harness.sceneUnmounts = 0;
  harness.sceneRenders = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ContentPreviewHost", () => {
  it("keeps one scene mounted when a preview replaces another", () => {
    const first = gesture("wave");
    const second = gesture("bow");
    const firstKey = prepare(first);
    const secondKey = prepare(second);

    show(first, "docked");
    expect(harness.sceneMounts).toBe(1);
    expect(harness.sceneRenders.at(-1)?.targetKey).toBe(firstKey);

    show(second, "docked");
    expect(harness.sceneMounts).toBe(1);
    expect(harness.sceneUnmounts).toBe(0);
    expect(harness.sceneRenders.at(-1)).toMatchObject({
      targetKey: secondKey,
      avatarRevision: "avatar-r1",
      active: true,
    });
  });

  it("starts playback only with the target it was requested for", () => {
    const first = gesture("wave");
    const second = gesture("bow");
    const firstKey = prepare(first);
    const secondKey = prepare(second);

    show(first, "docked");
    show(second, "docked");

    // Each new play request must arrive together with its own prepared target,
    // never while the scene still shows the previous one.
    const firstRequests = new Map<number, string>();
    for (const render of harness.sceneRenders) {
      if (!firstRequests.has(render.playRequest)) {
        firstRequests.set(render.playRequest, render.targetKey);
      }
    }
    expect([...firstRequests.entries()]).toEqual([
      [1, firstKey],
      [2, secondKey],
    ]);
  });

  it("frames each replacement target from the default camera", () => {
    const first = gesture("wave");
    const second = gesture("bow");
    prepare(first);
    const secondKey = prepare(second);

    show(first, "docked");
    const firstReset = harness.sceneRenders.at(-1)!.resetCameraRequest;
    show(second, "docked");

    const replacement = harness.sceneRenders.at(-1)!;
    expect(replacement.targetKey).toBe(secondKey);
    expect(replacement.resetCameraRequest).toBeGreaterThan(firstReset);
  });

  it("keeps the warm scene mounted while the Dock is minimized or closed", () => {
    const first = gesture("wave");
    const firstKey = prepare(first);

    show(first, "docked");
    show(first, "minimized");
    show(first, "hidden");
    expect(harness.sceneMounts).toBe(1);
    expect(harness.sceneUnmounts).toBe(0);
    expect(harness.sceneRenders.at(-1)).toMatchObject({
      targetKey: firstKey,
      active: false,
    });

    show(first, "docked");
    expect(harness.sceneMounts).toBe(1);
    expect(harness.sceneRenders.at(-1)).toMatchObject({
      targetKey: firstKey,
      active: true,
    });
  });
});

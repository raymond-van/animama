// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PreviewRuntimeCatalogSession } from "@/lib/content-preview/PreviewRuntimeCatalogSession";
import type { ContentPreviewTarget } from "@/lib/content-preview/types";
import type { RuntimeCatalogEntry } from "@/lib/runtime-content/types";
import { DEFAULT_AVATAR_TRANSFORM } from "@/ui/main/canvas/transform-state";
import { ContentPreviewScene } from "./ContentPreviewScene";

type Deferred = { resolve: () => void; reject: (error: Error) => void };

const harness = vi.hoisted(() => ({
  avatars: [] as Array<{
    loads: string[];
    disposed: boolean;
    pending: Deferred[];
  }>,
  three: {
    camera: {},
    gl: { domElement: {} },
  },
}));

vi.mock("@/lib/avatar", () => ({
  Avatar: class {
    record = {
      loads: [] as string[],
      disposed: false,
      pending: [] as Deferred[],
    };
    isReady = false;
    isDisposed = false;
    scene: object | null = null;
    constructor() {
      harness.avatars.push(this.record);
    }
    load({ sourceKey }: { sourceKey: string }) {
      this.record.loads.push(sourceKey);
      this.isReady = false;
      this.scene = null;
      return new Promise<void>((resolve, reject) => {
        this.record.pending.push({
          resolve: () => {
            this.isReady = !this.isDisposed;
            this.scene = this.isReady ? {} : null;
            resolve();
          },
          reject,
        });
      });
    }
    dispose() {
      this.isDisposed = true;
      this.isReady = false;
      this.record.disposed = true;
    }
    setAutomaticAnimationPlaybackEnabled() {}
    resetAnimations() {}
    update() {}
  },
}));
vi.mock("@react-three/fiber", () => ({
  useThree: () => harness.three,
  useFrame: () => undefined,
}));
// Stand-ins for the R3F tree so a loaded model can render outside WebGL.
vi.mock("@/ui/avatar-preview/AvatarPreviewSurface", () => ({
  AvatarPreviewSurface: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/ui/main/canvas/transform-state", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/ui/main/canvas/transform-state")
  >()),
  applyAvatarTransformToObject: () => undefined,
}));
vi.mock("@/ui/avatar-preview/AvatarTransformControls", () => ({
  AvatarTransformControls: () => null,
}));
vi.mock("@/lib/runtime-content/animaRuntimeSnapshot", () => ({
  runtimeContentEntryUrl: (entry: RuntimeCatalogEntry) =>
    `/fixtures/${entry.runtime_id}.vrm`,
}));
vi.mock("@/lib/runtime-content/runtimeContentDelivery", () => ({
  runtimeContentDownloadUrl: async (_entry: unknown, url: string) => ({
    url,
    release: () => undefined,
  }),
}));
vi.mock("@/lib/content-preview/effects", () => ({
  contentPreviewEffectCommand: () => null,
  ContentPreviewApplySoundPlayer: class {
    play() {}
    stop() {}
  },
  attachContentPreviewClipEventBridge: () => () => undefined,
  clearContentPreviewEffects: () => undefined,
  createContentPreviewClipEventBridge: () => ({ reset: () => undefined }),
  playContentPreviewEffect: async () => undefined,
}));
vi.mock("@/lib/content-preview/playback", () => ({
  boundedContentPreviewFrameDelta: (delta: number) => delta,
  playContentPreviewMotion: async () => false,
}));
vi.mock("@/lib/content-preview/lifecycle", () => ({
  acquireContentPreviewResource: () => () => undefined,
  logContentPreviewLifecycle: () => undefined,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function avatarEntry(revision: string): RuntimeCatalogEntry {
  return {
    slot: "primary_model",
    runtime_id: "annie",
    kind: "avatar_model",
    display_name: "Annie",
    description: null,
    config_schema_version: 1,
    config: {},
    content_revision: revision,
    source: { type: "public_url", url: "/fixtures/annie.vrm" },
  };
}

function gesture(runtimeId: string): ContentPreviewTarget {
  return {
    key: `gesture:${runtimeId}`,
    sourceType: "resolved_entry",
    entry: {
      ...avatarEntry(runtimeId),
      slot: "gesture",
      kind: "anima_pose_clip",
      runtime_id: runtimeId,
    },
    kind: "anima_pose_clip",
    displayName: runtimeId,
    versionLabel: "Exact typed release",
    slot: "gesture",
    runtimeId,
    configSchemaVersion: 1,
    config: {},
  };
}

const catalog = {} as PreviewRuntimeCatalogSession;
const noop = () => undefined;
const onStatusChange = vi.fn();

let container: HTMLDivElement;
let root: Root;
let preparationRequest = 0;

/** Render one new preparation, as the host does for each prepared target. */
async function show(target: ContentPreviewTarget, avatarRevision: string) {
  preparationRequest += 1;
  const props: ComponentProps<typeof ContentPreviewScene> = {
    active: true,
    avatarTransform: DEFAULT_AVATAR_TRANSFORM,
    avatarEntry: avatarEntry(avatarRevision),
    catalog,
    loop: false,
    playRequest: 0,
    preparationRequest,
    resetCameraRequest: 0,
    stopRequest: 0,
    target,
    moveAvatar: false,
    onAvatarChange: noop,
    onAvatarTransformChange: noop,
    onCameraChanged: noop,
    onMissingDependencies: noop,
    onDependenciesLoadingChange: noop,
    onStatusChange,
  };
  await act(async () => root.render(<ContentPreviewScene {...props} />));
}

async function finishLoads(index: number) {
  await act(async () => {
    for (const pending of harness.avatars[index].pending) pending.resolve();
  });
}

async function failLoads(index: number) {
  await act(async () => {
    for (const pending of harness.avatars[index].pending) {
      pending.reject(new Error("Model download failed."));
    }
  });
}

beforeEach(() => {
  harness.avatars = [];
  preparationRequest = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ContentPreviewScene", () => {
  it("reuses the loaded Avatar for a target with the same model revision", async () => {
    await show(gesture("wave"), "avatar-r1");
    await finishLoads(0);
    await show(gesture("bow"), "avatar-r1");

    expect(harness.avatars).toHaveLength(1);
    expect(harness.avatars[0].loads).toEqual(["avatar-r1"]);
    expect(harness.avatars[0].disposed).toBe(false);
  });

  it("reports a reused Avatar ready without waiting for playback", async () => {
    await show(gesture("wave"), "avatar-r1");
    await finishLoads(0);
    onStatusChange.mockClear();

    // The host marks a replacement as loading; without autoplay (reduced
    // motion) no play request follows to clear it.
    await show(gesture("bow"), "avatar-r1");

    expect(onStatusChange).toHaveBeenCalledWith("ready");
  });

  it("retries a failed model load on the next preparation", async () => {
    await show(gesture("wave"), "avatar-r1");
    await failLoads(0);
    expect(onStatusChange).toHaveBeenLastCalledWith(
      "error",
      "Model download failed.",
    );

    // Retry, or another item with the same model, prepares again.
    await show(gesture("wave"), "avatar-r1");
    expect(harness.avatars).toHaveLength(1);
    expect(harness.avatars[0].loads).toEqual(["avatar-r1", "avatar-r1"]);
    expect(onStatusChange).toHaveBeenLastCalledWith(
      "loading",
      "Loading avatar…",
    );

    await finishLoads(0);
    expect(onStatusChange).toHaveBeenLastCalledWith("ready");
  });

  it("does not restart an in-flight model load when the target changes", async () => {
    await show(gesture("wave"), "avatar-r1");
    await show(gesture("bow"), "avatar-r1");

    expect(harness.avatars).toHaveLength(1);
    expect(harness.avatars[0].loads).toEqual(["avatar-r1"]);
  });

  it("loads a different model revision into a new Avatar", async () => {
    await show(gesture("wave"), "avatar-r1");
    await show(gesture("wave"), "avatar-r2");

    expect(harness.avatars).toHaveLength(2);
    expect(harness.avatars[0]).toMatchObject({
      loads: ["avatar-r1"],
      disposed: true,
    });
    expect(harness.avatars[1]).toMatchObject({
      loads: ["avatar-r2"],
      disposed: false,
    });
  });
});

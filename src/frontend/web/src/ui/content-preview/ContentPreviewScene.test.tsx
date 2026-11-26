// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PreviewRuntimeCatalogSession } from "@/lib/content-preview/PreviewRuntimeCatalogSession";
import type { ContentPreviewTarget } from "@/lib/content-preview/types";
import type { RuntimeCatalogEntry } from "@/lib/runtime-content/types";
import { usePreviewDockAvatarStore } from "@/stores/preview-dock-avatar-store";
import { DEFAULT_AVATAR_TRANSFORM } from "@/ui/main/canvas/transform-state";
import { ContentPreviewScene } from "./ContentPreviewScene";

type Deferred = { resolve: () => void; reject: (error: Error) => void };

const harness = vi.hoisted(() => ({
  avatars: [] as Array<{
    loads: string[];
    disposed: boolean;
    pending: Deferred[];
    /** Each load's settings, then each live wind change. */
    settings: string[];
  }>,
  settings: {
    springMode: "automatic",
    springModeRef: { current: "automatic" },
    materialMode: "automatic" as string | null,
  },
  three: {
    camera: {},
    gl: { domElement: {} },
  },
  /** The motion playback each play request starts. */
  playMotion: async () => false as boolean,
  /** What the Dock last asked of the portrait retake. */
  retake: null as null | {
    ready: boolean;
    shown: unknown;
    retake: unknown;
  },
}));

vi.mock("@/lib/avatar", () => ({
  Avatar: class {
    record = {
      loads: [] as string[],
      disposed: false,
      pending: [] as Deferred[],
      settings: [] as string[],
    };
    isReady = false;
    isDisposed = false;
    scene: object | null = null;
    constructor() {
      harness.avatars.push(this.record);
    }
    load({
      sourceKey,
      springMode,
      materialMode,
    }: {
      sourceKey: string;
      springMode: string;
      materialMode: string;
    }) {
      this.record.loads.push(sourceKey);
      this.record.settings.push(`load ${springMode} ${materialMode}`);
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
    setSpringMode(mode: string) {
      this.record.settings.push(`wind ${mode}`);
    }
    setAutomaticAnimationPlaybackEnabled() {}
    resetAnimations() {}
    update() {}
  },
}));
vi.mock("./useDockPortraitRetake", () => ({
  useDockPortraitRetake: (input: {
    ready: boolean;
    shown: unknown;
    retake: unknown;
  }) => {
    harness.retake = {
      ready: input.ready,
      shown: input.shown,
      retake: input.retake,
    };
  },
}));
vi.mock("@/query/hooks/useAvatarSettings", () => ({
  useAvatarLoadSettings: () => harness.settings,
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
  playContentPreviewMotion: () => harness.playMotion(),
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
    config: { avatar_catalog_item_id: "item-annie" },
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
async function show(
  target: ContentPreviewTarget,
  avatarRevision: string,
  requests: { play?: number; stop?: number } = {},
) {
  preparationRequest += 1;
  const props: ComponentProps<typeof ContentPreviewScene> = {
    active: true,
    avatarTransform: DEFAULT_AVATAR_TRANSFORM,
    avatarEntry: avatarEntry(avatarRevision),
    catalog,
    loop: false,
    playRequest: requests.play ?? 0,
    preparationRequest,
    resetCameraRequest: 0,
    stopRequest: requests.stop ?? 0,
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
  harness.settings = {
    springMode: "automatic",
    springModeRef: { current: "automatic" },
    materialMode: "automatic",
  };
  harness.three = { camera: {}, gl: { domElement: {} } };
  harness.playMotion = async () => false;
  harness.retake = null;
  preparationRequest = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * The Avatar's settings as `useAvatarLoadSettings` reports them; its ref is
 * one object for the component's life.
 */
function settings(springMode: string, materialMode: string | null) {
  harness.settings.springModeRef.current = springMode;
  harness.settings = {
    springMode,
    springModeRef: harness.settings.springModeRef,
    materialMode,
  };
}

describe("ContentPreviewScene Avatar settings", () => {
  it("waits for the material setting, then loads with both settings", async () => {
    settings("automatic", null);
    await show(gesture("wave"), "avatar-r1");
    expect(harness.avatars[0].loads).toEqual([]);

    settings("springs_off", "simple");
    await show(gesture("wave"), "avatar-r1");
    expect(harness.avatars[0].settings).toContain("load springs_off simple");
  });

  it("changes the wind live and reloads only for a material change", async () => {
    await show(gesture("wave"), "avatar-r1");
    await finishLoads(0);

    settings("off", "automatic");
    await show(gesture("wave"), "avatar-r1");
    expect(harness.avatars[0].loads).toEqual(["avatar-r1"]);
    expect(harness.avatars[0].settings.at(-1)).toBe("wind off");

    settings("off", "simple");
    await show(gesture("wave"), "avatar-r1");
    expect(harness.avatars[0].loads).toEqual(["avatar-r1", "avatar-r1"]);
    expect(harness.avatars[0].settings.at(-1)).toBe("load off simple");
  });
});

describe("ContentPreviewScene", () => {
  it("publishes its Avatar to Diagnostics only while a load has finished", async () => {
    const dock = () => usePreviewDockAvatarStore.getState();
    await show(gesture("wave"), "avatar-r1");
    expect(dock().avatar).toBeNull();
    await finishLoads(0);
    expect(dock().avatar).not.toBeNull();
    expect(dock().itemId).toBe("item-annie");

    // A new model revision withdraws it until that load finishes.
    await show(gesture("wave"), "avatar-r2");
    expect(dock().avatar).toBeNull();
    await finishLoads(1);
    expect(dock().avatar).not.toBeNull();

    act(() => root.unmount());
    expect(dock()).toEqual({ avatar: null, itemId: null });
    root = createRoot(container);
  });

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

  it("loads an Avatar the actor re-creates", async () => {
    await show(gesture("wave"), "avatar-r1");
    await finishLoads(0);

    // Any change to the creation effect's inputs re-creates the Avatar (a new
    // camera here); the new instance must load rather than stay empty.
    harness.three = { ...harness.three, camera: {} };
    await show(gesture("bow"), "avatar-r1");

    expect(harness.avatars).toHaveLength(2);
    expect(harness.avatars[0].disposed).toBe(true);
    expect(harness.avatars[1].loads).toEqual(["avatar-r1"]);
    await finishLoads(1);
    expect(onStatusChange).toHaveBeenLastCalledWith("ready");
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

describe("ContentPreviewScene Stop", () => {
  it("ends a play still preparing: its later failure reports nothing", async () => {
    let fail: (error: Error) => void = noop;
    harness.playMotion = () =>
      new Promise<boolean>((_resolve, reject) => {
        fail = reject;
      });
    // One target object, as the host keeps it across Play and Stop.
    const wave = gesture("wave");
    await show(wave, "avatar-r1");
    await finishLoads(0);
    await show(wave, "avatar-r1", { play: 1 });
    expect(onStatusChange).toHaveBeenCalledWith("loading", expect.any(String));

    // The host's Stop: status "ready", then the preparation fails.
    await show(wave, "avatar-r1", { play: 1, stop: 1 });
    onStatusChange.mockClear();
    await act(async () => fail(new Error("Effect load aborted.")));

    expect(onStatusChange).not.toHaveBeenCalledWith("error", expect.anything());
  });

  it("ends a play still preparing: its later success does not play", async () => {
    let succeed: (played: boolean) => void = noop;
    harness.playMotion = () =>
      new Promise<boolean>((resolve) => {
        succeed = resolve;
      });
    const wave = gesture("wave");
    await show(wave, "avatar-r1");
    await finishLoads(0);
    await show(wave, "avatar-r1", { play: 1 });
    await show(wave, "avatar-r1", { play: 1, stop: 1 });
    onStatusChange.mockClear();
    await act(async () => succeed(true));

    expect(onStatusChange).not.toHaveBeenCalledWith("playing");
  });
});

describe("ContentPreviewScene portrait retake", () => {
  const retake = { item_id: "item-annie", revision_sha256: "avatar-r2" };
  const avatarPreview: ContentPreviewTarget = {
    key: "typed-avatar:annie:avatar-r2",
    sourceType: "resolved_entry",
    entry: avatarEntry("avatar-r2"),
    kind: "avatar_model",
    displayName: "Annie",
    versionLabel: "avatar-r2",
    slot: "primary_model",
    runtimeId: "annie",
    configSchemaVersion: 1,
    config: { avatar_catalog_item_id: "item-annie" },
    portraitRetake: retake,
  };

  it("asks for the portrait once the Avatar preview's model has loaded", async () => {
    await show(avatarPreview, "avatar-r2");
    expect(harness.retake).toEqual({
      ready: false,
      shown: retake,
      retake,
    });

    await finishLoads(0);
    expect(harness.retake?.ready).toBe(true);
  });

  it("never retakes while an Action previews on the Avatar", async () => {
    await show(avatarPreview, "avatar-r2");
    await finishLoads(0);
    await show(gesture("wave"), "avatar-r2");

    expect(harness.retake).toMatchObject({ ready: false, retake: null });
  });
});

// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fakeAvatarLoads,
  fakeAvatars,
  fakeSettingsItemIds,
  resetFakeSettingsAvatars,
  setFakeSettings,
} from "@/lib/avatar/testing/fakeSettingsAvatar";
import type { RuntimeCatalogEntry } from "@/lib/runtime-content/types";
import { AnimaAvatarStage } from "./AnimaAvatarStage";

vi.mock("@/lib/avatar", async () => ({
  Avatar: (await import("@/lib/avatar/testing/fakeSettingsAvatar"))
    .FakeSettingsAvatar,
}));
vi.mock("@/query/hooks/useAvatarSettings", async () => ({
  useAvatarLoadSettings: (
    await import("@/lib/avatar/testing/fakeSettingsAvatar")
  ).fakeUseAvatarLoadSettings,
}));
// The stage's portrait retake: what it asks for, not the capture itself.
const contents = vi.hoisted(() => ({
  data: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/query/hooks/useAnimaCreation", () => ({
  useAvatarContents: () => ({ data: contents.data }),
}));
const retakes = vi.hoisted(() => ({
  calls: [] as Array<{ ready: boolean; shown: unknown; retake: unknown }>,
}));
vi.mock("@/ui/avatar-preview/useStagePortraitRetake", () => ({
  useStagePortraitRetake: (input: {
    ready: boolean;
    shown: unknown;
    retake: unknown;
  }) => {
    retakes.calls.push({
      ready: input.ready,
      shown: input.shown,
      retake: input.retake,
    });
  },
}));
vi.mock("@react-three/fiber", () => ({
  useThree: () => three,
  useFrame: () => undefined,
}));
// Stand-ins for the R3F tree and preview playback, as in ContentPreviewScene's tests.
vi.mock("@/ui/avatar-preview/AvatarPreviewSurface", () => ({
  AvatarPreviewSurface: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/ui/avatar-preview/PlaybackObservationOutput", () => ({
  PlaybackObservationOutput: () => null,
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
vi.mock("@/lib/content-preview/lifecycle", () => ({
  acquireContentPreviewResource: () => () => undefined,
  logContentPreviewLifecycle: () => undefined,
}));
vi.mock("@/lib/runtime-content/runtimeContentDelivery", () => ({
  runtimeContentDeliveryUrl: () => "/avatar.vrm",
  runtimeContentDownloadUrl: async () => ({
    url: "blob:avatar",
    release: () => undefined,
  }),
}));

const three = { camera: {}, gl: { domElement: {} } };

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const entry = {
  runtime_id: "avatar",
  content_revision: "revision-1",
  config: { avatar_catalog_item_id: "avatar-1" },
  source: { type: "public_url", url: "/avatar.vrm" },
} as unknown as RuntimeCatalogEntry;

let root: Root;

async function settings(springMode: string, materialMode: string | null) {
  setFakeSettings(springMode, materialMode);
  await act(async () =>
    root.render(
      <AnimaAvatarStage
        animaName="Annie"
        avatarUrl="/avatar.vrm"
        avatarRuntimeContentEntry={entry}
      />,
    ),
  );
}

beforeEach(() => {
  retakes.calls = [];
  contents.data = [];
  resetFakeSettingsAvatars();
  vi.spyOn(console, "info").mockImplementation(() => {});
  // react-dom does not know R3F's <primitive>.
  vi.spyOn(console, "error").mockImplementation(() => {});
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
});

describe("AnimaAvatarStage Avatar settings", () => {
  it("loads with the settings, changes the wind live and reloads for materials", async () => {
    await settings("automatic", null);
    expect(fakeAvatars).toHaveLength(0);

    await settings("springs_off", "simple");
    expect(new Set(fakeSettingsItemIds)).toEqual(new Set(["avatar-1"]));
    expect(fakeAvatarLoads(0)).toEqual(["load springs_off simple"]);
    await act(async () => fakeAvatars[0]!.finishLoad());

    await settings("on", "simple");
    expect(fakeAvatars).toHaveLength(1);
    expect(fakeAvatarLoads(0)).toHaveLength(1);
    expect(fakeAvatars[0]!.events.at(-1)).toBe("wind on");

    await settings("on", "automatic");
    expect(fakeAvatars).toHaveLength(2);
    expect(fakeAvatars[0]!.disposed).toBe(true);
    expect(fakeAvatarLoads(1)).toEqual(["load on automatic"]);
  });
});

describe("AnimaAvatarStage portrait retake", () => {
  const revision = "b".repeat(64);
  const mounted = {
    ...entry,
    config: {
      avatar_catalog_item_id: "avatar-1",
      avatar_revision_sha256: revision,
    },
  } as unknown as RuntimeCatalogEntry;
  const render = () =>
    act(async () =>
      root.render(
        <AnimaAvatarStage
          animaName="Annie"
          avatarUrl="/avatar.vrm"
          avatarRuntimeContentEntry={mounted}
        />,
      ),
    );

  it("retakes a Local portrait captured from another revision once loaded", async () => {
    contents.data = [
      {
        item_id: "avatar-1",
        revision_sha256: revision,
        source: "local",
        portrait: { url: "/p.webp", avatar_revision_sha256: "c".repeat(64) },
      },
    ];
    setFakeSettings("automatic", "automatic");
    await render();
    const shown = { item_id: "avatar-1", revision_sha256: revision };
    expect(retakes.calls.at(-1)).toEqual({
      ready: false,
      shown,
      retake: shown,
    });

    await act(async () => fakeAvatars[0]!.finishLoad());
    expect(retakes.calls.at(-1)?.ready).toBe(true);
  });

  it("keeps a current portrait", async () => {
    contents.data = [
      {
        item_id: "avatar-1",
        revision_sha256: revision,
        source: "local",
        portrait: { url: "/p.webp", avatar_revision_sha256: revision },
      },
    ];
    setFakeSettings("automatic", "automatic");
    await render();
    expect(retakes.calls.at(-1)?.retake).toBeNull();
  });
});

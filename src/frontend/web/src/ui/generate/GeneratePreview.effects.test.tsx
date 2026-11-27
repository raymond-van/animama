// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import type { Avatar } from "@/lib/avatar";
import type { RuntimeCatalogEntry } from "@/lib/runtime-content/types";
import { usePoseCreatorStore } from "@/stores/pose-creator-store";
import {
  GeneratePreviewProvider,
  GeneratePreviewStage,
  useGeneratePreviewPlayer,
} from "./GeneratePreview";
import {
  effectGestureProject,
  generationDraft,
  waveHelloClip,
} from "./testing/generationFixtures";
import {
  mountInDocument,
  settle,
  type MountedInDocument,
} from "./testing/generationHarness";
import { validateDraft } from "./useDraftWorker";

/**
 * A draft's effects on the Generate stage (R5.3). The stage plays a draft
 * through the creator's own clip preview, which is the real one here: only
 * the Avatar, the runtime catalog and the canvas are stood in for.
 */
const fixture = vi.hoisted(() => ({
  /** What the creator's preview provider was given. */
  provider: [] as Record<string, unknown>[],
  catalog: null as unknown,
  applyAvatarVFX: null as unknown,
}));

vi.mock("@/ui/pose-creator/PoseCreatorPreviewProvider", () => ({
  PoseCreatorPreviewProvider: ({
    children,
    ...props
  }: {
    children: ReactNode;
  }) => {
    fixture.provider.push(props);
    return <>{children}</>;
  },
  usePoseCreatorPreview: () => ({
    catalog: fixture.catalog,
    // What the mounted catalog lists, as the provider projects it.
    eventCatalog: {
      validationRefs: {
        avatarVFXIds: ["sparkle"],
        sceneBackgroundLayerPresetIds: ["backdrop"],
        sceneFocusLinePresetIds: [],
        particleVFXIds: ["rain"],
        sfxCueIds: [],
      },
    },
    modelEntry: { content_revision: "revision" },
    isAnimaPending: false,
    isRuntimePending: false,
    modelError: null,
    runtimeError: null,
    animaError: null,
  }),
}));
vi.mock("@/ui/content-preview/ContentPreviewDockProvider", () => ({
  ContentPreviewExclusiveCanvasGate: ({ children }: { children: ReactNode }) =>
    children,
}));
// The stage's own playback, without the rest of the creator's primitives.
vi.mock("@/ui/action-editor/ActionEditorPrimitives", async () => ({
  ActionEditorClipPreviewSync: (
    await import("@/ui/pose-creator/PoseCreatorClipPreviewSync")
  ).PoseCreatorClipPreviewSync,
}));
vi.mock("@/ui/action-editor/ActionEditorScene", () => ({
  ActionEditorScene: () => <div data-testid="scene" />,
}));
vi.mock("@/ui/avatar-preview/PlaybackObservationOutput", () => ({
  PlaybackObservationOutput: () => null,
}));
vi.mock("./GenerationPreviewRendererBridge", () => ({
  GenerationPreviewRendererBridge: () => null,
}));
// Posing needs a real VRM; the effects under test do not.
vi.mock("@/ui/pose-creator/poseCreatorClipPreview", async (original) => ({
  ...(await original<
    typeof import("@/ui/pose-creator/poseCreatorClipPreview")
  >()),
  applyPoseCreatorClipPreview: () => ({
    diagnostics: { missingPoseRefs: [] },
  }),
}));
vi.mock("@/ui/pose-creator/poseCreatorAuthoring", async (original) => ({
  ...(await original<
    typeof import("@/ui/pose-creator/poseCreatorAuthoring")
  >()),
  applyPoseCreatorDraftsToAvatar: () => {},
}));
vi.mock("@/lib/avatar/vfx/runtime", () => ({
  applyAvatarVFXEffectById: (request: unknown) =>
    (fixture.applyAvatarVFX as (request: unknown) => Promise<boolean>)(request),
}));

const store = () => usePoseCreatorStore.getState();
let mounted: MountedInDocument | null = null;

function Stage({ draft }: { draft: PyGenerationDraft }) {
  const validation = validateDraft(draft);
  const player = useGeneratePreviewPlayer(draft, validation);
  return (
    <GeneratePreviewStage
      draft={draft}
      validation={validation}
      player={player}
      hasDrafts
    />
  );
}

/** A preview Avatar as far as timeline effects reach it. */
function previewAvatar() {
  return {
    vfxController: { removeEffect: vi.fn(), setEffectIntensity: vi.fn() },
    particleVFXController: {
      playEffect: vi.fn<(request: Record<string, unknown>) => Promise<boolean>>(
        async () => true,
      ),
      clearEffect: vi.fn(),
    },
  };
}

beforeEach(() => {
  fixture.provider = [];
  fixture.catalog = {
    revision: "catalog-1",
    loadAvatarVFX: vi.fn(async (id: string) => ({ id })),
    loadSceneVFX: vi.fn(async () => null),
  };
  fixture.applyAvatarVFX = vi.fn(async () => true);
  act(() => store().resetWorkspace());
});
afterEach(async () => {
  mounted?.unmount();
  mounted = null;
  act(() => store().setActiveAvatar(null));
  // Let the store's deferred reset run before the next test starts.
  await settle(1);
});

describe("the Generate preview's effects", () => {
  it("gives the creator's preview provider the selected draft's sandbox entries", () => {
    const entries = [
      { slot: "avatar_vfx", runtime_id: "sparkle" },
    ] as unknown as RuntimeCatalogEntry[];
    mounted = mountInDocument(
      <GeneratePreviewProvider sandboxEntries={entries}>
        <span />
      </GeneratePreviewProvider>,
    );
    expect(fixture.provider.at(-1)).toMatchObject({
      includedAvatars: true,
      ownAvatars: true,
    });
    // The very list: the provider rebuilds its catalog when it changes.
    expect(fixture.provider.at(-1)!.sandboxEntries).toBe(entries);
  });

  it("loads the draft's clip with its events", () => {
    const draft = generationDraft({
      status: "ready",
      project: effectGestureProject(),
    });
    mounted = mountInDocument(<Stage draft={draft} />);
    expect(store().clipDraft.id).toBe("shy-wave");
    expect(store().clipDraft.events).toMatchObject([
      {
        id: "effect-1",
        kind: "avatar_vfx",
        time: 0,
        effectId: "sparkle",
        duration: 0.5,
      },
    ]);
    // Nothing the mounted catalog lists is reported as missing.
    expect(store().clipPreviewDiagnostics.missingAvatarVFXIds ?? []).toEqual(
      [],
    );
  });

  it("plays each effect from the mounted catalog when its event is due, as the creator's preview does", async () => {
    const override = { appearance: { opacity: 0.5 } };
    const draft = generationDraft({
      status: "ready",
      project: effectGestureProject({
        sequence: {
          ...waveHelloClip(),
          id: "shy-wave",
          events: [
            {
              id: "effect-1",
              time: 0,
              kind: "avatar_vfx",
              effectId: "sparkle",
              duration: 0.5,
              override,
            },
            {
              id: "effect-2",
              time: 0.3,
              kind: "particle_vfx",
              effectId: "rain",
              duration: 0.4,
            },
            {
              id: "effect-3",
              time: 0.6,
              kind: "scene_vfx",
              sceneKind: "background_layers",
              presetId: "backdrop",
            },
          ],
        },
      }),
    });
    const catalog = fixture.catalog as {
      loadAvatarVFX: ReturnType<typeof vi.fn>;
      loadSceneVFX: ReturnType<typeof vi.fn>;
    };
    const apply = fixture.applyAvatarVFX as ReturnType<typeof vi.fn>;
    const avatar = previewAvatar();
    mounted = mountInDocument(<Stage draft={draft} />);

    // The Avatar arrives: the draft plays from its start.
    act(() => store().setActiveAvatar(avatar as unknown as Avatar));
    await settle();
    expect(store().clipPlaybackPlaying).toBe(true);
    // The event at the start names its effect by the draft's alias, and
    // carries its per-use override to the catalog. (Playback starts when the
    // clip loads and again when the Avatar arrives, so the start is
    // dispatched for each; the creator's preview retires the earlier one.)
    const started = catalog.loadAvatarVFX.mock.calls.length;
    expect(started).toBeGreaterThan(0);
    for (const call of catalog.loadAvatarVFX.mock.calls)
      expect(call).toEqual(["sparkle", override]);
    expect(apply).toHaveBeenCalledTimes(started);
    expect(apply.mock.calls.at(-1)![0]).toMatchObject({
      avatar,
      effectId: "sparkle",
      effectEntry: { id: "sparkle" },
    });
    expect(avatar.particleVFXController.playEffect).not.toHaveBeenCalled();

    // Playback reaches the Particle Effect's event.
    act(() => store().advanceClipPlayback(0.4));
    await settle();
    expect(avatar.particleVFXController.playEffect).toHaveBeenCalledTimes(1);
    expect(
      avatar.particleVFXController.playEffect.mock.calls[0]![0],
    ).toMatchObject({ effectId: "rain", durationSec: 0.4 });
    expect(catalog.loadSceneVFX).not.toHaveBeenCalled();

    // And the Scene Effect's, by its lane and alias.
    act(() => store().advanceClipPlayback(0.3));
    await settle();
    expect(catalog.loadSceneVFX).toHaveBeenCalledWith(
      "background_layers",
      "backdrop",
    );
    // No event is played again as playback moves on.
    expect(apply).toHaveBeenCalledTimes(started);
    expect(avatar.particleVFXController.playEffect).toHaveBeenCalledTimes(1);
  });
});

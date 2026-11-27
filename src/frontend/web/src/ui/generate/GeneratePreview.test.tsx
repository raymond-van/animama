// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import type { Avatar } from "@/lib/avatar";
import { usePoseCreatorStore } from "@/stores/pose-creator-store";
import {
  GeneratePreviewControls,
  GeneratePreviewStage,
  useGeneratePreviewAvatarExpressions,
  useGeneratePreviewPlayer,
} from "./GeneratePreview";
import { generationDraft, gestureProject } from "./testing/generationFixtures";
import {
  click,
  mountGenerationHook,
  mountInDocument,
  type MountedHook,
  type MountedInDocument,
} from "./testing/generationHarness";
import { enterPseudoLocale, unmarkedText } from "./testing/pseudoLocale";
import { validateDraft, type DraftValidation } from "./useDraftWorker";

const fixture = vi.hoisted(() => ({
  preview: {} as Record<string, unknown>,
  scene: [] as Record<string, unknown>[],
  observation: [] as Record<string, unknown>[],
}));

vi.mock("@/ui/pose-creator/PoseCreatorPreviewProvider", () => ({
  PoseCreatorPreviewProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  usePoseCreatorPreview: () => fixture.preview,
}));
// The scene is a WebGL canvas; what the stage asks of it is recorded instead.
vi.mock("@/ui/action-editor/ActionEditorScene", () => ({
  ActionEditorScene: (props: Record<string, unknown>) => {
    fixture.scene.push(props);
    return <div data-testid="scene" />;
  },
}));
vi.mock("@/ui/action-editor/ActionEditorPrimitives", () => ({
  ActionEditorClipPreviewSync: () => null,
}));
// What a journey reads to see the draft playing; it samples a real Avatar.
vi.mock("@/ui/avatar-preview/PlaybackObservationOutput", () => ({
  PlaybackObservationOutput: (props: Record<string, unknown>) => {
    fixture.observation.push(props);
    return null;
  },
}));
vi.mock("./GenerationPreviewRendererBridge", () => ({
  GenerationPreviewRendererBridge: () => null,
}));

const source = (key: string, displayName: string) => ({
  key,
  displayName,
  sourceType: key.startsWith("own:") ? "own_avatar" : "included_avatar",
  itemId: key,
});
const SOURCES = [
  source("resolved:anima", "Miko (Anima)"),
  source("own:1", "My Fox"),
  source("included:andrew", "Andrew"),
];

function preview(overrides: Record<string, unknown> = {}) {
  return {
    modelOptions: SOURCES,
    selectedModel: SOURCES[0],
    modelEntry: { content_revision: "revision" },
    isAnimaPending: false,
    isRuntimePending: false,
    isModelCatalogPending: false,
    modelCatalogError: null,
    modelError: null,
    runtimeError: null,
    animaError: null,
    selectModel: vi.fn(),
    ...overrides,
  };
}

let mounted: MountedInDocument | null = null;
const find = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const store = () => usePoseCreatorStore.getState();

beforeEach(() => {
  fixture.preview = preview();
  fixture.scene = [];
  fixture.observation = [];
  act(() => {
    store().resetWorkspace();
    store().setModelSource(SOURCES[0] as never);
  });
});
afterEach(async () => {
  mounted?.unmount();
  mounted = null;
  // Let the store's deferred reset run before the next test starts.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

type Selection = {
  draft: PyGenerationDraft | null;
  validation?: DraftValidation;
  hasDrafts?: boolean;
};

/** The stage and its controls over one selection, as the page wires them. */
function Preview({ draft, validation, hasDrafts = true }: Selection) {
  const player = useGeneratePreviewPlayer(draft, validation);
  return (
    <>
      <GeneratePreviewStage
        draft={draft}
        validation={validation}
        player={player}
        hasDrafts={hasDrafts}
      />
      <GeneratePreviewControls playable={player.playable} />
    </>
  );
}

function show(selection: Selection) {
  const node = <Preview {...selection} />;
  if (mounted) mounted.rerender(node);
  else mounted = mountInDocument(node);
  return mounted.container;
}

const playable = (overrides: Partial<PyGenerationDraft> = {}) => {
  const draft = generationDraft({ status: "ready", ...overrides });
  return { draft, validation: validateDraft(draft) };
};
const button = (name: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;

describe("the Generate preview", () => {
  it("plays the selected draft as soon as it loads", () => {
    show(playable());
    expect(store().clipDraft.id).toBe("shy-wave");
    expect(store().clipPlaybackPlaying).toBe(true);
    expect(store().clipPlaybackAbsoluteTimeSec).toBe(0);
    expect(find("generate-preview")!.dataset.draftId).toBe("draft-1");
    expect(find("generate-preview-note")).toBeNull();
  });

  it("uses the creator's stage without its bone tools, and lends it to the worker", () => {
    show(playable());
    const scene = fixture.scene.at(-1)!;
    expect(scene.showHumanoidTools).toBe(false);
    expect(scene.canvasTestId).toBe("generate-preview-canvas");
    // The renderer bridge is mounted inside the canvas.
    expect(scene.children).toBeTruthy();
    expect(find("generate-preview")!.dataset.playbackSurface).toBe(
      "creator-stage",
    );
  });

  it("plays a new version of the draft from its start", () => {
    const first = playable();
    show(first);
    act(() => store().pauseClipPreview());
    act(() => store().setClipCurrentTime(0.5));
    expect(store().clipPlaybackPlaying).toBe(false);

    show(
      playable({
        version: 2,
        project: gestureProject({
          sequence: {
            ...(first.validation.sequence as Record<string, unknown>),
            id: "shy-wave-2",
          },
        }),
      }),
    );
    expect(store().clipDraft.id).toBe("shy-wave-2");
    expect(store().clipPlaybackPlaying).toBe(true);
    expect(store().clipDraft.currentTimeSec).toBe(0);
  });

  it("keeps playing through updates that leave the version as it is", () => {
    const { draft } = playable({ status: "checking" });
    show({ draft, validation: validateDraft(draft) });
    act(() => store().pauseClipPreview());
    act(() => store().setClipCurrentTime(0.5));

    // The same version moves on to `ready`: a new object, the same clip.
    const settled = {
      ...draft,
      status: "ready" as const,
      project: structuredClone(draft.project),
    };
    show({ draft: settled, validation: validateDraft(settled) });
    expect(store().clipPlaybackPlaying).toBe(false);
    expect(store().clipDraft.currentTimeSec).toBe(0.5);
  });

  it("plays the draft again from its start on a newly chosen Avatar", () => {
    show(playable());
    act(() => store().pauseClipPreview());
    // Without an Avatar there is nothing to observe.
    expect(fixture.observation.at(-1)!.status).toBe("unavailable");

    act(() => store().setActiveAvatar({} as Avatar));
    expect(store().clipPlaybackPlaying).toBe(true);
    // The stage reports the playing clip as the creator's stage does.
    expect(fixture.observation.at(-1)).toMatchObject({
      surface: "creator-stage",
      status: "playing",
      target: { kind: "anima_pose_clip", runtimeId: "shy-wave" },
      poseClipSample: { runtimeId: "shy-wave", active: true },
    });
  });

  it("shows why a draft cannot be played instead of playing it", () => {
    const draft = generationDraft({
      status: "failed",
      failure_reason: "generation_draft_unloadable",
      project: { name: "Broken", sequence: { schema: "nonsense" } },
    });
    const validation = validateDraft(draft);
    expect(validation.sequence).toBeNull();
    show({ draft, validation });
    const note = find("generate-preview-note")!;
    expect(note.getAttribute("role")).toBe("status");
    // The reason the draft failed, then what the validation found.
    expect(note.querySelectorAll("p").length).toBeGreaterThan(1);
    expect(store().clipPlaybackPlaying).toBe(false);
    expect(find("generate-preview")!.dataset.draftId).toBeUndefined();
    for (const name of ["Play draft", "Restart draft"])
      expect(button(name).disabled).toBe(true);
  });

  it("never plays a clip the page has not validated at this version", () => {
    const { draft, validation } = playable();
    show({ draft: { ...draft, version: 2 }, validation });
    expect(store().clipPlaybackPlaying).toBe(false);
    expect(find("generate-preview-note")!.textContent).toBe(
      "Loading the draft…",
    );
  });

  it("says what the stage is for while nothing is selected", () => {
    const root = show({ draft: null, hasDrafts: false });
    expect(find("generate-preview-note")!.textContent).toBe(
      "Drafts play here as soon as the assistant writes one.",
    );
    show({ draft: null, hasDrafts: true });
    expect(root.textContent).toContain("Select a draft to play it.");
    // A draft that failed before it had a project says why.
    show({
      draft: generationDraft({
        status: "failed",
        project: null,
        failure_reason: "generation_no_valid_draft",
      }),
    });
    expect(find("generate-preview-note")!.textContent).toContain(
      "The assistant did not produce a draft that works.",
    );
  });

  it("stops playing when the selection is cleared", () => {
    show(playable());
    show({ draft: null });
    expect(store().clipPlaybackPlaying).toBe(false);
    expect(store().clipDraft.id).not.toBe("shy-wave");
  });

  it("pauses, plays and restarts from the transport", async () => {
    show(playable());
    await click(button("Pause draft"));
    expect(store().clipPlaybackPlaying).toBe(false);
    await click(button("Play draft"));
    expect(store().clipPlaybackPlaying).toBe(true);
    act(() => store().setClipCurrentTime(0.5));
    await click(button("Restart draft"));
    expect(store().clipPlaybackPlaying).toBe(true);
    expect(store().clipDraft.currentTimeSec).toBe(0);
  });

  it("keeps the person's loop choice across drafts", async () => {
    const first = playable();
    show(first);
    const loop = find("generate-preview-loop")!;
    expect(loop.getAttribute("aria-label")).toBe("Loop the draft");
    expect(loop.getAttribute("aria-checked")).toBe("false");
    await click(loop);
    expect(store().clipDraft.loop).toBe(true);
    expect(loop.getAttribute("aria-checked")).toBe("true");

    show(playable({ id: "draft-2", version: 1 }));
    expect(store().clipDraft.loop).toBe(true);
  });

  it("offers the Anima's, the person's own and the Included Avatars", () => {
    show(playable());
    const picker = find("generate-avatar-picker")!;
    expect(picker.getAttribute("aria-label")).toBe("Preview avatar");
    expect(picker.textContent).toContain("Miko (Anima)");
    expect(picker.getAttribute("role")).toBe("combobox");
  });

  it("says when a list of Avatars could not be read, and reads it again on request", async () => {
    const retryModels = vi.fn(async () => {});
    fixture.preview = preview({
      modelCatalogError: "Could not load your Avatars.",
      retryModels,
    });
    const root = show(playable());
    expect(root.textContent).toContain("Could not load your Avatars.");
    await click(button("Retry loading models"));
    expect(retryModels).toHaveBeenCalledTimes(1);
  });

  it("puts the playback store back when the page leaves", async () => {
    show(playable());
    mounted!.unmount();
    mounted = null;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(store().clipPlaybackPlaying).toBe(false);
    expect(store().selectedSource).toBeNull();
  });

  it("takes every word it shows from the catalogs", async () => {
    const leave = await enterPseudoLocale();
    try {
      show({ draft: null, hasDrafts: false });
      const data = ["Miko (Anima)", "My Fox", "Andrew"];
      expect(unmarkedText(document.body, data)).toEqual([]);
      const draft = generationDraft({
        status: "failed",
        project: { name: "Broken", sequence: { schema: "nonsense" } },
      });
      const validation = validateDraft(draft);
      show({ draft, validation });
      expect(
        unmarkedText(document.body, [
          ...data,
          // The validator's own text is shown as detail.
          ...validation.issues.flatMap(({ path, message }) => [path, message]),
        ]),
      ).toEqual([]);
    } finally {
      await leave();
    }
  });
});

describe("the preview Avatar's expression names", () => {
  type Expressions = ReturnType<typeof useGeneratePreviewAvatarExpressions>;
  let probe: MountedHook<null, Expressions> | null = null;
  const read = () => {
    probe ??= mountGenerationHook(useGeneratePreviewAvatarExpressions, {
      props: null,
      fetch: () => Promise.reject(new Error("No request expected.")),
    });
    return probe.result();
  };
  afterEach(() => {
    probe?.unmount();
    probe = null;
  });

  it("is undefined while the Avatar loads and null when none can be shown", () => {
    expect(read()).toBeUndefined();

    act(() => store().setLoadStatus("error", "The Avatar did not load."));
    expect(read()).toBeNull();

    act(() => store().setLoadStatus("idle"));
    fixture.preview = preview({ modelError: "No Avatar." });
    probe!.rerender(null);
    expect(read()).toBeNull();
  });

  it("reads only names from the loaded Avatar, once", () => {
    const getAvailableExpressions = vi.fn(() => ["happy", "Cheek_Blush"]);
    expect(read()).toBeUndefined();
    act(() =>
      store().setActiveAvatar({
        getAvailableExpressions,
        arkitFace: null,
      } as unknown as Avatar),
    );
    const first = read();
    expect(first).toEqual({
      names: ["happy", "Cheek_Blush"],
      arkitNames: undefined,
    });
    probe!.rerender(null);
    // The same array for the same Avatar, so its readers stay still.
    expect(read()).toBe(first);
    expect(getAvailableExpressions).toHaveBeenCalledTimes(1);
  });
});

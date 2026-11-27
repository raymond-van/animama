// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import { IDLE_GENERATION_RUN } from "@/stores/generation-store";
import type { ActionDocument } from "@/ui/action-editor/actionDocument";
import { applyAssistantProject } from "@/ui/action-editor/assistantDocument";
import { createGestureDocument } from "@/ui/gesture-editor/gestureDocument";
import { CreatorGenerateControl } from "./CreatorGenerateControl";
import {
  generationDraft,
  gestureProject,
  waveHelloClip,
} from "../testing/generationFixtures";
import {
  click,
  mountInDocument,
  type MountedInDocument,
} from "../testing/generationHarness";
import { validateDraft } from "../useDraftWorker";
import type { useGenerationRun } from "../useGenerationRun";

type RunInput = Parameters<typeof useGenerationRun>[0];

/** What the mocked hooks answer, and what the panel asked of them. */
const stage = vi.hoisted(() => ({
  available: true,
  model: { id: "model-1" } as { id: string } | null,
  drafts: [] as unknown[],
  running: false,
  runInput: null as unknown,
  scopeInput: null as unknown,
  conversationProps: null as unknown,
  stop: vi.fn(),
  restartPreview: vi.fn(),
  history: { beginGroup: vi.fn(), endGroup: vi.fn() },
  document: null as unknown,
  mode: "clip",
  /** What Pose mode commits into the document when a run starts. */
  pendingPose: null as unknown,
  /** What the pose editor holds that a result would lose. */
  poseEdit: null as "pose_draft" | "keyframe_edit" | null,
  itemId: undefined as string | undefined,
  timelineSession: 0,
  applied: [] as unknown[],
  /** Whether each applied result replaced the run's history entry. */
  replaced: [] as boolean[],
  applyFails: false,
  removed: [] as string[],
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/query/hooks/useGeneration", () => ({
  useContentGenerationAvailable: () => stage.available,
  useGenerationConversation: (id: string | null) => ({
    data: id ? { drafts: stage.drafts, usage: null } : undefined,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/stores/pose-creator-store", () => ({
  usePoseCreatorStore: {
    getState: () => ({
      restartClipPreview: stage.restartPreview,
    }),
  },
}));
vi.mock("@/query/mutations/useGenerationMutations", () => ({
  useDeleteGenerationConversation: () => ({
    mutateAsync: async (id: string) => {
      stage.removed.push(id);
    },
    isPending: false,
  }),
}));
vi.mock("@/ui/action-editor/ActionEditorWorkspaceContext", () => ({
  useActionEditorWorkspace: () => ({
    document: stage.document,
    mode: stage.mode,
    itemId: stage.itemId,
    history: stage.history,
    timelineSession: stage.timelineSession,
    pendingPoseEdit: () => stage.poseEdit,
    prepareAssistantRun: () => {
      // An unsaved pose of its own blocks the run.
      if (stage.poseEdit === "pose_draft") return null;
      // Pose mode: the keyframe's pose being edited is applied, and the
      // creator moves to Clip.
      if (stage.mode === "pose" && stage.pendingPose) {
        stage.document = stage.pendingPose;
        stage.pendingPose = null;
        stage.mode = "clip";
      }
      return stage.document;
    },
    applyAssistantResult: (
      project: unknown,
      options?: { replace?: boolean },
    ) => {
      if (stage.applyFails) throw new Error("refused");
      const next = applyAssistantProject(
        stage.document as ActionDocument,
        project,
        { identityExists: true },
      );
      stage.applied.push(project);
      stage.replaced.push(options?.replace === true);
      stage.document = next;
      stage.timelineSession += 1;
      return { document: next, changed: true };
    },
  }),
}));
vi.mock("../GenerateConversation", () => ({
  GenerateConversation: (props: { composerNote?: ReactNode }) => {
    stage.conversationProps = props;
    return (
      <div data-testid="generate-conversation">
        {props.composerNote}
        <textarea data-testid="generate-request" />
      </div>
    );
  },
}));
vi.mock("../GenerateModelControl", () => ({
  GenerateModelControl: () => <div data-testid="model-control" />,
}));
vi.mock("../GeneratePreview", () => ({
  useGeneratePreviewAvatarExpressions: () => null,
}));
vi.mock("../useGenerationModel", () => ({
  useGenerationModel: () => ({
    model: stage.model,
    effort: null,
    isPending: false,
  }),
}));
vi.mock("../useGenerationRun", () => ({
  useGenerationRun: (input: unknown) => {
    stage.runInput = input;
    return {
      run: { ...IDLE_GENERATION_RUN, running: stage.running },
      questions: null,
      send: vi.fn(),
      answer: vi.fn(),
      retry: vi.fn(),
      stop: stage.stop,
      dismissFailure: vi.fn(),
    };
  },
}));
vi.mock("../useDraftWorker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../useDraftWorker")>();
  return {
    ...actual,
    // The page's own validation of each draft, without the checks worker.
    useDraftWorker: ({ drafts }: { drafts: readonly PyGenerationDraft[] }) => ({
      validations: Object.fromEntries(
        drafts
          .filter((draft) => draft.project !== null)
          .map((draft) => [draft.id, actual.validateDraft(draft)]),
      ),
      checkingDraftId: null,
      failures: {},
      retryCheck: vi.fn(),
      frames: { status: "idle", draftId: null },
    }),
  };
});
vi.mock("./useCreatorGenerationConversation", () => ({
  useCreatorGenerationConversation: (input: unknown) => {
    stage.scopeInput = input;
    return { conversationId: "conversation-1", isError: false, retry: vi.fn() };
  },
}));

const find = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

function savedGesture(): ActionDocument {
  return {
    ...createGestureDocument(),
    name: "My Wave",
    aiDescription: "Use for hello.",
    semanticKey: "my_wave",
    sequence: { ...waveHelloClip(), id: "my-wave", name: "My Wave" },
  };
}

const result = (version: number, duration: number) =>
  generationDraft({
    version,
    status: "checking",
    project: gestureProject({
      sequence: { ...waveHelloClip(), duration },
    }),
  });

let mounted: MountedInDocument | null = null;
const render = () => {
  const node = <CreatorGenerateControl bottom={198} />;
  if (mounted) mounted.rerender(node);
  else mounted = mountInDocument(node);
};
/** Open the panel, then start a run as the conversation's Send does. */
async function startRun() {
  render();
  await click(find("creator-generate-toggle"));
  const source = (stage.runInput as RunInput).creatorSource!();
  stage.running = true;
  render();
  return source;
}

beforeEach(() => {
  Object.assign(stage, {
    available: true,
    model: { id: "model-1" },
    drafts: [],
    running: false,
    runInput: null,
    document: savedGesture(),
    mode: "clip",
    pendingPose: null,
    poseEdit: null,
    itemId: "item-1",
    timelineSession: 0,
    applied: [],
    replaced: [],
    applyFails: false,
    removed: [],
  });
  stage.stop.mockClear();
  stage.restartPreview.mockClear();
  stage.history.beginGroup.mockClear();
  stage.history.endGroup.mockClear();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("the creator's Generate control", () => {
  it("is not there without the assistant", () => {
    stage.available = false;
    render();
    expect(find("creator-generate-toggle")).toBeNull();
    expect(find("creator-generate-panel")).toBeNull();
  });

  it("opens the item's conversation in a panel, and Escape gives focus back", async () => {
    render();
    const toggle = find("creator-generate-toggle")!;
    expect(toggle.textContent).toBe("Generate");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Nothing of the assistant is mounted, or asked for, before first use.
    expect(find("creator-generate-panel")).toBeNull();
    expect(stage.scopeInput).toBeNull();

    await click(toggle);
    const panel = find("creator-generate-panel")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.hidden).toBe(false);
    // Labelled, and no dialog: it does not trap focus or hide the creator.
    expect(panel.getAttribute("aria-labelledby")).toBeTruthy();
    expect(panel.getAttribute("role")).toBeNull();
    expect(panel.getAttribute("aria-modal")).toBeNull();
    expect(stage.scopeInput).toEqual({
      intent: "gesture",
      itemId: "item-1",
      enabled: true,
    });
    expect(document.activeElement).toBe(find("generate-request"));

    act(() => {
      find("generate-request")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(find("creator-generate-panel")!.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
    // Closed, not unmounted: a run in flight goes on.
    expect(find("generate-conversation")).not.toBeNull();

    await click(find("creator-generate-toggle"));
    await click(find("creator-generate-close"));
    expect(find("creator-generate-panel")!.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
  });

  it("sends the creator's document as it stands, or none for an empty item", async () => {
    render();
    await click(find("creator-generate-toggle"));
    stage.drafts = [generationDraft({ id: "draft-9", status: "ready" })];
    render();
    const source = (stage.runInput as RunInput).creatorSource!();
    expect(source).toMatchObject({
      draftId: "draft-9",
      document: { intent: "gesture", name: "My Wave", dependencies: [] },
    });
    expect(find("creator-generate-note")!.textContent).toContain(
      "Your request changes the Gesture open here. Undo puts it back.",
    );

    stage.document = createGestureDocument();
    stage.itemId = undefined;
    render();
    expect((stage.runInput as RunInput).creatorSource!()).toEqual({
      document: null,
      draftId: null,
    });
    expect(find("creator-generate-note")!.textContent).toContain(
      "Your request writes this new Gesture.",
    );
    expect(stage.scopeInput).toMatchObject({ itemId: null });
  });

  it("applies a run's results as one history entry and plays each", async () => {
    await startRun();
    expect(find("creator-generate-note")!.textContent).toContain(
      "Leave the timeline as it is while the assistant works.",
    );

    // The first result is a new entry; its repair takes that entry's place.
    stage.drafts = [result(2, 3.1)];
    render();
    expect(stage.replaced).toEqual([false]);
    expect((stage.document as ActionDocument).sequence.duration).toBe(3.1);
    stage.drafts = [{ ...result(2, 3.1), status: "repairing" }];
    render();
    stage.drafts = [result(3, 3.4)];
    render();
    // The creator renders again with the document it was just given.
    render();
    expect(stage.replaced).toEqual([false, true]);
    expect((stage.document as ActionDocument).sequence.duration).toBe(3.4);
    // Each new timeline is played in the creator's own preview.
    expect(stage.restartPreview).toHaveBeenCalledTimes(2);
    // The item keeps its identity whatever the result is called.
    expect((stage.document as ActionDocument).name).toBe("My Wave");
    // No history group is held open across the run: hand edits stay entries
    // of their own.
    expect(stage.history.beginGroup).not.toHaveBeenCalled();

    stage.running = false;
    render();
    // A later status of the same version is not applied again.
    stage.drafts = [{ ...result(3, 3.4), status: "ready" }];
    render();
    expect(stage.applied).toHaveLength(2);
    // The next run's first result is an entry of its own again.
    await startRun();
    stage.drafts = [result(4, 3.9)];
    render();
    expect(stage.replaced).toEqual([false, true, false]);
  });

  it("commits a pose being edited in Pose mode before the run, and says so", async () => {
    stage.mode = "pose";
    const posed = savedGesture();
    posed.sequence = { ...posed.sequence, duration: 5.5 };
    stage.pendingPose = posed;
    render();
    await click(find("creator-generate-toggle"));
    expect(find("creator-generate-pose-note")!.textContent).toBe(
      "Sending a request switches to Clip, where the result plays. A keyframe's pose you changed is applied first. An unsaved pose of its own has to be saved or discarded before.",
    );

    const source = (stage.runInput as RunInput).creatorSource!();
    stage.running = true;
    render();

    // The run starts from the document with the pose edit, in Clip mode.
    expect(source).toMatchObject({ document: { sequence: { duration: 5.5 } } });
    expect(stage.mode).toBe("clip");
    stage.drafts = [result(2, 3.1)];
    render();
    // The result is applied over that document: the edit was not "a change
    // meanwhile".
    expect(stage.applied).toHaveLength(1);
    expect(find("creator-generate-note")!.querySelector('[role="alert"]')).toBe(
      null,
    );
  });

  it("refuses a result while a keyframe's pose is being changed again", async () => {
    await startRun();
    stage.poseEdit = "keyframe_edit";
    stage.drafts = [result(2, 3.1)];
    render();
    expect(stage.applied).toEqual([]);
    expect(stage.stop).toHaveBeenCalledTimes(1);
    expect(
      find("creator-generate-note")!
        .querySelector('[role="alert"]')!
        .getAttribute("data-notice"),
    ).toBe("changed");
  });

  it("starts no run over an unsaved pose of its own, and says what to do", async () => {
    stage.mode = "pose";
    stage.poseEdit = "pose_draft";
    render();
    await click(find("creator-generate-toggle"));

    let source!: unknown;
    act(() => {
      source = (stage.runInput as RunInput).creatorSource!();
    });

    // No request goes out, and the creator is left as it is.
    expect(source).toBe(false);
    expect(stage.mode).toBe("pose");
    const notice = find("creator-generate-note")!.querySelector(
      '[role="alert"]',
    )!;
    expect(notice.getAttribute("data-notice")).toBe("pose_draft");
    expect(notice.textContent).toBe(
      "Pose mode holds an unsaved pose that the assistant's result would replace, so nothing was sent or applied. Save the pose or discard it, then send your request again.",
    );
  });

  it("applies no result over a pose drafted while the assistant worked", async () => {
    await startRun();
    stage.poseEdit = "pose_draft";
    stage.drafts = [result(2, 3.1)];
    render();

    expect(stage.applied).toEqual([]);
    expect(stage.stop).toHaveBeenCalledTimes(1);
    expect(
      find("creator-generate-note")!
        .querySelector('[role="alert"]')!
        .getAttribute("data-notice"),
    ).toBe("pose_draft");
  });

  it("applies nothing after Stop, and nothing after a run has ended", async () => {
    await startRun();
    stage.drafts = [result(2, 3.1)];
    render();
    expect(stage.applied).toHaveLength(1);

    // Stop, from the conversation's own Stop control.
    act(() => {
      (
        stage.conversationProps as { controller: { stop: () => void } }
      ).controller.stop();
    });
    expect(stage.stop).toHaveBeenCalledTimes(1);
    // A version the server stored as the run was stopped arrives later.
    stage.drafts = [result(3, 3.4)];
    render();
    stage.running = false;
    render();
    expect(stage.applied).toHaveLength(1);
    expect((stage.document as ActionDocument).sequence.duration).toBe(3.1);

    // A run that failed: what the server kept of it is read afterwards.
    await startRun();
    stage.running = false;
    render();
    stage.drafts = [result(4, 4.2)];
    render();
    expect(stage.applied).toHaveLength(1);
  });

  it("discards the item's conversation after a confirmation, never during a run", async () => {
    render();
    await click(find("creator-generate-toggle"));
    const discard = find("creator-generate-discard")!;
    // The Generate page's own action, by its own name.
    expect(discard.getAttribute("aria-label")).toBe(
      "Discard this conversation…",
    );
    await click(discard);
    const dialog = find("generate-conversation-discard-dialog")!;
    expect(dialog).not.toBeNull();
    expect(stage.removed).toEqual([]);
    await click(find("generate-conversation-discard-confirm"));
    expect(stage.removed).toEqual(["conversation-1"]);
    expect(find("generate-conversation-discard-dialog")).toBeNull();

    stage.running = true;
    render();
    expect(
      (find("creator-generate-discard") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("starts no second run over the one in flight", async () => {
    await startRun();
    expect((stage.runInput as RunInput).creatorSource!()).toBe(false);
    // The run in flight still applies its result.
    stage.drafts = [result(2, 3.1)];
    render();
    expect(stage.applied).toHaveLength(1);
  });

  it("applies nothing a run did not write: a stored draft stays where it is", async () => {
    stage.drafts = [result(4, 9)];
    render();
    await click(find("creator-generate-toggle"));
    render();
    expect(stage.applied).toEqual([]);
    // A run then starts from version 4; only what comes after is its own.
    await startRun();
    stage.drafts = [{ ...result(4, 9), status: "checking" }];
    render();
    expect(stage.applied).toEqual([]);
  });

  it("refuses a result when the timeline changed meanwhile, and stops the run", async () => {
    await startRun();
    // The person edits the timeline by hand while the assistant works.
    const edited = savedGesture();
    edited.sequence = { ...edited.sequence, duration: 1.2 };
    stage.document = edited;
    stage.drafts = [result(2, 3.1)];
    render();

    expect(stage.applied).toEqual([]);
    expect((stage.document as ActionDocument).sequence.duration).toBe(1.2);
    expect(stage.stop).toHaveBeenCalledTimes(1);
    const notice = find("creator-generate-note")!.querySelector(
      '[role="alert"]',
    )!;
    expect(notice.getAttribute("data-notice")).toBe("changed");
    expect(notice.textContent).toContain("was not applied");
    // Nothing later of that run is applied either.
    stage.drafts = [result(3, 3.4)];
    render();
    expect(stage.applied).toEqual([]);
    expect(stage.restartPreview).not.toHaveBeenCalled();
  });

  it("never applies a clip the page cannot load, and says when a result cannot be applied", async () => {
    await startRun();
    const broken = generationDraft({
      version: 2,
      project: gestureProject({ sequence: { schema: "animaPoseClip/2.0" } }),
    });
    expect(validateDraft(broken).sequence).toBeNull();
    stage.drafts = [broken];
    render();
    expect(stage.applied).toEqual([]);
    expect(stage.stop).not.toHaveBeenCalled();

    stage.applyFails = true;
    stage.drafts = [result(3, 3.4)];
    render();
    expect(
      find("creator-generate-note")!
        .querySelector('[role="alert"]')!
        .getAttribute("data-notice"),
    ).toBe("not_applied");
    // A later version of the same run that applies clears the notice.
    stage.applyFails = false;
    stage.drafts = [result(4, 3.6)];
    render();
    expect(stage.applied).toHaveLength(1);
    expect(find("creator-generate-note")!.querySelector('[role="alert"]')).toBe(
      null,
    );
  });

  it("sends setup to the Generate page while the assistant has no model", async () => {
    stage.model = null;
    render();
    await click(find("creator-generate-toggle"));
    const setup = find("creator-generate-setup")!;
    expect(setup.textContent).toContain("needs a model");
    expect(setup.querySelector("a")!.getAttribute("href")).toBe("/generate");
    expect(find("generate-conversation")).toBeNull();
    // No conversation is started for an assistant that cannot run.
    expect(stage.scopeInput).toMatchObject({ enabled: false });
  });
});

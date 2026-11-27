import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseAnimaPoseClip } from "@/lib/avatar/poses/animaPoseClip";
import { usePoseCreatorStore } from "@/stores/pose-creator-store";
import {
  commitCreatorHistory,
  createCreatorHistoryState,
  redoCreatorHistory,
  undoCreatorHistory,
} from "@/ui/creator-history/CreatorHistory";
import {
  gestureProject,
  waveHelloClip,
} from "@/ui/generate/testing/generationFixtures";
import { createGestureDocument } from "@/ui/gesture-editor/gestureDocument";
import {
  actionAuthoringSnapshot,
  actionAuthoringSnapshotsEqual,
  applyActionAuthoringSnapshot,
  type ActionAuthoringSnapshot,
  type ActionDocument,
} from "./actionDocument";
import {
  assistantDocumentFingerprint,
  assistantRunDocument,
} from "./assistantDocument";
import {
  pendingActionEditorPoseEdit,
  setActionEditorAuthoringMode,
} from "./actionEditorSavedPose";
import {
  commitAssistantResult,
  prepareCreatorForAssistantRun,
} from "./assistantRun";

/**
 * The creator's history as its hook keeps it, on the real history functions:
 * `commit` adds an entry and `replacePresent` swaps the current snapshot.
 */
function creatorHistory(initial: ActionAuthoringSnapshot) {
  let state = createCreatorHistoryState(initial);
  return {
    get present() {
      return state.present;
    },
    get entries() {
      return state.past.length;
    },
    commit(value: ActionAuthoringSnapshot) {
      state = commitCreatorHistory(state, value, actionAuthoringSnapshotsEqual);
    },
    replacePresent(value: ActionAuthoringSnapshot) {
      state = { ...state, present: value };
    },
    undo() {
      state = undoCreatorHistory(state);
    },
    redo() {
      state = redoCreatorHistory(state);
    },
  };
}

function savedGesture(): ActionDocument {
  return {
    ...createGestureDocument(),
    name: "My Wave",
    aiDescription: "Use for hello.",
    semanticKey: "my_wave",
    sequence: { ...waveHelloClip(), id: "my-wave", name: "My Wave" },
  };
}

const result = (duration: number) =>
  gestureProject({ sequence: { ...waveHelloClip(), duration } });
const store = () => usePoseCreatorStore.getState();
const surprisedKeys = (document: ActionDocument) =>
  (document.sequence.expressions as Record<string, { v: number }[]>)
    .surprised ?? [];

/**
 * Open the timeline in the real store and open a keyframe's pose for editing,
 * as Pose mode does for an item that has keyframes: the store stays in clip
 * authoring with an inline edit of that keyframe.
 */
function openKeyframeInPoseMode(document: ActionDocument) {
  store().hydrateClipDocument(parseAnimaPoseClip(document.sequence));
  const keyframe = store().clipDraft.keyframes[1]!;
  setActionEditorAuthoringMode("pose");
  expect(store().authoringMode).toBe("clip");
  store().beginClipInlinePoseEdit({
    alias: keyframe.pose,
    keyframeId: keyframe.id,
    originalPose: {},
    boneDrafts: {},
    expressionDrafts: {},
    draftName: "",
  });
}

/** The same, with an edit: a surprised face on that keyframe, in the pose editor's drafts only. */
function editPoseInPoseMode(document: ActionDocument) {
  openKeyframeInPoseMode(document);
  store().setExpressionDraft("surprised", { baseValue: 0, value: 0.6 });
  expect(pendingActionEditorPoseEdit()).toBe("keyframe_edit");
}

/**
 * The state a new Gesture opens in: the standalone pose editor, with no
 * keyframe and no inline edit, and here a pose drafted in it.
 */
function draftStandalonePose() {
  setActionEditorAuthoringMode("pose");
  expect(store().authoringMode).toBe("pose");
  expect(store().clipInlineEdit).toBeNull();
  expect(store().clipDraft.keyframes).toEqual([]);
  store().setExpressionDraft("surprised", { baseValue: 0, value: 0.6 });
  expect(pendingActionEditorPoseEdit()).toBe("pose_draft");
}

beforeEach(() => store().resetWorkspace());
afterEach(() => store().resetWorkspace());

describe("starting an assistant run from the creator", () => {
  it("sends a pose edited in Pose mode, and leaves Pose mode for the run", () => {
    const document = savedGesture();
    const history = creatorHistory(actionAuthoringSnapshot(document));
    editPoseInPoseMode(document);
    expect(store().clipInlineEdit).not.toBeNull();
    // Before the run, neither the document nor what it would send holds the edit.
    expect(surprisedKeys(document)).toEqual([]);

    const prepared = prepareCreatorForAssistantRun({
      document,
      mode: "pose",
      history,
    });

    expect(prepared).toMatchObject({ leftPoseMode: true, blocked: false });
    // The edit is in the document the run starts from, and in what is sent.
    expect(surprisedKeys(prepared.document).map(({ v }) => v)).toContain(0.6);
    const sent = assistantRunDocument(prepared.document)!;
    expect(
      (
        (sent.sequence as Record<string, unknown>).expressions as Record<
          string,
          unknown
        >
      ).surprised,
    ).toBeDefined();
    // The creator is in Clip mode with no pose edit open: its clip preview
    // plays the timeline, and the header's Undo is the clip history.
    expect(store().authoringMode).toBe("clip");
    expect(store().clipInlineEdit).toBeNull();
    // The pose edit is an entry of its own in the creator's history.
    expect(history.entries).toBe(1);
    expect(history.present).toEqual(actionAuthoringSnapshot(prepared.document));
  });

  it("returns to the document with that pose edit in one Undo after the result", () => {
    const before = savedGesture();
    const history = creatorHistory(actionAuthoringSnapshot(before));
    editPoseInPoseMode(before);
    const prepared = prepareCreatorForAssistantRun({
      document: before,
      mode: "pose",
      history,
    });
    const options = { identityExists: true, history };

    // The run's first result, then its repair.
    const first = commitAssistantResult({
      ...options,
      document: prepared.document,
      project: result(3.1),
    });
    const repaired = commitAssistantResult({
      ...options,
      document: first.document,
      project: result(3.4),
      replace: true,
    });
    expect([first.changed, repaired.changed]).toEqual([true, true]);
    expect(history.present.sequence.duration).toBe(3.4);

    history.undo();
    const undone = applyActionAuthoringSnapshot(
      repaired.document,
      history.present,
    );
    // One step back is the document from before the request, pose edit kept.
    expect(assistantDocumentFingerprint(undone)).toBe(
      assistantDocumentFingerprint(prepared.document),
    );
    expect(surprisedKeys(undone).map(({ v }) => v)).toContain(0.6);
    history.redo();
    expect(history.present.sequence.duration).toBe(3.4);
    // One more Undo from before the request is the pose edit itself.
    history.undo();
    history.undo();
    expect(history.present).toEqual(actionAuthoringSnapshot(before));
  });

  it("does not start over a pose drafted in a new Gesture's pose editor, and keeps the draft", () => {
    const document = createGestureDocument();
    const history = creatorHistory(actionAuthoringSnapshot(document));
    draftStandalonePose();
    const drafted = store().expressionDrafts;

    const prepared = prepareCreatorForAssistantRun({
      document,
      mode: "pose",
      history,
    });

    // The pose is on no keyframe: it cannot be sent, and a result would
    // discard it. The run does not start and nothing is touched.
    expect(prepared).toEqual({ document, leftPoseMode: false, blocked: true });
    expect(store().authoringMode).toBe("pose");
    expect(store().expressionDrafts).toBe(drafted);
    expect(store().isDirty).toBe(true);
    expect(history.entries).toBe(0);
    // Hydrating a result is what would have lost it.
    store().hydrateClipDocument(parseAnimaPoseClip(waveHelloClip()));
    expect(store().expressionDrafts).toEqual({});
  });

  it("does not start over an unsaved change to a Library Pose either, in any mode", () => {
    const document = savedGesture();
    const history = creatorHistory(actionAuthoringSnapshot(document));
    store().hydrateClipDocument(parseAnimaPoseClip(document.sequence));
    // A saved Pose opened in the pose editor, then changed.
    usePoseCreatorStore.setState({
      authoringMode: "pose",
      savedPoseIdentity: {
        itemId: "pose-1",
        logicalKey: "local:pose:bow",
        name: "Bow",
        poseId: "bow",
        revision: "r1",
      },
    });
    store().setExpressionDraft("surprised", { baseValue: 0, value: 0.6 });

    for (const mode of ["pose", "clip"] as const)
      expect(
        prepareCreatorForAssistantRun({ document, mode, history }),
      ).toMatchObject({ blocked: true, leftPoseMode: false });
    expect(store().savedPoseIdentity).not.toBeNull();
    expect(store().isDirty).toBe(true);
  });

  it("starts from a new Gesture's untouched pose editor, and moves to Clip", () => {
    const document = createGestureDocument();
    const history = creatorHistory(actionAuthoringSnapshot(document));
    setActionEditorAuthoringMode("pose");
    expect(pendingActionEditorPoseEdit()).toBeNull();

    const prepared = prepareCreatorForAssistantRun({
      document,
      mode: "pose",
      history,
    });

    expect(prepared).toEqual({ document, leftPoseMode: true, blocked: false });
    expect(assistantRunDocument(prepared.document)).toBeNull();
    expect(store().authoringMode).toBe("clip");
    expect(history.entries).toBe(0);
  });

  it("adds no history entry and leaves the item clean when the keyframe's pose was not changed", () => {
    const document = savedGesture();
    const history = creatorHistory(actionAuthoringSnapshot(document));
    openKeyframeInPoseMode(document);
    const timeline = store().clipDraft;
    expect(pendingActionEditorPoseEdit()).toBeNull();

    const prepared = prepareCreatorForAssistantRun({
      document,
      mode: "pose",
      history,
    });

    // Pose mode is left, as for any run, but nothing was edited: the
    // document is the same object, and neither the timeline nor the history
    // was touched.
    expect(prepared).toEqual({ document, leftPoseMode: true, blocked: false });
    expect(history.entries).toBe(0);
    expect(history.present).toEqual(actionAuthoringSnapshot(document));
    expect(store().clipDraft).toBe(timeline);
    expect(store().clipInlineEdit).toBeNull();
    expect(store().authoringMode).toBe("clip");
  });

  it("leaves a creator that is not in Pose mode as it is", () => {
    const document = savedGesture();
    const history = creatorHistory(actionAuthoringSnapshot(document));
    store().hydrateClipDocument(parseAnimaPoseClip(document.sequence));
    store().setAuthoringMode("clip");

    const prepared = prepareCreatorForAssistantRun({
      document,
      mode: "clip",
      history,
    });

    expect(prepared).toEqual({
      document,
      leftPoseMode: false,
      blocked: false,
    });
    expect(history.entries).toBe(0);
  });
});

describe("a run's results in the creator's history", () => {
  it("are one entry: two applied versions are undone in one step", () => {
    const before = savedGesture();
    const history = creatorHistory(actionAuthoringSnapshot(before));
    const options = { identityExists: true, history };

    const first = commitAssistantResult({
      ...options,
      document: before,
      project: result(3.1),
    });
    commitAssistantResult({
      ...options,
      document: first.document,
      project: result(3.4),
      replace: true,
    });

    expect(history.entries).toBe(1);
    history.undo();
    expect(history.present).toEqual(actionAuthoringSnapshot(before));
    history.redo();
    expect(history.present.sequence.duration).toBe(3.4);
  });

  it("keep a hand edit made during the run as an entry of its own", () => {
    const before = savedGesture();
    const history = creatorHistory(actionAuthoringSnapshot(before));
    const first = commitAssistantResult({
      document: before,
      project: result(3.1),
      identityExists: true,
      history,
    });
    // The person edits the timeline while the assistant still works.
    const edited: ActionDocument = {
      ...first.document,
      sequence: { ...first.document.sequence, loop: true },
    };
    history.commit(actionAuthoringSnapshot(edited));

    expect(history.entries).toBe(2);
    // Undo takes back the hand edit alone; the result is still there.
    history.undo();
    expect(history.present.sequence.duration).toBe(3.1);
    expect(history.present.sequence.loop).toBeUndefined();
    history.undo();
    expect(history.present).toEqual(actionAuthoringSnapshot(before));
  });

  it("adds no entry for a result that changes nothing", () => {
    const before = savedGesture();
    const history = creatorHistory(actionAuthoringSnapshot(before));
    const same = commitAssistantResult({
      document: before,
      project: gestureProject({ sequence: before.sequence }),
      identityExists: true,
      history,
    });
    expect(same.changed).toBe(false);
    expect(history.entries).toBe(0);
  });
});

import { usePoseCreatorStore } from "@/stores/pose-creator-store";
import type { CreatorHistoryController } from "@/ui/creator-history/CreatorHistory";
import { pruneUnusedTimelineDependencies } from "./actionDependencies";
import {
  actionAuthoringSnapshot,
  actionAuthoringSnapshotsEqual,
  applyActionAuthoringSnapshot,
  type ActionAuthoringSnapshot,
  type ActionDocument,
} from "./actionDocument";
import type { ActionEditorMode } from "./actionEditorCapabilities";
import {
  commitActionEditorInlineKeyframe,
  pendingActionEditorPoseEdit,
  setActionEditorAuthoringMode,
} from "./actionEditorSavedPose";
import { actionSequenceFromTimelineDraft } from "./actionPersistence";
import { applyAssistantProject } from "./assistantDocument";

/**
 * Make the creator ready for a content assistant run, and return the document
 * the run starts from, or `blocked` when the run must not start.
 *
 * - **An unsaved pose of its own** (the standalone pose editor) blocks the
 *   run, in any mode: it is on no keyframe, so it cannot be sent, and the
 *   result would discard it when it replaces the timeline. Nothing is
 *   changed; the person saves the pose, discards it or adds it to the
 *   timeline first, as the creator asks before any other replacement of a
 *   dirty pose draft.
 * - **A keyframe's pose being edited in Pose mode** lives only in the pose
 *   editor's drafts until it is applied. A run started there does what the
 *   switch to Clip does: it applies that pose to its keyframe and leaves
 *   Pose mode. When the pose was changed, the timeline store then holds the
 *   change: the document is read from the store (as Save reads it) and
 *   committed to the creator's history as an entry of its own, so the result
 *   that follows can be undone back to it. When nothing was changed, the
 *   edit is closed without touching the timeline, the history or the item.
 * - In Clip mode the result plays in the creator's preview and the header's
 *   Undo is the clip's, which is why a run leaves Pose mode.
 *
 * In any other mode the document is already what the timeline holds.
 */
export function prepareCreatorForAssistantRun(input: {
  document: ActionDocument;
  mode: ActionEditorMode;
  history: Pick<
    CreatorHistoryController<ActionAuthoringSnapshot>,
    "present" | "commit"
  >;
}): { document: ActionDocument; leftPoseMode: boolean; blocked: boolean } {
  const { document, mode, history } = input;
  const unchanged = { document, leftPoseMode: false, blocked: false };
  if (document.implementation !== "anima_clip") return unchanged;
  const pending = pendingActionEditorPoseEdit();
  if (pending === "pose_draft") return { ...unchanged, blocked: true };
  if (mode !== "pose") return unchanged;
  const left = { document, leftPoseMode: true, blocked: false };
  if (pending !== "keyframe_edit") {
    // Nothing was changed: close the keyframe's editor as it was opened.
    usePoseCreatorStore.getState().cancelClipInlinePoseEdit();
    setActionEditorAuthoringMode("clip");
    return left;
  }
  commitActionEditorInlineKeyframe();
  setActionEditorAuthoringMode("clip");
  const sequence = actionSequenceFromTimelineDraft(
    usePoseCreatorStore.getState().clipDraft,
    document.intent,
    { allowEmpty: true },
  );
  if (!sequence) return left;
  const snapshot = pruneUnusedTimelineDependencies({
    ...history.present,
    sequence,
  });
  history.commit(snapshot);
  return {
    ...left,
    document: applyActionAuthoringSnapshot(document, snapshot),
  };
}

/**
 * Put the content assistant's result (a draft's project) into the creator's
 * history, and return the document it becomes (`applyAssistantProject`).
 *
 * A run's first result is committed as one new entry. With `replace`, a later
 * version of the same run (a repair, a review's edit) takes that entry's
 * place instead of adding one, so the whole run stays one undoable change:
 * Undo returns to the document from before the request. The caller replaces
 * only while the run's last result is still what the document holds, so an
 * edit the person made is never folded into the run's entry.
 *
 * `changed` says whether the result differs from the document before it: a
 * result that changes nothing adds no entry, and the next version is then
 * the run's first.
 */
export function commitAssistantResult(input: {
  document: ActionDocument;
  project: unknown;
  identityExists: boolean;
  history: Pick<
    CreatorHistoryController<ActionAuthoringSnapshot>,
    "present" | "commit" | "replacePresent"
  >;
  replace?: boolean;
}): { document: ActionDocument; changed: boolean } {
  const next = applyAssistantProject(input.document, input.project, {
    identityExists: input.identityExists,
  });
  const snapshot = actionAuthoringSnapshot(next);
  const changed = !actionAuthoringSnapshotsEqual(
    input.history.present,
    snapshot,
  );
  if (input.replace) input.history.replacePresent(snapshot);
  else input.history.commit(snapshot);
  return { document: next, changed };
}

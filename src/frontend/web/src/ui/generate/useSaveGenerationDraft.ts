import { useProductApiClient } from "@animama/product-ui";
import { useCallback, useRef, useState } from "react";
import { getI18n } from "react-i18next";
import {
  getGesture,
  getReaction,
  type Client,
} from "@animama/runtime-contracts/sdk";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import { toContentSaveApiError } from "@/lib/content/contentSaveErrors";
import { WordedError } from "@/lib/errors/apiError";
import { useMarkGenerationDraftSaved } from "@/query/mutations/useGenerationMutations";
import { sdkResultError } from "@/query/sdkResultError";
import type { ActionSaveStage } from "@/ui/action-editor/ActionEditorWorkspaceContext";
import { pruneUnusedDependencies } from "@/ui/action-editor/actionDependencies";
import type {
  ActionDocument,
  ActionIntent,
} from "@/ui/action-editor/actionDocument";
import {
  importedProjectDocument,
  parseActionImport,
} from "@/ui/action-editor/actionProject";
import {
  ActionDocumentIncompleteError,
  useSaveActionDocument,
} from "@/ui/action-editor/useSaveActionDocument";
import { createGestureDocument } from "@/ui/gesture-editor/gestureDocument";
import { createReactionDocument } from "@/ui/reaction-editor/reactionDocument";
import type { DraftValidation } from "./useDraftWorker";

/**
 * The document a draft's project becomes in the creator: what the creator's
 * Import makes of the same project in a new document, with dependencies no
 * event uses left out as the creator's Save leaves them out. Throws a worded
 * error for a project the creator's Import would refuse.
 */
export function draftActionDocument(
  draft: Pick<PyGenerationDraft, "project" | "intent">,
): ActionDocument {
  const imported = parseActionImport(draft.project, draft.intent);
  if (imported.kind !== "project") {
    // A draft is always a project; a bare clip here is a malformed draft.
    const t = getI18n().getFixedT(null, "actionEditor");
    throw new WordedError(t("importDialog.failed"));
  }
  const blank =
    draft.intent === "gesture"
      ? createGestureDocument()
      : createReactionDocument();
  return pruneUnusedDependencies(
    importedProjectDocument(blank, imported.project),
  );
}

/**
 * The Local item a draft was saved as, if the Library still holds it. A saved
 * item the person has since deleted reads as none, so the draft saves as a new
 * item instead of failing.
 */
async function existingLocalItem(
  apiClient: Client,
  intent: ActionIntent,
  itemId: string,
): Promise<string | null> {
  const options = {
    client: apiClient,
    path: { item_id: itemId },
    responseValidator: undefined,
    throwOnError: false as const,
  };
  const result =
    intent === "gesture"
      ? await getGesture(options)
      : await getReaction(options);
  if (
    !result.response ||
    (result.error !== undefined && result.response.status !== 404)
  )
    throw sdkResultError(result, (status, error) =>
      toContentSaveApiError(error, status),
    );
  return result.response.status !== 404 && result.data?.source === "local"
    ? itemId
    : null;
}

export type SaveGenerationDraft = {
  /**
   * Save a draft as Local content through the creator's save, then record the
   * item on the draft. Resolves with the draft as the backend now holds it.
   * A draft saved before replaces its own Library item. Rejects with an error
   * whose `message` is worded for the person; for a document lacking a
   * required detail (`ActionDocumentIncompleteError`) a toast has already
   * said so.
   *
   * `validation` is the page's own validation of the draft (`useDraftWorker`):
   * only a draft it found loadable at its current version is saved.
   */
  save: (
    draft: PyGenerationDraft,
    validation: DraftValidation | undefined,
  ) => Promise<PyGenerationDraft>;
  /** The draft being saved now. */
  savingDraftId: string | null;
  /** What that save is doing. */
  stage: ActionSaveStage;
};

/**
 * Save for the Generate page's drafts. Saving is always the person's action:
 * nothing here runs by itself.
 */
export function useSaveGenerationDraft(): SaveGenerationDraft {
  const apiClient = useProductApiClient();
  const gesture = useSaveActionDocument("gesture");
  const reaction = useSaveActionDocument("reaction");
  const markSaved = useMarkGenerationDraftSaved();
  const [savingDraftId, setSavingDraftId] = useState<string | null>(null);
  const busy = useRef(false);
  /**
   * Versions saved in this session, by draft. When the save reached the
   * Library but its mark did not reach the draft, a retry only records the
   * mark instead of saving a second item.
   */
  const saved = useRef(new Map<string, { version: number; itemId: string }>());
  const savers = useRef({ gesture, reaction });
  savers.current = { gesture, reaction };
  const { mutateAsync: mark } = markSaved;

  const save = useCallback<SaveGenerationDraft["save"]>(
    async (draft, validation) => {
      if (busy.current) throw new Error("Another draft is being saved.");
      // The page's validation, never the stored report, admits a draft to Save.
      if (!validation?.sequence || validation.version !== draft.version)
        throw new Error("The draft cannot be saved: its clip does not load.");
      busy.current = true;
      setSavingDraftId(draft.id);
      try {
        const known = saved.current.get(draft.id);
        let itemId = known?.version === draft.version ? known.itemId : null;
        if (!itemId) {
          const document = draftActionDocument(draft);
          const replaces = draft.saved_item_id ?? known?.itemId ?? null;
          const target = await savers.current[draft.intent].saveDocument({
            document,
            itemId: replaces
              ? await existingLocalItem(apiClient, draft.intent, replaces)
              : null,
            // One edit session per draft: a retry continues it, and a save of
            // another draft never does.
            sessionKey: draft.id,
          });
          itemId = target.itemId;
          saved.current.set(draft.id, { version: draft.version, itemId });
        }
        return await mark({ draftId: draft.id, itemId });
      } catch (cause) {
        if (cause instanceof ActionDocumentIncompleteError) throw cause;
        throw toContentSaveApiError(cause);
      } finally {
        busy.current = false;
        setSavingDraftId(null);
      }
    },
    [apiClient, mark],
  );

  return {
    save,
    savingDraftId,
    stage: gesture.stage !== "idle" ? gesture.stage : reaction.stage,
  };
}

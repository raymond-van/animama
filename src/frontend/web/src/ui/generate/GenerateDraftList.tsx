import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import { apiErrorLine, failureLine } from "@/lib/errors/apiError";
import {
  useDiscardGenerationDraft,
  useRestoreGenerationDraft,
} from "@/query/mutations/useGenerationMutations";
import { ActionDocumentIncompleteError } from "@/ui/action-editor/useSaveActionDocument";
import { GenerateDraftCard } from "./GenerateDraftCard";
import { draftName } from "./generationDrafts";
import { describeGenerationActionFailure } from "./generationFailure";
import type { DraftWorker } from "./useDraftWorker";
import { useSaveGenerationDraft } from "./useSaveGenerationDraft";

const NO_RUN_DRAFTS: ReadonlySet<string> = new Set();

/**
 * The conversation's drafts, each with its status, warnings and actions.
 * Selecting one plays it in the preview and makes it the draft the next
 * message revises. Saving, restoring and discarding are the person's own
 * actions; a failure is said in a toast and the draft stays as it was.
 */
export function GenerateDraftList({
  drafts,
  isLoading = false,
  loadFailed = false,
  worker,
  selectedDraftId,
  onSelect,
  running,
  runDraftIds = NO_RUN_DRAFTS,
}: {
  drafts: readonly PyGenerationDraft[];
  /** The conversation is being read for the first time. */
  isLoading?: boolean;
  /** The conversation could not be read; its own panel offers the retry. */
  loadFailed?: boolean;
  worker: Pick<
    DraftWorker,
    "validations" | "checkingDraftId" | "failures" | "retryCheck"
  >;
  selectedDraftId: string | null;
  onSelect: (draftId: string) => void;
  /** A run is in flight on the conversation. */
  running: boolean;
  /** The drafts that run is working on; their Discard waits for it. */
  runDraftIds?: ReadonlySet<string>;
}) {
  const { t } = useTranslation("generate");
  const saver = useSaveGenerationDraft();
  const restore = useRestoreGenerationDraft();
  const discard = useDiscardGenerationDraft();
  /** The draft a restore or discard is working on. */
  const [actingOn, setActingOn] = useState<string | null>(null);
  const busy = saver.savingDraftId !== null || actingOn !== null;
  const nameOf = (draft: PyGenerationDraft) =>
    draftName(draft) || t("drafts.unnamed");

  const save = async (draft: PyGenerationDraft) => {
    try {
      await saver.save(draft, worker.validations[draft.id]);
      toast.success(t("drafts.toasts.saved", { name: nameOf(draft) }));
    } catch (error) {
      // A toast already named the details the document lacks.
      if (error instanceof ActionDocumentIncompleteError) return;
      toast.error(failureLine(error, t("drafts.toasts.saveFailed")));
    }
  };

  const act = async (
    draft: PyGenerationDraft,
    action: () => Promise<unknown>,
  ) => {
    setActingOn(draft.id);
    try {
      await action();
    } catch (error) {
      toast.error(apiErrorLine(describeGenerationActionFailure(error)));
    } finally {
      setActingOn(null);
    }
  };

  if (loadFailed)
    return (
      <p className="p-2 text-sm" role="status">
        {t("drafts.loadFailed")}
      </p>
    );
  if (isLoading)
    return (
      <p className="text-muted-foreground p-2 text-sm" role="status">
        {t("drafts.loading")}
      </p>
    );
  if (drafts.length === 0)
    return (
      <div className="space-y-1 p-2" data-testid="generate-drafts-empty">
        <p className="text-sm font-medium">{t("drafts.emptyTitle")}</p>
        <p className="text-muted-foreground text-xs">
          {t("drafts.emptyDescription")}
        </p>
      </div>
    );

  return (
    <ul className="space-y-2" data-testid="generate-drafts">
      {drafts.map((draft) => (
        <li key={draft.id}>
          <GenerateDraftCard
            draft={draft}
            validation={worker.validations[draft.id]}
            selected={draft.id === selectedDraftId}
            onSelect={() => onSelect(draft.id)}
            running={running}
            inRun={runDraftIds.has(draft.id)}
            checking={worker.checkingDraftId === draft.id}
            checkFailure={worker.failures[draft.id]}
            onRetryCheck={() => worker.retryCheck(draft.id)}
            saving={saver.savingDraftId === draft.id}
            busy={busy}
            onSave={() => void save(draft)}
            onRestore={() =>
              void act(draft, () => restore.mutateAsync(draft.id))
            }
            onDiscard={() =>
              void act(draft, () =>
                discard.mutateAsync({
                  id: draft.id,
                  conversation_id: draft.conversation_id,
                }),
              )
            }
          />
        </li>
      ))}
    </ul>
  );
}

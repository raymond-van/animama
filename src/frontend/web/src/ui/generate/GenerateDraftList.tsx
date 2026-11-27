import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import { apiErrorLine, failureLine } from "@/lib/errors/apiError";
import {
  useDiscardGenerationDraft,
  useRestoreGenerationDraft,
} from "@/query/mutations/useGenerationMutations";
import { ActionDocumentIncompleteError } from "@/ui/action-editor/useSaveActionDocument";
import { Button } from "@/ui/components/button";
import type { DraftEffectsInfo } from "./draftEffects";
import { GenerateDraftCard } from "./GenerateDraftCard";
import type { DraftBatchInfo } from "./generationBatch";
import { draftName } from "./generationDrafts";
import { describeGenerationActionFailure } from "./generationFailure";
import type { DraftValidation, DraftWorker } from "./useDraftWorker";
import { useSaveGenerationDraft } from "./useSaveGenerationDraft";

const NO_RUN_DRAFTS: ReadonlySet<string> = new Set();
const NO_BATCH: ReadonlyMap<string, DraftBatchInfo> = new Map();
const NO_MARKS: ReadonlySet<string> = new Set();
const NO_EFFECTS: ReadonlyMap<string, DraftEffectsInfo> = new Map();

/**
 * Whether a draft can be saved as it stands: the page validated its current
 * version as one it can load, no run is working on it, so it will not change
 * under the save, and every effect it plays is still in the Library.
 */
function draftSaveable(
  draft: PyGenerationDraft,
  validation: DraftValidation | undefined,
  working: boolean,
  effects: DraftEffectsInfo | undefined,
): boolean {
  return (
    !working &&
    validation?.version === draft.version &&
    Boolean(validation.sequence) &&
    !effects?.missing.length
  );
}

/** How saving several drafts ended, in drafts. */
type SaveManyOutcome = { saved: number; failed: number; skipped: number };

/**
 * The conversation's drafts, each with its status, warnings and actions.
 * Selecting one plays it in the preview and makes it the draft the next
 * message revises. Saving, restoring and discarding are the person's own
 * actions; a failure is said in a toast and the draft stays as it was.
 *
 * With two or more drafts the list also offers to save the marked drafts, or
 * all of them (R7.4): one after another through the same save as a card's
 * Save, each as its own Local item. A draft that cannot be saved as it stands
 * is skipped, and a save that fails is reported on its card and counted in a
 * short summary; neither stops the rest. A draft that plays an effect the
 * Library no longer holds is one that cannot be saved as it stands: its own
 * Save is held, and saving several skips it.
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
  workingDraftIds = NO_RUN_DRAFTS,
  batchInfo = NO_BATCH,
  effects = NO_EFFECTS,
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
  /** The drafts whose Discard waits for that run. */
  runDraftIds?: ReadonlySet<string>;
  /** The drafts that run is working on now; none of them is saved meanwhile. */
  workingDraftIds?: ReadonlySet<string>;
  /** Each batch draft's brief, step and failure, by draft id. */
  batchInfo?: ReadonlyMap<string, DraftBatchInfo>;
  /** What each draft that plays effects shows of them, by draft id. */
  effects?: ReadonlyMap<string, DraftEffectsInfo>;
}) {
  const { t } = useTranslation("generate");
  const saver = useSaveGenerationDraft();
  const restore = useRestoreGenerationDraft();
  const discard = useDiscardGenerationDraft();
  /** The draft a restore or discard is working on. */
  const [actingOn, setActingOn] = useState<string | null>(null);
  /** The drafts marked for "Save selected". */
  const [marked, setMarked] = useState<ReadonlySet<string>>(NO_MARKS);
  /** Saving several drafts: which one it is at, of how many. */
  const [savingMany, setSavingMany] = useState<{
    position: number;
    total: number;
  } | null>(null);
  /** How the last "Save selected" or "Save all" ended. */
  const [saveSummary, setSaveSummary] = useState<SaveManyOutcome | null>(null);
  /** Why saving a draft with others failed, worded, by draft id. */
  const [saveFailures, setSaveFailures] = useState<
    Readonly<Record<string, string>>
  >({});
  const busy =
    saver.savingDraftId !== null || actingOn !== null || savingMany !== null;
  const nameOf = (draft: PyGenerationDraft) =>
    draftName(draft) || t("drafts.unnamed");

  // Marks, the summary and save failures belong to the conversation shown.
  const conversationId = drafts[0]?.conversation_id ?? null;
  // What a sequence of saves reads at each draft's turn: the list as it is
  // then, not as it was when the sequence started.
  const latest = useRef({
    conversationId,
    drafts,
    validations: worker.validations,
    workingDraftIds,
    effects,
  });
  latest.current = {
    conversationId,
    drafts,
    validations: worker.validations,
    workingDraftIds,
    effects,
  };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [shownConversationId, setShownConversationId] =
    useState(conversationId);
  if (conversationId !== null && conversationId !== shownConversationId) {
    setShownConversationId(conversationId);
    setMarked(NO_MARKS);
    setSaveSummary(null);
    setSaveFailures({});
  }

  const forgetSaveFailure = (draftId: string) =>
    setSaveFailures((current) =>
      draftId in current
        ? Object.fromEntries(
            Object.entries(current).filter(([id]) => id !== draftId),
          )
        : current,
    );

  const save = async (draft: PyGenerationDraft) => {
    // The card holds its Save for this; nothing else may save the draft either.
    if (effects.get(draft.id)?.missing.length) return;
    try {
      await saver.save(draft, worker.validations[draft.id]);
      forgetSaveFailure(draft.id);
      toast.success(t("drafts.toasts.saved", { name: nameOf(draft) }));
    } catch (error) {
      // A toast already named the details the document lacks.
      if (error instanceof ActionDocumentIncompleteError) return;
      toast.error(failureLine(error, t("drafts.toasts.saveFailed")));
    }
  };

  /**
   * Save the drafts named, in list order, one after another. Each is looked
   * at again at its turn: one that is gone, does not load at its current
   * version, is being worked on by a run or plays an effect the Library no
   * longer holds is skipped. A failed save is kept for its card and the next
   * draft is saved all the same.
   */
  const saveMany = async (draftIds: readonly string[]) => {
    if (busy || running || draftIds.length === 0) return;
    const outcome: SaveManyOutcome = { saved: 0, failed: 0, skipped: 0 };
    setSaveSummary(null);
    for (const [index, draftId] of draftIds.entries()) {
      // Leaving the page or the conversation ends the sequence; what was
      // saved stays saved.
      if (!mounted.current) return;
      if (latest.current.conversationId !== conversationId) {
        setSavingMany(null);
        return;
      }
      setSavingMany({ position: index + 1, total: draftIds.length });
      const now = latest.current;
      const draft = now.drafts.find(({ id }) => id === draftId);
      const validation = now.validations[draftId];
      if (
        !draft ||
        !draftSaveable(
          draft,
          validation,
          now.workingDraftIds.has(draftId),
          now.effects.get(draftId),
        )
      ) {
        outcome.skipped += 1;
        continue;
      }
      forgetSaveFailure(draftId);
      try {
        await saver.save(draft, validation);
        outcome.saved += 1;
        setMarked((current) => {
          const next = new Set(current);
          next.delete(draftId);
          return next;
        });
      } catch (error) {
        outcome.failed += 1;
        // Worded for the person; the creator's save may also have said in a
        // toast which details the document lacks.
        const reason = failureLine(error, t("drafts.toasts.saveFailed"));
        setSaveFailures((current) => ({ ...current, [draftId]: reason }));
      }
    }
    if (!mounted.current) return;
    setSavingMany(null);
    setSaveSummary(outcome);
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

  const saveable = (draft: PyGenerationDraft) =>
    draftSaveable(
      draft,
      worker.validations[draft.id],
      workingDraftIds.has(draft.id),
      effects.get(draft.id),
    );
  const markedIds = drafts
    .filter((draft) => marked.has(draft.id) && saveable(draft))
    .map(({ id }) => id);
  // Saving several waits for a run in flight, as a card's Save does.
  const saveManyHeld = busy || running;
  const offersSaveMany = drafts.length > 1;

  return (
    <div className="space-y-2">
      {offersSaveMany ? (
        <div className="space-y-1.5" data-testid="generate-drafts-save-many">
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="generate-drafts-save-selected"
              disabled={saveManyHeld || markedIds.length === 0}
              title={running ? t("drafts.waitForRun") : undefined}
              onClick={() => void saveMany(markedIds)}
            >
              {t("drafts.saveMany.selected", { selected: markedIds.length })}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="generate-drafts-save-all"
              disabled={saveManyHeld || !drafts.some(saveable)}
              title={running ? t("drafts.waitForRun") : undefined}
              // Every draft is named, so the summary counts the ones skipped.
              onClick={() => void saveMany(drafts.map(({ id }) => id))}
            >
              {t("drafts.saveMany.all")}
            </Button>
          </div>
          {savingMany ? (
            <p
              className="text-muted-foreground text-xs"
              role="status"
              data-testid="generate-drafts-save-progress"
            >
              {t("drafts.saveMany.saving", savingMany)}
            </p>
          ) : saveSummary ? (
            <p
              className="text-xs"
              role="status"
              data-testid="generate-drafts-save-summary"
              data-saved={saveSummary.saved}
              data-failed={saveSummary.failed}
              data-skipped={saveSummary.skipped}
            >
              {saveSummary.saved > 0 ? (
                <span className="block">
                  {t("drafts.saveMany.saved", { count: saveSummary.saved })}
                </span>
              ) : null}
              {saveSummary.failed > 0 ? (
                <span className="text-destructive block">
                  {t("drafts.saveMany.failed", { count: saveSummary.failed })}
                </span>
              ) : null}
              {saveSummary.skipped > 0 ? (
                <span className="text-muted-foreground block">
                  {t("drafts.saveMany.skipped", { count: saveSummary.skipped })}
                </span>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}
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
              batch={batchInfo.get(draft.id)}
              marked={marked.has(draft.id)}
              onMarkedChange={
                offersSaveMany
                  ? (next) =>
                      setMarked((current) => {
                        const ids = new Set(current);
                        if (next) ids.add(draft.id);
                        else ids.delete(draft.id);
                        return ids;
                      })
                  : undefined
              }
              saveFailure={saveFailures[draft.id]}
              effects={effects.get(draft.id)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

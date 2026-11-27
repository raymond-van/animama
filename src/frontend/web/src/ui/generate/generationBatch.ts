import type {
  PyGenerationDraft,
  PyGenerationMessage,
} from "@animama/runtime-contracts/api-types";

import { isRecord } from "@/lib/records";
import type {
  GenerationDraftPhase,
  GenerationItemFailure,
  GenerationRunState,
} from "@/stores/generation-store";
import { parseGenerationBatch } from "./generationDrafts";

/**
 * A batch as the page shows it. One request may be written as up to ten
 * items, each its own draft. While the run is in flight its stream says what
 * was planned and where each item stands (`stores/generation-store.ts`);
 * afterwards the run's stored assistant turn keeps the plan (`data.batch`),
 * so a draft's brief and an item's failure return after a reload.
 */

/** What a draft's card shows of the batch its draft was planned in. */
export type DraftBatchInfo = {
  /** What the item was planned to be; empty when the plan gave none. */
  brief: string;
  /**
   * Where the run in flight stands with the item: its step, `waiting` while
   * the run has not started on it, or `null` when the run is not working on
   * it (it settled or failed, or no run is in flight).
   */
  step: GenerationDraftPhase | "waiting" | null;
  /** Why the item failed while its run went on with the others, if it did. */
  failure: GenerationItemFailure | null;
};

/** The statuses a draft is left in once a run has finished with it. */
const SETTLED_STATUSES: ReadonlySet<string> = new Set([
  "ready",
  "warnings",
  "failed",
]);

type BatchRun = Pick<
  GenerationRunState,
  "running" | "batch" | "draftPhases" | "itemFailures"
>;

/**
 * Each batch draft's brief, step and failure, by draft id, for the drafts
 * that exist. A draft that no batch planned has no entry.
 *
 * - The brief comes from the run's plan, or else from the stored turn of the
 *   run that planned the draft.
 * - The step is told only while a run is in flight, for that run's items.
 * - The failure is the one the last run reported for the item. After a
 *   reload it is read from the conversation's last assistant turn, and only
 *   while no run is in flight: a failure stored with an earlier run no longer
 *   describes a draft a later run may have revised.
 */
export function draftBatchInfo(input: {
  drafts: readonly PyGenerationDraft[];
  messages: readonly PyGenerationMessage[];
  run: BatchRun;
}): ReadonlyMap<string, DraftBatchInfo> {
  const { drafts, messages, run } = input;
  const briefs = new Map<string, string>();
  const storedFailures = new Map<string, GenerationItemFailure>();
  const lastAssistant = messages.findLast(({ role }) => role === "assistant");
  for (const message of messages) {
    if (message.role !== "assistant" || !isRecord(message.data)) continue;
    for (const item of parseGenerationBatch(message.data.batch)) {
      briefs.set(item.draftId, item.brief);
      if (item.error && message === lastAssistant && !run.running)
        storedFailures.set(item.draftId, { ...item.error, details: {} });
    }
  }
  const inFlight = new Set<string>();
  for (const item of run.batch ?? []) {
    briefs.set(item.draftId, item.brief);
    if (run.running) inFlight.add(item.draftId);
  }

  const info = new Map<string, DraftBatchInfo>();
  for (const draft of drafts) {
    const brief = briefs.get(draft.id);
    if (brief === undefined) continue;
    const failure =
      run.itemFailures[draft.id] ?? storedFailures.get(draft.id) ?? null;
    // A planned item is listed as `writing` without a project until the run
    // starts on it; from then on the run names its step.
    const waiting =
      !failure && draft.status === "writing" && draft.project === null;
    info.set(draft.id, {
      brief,
      step: inFlight.has(draft.id)
        ? (run.draftPhases[draft.id] ?? (waiting ? "waiting" : null))
        : null,
      failure,
    });
  }
  return info;
}

/**
 * How far the batch in flight has come: how many items it is working through,
 * and how many it has finished with. An item is finished once its draft is in
 * the list and settled, or its item failed. A planned item whose draft the
 * list does not hold yet is still to come, so the count starts at none; one
 * the person discarded is no longer part of the batch. `null` unless a run
 * that planned a batch is in flight.
 */
export function generationBatchProgress(
  run: Pick<
    GenerationRunState,
    "running" | "batch" | "itemFailures" | "discardedDraftIds"
  >,
  drafts: readonly Pick<PyGenerationDraft, "id" | "status">[],
): { total: number; done: number } | null {
  if (!run.running || !run.batch) return null;
  const statuses = new Map(drafts.map(({ id, status }) => [id, status]));
  const items = run.batch.filter(
    ({ draftId }) => !run.discardedDraftIds.includes(draftId),
  );
  const done = items.filter(({ draftId }) => {
    const status = statuses.get(draftId);
    return (
      status !== undefined &&
      (SETTLED_STATUSES.has(status) || draftId in run.itemFailures)
    );
  }).length;
  return { total: items.length, done };
}

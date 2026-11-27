import { create } from "zustand";
import type { PyGenerationAnswers } from "@animama/runtime-contracts/api-types";

import { registerPrivateStateReset } from "@/app/runtime/private-module-state";
import type {
  GenerationBatchItem,
  PendingGenerationQuestions,
} from "@/ui/generate/generationDrafts";
import type { GenerationRunEvent } from "@/ui/generate/generationStream";

/**
 * The content assistant's transient state, per conversation: what the run in
 * flight is doing and what the last one left for the person to act on. Stored
 * conversations, messages and drafts live in TanStack Query
 * (`query/hooks/useGeneration.ts`); nothing here outlives the page session.
 */

/** What a run is doing, for the page to say in words. `starting` precedes the stream's first event. */
export type GenerationRunPhase =
  | "starting"
  | "thinking"
  | "writing"
  | "checking"
  | "repairing"
  | "reviewing_frames";

/** A step of the run's work on one draft. */
export type GenerationDraftPhase = Exclude<GenerationRunPhase, "starting">;

/** Review sheets a run asked the page for: one draft version's. */
export type GenerationFramesRequest = { draftId: string; version: number };

/**
 * Why one item of a batch failed while the run went on: stable codes and
 * data only, worded at render (`generationFailureLine`).
 */
export type GenerationItemFailure = {
  code: string;
  category: string | null;
  details: Record<string, unknown>;
};

/** One request to the assistant, as the person made it. */
export type GenerationRunRequest = {
  message: string;
  /** The draft the message revises, or `null` for a new draft. */
  draftId: string | null;
  /** The kind of a new draft; a Gesture when left out. A revision keeps its draft's kind. */
  intent?: "gesture" | "reaction";
  /** Answers to the previous run's questions (or that they were skipped). */
  answers: PyGenerationAnswers | null;
};

/**
 * Why a run failed: stable codes and data only, worded at render
 * (`describeGenerationFailure`). `request` is what a retry sends again.
 */
export type GenerationRunFailure = {
  code: string;
  category: string | null;
  /** The backend's reason for a refused model (`generation_model_unusable`). */
  reason: string | null;
  details: Record<string, unknown>;
  /** The HTTP status when the request itself was refused, else `null`. */
  status: number | null;
  /** The connection failed before any answer arrived. */
  network: boolean;
  request: GenerationRunRequest;
};

/** Tokens the run's model responses reported, added up. */
export type GenerationRunUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  requests: number;
};

/** The turn a run adds to the conversation, shown until the stored messages are read again. */
export type GenerationPendingTurn = {
  message: string;
  draftId: string | null;
  /** The assistant's text so far. */
  text: string;
};

export type GenerationRunState = {
  running: boolean;
  runId: string | null;
  /**
   * The step the run named last. A run that writes or revises one draft has
   * one step at a time; in a batch it is the last named item's, and each
   * item's own step is in `draftPhases`.
   */
  phase: GenerationRunPhase | null;
  /** The draft the phase is about, once the run names one. */
  phaseDraftId: string | null;
  /**
   * The items of the batch the run planned, in plan order, each with its
   * brief; `null` for a run that writes or revises one draft. Kept after
   * the run for the page to show, until the next run starts.
   */
  batch: readonly GenerationBatchItem[] | null;
  /**
   * The step the run in flight is at for each draft it is working on, by
   * draft id. A draft leaves when it settles or fails. A batch item with no
   * step, whose draft has not settled, is waiting its turn.
   */
  draftPhases: Readonly<Record<string, GenerationDraftPhase>>;
  /**
   * Batch items that failed while the run went on, by draft id. Kept after
   * the run for the page to show, until the next run starts.
   */
  itemFailures: Readonly<Record<string, GenerationItemFailure>>;
  pendingTurn: GenerationPendingTurn | null;
  /** Questions the last run ended on, until the next run starts. */
  questions: PendingGenerationQuestions | null;
  failure: GenerationRunFailure | null;
  /**
   * Review sheets the run in flight is waiting for, in the order asked: at
   * most one request for a draft, and in a batch up to one for each item in
   * flight.
   */
  framesRequests: readonly GenerationFramesRequest[];
  /** The last finished run's token use; `null` while a run is in flight. */
  usage: GenerationRunUsage | null;
  /**
   * The run stored a draft (one arrived on its stream). A run that failed
   * after that is not offered again: a second pass would write the draft a
   * second time, or overwrite what a restore returns to.
   */
  draftStored: boolean;
  /** The person stopped the last run. */
  stopped: boolean;
  /**
   * Drafts the person discarded while the run in flight worked on them. The
   * run's later events about them are ignored, so a discarded draft does not
   * come back.
   */
  discardedDraftIds: readonly string[];
};

/** The state of a conversation no run has touched in this session. */
export const IDLE_GENERATION_RUN: GenerationRunState = Object.freeze({
  running: false,
  runId: null,
  phase: null,
  phaseDraftId: null,
  batch: null,
  draftPhases: Object.freeze({}),
  itemFailures: Object.freeze({}),
  pendingTurn: null,
  questions: null,
  failure: null,
  framesRequests: Object.freeze([]),
  usage: null,
  draftStored: false,
  stopped: false,
  discardedDraftIds: Object.freeze([]),
});

type GenerationStoreState = {
  runs: Record<string, GenerationRunState>;
};

export const useGenerationStore = create<GenerationStoreState>(() => ({
  runs: {},
}));

function update(
  conversationId: string,
  change: (run: GenerationRunState) => GenerationRunState,
): void {
  useGenerationStore.setState(({ runs }) => ({
    runs: {
      ...runs,
      [conversationId]: change(runs[conversationId] ?? IDLE_GENERATION_RUN),
    },
  }));
}

/** A conversation's run state outside React. */
export function generationRunState(conversationId: string): GenerationRunState {
  return (
    useGenerationStore.getState().runs[conversationId] ?? IDLE_GENERATION_RUN
  );
}

/** A conversation's run state; the idle state for `null` or an untouched one. */
export function useGenerationRunState(
  conversationId: string | null,
): GenerationRunState {
  return useGenerationStore(
    (state) =>
      (conversationId ? state.runs[conversationId] : undefined) ??
      IDLE_GENERATION_RUN,
  );
}

/**
 * Whether a run is in flight on a conversation. Read by itself, so its
 * reader does not render again for every piece of streamed text.
 */
export function useGenerationRunning(conversationId: string | null): boolean {
  return useGenerationStore(
    (state) =>
      (conversationId ? state.runs[conversationId]?.running : false) === true,
  );
}

/**
 * The drafts the run in flight is working on now: the one its request
 * revises, the one its last step names (a new draft, once it is written),
 * and every draft that has a step of its own, which in a batch are the items
 * in flight. Such a draft may change under the person, so the page does not
 * save it. Empty when no run is in flight.
 */
export function generationRunWorkingDraftIds(
  run: Pick<
    GenerationRunState,
    "running" | "phaseDraftId" | "pendingTurn" | "draftPhases"
  >,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!run.running) return ids;
  if (run.pendingTurn?.draftId) ids.add(run.pendingTurn.draftId);
  if (run.phaseDraftId) ids.add(run.phaseDraftId);
  for (const id of Object.keys(run.draftPhases)) ids.add(id);
  return ids;
}

/**
 * The drafts whose Discard waits for the run in flight: the ones it is
 * working on, since discarding the draft of a run that writes or revises one
 * would end that run as a failure. A batch's items are left out: the backend
 * ends only the discarded item, and the others go on. Empty when no run is
 * in flight.
 */
export function generationRunDraftIds(
  run: Pick<GenerationRunState, "running" | "phaseDraftId" | "pendingTurn"> &
    Partial<Pick<GenerationRunState, "draftPhases" | "batch">>,
): ReadonlySet<string> {
  const ids = new Set(
    generationRunWorkingDraftIds({
      ...run,
      draftPhases: run.draftPhases ?? {},
    }),
  );
  for (const item of run.batch ?? []) ids.delete(item.draftId);
  return ids;
}

/**
 * The review sheets a conversation's run is waiting for. Read by itself, so
 * its reader does not render again for every piece of streamed text.
 */
export function useGenerationFramesRequests(
  conversationId: string | null,
): GenerationRunState["framesRequests"] {
  return useGenerationStore(
    (state) =>
      (conversationId ? state.runs[conversationId]?.framesRequests : null) ??
      IDLE_GENERATION_RUN.framesRequests,
  );
}

/**
 * Mark a run as started. Returns `false`, changing nothing, while the
 * conversation already has one in flight: a conversation runs one request at
 * a time, and the page refuses the second before the server has to.
 */
export function beginGenerationRun(
  conversationId: string,
  request: GenerationRunRequest,
): boolean {
  if (generationRunState(conversationId).running) return false;
  update(conversationId, () => ({
    ...IDLE_GENERATION_RUN,
    running: true,
    phase: "starting",
    pendingTurn: {
      message: request.message,
      draftId: request.draftId,
      text: "",
    },
  }));
  return true;
}

/** The statuses a draft is left in once a run has finished with it. */
const SETTLED_STATUSES: ReadonlySet<string> = new Set([
  "ready",
  "warnings",
  "failed",
]);

/** A record without one of its keys; the record itself when it has no such key. */
function without<Value>(
  record: Readonly<Record<string, Value>>,
  key: string,
): Readonly<Record<string, Value>> {
  if (!(key in record)) return record;
  return Object.fromEntries(
    Object.entries(record).filter(([id]) => id !== key),
  );
}

/** The requests for sheets without a draft's; the list itself when it holds none. */
function withoutFramesOf(
  requests: readonly GenerationFramesRequest[],
  draftId: string,
): readonly GenerationFramesRequest[] {
  return requests.some((request) => request.draftId === draftId)
    ? requests.filter((request) => request.draftId !== draftId)
    : requests;
}

/**
 * What one stream event changes in a run's state. Events of other kinds
 * change nothing, and neither does an event about a draft the person
 * discarded during the run.
 */
export function reduceGenerationRunEvent(
  run: GenerationRunState,
  event: GenerationRunEvent,
  request: GenerationRunRequest,
): GenerationRunState {
  const discarded = (draftId: string | null) =>
    draftId !== null && run.discardedDraftIds.includes(draftId);
  switch (event.type) {
    case "run.started":
      return { ...run, runId: event.runId };
    case "batch.planned":
      return { ...run, batch: event.items };
    case "progress":
      if (!event.phase || discarded(event.draftId)) return run;
      return {
        ...run,
        phase: event.phase,
        phaseDraftId: event.draftId,
        draftPhases: event.draftId
          ? { ...run.draftPhases, [event.draftId]: event.phase }
          : run.draftPhases,
      };
    case "message.delta":
      return run.pendingTurn
        ? {
            ...run,
            pendingTurn: {
              ...run.pendingTurn,
              text: run.pendingTurn.text + event.text,
            },
          }
        : run;
    case "questions":
      return event.questions.length > 0
        ? {
            ...run,
            questions: {
              questions: event.questions,
              request: { message: request.message, draftId: request.draftId },
            },
          }
        : run;
    case "frames.requested":
      if (discarded(event.draftId)) return run;
      return {
        ...run,
        // A draft has one request outstanding: a newer one takes its place.
        framesRequests: [
          ...withoutFramesOf(run.framesRequests, event.draftId),
          { draftId: event.draftId, version: event.version },
        ],
      };
    case "draft.updated": {
      const { draft } = event;
      if (discarded(draft.id)) return run;
      const asked = run.framesRequests.find(
        ({ draftId }) => draftId === draft.id,
      );
      // The run moved on from the version it asked sheets for.
      const movedOn =
        asked !== undefined &&
        (draft.version !== asked.version || draft.status !== "checking");
      // The run has finished with a draft it leaves settled.
      const stepEnds =
        SETTLED_STATUSES.has(draft.status) && draft.id in run.draftPhases;
      // The backend sends a draft only once it is stored.
      if (!movedOn && !stepEnds && run.draftStored) return run;
      return {
        ...run,
        draftStored: true,
        framesRequests: movedOn
          ? withoutFramesOf(run.framesRequests, draft.id)
          : run.framesRequests,
        draftPhases: stepEnds
          ? without(run.draftPhases, draft.id)
          : run.draftPhases,
      };
    }
    case "item.failed":
      if (discarded(event.draftId)) return run;
      return {
        ...run,
        itemFailures: {
          ...run.itemFailures,
          [event.draftId]: {
            code: event.code,
            category: event.category,
            details: event.details,
          },
        },
        // The run works on the item no more, and draws nothing for it.
        draftPhases: without(run.draftPhases, event.draftId),
        framesRequests: withoutFramesOf(run.framesRequests, event.draftId),
      };
    case "run.failed":
      return {
        ...run,
        failure: {
          code: event.code,
          category: event.category,
          reason: null,
          details: event.details,
          status: null,
          network: false,
          request,
        },
      };
    case "run.completed":
      return { ...run, usage: event.usage };
  }
}

/** Apply one stream event of the run in flight. */
export function applyGenerationRunEvent(
  conversationId: string,
  event: GenerationRunEvent,
  request: GenerationRunRequest,
): void {
  update(conversationId, (run) =>
    reduceGenerationRunEvent(run, event, request),
  );
}

/**
 * Mark the run as over. `failure` is a failure the stream did not report
 * itself (a refused request, a lost connection); one the stream reported is
 * kept. What the run left for the person stays: questions, the failure, the
 * turn's text, and a batch's plan with its items' failures.
 */
export function endGenerationRun(
  conversationId: string,
  outcome: { stopped?: boolean; failure?: GenerationRunFailure | null } = {},
): void {
  update(conversationId, (run) => ({
    ...run,
    running: false,
    phase: null,
    phaseDraftId: null,
    draftPhases: IDLE_GENERATION_RUN.draftPhases,
    framesRequests: IDLE_GENERATION_RUN.framesRequests,
    discardedDraftIds: IDLE_GENERATION_RUN.discardedDraftIds,
    stopped: outcome.stopped === true,
    failure: outcome.failure ?? run.failure,
  }));
}

/**
 * Drop the turn shown for the last run, once the conversation's stored
 * messages hold it (or it was never stored).
 */
export function clearGenerationPendingTurn(conversationId: string): void {
  update(conversationId, (run) =>
    run.running ? run : { ...run, pendingTurn: null },
  );
}

/** Dismiss the last run's failure notice. */
export function dismissGenerationFailure(conversationId: string): void {
  update(conversationId, (run) => ({ ...run, failure: null }));
}

/** Forget a request for review sheets once it was answered or cannot be. */
export function clearGenerationFramesRequest(
  conversationId: string,
  request: GenerationFramesRequest,
): void {
  update(conversationId, (run) =>
    run.framesRequests.some(
      ({ draftId, version }) =>
        draftId === request.draftId && version === request.version,
    )
      ? {
          ...run,
          framesRequests: run.framesRequests.filter(
            ({ draftId, version }) =>
              draftId !== request.draftId || version !== request.version,
          ),
        }
      : run,
  );
}

/**
 * Forget what a conversation's run holds about a draft the person discarded:
 * its step, its failure and its request for sheets. While the run is in
 * flight the draft is also remembered as discarded, so the run's later
 * events about it change nothing. Every other draft's state stays as it is.
 */
export function forgetGenerationRunDraft(
  conversationId: string,
  draftId: string,
): void {
  // A conversation no run has touched has nothing to forget.
  if (!useGenerationStore.getState().runs[conversationId]) return;
  update(conversationId, (run) => ({
    ...run,
    phaseDraftId: run.phaseDraftId === draftId ? null : run.phaseDraftId,
    draftPhases: without(run.draftPhases, draftId),
    itemFailures: without(run.itemFailures, draftId),
    framesRequests: withoutFramesOf(run.framesRequests, draftId),
    discardedDraftIds:
      run.running && !run.discardedDraftIds.includes(draftId)
        ? [...run.discardedDraftIds, draftId]
        : run.discardedDraftIds,
  }));
}

/** Forget a deleted conversation's transient state. */
export function forgetGenerationRun(conversationId: string): void {
  useGenerationStore.setState(({ runs }) => ({
    runs: Object.fromEntries(
      Object.entries(runs).filter(([id]) => id !== conversationId),
    ),
  }));
}

// A run's text and failures belong to the session that started it.
registerPrivateStateReset(() => useGenerationStore.setState({ runs: {} }));

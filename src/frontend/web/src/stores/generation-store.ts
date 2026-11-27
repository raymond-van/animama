import { create } from "zustand";
import type { PyGenerationAnswers } from "@animama/runtime-contracts/api-types";

import { registerPrivateStateReset } from "@/app/runtime/private-module-state";
import type { PendingGenerationQuestions } from "@/ui/generate/generationDrafts";
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
  phase: GenerationRunPhase | null;
  /** The draft the phase is about, once the run names one. */
  phaseDraftId: string | null;
  pendingTurn: GenerationPendingTurn | null;
  /** Questions the last run ended on, until the next run starts. */
  questions: PendingGenerationQuestions | null;
  failure: GenerationRunFailure | null;
  /** Review sheets the run in flight is waiting for. */
  framesRequest: { draftId: string; version: number } | null;
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
};

/** The state of a conversation no run has touched in this session. */
export const IDLE_GENERATION_RUN: GenerationRunState = Object.freeze({
  running: false,
  runId: null,
  phase: null,
  phaseDraftId: null,
  pendingTurn: null,
  questions: null,
  failure: null,
  framesRequest: null,
  usage: null,
  draftStored: false,
  stopped: false,
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
 * The drafts the run in flight is working on: the one its request revises,
 * and the one its current step names (a new draft, once it is written).
 * Discarding one of them would end the run as a failure, so the page holds
 * that action until the run has ended. Empty when no run is in flight.
 */
export function generationRunDraftIds(
  run: Pick<GenerationRunState, "running" | "phaseDraftId" | "pendingTurn">,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!run.running) return ids;
  if (run.pendingTurn?.draftId) ids.add(run.pendingTurn.draftId);
  if (run.phaseDraftId) ids.add(run.phaseDraftId);
  return ids;
}

/**
 * The review sheets a conversation's run is waiting for. Read by itself, so
 * its reader does not render again for every piece of streamed text.
 */
export function useGenerationFramesRequest(
  conversationId: string | null,
): GenerationRunState["framesRequest"] {
  return useGenerationStore(
    (state) =>
      (conversationId ? state.runs[conversationId]?.framesRequest : null) ??
      null,
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

/** What one stream event changes in a run's state. Events of other kinds change nothing. */
export function reduceGenerationRunEvent(
  run: GenerationRunState,
  event: GenerationRunEvent,
  request: GenerationRunRequest,
): GenerationRunState {
  switch (event.type) {
    case "run.started":
      return { ...run, runId: event.runId };
    case "progress":
      return event.phase
        ? { ...run, phase: event.phase, phaseDraftId: event.draftId }
        : run;
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
      return {
        ...run,
        framesRequest: { draftId: event.draftId, version: event.version },
      };
    case "draft.updated": {
      // The run moved on from the version it asked sheets for.
      const movedOn =
        run.framesRequest?.draftId === event.draft.id &&
        (event.draft.version !== run.framesRequest.version ||
          event.draft.status !== "checking");
      // The backend sends a draft only once it is stored.
      if (!movedOn && run.draftStored) return run;
      return {
        ...run,
        draftStored: true,
        framesRequest: movedOn ? null : run.framesRequest,
      };
    }
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
 * turn's text.
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
    framesRequest: null,
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
  request: { draftId: string; version: number },
): void {
  update(conversationId, (run) =>
    run.framesRequest?.draftId === request.draftId &&
    run.framesRequest.version === request.version
      ? { ...run, framesRequest: null }
      : run,
  );
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

import type {
  PyGenerationConversationSnapshot,
  PyGenerationDraft,
  PyGenerationMessage,
} from "@animama/runtime-contracts/api-types";

import { isRecord } from "@/lib/records";
import type { GenerationRunState } from "@/stores/generation-store";
import {
  parseGenerationQuestions,
  type GenerationQuestion,
} from "./generationDrafts";
import {
  storedGenerationReferences,
  storedImagesSent,
  type GenerationRunReferences,
} from "./references/generationReferences";

/**
 * A conversation as the page shows it: its stored turns, then the turn of
 * the run in flight. A stored turn's `data` is read tolerantly, since its
 * fields are the backend's to extend.
 */

/** How a run ended, as its assistant turn records it. */
export type GenerationTurnOutcome =
  | "draft"
  | "questions"
  | "reply"
  | "failed"
  | "stopped";

const OUTCOMES: ReadonlySet<string> = new Set<GenerationTurnOutcome>([
  "draft",
  "questions",
  "reply",
  "failed",
  "stopped",
]);

export type GenerationTranscriptEntry = {
  /** Stable for a stored turn; `pending:user` and `pending:assistant` for the run in flight. */
  id: string;
  role: "user" | "assistant";
  text: string;
  /** The turn belongs to the run in flight and is not stored yet. */
  pending: boolean;
  /** The draft the person's turn revised, or the assistant's turn produced. */
  draftId: string | null;
  /** An assistant turn: how its run ended; `null` when it does not say. */
  outcome: GenerationTurnOutcome | null;
  /** An assistant turn that asked instead of writing: its questions. */
  questions: GenerationQuestion[];
  /**
   * A person's turn that answered questions: `skipped`, or the answers given.
   * `null` for an ordinary request.
   */
  answers: {
    skipped: boolean;
    answers: { question: string; answer: string }[];
  } | null;
  /** A failed run's code, for wording with `describeGenerationFailure`'s area. */
  errorCode: string | null;
  /** An assistant turn: the run that stored it; `null` when it does not say. */
  runId: string | null;
  /** An assistant turn of a batch: the drafts its plan made, kept or not. */
  batchDraftIds: string[];
  /**
   * A person's turn: the Library Gestures and images it carried, for display;
   * `null` when it carried none.
   */
  references: GenerationRunReferences | null;
  /** `false` when the run's model took none of the turn's images. */
  imagesSent: boolean;
};

function storedEntry(message: PyGenerationMessage): GenerationTranscriptEntry {
  const data = isRecord(message.data) ? message.data : {};
  const answers = isRecord(data.answers) ? data.answers : null;
  const error = isRecord(data.error) ? data.error : null;
  const person = message.role !== "assistant";
  return {
    id: message.id,
    role: message.role === "assistant" ? "assistant" : "user",
    text: message.text,
    pending: false,
    draftId:
      typeof data.draft_id === "string" && data.draft_id ? data.draft_id : null,
    outcome:
      typeof data.outcome === "string" && OUTCOMES.has(data.outcome)
        ? (data.outcome as GenerationTurnOutcome)
        : null,
    questions: parseGenerationQuestions(data.questions),
    answers: answers && {
      skipped: answers.skipped === true,
      answers: Array.isArray(answers.answers)
        ? answers.answers.flatMap((entry) =>
            isRecord(entry) &&
            typeof entry.question === "string" &&
            typeof entry.answer === "string"
              ? [{ question: entry.question, answer: entry.answer }]
              : [],
          )
        : [],
    },
    errorCode: typeof error?.code === "string" ? error.code : null,
    runId:
      message.role === "assistant" &&
      typeof data.run_id === "string" &&
      data.run_id
        ? data.run_id
        : null,
    batchDraftIds: Array.isArray(data.batch)
      ? data.batch.flatMap((item) =>
          isRecord(item) && typeof item.draft_id === "string"
            ? [item.draft_id]
            : [],
        )
      : [],
    references: person ? storedGenerationReferences(data) : null,
    imagesSent: !person || storedImagesSent(data),
  };
}

/**
 * Whether the failed run kept a draft: one that holds a project arrived on
 * its stream, or the turn that run stored names a draft, which the backend
 * does only for a draft the run left changed. Such a failure is not offered
 * again, since the draft is there, checked or awaiting its check.
 *
 * A draft with nothing written is not one the run kept. A batch that a
 * failure ended before any item was written leaves only such drafts (or
 * none), and its request can be sent again. `drafts` are the conversation's
 * drafts as last read: given them, the turn counts only when a draft it
 * names, or one of its batch, holds a project. Without them the turn's word
 * is taken.
 *
 * The conversation's last turn counts only when it is this run's own
 * (`run_id`). A request that never reached the backend stored no turn, so
 * the last turn is then the run before's, and says nothing about this one:
 * with no stream event there is no run id, and the failure can be retried.
 */
export function failedRunStoredDraft(
  run: Pick<GenerationRunState, "draftStored" | "runId">,
  entries: readonly GenerationTranscriptEntry[],
  drafts?: readonly Pick<PyGenerationDraft, "id" | "project">[],
): boolean {
  if (run.draftStored) return true;
  const last = entries.at(-1);
  if (
    run.runId === null ||
    last?.role !== "assistant" ||
    last.pending ||
    last.runId !== run.runId ||
    last.outcome !== "failed" ||
    last.draftId === null
  ) {
    return false;
  }
  if (drafts === undefined) return true;
  const named = new Set([last.draftId, ...last.batchDraftIds]);
  return drafts.some((draft) => named.has(draft.id) && draft.project !== null);
}

/**
 * The turns to show: the stored ones in order, then the run in flight's
 * request and the assistant's text so far. The pending turn is left out as
 * far as the stored conversation already holds it, so a turn never shows
 * twice while the page catches up with what the server stored.
 */
export function generationTranscript(
  snapshot: Pick<PyGenerationConversationSnapshot, "messages"> | undefined,
  run: Pick<GenerationRunState, "running" | "pendingTurn">,
): GenerationTranscriptEntry[] {
  const messages = snapshot?.messages ?? [];
  const entries = messages.map(storedEntry);
  const pending = run.pendingTurn;
  if (!pending) return entries;

  const last = messages.at(-1);
  const before = messages.at(-2);
  // The run ended and its two turns were read: nothing is pending any more.
  if (
    !run.running &&
    last?.role === "assistant" &&
    before?.role === "user" &&
    before.text === pending.message
  )
    return entries;
  // The server stores the person's turn when the run starts; a read during
  // the run already holds it.
  const requestStored = last?.role === "user" && last.text === pending.message;
  const pendingEntry = (
    role: GenerationTranscriptEntry["role"],
    text: string,
    draftId: string | null,
    references: GenerationRunReferences | null = null,
  ): GenerationTranscriptEntry => ({
    id: `pending:${role}`,
    role,
    text,
    pending: true,
    draftId,
    outcome: null,
    questions: [],
    answers: null,
    errorCode: null,
    runId: null,
    batchDraftIds: [],
    references,
    imagesSent: true,
  });
  return [
    ...entries,
    ...(requestStored
      ? []
      : [
          pendingEntry(
            "user",
            pending.message,
            pending.draftId,
            pending.references ?? null,
          ),
        ]),
    pendingEntry("assistant", pending.text, null),
  ];
}

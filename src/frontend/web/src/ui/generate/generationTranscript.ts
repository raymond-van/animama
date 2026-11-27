import type {
  PyGenerationConversationSnapshot,
  PyGenerationMessage,
} from "@animama/runtime-contracts/api-types";

import { isRecord } from "@/lib/records";
import type { GenerationRunState } from "@/stores/generation-store";
import {
  parseGenerationQuestions,
  type GenerationQuestion,
} from "./generationDrafts";

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
};

function storedEntry(message: PyGenerationMessage): GenerationTranscriptEntry {
  const data = isRecord(message.data) ? message.data : {};
  const answers = isRecord(data.answers) ? data.answers : null;
  const error = isRecord(data.error) ? data.error : null;
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
  };
}

/**
 * Whether the failed run had already stored its draft: one arrived on its
 * stream, or the turn it stored (the conversation's last) names a draft,
 * which the backend does only for a draft the run left changed. Such a
 * failure is not offered again, since the draft is there, checked or
 * awaiting its check.
 */
export function failedRunStoredDraft(
  run: Pick<GenerationRunState, "draftStored">,
  entries: readonly GenerationTranscriptEntry[],
): boolean {
  if (run.draftStored) return true;
  const last = entries.at(-1);
  return (
    last?.role === "assistant" &&
    !last.pending &&
    last.outcome === "failed" &&
    last.draftId !== null
  );
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
  });
  return [
    ...entries,
    ...(requestStored
      ? []
      : [pendingEntry("user", pending.message, pending.draftId)]),
    pendingEntry("assistant", pending.text, null),
  ];
}

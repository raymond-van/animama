import type {
  PyGenerationConversationSnapshot,
  PyGenerationDraft,
  PyGenerationMessage,
} from "@animama/runtime-contracts/api-types";
import {
  REACTION_INTENSITIES,
  type EmotionReactionIntensity,
} from "@/lib/avatar/reactionPools";
import { TRACKED_EMOTIONS, type TrackedEmotion } from "@/lib/emotion";
import { isRecord } from "@/lib/records";
import {
  hasGenerationReferences,
  storedGenerationReferences,
  type GenerationRunReferences,
} from "./references/generationReferences";

/**
 * Readers of the content assistant's stored resources. Drafts, messages and
 * reports come from a backend whose shapes may still move, and a draft's
 * project was written by a model, so every reader tolerates missing and
 * malformed fields instead of trusting the generated types.
 */

/** One question the assistant asked, with the answers it offers (recommended first). */
export type GenerationQuestion = { question: string; options: string[] };

/** The questions a run ended on, and the request they were about. */
export type PendingGenerationQuestions = {
  questions: GenerationQuestion[];
  /** Sent again, with the answers, by the run that answers them. */
  request: {
    message: string;
    draftId: string | null;
    /** The kind the request asked for, where the turn recorded one. */
    intent?: "gesture" | "reaction";
    /** The references the request carried, which the answering run names again. */
    references?: GenerationRunReferences;
  };
};

/** Read a `questions` payload; entries without question text are dropped. */
export function parseGenerationQuestions(value: unknown): GenerationQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.question !== "string") return [];
    const question = entry.question.trim();
    if (!question) return [];
    const options = Array.isArray(entry.options)
      ? entry.options.filter(
          (option): option is string =>
            typeof option === "string" && option.trim() !== "",
        )
      : [];
    return [{ question, options }];
  });
}

/**
 * One item of a batch: a request that asked for several items is planned as
 * up to ten, each with its own draft. The run's stream names them when the
 * plan is made, and the run's stored assistant turn keeps them
 * (`data.batch`), so a draft's brief can be shown during the run and after a
 * reload.
 */
export type GenerationBatchItem = {
  /** The item's draft. A stop removes the draft of an item it had not written. */
  draftId: string;
  intent: "gesture" | "reaction";
  /** What the item is to be, in the assistant's words; empty when none was sent. */
  brief: string;
  /**
   * Why the item failed on a model error or an internal failure, as its
   * stored turn records it. Always `null` on the stream, where a failure
   * arrives as its own event.
   */
  error: { code: string; category: string | null } | null;
};

/**
 * Read a batch's items, from the stream's plan or a stored turn. An entry
 * that names no draft cannot be placed and is dropped, as is a second entry
 * for the same draft; a missing brief is empty and an unknown kind is a
 * Gesture, as for a draft.
 */
export function parseGenerationBatch(value: unknown): GenerationBatchItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry): GenerationBatchItem[] => {
    if (!isRecord(entry)) return [];
    const draftId = entry.draft_id;
    if (typeof draftId !== "string" || !draftId || seen.has(draftId)) return [];
    seen.add(draftId);
    const error = isRecord(entry.error) ? entry.error : null;
    return [
      {
        draftId,
        intent: entry.intent === "reaction" ? "reaction" : "gesture",
        brief: typeof entry.brief === "string" ? entry.brief.trim() : "",
        error:
          typeof error?.code === "string" && error.code
            ? {
                code: error.code,
                category:
                  typeof error.category === "string" && error.category
                    ? error.category
                    : null,
              }
            : null,
      },
    ];
  });
}

/** How an assistant turn that did no work ended. */
const NO_WORK_OUTCOMES: ReadonlySet<unknown> = new Set(["failed", "stopped"]);

/**
 * The questions a conversation is waiting on, by the backend's own rule, so
 * it holds after a reload and after an answering run that failed or was
 * stopped. Walking back from the end:
 *
 * - the person's turns are passed over;
 * - an assistant turn that carries questions means those are outstanding,
 *   whatever its outcome (a stopped turn can still carry the questions the
 *   page was shown);
 * - an assistant turn that ended `failed` or `stopped` without a draft is an
 *   attempt that did no work, and is passed over;
 * - any other assistant turn ends the walk with nothing outstanding. That
 *   includes a run that stored its draft and then failed or was stopped: the
 *   person's next message is then an ordinary request.
 *
 * The request to send again, with the answers, is the person's turn before
 * the asking one: the original request, never a later attempt at answering.
 */
export function pendingGenerationQuestions(
  snapshot: Pick<PyGenerationConversationSnapshot, "messages"> | undefined,
): PendingGenerationQuestions | null {
  const messages = snapshot?.messages ?? [];
  let index = messages.length - 1;
  for (; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    const data = isRecord(message.data) ? message.data : {};
    // Tested before the outcome, as the backend does.
    if (Array.isArray(data.questions) && data.questions.length > 0) break;
    if (NO_WORK_OUTCOMES.has(data.outcome) && !data.draft_id) continue;
    return null;
  }
  const asking = messages[index];
  if (!asking) return null;
  const questions = parseGenerationQuestions(
    isRecord(asking.data) ? asking.data.questions : undefined,
  );
  if (questions.length === 0) return null;
  const asked = messages
    .slice(0, index)
    .findLast((message: PyGenerationMessage) => message.role === "user");
  if (!asked) return null;
  const data = isRecord(asked.data) ? asked.data : {};
  const draftId = data.draft_id;
  const references = storedGenerationReferences(data);
  return {
    questions,
    request: {
      message: asked.text,
      draftId: typeof draftId === "string" && draftId ? draftId : null,
      // The answering run writes the kind the questions were about.
      ...(data.intent === "reaction" || data.intent === "gesture"
        ? { intent: data.intent }
        : {}),
      ...(hasGenerationReferences(references) ? { references } : {}),
    },
  };
}

/**
 * Whether the page owes the backend a check of this draft: it holds a project
 * at a version nobody checked, and waits in `checking`. True inside a run and
 * outside one (a restored version, or one a stopped run left unchecked).
 */
export function draftAwaitsCheck(
  draft: Pick<
    PyGenerationDraft,
    "project" | "status" | "version" | "checked_version"
  >,
): boolean {
  return (
    draft.project !== null &&
    draft.status === "checking" &&
    draft.checked_version !== draft.version
  );
}

/**
 * Whether a run gave up waiting for this version's checks: the stored report
 * of the draft's current version says only that it was not checked. The
 * draft is then the page's to check once no run is in flight on its
 * conversation (when the conversation is next shown, or on "Check again"),
 * and the backend settles it from that report.
 */
export function draftLeftUnchecked(
  draft: Pick<
    PyGenerationDraft,
    "project" | "version" | "checked_version" | "check_report"
  >,
): boolean {
  return (
    draft.project !== null &&
    draft.checked_version === draft.version &&
    isRecord(draft.check_report) &&
    draft.check_report.unchecked === true
  );
}

/**
 * Whether a message can revise this draft: it has a project to revise. A
 * draft the assistant listed as `failed` before it had one (a write that
 * produced nothing that works) is shown and can be discarded, but the backend
 * refuses a revision of it (`generation_draft_empty`), so the page never
 * makes it the draft the next message revises.
 */
export function draftCanBeRevised(
  draft: Pick<PyGenerationDraft, "project">,
): boolean {
  return draft.project !== null;
}

/**
 * The kind of draft the next message writes: the kind chosen for a new
 * draft, or `null` when the message revises the selected draft (which keeps
 * its own kind) or the composer offers no choice of kind.
 */
export function generationRequestWrites(
  selectedDraft: Pick<PyGenerationDraft, "project"> | null,
  newDraftKind: "gesture" | "reaction" | undefined,
): "gesture" | "reaction" | null {
  return selectedDraft && draftCanBeRevised(selectedDraft)
    ? null
    : (newDraftKind ?? null);
}

/** A draft project's clip as stored: unvalidated, or `null` without a project. */
export function draftSequence(
  draft: Pick<PyGenerationDraft, "project">,
): unknown {
  return isRecord(draft.project) ? (draft.project.sequence ?? null) : null;
}

/** A draft's name for display; empty before it has a project or a name. */
export function draftName(draft: Pick<PyGenerationDraft, "project">): string {
  const name = isRecord(draft.project) ? draft.project.name : null;
  return typeof name === "string" ? name.trim() : "";
}

/**
 * Where a Reaction draft suggests it fits: its emotion and intensity, read
 * from its project. `null` for a Gesture, and for a Reaction whose project
 * names no tracked emotion or no intensity from 1 to 4.
 */
export function draftReactionPlacement(
  draft: Pick<PyGenerationDraft, "project" | "intent">,
): { emotion: TrackedEmotion; intensity: EmotionReactionIntensity } | null {
  if (draft.intent !== "reaction" || !isRecord(draft.project)) return null;
  const emotion = TRACKED_EMOTIONS.find(
    (tracked) => tracked === draft.project!.suggestedEmotion,
  );
  const intensity = REACTION_INTENSITIES.find(
    (level) => level === draft.project!.suggestedIntensity,
  );
  return emotion && intensity ? { emotion, intensity } : null;
}

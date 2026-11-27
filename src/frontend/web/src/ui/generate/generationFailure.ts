import {
  describeChatFailure,
  type ChatFailure,
} from "@animama/product-ui/chat";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import {
  apiErrorText,
  errorWording,
  readApiError,
  type ApiErrorInfo,
  type ApiErrorText,
} from "@/lib/errors/apiError";
import type { GenerationRunFailure } from "@/stores/generation-store";

/**
 * Wording for the content assistant's failures, from their codes.
 *
 * A model, plan or connection failure carries the model client's own code and
 * the details chat's error frame carries, so it reads as it does in chat
 * (`describeChatFailure`). The assistant's own codes (`generation_*`, and the
 * page's for a request that never completed) are worded in the `errors`
 * catalog's `generation` area. Everything here is worded when called, so call
 * it at render and the text follows the UI Locale.
 */

/** Categories of failures that are the assistant's or this page's own. */
const OWN_CATEGORIES = new Set(["generation", "internal", "request"]);

/** The code that words a failure nothing more specific words. */
const FALLBACK_CODE = "generation_run_failed";

export type GenerationFailureText =
  /**
   * A model, plan or connection failure in chat's wording. `failure.copy`
   * holds catalog references for the title, the guidance and any link, which
   * product UI's failure notice (or `chatFailureCopy`) words at render.
   */
  | { source: "model"; code: string; failure: ChatFailure }
  /** The assistant's own failure, as one message with optional technical detail. */
  | {
      source: "assistant";
      code: string;
      message: string;
      detail: string | null;
    };

/**
 * The assistant's own failures that another model may not meet: the model or
 * the effort was refused, or the model produced no draft that works.
 */
const MODEL_DEPENDENT_CODES = new Set([
  "generation_model_unusable",
  "generation_reasoning_effort_unsupported",
  "generation_no_valid_draft",
]);

/**
 * Refusals that say why in a `reason`: a model that cannot be used, and a
 * creator's document that cannot be worked on (its details, or its timeline).
 * The reason is worded before the general code.
 */
const REASONED_CODES: ReadonlySet<string> = new Set([
  "generation_model_unusable",
  "generation_document_invalid",
]);

/**
 * Whether a failure is one that choosing another model could get past (R2.4):
 * any model, plan or connection failure, and the assistant's own failures
 * that depend on the model. A request that never arrived, a stream that
 * broke or a conversation that is gone are not.
 */
export function generationFailureSuggestsAnotherModel(
  described: GenerationFailureText,
): boolean {
  return (
    described.source === "model" || MODEL_DEPENDENT_CODES.has(described.code)
  );
}

function ownFailureText(info: ApiErrorInfo): ApiErrorText {
  // A refused model says why; that reason is worded before the general code.
  const reasoned =
    info.code && REASONED_CODES.has(info.code) && info.reason
      ? errorWording("generation", `${info.code}_${info.reason}`)
      : null;
  if (reasoned) return { message: reasoned, detail: null };
  return apiErrorText(
    info,
    "generation",
    errorWording("generation", FALLBACK_CODE) ?? undefined,
  );
}

/** Word a failed run for the conversation's failure notice. */
export function describeGenerationFailure(
  failure: GenerationRunFailure,
): GenerationFailureText {
  const own =
    failure.code.startsWith("generation_") ||
    (failure.category !== null && OWN_CATEGORIES.has(failure.category));
  if (!own) {
    const chat = describeChatFailure(
      { code: failure.code, details: failure.details },
      failure.request.message,
    );
    // A code chat does not word either reads as the assistant's general failure.
    if (chat.copy && !chat.copy.title.key.startsWith("chatFailure.unknown"))
      return { source: "model", code: failure.code, failure: chat };
  }
  const text = ownFailureText({
    status: failure.status,
    code: own ? failure.code : FALLBACK_CODE,
    reason: failure.reason,
    field: null,
    params: {},
    message: null,
  });
  return { source: "assistant", code: failure.code, ...text };
}

/**
 * Word a failed action on a conversation or draft (restore, discard, delete,
 * record a save): the error a `useGenerationMutations` mutation rejected with.
 */
export function describeGenerationActionFailure(error: unknown): ApiErrorText {
  return ownFailureText(readApiError(error));
}

/**
 * Why a draft is `failed`, from its `failure_reason`; `null` for a draft that
 * did not fail. A reason this page does not know reads as the general failure.
 */
export function draftFailureText(
  draft: Pick<PyGenerationDraft, "status" | "failure_reason">,
): string | null {
  if (draft.status !== "failed") return null;
  return (
    (draft.failure_reason
      ? errorWording("generation", draft.failure_reason)
      : null) ?? errorWording("generation", FALLBACK_CODE)
  );
}

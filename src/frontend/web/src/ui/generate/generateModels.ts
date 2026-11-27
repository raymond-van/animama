import type { PyModelProviderCatalogItem } from "@animama/runtime-contracts/api-types";

import {
  CHATGPT_PLAN_PROVIDER_TYPE,
  chatModelUnusableReason,
  isChatModelRow,
} from "@/lib/chat/model-catalog";

/**
 * Which catalog models the content assistant may use. The assistant writes
 * through function tools and streams its replies, so it needs a chat model
 * that calls tools, streams, has room for a pass in its context window, and
 * that chat itself could use. The backend checks the same when a run starts
 * (its `model_unusable_reason`, which asks chat's own validator) and never
 * uses another model instead (`generation_model_unusable`), so a model it
 * would refuse cannot be chosen: the pickers list it disabled, with the
 * reason. The catalog lists only active models on active connections, which
 * is the rest of the backend's rule.
 */

/**
 * The smallest recorded context window the assistant's model may have, in
 * tokens. A pass sends 16,000 to 24,000 tokens and its tool rounds send the
 * clip again. The backend refuses a smaller one by the same figure (its
 * `MIN_CONTEXT_WINDOW_TOKENS`). `fixtures/model-requirements.json` records
 * the value for the parity tests that keep this constant and the backend's
 * equal: change all three together.
 */
export const MIN_GENERATION_CONTEXT_WINDOW_TOKENS = 64_000;

/** Why the assistant cannot use a catalog model. */
export type GenerationModelIneligibility =
  /** An embedding model. */
  | "not_chat_model"
  /** The owner hid it from pickers in App Settings. */
  | "hidden"
  /** It cannot call tools. */
  | "tools_unsupported"
  /** It cannot stream its replies. */
  | "streaming_unsupported"
  /** Chat cannot use it either: the app has no API to talk to it with. */
  | "chat_unsupported"
  /** Chat cannot use it either: the owner's own model has no context window yet. */
  | "context_window_missing"
  /** Its recorded context window has no room for the assistant's passes. */
  | "context_too_small";

type ModelRow = Pick<
  PyModelProviderCatalogItem,
  | "id"
  | "model_provider"
  | "model_kind"
  | "hidden"
  | "supports_tools"
  | "supports_streaming"
  | "api_standard"
  | "source"
  | "context_window_tokens"
>;

/** Why the assistant cannot use this model, or `null` when it can. */
export function generationModelIneligibility(
  item: Omit<ModelRow, "id" | "model_provider">,
): GenerationModelIneligibility | null {
  if (!isChatModelRow(item as PyModelProviderCatalogItem))
    return "not_chat_model";
  if (item.hidden) return "hidden";
  if (item.supports_tools !== true) return "tools_unsupported";
  if (item.supports_streaming !== true) return "streaming_unsupported";
  // The window before chat's other rules, in the backend's order.
  if (item.source === "owner" && item.context_window_tokens == null)
    return "context_window_missing";
  if (
    item.context_window_tokens != null &&
    item.context_window_tokens < MIN_GENERATION_CONTEXT_WINDOW_TOKENS
  )
    return "context_too_small";
  // The rule the chat's model picker disables rows by.
  switch (chatModelUnusableReason(item as PyModelProviderCatalogItem)) {
    case "unsupported":
      return "chat_unsupported";
    case "needs_context_window":
      return "context_window_missing";
    case null:
      return null;
  }
}

/** Whether a model runs on the owner's ChatGPT plan. */
export function isChatGPTPlanModel(
  item: Pick<ModelRow, "model_provider">,
): boolean {
  return item.model_provider === CHATGPT_PLAN_PROVIDER_TYPE;
}

/**
 * The models the assistant offers: every eligible one, the ChatGPT plan's
 * first and otherwise in catalog order.
 */
export function eligibleGenerationModels<T extends ModelRow>(
  items: readonly T[],
): T[] {
  const eligible = items.filter(
    (item) => generationModelIneligibility(item) === null,
  );
  return [
    ...eligible.filter(isChatGPTPlanModel),
    ...eligible.filter((item) => !isChatGPTPlanModel(item)),
  ];
}

/** A model as the assistant's pickers list it. */
export type ListedGenerationModel<T> = {
  item: T;
  /** Why it cannot be chosen; `null` for a model the assistant may use. */
  unavailable: Exclude<
    GenerationModelIneligibility,
    "not_chat_model" | "hidden"
  > | null;
};

/**
 * Every model the assistant's pickers show (R2.2): each visible chat model,
 * the ones that can be chosen first (as `eligibleGenerationModels` orders
 * them) and then, in catalog order, the ones that cannot, each with its
 * reason. Embedding models and models the owner hid are not shown at all.
 */
export function listedGenerationModels<T extends ModelRow>(
  items: readonly T[],
): ListedGenerationModel<T>[] {
  const unavailable = items.flatMap((item): ListedGenerationModel<T>[] => {
    const reason = generationModelIneligibility(item);
    return reason === null || reason === "not_chat_model" || reason === "hidden"
      ? []
      : [{ item, unavailable: reason }];
  });
  return [
    ...eligibleGenerationModels(items).map((item) => ({
      item,
      unavailable: null,
    })),
    ...unavailable,
  ];
}

/**
 * The assistant's model: the saved choice while the assistant can still use
 * it, else `null`, which means setup. No other model stands in for a saved
 * choice that was removed, hidden or signed out of.
 */
export function chosenGenerationModel<T extends ModelRow>(
  items: readonly T[],
  savedId: string | null | undefined,
): T | null {
  if (!savedId) return null;
  const saved = items.find((item) => item.id === savedId);
  return saved && generationModelIneligibility(saved) === null ? saved : null;
}

/**
 * Whether a model looks at images. A text-only model writes and repairs
 * drafts but skips the review of rendered frames.
 */
export function generationModelReviewsFrames(
  item: Pick<PyModelProviderCatalogItem, "accepts">,
): boolean {
  return item.accepts?.includes("image") === true;
}

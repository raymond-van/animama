import type { PyModelProviderCatalogItem } from "@animama/runtime-contracts/api-types";

import {
  CHATGPT_PLAN_PROVIDER_TYPE,
  chatModelUnusableReason,
  isChatModelRow,
} from "@/lib/chat/model-catalog";

/**
 * Which catalog models the content assistant may use. The assistant writes
 * through function tools and streams its replies, so it needs a chat model
 * that calls tools, streams, and that chat itself could use. The backend
 * checks the same when a run starts (`model_unusable_reason`, which asks
 * chat's own validator) and never uses another model instead
 * (`generation_model_unusable`), so a model it would refuse is not listed.
 * The catalog lists only active models on active connections, which is the
 * rest of the backend's rule.
 */

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
  | "context_window_missing";

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

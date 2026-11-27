import type { TFunction } from "i18next";
import { getI18n } from "react-i18next";
import type { PyModelProviderCatalogItem } from "@animama/runtime-contracts/api-types";
import {
  ANTHROPIC_MESSAGES_PROVIDER_TYPE,
  chatModelSendGate,
} from "@animama/product-ui/chat";

/** Defined once in product-ui, whose web search rule also reads it. */
export { ANTHROPIC_MESSAGES_PROVIDER_TYPE };

type LabeledModel = Pick<
  PyModelProviderCatalogItem,
  "model" | "model_label" | "provider_label"
> &
  Partial<
    Pick<
      PyModelProviderCatalogItem,
      "connection_id" | "connection_name" | "model_provider"
    >
  >;

/**
 * The connection a model runs on, so pickers group its models together. The
 * ChatGPT plan's connection is named in the UI Locale, as App Settings does.
 */
export function modelConnectionLabel(item: LabeledModel): string {
  if (item.model_provider === CHATGPT_PLAN_PROVIDER_TYPE) {
    const t = getI18n().getFixedT(null, "models");
    return t("providers.chatgptPlan");
  }
  return (
    item.connection_name?.trim() ||
    item.provider_label?.trim() ||
    item.model_provider ||
    ""
  );
}

/** The built-in OpenAI connection, whose models run on an API key. */
const BUILTIN_OPENAI_CONNECTION_ID = "openai";

/**
 * How an OpenAI model is used, where pickers must tell the two apart: through
 * the owner's ChatGPT plan or on the built-in connection's API key. Null for
 * every other model.
 */
export function openaiModelAccess(item: LabeledModel): "plan" | "key" | null {
  if (item.model_provider === CHATGPT_PLAN_PROVIDER_TYPE) return "plan";
  if (item.connection_id === BUILTIN_OPENAI_CONNECTION_ID) return "key";
  return null;
}

/**
 * Whether a picker lists ChatGPT plan models, so it must tell OpenAI's two
 * ways apart. Never true in the hosted composition, nor before a sign-in.
 */
export function listsChatGPTPlanModels(
  items: readonly LabeledModel[],
): boolean {
  return items.some((item) => openaiModelAccess(item) === "plan");
}

/**
 * The heading of a model's group in the chat picker: its connection. With
 * `splitOpenAI` (the picker lists plan models), OpenAI's two ways read
 * "OpenAI · ChatGPT plan" and "OpenAI · API key".
 */
export function modelPickerGroupLabel(
  item: LabeledModel,
  splitOpenAI: boolean,
): string {
  const t = getI18n().getFixedT(null, "models");
  const access = splitOpenAI ? openaiModelAccess(item) : null;
  if (access === "plan") return t("picker.openaiPlan");
  if (access === "key") return t("picker.openaiKey");
  return modelConnectionLabel(item);
}

/**
 * The chat picker's groups: models by `modelPickerGroupLabel` in catalog
 * order. Where the picker lists plan models, OpenAI's two ways (ChatGPT plan,
 * then API key) sit side by side; otherwise OpenAI's models keep one group.
 */
export function pickerModelGroups<T extends LabeledModel>(
  items: readonly T[],
): { providerLabel: string; models: T[] }[] {
  const splitOpenAI = listsChatGPTPlanModels(items);
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = modelPickerGroupLabel(item, splitOpenAI);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const list = Array.from(groups, ([providerLabel, models]) => ({
    providerLabel,
    models,
  }));
  const access = (group: (typeof list)[number]) =>
    group.models[0] ? openaiModelAccess(group.models[0]) : null;
  const plan = list.findIndex((group) => access(group) === "plan");
  if (plan < 0 || !list.some((group) => access(group) === "key")) return list;
  const [planGroup] = list.splice(plan, 1);
  list.splice(
    list.findIndex((group) => access(group) === "key"),
    0,
    planGroup,
  );
  return list;
}

/**
 * The line under a model's name in pickers: its connection. With
 * `splitOpenAI` (the picker lists plan models), OpenAI's models say which way
 * they are used, "ChatGPT plan" or "API key". The app picks the API, so
 * pickers never name it; a model's Info panel in App Settings does.
 */
export function modelOptionDetail(
  item: LabeledModel,
  splitOpenAI = false,
): string {
  if (splitOpenAI && openaiModelAccess(item) === "key") {
    // Called through `t` so the catalog extractor finds the key.
    const t = getI18n().getFixedT(null, "models");
    return t("picker.apiKey");
  }
  return modelConnectionLabel(item);
}

/** The `chat` translator for the active UI Locale, for callers without a hook. */
function activeChatT(): TFunction<"chat"> {
  return getI18n().getFixedT(null, "chat");
}

function connectionModelLabel(
  connection: string,
  model: string,
  t: TFunction<"chat"> = activeChatT(),
): string {
  return t("model.optionLabel", { connection, model });
}

function alternateModelName(
  name: string,
  t: TFunction<"chat"> = activeChatT(),
): string {
  return t("model.alternate", { name });
}

/**
 * "Connection: Model", falling back to the model id when labels are missing.
 * Connection and model names are shown as configured; only the format follows
 * the UI Locale.
 */
export function modelOptionLabel(
  item: LabeledModel,
  alternate = false,
  t?: TFunction<"chat">,
): string {
  const model = modelDisplayName(item, alternate, t);
  const connection = modelConnectionLabel(item);
  return connection ? connectionModelLabel(connection, model, t) : model;
}

/**
 * A model's shown name, with a neutral "(alternate)" marker telling apart two
 * listed rows with one name. Display only; never use it as an identifier.
 */
export function modelDisplayName(
  item: Pick<LabeledModel, "model" | "model_label">,
  alternate = false,
  t?: TFunction<"chat">,
): string {
  const name = item.model_label?.trim() || item.model;
  return alternate ? alternateModelName(name, t) : name;
}

/**
 * API families a catalog row uses (`model_provider` on catalog items,
 * `provider_type` on configured models). The app picks the family: OpenAI
 * Responses on the built-in OpenAI connection, Anthropic Messages on the
 * built-in Anthropic connection and Chat Completions everywhere else.
 */
export const RESPONSES_PROVIDER_TYPE = "OpenAIResponsesHTTPAgent";
export const CHAT_COMPLETIONS_PROVIDER_TYPE = "OpenAIHTTPAgent";
/** Models the signed-in ChatGPT plan lists: OpenAI Responses through the plan (spec #919). */
export const CHATGPT_PLAN_PROVIDER_TYPE = "ChatGPTPlanResponsesHTTPAgent";
export type ModelProviderType =
  | typeof RESPONSES_PROVIDER_TYPE
  | typeof CHAT_COMPLETIONS_PROVIDER_TYPE
  | typeof ANTHROPIC_MESSAGES_PROVIDER_TYPE;

/** A stored provider type as one of the known API families (Chat Completions otherwise). */
export function modelProviderType(
  value: string | null | undefined,
): ModelProviderType {
  return value === RESPONSES_PROVIDER_TYPE ||
    value === ANTHROPIC_MESSAGES_PROVIDER_TYPE
    ? value
    : CHAT_COMPLETIONS_PROVIDER_TYPE;
}

/** The built-in Anthropic connection's default model, Claude Haiku 5.5. */
export const ANTHROPIC_DEFAULT_MODEL_ID =
  "AnthropicMessagesHTTPAgent:claude-haiku-5-5";

/** Fields shared by catalog items and configured models that naming needs. */
type AlternateCandidate = {
  id: string;
  model: string;
  model_label?: string | null;
  connection_id?: string | null;
  model_kind?: string | null;
  /** Catalog items name the API here… */
  model_provider?: string | null;
  /** …and configured models here. */
  provider_type?: string | null;
};

/**
 * Ids of listed chat rows that need the alternate suffix: when rows on one
 * connection share a name (the built-in OpenAI connection can list a model
 * once per API), every row but the Responses one is marked. Without a
 * Responses row among them, rows after the first are marked. Pass only the
 * rows the list shows, so a hidden twin does not rename a visible row. No API
 * is named, because the app picks it.
 */
export function alternateModelIds(
  rows: readonly AlternateCandidate[],
): Set<string> {
  const groups = new Map<string, AlternateCandidate[]>();
  for (const row of rows) {
    if ((row.model_kind ?? "chat") !== "chat") continue;
    const key = `${row.connection_id ?? ""}\u0000${modelDisplayName(row)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const alternates = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const primary =
      group.find(
        (row) =>
          (row.model_provider ?? row.provider_type) === RESPONSES_PROVIDER_TYPE,
      ) ?? group[0];
    for (const row of group) if (row !== primary) alternates.add(row.id);
  }
  return alternates;
}

/** A row's reasoning efforts in the backend's display order. */
export function supportedReasoningEfforts(
  item: PyModelProviderCatalogItem | null | undefined,
): string[] {
  return Array.isArray(item?.supported_reasoning_efforts)
    ? item.supported_reasoning_efforts.filter(
        (effort) => typeof effort === "string",
      )
    : [];
}

/**
 * The effort a picker preselects for a row: the backend's reported default
 * (Anthropic rows report their chat default, `medium`) when the row offers
 * it, else the row's first supported effort. `null` for rows without efforts.
 */
export function defaultReasoningEffort(
  item: PyModelProviderCatalogItem | null | undefined,
): string | null {
  const efforts = supportedReasoningEfforts(item);
  const reported = item?.default_reasoning_effort;
  if (reported && efforts.includes(reported)) return reported;
  return efforts[0] ?? null;
}

/**
 * The effort a chat turn uses for a row: the Anima's saved effort
 * (`chat_profile.reasoning_effort`) while the row offers it, else the row's
 * default preselection. `null` for rows without efforts.
 */
export function effectiveReasoningEffort(
  item: PyModelProviderCatalogItem | null | undefined,
  saved: string | null | undefined,
): string | null {
  if (saved && supportedReasoningEfforts(item).includes(saved)) return saved;
  return defaultReasoningEffort(item);
}

/** Chat rows; rows from before model kinds existed count as chat. */
export function isChatModelRow(item: PyModelProviderCatalogItem): boolean {
  return (item.model_kind ?? "chat") === "chat";
}

/** Why chat cannot use a listed chat model. */
export type ChatModelUnusableReason =
  /** The app has no API to talk to it with. */
  | "unsupported"
  /** The owner's own model has no context window set yet. */
  | "needs_context_window";

/**
 * Why chat cannot use a listed chat model, or `null` when it can. The chat's
 * model picker disables such a row and says why, and the content assistant
 * does not list it. The backend refuses such a model when a chat turn or an
 * assistant run starts.
 */
export function chatModelUnusableReason(
  item: PyModelProviderCatalogItem,
): ChatModelUnusableReason | null {
  // The send gate without a chat judges the model alone.
  const gate = chatModelSendGate(null, item);
  if (!gate.ok && gate.reason === "unsupported_model") return "unsupported";
  // Owner models need a context window before they can chat.
  if (item.source === "owner" && item.context_window_tokens == null)
    return "needs_context_window";
  return null;
}

/**
 * Chat models a picker may offer: never embedding models, and hidden models
 * only when one is the current choice (so the picker can still show it).
 */
export function selectableChatModels(
  items: readonly PyModelProviderCatalogItem[],
  currentId?: string | null,
): PyModelProviderCatalogItem[] {
  return items.filter(
    (item) => isChatModelRow(item) && (!item.hidden || item.id === currentId),
  );
}

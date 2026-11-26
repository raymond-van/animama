# Model Catalog

The durable backend model catalog is stored in `model_providers`. Every row
belongs to one model connection in `model_connections`. Built-in rows and the
built-in `openai`, `anthropic` and `chatgpt_plan` connections come from
`src/backend/animama/app/model_catalog.py`, except the ChatGPT plan's rows,
which are [listed from the signed-in account](#chatgpt-plan-connection);
the installation owner adds other connections and models in App Settings →
Models ([model settings](../frontend/features/model-settings.md)). The design is
recorded in
[ADR 0011](../adr/0011-application-owned-companion-features-and-composition-catalog-policy.md).

The public API is:

```text
GET /v1/model-providers
```

That route returns active rows on active connections that the composition's
catalog policy allows. Hidden rows are included with `hidden: true`, so a client
can still show a hidden row that an Anima uses. Provider credentials, base URLs,
pricing metadata and internal capability fields are omitted from the public
payload. A database failure returns `503` with
`detail.code="model_catalog_unavailable"`; the route never substitutes the
static catalog, which would silently drop owner rows.

## Connections And Row Ownership

A `model_connections` row names one model server: `name`, `preset`,
`base_url`, `credential_env` (the name of the environment variable that holds
its key, never the key), `compatibility` options and `timeout_seconds`. A
connection speaks an OpenAI protocol (Responses or Chat Completions) or, for
the built-in Anthropic connection, Anthropic's Messages API. Requests
for a model row go only to its connection's base URL with only that
connection's key. [Model clients](runtime/model-client-providers.md#connections-and-credentials)
describes credentials, presets and compatibility options.

- The built-in `openai` connection stores no base URL or key reference. It uses
  `OPENAI_BASE_URL` (default `https://api.openai.com/v1`) and `OPENAI_API_KEY`.
  It is the only connection that serves `OpenAIResponsesHTTPAgent` rows. The
  owner cannot edit or remove it but can add models to it.
- The built-in `anthropic` connection also stores no base URL or key
  reference. It uses only `ANTHROPIC_API_KEY`, always against Anthropic's own
  API, and serves only `AnthropicMessagesHTTPAgent` rows, which no other
  connection may serve. The owner cannot edit or remove it but can add Claude
  models to it.
- The built-in `chatgpt_plan` connection's credential is the owner's ChatGPT
  plan sign-in, not a key; see [ChatGPT plan connection](#chatgpt-plan-connection).
  It serves only `ChatGPTPlanResponsesHTTPAgent` rows, which no other
  connection may serve. The owner cannot edit or remove it, or add models to it.
- Built-in rows (`source="builtin"`) are release-managed, except the ChatGPT
  plan's account-listed rows. The owner can only hide or show them and, on rows
  with a long-context price step, change [Compact early](#compact-early).
- Owner rows (`source="owner"`, ids `owner:<hex>`) are added, edited and removed
  by the owner. Their capabilities come from a copied built-in template of the
  same connection, the connection probe or values the owner enters. On the
  Anthropic connection the probe reads Anthropic's Models API instead of
  sending messages.
- `model_kind` is `chat` or `embedding`. Embedding rows serve only the
  Embeddings model role; chat profiles and direct chat reject them.
- Removal is soft (`active=false`) because chat profiles reference rows.
  Re-adding a removed model to the same connection reactivates its row; an
  active one cannot be added twice. Removing a connection retires its rows.
- Rows are unique on `(connection_id, provider_type, model, source)`, so two
  connections can serve the same model ID.

Connection, owner-model, probe and role routes are mounted only by the local
composition; see [HTTP API](architecture/http-api.md).

### Catalog Policy

Shared services receive a `ModelCatalogPolicy`
(`app/services/model_provider_catalog_service.py`) from the composition:
`owner_models_enabled`, an optional `builtin_allowlist` and the built-in
connections whose rows it exposes. The default exposes only the built-in rows
of the OpenAI connection, so a hosted composition shows no Anthropic rows
unless its allowlist names them. `create_local_app` uses
`ModelCatalogPolicy.local()`: owner models, which also apply the owner's App
Settings model roles, and the built-in rows of every built-in connection. An
allowlist names exact rows and replaces the connection filter. The policy
filters the listing and role resolution only; a composition that restricts
built-in rows must also restrict chat profiles and turn setup, which validate
the selected row directly. A hosted composition has no ChatGPT plan rows: it
mounts no sign-in and registers no plan model client.

### ChatGPT Plan Connection

The `chatgpt_plan` connection serves the models of the owner's ChatGPT plan
through a Sign in with ChatGPT session, in local compositions only (see the
[glossary](../../GLOSSARY.md#chatgpt-plan-connection) and
[ADR 0039](../adr/0039-chatgpt-plan-sign-in-and-connection.md)). Its preset
cannot be chosen for a new connection and it names no key variable.
`GET /v1/model-connections` reports its `credential_state` from the session:
`configured` while an account is signed in with plan use granted, otherwise
`missing`, including when the session cannot be read.

Its rows are [account-listed](../../GLOSSARY.md#account-listed-models)
(`app/services/chatgpt_plan_models.py`). A sign-in's return (before the
sign-in reads as finished) and `POST /v1/chatgpt-plan/models:refresh` read the
account's model list from `GET https://api.openai.com/v1/models`
(`adapters/chatgpt_plan/openai_models.py`, which never logs the response) and
store one row for each item whose `visibility` is `list`:

- the id `ChatGPTPlanResponsesHTTPAgent:<slug>`, the item's `display_name` as
  `model_label`, and `ChatGPT plan` as `provider_label` with the `openai` logo;
- `context_window_tokens` from the item's `context_window`, else the catalog's
  figure for the same slug, else 128,000. The plan can list a smaller window
  than the catalog gives the same model on a key;
- `accepts` from `input_modalities` (text and image), the listed reasoning
  efforts that `REASONING_EFFORT_ORDER` knows, and hosted `web_search` in
  `native_tool_support` when the item's `supports_search_tool` is true;
- tools, streaming and `json_schema` structured output on every row, and no
  pricing (`unpriced`).

A refresh retires rows OpenAI no longer lists, signing out retires all of them,
and a later sign-in reactivates them. One lock per application serializes
refreshes and sign-out, so a sign-out during a refresh leaves no row active.
Stored rows keep their `hidden` flag, the only field the owner can change; the
owner model routes (add a model, list available models, probe) refuse this
connection with `400 connection_read_only`. The seed upserts the connection but
never retires its rows.

The evaluation tools (`scripts/evals/core/catalog.py`, used by the model
benchmark and Gesture selection) leave plan rows out: they run outside the app,
without its session, and the plan serves only Animama's own features.

## Public Catalog Shape

Each serialized row has:

- `id`: `${model_provider}:${model}` for built-in rows, `owner:<hex>` for owner
  rows
- `model`: provider-specific model ID
- `model_provider`: backend provider adapter type
- `model_label`: the owner's label, else the model ID
- `provider_label`: human-readable provider name; owner rows use their
  connection's current name
- `logo_provider`: frontend logo key; owner rows use their connection preset's
  logo
- `model_client`: nullable direct model-client profile for chat compatibility,
  `openai_chat_completions`, `openai_responses` or `anthropic_messages`
- `api_standard`: nullable chat transcript standard, `chat_completions`,
  `responses` or `anthropic_messages`
- `source`: `builtin` or `owner`
- `connection_id` and `connection_name`
- `model_kind`: `chat` or `embedding`
- `hidden`: whether the row is hidden from model lists; built-in Chat
  Completions chat rows start hidden, and the owner can change any row
- `context_window_tokens`: nullable; owner chat rows need it before they can
  chat
- `accepts`: sorted input modalities
- `produces`: sorted output modalities
- `supports_developer_role`: whether requests may send OpenAI-style `developer`
  messages; false when the model lacks the role or its connection folds them
  into the system message
- `supports_tools`
- `supports_streaming`
- `supports_reasoning`: optional boolean for models with explicit reasoning
  support metadata
- `supported_reasoning_efforts`: optional ordered list of allowed
  request-scoped reasoning effort values
- `default_reasoning_effort`: nullable effort the chat picker preselects;
  Anthropic Messages rows report `medium` when they offer it, other rows null
- `native_tool_support`: optional list of native provider tools supported by
  that concrete provider/model row; individual tools may be frontend opt-ins or
  backend-owned capabilities
- `requestable_native_tool_support`: optional list derived from the complete
  capability set and the direct-chat runtime allowlist; only these tools may be
  selected through `dispatch_options.native_tools`

Built-in chat rows produce text and support tools and streaming. Built-in
embedding rows accept text, produce `embedding` and advertise neither. Owner
rows carry whatever the owner confirmed. The internal `structured_kinds`,
`structured_output_transport`, `tools_with_structured_output`,
`allow_memory_writes` and `probe_result` fields are used by the backend
runtime and App Settings but are not exposed in the `/v1/model-providers`
public payload.

## Where Models Are Configured

Normal avatar chat stores the selected default as a stable catalog row ID on
`anima_chat_profiles.default_model_provider_id`:

```json
{
  "default_model_provider_id": "OpenAIResponsesHTTPAgent:gpt-6-luna"
}
```

Strict Anima creation seeds the profile from the owner's App Settings default
chat model (`user_settings.preferences.chat.default_model_provider_id`) when it
names an active model that direct chat supports. Otherwise, and always for
installation bootstrap, it uses `ANIMAMA_DEFAULT_MODEL_PROVIDER_ID`, which
defaults to `OpenAIResponsesHTTPAgent:gpt-6-luna`. Existing Animas keep their
own profile. The frontend model selector persists
changes through `PATCH /v1/animas/{anima_id}/chat-profile`.

The profile's nullable `reasoning_effort` holds the owner's effort for that
model; null means the model's default. An update may set one of the row's
`supported_reasoning_efforts` (others return `400`) or null. An update that
omits it keeps the saved effort for the same model and clears it when the model
changes. `chat:sse` does not read it: the client sends the effective effort
with each turn.

The backend validates anima chat-profile updates (an active chat row) and
request-level `chat:sse` model overrides against `model_providers` rows; see
[direct chat](runtime/chat.md#request-contract) for turn validation.

Persisted assistant chat messages also store a lightweight `(model_provider,
model)` snapshot for the provider/model that produced the row. The snapshot has
no foreign key, so history survives a row's removal. User messages and
non-provider rows intentionally keep those fields null. Successful turns also
record the exact row on `chats.last_model_provider_id`, which the frontend uses
to restore a chat's model.

## Pricing Metadata And Cost Estimates

`model_providers` stores backend-internal token pricing and rate-card source
metadata for each provider/model row. Public `/v1/model-providers` responses do
not expose pricing fields. Owner rows and the built-in embedding rows are
`unpriced`; their usage is still recorded.

The pricing fields include:

- `pricing_status`, such as `priced` or `unpriced`
- source provider/model/URL/checked date
- currency and billing unit
- supported service tiers
- input, cached-input, and output prices per 1M tokens for standard, batch,
  flex, and priority tiers when known
- optional notes and regional-processing uplift metadata

`animama.app.util.model_pricing.estimate_model_token_cost()` calculates a
backend-only token-cost estimate from a `Usage` payload and a `ModelProvider`
row. It defaults `default`, `auto`, and unset service tiers to `standard`.
Cached input tokens are charged at the cached-input rate, while uncached input
tokens are `max(input_tokens - cached_input_tokens, 0)`. Output reasoning tokens
are not priced separately; they are part of the provider-reported output token
count.

When a row is unpriced, a requested service tier is unsupported, or a required
rate is missing (for example, cached tokens on a row without a cached-input
rate), the helper returns an explicit unpriced result with `None`
cost fields. It does not treat unknown pricing as zero dollars. The helper does
not apply regional-processing uplifts, long-context rates or tool-call fees;
later billing work must opt into those adjustments with the right request
context.

`gpt-6-luna` rows (both APIs) record the owner-supplied standard rates of
$0.10 input and $0.50 output per 1M tokens and a $0.01 cached-input rate from
secondary sources awaiting owner confirmation, checked 2026-09-28, with no
source URL. Its batch, flex, priority and long-context rates are unknown and
stored as null, so `service_tiers_supported` is `["standard"]`. The catalog has
no prompt-cache write rate: usage reporting `cache_write_tokens` (parsed from
both APIs' input token details) produces an unpriced estimate, and those tokens
are excluded from the uncached input count.

`claude-haiku-5-5` records Anthropic's published rates, checked 2026-10-08:
$0.10 input, $0.01 cached input (cache reads) and $0.50 output per 1M tokens,
with batch at half those rates. Above 100,000 prompt tokens every token of the
request bills at $0.50 input, $0.05 cached and $2.50 output, stored as the
long-context threshold and rates. The estimator ignores that step, cache writes
stay unpriced as for `gpt-6-luna`, and Anthropic's per-search web search fee
is billed to the owner's Anthropic account but not estimated; the row's
`pricing_notes` say so.

### Compact early

`model_providers.early_compaction` (boolean, default true) is the owner's
**Compact early** setting. It applies only to Anthropic rows whose pricing has
a long-context threshold (`early_compaction_available` in `model_catalog.py`):
with it on, server compaction triggers at 90% of the threshold, never below
Anthropic's 50,000-token minimum (90,000 for Claude Haiku 5.5), so a chat
stays below the price step; with it off, or on any other row, the trigger is
Anthropic's default of 150,000 tokens. Unpriced owner rows therefore always use
150,000. The owner changes it on built-in rows too, and catalog re-seeding
keeps the stored value, like `hidden`. See
[Anthropic Messages](runtime/model-client-providers.md#anthropic-messages) for
the request.

## Provider Types

| Provider type                | Provider label                                     | Default logo                              | Notes                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OpenAIHTTPAgent`            | OpenAI HTTP, or the connection name for owner rows | `openai`, or the connection preset's logo | Chat Completions adapter shared by every connection, including owner connections. Requests go to the row's connection base URL. Built-in embedding rows also use this provider type.                                                                                                                                      |
| `OpenAIResponsesHTTPAgent`   | OpenAI Responses HTTP                              | `openai`                                  | OpenAI Python SDK Responses adapter, valid only on the built-in OpenAI connection. Turns call `/responses` directly, support typed SSE text streaming, continue chats through the chat row's `openai_previous_response_id`, and use Anima memory function tools through Responses tool/input item types.                  |
| `AnthropicMessagesHTTPAgent` | Anthropic                                          | `anthropic`                               | Official `anthropic` Python Client SDK Messages adapter, valid only on the built-in Anthropic connection. Turns stream from the Messages API, replay application-owned history (from the newest server compaction block), and use strict memory tools, strict structured output and Anthropic's `web_search` server tool. |
| `ChatGPTPlanResponsesHTTPAgent` | ChatGPT plan                                    | `openai`                                  | The OpenAI Responses adapter on the ChatGPT plan's route, valid only on the built-in `chatgpt_plan` connection, whose [account-listed rows](#chatgpt-plan-connection) it serves. Requests are streamed and unstored and replay history instead of continuing from a cursor; see [ChatGPT plan Responses](runtime/model-client-providers.md#chatgpt-plan-responses). |

## Built-In Provider/Model Pairs

| Provider type                | Model                    | Accepts     | Produces  | Tools | Streaming | Reasoning efforts                               | Native tools                |
| ---------------------------- | ------------------------ | ----------- | --------- | ----- | --------- | ----------------------------------------------- | --------------------------- |
| `OpenAIHTTPAgent`            | `gpt-6-luna`             | image, text | text      | yes   | yes       | `none`, `low`, `medium`, `high`, `xhigh`, `max` | none                        |
| `OpenAIResponsesHTTPAgent`   | `gpt-6-luna`             | image, text | text      | yes   | yes       | `none`, `low`, `medium`, `high`, `xhigh`, `max` | `apply_patch`, `web_search` |
| `AnthropicMessagesHTTPAgent` | `claude-haiku-5-5`       | image, text | text      | yes   | yes       | `none`, `low`, `medium`, `high`, `xhigh`, `max` | `web_search`                |
| `OpenAIHTTPAgent`            | `text-embedding-3-small` | text        | embedding | no    | no        | n/a                                             | none                        |
| `OpenAIHTTPAgent`            | `text-embedding-3-large` | text        | embedding | no    | no        | n/a                                             | none                        |

The two `text-embedding-3-*` rows have `model_kind: "embedding"`. The
`gpt-6-luna` rows are chat rows with a 1,050,000-token context window, 128,000
max output tokens and a 2026-05-18 knowledge cutoff. The `claude-haiku-5-5` row
is on the built-in Anthropic connection, with a 1,000,000-token context window
and 128,000 max output tokens; a request asks for at most 64,000 output tokens,
thinking included. It is visible in a fresh installation, but the application
default chat model stays `gpt-6-luna`.

The `Tools` column is a broad provider capability flag. Anima memory tools are
app-layer tools executed by the direct chat runtime when the selected row
supports tool calling. Provider-native tools are
advertised through `native_tool_support`. Hosted `web_search` is observed
through model-client stream metadata; backend-owned memory `apply_patch` calls
are validated and executed by Animama.

## Structured Output Capabilities

`structured_kinds` is internal runtime metadata used by direct chat to decide
whether a provider/model can enforce
`main_structured_response` JSON. The canonical structured kind is
`main_structured_response`, which emits SSE parts with
`response_format="main_structured_json"`. The durable `model_providers` row also
stores backend-internal `structured_output_transport`, `json_schema`
or `json_object`, so adapters use the selected persisted row instead of the
in-process catalog helper at request time. This field is not returned by
`/v1/model-providers`.

Every built-in chat row supports this kind through schema-backed `json_schema`.
Owner chat rows take their transport from the template, the probe or the owner:
`json_schema`, `json_object` (the probe's fallback when schema output fails),
or none. A row without a transport has no structured kind; it still chats, with
the reply requested by prompt alone. Anthropic rows send `json_schema` as
strict structured output in `output_config.format`; they never use
`json_object`, which owner Anthropic rows reject (`invalid_capabilities`).

| Transport | Request | Prompt guidance |
| --- | --- | --- |
| `json_schema` | strict schema in the response format | brief guidelines |
| `json_object` | `{"type": "json_object"}` | guidelines, the word `json`, the schema and an example |
| none | no response format | as for `json_object` |

Every reply is validated locally, whatever the transport; see
[reply validation and recovery](runtime/model-client-providers.md#reply-validation-and-recovery).

The internal `tools_with_structured_output` capability records whether one
request may carry both function tools and a response format. When it is false,
direct chat splits a Chat Completions turn into tool rounds and one structured
round; see [model clients](runtime/model-client-providers.md#context-and-structured-output).

## Reasoning And Native Tool Capabilities

Reasoning and native tool metadata is optional in `MODEL_CATALOG`. Models that
do not declare those fields omit them from the public API payload rather than
returning empty capability lists.

`supported_reasoning_efforts` is normalized using
`REASONING_EFFORT_ORDER = ("none", "minimal", "low", "medium", "high",
"xhigh", "max")`, so frontend controls receive a stable display order.
Per-model values are listed in
[Built-In Provider/Model Pairs](#built-in-providermodel-pairs).
Anthropic rows may offer only `ANTHROPIC_REASONING_EFFORTS` (`none`, `low`,
`medium`, `high`, `xhigh`, `max`); owner Anthropic rows that list `minimal`
are rejected with `invalid_capabilities`.

The chat picker shows, and sends with each turn, the effort saved on the
Anima's chat profile while the row offers it. With none saved (null), or one
the row no longer offers, it uses the row's `default_reasoning_effort`, else its
first listed effort.
`default_chat_reasoning_effort` (`app/model_catalog.py`) reports
`DEFAULT_ANTHROPIC_CHAT_EFFORT` (`medium`) for every Anthropic row, built-in or
owner, that offers it; the Anthropic adapter applies the same constant to chat
requests that carry no effort. OpenAI rows report none, so for both
`gpt-6-luna` rows, whose list starts with `none`, the picker sends `none`
rather than OpenAI's omitted-field default of `medium`. On the Chat Completions
row `none` is also the only effort that allows memory tools and web search,
which OpenAI accepts there only at `none`
([function tools and reasoning](runtime/model-client-providers.md#provider-behavior)).

All four provider types honor request-scoped
`reasoning_effort` values when the selected effort is listed for the active
provider/model pair. `OpenAIResponsesHTTPAgent` and
`ChatGPTPlanResponsesHTTPAgent` send supported efforts through the Responses
API `reasoning.effort` request field.
`AnthropicMessagesHTTPAgent` turns `none` into disabled thinking and sends any
other effort as `output_config.effort` with adaptive thinking.
`OpenAIHTTPAgent` follows the connection's `reasoning_mode`: `openai_effort` sends the effort literally,
`deepseek_thinking` (the DeepSeek preset) turns `none` into disabled thinking
and sends `high` and `max` with thinking enabled, and `omit` never sends one.

`native_tool_support` lists provider-native tools by stable request name. The
catalog advertises `web_search` and `apply_patch` for the official
OpenAI Responses row `OpenAIResponsesHTTPAgent:gpt-6-luna`.
Runtime turns user-requested
`web_search` into a hosted Responses tool with `search_context_size: "low"`.
`requestable_native_tool_support` contains only `web_search` for that row.
`apply_patch` is therefore visible as a complete model capability but is not in
the generic request allowlist; the backend enables it only for permitted
direct-memory writes. Catalog serialization and direct-turn validation derive
the requestable list from the same backend policy. `OpenAIHTTPAgent:gpt-6-luna`
uses Chat Completions and advertises neither capability. Native tools are not
owner-editable: an owner Responses row keeps those of the Responses template it was copied from, and
Chat Completions rows never advertise them. A requested `web_search` on an
OpenAI row without hosted search uses the
[application web search](runtime/model-client-providers.md#application-web-search)
tool when the installation has a backend and the row calls tools.

`AnthropicMessagesHTTPAgent:claude-haiku-5-5` advertises requestable
`web_search`, which runtime turns into Anthropic's `web_search` server tool.
Anthropic bills each search to the owner's Anthropic account, separately from
tokens. Owner Anthropic rows take `web_search` from a copied Anthropic
template or from the Models API probe. An Anthropic row without it runs a
search-enabled turn without search; Anthropic rows never use the application
tool.

## Production Selection

`OpenAIResponsesHTTPAgent` is selectable as a distinct direct OpenAI provider on
the built-in OpenAI connection.
Use it when Responses behavior, typed SSE streaming, supported native tools,
and `previous_response_id` continuation are the desired provider boundary.

`AnthropicMessagesHTTPAgent` rows run Claude models natively on the built-in
Anthropic connection, for chat, Utility and the Memory Manager (never
Embeddings, because Anthropic offers no embedding model). Claude Haiku 5.5 is
the built-in row; the owner adds other Claude model IDs on the same
connection. Their chats use the `anthropic_messages` API standard, so the chat
fence keeps them apart from OpenAI chats in both directions. These rows have no
inline crisis moderation; only a composition's operator check can add the
[crisis card](runtime/chat.md#companion-safety).

`ChatGPTPlanResponsesHTTPAgent` rows run the owner's ChatGPT plan models
without an API key, for chat, Utility and the Memory Manager (never
Embeddings). They share the `responses` API standard, so a chat moves between
key and plan Responses models in either direction by replaying history. These
rows have no inline crisis moderation and no operator check, so plan turns
show no moderation-triggered [crisis card](runtime/chat.md#companion-safety).

DeepSeek, Hugging Face router and OpenRouter models have no built-in rows. The
owner adds a connection from the `deepseek`, `huggingface` or `openrouter`
preset and adds models under it. On self-hosted web the connection names the
environment variable that holds its key (conventionally `DEEPSEEK_API_KEY`,
`HF_TOKEN` or `OPENROUTER_API_KEY`); on desktop the key is kept in the
encrypted vault. These presets send no `developer` messages
(`fold_developer_role`) and omit OpenAI request extensions; the
[preset table](runtime/model-client-providers.md#connection-presets) lists the
remaining differences. Their rows use `OpenAIHTTPAgent`, so they share the
`chat_completions` API standard and are blocked from Responses-backed chats by
the chat API standard fence.

OpenRouter's add-model picker reads OpenRouter's public model list through
`GET /v1/model-connection-presets/openrouter/models` (see
[HTTP API](architecture/http-api.md#model-configuration)); each entry's
`supports_tools` and `supports_structured_outputs` come from the model's
advertised parameters and only prefill the form.

## Resolution And Validation

Direct chat, chat-profile updates and model roles read the persisted row by ID.
Missing, inactive, non-chat, or unsupported rows fail setup before a direct
model-client call. Direct chat also requires an active connection, a context
window on owner rows, the built-in OpenAI connection for Responses rows, the
built-in Anthropic connection for Anthropic Messages rows and the ChatGPT plan
connection for plan rows (each of the last two serves only its own kind of
row). A plan row also needs a signed-in session with plan use, which the plan's
model client checks when it asks for a token, not at setup.

This resolution is used by:

- anima chat-profile validation and direct-chat setup
- model roles (Utility, Memory Manager and Embeddings)
- tests that assert frontend-facing model selector behavior

Unsupported provider/model pairs should fail at validation time instead of
falling through to provider construction.

## Updating The Catalog

A newly released OpenAI model needs no code change: the owner adds it in App
Settings → Models on the built-in OpenAI connection, copying the capabilities
of a built-in template such as `gpt-6-luna`. A Claude model is added the same
way on the built-in Anthropic connection, from the Claude Haiku 5.5 template
or from **Test model**, which reads the model's limits, efforts, structured
output and web search from Anthropic's Models API. Such rows are unpriced, so
they show no Compact early setting. Change `MODEL_CATALOG` only when a model
should ship as a release-managed built-in row.

Follow [Adding AI model support](runtime/adding-ai-models.md) when adding or
changing a built-in model, connection preset, provider type, or public model
capability. That guide covers the complete catalog-to-frontend flow, database
seed regeneration, adapter and API-standard decisions, pricing limitations,
tests, and live verification.

The generated seed `src/backend/migrations/seeds/01-seed-model-providers.sql` upserts the
built-in `openai`, `anthropic` and `chatgpt_plan` connections and the built-in
rows. It updates only `source='builtin'` rows, never changes their `hidden` or
`early_compaction` values (a newly inserted row starts with Compact early on),
and retires built-in rows that are no longer in `MODEL_CATALOG`, except the
ChatGPT plan connection's account-listed rows. A newly
inserted built-in Chat Completions chat row starts hidden (`builtin_hidden_by_default`), so a fresh
installation lists the Responses row; embedding rows stay visible. Existing
databases keep their flags until they are reset. Owner connections and rows are never
touched, and retired rows keep their IDs, so history stays valid.

`RETIRED_BUILTIN_REPLACEMENTS` in `animama.app.model_catalog` maps retired
built-in chat rows to a current row on the same API. On every run the seed moves
Anima chat profiles (`default_model_provider_id`) and the owner's
`chat.default_model_provider_id`, `models.utility_model_provider_id` and
`models.memory_manager_model_provider_id` preferences from a mapped row to its
replacement; other preference keys and profile metadata are kept. The embedding
role is not remapped because retired rows are chat rows. Operator defaults
(`ANIMAMA_DEFAULT_MODEL_PROVIDER_ID` and the utility and Memory Manager
defaults) that name a mapped row use its replacement when settings load, with a
warning in the log; update the environment to silence it. Current mappings:

| Retired row                                                                               | Replacement                           |
| ----------------------------------------------------------------------------------------- | ------------------------------------- |
| `OpenAIResponsesHTTPAgent:` `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5-nano`, `gpt-5.4-nano` | `OpenAIResponsesHTTPAgent:gpt-6-luna` |
| `OpenAIHTTPAgent:` `gpt-5-nano`, `gpt-5.4-nano`                                           | `OpenAIHTTPAgent:gpt-6-luna`          |

When retiring a built-in row that Animas may use, add its mapping in the same
change and regenerate the seed.

Do not put provider secrets in `MODEL_CATALOG` or connection rows. Connections
store only the name of the environment variable that holds a key.

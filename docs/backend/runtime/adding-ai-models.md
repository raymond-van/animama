# Adding AI Model Support

This guide explains how model-provider integration is wired from the durable
backend catalog through direct chat and the frontend model selector, then gives
the implementation workflow for adding a built-in model, a connection preset or
a provider family.

Most new models need no code: the installation owner adds them under a model
connection in App Settings → Models, including a new OpenAI model on the
built-in OpenAI connection or a Claude model on the built-in Anthropic
connection ([model settings](../../frontend/features/model-settings.md)).
Use this guide for release-managed catalog and adapter changes.

Use this page together with:

- [Model catalog](../model-catalog.md) for the current supported rows and field
  definitions.
- [Model clients and providers](model-client-providers.md) for detailed runtime
  behavior.
- [Direct chat SSE runtime](chat.md) for the public chat lifecycle.
- [ADR 0011](../../adr/0011-application-owned-companion-features-and-composition-catalog-policy.md)
  for why companion features must work on any Chat Completions model, and
  [ADR 0023](../../adr/0023-native-anthropic-messages-provider.md) for when a
  vendor gets its own native provider type.

When a change depends on current vendor behavior, verify the model ID, endpoint,
request fields, reasoning values, tools, context limits, and pricing against the
provider's authoritative documentation before editing the catalog or adapter.
For OpenAI changes, use current official OpenAI Developer Docs through an
available documentation MCP server or the official website; no imported agent
skill is required. For Anthropic changes, use Anthropic's current platform
documentation, and check a model's limits and capabilities with its Models API
(`models.retrieve`).

## Mental Model

Animama separates a selectable model row from the code that calls its provider:

- A **model** is a provider-specific model ID such as `gpt-6-luna`.
- A **model connection** (`model_connections`) is the endpoint and credential
  boundary a row belongs to: the built-in `openai` or `anthropic` connection,
  the built-in `chatgpt_plan` connection (whose rows are listed from the
  signed-in account, not added here; see
  [ADR 0039](../../adr/0039-chatgpt-plan-sign-in-and-connection.md)), or an
  owner connection with its own base URL, key variable, timeout and
  compatibility options.
- A **provider type** is a durable adapter-family identifier such as
  `OpenAIResponsesHTTPAgent`.
- A **model-provider row** is one supported provider/model pair on one
  connection. Built-in rows are identified by `${provider_type}:${model}`;
  owner rows by `owner:<hex>`. Each row has a `model_kind` (`chat` or
  `embedding`) and a `hidden` flag that removes it from model lists.
- A **model client** is the app-scoped adapter implementation registered for a
  provider type.
- An **API standard** is the persisted chat-transcript compatibility boundary,
  currently `chat_completions`, `responses` or `anthropic_messages`.

Adding a model to an existing provider type normally adds data, not a new
FastAPI endpoint or a new app-scoped client. For example,
`OpenAIResponsesHTTPAgent:gpt-6-luna` reuses Animama's existing
`POST /v1/animas/{anima_id}/chat:sse` route and shared OpenAI Responses client.
That client sends the selected row's model ID to OpenAI's `POST /v1/responses`
endpoint.

## End-To-End Integration Map

```text
app/model_catalog.py (built-in rows)  |  App Settings → Models (owner rows)
    -> src/backend/migrations/seeds/01-seed-model-providers.sql  |  /v1/model-connections/{id}/models
    -> model_connections + model_providers tables
    -> GET /v1/model-providers (filtered by the composition's ModelCatalogPolicy)
    -> generated frontend client + useModelProviders()
    -> chat model selector
    -> PATCH /v1/animas/{anima_id}/chat-profile
    -> POST /v1/animas/{anima_id}/chat:sse with model_provider_id
    -> persisted row resolution and capability validation
    -> app-scoped ModelClient selected by provider_type
    -> the row's connection: base URL, key, timeout, compatibility options
    -> provider SDK/API stream
    -> provider-neutral ModelClientDelta stream
    -> DirectChatTurnExecutor parsing, tools, persistence, and domain events
    -> public Animama SSE frames
    -> frontend chat, TTS, emotion, and avatar runtime
```

### Catalog And Database

`src/backend/animama/app/model_catalog.py` is the source of built-in model and
provider metadata for the built-in connections; each provider entry belongs to
the OpenAI connection unless it names another built-in connection.
`serialize_model_provider_catalog()` expands it into durable rows for
`model_providers`, and `serialize_builtin_model_connections()` produces the
built-in `openai` and `anthropic` connection rows. `serialize_model_catalog()`
is the public projection of those rows; only tests use it, and the API never
falls back to it.

The generated post-schema seed
`src/backend/migrations/seeds/01-seed-model-providers.sql` upserts the built-in connections
and then the built-in rows after Alembic creates the tables. It updates only
`source='builtin'` rows, never changes `hidden`, `early_compaction`, `source`
or `connection_id`, and retires built-in rows missing from the catalog. Owner
connections and rows are never touched. `animama.server.db_bootstrap` executes it for both
`reset.sh` and native/packaged bootstrap. Restarting FastAPI alone does not
synchronize a changed Python catalog into an existing database.

`ModelProviderCatalogService.sync_from_registry` can synchronize built-in
repository rows from the Python catalog (retiring only built-ins), but it has
no production caller; normal startup relies on the post-schema SQL seed.
The SQL renderer lives in `tests/test_model_provider_catalog.py`.

Owner connections and rows are written by `ModelConfigurationService` through
the local-only `/v1/model-connections` routes. They are never seeded.

### Public Catalog And Frontend Discovery

`GET /v1/model-providers` reads active rows on active connections that the
composition's `ModelCatalogPolicy` allows (built-in rows of the OpenAI
connection by default; the local composition adds owner rows and the
Anthropic built-ins) and exposes the public
`PyModelProviderCatalogItem` projection. It omits provider credentials, base
URLs, internal structured-output transport, and pricing. A database failure
returns `503 model_catalog_unavailable` instead of a static fallback.

The frontend does not hardcode supported model IDs. `useModelProviders()` calls
the generated API client, and `ChatInputModelSelector` groups returned rows by
provider label (an owner row's connection name). Chat pickers omit
`model_kind: "embedding"` rows and hidden rows other than the current one, and
disable owner rows without `context_window_tokens`. A schema-preserving catalog
addition therefore appears in the selector without a frontend source change or
client regeneration.

Selecting a row updates
`anima_chat_profiles.default_model_provider_id` through
`PATCH /v1/animas/{anima_id}/chat-profile`. Accepted sends also include the
same row ID as `model_provider_id` in the `chat:sse` body, so the displayed and
executed selections agree.

### Direct Chat Resolution And Validation

Direct chat resolves the selected row in this order:

1. request `model_provider_id`, when present;
2. the anima chat profile's `default_model_provider_id`.

Before opening the SSE stream, setup verifies ownership and validates that the
persisted row is an active chat row on an active connection and supports
streaming, the requested reasoning effort, and requested native tools other
than `web_search` (which falls back to the application tool, or to no search,
at turn time; Anthropic rows never get the application tool). Structured
output is not required: a row without a schema or JSON-mode transport is asked
for JSON by prompt and validated locally. Owner rows also need a context
window. Responses rows are valid only on the built-in OpenAI connection, and
Anthropic Messages rows only on the built-in Anthropic connection, which
serves nothing else.
Memory tools are narrowed to the row instead of failing setup: a row without
tool calling chats without memory tools, and a row with
`allow_memory_writes=false` gets read tools only.

The provider type also supplies `model_client` and `api_standard`. A chat may
switch between rows with the same API standard, but switching to another
standard requires a new chat. The frontend gates this
selection for usability; the backend remains authoritative and returns
`409 chat_api_standard_mismatch` for incompatible turns.

### Provider Invocation And Streaming

`server/model_clients.py` constructs one shared client per registered provider
type. The selected durable row remains request-local and supplies the exact
model ID, its loaded connection, capabilities, and pricing metadata. The base
URL, key, timeout and request-shape options come from that connection; built-in
rows store no base URL. The Chat Completions client caches one SDK client per
connection.

Adapters translate a provider-neutral `ModelClientRequest` into SDK/API request
fields and stream provider-neutral `ModelClientDelta` values:

- `text_delta` for public assistant text;
- `event` for sanitized provider observations;
- `final` for the authoritative response, usage, metadata, and tool calls;
- `error` for a classified provider failure;
- `done` after successful adapter completion.

Provider event payloads are not forwarded directly to the browser. The direct
turn executor observes and summarizes them, performs bounded app-layer tool
loops, validates the structured main response, persists chat messages and usage,
and emits Animama domain events. The route converts those events into public
SSE frames and owns the single final `run.completed` frame after success-side
effects.

OpenAI Responses chats additionally persist the latest successful response ID
on `chats.openai_previous_response_id`. The next turn normally sends it as
`previous_response_id`; a stale-cursor failure is retried once with locally
replayed history. Successful chat rows also retain `api_standard`,
`last_model_provider_id`, `last_model_client`, and `last_model_id`. The
frontend restores a reopened chat's selection by `last_model_provider_id`,
using the client/model pair only for chats without a recorded row ID.

## Decide The Change Type First

### Existing Provider Type, New Model

An owner can add any model to an existing connection without a release. Use
this path only when a model should ship as a release-managed built-in row on
a built-in connection, and the existing adapter already supports the
required endpoint, request shape, stream semantics, structured output, and
tools. Typical work is:

1. add a `MODEL_CATALOG` entry;
2. add or update pricing metadata;
3. regenerate the SQL seed;
4. update catalog and validation tests;
5. update the supported-model reference and run a live smoke test.

No registry, adapter, route, or frontend code should be necessary when the
public schema remains unchanged.

### Existing Protocol, New Compatible Vendor

An OpenAI-compatible server needs no code when the owner can reach it through
the Custom preset and its compatibility options. Add a preset to
`app/model_connection_presets.py` only to give a common server family good
defaults: label and logo, default base URL (local presets derive the host from
`ANIMAMA_LOCAL_MODEL_HOST`), whether a key is expected, a suggested key
variable, timeout and `ModelConnectionCompatibility`. Settings read presets
from `GET /v1/model-connection-presets`; chat-failure hints in
`packages/product-ui/src/chat/chat-failure.ts` name local presets. A suggested
key variable must also be listed with its provider's origin in
`PROVIDER_CREDENTIAL_ORIGINS` (`app/model_clients/credential_store.py`), and its
key then goes only to that origin; otherwise owners use
`ANIMAMA_CONNECTION_<NAME>_API_KEY` with its `_ORIGIN`.

When a server differs in a way the existing options cannot express, add a
compatibility option and apply it in
`adapters/model_clients/openai_chat_completions/request.py`. Do not infer
behavior from a base URL, provider label or model prefix.

Do not label a vendor OpenAI-compatible merely because its payload looks
similar. Verify unsupported request fields, stream chunks, errors, tool calls,
reasoning configuration, structured-output transport, and usage reporting.

### New Provider Type Or API Standard

Add a new provider type when an existing adapter cannot accurately represent
the provider's lifecycle. This is a larger change:

1. implement the provider-neutral model-client contract under
   `adapters/model_clients/`;
2. keep vendor SDK types inside the adapter package;
3. register and close the app-scoped client in `server/model_clients.py`;
4. reach each row's connection base URL with only that connection's key from
   `ModelCredentialResolver`, and honor its timeout, without placing secrets in
   the catalog or reading process keys for owner connections;
5. decide whether the provider shares an existing transcript standard or needs
   a new `api_standard` mapping in `app/chat/api_standard.py`; a new standard
   or model-client profile also extends the `chats` `api_standard` and
   `last_model_client` CHECK constraints in the ORM and a new Alembic
   revision;
6. translate structured output, reasoning, tools, usage, errors, retries, and
   terminal stream events explicitly, mapping failures to the neutral
   categories in `app/model_clients/error_categories.py`;
7. decide whether owner rows may use it (`OWNER_MODEL_PROVIDER_TYPES` in
   `ModelConfigurationService`, with the connection each type needs), whether
   the Memory Manager can run on it (`MemoryManagerRuntimeSelector` picks a
   runtime by provider type), and, for a new built-in connection, its key
   variable in the credential store, Compose and the desktop vault;
8. add focused adapter, registry, direct-turn, route, persistence, and public
   catalog tests;
9. regenerate the frontend client if public schemas change.

Do not expose a catalog row for direct chat until its provider type has a
registered client and a supported API-standard profile.

## Adding A Built-In Model To An Existing Provider

### 1. Verify The Provider Contract

Record authoritative answers for:

- exact stable model ID and any dated snapshot;
- supported API endpoints;
- input and output modalities;
- context, maximum input, and maximum output limits;
- streaming and structured-output support;
- function and hosted tool support;
- accepted reasoning efforts and defaults;
- service tiers and short/long-context pricing;
- deprecation or preview status;
- SDK version or event-type requirements.

Prefer an explicit model ID over a moving alias for durable catalog rows unless
following the alias is intentional product behavior.

### 2. Add The Catalog Entry

Add the model to `MODEL_CATALOG` with only verified, Animama-supported
capabilities. Each provider entry becomes a row on the built-in OpenAI
connection unless it sets `connection_id` to another built-in connection, as
the Anthropic entry does. A schema-backed reasoning model generally resembles:

```python
"openai-model-id": {
    "model_metadata": {
        "model_type": "reasoning",
        "current_snapshot": "openai-model-snapshot",
        "context_window_tokens": 1_000_000,
        "max_output_tokens": 128_000,
    },
    "capabilities": {
        "accepts": _s("text", "image"),
        "produces": _s("text"),
        "supports_tools": True,
        "supports_streaming": True,
        "structured_kinds": MAIN_STRUCTURED_RESPONSE_KINDS,
        "structured_output_transport":
            STRUCTURED_OUTPUT_TRANSPORT_JSON_SCHEMA,
        "supports_reasoning": True,
        "supported_reasoning_efforts": {"low", "medium", "high"},
    },
    "providers": {
        "OpenAIResponsesHTTPAgent": {},
    },
    "pricing": VERIFIED_PRICING,
},
```

An embedding model sets `"model_kind": MODEL_KIND_EMBEDDING`, produces
`embedding` and uses `OpenAIHTTPAgent`; see the `text-embedding-3-*` entries.

Provider attributes override shared model capabilities when one endpoint has a
different feature set. Add multiple provider types only when each path is
intentionally supported and tested; a model being offered by both Responses
and Chat Completions does not require Animama to expose both.

### 3. Model Capabilities Conservatively

Capabilities drive runtime validation and UI controls, so an optimistic value
creates executable behavior rather than harmless descriptive metadata.

- Use `json_schema` only when the selected provider path accepts the schema
  transport the adapter sends.
- Use `json_object` only with explicit JSON prompting and local validation.
- Set `supports_tools` only when the adapter handles the provider's tool-call
  stream and follow-up result format.
- Put a hosted tool in `native_tool_support` only when Animama can request or
  safely execute/observe it through that adapter.
- Update `REQUESTABLE_NATIVE_TOOL_SUPPORT_BY_PROVIDER` only for tools users may
  explicitly select. Backend-owned capabilities such as memory `apply_patch`
  should not become generic request options.
- List only reasoning efforts accepted by the concrete provider/model pair.

The chat picker preselects the public catalog's `default_reasoning_effort`
when the row offers it, else the first supported effort in
`REASONING_EFFORT_ORDER`. Only Anthropic rows report a default (`medium`), so
adding `none` to another row makes the UI send `none` even when the provider's
omitted-field default is `medium`. To give another provider a different picker
default, extend `default_chat_reasoning_effort` in `app/model_catalog.py`
rather than relying on effort order.

### 4. Add Pricing Without Inventing Precision

Pricing is backend-internal but participates in usage estimates. Populate the
source URL and checked date together with every verified tier. Preserve
trailing decimal precision as strings in the catalog constants. Entries without
pricing, and every owner row, are stored as `unpriced`.

The current model supports input, cached-input, and output prices for standard,
batch, flex, and priority tiers, plus corresponding long-context rates and a
long-context token threshold. It does not have separate cache-write price
columns or a distinct Fast-mode name; usage that reports `cache_write_tokens`
is therefore estimated as unpriced. When a provider rate card cannot be
represented faithfully, either:

- mark the missing dimension in `pricing_notes` and document the estimate's
  limitation; or
- extend the domain, ORM (with an Alembic revision), mapper, serializer,
  estimator, seed, and tests before claiming complete pricing support.

Unknown pricing must remain explicitly unpriced, never zero.

### 5. Regenerate And Apply The Seed

Update `src/backend/migrations/seeds/01-seed-model-providers.sql` from
`serialize_model_provider_catalog()` and `serialize_builtin_model_connections()`
and run the catalog parity test. Do not hand-edit only the SQL while leaving the
Python source stale. Removing an entry retires its row on the next seed run; the
row keeps its ID so chat profiles and history stay valid.

Apply the new rows locally through the normal stack reset:

```bash
./reset.sh
```

For a named worktree stack, follow the repository's local-stack instructions
and use `reset.sh --name ... --base-port ...`. Do not use an unscoped Compose
reset.

### 6. Update Or Regenerate Frontend Contracts Only When Needed

A catalog-only addition is data and needs no generated client change. If the
public `PyModelProviderCatalogItem`, chat request options, error contract, or
another FastAPI schema changes, regenerate instead of editing
`packages/runtime-contracts/src/generated/**`:

```bash
cd src/frontend
pnpm openapi-ts
pnpm packages:build
```

Update selector logic and tests when introducing a new public capability,
default, grouping rule, or API-standard behavior.

## OpenAI Example: GPT-6 Luna On Both APIs

One catalog entry ships `gpt-6-luna` on both OpenAI APIs:

```text
OpenAIResponsesHTTPAgent:gpt-6-luna   (OpenAIResponsesModelClient)
OpenAIHTTPAgent:gpt-6-luna            (Chat Completions client)
```

The Responses row enables requestable `web_search` and backend-controlled
memory `apply_patch`; the Chat Completions row has no native tools. The ordered
reasoning list starts with `none`, which the selector sends as its default.
Other OpenAI models need no catalog row: an owner can add one on the built-in
OpenAI connection by copying the Luna template, which keeps the template's API
and, on Responses, its native tools. When a built-in row is replaced, map the
retired ID in `RETIRED_BUILTIN_REPLACEMENTS` so the seed moves Animas and roles
to the replacement.

Use [the model catalog](../model-catalog.md) for supported capabilities and
`MODEL_CATALOG` for source-attributed pricing. Verify current vendor terms
before adding a row; dated rate-card examples are not integration requirements.

## Anthropic Example: Claude Haiku 5.5

The `claude-haiku-5-5` entry names the built-in Anthropic connection:

```python
"providers": {
    "AnthropicMessagesHTTPAgent": {"connection_id": BUILTIN_ANTHROPIC_CONNECTION_ID},
},
```

It declares `json_schema` structured output, tools, streaming, `web_search` as
a native tool and efforts from `ANTHROPIC_REASONING_EFFORTS`; `none` means
thinking disabled. Its pricing fills the long-context threshold and rates,
which is what makes the row offer [Compact early](../model-catalog.md#compact-early).
A new built-in Claude row follows the same shape, with values checked against
Anthropic's Models API and pricing page; leave the long-context fields empty
when the model has no price step.

Other Claude models need no catalog row. The owner adds them on the built-in
Anthropic connection: the dialog offers only Anthropic templates, and **Test
model** calls `POST /v1/model-connections/anthropic/probe`, which reads
`models.retrieve` (no tokens spent) and suggests the context window, output
limit, efforts (`none` first when the model accepts disabled thinking),
structured output and web search. A row saved from the probe rather than a
template keeps the probe's `web_search` and output limit. Owner Anthropic rows
are chat rows only, cannot use JSON mode or the `minimal` effort, and are
unpriced.

## Tests And Verification

### Catalog And Runtime Tests

At minimum, cover:

- one serialized row per configured provider/model pair;
- exact IDs, labels, logos, API family, and active state;
- public `model_client` and `api_standard` projections;
- structured-output transport and supported kind;
- reasoning effort normalization and validation;
- complete versus requestable native tools;
- short/long-context pricing and explicitly missing rates;
- SQL seed parity with the Python serializer;
- seed reruns that keep owner rows, `hidden` flags and `early_compaction`
  values and retire removed built-ins;
- adapter request shape per compatibility option and terminal stream behavior;
- direct-turn selection, capability rejection, persistence, and API-standard
  fencing;
- anima chat-profile and `chat:sse` request overrides.

Useful backend validation from the repository root:

```bash
uv run pytest -q \
  tests/test_model_provider_catalog.py \
  tests/test_model_pricing.py \
  tests/test_model_client_registry.py \
  tests/test_direct_chat_turn_executor.py \
  tests/test_anima_chat_profile.py \
  tests/test_anima_chat_sse.py \
  tests/test_model_configuration_api.py \
  tests/test_model_connection_credentials.py \
  tests/test_model_connection_probe.py \
  tests/test_model_error_categories.py \
  tests/test_anthropic_model_provider.py \
  tests/test_anthropic_model_probe.py \
  tests/test_anthropic_messages_client.py

uv run ruff check
```

When public schemas or frontend behavior changes, also run from
`src/frontend`:

```bash
pnpm openapi-ts
pnpm packages:build
pnpm check
pnpm web:lint
pnpm web:test
```

### Local And Live Smoke Checks

After applying the seed:

1. confirm `GET /v1/model-providers` returns the new active row;
2. select it in the frontend and confirm the anima chat profile persists its
   exact ID;
3. send a turn and confirm the request uses that same `model_provider_id`;
4. verify structured speech/display output, emotion, gesture, optional TTS, and
   exactly one `run.completed` frame;
5. confirm the assistant row stores the exact provider/model snapshot and
   usage;
6. reopen the chat and confirm model restoration;
7. for Responses, confirm `openai_previous_response_id` advances and the next
   turn continues successfully;
8. exercise every advertised reasoning effort and requestable native tool;
9. run an opt-in real-provider smoke for structured output, tools, continuation,
   rate-limit/error classification, and terminal stream handling.

Use `ANIMAMA_LLM_SKIP=1` for local flow checks that must not call providers.
Opt-in paid provider smokes live in `tests/live/`; their
[README](../../../tests/live/README.md) lists the keys, cost and commands.
Never use production credentials in tests or commit provider secrets, raw
responses, user content, tool arguments, or sensitive stream previews.

## Common Failure Modes

- **The model is in Python but absent from the UI:** the database seed was not
  regenerated or applied, or the row is inactive.
- **A row is in the database but not in a chat picker:** it is hidden, an
  embedding row, on a removed connection, an owner row outside a composition
  whose `ModelCatalogPolicy` enables owner models, or an Anthropic built-in in
  a composition whose policy exposes only the OpenAI connection.
- **`GET /v1/model-providers` returns `503 model_catalog_unavailable`:** the
  catalog query failed; check the database and backend logs.
- **The selector shows the row but send is blocked:** the provider type has no
  supported API-standard profile, the active chat uses another standard, or an
  owner row has no context window.
- **Setup returns 400 before SSE opens:** the row is not an active chat row, its
  connection is inactive, an owner row lacks a context window, a Responses row
  is on an owner connection, an Anthropic Messages row is off the Anthropic
  connection, or a persisted capability does not cover streaming, structured
  output, reasoning, or native tools.
- **The provider rejects the request:** capability metadata is broader than the
  model actually supports, the connection's compatibility options send a field
  the server rejects, or the SDK/request translation needs updating.
- **A Responses turn loses continuity:** inspect the chat cursor, terminal
  response ID, incognito/store behavior, stale-cursor retry, and manual-history
  serialization.
- **Costs are missing or misleading:** verify the service-tier mapping,
  long-context threshold, cached-token rates, and any provider pricing
  dimension the current schema cannot represent.
- **A frontend change disappears after regeneration:** generated client files
  were hand-edited instead of changing the FastAPI schema or generator input.

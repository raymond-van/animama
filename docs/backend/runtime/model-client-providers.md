# Model Clients And Providers

Normal `POST /v1/animas/{anima_id}/chat:sse` turns use shared direct model
clients. The boundary accepts a prepared prompt, provider options and
continuation state, then emits normalized deltas and sanitized observations.

## Direct Chat Boundary

Direct chat resolves model selection in this order:

1. request `model_provider_id`, when present
2. `anima_chat_profiles.default_model_provider_id`

The selected ID must name an active chat row on an active connection whose
capabilities support the requested turn; [direct chat](chat.md#request-contract)
lists the owner-row rules. Setup errors happen before the SSE
stream opens, so callers receive a normal HTTP error instead of a partially
opened stream.

`DirectChatTurnExecutor` owns the app-layer turn:

- verifies chat ownership through `ChatManager`
- fetches visible chat history and active compaction context
- opens direct-chat memory context for anima identity
- assembles one OpenAI Chat Completions-compatible prompt
- attaches scoped memory tools when request options, the row's tool support and
  its `allow_memory_writes` flag allow them
- builds a provider-neutral `ModelClientRequest`
- invokes the selected shared model client
- executes bounded request-local memory tool loops when the model asks for them
- parses the `main_structured_response` JSON envelope
- emits `user.response`, `avatar.gesture.requested`, `emotion.update`,
  and `error` domain events
- persists user and assistant chat messages through `ChatManager`

The public `run.completed` SSE frame is formatted by `product_http/chat/stream.py`. The shared
`app/chat/completion.py` sequence flushes safety/emotion events, TTS, title and
compaction before invoking that completion callback once. Incognito skips title
and compaction; memory-update switches remain the executor's responsibility.
Compositions supply authorized effect callbacks and cancel them on disconnect. Model clients never create chats or write SQL
rows directly.

## Shared Model Clients

The provider-neutral contracts live in `src/backend/animama/app/model_clients/types.py`.
The implementations live under `src/backend/animama/adapters/model_clients/`.
Provider SDK types (OpenAI and Anthropic) stay inside those adapter modules.
Chat Completions is organized under `openai_chat_completions/` with separate
modules for the SDK client lifecycle, request kwargs, typed chunk events,
streamed tool-call aggregation, and usage conversion. Responses follows the
same package pattern under `openai_responses/`, and Anthropic Messages under
`anthropic_messages/` (client, request, stream events, final, errors, the
Models API probe and strict-schema conversion).

Registered provider families are:

- `OpenAIHTTPAgent`: OpenAI Chat Completions via the OpenAI Python SDK, for
  every model connection
- `OpenAIResponsesHTTPAgent`: OpenAI Responses via the OpenAI Python SDK, on
  the built-in OpenAI connection only
- `AnthropicMessagesHTTPAgent`: Anthropic's Messages API via the official
  `anthropic` Python SDK (`adapters/model_clients/anthropic_messages/`), on the
  built-in Anthropic connection only; see [Anthropic Messages](#anthropic-messages)
- `ChatGPTPlanResponsesHTTPAgent`: OpenAI Responses through the owner's
  ChatGPT plan sign-in, on the built-in `chatgpt_plan` connection only; see
  [ChatGPT plan Responses](#chatgpt-plan-responses)
- `MockModelClient`: deterministic local/test model client

Provider type names, including their `Agent` suffixes, are durable catalog
identifiers.

The public model-provider catalog also reports a nullable chat compatibility
profile for each row. `OpenAIHTTPAgent` maps to
`model_client="openai_chat_completions"` and
`api_standard="chat_completions"` on every connection.
`OpenAIResponsesHTTPAgent` and `ChatGPTPlanResponsesHTTPAgent` map to
`model_client="openai_responses"` and `api_standard="responses"`, so a chat
moves between key and plan Responses models. `AnthropicMessagesHTTPAgent` maps to
`model_client="anthropic_messages"` and `api_standard="anthropic_messages"`, so
an Anthropic chat and an OpenAI chat never share history.

`chat:sse` treats `api_standard` as the compatibility key for one persisted
chat. A new or empty chat records the selected row's `api_standard` before any
provider call. Successful non-incognito turns then update
`chats.last_model_provider_id` from the row ID,
`chats.last_model_client` from the selected catalog row's `model_client` and
`chats.last_model_id` from the selected model slug in the same chat-row update
that records usage and advances turns. Later requests can switch to another
catalog row with the same `api_standard`, but a different standard is rejected
with `409 chat_api_standard_mismatch` before local history, Responses cursors,
memory side effects, or upstream model clients are used. Rows whose provider
type has no compatibility profile fail setup with
`chat_api_standard_unsupported`.

Server startup builds the app-scoped registry in `server/model_clients.py`.
Clients may hold reusable SDK or HTTP resources. They must not store
request-local anima, user, chat, run, prompt, memory, structured-output, or
tool state. Provider invocation state must come from `ModelClientRequest`;
route/runtime bookkeeping stays in the prepared direct chat turn and executor.

Model clients stream `ModelClientDelta` values across the provider-neutral
boundary. The supported delta kinds are:

- `text_delta`: public assistant text that can contribute to the final
  structured response
- `event`: internal provider observations represented by typed `MC*` event
  dataclasses from `app/model_clients/event_types.py`
- `run_status`: provider-side work to show while the reply is pending (an
  Anthropic-hosted web search or server compaction); the executor forwards it
  as a `run.status` frame, and every `started` is followed by `finished`
- `final`: the authoritative `ModelClientFinal` for one provider call
- `error`: stream-level provider failure
- `done`: successful adapter completion after the final value

The `event` deltas are ordered with text/final deltas but are not public
`chat:sse` frames. They preserve provider facts such as finish reasons, usage,
assistant phases, native hosted tool activity, terminal events, and unknown
provider events. `app/model_clients/event_summary.py` records a sanitized
request-local summary for direct chat persistence and warnings through
`app/model_clients/event_sanitizer.py`; raw provider event payloads are not
persisted.

`ANIMAMA_OPENAI_RESPONSES_COMPACTION_THRESHOLD_TOKENS` controls native
server-side auto-compaction for `OpenAIResponsesHTTPAgent` Responses create
requests. It defaults to `90000`. Values less than or equal to zero disable
the `context_management` payload. When enabled, the adapter sends
`context_management: [{"type": "compaction", "compact_threshold": ...}]`; the
OpenAI server decides whether to compact based on the rendered token count.
Without that payload, the executor fits Responses prompts to the row's
[context window budget](#context-window-budget). Chat Completions rows have no
provider-side compaction; they use that budget and the local post-response pass
described under [prompt-only maintenance calls](#prompt-only-maintenance-calls).

When `ANIMAMA_LLM_SKIP=1`, startup registers `MockModelClient` for all direct
provider families so local chat can run without upstream API keys. Mock mode is
all-or-nothing for direct provider families.

### Images

A prompt never holds image bytes. A user message with images has a part list:
one `model_client_image` part per image (`file_id`, name, width, height),
then its `text` part (`app/model_clients/image_parts.py`). The executor loads
the referenced bytes into `ModelClientRequest.images` just before each
request, and each adapter walks the parts with `resolved_parts`, which turns
an image without bytes into its `[Image: name]` placeholder:

- **Responses:** `input_image` parts with a `data:` URL and `"detail":
  "auto"`, then `input_text`. A cursor request sends only the new message and
  its images; a request without one, which includes every ChatGPT plan
  request, replays the history's kept images too.
- **Chat Completions:** `image_url` parts with a `data:` URL, then `text`. A
  message left with text only (every image a placeholder) is sent as one
  string, for OpenAI-compatible servers whose templates expect string content.
- **Anthropic Messages:** base64 `image` blocks, user messages only, then
  `text` blocks.

The `anthropic` and `openai` SDK loggers stay at INFO even with
`ANIMAMA_DEBUG`, because their DEBUG output prints request bodies with the
base64 images. The operator crisis moderator reads the turn's text only.

## Connections And Credentials

Every catalog row belongs to a model connection
([model catalog](../model-catalog.md#connections-and-row-ownership)). A request
goes only to the row's connection base URL, with only that connection's key and
timeout. `app/model_clients/credentials.py` resolves keys, and
`adapters/model_clients/openai_chat_completions/connection_sdk.py` builds SDK
clients from them.

Keys live in the process's runtime credential store
(`app/model_clients/credential_store.py`, instance in
`server/runtime_credentials.py`). Startup loads the allowed names below, plus
`ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY` and `GEMINI_API_KEY` for the built-in
Anthropic connection and voices, from the environment once; nothing reads keys from
`os.environ` afterwards. The embedded desktop backend then removes those names
from its environment, and Electron main replaces the store while it runs.

- **Per request.** `PinnedCredentialsMiddleware` pins the current snapshot
  for each HTTP request and WebSocket, and tasks the request starts inherit it.
  A request finishes on the keys it was admitted with; the next request uses a
  replaced key. Adapters resolve a key once per stream, run or probe and reuse
  it for retries and headers. Background loops read the latest snapshot per job.
- **No cached keys.** Long-lived SDK clients are built key-free by
  `base_client_for_connection`. `keyed_client` adds the key to a per-request
  view that shares the pool, so a removed key stops working on the next request.

- **Built-in `openai` connection.** Uses `OPENAI_API_KEY` and `OPENAI_BASE_URL`
  (default `https://api.openai.com/v1`). It is the only connection that runs
  `OpenAIResponsesHTTPAgent`: setup rejects a Responses row elsewhere, and the
  adapter refuses one with `responses_connection_unsupported`.
- **Owner connections.** `StoreModelCredentialResolver` reads only the
  key variable the connection names in `credential_env`. The name must
  be `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `HF_TOKEN`, `OPENROUTER_API_KEY` or
  match `ANIMAMA_CONNECTION_<NAME>_API_KEY`; desktop-managed keys use
  `ANIMAMA_CONNECTION_<ID>_API_KEY`. `ANTHROPIC_API_KEY` is reserved for the
  built-in Anthropic connection. An owner connection never falls back to a
  built-in connection's key.
- **Key origins.** `key_refusal` in `credentials.py` sends a provider variable's
  key only to its provider's origin (`PROVIDER_CREDENTIAL_ORIGINS`) and a
  connection key only to the origin in `ANIMAMA_CONNECTION_<NAME>_ORIGIN`
  (`key_origins.py` compares canonical origins). No such key goes over plain
  HTTP unless the host is this computer; the built-in OpenAI connection keeps
  the operator's `OPENAI_BASE_URL`. A refused key resolves as missing, with the
  reason in `ModelCredential.refusal`. A delivered origin that matches no
  address leaves only its own key unused.
- **Redirects.** httpx drops `Authorization` when a redirect leaves the origin,
  so the OpenAI SDK clients need nothing more. Clients that send a custom key
  header and follow redirects (Anthropic, Gemini and ElevenLabs) add the
  response hook in `adapters/key_redirects.py`, which refuses a redirect to
  another origin. The other keyed clients, such as web search, follow no
  redirects.
- **Isolation.** Owner-connection SDK clients omit the process
  `OpenAI-Organization` and `OpenAI-Project` headers and every header listed in
  `OPENAI_CUSTOM_HEADERS`, and set `Authorization` from the connection's own
  key. A keyless connection (no `credential_env`) sends no `Authorization`
  header. A preset's fixed `request_headers` are then added to every request
  (chat, probe and model listing); only `openrouter` has them, sending
  `X-Title: Animama` and `HTTP-Referer: https://animama.ai`.
- **Missing keys.** A named key that is not in the store fails the turn with
  `missing_api_key` (category `credential_missing`). Self-hosted backends read
  the environment only at startup, so restart them after changing a variable.
- **Timeouts.** Owner connections store their own timeout: 60 s by default for
  cloud presets and 300 s for local presets, because a first request may load a
  model. The built-in connections use `ANIMAMA_MODEL_CLIENT_TIMEOUT_SECONDS`
  (default 60). Chat Completions requests also cap connecting at 10 s
  (`connection_timeout`), so a stopped server fails quickly.
- **Built-in `anthropic` connection.** Uses only `ANTHROPIC_API_KEY`, always
  against `https://api.anthropic.com`; it serves only
  `AnthropicMessagesHTTPAgent` rows, and those rows live only there. Without
  the key a turn fails with `missing_api_key` ("No key is configured for
  Anthropic", category `credential_missing`) before any request. SDK clients
  are built with an explicit key and base URL and no SDK retries, so
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and other SDK credential
  sources are never used; the SDK still adds `ANTHROPIC_CUSTOM_HEADERS` from
  the process environment, which Animama never sets.
- **Built-in `chatgpt_plan` connection.** Its credential is the ChatGPT plan
  session's access token, which never enters the credential store; see
  [ChatGPT plan Responses](#chatgpt-plan-responses).
- **Clients.** `OpenAIHTTPAgent` caches one SDK client per connection.
  `OpenAIResponsesHTTPAgent` owns one OpenAI-only SDK client, and
  `ChatGPTPlanResponsesHTTPAgent` one key-free SDK client at the plan's fixed
  address with a per-request view that carries the session's token.
  `AnthropicMessagesHTTPAgent` keeps one SDK client per credential, keyed by a
  digest, so a replaced key builds a new client on the next request.

### Connection Presets

Presets (`app/model_connection_presets.py`) only fill defaults when the owner
adds a connection; every value except a preset's fixed request headers can be
changed afterwards. Local presets build their base URL from
`ANIMAMA_LOCAL_MODEL_HOST` (`127.0.0.1` by default, `host.docker.internal` in
Compose).

| Preset        | Default base URL                   | Key                                     | Timeout | Compatibility defaults                                                                                    |
| ------------- | ---------------------------------- | --------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `ollama`      | `http://<host>:11434/v1`           | none                                    | 300 s   | fold `developer`, no OpenAI extensions                                                                    |
| `lmstudio`    | `http://<host>:1234/v1`            | none                                    | 300 s   | fold `developer`, no OpenAI extensions                                                                    |
| `llamacpp`    | `http://<host>:8080/v1`            | none                                    | 300 s   | fold `developer`, no OpenAI extensions                                                                    |
| `vllm`        | `http://<host>:8000/v1`            | none                                    | 300 s   | fold `developer`, no OpenAI extensions                                                                    |
| `deepseek`    | `https://api.deepseek.com`         | expected; suggests `DEEPSEEK_API_KEY`   | 60 s    | fold `developer`, no OpenAI extensions, `reasoning_mode=deepseek_thinking`                                |
| `huggingface` | `https://router.huggingface.co/v1` | expected; suggests `HF_TOKEN`           | 60 s    | fold `developer`, no OpenAI extensions, no streamed usage, strip function `strict`, `reasoning_mode=omit` |
| `openrouter`  | `https://openrouter.ai/api/v1`     | expected; suggests `OPENROUTER_API_KEY` | 60 s    | fold `developer`, no OpenAI extensions                                                                    |
| `custom`      | none                               | optional                                | 60 s    | fold `developer`, no OpenAI extensions                                                                    |

DeepSeek models typically need the `json_object` structured-output mode, which
the probe selects when schema output fails. Hugging Face model IDs are sent
exactly, so a suffix such as `zai-org/GLM-5.2:deepinfra` pins the router's
inference provider. Without `stream_options`, servers usually stream no usage;
the adapter then estimates it (see [chat persistence](#chat-persistence)).

## Stream Event Finality And Observability

Provider adapters own upstream stream semantics and convert them into the
provider-neutral delta sequence. The direct chat executor consumes every delta
until it sees `final`, `error`, or adapter completion. It records `event` deltas
with `ModelClientStreamEventObserver`, attaches the compact
`stream_event_summary` to `ModelClientFinal.raw_provider_metadata`, and then
persists that metadata in assistant `message_data.model_client.raw_provider_metadata`.
For OpenAI Responses rows that include a final response ID, the same compact
summary is also copied into `message_data.openai.stream_event_summary`.

Normal INFO logs stay content-free unless preview logging is enabled. Preview
logging is off by default, including in Docker Compose. For local debugging, set
`ANIMAMA_MODEL_CLIENT_LOG_PREVIEWS=true` in the worktree `.env` (or the shell)
and rerun `./reset.sh`; selected model-client lifecycle logs then include
truncated prompt, response, tool argument, and tool result previews.
`ANIMAMA_MODEL_CLIENT_LOG_PREVIEW_CHARS` controls each preview length and
defaults to 240 characters. Preview logs are redacted for obvious secret shapes
but can still include user, memory, file, or tool content, and Compose persists
logs under `.animama-logs` for seven days, so turn previews off again after
debugging and never enable them in shared or hosted environments.

`stream_event_summary` can include:

- total event counts and counts by provider event type
- unknown provider event counts and warnings
- finish reasons
- whether usage was observed
- terminal completed/incomplete/failed events
- assistant message phases and output item summaries
- native hosted tool lifecycle summaries

OpenAI Chat Completions uses `client.chat.completions.create(..., stream=True)`
and normalizes SDK `ChatCompletionChunk` objects with typed helpers for
`Choice`, `ChoiceDelta`, `ChoiceDeltaToolCall`,
`ChoiceDeltaToolCallFunction`, and `CompletionUsage`. Choice index `0` is the
only public assistant output and tool-call source; additional choices are
recorded as unknown/multi-choice observations. The adapter emits finish-reason
and usage observations when those chunk fields appear, buffers text and streamed
function tool-call fragments, and emits `ModelClientFinal` only after the SDK
stream iterator closes. If no finish reason or usage appears, direct chat keeps
the turn behavior unchanged but records summary warnings such as
`missing_finish_reason` or `missing_usage`.
OpenAI-compatible servers may add choice or delta extras. On every connection,
`reasoning`, `reasoning_content` and `token_id` are private provider metadata:
they never become public text deltas, final assistant text, spoken text or
persisted chat content, and they do not raise unknown-provider warnings. A
choice-level `text` extra is used as content when `delta.content` is absent.

OpenAI Responses uses SDK `ResponseStreamEvent` variants and maps lifecycle,
output item, text, function-call argument, native hosted/tool-call, terminal, and
unknown events into `MC*` observations. Public chat text comes only from
unphased assistant output or assistant output with `phase="final_answer"`.
`phase="commentary"` and other intermediate provider text are observable
internally but are not public `user.response` text. The adapter emits a final
only for `response.completed` or the compatibility `response.done` event.
`response.failed`, `response.incomplete`, `error`, and SDK equivalents become
provider errors. If the stream reaches EOF without a terminal event, the adapter
emits an internal incomplete terminal observation and raises
`openai_stream_incomplete`; it does not persist partial text as a successful
assistant response. If a phased completed response never contains
`final_answer`, the adapter raises `openai_missing_final_answer_phase`.

Responses assistant `phase` is preserved for manual replay. Cursor-backed
Responses turns normally continue from `chats.openai_previous_response_id`, so
the provider retains previous assistant state. New chats and stale-cursor
fallbacks serialize local history instead; in that path the Responses adapter
reads persisted assistant phase metadata and writes valid assistant phases back
onto assistant input items. Chat Completions ignores Responses-only phase
metadata.

The Responses adapter also recognizes SDK `ResponseApplyPatchToolCall` output
items as executable app-layer work. Its lifecycle observations expose only the
call ID, status, operation type, and path length; the path and V4A diff are not
copied into sanitized provider metadata. Other hosted native tools remain
observations rather than app-executed calls.

## Anthropic Messages

Rows on the Anthropic connection share the `anthropic_messages` API standard,
so the [chat fence](#shared-model-clients) keeps their chats apart from OpenAI
chats both ways. `AnthropicMessagesModelClient` streams with the beta
`client.beta.messages.stream` (beta `compact-2026-01-12` on chat requests) and
JSON-shaped parameters built in `anthropic_messages/request.py`:

- **Positions.** The stable instructions are one `system` block; history and
  the user's new message follow; the turn context is a mid-conversation
  `system` message after the user turn. `cache_control` marks the system block,
  a replayed compaction block and the last history block. See
  [turn layout](prompt-caching.md#turn-layout).
- **Tools and output.** Memory tools become strict tools (`strict: true`)
  with `tool_choice: {type: auto, disable_parallel_tool_use: true}`, and the
  reply schema goes in `output_config.format` as strict structured output.
  `anthropic_strict_schema` (`anthropic_messages/schema.py`) rewrites JSON
  type lists such as `["string", "null"]` as `anyOf`, then the SDK's
  `transform_schema` moves constraints Anthropic's strict mode rejects
  (integer bounds, `maxItems`) into descriptions. Local validation still
  enforces the original schema on the reply and tool arguments.
- **Web search.** When the turn asks for web search and the row lists
  `web_search` in its native tools, the request adds Anthropic's server tool
  `{type: web_search_20250305, name: web_search, max_uses: 5,
  allowed_callers: [direct]}`. Anthropic runs the searches and bills each one
  to the owner's Anthropic account. Anthropic rows never get the
  [application web search](#application-web-search) tool. The stream reports
  `run.status` `searching_web` from a search's `server_tool_use` block to its
  result block. A result whose content is an error object (such as
  `max_uses_exceeded`) does not fail the turn.
- **Paused turns.** `stop_reason: pause_turn` (a long server-side search
  loop) is resumed by resending the round's content unchanged as the last
  assistant message, at most three times. The round's content, text and
  summed usage span every resumed response; after the third resend the round
  ends with what it has.
- **Compaction.** Every chat request sends `context_management.edits`
  `[{type: compact_20260112, trigger: {type: input_tokens, value: T},
  pause_after_compaction: false}]`. `T` is 150,000 (Anthropic's default),
  except on rows with a long-context price threshold whose owner left
  **Compact early** on: there `T` is 90% of the threshold, at least 50,000
  (90,000 for Claude Haiku 5.5). The stream reports `run.status`
  `summarizing_context` while the compaction block streams, and the reply
  continues from the summary. Usage sums every `usage.iterations` entry, so
  billing includes the compaction step. The provider metadata's
  `context_tokens` is the last iteration's footprint, which becomes
  `chats.active_context_tokens`. Application pre-send fitting and
  post-response compaction never run for Anthropic chats. Utility prompts
  (`provider_options.utility_task`) send no `context_management` and no
  compaction beta: a title or summary prompt is read whole, because its input
  is already bounded by the source chat's own trigger and compacting it would
  bill an extra step to summarize a summary.
- **Effort.** `none` sends `thinking: {type: disabled}` and no effort. Any
  other effort leaves adaptive thinking on and sets `output_config.effort`;
  requests never send a thinking budget. A request without an effort uses the
  role's default when the row offers it: `medium` for chat turns (at `low`,
  Claude Haiku 5.5 skipped needed memory-tool calls in live tests), `low` for
  Utility prompts and `medium` for
  [Memory Manager](../features/memory-manager-and-episodic-memory.md#live-anthropic-runtime)
  runs. The chat picker preselects the chat default from the catalog's
  `default_reasoning_effort` and sends it unless the owner picks another; see
  [reasoning capabilities](../model-catalog.md#reasoning-and-native-tool-capabilities).
- **Limits.** `max_tokens` is the row's output limit, capped at 64,000 per
  request (thinking included). Requests never carry sampling parameters or an
  assistant prefill.
- **Rounds.** After tool calls the final carries the round's content blocks
  (a compaction block, signed thinking, text, web-search blocks and
  `tool_use`) as a request-local continuation, and the next round resends them
  unchanged with the `tool_result` user turn. Forced-final and repair rounds
  keep the tools with `tool_choice: {type: none}` and put their instruction,
  ending with the guardrails, in a user turn.
- **Replay.** History alternates roles, merging same-role neighbours. Stored
  memory-tool exchanges replay as `tool_use`/`tool_result` blocks; thinking
  blocks, web-search blocks and earlier turns' context messages are never
  replayed. After a compaction, history starts at the newest assistant row
  whose stored content begins with a compaction block, however many rows
  back, and includes every later row
  (`ChatManager.get_chat_context(native_compaction=True)`). The API ignores
  content before that block, so older rows are not sent. Anthropic chats ignore
  `chat_compactions` summaries.
- **Stream.** Text deltas from text blocks are the only public text; thinking
  is never shown. A stream that closes before `message_stop` fails with
  `anthropic_stream_incomplete`.
- **Refusal.** `stop_reason: refusal` fails the turn with `model_refused`
  (category `provider_error`) after any streamed text, with the refusal
  category in `stop_details_category`; no assistant row is stored.
- **Truncation.** A `max_tokens` stop offers no tool calls, and its text goes
  through the usual [reply recovery](#reply-validation-and-recovery).

## ChatGPT Plan Responses

`ChatGPTPlanResponsesModelClient` (`openai_responses/chatgpt_plan_client.py`)
serves `ChatGPTPlanResponsesHTTPAgent` rows, the
[account-listed models](../model-catalog.md#chatgpt-plan-connection) of the
owner's ChatGPT plan ([ADR 0039](../../adr/0039-chatgpt-plan-sign-in-and-connection.md)).
Only the local composition registers it, with its sign-in session; a hosted
composition registers none, and `ANIMAMA_LLM_SKIP=1` maps the type to
`MockModelClient`. It is the Responses client with another `ResponsesRoute`
(`openai_responses/routes.py`): a profile of what one endpoint accepts, which
`request.py` and `client.py` read instead of asking which connection they
serve. The plan's route (`CHATGPT_PLAN_ROUTE`) differs from the API on a key
(`OPENAI_API_ROUTE`) as follows:

- **Unstored.** Every request sends `store: false` and no
  `previous_response_id`, so a plan turn reads no chat-row cursor and every
  request carries its whole input. A turn's tool rounds replay each earlier call
  and its output, without item ids.
- **Refused fields.** No inline `moderation`, no output limits
  (`max_output_tokens`, `max_tool_calls`) and no `context_management`. The
  client reports no native compaction, so the executor fits each prompt to the
  row's [context window budget](#context-window-budget).
- **Roles.** The leading system message is `instructions`, as on a key; any
  later system-role message is sent as a `developer` item, because the route
  refuses system-role input.
- **Tools.** Function tools are wrapped in one `namespace` tool named
  `animama`, and replayed `function_call` items name that namespace; a returned
  call keeps its own `name`. The route never gets `apply_patch`: memory edits
  use the function writers, and replayed `apply_patch_call` items and their
  outputs (a key model's native memory edits) are left out of the request. Hosted
  `web_search` is sent only for rows whose listing supports search; other plan
  rows can use the [application web search](#application-web-search).
- **Reasoning.** Requesting encrypted reasoning
  (`include: ["reasoning.encrypted_content"]`) and replaying each reasoning item
  before the call it led to, carried in the round's continuation, sits behind
  the profile's `replay_reasoning` switch, which is off: whether the route
  accepts a replayed reasoning item is unconfirmed. A round then replays its
  calls and their outputs only.

`prompt_cache_key` and `reasoning.effort` are sent as on a key.

Requests go only to the fixed `https://api.openai.com/v1`, whatever
`OPENAI_BASE_URL` says, through one key-free SDK client with no SDK retries
and no redirects. A request hook keeps only an allowlist of headers (plus the
SDK's `x-stainless-*` ones), so `OpenAI-Organization`, `OpenAI-Project` and
`OPENAI_CUSTOM_HEADERS` never reach the plan, and each request sets
`Authorization` from the session's access token. Every request this client
serves is the owner's own (a chat turn, its compaction or its title), so it asks
the session for an `interactive` token when the request starts; a session that
cannot give one fails the turn before anything is sent. Before any output:

- a 401 renews the token once and sends the request again;
- a temporary failure is retried twice, after 1 and 2 seconds, or after
  OpenAI's `Retry-After` when it asks for at most 10 seconds; a longer wait is
  reported with the failure.

Once output has streamed nothing is retried, and no plan request moves to
another connection. When the terminal event lists no output items, as after a
hosted search, the final takes them from the `response.output_item.done`
events. A completed response clears the usage-limit pause that the session keeps
for background work.

The plan's error codes (`subscription_sharing_*`) and the bare
`{"detail": "…"}` bodies its admission returns become these model-client codes
(the event's `code`) and [categories](#provider-behavior):

| Code | Category | Cause |
| --- | --- | --- |
| `chatgpt_plan_usage_limit` | `usage_limit` | The plan's usage limit; also pauses background use of the plan |
| `chatgpt_plan_not_eligible` | `not_eligible` | The account's plan does not include this use |
| `chatgpt_plan_unavailable` | `server_error` | Plan usage is temporarily unavailable, or the session could not be read or renewed for the moment |
| `chatgpt_plan_unsupported_request` | `bad_request` | The route refused the request, including a 400 with only a `detail` body; the route's sanitized reason is the `provider_error_message` |
| `chatgpt_plan_sign_in_required` | `sign_in_required` | No signed-in account, tokens OpenAI rejected, or a 401 after the renewal |
| `chatgpt_plan_use_not_granted` | `sign_in_required` | The account is signed in without plan use |

A refusal that names `context_length_exceeded` keeps `openai_bad_request`
(category `context_exceeded`), so the executor's oversized-prompt handling
still applies. Provider error text is sanitized as on every OpenAI connection,
which also redacts JWT-shaped strings, and the plan client removes the
request's own token from every error field.

## Context And Structured Output

`DirectChatPrompt` is the app-layer model-client prompt contract: an OpenAI
Chat Completions-compatible `messages` list plus request fields such as
`response_format`, `stream_options`, `prompt_cache_key`, `reasoning_effort`,
`tools`, `tool_choice`, and `parallel_tool_calls`.
`DirectChatPromptAssembler` builds exactly one system
message at `messages[0]` with Markdown sections for stable core companion
guidance (which names no Anima), a "Your name is …" line with the Anima's display
name followed by the raw current anima identity markdown, stable memory guidance, and
structured-output guidance selected from the persisted `model_providers`
capability row. Schema-backed `json_schema` rows receive the shared response
guidelines because the actual schema travels in
`DirectChatPrompt.response_format`; `json_object` JSON-mode rows and rows
without a structured transport (which get no `response_format`) receive those
guidelines plus the dumped schema and example object because nothing enforces
schema adherence. The identity section
contains only file content rather than file path, status, revision, or
fingerprint details. Anima profile columns, `metadata.direct_chat`, and pinned
user profile content are not prompt sources. The system message ends with the
server-owned
[Companion Guardrails](../../adr/0008-non-overridable-companion-guardrail.md).
One request-local `developer` message sits immediately before the latest user
message when the turn has context: the user-scope memory file map (when memory
influence is enabled) and the attached-file list. An app compaction summary is
a `developer` message directly after the system message. The Anthropic adapter
sends that turn-context message as a mid-conversation `system` message after
the user's message instead, and Anthropic rows delimit the identity and
`MEMORIES.md` with XML tags, add a tools-first line to the shared response
guidance and describe that turn-context message
(`app/chat/anthropic_instructions.py`); their Speech section keeps asking for
audio tags sparingly (`app/chat/speech_tags.py`). The
[turn layout](prompt-caching.md#turn-layout) describes each provider path and
its cache breakpoints.

Model clients receive the same prompt contract. Chat Completions requests are
shaped by the row's connection compatibility options
(`ModelConnectionCompatibility`, stored in `model_connections.compatibility`
and edited under Advanced in App Settings). The built-in OpenAI connection uses
the defaults: no folding, every field sent and `openai_effort`.

- `fold_developer_role`: send no `developer` messages. The row's
  `supports_developer_role` is then false, so the prompt assembler puts the
  turn context in a `<turn_context>` block at the start of the user message, which the system message describes, and folds a compaction
  summary into the system message before its closing guardrails. The adapter
  folds within-turn `developer` instructions (forced final, repair) into the
  end of the system message before dispatch. On by default for every
  non-OpenAI preset.
- `send_openai_extensions`: send `prompt_cache_key` and `parallel_tool_calls`,
  which some servers reject as unknown fields.
- `send_stream_usage`: send `stream_options` (`include_usage`).
- `strip_function_strict`: drop `strict` from function tool definitions while
  keeping the schema and Animama's local argument validation.
- `reasoning_mode`: `openai_effort` sends a supported effort as
  `reasoning_effort`; `deepseek_thinking` sends
  `extra_body={"thinking":{"type":"disabled"}}` for `none` and enabled thinking
  with a literal `reasoning_effort` for `high` and `max` (other values fail with
  `unsupported_reasoning_effort`); `omit` never sends an effort.

Whatever the options, a zero-argument function tool such as
`memory_list_files` is sent without its empty `required` list, as
`{"type":"object","properties":{},"additionalProperties":false}`. Groq's
strict validator rejects `properties: {}` beside `required: []`, and an absent
`required` means the same as an empty one.

JSON-mode rows (`structured_output_transport="json_object"`) receive
`response_format={"type":"json_object"}` whatever the connection.

### Reply validation and recovery

The executor validates each final reply locally
(`recover_main_structured_response`). A reply is valid when it contains a JSON
object with a non-blank `speech` string, even inside a markdown fence or prose.
Unknown keys are dropped; a missing or unknown tone becomes `neutral`, intensity
is clamped and an unknown gesture is dropped.

An invalid reply is recovered in this order, and the assistant row records the
outcome in `data.structured_recovery`:

1. **Salvaged** — speech from the invalid reply has already streamed. The
   streamed tone, gesture, speech and display become the reply, so no speech is
   repeated.
2. **Repaired** — otherwise one repair request is sent: the request that
   produced the reply, without tools, plus a repair instruction and the
   Companion Guardrails last. Chat Completions rows with a developer role also
   see the invalid reply as the previous assistant message. Rows that fold
   developer messages (every local preset) and Responses rows get the
   instruction alone, because a trailing assistant message is continued as a
   prefill and Responses resends the round from its own cursor. Usage covers
   both requests.
3. **Plain text** — the repair also fails, or its request errors. The
   model's text becomes speech (only its `speech` value if it looks like JSON;
   the invalid original's text if the repair has none), with
   `neutral` emotion, intensity 1 and no gesture, and is spoken by TTS.

Salvaged and plain-text rows store and replay a synthesized valid reply as
their `content`, so later turns do not learn to answer in plain text. Each
recovery logs `Direct chat structured reply recovered` with ids, the transport
and lengths, never message text. A reply with no speakable text fails with
`main_structured_response_parse_failed`. Memory changes made by the turn's
tool calls stay in every case.

`OpenAIResponsesHTTPAgent` sends only the stable system message as the
Responses `instructions` parameter, which ends with the guardrails. The turn
context, when there is any, travels as a `developer` input item before the user
item. If the chat row has an `openai_previous_response_id`, its `input` contains
only that developer item and the current user message, or the current turn's
function-call outputs, followed by any forced-final or repair instruction as a
`developer` item. The executor skips fetching local chat history for that
normal cursor-backed request. Each turn's context item stays in the stored
chain until native compaction.
Without a cursor, Responses input contains the remaining conversation messages
in the same order: user and assistant content become normal Responses input
messages, assistant function calls become Responses `function_call` items, and
tool rows become Responses `function_call_output` items. Persisted
provider-neutral native patch exchanges become typed SDK `ApplyPatchCall` and
`ApplyPatchCallOutput` items. This is the manual-context path used for new
Responses chats, incognito turns (`store: false`) and stale-cursor fallback; it
marks the last two history user messages as explicit cache breakpoints.
OpenAI SDK clients and provider
response objects stay inside adapter modules; application services persist only
domain data and JSON-safe metadata.

When memory tools are attached, the prompt sets `parallel_tool_calls` to
`false`. Read/search tools and function-tool writers use strict JSON-schema functions.
For `OpenAIResponsesHTTPAgent`, the adapter additionally sends typed SDK
`ApplyPatchToolParam(type="apply_patch")` when memory writes are allowed and the
selected catalog row advertises `apply_patch`. That request keeps read/search
functions and omits the two function-tool writers. The official OpenAI Responses row
for `gpt-6-luna` has that capability; Chat Completions rows retain JSON-schema
functions. `apply_patch` is
intentionally absent from the user-requestable generic `native_tools`
allowlist. Public catalog rows keep the complete capability in
`native_tool_support` and separately expose
`requestable_native_tool_support`; both that public projection and direct-turn
validation use the same backend allowlist.

`ModelClientFinal` can carry provider-neutral
`tool_calls`; OpenAI Chat Completions aggregates streamed tool-call
argument fragments before returning the final, while OpenAI Responses converts
Responses `function_call` and `apply_patch_call` output items into the same
provider-neutral call shape with an explicit tool type. Follow-up native results
become exactly one `apply_patch_call_output` per call ID. The app caches results
by call ID and explicit stale-cursor replay reuses the stored result instead of
executing the patch again.
Tool execution belongs to
`DirectChatTurnExecutor` and `DirectChatMemoryToolService`, not the provider
adapters.

Some servers reject a response format together with tools, or ignore the tools.
When a Chat Completions row's internal `tools_with_structured_output`
capability is false (set by the probe or the owner) and the turn offers tools,
direct chat splits the turn: tool rounds send tools without `response_format`,
then one structured round sends `response_format` without tools, built like
the forced final after the tool limit. Only the structured round streams public
text; the last tool round's unconstrained answer is discarded. Responses rows
never split.

Direct chat requires the canonical `main_structured_response` envelope. SSE
`user.response` events for structured turns carry
`response_format="main_structured_json"` and a `response_part` such as
`emotional_tone`, `speech`, or `display`. The OpenAI-facing schema requires all
main structured fields and represents absent optional values with
`gesture: null`/`display: null`; the parser normalizes `gesture: null` and
`gesture: ""` to no avatar gesture. Non-null `gesture` values are constrained
to the Gesture selectors in the Anima's mounted runtime snapshot. The backend
uses the parsed `emotional_tone`, `emotional_intensity`, and `gesture` fields to
drive avatar state and emits `speech` plus optional distinct `display` to the
UI. Persistence keeps the raw final structured JSON as one visible assistant
message instead of splitting speech and display into separate durable rows.

## Provider Behavior

`OpenAIResponsesHTTPAgent` continues prior Responses turns from the chat row's
`openai_previous_response_id`. If that chat-row cursor is null, direct chat
replays local visible history instead of sending `previous_response_id`.
Replayed history is at most the newest 200 rows after any active compaction,
counting stored tool calls and results; a window cut by that limit starts at its
first user message, so a tool result is never replayed without its call
(`ChatManager.get_chat_context`). Active
compaction summaries are part of that replayed local context. They are not
fetched or sent as Responses `input` on cursor-backed turns because the provider
request carries only the stable instructions, the turn context and user input
or function-call outputs, and `previous_response_id`. If OpenAI reports that the previous
response cannot be resolved, the executor fetches local history lazily and
retries the same provider call once with continuation removed. The retry uses
the manual-context serialization above, and a successful non-incognito final
response refreshes the chat-row cursor through normal persistence.

When companion crisis detection is effective, direct chat sets the provider
option `moderation_model` for `OpenAIResponsesHTTPAgent` rows only, and the
adapter sends `moderation={"model": "omni-moderation-latest"}` with the
Responses create request. The option is cleared on tool follow-up and forced
final requests, so only round 0, whose new input is the user's message, is
moderated. The adapter parses the completed response's input moderation into a
content-free `ModelClientFinal.input_moderation` (`status` `result` or `error`,
flagged categories and scores). Moderation is report-only: it never blocks or
alters the reply, and the executor only uses a self-harm signal to add a
[crisis card](chat.md#sse-events). Chat Completions, Anthropic Messages and
ChatGPT plan rows never receive the option; the plan's route refuses it.
Anthropic offers no moderation endpoint, so a
composition may check Anthropic turns with an operator
[crisis moderator](chat.md#companion-safety). Without one, as in the local
composition, Anthropic and Chat Completions turns rely on the Companion
Guardrails alone ([ADR 0023](../../adr/0023-native-anthropic-messages-provider.md)),
and so do ChatGPT plan turns, which the operator check never covers.

The Anthropic adapter classifies SDK errors and stream `error` events by
Anthropic's `error.type`, then the HTTP status, into `anthropic_authentication_error`,
`anthropic_permission_denied`, `anthropic_not_found`, `anthropic_rate_limit`,
`anthropic_overloaded`, `anthropic_server_error`, `anthropic_context_exceeded`
(prompt too long or request too large), `anthropic_quota_exceeded` (billing or
credit balance), `anthropic_bad_request`, `anthropic_timeout` and
`anthropic_connection_error`, with the same sanitized metadata and single
retry before any text.

Both OpenAI SDK adapters share one error classifier
(`adapters/model_clients/openai_errors.py`) on every connection. It maps SDK
exceptions and status codes into stable model-client codes such as
`openai_bad_request`, `openai_authentication_error`,
`openai_permission_denied`, `openai_not_found`, `openai_rate_limit`,
`openai_quota_exceeded`, `openai_timeout`, `openai_connection_error`,
`openai_conflict`, `openai_server_error`, `openai_overloaded`, and
`openai_previous_response_unresolvable`; connection failures before a request
use codes such as `missing_api_key` and `connection_unavailable`. An error the
provider reports inside a stream (the SDK's bare `APIError` for an `error`
event, or a Responses `response.failed` or `error` event) gets the code its
type or code would have as an HTTP error, for example `insufficient_quota` as
`openai_quota_exceeded` and an image error such as `image_too_large` as
`openai_bad_request`, and the adapter does not retry it (except a temporary
ChatGPT plan code that arrives before any output, which the plan client's
[bounded backoff](#chatgpt-plan-responses) retries); one whose type and
code are not recognized stays `openai_request_failed` or
`openai_stream_error`. The adapters
retry one request-local
time only for retryable failures before any downstream text delta has been
yielded (the ChatGPT plan client uses its own
[bounded backoff](#chatgpt-plan-responses)). Once text has streamed, the adapter surfaces the error without retry
so the runtime does not duplicate a partial generation. Error metadata exposed
through model-client errors is sanitized to provider/API/model, status code,
request ID, retryability, retry-after, provider error code/type/param, and a
redacted provider error message; raw provider response bodies and keys are
intentionally not carried into `chat:sse` details.

When direct chat emits the `error` event, `model_error_details`
(`app/chat/direct_turn/events.py`) adds a provider-neutral `category` from
`app/model_clients/error_categories.py` and names the connection:
`connection_id`, `connection_name`, `connection_preset` (also written to
`provider`) and, for connections other than the built-in one,
`connection_base_url`. The event `code` stays the adapter code on every
connection, so clients explain failures from `details.category`:

- `unreachable`, `timeout`, `server_error`;
- `credential_missing`, `credential_rejected`;
- `model_not_found`, `bad_request`;
- `context_exceeded`: OpenAI's `context_length_exceeded` code, a rejected
  request whose message matches known llama.cpp, vLLM or LM Studio wording, or
  llama.cpp's HTTP 500 "input is too large";
- `rate_limited`, `quota_exceeded`;
- `usage_limit`, `not_eligible`, `sign_in_required`: the ChatGPT plan's limit,
  an account whose plan does not include the use, and a sign-in or plan use
  that needs the owner ([ChatGPT plan Responses](#chatgpt-plan-responses));
- `provider_error` for any other code.

The connection probe also reports `invalid_base_url` and `unexpected_response`
(a reply that is not OpenAI-compatible).

The prompt `prompt_cache_key` is a SHA-256 scope derived from user ID, anima
ID, provider type, and model. This avoids mixing incompatible anima prefixes
while keeping repeated turns for the same user/anima/provider/model eligible
for provider prompt caching. Responses always sends it; Chat Completions sends
it only when the connection's `send_openai_extensions` option is on.

`native_tools` and `reasoning_effort` are request-scoped options validated
against the selected catalog row. Current direct support includes the
Responses-native and Anthropic server-side `web_search` tools for catalog rows
that advertise them; Chat Completions rows never advertise native web search
and use the [application web search](#application-web-search) tool instead. The Responses
adapter sends native web search with `search_context_size: "low"` by default. Anima
memory tools are separate app-layer function tools, supported for
`OpenAIHTTPAgent`, `OpenAIResponsesHTTPAgent`, `AnthropicMessagesHTTPAgent`,
`ChatGPTPlanResponsesHTTPAgent` and `MockModelClient` rows with tool calling. A row without tool calling runs the turn without memory tools
(and without attached-file search) instead of failing setup, and a row with
`allow_memory_writes=false` gets read tools only. The Responses adapter
converts the shared Chat Completions-style function schemas and tool-result
messages into Responses `function` tools and `function_call_output` input
items.

From GPT-5.4 on (OpenAI model IDs `gpt-5.4*`, `gpt-5.6*`, `gpt-6*`, such as
`OpenAIHTTPAgent:gpt-6-luna`), OpenAI's `/v1/chat/completions` accepts function
tools only with `reasoning_effort: "none"`. Leaving the field out does not help:
the model's default effort (`medium` on `gpt-6-luna`) applies and the request
fails with HTTP 400. On these Chat Completions rows:

- a turn that would attach memory tools with any other effort fails setup before
  the stream opens; application web search is left out instead
  (`reasoning_with_function_tools`);
- a request that carries function tools and names no effort sends `none`, on
  connections whose `reasoning_mode` is `openai_effort`. Rounds of the same
  turn without tools (a separate structured-reply round or a forced final)
  still name no effort and get the model's default;
- the [Memory Manager](../features/memory-manager-and-episodic-memory.md#live-openai-agents-runtime)
  and the connection probe's tool step send `none`.

The rule lives in `chat_completions_tools_require_no_reasoning`
(`app/model_catalog.py`). For reasoning with tools, use the model's Responses
row.

## Prompt-Only Maintenance Calls

Title generation and chat compaction use `DirectModelPromptRunner`, which
resolves the Utility [model role](../../frontend/features/model-settings.md#default-models)
(the App Settings choice, then `ANIMAMA_DEFAULT_UTILITY_MODEL_PROVIDER_ID`,
then the default chat model) and invokes the same shared model-client registry.
It sends a requested `request_options` reasoning effort only when the row
supports that effort, and marks the request `utility_task`, so adapters apply
their Utility defaults (on Anthropic rows: effort `low` and no server-side
compaction). These prompt-only calls are separate from the primary
anima turn, do not stream to the frontend, and persist usage only where their
service owns durable state, such as `chat_compactions`.

After a successful non-incognito Chat Completions or ChatGPT plan turn, the local
post-response compaction pass runs when `chats.active_context_tokens` reaches
the smallest of `ANIMAMA_CHAT_COMPACTION_THRESHOLD_TOKENS` (default 90000), 70%
of the model's context window, and 75% of the window left after the reply
reserve. The last bound matters only for rows with a large reply reserve; it
keeps this pass ahead of the 90% pre-send trigger. Each compaction rewrites
the summary that heads the cached history, so the trigger is set high. Primary `chat:sse` turns that use
`OpenAIResponsesHTTPAgent` or `AnthropicMessagesHTTPAgent` skip the local pass
and rely on the provider's server-side compaction instead.

### Context window budget

Rows with a context window never receive a prompt larger than it
(`app/chat/direct_turn/context_fit.py`, `app/model_clients/context_budget.py`),
with two exceptions. A client that asks its provider to compact relies on
server-side compaction: a Responses client with a positive compaction threshold
and the Anthropic Messages client report `native_context_compaction`. A turn
that continues from a stored provider cursor (`openai_previous_response_id`)
sends no local history, so it is not
fitted either. Any other Responses turn without native compaction (threshold
`0`, a composition that omits it, or a ChatGPT plan row) is bounded like Chat
Completions:

- **Budget.** Available tokens are the window minus the row's
  `max_output_tokens`, or minus a quarter of the window (at most 4096) when
  the row records none. Prompts are estimated offline and conservatively: ASCII
  at four characters per token, every other character as one token, over the
  messages, tools and response format. An image counts
  `min(ceil(w/28) × ceil(h/28), 4784)` tokens from its stored size, the larger
  of the Anthropic and OpenAI patch counts.
- **Pre-send compaction.** Above 90% of available, the executor emits
  `run.status` `summarizing_context` `started`, compacts through the Utility
  role in its own session (`ChatCompactionService.compact_for_budget`, bounded
  by `ANIMAMA_CHAT_PRESEND_COMPACTION_TIMEOUT_SECONDS`, default 90), then emits
  `finished`. Incognito turns skip compaction.
- **Omission.** If the prompt still does not fit, or compaction failed or timed
  out, the oldest turns after the summary are left out of this request only
  (never deleted). History is kept in whole turns that start with a user
  message, so a tool call stays with its results, and it is fitted below the
  90% trigger to leave room for tool rounds. The warning log records counts,
  never content.
- **Too large.** When the instructions and latest message alone exceed the
  window, the turn fails with `error` code `context_window_exceeded` and
  category `context_exceeded`, before any model request.
- **Within the turn.** Tool results that would push the next round past the
  window become a `tool_result_too_large` tool error the model can react to.
  If even those errors do not fit, the model is asked for its final reply
  without tools and without that exchange; if that final would not fit
  either, the turn fails with `context_window_exceeded`. A structured-reply
  repair leaves out the invalid reply when it would not fit, and is skipped
  (plain-text fallback) when it still would not. A server that still rejects the
  first request as oversized gets one retry with about half of the history
  left out.

Compaction input is itself bounded to the Utility model's window (oldest
messages beyond it are left out of the new summary), and both compaction
passes keep a user message together with its reply.

## Application Web Search

`native_tools: ["web_search"]` means "search the web" for any model:

- A Responses row, on a key or the ChatGPT plan, that advertises hosted
  `web_search` keeps hosted search.
- An Anthropic row uses only Anthropic's server tool (see
  [Anthropic Messages](#anthropic-messages)). A row without it runs the turn
  without search (`provider_without_native_web_search`).
- Otherwise, when the installation has a search backend and the row calls
  tools, the turn offers the application function tool `web_search(query)`
  (`app/web_search/`), also on turns without memory tools. The tool shares the
  memory tool round limit.
- Otherwise the turn runs without search and logs why (`no_backend`,
  `model_without_tools`, `provider_without_function_tools`, or
  `reasoning_with_function_tools` for an effort other than `none` on Chat
  Completions models that accept function tools only at `none`) instead of
  failing setup.

Backends are SearXNG (`GET {base_url}/search?format=json`, the instance's
`search.formats` must include `json`) and the Brave Search API
(`X-Subscription-Token`), in `adapters/web_search/`. Queries go only to the
configured backend. A result is a title, URL, snippet (at most 600
characters) and date; a call returns at most five. A backend failure becomes
a tool error (`web_search_<category>`) the model can explain, never a turn
failure. While a search runs, the turn emits `run.status` `searching_web`
`started` and `finished`.

The model sees full results within the turn. The persisted tool-result row
keeps only the query and each result's title and URL: Brave allows only
transient storage of results, and one rule covers both backends. Settings are
the local-only [web search routes](../architecture/http-api.md#web-search);
the backend reads its key from `ANIMAMA_CONNECTION_WEB_SEARCH_API_KEY` or
`BRAVE_SEARCH_API_KEY`, and model connections cannot read the former.

## Chat Persistence

Normal direct `chat:sse` turns persist messages through `ChatManager` unless
dispatch options mark the turn incognito. Assistant messages store a lightweight
`model_provider` and `model` snapshot, without a foreign key, so later catalog
changes and model removal do not rewrite history. Assistant usage is added
eagerly to the parent chat's cumulative usage counters.

When a Chat Completions stream reports no usage, the adapter estimates it at
about four characters per token over the serialized request and reply, and
marks the provider metadata with `usage_estimated` (and `usage_missing`). A turn
with tool rounds or a split structured round bills the sum of every request,
while `context_tokens` in the provider metadata records the last request's
footprint; `chats.active_context_tokens` uses that footprint, so estimated or
multi-request turns still trigger post-response compaction at the right size.

Direct chat also persists a raw Chat Completions-style `raw_provider_message`
for each durable row used in model replay. User rows store `role: "user"`
(with image references in a part list when the turn had images, never
bytes),
tool-call rows store the assistant `tool_calls`, tool-result rows store
`role: "tool"` plus `tool_call_id`, and final assistant rows store the raw
structured JSON as assistant `content`. Tool-assisted successful turns persist
compact internal assistant/tool rows for memory tool calls and tool results
before the visible assistant message. Public history readers hide internal rows
by default and project final assistant JSON back to display or speech text; chat
search indexes that user-facing projection.

The same non-incognito `ChatManager.record_turn` transaction also merges the
latest direct-chat memory fingerprints into
`chats.metadata.memory_context`. The manifest records opened file paths,
statuses, revisions, SHA-256 values, kinds, run metadata, and reserved message
turns. Incognito turns may read memory context for model setup but do not update
chat metadata.

For `AnthropicMessagesHTTPAgent`, the final assistant row stores
`raw_provider_message` as the turn's latest compaction block, when the server
compacted, followed by the reply's text block (`{"role": "assistant",
"content": [{"type": "compaction", ...}, {"type": "text", ...}]}`). It also
stores `data.anthropic`:

- the message id, stop reason and refusal `stop_details` when present;
- this round's usage, including any `iterations` and `web_search_requests`;
- the turn's billed searches across all rounds as top-level
  `web_search_requests` (failed searches are not billed);
- the response's block types and `pause_turn_continuations`;
- the turn's searches as `native_tool_summaries` (query, then result titles
  and URLs or an `error_code`);
- text `citations` (URL, title and cited text).

Sources are stored, not displayed, and encrypted search content is never
stored. Hidden tool rows store `anthropic_tool_use` and
`anthropic_tool_result` items. Usage counts input as
uncached plus cache-read plus cache-write tokens, with cache reads as cached
input and cache writes in `cache_write_tokens`; thinking tokens are reasoning
tokens.

For `OpenAIResponsesHTTPAgent`, assistant rows may contain compact
`data.openai` metadata such as response IDs and request cursors. The parent
chat's `openai_previous_response_id` advances only from Responses assistant
turns that include a final response ID. Persisted assistant turns of any other
provider type, ChatGPT plan rows included (they store no `data.openai`), clear
the cursor during the same chat-row update that reserves turns and updates
usage. Incognito Responses turns send `store=false` upstream and do not advance
the local Responses cursor.

The same successful non-incognito chat-row update stores the last durable model
snapshot for frontend restore: `chats.last_model_provider_id` is the exact
catalog row ID, `chats.last_model_client` is the row's model-client profile
(`openai_chat_completions`, `openai_responses` or `anthropic_messages`), and
`chats.last_model_id` is the model slug such as `gpt-6-luna`. The frontend
restores by row ID, since several connections can serve the same model slug,
and falls back to the client and slug only for chats without a row ID.

## Adding Provider Support

Follow [Adding AI model support](adding-ai-models.md) for catalog, adapter,
registration, schema, and validation changes.


## Composition-owned provider admission

`app/model_clients/call_boundary.py` supplies `AccountedModelClient` for a
request-scoped registry. Its boundary reserves first and returns an
`AdmittedModelCall` with authenticated owner, root operation, unique call ID and
bounded request. The composition owns policy, durable receipts and replay
rejection. Use that same scoped registry for the direct turn and
`DirectModelPromptRunner` (titles and compaction), so each nested invocation
enters admission independently. A retry is another invocation and reservation.
Do not put a request-scoped boundary into a process-global registry.

`ModelCallLimits` caps output and the whole stream's elapsed time. Bounded
adapters disable their internal retries and OpenAI SDK retries. Responses also
sends `max_tool_calls` when native tools are admitted; this is a limit across all
built-in calls, not a per-tool budget. Anthropic Messages caps `max_tokens` and
the web search tool's `max_uses` on each request, uses the limits' timeout and
never retries. A turn paused during server-side search (`pause_turn`) is still
resent, at most three times, so these caps apply per request rather than across
the invocation; hosted compositions offer no Anthropic rows. Admission may
narrow `native_tools` before dispatch. The composition must reject
provider/model combinations that cannot honor its controls rather than drop a
limit. Local calls without limits preserve their existing request and retry
behavior.

Only `ModelClientFinal.usage_reported=True` establishes measured token usage.
Estimates, missing finals, errors, timeouts and cancellation never imply a zero
charge. The boundary persists the outcome before forwarding a final delta;
failed settlement leaves recovery responsible for the existing reservation.
Cleanup and settlement each have a finite cleanup deadline; a stalled provider
close cannot hold the request forever. A rejected admitted request reports
`not_dispatched` before any provider call, allowing a composition to release it.
Provider pulls share one absolute deadline. A slow consumer does not receive
task cancellation while handling a yielded delta; its next pull checks the
same deadline and times out before reading more provider data if it has expired.
`unmeasured_native_tools` remains explicit even with known token counts: these
adapters do not provide authoritative non-token billing receipts. A composition
must reserve/reconcile those units separately. Counting streamed tool events is
not proof of a provider invoice.

`ConnectionEmbedder.embed_texts_with_usage` exposes vectors and optional measured
usage; `EmbeddingLimits` bounds batch input/deadline and disables SDK retries.
Input over the bound fails before dispatch with `model_input_limit_exceeded`
(category `context_exceeded`), and the deadline with `model_deadline_exceeded`
(`timeout`), both as model-client errors.
Compositions wrap **each** embed call, including tool-driven retrieval, with
admission. `WebSearchBackend.search` is already an injectable per-search boundary;
its result list contains no provider billing receipt, so a paid implementation
must retain uncertainty or reconcile its own authoritative receipt.

`OpenAIAgentsMemoryManagerRuntime` accepts a `model_wrapper(model, run)` applied
to the actual Agents SDK `Model`, including pinned-model approval resumes and
Reflection. Its wrapper must admit every `get_response`/`stream_response`, not
only the outer runner. `model_limits` disables SDK retries and sets output and
request timeout; `max_model_turns` caps each runner segment. The wrapper still
owns whole-call cancellation, input/tool admission, usage and root lifetime
across resumed segments. These seams grant no provider activation or quota policy.

The request controls follow the official [Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create),
[Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create),
[SDK retry controls](https://github.com/openai/openai-python#retries), and
[Agents model interface](https://openai.github.io/openai-agents-python/ref/models/interface/).

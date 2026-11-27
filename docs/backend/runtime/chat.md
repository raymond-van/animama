# Direct Chat SSE Runtime

`POST /v1/animas/{anima_id}/chat:sse` is the supported direct chat endpoint
for the normal avatar companion turn. It executes one direct model-client turn,
derives emotion updates from the primary response's structured metadata, and
persists the turn.

The route is shared by every composition ([ADR 0021](../../adr/0021-shared-product-http-routes.md)).
Implementation entrypoints under `product_http/chat/` are `stream.py` for the
stream lifecycle and the [chat-turn guard](#chat-turn-guard), `turn_setup.py`
for the owner checks and preparation, `sse_runtime.py` and `sse_events.py` for
frames, `session_services.py` for short-lived persistence, and
`app/chat/direct_executor.py` for model/tool execution. The composition supplies
the sessions, repositories, model clients, speech and policy through its ports;
the local ones are in `server/product_ports.py`.

## Request Contract

The route accepts `PyAnimaChatRequest`:

```json
{
    "message": "Hello",
    "chat_id": "optional-existing-or-client-id",
    "run_id": "optional-client-run-id",
    "model_provider_id": "optional-model-providers-id",
    "runtime_revision": "mounted-runtime-revision",
    "dispatch_options": {
        "main_structured_response": true,
        "incognito": false
    },
    "client_context": {
        "time_zone": "America/Toronto",
        "locale": "en-US",
        "ui_locale": "ja"
    }
}
```

`client_context` is optional. For companion safety, the IANA `time_zone` sets
the local calendar day for the AI notice (unknown or missing zones use UTC), and
the BCP 47 `locale` (the browser's) selects the crisis-resource region when the
owner has not chosen one. `ui_locale` is the UI Locale the client applied and is
the conversation language: a non-English supported locale adds a reply-language
section to the prompt and fills the turn's `tts.language_code` (ISO 639-1) for
ElevenLabs and Gemini; English and unknown values change nothing. Safety never
reads it ([ADR 0024](../../adr/0024-ui-locale-is-the-conversation-language.md)).

`message` is trimmed by the schema and must be non-empty. `chat_id` is the
thread identifier. The backend creates `chat-<uuid>` and `run-<uuid>` values
when the chat/run identifiers are omitted. The resolved chat ID is used for
durable chat lookup, persistence, and runtime events.
`runtime_revision` is required and identifies the persisted runtime snapshot
frozen by the mounted Anima route. Setup authorizes that exact owner/Anima
snapshot and returns `409` with `detail.code="runtime_remount_required"`
before provider selection or model usage when it is missing or expired. The
client remounts explicitly; it never silently retries a turn against a newer
loadout revision. Setup consumes the immutable typed catalog and Action
selector inventory persisted in that snapshot; it does not consult current
catalog revisions. The snapshot's bounded item-revision map protects later
file preparation, while already prepared browser bytes remain stable if a
source is subsequently edited.
`model_provider_id` is an optional stable catalog selector that must match
`model_providers.id`. When it is present, the backend validates that the row
exists, is an active chat row (`model_kind="chat"`) on an active connection,
supports streaming, and supports the requested reasoning effort and any
requested hosted native tool before the provider is invoked. Structured output
is not required (rows without a schema or JSON-mode transport are asked for
JSON by prompt), and `web_search` on a row without hosted search is the application
tool, offered or left out at turn time (Anthropic rows never get it). Owner-added
rows also need a context window. `OpenAIResponsesHTTPAgent` rows are valid only
on the built-in OpenAI connection, `AnthropicMessagesHTTPAgent` rows only
on the built-in Anthropic connection, and `ChatGPTPlanResponsesHTTPAgent` rows
only on the ChatGPT plan connection; each of the last two serves no other
rows. When it is
omitted, the route
requires an explicit `anima_chat_profiles` row for the anima. Missing
profiles fail setup before any upstream model call. Unsupported, inactive, or
unregistered provider IDs are rejected before model invocation. Accepted turns
persist the resolved assistant message `model_provider` and `model` snapshot
through the existing chat-message persistence path.

Direct chat also enforces the chat API standard recorded on `chats`. The first
model-backed `chat:sse` request for a missing or empty chat stores the selected
provider's `api_standard` on the chat row before memory context, history
replay, Responses cursor use, or upstream model invocation.
Subsequent requests may switch models only within the same `api_standard`, on
any connection. Requests that would switch between OpenAI Chat Completions
(`chat_completions`), OpenAI Responses (`responses`) and Anthropic Messages
(`anthropic_messages`) fail setup with `409` and detail code
`chat_api_standard_mismatch`. Rows whose provider type
has no direct-chat standard fail setup with `chat_api_standard_unsupported`.
`dispatch_options` reuses `PyAnimaDispatchOptions`, so the direct path
receives the same request-level controls used by chat settings: memory
influence, memory updates, emotion influence, emotion updates, incognito,
main-structured response, native tools, and reasoning effort. Direct chat
resolves boolean controls through the neutral
`app.chat.options.merge_chat_request_options`: explicit request values take
precedence over per-Anima settings and then owner defaults. Disabling memory
influence also disables memory updates, including across preference layers. Each
composition loads its owned settings before calling this shared policy.
Direct chat always
opens the anima identity file because it is anima configuration. With memory
influence enabled it also opens the Anima's `MEMORIES.md` and places it as
`# Anima Memories` directly after `# Anima Identity`, then the owner's
`PROFILE.md` as `# User Profile` and this Anima's recent `remember` notes from
other chats as `# Recent Notes` (see [Memory](../features/memory.md#current-direct-chat-boundary)).
A missing, blank or unreadable file is omitted without failing the turn. When
`disable_memory_influence` is true, direct chat still keeps anima identity
active; `MEMORIES.md`, the profile, the notes and the memory file list are omitted.
The turn context, placed just before the user message, holds the memory file list
and the attached-file list; a turn with neither sends none. The
[Companion Guardrails](../../adr/0008-non-overridable-companion-guardrail.md)
end the stable system instructions, once per turn.
Provider rows that expose `supports_developer_role: false`, such as rows on
connections with the `fold_developer_role` option (the default for non-OpenAI
presets), receive the same text in a `<turn_context>` block at the start of
the user message instead. Anthropic rows receive it as a mid-conversation
`system` message after the user message, because Anthropic accepts one only
after a user turn. See the [turn layout](prompt-caching.md#turn-layout).
Memory tools also depend on the selected row. A row without tool calling runs
the turn without memory tools or attached-file search instead of failing
setup, and a row whose owner turned off memory writes (`allow_memory_writes`)
gets read tools only.
The model catalog separates complete `native_tool_support` from
`requestable_native_tool_support`. Clients may send only the latter through
`dispatch_options.native_tools`; backend-owned capabilities such as memory
`apply_patch` are activated by server policy and remain invalid as explicit
request options.
When TTS is enabled, `dispatch_options.tts` can carry explicit provider intent.
ElevenLabs always speaks in realtime with `eleven_v4_turbo`;
`provider="gemini"` selects backend-pushed finalized audio, with a Gemini TTS
`model_id`. The optional `finalized_chunking` field accepts `"sentence"` or
`"paragraph"` and applies only to finalized audio; omitted or unsupported
combinations behave as `"sentence"`.

## Shared Model-Client Layer

The app-scoped `ModelClientRegistry` owns reusable provider transports. Each
turn supplies its selected row, prompt, options, and continuation state in a
`ModelClientRequest`; clients retain no owner, Anima, chat, or tool state.
`ANIMAMA_LLM_SKIP=1` registers deterministic clients for all provider families.

See [model clients and providers](model-client-providers.md) for connections
and credentials, request translation, Responses continuation and compaction,
retries, and stream finality. [Memory tools](../features/memory.md#direct-chat-memory-tools) defines
the function/native-patch boundary.

## Model selection

Anima creation writes its chat profile directly. Request-time model selection
uses an explicit `model_provider_id` or that profile's default; missing both
fails setup. Either selection must name an active direct model provider. The
catalog, including owner-added rows and model connections, is described in
[model catalog](../model-catalog.md); the owner manages it in
[App Settings → Models](../../frontend/features/model-settings.md).

## Chat Images

Local compositions accept images among a turn's `attached_file_ids`
([User Files](../features/user-files.md#chat-images) covers uploads). Setup
splits the IDs (`app/chat/attached_images.py`): ready images go with the user
message, other IDs stay document attachments. More than four images is `400`
`too_many_images`, an image that is deleted, failed or not ready is `400`
`attached_image_unavailable`, and any image for a row whose catalog
capabilities do not accept `image` is `400` `model_does_not_accept_images`,
all before the chat is created or anything is saved.

The saved user message refers to its images and never holds their bytes
([ADR 0038](../../adr/0038-chat-images-saved-as-references.md)):

- `content` is the person's text followed by one `[Image: name]` line per
  image, so memory, search and compaction see each image named.
- `data.images` lists each image (`file_id`, `name`, `width`, `height`) and
  `data.user_text` keeps the person's own text for the chat bubble.
- `raw_provider_message` holds a part list: the image reference parts, then
  the text, which later turns replay.

When building a prompt, `select_images` keeps the newest 20 images in the
fitted history, the current turn's first, and turns the rest into
placeholders; a row that does not accept images gets placeholders for all of
them. Context fitting counts each image's estimate. Before the turn's first
request that needs them, `SessionBackedChatImageLoader` reads the referenced
bytes of the owner's ready images from private storage; the turn's later
requests (tool rounds, a retry) reuse them. An image that is gone or whose
bytes no longer match its record is sent as its placeholder; a read failure is
logged by file ID, never with bytes. The adapters write the bytes in their
provider's format ([model clients](model-client-providers.md#images)).

Deleting a chat deletes the images only that chat's messages reference
([deletion](../features/user-files.md#deletion-and-recovery)).

## Step-By-Step Flow

1. The local HTTP boundary admits the request and resolves the installation
   principal. Setup validates Anima ownership and the issued runtime snapshot,
   then the composition [admits the turn](#chat-turn-guard), then setup
   validates chat ownership, model capabilities, and chat API-standard
   compatibility before opening SSE. It also resolves
   [companion safety](#companion-safety), which never blocks the turn.
2. The executor loads required `IDENTITY.md`, optional `MEMORIES.md` and
   `PROFILE.md`, recent episode notes, current
   memory/attachment navigation, and local history when the provider needs
   replay. It assembles
   the prompt, ending with the Companion Guardrails, and closes the setup
   database session before upstream streaming.
3. The route starts the request-local event bridge and model task, plus eligible
   title/TTS work. While the model task runs, it records the AI-notice decision
   and yields any `safety.ai_notice` frame before draining provider events. The executor runs bounded memory-tool rounds
   and validates the final structured response. At the tool limit, it makes one
   no-tools attempt to produce the final answer, restating the guardrail after
   the limit instruction; further tool calls fail the turn.
4. Structured speech/display can stream before completion. Final validation
   controls corrections, Gesture selection, emotion, and durable persistence;
   raw provider observations remain internal.
5. A fresh short-lived session persists non-incognito chat messages, tool rows,
   usage, model selection, memory fingerprints and the reply's memory block.
   Memory tool writes commit separately and survive a later model or
   final-parse failure. Eligible episode capture is best-effort after visible
   persistence; the executor then emits `memory.updated` when the turn
   remembered anything.
6. The route drains events, emits any saved title, waits for TTS and applicable
   compaction, then emits one `run.completed`. Cleanup settles request-local
   tasks without closing shared model clients.

See [memory](../features/memory.md), [user files](../features/user-files.md), and
[model clients](model-client-providers.md) for tool, prompt, and replay contracts.

## Chat-turn guard

A composition guards each whole turn through its ports. The local composition
admits every turn and its lease does nothing; a hosted one can reserve and
settle usage and recheck a session lease.

- **Admission.** `admit_chat_turn` runs after the Anima ownership and runtime
  revision checks and before anything is written or a model is called. A refusal
  (`ProductRefusal`, reported as `detail.code`, or the composition's own
  exception) ends the request with no chat created.
- **Checks.** The lease's `check` runs before each event the stream drains
  while the model runs (at least every 50 ms while the client keeps reading;
  a client that stops reading holds the stream at its next frame) and before
  each step and frame of
  a successful reply's completion (speech, title, compaction). A stop before
  the reply is saved cancels the model and ends the stream with `event: error`
  (`{"run_id", "error": <stop message>, "code": <stop code>}`, plus any denial
  fields the stop carries) and one `run.completed`. A stop after the reply is saved skips the remaining
  optional work, cancelling title and speech tasks still running, and ends with
  the normal `run.completed`.
- **Settlement.** `settle` runs exactly once, after every turn task has stopped,
  with `unstarted` (setup, or the composition's own commit of the setup
  session, failed after admission, or nothing was dispatched),
  `completed` (the reply was saved, or an incognito turn finished), `failed`
  (an error before the reply was saved) or `interrupted` (a stop or disconnect
  before the reply was saved). A refused turn has no lease to settle. A reply save that has
  begun finishes, within the five-second cleanup bound, even if the turn is
  stopped or the client leaves.
- **Denials.** A `ProductRefusal` or `ChatTurnStop` may carry `DenialDetails`:
  the hosted denial fields `limit`, `retry_after_seconds`, `max_characters` and
  `download_url`. A refusal raised while the turn runs (by a model request's
  call boundary, web search, or the composition's deferred commit of a turn
  write such as the reply save) ends the turn with `event: error` carrying its
  code and those fields, beside the code and again in `details`, then
  `run.completed`. A refusal before the stream adds them to its HTTP body, with
  `Retry-After` for a known wait on a 429 or 503 refusal.
- **Model work.** `ChatTurnServices.model_clients` serves the reply's rounds.
  Pre-send compaction, post-reply compaction and a first turn's title each ask
  `utility_model_clients(purpose)` for their own registry, so a composition can
  meter or limit them apart; `None` skips that work. A turn asks for every
  purpose before it knows which work it needs, so asking reserves nothing. The local composition
  returns its one registry for every purpose.
- **Server speech.** A composition that speaks ElevenLabs through its own socket
  returns a realtime session with `transport="server"` and its `websocket_url`
  instead of a provider token, and offers `ChatTurnServices.server_speech_text`.
  Once the turn's realtime session resolves as a server session, the turn
  hands it each speech piece in order, prepared as the browser prepares
  ElevenLabs chunks (emoji removed, `ProviderSpeechText("elevenlabs")`, the tone
  tag first), then `end` after the reply's last piece. `abort` follows when the
  turn stops, fails or loses its client, even after `end`. A direct, declined or
  failed session gets no text. A sink that raises is logged and the turn's
  cleanup goes on. Local sessions are direct, and its sink is `None`.

The composition's chat policy also sets title and compaction settings and,
optionally, `public_error_text`, which replaces the text and details of
`event: error` frames (a stop keeps its own message and a denial its fields)
and turns their codes outside
a short lowercase pattern into `turn_failed`. Speech error frames carry the speech port's own messages;
a speech port that declines a reply's speech raises `ProductRefusal`, and the
frame (`tts.session.error` or `tts.error`) carries its code.

## What It Deliberately Does Not Do

Direct chat runs one companion turn. Memory tools operate on user-scope files
plus the Anima's own `MEMORIES.md` (through `[self]/MEMORIES.md`), and cannot
edit Anima identity, move/delete files, or change arbitrary metadata. Workflow orchestration requires a separate API contract.

## Companion Safety

`product_http/chat/safety.py` and `app/safety/` own per-turn safety. The
user-facing contract is the [safety and crisis protocol](../../safety/crisis-protocol.md).

- **Companion Guardrails.** `COMPANION_GUARDRAILS` always ends the system
  instructions of every provider request, and the forced-final tool-limit and
  structured-reply repair requests restate it after their instruction. No
  setting disables it
  ([ADR 0008](../../adr/0008-non-overridable-companion-guardrail.md)).
- **Effective configuration.** Setup combines operator settings
  (`ANIMAMA_COMPANION_SAFETY_ENABLED`, `ANIMAMA_AI_NOTICE_ENABLED`,
  `ANIMAMA_AI_NOTICE_REMINDER_HOURS`, `ANIMAMA_CRISIS_DETECTION_ENABLED`,
  `ANIMAMA_CRISIS_RESOURCES_PATH`) with the owner's
  `user_settings.preferences.safety`. The global switch turns the AI notice,
  moderation and crisis card off together. Owners may choose
  `crisis_resource_region` and a `reminder_hours` value that applies only when
  it is shorter than the operator interval. Reminder hours must be 0.25–168,
  and an invalid resource table fails startup. Each operator override of a
  safe default logs a startup warning.
- **AI notice.** `app/safety/ai_notice.py` decides per owner principal, across
  Animas, under a `companion_safety_state` row lock. A `start` notice is due on
  the first turn of each local calendar day; a `reminder` is due once the
  reminder interval (default 3 hours) has passed since the later of the
  continuing interaction's start and the last notice. Turns less than 30
  minutes apart continue an interaction. If the state cannot be read or
  written, the notice is shown anyway.
- **Crisis detection.** For `OpenAIResponsesHTTPAgent` rows (OpenAI Responses
  on a key), round 0 requests
  [inline moderation](model-client-providers.md#provider-behavior). For
  Anthropic Messages rows, a composition may set `ChatTurnPolicy.crisis_moderator`
  (such as `OpenAIModerationCrisisModerator`, OpenAI's moderation endpoint with
  an operator key; the local composition sets none). It checks only the user's
  message text, alongside the reply; the turn waits at most 2 seconds after the
  reply, then cancels a pending check. A self-harm result from either emits one
  `safety.crisis_support` card after the reply text and before `run.completed`;
  a failed, errored or late check adds no card. Other turns get no crisis card;
  the guardrail's crisis rule still applies. ChatGPT plan turns are among them:
  the plan's route refuses inline moderation, and the operator check covers
  Anthropic turns only
  ([ADR 0039](../../adr/0039-chatgpt-plan-sign-in-and-connection.md)). Crisis
  resources resolve from the owner's region, then the `client_context` locale,
  then the fallback entry.

Crisis turns stream, persist and update memory like any other turn. Safety
code never logs message text or detection results (crisis frames are excluded
from SSE frame logging) and stores no detection results. Opt-in model-client
prompt previews (`ANIMAMA_MODEL_CLIENT_LOG_PREVIEWS`, off by default) can still
include the user message when enabled.

## SSE Events

The direct endpoint uses this frontend SSE contract:

- `event: tts.session`
- `event: tts.session.error`
- `event: tts.audio`
- `event: tts.done`
- `event: tts.error`
- `event: user.response`
- `event: emotion.update`
- `event: avatar.gesture.requested`
- `event: chat.title.updated`
- `event: safety.ai_notice`
- `event: safety.crisis_support`
- `event: memory.updated`
- `event: run.status`
- `event: error`
- `event: run.completed`

These are Animama domain/backend events, not raw upstream model-provider stream
events. OpenAI Chat Completions chunks, OpenAI Responses lifecycle events,
Responses assistant `phase` events, native hosted tool events, function-call
argument fragments, and unknown provider events are normalized as internal
model-client `MC*` events. They are logged and summarized for persistence, but
they are not forwarded directly to browser clients over `chat:sse`.

`user.response` frames include:

- `event_id`
- `run_id`
- `node_id`
- `text`
- optional `response_format`
- optional `response_part`
- optional `is_delta`
- optional `part_index`
- optional `part_final`
- optional `speech_tone_tag`, on the first speech frame of an ElevenLabs run
  ([audio tags](../integrations/voice-and-speech.md#audio-tags))

Main structured turns use one JSON shape: `emotional_tone`,
`emotional_intensity`, nullable `gesture`, `speech`, and nullable `display`.
All fields are required in the provider JSON schema, and the guidance asks for
`null` for an absent value. `gesture: null` (or `""`, which the parser also
accepts) means no avatar gesture; `display: null` means no separate visual
response. Gesture choices come from the Gestures equipped in the mounted
runtime snapshot. The provider schema's `gesture` enum is `null` plus those
selectors, and the response guidance appends an
`Available Gestures for this Anima:` block with one
`- {selector}: {description}` line per Gesture. The description falls back to
the Gesture's name when empty; the name is otherwise left out, because
selectors are usually readable semantic keys. When the described block's
conservative token estimate exceeds 10% of the model row's context window,
each line carries only `- {selector}`, leaving the window for history. A row
without a recorded window keeps the descriptions. Every request of a turn sends
the same block; it changes only with the model row's window or the loadout.
An Anima with no equipped Gestures gets a `null`-only enum and no block. Motion types, catalog
item or file IDs, storage locators, package manifests and resource URLs are not
sent to the model. The final parsed `gesture` is normalized and dropped unless
it matches one of the snapshot selectors.
Normal chat emits `response_format="main_structured_json"` and uses
`response_part="speech"` or `response_part="display"` for visible
`user.response` frames. Those visible parts may arrive as sentence-level stream
chunks with `is_delta=true`, increasing `part_index` values scoped to the
response part, and `part_final=true` on the final chunk or final empty marker.
A sentence ends at ASCII `.!?` followed by whitespace, except after common
abbreviations, initials and list numbers. It also ends at Japanese or Chinese
`。！？`, with any following marks and closing brackets or quotes. That end waits
for the next character that is not a mark or closer, so a run streamed one mark
at a time stays with its sentence (`domain/text_segmenter.py`). A mark inside
an audio tag that is still being written, as in `[sighs. long pause]`, ends
nothing.
The hidden `emotional_tone` event is emitted only after both
`emotional_tone` and `emotional_intensity` have been decoded, so request-local
state receives the paired delivery metadata before speech chunks arrive. The
stream parser also waits for the ordered `gesture` field to complete before
speech starts; gesture validation and the public `avatar.gesture.requested`
event still come from the final validated JSON.
If early semantic streaming is unavailable or the final parsed response differs
from the streamed chunks, the backend emits a full/correction frame with
`is_delta=false` and `part_final=true`. The tone and intensity parts are
backend-internal and filtered before `user.response` SSE reaches the browser.
Missing or blank tone metadata falls back to `neutral`; values outside the
allowlist are logged and ignored for Gemini's speaking style and durable
emotion updates.

When a run requests TTS, each main-structured `speech` segment is queued for
speech as soon as it is emitted, with its visible text as written in any
language, emoji dropped; providers read numbers and symbols themselves. Gemini
batches respell or drop the reply's audio tags
([audio tags](../integrations/voice-and-speech.md#audio-tags)), so `x < 5`
loses its stray `<` there. A segment without
letters or digits, such as a closing emoji, stays visible only. Empty
`part_final=true` speech markers close the segment stream without adding audio
text. If semantic deltas were unavailable, one complete non-delta `speech`
fallback is queued; if a complete correction arrives after speech deltas have
already been queued, it updates visible text only and is not re-spoken.

ElevenLabs speaks these segments in realtime through the browser's
`tts.session` socket. Gemini speech is finalized: the backend starts it as soon
as both the hidden `emotional_tone` and the first speech segment are available,
through the composition's `ChatTurnServices.gemini_speech` port, which the turn
reads only when the run asks for Gemini; where the port is `None` the run gets
no speech frames.

- **Sentence chunking**, the default, makes each prepared speech segment one
  upstream request.
- **Paragraph chunking** keeps sentence-level SSE unchanged while backend audio
  accumulates segments by paragraph, flushing when a new paragraph starts, when
  a batch reaches four sentence segments, when it reaches about 600 visible
  characters, or when the speech stream closes. Paragraph batches join the
  visible sentence text, emoji dropped and tags in Gemini's spelling.
  Before each paragraph batch after the first, the backend inserts a 400 ms
  silent PCM `tts.audio` frame so adjacent paragraph utterances do not play
  back-to-back.

Every Gemini request carries the same speaking style built from the tone and
level. Audio batches stream back as `tts.audio` frames; the backend coalesces
upstream PCM bytes into larger frames so the frontend does not need to schedule
many tiny audio buffers, and emits exactly one `tts.done` after the last batch.
If setup or upstream streaming fails, it emits `tts.error`, stops synthesis,
skips `tts.done`, and still lets the chat run finish with `run.completed`.
Chat text and Gemini's spoken text carry no tone tag; only an ElevenLabs run's
first speech frame adds `speech_tone_tag`. No paragraph-specific fields are
added to public SSE events. Frames and error codes name `gemini`. See
[voice and speech](../integrations/voice-and-speech.md#gemini-tts).

`emotion.update` frames include the event ID, run ID, direct chat node ID, and
full emotion state payload. They also include optional context metadata:
`emotional_tone`, `emotional_intensity` as a Reaction intensity 0–4,
`promoted_emotion`, and `demoted_emotion`. The model's 1–10 intensity maps
1–2 to 0 (no Reaction) and 3–4, 5–6, 7–8 and 9–10 to Reaction intensities 1–4.
Separately, the turn shifts the emotion state by 1 (model intensity 1–3), 2
(4–6) or 3 (7–10): the promoted emotion rises and one opposing emotion falls by
that amount, so a turn at 1–2 still moves the state while playing no Reaction.
The required frontend source of truth is the full `emotions` array. The frame
does not include animation or VFX fields.

`avatar.gesture.requested` frames include the event ID, run ID, direct chat
node ID, validated runtime gesture ID, and `runtime_revision`. Unknown
or invalid model-selected IDs are logged and dropped before SSE delivery. A
normal browser queues the gesture only when both run ID and revision match its
currently mounted catalog.

`chat.title.updated` frames include `type="chat.title.updated"`, `run_id`,
`chat_id`, and the saved title. The title is generated only for first-turn,
untitled, non-incognito chats and is capped at 48 characters after server-side
sanitization. Title-generation failures are logged and do not emit `error`.

`safety.ai_notice` frames include `type="safety.ai_notice"`, `run_id`,
`kind` (`start` or `reminder`), and nullable `anima_name`. When due, the frame
precedes every provider-derived frame of the turn. Clients render it as app UI,
never as assistant text.

`run.status` frames include `type="run.status"`, `run_id`, `status`
(`summarizing_context` while earlier conversation is compacted before sending
or by Anthropic's server, `searching_web` while an application or
Anthropic-hosted web search runs) and `phase` (`started`, then `finished`).
Every `started` is followed by `finished`, including when the turn fails.
Summarizing precedes the reply text of its request; a search, or an Anthropic
compaction in a later tool round, may follow text that streamed in an earlier
round. Clients show a status only while the reply is pending and ignore
unknown statuses.

`safety.crisis_support` frames include `type="safety.crisis_support"`,
`run_id`, `source` (`local` or `moderation`), and `resources`, the resolved
crisis-resource region entry (`code`, `label`, nullable `emergency_number`,
`services` with `phone`, `sms` or `chat` contacts, nullable `source_url`, and
`verified_on`; the fallback entry has no services, emergency number or source). A `local` card precedes provider frames. A `moderation` card
comes from an executor `EventType.CRISIS_SUPPORT` domain event, formatted by
`sse_runtime.py`, and arrives after the reply text but before `run.completed`.
Each turn emits at most one crisis card.

`memory.updated` frames (ID `memory-updated-<run_id>`) carry
`{"type": "memory.updated", "run_id", "message_id", "memory_cue"}`.
`message_id` is the persisted final visible assistant message (`null` only if
the recorder did not expose it) and `memory_cue` is the object described in
[Chat Memory Cue](../features/memory.md#chat-memory-cue), with at least one of
`episode` or `memories` present. The executor emits it after persistence and
episode capture, so it arrives after the reply text and before `run.completed`,
at most once per turn. Incognito turns and turns that remembered nothing emit
none.

`run.completed` is emitted once after safe side effects have run and includes
both `run_id` and the resolved `chat_id`. It is only the run/chat terminal
marker, because the reply text has already been emitted as `user.response`.

## Persistence And Side Effects

Chat persistence is owned by `DirectChatTurnExecutor` through `ChatManager`.
The executor fetches visible chat history by chat ID during setup, then records
the user/assistant turn through a separate short-lived recorder session unless
the request is incognito. The route supplies that recorder through
`product_http/chat/session_services.py`, so the setup session can close before
upstream model streaming begins. Assistant message usage is persisted on the message
row and added eagerly to the parent `chats.cum_*` usage counters in the same
unit of work. The parent chat's `active_context_tokens` is replaced with the
latest turn's footprint in the next turn's context: its last request's total
tokens minus output reasoning tokens. A turn with tool rounds or a split
structured round sums every request in the message usage, so it records that
footprint as `context_tokens` in the provider metadata. An Anthropic request
that compacted also bills the compaction step, so its `context_tokens` is
the last iteration's footprint only. When a stream reports
no usage, the Chat Completions adapter substitutes a character-based estimate
marked `usage_estimated`, so the value still advances and post-response
compaction can trigger. The same non-incognito update stores the last durable
model snapshot as `last_model_provider_id` (the exact catalog row, used by the
frontend to restore the chat's model), `last_model_client` from the catalog
row's model-client profile and `last_model_id` from the selected model slug.
Incognito turns skip durable message writes and chat usage updates.

Visible assistant rows store `message_data.structured` for the parsed
speech/display/emotion payload and `message_data.model_client` for JSON-safe
provider metadata. When provider adapters emit internal `MC*` stream events,
the direct turn observer persists only a compact `stream_event_summary` under
`message_data.model_client.raw_provider_metadata`. OpenAI Responses rows with a
final response ID also expose compact continuation, phase, output item, native
tool, and stream-summary metadata under `message_data.openai` so manual
history replay can preserve assistant `phase` values when the
`previous_response_id` cursor is unavailable or stale. The final visible
assistant row also stores `message_data.memory` (`updates_enabled` and the
turn's `MEMORIES.md` change); see
[Chat Memory Cue](../features/memory.md#chat-memory-cue).

ChatGPT plan turns store nothing at OpenAI. A plan turn reads no stored cursor,
even one a key model left, and replays local history; its reply stores no
`message_data.openai`, so the turn clears the chat row's cursor and the next
key-model Responses turn replays history too. Key and plan Responses models
share the `responses` API standard, so a chat moves between them in either
direction ([ChatGPT plan Responses](model-client-providers.md#chatgpt-plan-responses)).

Normal chat persistence also reserves per-chat `chat_messages.turn` values from
`chats.next_turn`. The value starts at `1` for each chat and increments for each
persisted message row, including multiple rows in the same run.

For first-turn title generation, `chat:sse` conditionally writes `chats.title`
only while it is still blank through its own short-lived database sessions.
Generated-title model usage is stored as small metadata under
`chats.metadata.title_generation`; it is not added to chat usage counters.
Titles and post-response compaction use the utility model role: the App
Settings assignment `models.utility_model_provider_id`, else
`ANIMAMA_DEFAULT_UTILITY_MODEL_PROVIDER_ID`, else the default chat model. The
hidden title prompt defaults to a low reasoning effort (sent only when the
utility model supports it) and a 20 second timeout through
`ANIMAMA_CHAT_TITLE_GENERATION_REASONING_EFFORT` and
`ANIMAMA_CHAT_TITLE_GENERATION_TIMEOUT_SECONDS`; the local composition reads these
and the `ANIMAMA_CHAT_COMPACTION_*` settings from the app's runtime settings. On an Anthropic utility model,
title and compaction prompts use effort `low` unless set and are never
server-compacted ([prompt-only maintenance calls](model-client-providers.md#prompt-only-maintenance-calls)).
Incognito turns skip title generation.

After a successful non-incognito response and before the normal
`run.completed` frame, the route runs a hidden compaction check. OpenAI
Responses turns on a key and Anthropic Messages turns skip it and rely on
provider-side compaction; ChatGPT plan turns have none, so they run it. Models
without provider-side compaction also compact before sending
when a prompt nears their window (see the
[context window budget](model-client-providers.md#context-window-budget)). If
`chats.active_context_tokens` is at or above
the smallest of `ANIMAMA_CHAT_COMPACTION_THRESHOLD_TOKENS` (default 90000), 70%
of the model's context window and 75% of the window left after the reply
reserve,
`ChatCompactionService` calls a separate backend-owned direct model prompt and
stores the resulting summary in `chat_compactions`. Compaction summaries are not
streamed as `user.response` events and are not inserted into `chat_messages`.
Compaction model usage stays on the `chat_compactions` row rather than the
chat's `cum_*` counters. Active compaction summaries record `start_turn` and
`end_turn`; the next prompt uses the summary as a `developer` continuity
message directly after the system message and ahead of the exact visible
messages with `turn > end_turn` when the selected provider serializes local
context. Rows without a developer role get it at the end of the system
message, before the closing guardrails. Anthropic chats ignore these
summaries: their history starts at the newest stored compaction block (see
[Anthropic Messages](model-client-providers.md#anthropic-messages)). If an
OpenAI Responses turn continues from a
chat-row `openai_previous_response_id`, the request sends only the turn context,
the new user input and the cursor, so the active summary is not physically
included in that provider payload.

Before provider frames, the route records the AI-notice cadence for the owner
in `companion_safety_state` through its own short-lived session. That row
holds timestamps and the local notice date only, never message content.

Emotion persistence reuses `persist_sse_side_effect(...)`. Current-run
`EMOTION_UPDATE` events are persisted with
`persist_emotional_state_update(...)` before being streamed.

No background memory extraction queue is scheduled by this route. Direct
model-client turns can attach
request-local memory entry tools when the selected row supports tool calling.

## Error And Cancellation Behavior

Provider/model-client errors after stream setup are caught by the SSE generator.
The route emits `event: error`, skips title persistence and post-response
compaction, and then emits exactly one `event: run.completed` with `chat_id`.
On every connection the error `details` carry a provider-neutral `category`
(such as `unreachable`, `credential_rejected`, `model_not_found`, `timeout` or
`context_exceeded`), the connection's `connection_id`, `connection_name` and
`connection_preset`, `connection_base_url` for owner connections, and the
sanitized metadata described in
[model clients](model-client-providers.md#provider-behavior); never raw SDK
response bodies or keys. A failed turn persists no chat messages and leaves the
Responses cursor, usage counters and turn counter unchanged; memory tool writes
that already committed remain.
Setup-time validation failures such as missing animas, foreign chats,
inactive model rows or connections, non-chat rows, owner rows without a context
window, unsupported capabilities, missing direct clients, or a
missing app-scoped registry (`503`, checked after the owner and runtime checks)
return normal HTTP errors before `StreamingResponse` is opened.

If the client closes the SSE stream early, the generator cancels the active
executor task without emitting `run.completed`. The setup database session has
already been closed before model streaming begins, and any auxiliary
title/TTS work is cancelled; a reply save that has begun finishes in its own
short-lived session. Shared registry clients remain app-scoped and are
not closed by request cancellation. This matches the expectation that
cancellation is not a completed chat turn.

Post-response compaction failures are logged but do not emit `event: error` and
do not alter the already-completed assistant response. Pre-response hard-ceiling
protection is not part of the current compaction path.

Request-local cleanup runs in `finally`, shielded from the disconnect's
cancellation and bounded to five seconds, and waits until each task has stopped;
only then does the response settle the turn's lease.

From admission until its lease settles, a turn is listed in the app's
active-turn registry (`product_http/chat/active_turns.py`, on `app.state`)
under its owner, chat and Anima. Deleting the chat or Anima stops it the same
way as a disconnect, ends whatever the response had sent, and waits for the
turn to settle and for its reply save to finish. A turn stopped during setup
sends no model request and settles `unstarted`. A turn that has not settled
within 10 seconds makes the delete return `409 chat_turn_stopping`
([HTTP API](../architecture/http-api.md#chats)).

## Runtime scope

`chat:sse` runs one avatar companion turn. Helper, trigger, feed and aggregate
workflows are outside this API. A separate workflow API requires its own
contract and ownership review.

## Transport verification

Run `uv run pytest -q tests/test_anima_chat_sse_transport.py` from the repository
root. It serves the shared chat router over the local ports, local
admission/principal resolution, direct executor, structured parser and SSE
bridge through Uvicorn on an owned ephemeral loopback socket. A controlled provider double holds the final bytes
until the client observes an incremental frame. Separate cases verify terminal
errors, disconnect cleanup and a successful next request on the same registry.

Repository/context inputs are fixture doubles and turns are incognito with
memory/emotion updates and TTS disabled. These tests need socket permission but
no database, provider credentials or user installation. They complement the
existing HTTP-boundary probes and SQL-backed chat tests; they do not establish
persistence or optional provider/audio integration acceptance.

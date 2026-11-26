# Chat Interface Runtime Guide

## Package and local composition ownership

The shared session implementation lives at
`src/frontend/packages/product-ui/src/chat/useProductChatSession.ts`, and SSE
classification lives at `packages/product-ui/src/query/mutations/useChatSse.ts`.
The local SSE path re-exports the package implementation. The local
`web/src/ui/main/chat/useChatSession.ts` is the playback/settings adapter: it
connects `useTtsPlayback`, avatar and lip-sync stores, mounted-content readiness,
and the speech policy to the shared session. Its `finalizedServerAudio` flag
(Gemini) routes `tts.audio`, `tts.done` and `tts.error` frames to playback.
Run lifecycle order and structured-response handling remain in the shared
hook.

A consumer supplies `ProductRuntimeProvider` with owner, chat capability and
transport, plus its own `QueryClientProvider`. `useProductChatSession` also
requires the issued `runtimeRevision`, `canChat`, and an explicit remount action;
a chat capability alone never substitutes for a runtime fence. Text-only hosts
may use the stable `textOnlyChatEffects` and `textOnlySpeechPolicy` adapters.
Playback hosts provide `ChatSessionEffects` and `ChatSpeechPolicy`. Routes are
callbacks (`openDraftChatRoute`, `replaceChatRoute`), so the package owns no router.
The SSE hook aborts its owned stream on Stop, unmount, or owner/transport
remount. Buffered or late frames cannot update callbacks after cancellation,
and a replaced stream cannot clear the new stream's controls.
POST streams still permit one attempt; typed chat mutations explicitly disable
query-client retry defaults. A remount conflict preserves the unsent input and
requires the existing explicit recovery action.

## Failed turns and recovery

The shared session keeps a failure notice beside the affected user message. Known
error codes distinguish missing/rejected credentials, unknown models, access or
usage limits, rate limits, timeouts, unreachable or unavailable servers and
removed connections. The notice names the failed
connection from the error's `details.connection_name` (never assuming OpenAI);
for Ollama, LM Studio, llama.cpp and vLLM connections it asks whether the server
is running at `details.connection_base_url`, and the `context_exceeded` category
explains an oversized conversation and suggests a larger-context model or window.
Anthropic codes with an OpenAI counterpart (key, access, model, quota, rate
limit, overload, server, timeout, connection and bad-request errors) read like
it and name the Anthropic connection; `anthropic_context_exceeded` and
`anthropic_stream_incomplete` have their own copy, and others such as
`anthropic_request_failed` use the safe fallback, as `openai_request_failed`
does. `model_refused` means a Claude model declined the turn:
the notice says so and suggests rephrasing, and no other model is tried. Local admission errors describe
installation access, without treating every HTTP 403 as an invalid provider key.
Unknown errors use a safe fallback. The only URL text a notice shows is the base
URL the owner configured for a non-built-in connection; provider-returned URLs,
credentials and exception messages are never inserted into the notice, and
neither is provider response text, with one exception: a ChatGPT plan request
the route refused (`chatgpt_plan_unsupported_request`) quotes the route's
reason, which the backend sanitizes and the notice clamps to 300 characters.
A hosted `trial_complete` denial may add a "Download Animama" link, only for an
absolute `https:` URL without credentials
([hosted denials](../../../contracts/hosted-web.md#hosted-denials)). A ChatGPT
plan limit or ineligible plan (`chatgpt_plan_usage_limit`,
`chatgpt_plan_not_eligible`) links to the fixed **Manage usage** page; a
required sign-in or plan use that is off names App Settings → Models. Details show only an allowlisted error code. A valid provider retry delay is shown as guidance.

Any received partial reply remains visible and is labelled incomplete. The notice
makes no claim that an uncertain turn was saved. Failed turns are local to the
mounted chat session; switching chats or reloading discards that notice/partial
output and loads actual server history. Later successful turns do not clear older
failure notices or move them below the new conversation. A server-confirmed
message with the same run ID replaces its optimistic local projection.

**Restore message** puts the original text into an empty composer for editing; it
never sends a request, replaces an existing draft, or restores attachment choices.
It is disabled while another reply is active or the composer contains a draft.
The user decides whether to resend, including after a suggested rate-limit delay.
POST streams are never automatically retried. Intentional Stop remains quiet and
does not imply that the upstream provider stopped generating or billing.
Switching chats or starting a new one while a reply streams stops it the same
way, so it cannot speak, animate or report errors in the next chat.

An in-stream error is terminal: subsequent duplicate errors, text and
`run.completed` cannot turn that failure into a successful cached answer. EOF
without completion reports an interrupted turn unless the stream was intentionally
cancelled or superseded. Text snapshots update synchronously so an error or
completion arriving in the same network chunk cannot lose the last text increment.

Mounted package browser tests exercise these states with an injected fake
transport. They prove the shared session and notice behavior without provider
calls, a running Compose stack or native/physical acceptance.

`ChatInterfaceView` renders the package's actual `ChatConversation` and existing
`ChatInput` primitives. Its upload/model/dictation controls, quick-chat behavior,
and desktop message insets stay local. `SidebarAnimas` renders the shared
`AnimaSelection` using TanStack links supplied by the local route composition.
Compiled `@animama/product-ui/styles.css` includes the shared theme and component
utilities; `theme.css` also exposes those theme tokens for the local utility build.
No consuming build needs the original web sources or their aliases.

See [Voice](voice.md) for STT/TTS and [Avatar animation](avatar-animation.md)
for playback internals.

## Images in chat

In local compositions the person can attach up to four images to a message:
**Upload from computer**, a drop on the chat page, a paste into the text box,
or a ready image chosen from the attach popover's list of uploaded files. A paste that also carries text
pastes the text. The composer refuses an image before uploading it
(`lib/user-files/chat-images.ts`, through Uppy's `onBeforeFileAdded`): HEIC or
HEIF by name, more than 20 MiB, a fifth image counting Library picks, or any
image while the selected model is known not to accept images (its catalog
`accepts` lacks `image`; an unknown model counts as accepting). While images
are attached to such a model the tray shows a note. A refused image gets one
toast. Upload details are in
[user file uploads](../features/user-file-uploads.md).

An image is ready once finalized, so it never holds a send waiting for
processing. Images go with one message: the shared session reports a turn's
attachments through `onAttachmentsSubmitted` when the turn completes (the
server has saved it), and the composer removes the images among them while
documents stay. A turn that is refused, fails or is stopped keeps them, so a
resend carries them again; a refusal's failure card explains
`too_many_images`, `attached_image_unavailable` or
`model_does_not_accept_images`.

The sent message shows its images at once: `describeAttachedImages` names
them for the session's local message and for the history row it writes after
the turn. Server history carries them in `data.images` with the person's text
in `data.user_text` (`mapServerMessagesForDisplay`), so the bubble shows that
text rather than the `[Image: name]` lines in `content`. `ChatConversation`
draws the host's `renderUserAttachments` above the user bubble;
`ui/main/chat/ChatMessageImages.tsx` shows 320 px previews loaded through
`useUserFileImageUrl`, opens the original in a dialog (inside the fullscreen
element when the chat is fullscreen) and leaves a placeholder for a deleted
image.

## 2) High-level flow

1. User types or dictates text in `ChatInterface`.
2. `useChatSession.handleSubmit()` validates the loaded anima plus its frozen
   mounted runtime catalog and ensures a chat id exists.
3. The hook starts a run (`run_id`) and opens SSE via `useChatSse.startChat(...)`,
   sending the catalog's required `runtime_revision` with the turn.
4. SSE events stream back:

- response tokens -> update streaming assistant text and TTS queue
- main-structured response parts -> render `speech`, render distinct
  `display`, and speak only `speech`
- emotion updates -> update avatar runtime store
- same-run, same-revision avatar gesture requests -> queue one-shot gesture planner events
- same-run AI notice and crisis card events -> the route's
  [companion safety](#companion-safety) state
- same-run `memory.updated` -> the reply's [memory cue](#memory-cue)
- run completion -> finalize run state + cache messages; talking ends on TTS audio-ended

5. `displayMessages` merges persisted server messages + local optimistic message + in-flight assistant stream.

## 3) `ChatInterface.tsx`

Responsibilities:

- Renders message list, empty state, submit/stop controls.
- Calls `useChatSession` and renders its `displayMessages` projection.
- Owns dictation composition behavior via `useDictation`.
- Renders the chat model selector immediately before dictation controls.

Sidebar Search uses `POST /v1/chats/search` to navigate persisted chats and does
not participate in the active stream. See [Data layer](../architecture/data-layer.md#chat-search).

### Canvas controls

The main scene settings popover controls display mode, camera, and TTS/SFX volume.
The chosen camera preset is saved as the user preference
`presentation.camera_preset` and restored when settings load. Fine-tune camera
edits are session-only: numeric edits select Custom, and choosing a preset or
Reset restores (and saves) a named preset. These controls are
available outside PiP while the main scene is visible.

### Layout modes

`MainShell` owns `canvasMode` and passes it to the route-provided `chatPanel`
render function. The anima route renders `ChatInterface` with
`layout="chat-only"` when `canvasMode === "chat"` and with
`layout="scene-overlay"` for the normal avatar + chat surface.

In chat-only mode, `AvatarSceneHost` stops rendering the main avatar scene
unless desktop PiP is active. The chat panel stays mounted as the primary
surface.

Assistant chat bubbles render streamed and persisted text with Streamdown
Markdown by default. The App Settings → Advanced toggle "Render assistant
Markdown" (saved as `presentation.render_markdown`) can turn this off, which
falls back to the plaintext renderer and sparkle animation path. User bubbles always
render as plaintext.

Markdown replies, here and in the Memory Manager, show only images from the
app's own origin. Any other image shows as text instead: its alt text, or
Streamdown's `[Image blocked: …]` label for sources Streamdown itself rejects,
such as `data:` and `blob:` URLs. HTML in a reply shows as text, and a link
opens only after Streamdown's dialog shows its destination. Product-ui's
`StreamdownResponse` applies these rules, and callers cannot override them.

### Model selector behavior

`ChatInputModelSelector` controls the anima's explicit direct-chat profile
default for the active anima. It loads the backend model catalog from
`GET /v1/model-providers`, loads the anima detail, reads the
active model from `anima.chat_profile.default_model_provider_id`, and persists
changes through `PATCH /v1/animas/{anima_id}/chat-profile`.

The selector groups catalog options by provider label, lists only chat models
(hidden ones only while active; owner models without a context window disabled),
marks the active `default_model_provider_id`, shows a warning when that row is
no longer in the catalog, returns to reasoning after selection, and disables while a chat
stream or profile update mutation is in flight. A failed update surfaces a
toast and leaves the current persisted profile unchanged. The selected model
applies to future chat requests; it does not alter an already-running stream.
`useChatSession` also sends the active catalog row id as `model_provider_id` in
each accepted `chat:sse` request, so the streamed turn uses the same row the
selector displays.

When a persisted chat is opened, `useChatSession` loads the chat row from
`GET /v1/chats/{chat_id}` and restores the catalog row recorded in
`last_model_provider_id`; older chats fall back to the row matching
`last_model_client`, `last_model_id`, and `api_standard`. The restored row is
written back to the anima chat profile before normal send is enabled for that
chat.

The frontend treats `api_standard` as the chat compatibility fence.
`last_model_client` is used only to restore the last historical model row. A
selected catalog row with no `api_standard` is disabled for direct chat. If the
active chat already has an `api_standard`, a different-standard model selection
does not update `default_model_provider_id`; it opens a confirmation dialog
above the still-open model selector. Cancel keeps the current chat and model so
the user can keep choosing from the selector. Confirm closes the selector,
switches the profile to the new model, and navigates to the anima draft chat
route so the current draft text can be sent as the first turn of a new chat.
The dialog, **Start a new chat?**, explains in user terms that the selected
model keeps conversations differently, without naming APIs. Quick Chat does not
switch; it shows a toast directing the user to the main chat.

The input's provider-logo button opens a popover with the supported reasoning
slider. Its model name and Chat features icon switch the same popover to the
model list or native-tool settings; Back returns to reasoning. Catalog rows
advertise `requestable_native_tool_support` and `supported_reasoning_efforts`.
Models without adjustable reasoning omit the slider. Supported native tools
are enabled by default when the active model advertises them.

The effort is saved per Anima with its model. The slider shows the Anima's
`chat_profile.reasoning_effort` while the active row offers it; with none saved,
or one the row no longer offers, it shows the row's `default_reasoning_effort`
when the row offers it (`medium` on Anthropic rows), else its first supported
effort (`effectiveReasoningEffort` in `lib/chat/model-catalog.ts`). Each slider
change saves `{ default_model_provider_id, reasoning_effort }` through
`PATCH /v1/animas/{anima_id}/chat-profile`. Chat-profile saves share one
mutation scope, so they reach the server in order, and the latest pick shows
until its save settles. A failed save shows a toast and the slider returns to
the saved effort. Selecting another model sends no effort, so the backend
clears the saved one and the new model starts at its default.

Web search availability comes from `webSearchAvailability` (product-ui) using
the row and the runtime capability `web_search`: hosted when the row lists
`web_search` as requestable; application search when the row calls tools and
a backend is configured with its key; otherwise a disabled Web search checkbox
with its reason ("Set up web search in App Settings.", a model without tools,
or a missing Brave key). Availability follows the runtime fields (`configured`,
`credential_state`); `configuration` only says whether the owner can set search
up, so an operator-provisioned backend (hosted reports `configured` with
`configuration: false`) offers application search without setup guidance. Where
the owner cannot configure search and no usable backend is reported, rows
without hosted search show no control. Anthropic rows without hosted search
never show one either, because the backend never gives them the application
tool. Available search
starts on, including when availability changes
while the same model stays selected (the capability loads after the catalog,
or the owner configures or removes the backend). The request field is the same
`native_tools: ["web_search"]` either way; the backend picks hosted or
application search. The control does not see the per-turn reasoning effort:
on Chat Completions rows for OpenAI GPT-5.4 and later, such as
`OpenAIHTTPAgent:gpt-6-luna`, the backend drops search when an effort other
than `none` is sent and logs `reasoning_with_function_tools`.

Chat features are not saved. `SettingsProvider` keeps the composer's choice
(`chatFeatureChoice`) for one Anima and model, so leaving and reopening the chat
page keeps it, including a choice that turned every tool off. Another Anima or
model, and a relaunch, start from the defaults.

`native_tool_support` is the complete provider/model capability set and may
also contain backend-owned tools such as memory `apply_patch`. The selector
renders and defaults only `requestable_native_tool_support` plus application
web search. The request builder filters native-tool overrides against the same
`selectableNativeTools` list as a final defense against stale in-memory
settings after a catalog update; internal capabilities are
never sent through `dispatch_options.native_tools`.

Reasoning and feature controls apply directly to the active model without
switching it; changing one preserves the other. `chatRequestOptions`
(`lib/chat/chat-request-options.ts`) derives both from the Anima's chat profile,
the catalog row and the Chat features choice. The composer shows its result and
`useChatSession` sends it, so turns carry the saved effort even while the
composer is not mounted (for example PiP voice turns from another page).
Remounting the composer changes neither setting.

Input integration preserves typed text while appending final dictation segments.
Dictation drives the avatar listening phase. Manual typing briefly activates
`user_typing`; submitting, clearing input or starting capture ends that phase.

## 4) `useChatSession.ts`

Responsibilities:

- Resolves route anima/chat ids and ingress node.
- Loads anima and chat messages.
- Creates a chat on first message and accepts backend-generated title updates.
- Controls SSE streaming lifecycle.
- Coordinates avatar runtime store and TTS playback hook.
- Reconciles query cache for chat/messages after completion.

### Core state

- `input`: textarea value.
- `draftChatId`: temporary chat id before route replacement.
- `localMessages`: optimistic user message(s) added immediately on submit.
- `streamingRunId`: active run being streamed.
- `streamingSegments` + `streamingSegmentsRef`: incremental assistant output.
- `streamingDisplayText` + `streamingDisplayTextRef`: visible-only display text
  for main structured responses.
- `streamingMemoryCue` + `streamingMemoryCueRef`: the run's validated
  `memory.updated` cue, shown on the last streaming bubble.

Derived state:

- `activeChatId = routeChatId ?? draftChatId`
- `canChat` requires the Anima plus its resolved mounted runtime response and catalog
- `displayMessages = serverMessages + localMessages + optional streaming assistant placeholder`

### Submit lifecycle

`handleSubmit()` executes these phases:

1. Validation and submit setup:

- Rejects empty text or re-entry while streaming.
- Records chat submit interaction metrics.
- Validates `animaId` and the frozen mounted Anima runtime catalog.

2. Chat resolution:

- Reuses existing chat when present.
- Otherwise creates one (`useCreateChat`) and stores temporary `draftChatId`.
- Leaves `title` unset so `chat:sse` can generate the first-turn title server-side.
- Untitled newly-created chats are not inserted into sidebar chat-list caches
  until the backend `chat.title.updated` event supplies a generated title.

3. Run initialization:

- Generates UI run id.
- Adds optimistic local user message.
- Starts TTS run (`startTtsRun(runId)`) and avatar run
  (`startAvatarRun(runId, { inputText })`).
- The avatar runtime store enqueues a generic `runStarted` avatar planner
  event. `AvatarPlanner` consumes that event and may select one delayed
  thinking PoseController clip from the trimmed input text.
- Chat does not choose or play animation clips directly; planner decisions are
  visible through the Animation Debug modal's Avatar Planner section.
- Clears streaming text buffer.

4. Chat SSE request and callbacks:

- Calls `chat:sse` with `animaId`, `message`, `chat_id`, `run_id`, and the
  mounted `runtime_revision`.
- Before clearing input, creating a chat, starting avatar/TTS side effects, or
  opening SSE, checks the selected catalog row against the active chat's stored
  `api_standard`. Missing, unsupported, or different-standard rows block the
  send locally; the backend fence remains authoritative.
- Merges the Anima's chat request options (`chatRequestOptions`: the saved or
  default reasoning effort and the Chat features choice) into the chat request
  body.
- When the effective TTS setting is enabled, adds
  `dispatch_options.main_structured_response=true`.
- `onToken`: appends normal text to `streamingSegments`, routes
  main-structured `speech` and `display` parts, and pushes speakable text to
  TTS only when TTS is enabled. With TTS disabled, the first assistant output
  starts the avatar's `responding_no_tts` presentation phase instead.
- `onEmotionUpdate`: applies the full-state emotion update to avatar runtime store.
- `onAvatarGestureRequested`: queues a gesture request only after transport has
  matched both its run ID and `runtime_revision` to the request.
- `onRuntimeContentRevisionMismatch`: drops the gesture and invalidates the
  runtime query; it never resolves through a similarly named global motion.
- `onChatTitleUpdated`: patches chat-list query caches when the backend saves an
  AI-generated first-turn title. For a newly-created chat, this is the first
  point where the sidebar chat list receives that chat row.
- `onComplete`: calls `completeTtsRun(runId)` for TTS runs, or requests
  non-TTS avatar completion after text animation and planner presentation work
  drain; then writes user+assistant messages into cache (the last assistant
  row carries the streamed cue as `memory_cue`), clears
  streaming/local pending state, invalidates chat lists, and replaces route for
  new chats. New chats skip chat-list invalidation until a title update has
  arrived, preventing a temporary `Untitled chat` sidebar row.
- `onError`: abort-safe cleanup; for a pre-stream runtime revision conflict it
  removes the optimistic message, restores the draft, invalidates/refetches and
  remounts the runtime catalog, then asks the user to send again. It never
  resubmits automatically. Other failures use the recovery behavior above.

### Main Structured Response Mode

Main structured response mode is the backend contract used by normal direct
chat:

- normal `chat:sse` uses `response_format="main_structured_json"` and semantic
  `speech`/`display` parts
- the frontend still sends `dispatch_options.main_structured_response=true` for
  TTS-enabled turns as request intent
- the backend requests the structured reply in the strongest form the selected
  row supports and validates it locally; a row without a structured transport
  still chats

The backend direct model-client executor builds the schema for each request.

The request sets `model_provider_id` to the exact catalog row ID and merges
request-scoped options into `dispatch_options`. The frontend requests
`main_structured_response=true` when TTS is enabled; the backend also emits
structured responses when TTS is disabled.

In structured mode, `user.response` carries semantic `speech` or `display`
parts rather than raw JSON. Speech is visible and speakable; display is visible
only.

The stream metadata is optional for backward compatibility:

- `is_delta=true` means `text` is an incremental semantic part. For `speech`,
  the frontend appends the text exactly as received, including leading
  whitespace between sentences. For `display`, it appends to the visible-only
  display buffer.
- `is_delta` missing or not `true` means the event is a complete part or
  correction. The frontend replaces the current speech or display text with
  that complete text.
- `part_index` is accepted as ordered metadata for diagnostics and future
  safeguards. The frontend trusts SSE ordering and does not reorder frames.
- `part_final=true` marks the final frame for that part. A final `speech` frame
  can have an empty `text` value; that marker finalizes the accumulated speech
  without changing the assistant bubble.

`useChatSession.ts` treats a token as main structured only when the SSE event
uses `response_part="speech"` or `response_part="display"`. The dispatch option
alone is not authoritative because future backend paths may still return normal
text during a TTS-enabled chat request.

The streaming behavior is:

1. `speech` updates the assistant streaming bubble through the structured
   accumulator. Delta speech grows the same assistant message sentence by
   sentence; complete non-delta speech replaces the current speech text so
   older backend fallback events and correction events still work.
2. `display` updates `streamingDisplayText` separately from speech. Delta
   display appends; complete non-delta display replaces the current display
   text. Display text is never sent to TTS.
3. Normal `user.response` text without `response_part` keeps the older text
   streaming path and can still queue TTS incrementally.
4. Structured speech deltas are routed into the existing TTS pipeline as they
   arrive, as written apart from emoji, which no voice receives, and with
   each voice's own audio tag spelling (item 7).
   `part_final=true` and `run.completed` close the TTS run without re-appending
   accumulated speech; empty final markers and visible corrections after
   streamed TTS are not spoken again. Lip-sync plans from the text the voice
   speaks and its audio (see [Avatar lip-sync](avatar-lipsync.md)).
5. On `run.completed`, the optimistic cache writes one assistant message for
   speech plus one additional assistant message for distinct display text.
   Display text equal to speech, as written or as shown, is not duplicated.
6. After a reload, the history API returns one provider-shaped assistant row
   with both values in `data.structured`. `mapServerMessagesForDisplay()`
   expands that row back into speech followed by distinct display text, matching
   the live stream. Legacy or malformed structured rows fall back to `content`.
7. Speech bubbles hide audio tags ([audio tags](../../backend/integrations/voice-and-speech.md#audio-tags)):
   - the live bubble calls `hideSpeechTags`; completion, reload and the
     failure notice use `replyBubbleTexts`, which also skips a display that
     repeats the speech;
   - TTS still receives the speech as written;
   - speech of only tags shows no bubble, and its turn finalises without
     waiting for a text animation;
   - display text and Markdown link labels are shown as written.

The backend owns JSON parsing and final validation for main structured output.
The frontend trusts the typed SSE parts and does not parse the raw model JSON.
A reply the backend recovers as plain text arrives as ordinary `speech` parts
with a `neutral` tone and no gesture.

Backend `chat:sse` derives normal emotion updates from the main structured
response, not from a second emotional analyst runner. The hidden
`emotional_tone` and `emotional_intensity` metadata are used
server-side to compute and persist one full-state `emotion.update`. The
frontend continues to treat the event's `emotions` array as the source of
truth; metadata such as `emotional_tone`, mapped `emotional_intensity`,
`promoted_emotion`, and `demoted_emotion` is optional context only.

### Stop lifecycle

`handleStop()`:

- calls `useChatSse.stop()` (aborts stream)
- cancels TTS playback
- finishes avatar run
- clears streaming text/run state

### Sidebar pins and deletes

Each chat and Anima row in the expanded sidebar has a row menu (More button on
hover or keyboard focus, or right-click) with Pin/Unpin and Delete
(`ui/sidebar/SidebarRowMenu.tsx`). Pins are the rows' `pinned_at`, set with
`PATCH {pinned}`; the sidebar sorts pinned rows first within the chosen Anima
sort or chat filter (`sidebarOrder.ts`), and the collapsed rail follows the
Anima order. The Anima page's More menu offers the same actions.

Deletes confirm in the shared `ConfirmDeleteDialog`. Before the request,
`ChatInterface` registers its streaming reply in
`stores/chat-delete-coordination-store.ts`, so the delete calls the same stop as
`handleStop()`, and it refuses sends to the chat or Anima being deleted
(including Voice Mode and Quick Chat turns) until the page has left it. The
server also stops and awaits running turns; a 409 `chat_turn_stopping` keeps the
dialog open to retry. After a delete, the sidebar drops the row and the page
leaves it, replacing its history entry: a deleted open chat opens a new chat
with the same Anima, and a deleted open Anima opens the next Anima in sidebar
order. Deleting the last Anima follows the existing empty-roster routing, which
opens Anima creation where the runtime offers it. Only then are its queries
removed and the related caches refreshed, so the open chat is never refetched.
Focus returns to the row's (or page's) More button when nothing was deleted.
After a sidebar delete it moves to the next surviving row, or the list
heading. After a delete from the Anima page, or at phone widths where the
drawer has closed, it can fall back to the page.

### Route/anima sync effects

- Anima change resets avatar runtime (`resetForAnima`) and seeds baseline emotion snapshot.
- Chat switch clears transient run state (`localMessages`, stream text, active TTS/avatar run).
- Unmount cleanup aborts any active SSE stream and finishes avatar run.

## 5) `useChatSse.ts`

Responsibilities:

- Own one active SSE stream at a time.
- Abort previous stream before starting a new chat request.
- Classify raw SSE chunks into typed events.
- Emit typed callbacks to `useChatSession`.
- Record SSE metrics.

### Event classification

Type guards map incoming chunks to:

- `user.response`-like chunks (contains `text`) -> `onToken`; optional
  `response_format`, `response_part`, `is_delta`, `part_index` and `part_final`
  are passed through for main-structured handling, and `speech_tone_tag` is
  passed to `appendTtsToken` for the run's first ElevenLabs chunk
- emotion updates (contains `emotions`, with optional tone/intensity context)
  -> `onEmotionUpdate`
- gesture requests (`avatar.gesture.requested` with `gesture` and
  `runtime_revision`) ->
  `onAvatarGestureRequested`
- `safety.ai_notice` (`type` field) -> `onAiNotice`
- `run.status` (`type` field, known `status` only) -> `onRunStatus`; the session
  shows "Summarizing earlier conversation…" or "Searching the web…" beside the
  pending indicator until `finished` or reply text arrives
- `safety.crisis_support` (`type` field, with `source` and `resources`) ->
  `onCrisisSupport`
- `memory.updated` (`type` field) -> `onMemoryUpdated` with a cue validated by
  `parseMemoryCue`; a frame whose cue has no valid part is logged and dropped.
  It is checked before the shape-based reply, error, emotion and gesture guards
- run completed (contains `run_id` without `text`, `emotions`, or `gesture`) ->
  `onComplete`
- error event (contains `error`) -> `onError`

Run-id guard behavior:

- When a run id is expected, mismatched event run ids are ignored.
- This prevents cross-talk from stale/multiplexed streams.
- When a runtime revision is expected, gesture events with a missing or
  different revision are logged, dropped, and reported to the session for
  query invalidation before they can reach the planner.

POST reconnect behavior:

- The generated SSE transport is limited to one attempt. A chat POST may have
  reached the model before a connection failure, so an automatic reconnect
  could duplicate the user's turn and consume tokens twice.
- Pre-stream HTTP failures preserve their status and JSON detail through
  `ChatSseHttpError`, allowing the session to distinguish the safe
  `runtime_remount_required` recovery path.

### Stream status

`isStreaming` reflects active request lifecycle.
Final status tracked for metrics:

- `ok`
- `error`
- `cancelled` (aborted before error/completion)

## Companion safety

The user-facing contract is the
[safety and crisis protocol](../../safety/crisis-protocol.md); the backend
cadence and detection rules are in
[backend chat](../../backend/runtime/chat.md#companion-safety).

`useProductChatSession` sends `client_context` (browser time zone and locale,
and the applied UI Locale as `ui_locale`, the conversation language) with every
turn and forwards `safety.ai_notice` and `safety.crisis_support`
through its optional `safety` argument (`ChatSafetyEffects`). Types and guards
live in `packages/product-ui/src/lib/chat/companion-safety.ts`.

`CompanionSafetyProvider` (`web/src/ui/safety/`) wraps `MainShell` in the Anima
route, keyed by Anima, so its state survives canvas-mode switches that unmount
the chat panel. It renders:

- **AI notice.** App text such as "You're talking with <name>, an AI — not a
  person." above the chat input without moving the composer, or bottom-center over the scene in Avatar-only
  mode through `MainShell`'s `avatarOnlyOverlay`. It is never spoken or added to
  the transcript. It stays visible until its turn completes, fails, stops or its
  chat panel unmounts, and for at least 8 seconds, then fades
  (`web/src/lib/safety/aiNotice.ts`).
- **Crisis card.** Localized crisis services with call, text and chat links, the
  region's emergency number, and a "Safety and crisis protocol" link. In the
  main window it sits in the chat panel's bottom-right corner, or is lifted just
  above the input region when it would overlap it
  (`web/src/ui/main/chat/crisisCardCorner.ts`); in Avatar-only mode it uses the
  scene's bottom-right corner. Quick Chat shows it below the input. It stays
  until dismissed; a later positive turn replaces it.

`SafetyProtocolDialog` opens `docs/safety/crisis-protocol.md`, bundled with
Vite's `?raw` import, in place so reading it never interrupts the turn. The
same document is the `/safety` route, reachable before first run, and the
landing build publishes it at animama.ai/safety/ ([landing page](../landing-page.md)). Under a beta
UI Locale, `useCrisisProtocol` loads `crisis-protocol.<locale>.md` (a machine
translation; English is authoritative) and shows English until it loads. Vite's
`server.fs.allow`, the production `Dockerfile`, and the development Compose
mount include `docs/safety` for that import. Quick Chat mirrors the notice and
card through its snapshot `safety` field and sends `dismiss-crisis-card`
([Quick chat](../desktop/quick-chat.md#runtime-mirror)).

Settings → Safety chooses the crisis-resource region (or Automatic, from the
browser locale) and a reminder interval no longer than the operator's
(`companion_safety.operator_reminder_hours` from runtime capabilities), and
links the protocol. Both are saved under user preferences `safety`. First-run
setup ends with a concise 18+ confirmation modal on entry to the first Anima.
Chat remains blocked until the owner explicitly confirms; declining cannot
complete onboarding.

## Memory cue

A reply whose turn recorded a `remember` episode, changed the Anima's
`MEMORIES.md`, or both shows a small `Brain` icon button named "Memory updated"
at the foot of its last bubble. The backend contract is in
[backend chat](../../backend/runtime/chat.md#sse-events); types, the `memory.updated`
guard and `parseMemoryCue` live in
`packages/product-ui/src/lib/chat/memory-cue.ts`.

- **Streaming.** The session keeps the run's cue and attaches it to the last
  streaming bubble: the display bubble when structured display differs from
  speech, otherwise the speech bubble.
- **Completion.** New chats never refetch history, so `onComplete` copies the
  cue onto the last assistant row it writes into the messages cache.
- **Reload.** `mapServerMessagesForDisplay()` maps `PyChatMessage.memory_cue`
  onto the last bubble of that assistant row. Cues with no valid part are
  ignored.
- **Caches.** The event invalidates memory-entry queries for a `MEMORIES.md`
  part and memory-episode queries for an episode note, so the Memory workspace
  refetches what the turn wrote.

`ChatConversation` renders host content through `renderAssistantAccessory`, so
the package stays router-free. `ChatInterfaceView` renders `MemoryCue`
(`web/src/ui/main/chat/MemoryCue.tsx`), whose popover lists the episode note
under `Noted in episodes` and the added `MEMORIES.md` text under
`Added to <Anima>'s memories` (`Updated <Anima>'s memories` when the change
added no text). Only the `MEMORIES.md` part has an Open in Memories link,
to `/memories?tab=memory&mode=manual&entryId=<entry_id>`; a pending episode
note has no file of its own. Quick Chat mirrors the cue and opens the file
through the main window ([Quick chat](../desktop/quick-chat.md#runtime-mirror)).
Avatar-only mode renders no transcript and so no cue.

## Speech integration

`ChatInterface` receives final dictation segments through `useDictation`.
`useChatSession` starts a TTS run at dispatch, appends speakable tokens, completes
it after SSE completion and cancels playback on Stop, error or navigation.
Provider selection, buffering and timing are documented in [Voice](voice.md).

While a reply is spoken, the latest assistant bubble shows a `FastForward`
button ("Skip speech", `SkipSpeechButton.tsx`) beside any memory cue. It calls
the session's `handleSkipTts`, like the desktop Skip TTS shortcut, and stops
playback without changing Voice Mode. Quick Chat mirrors it through the
`ttsAudioActive` voice state and a `skip-tts` command.

## 8) Avatar updates from chat

`useChatSession` updates avatar runtime store on run events:

- submit -> `startAvatarRun(runId, { inputText })`
  (`interactionPhase=thinking`, plus a queued `runStarted` planner event)
- TTS audio started -> `markSpeechStarted(runId)` (`interactionPhase=talking`)
- TTS audio ended -> `markSpeechEnded(runId)` + `finishAvatarRun(runId)`
- TTS disabled, first assistant output -> `markNonTtsResponseStarted(runId)`
  (`interactionPhase=responding_no_tts`)
- TTS disabled, text animation complete -> `requestNonTtsResponseCompletion(runId)`;
  `AvatarCanvasActor` finishes the run after same-run gesture/reaction planner
  work drains. Reactions started during `responding_no_tts` clear after 6s,
  even when their authored lifetime is phase-bound.
- emotion update -> `applyAvatarEmotionUpdate({ emotions, eventId, runId })`
- accepted avatar gesture request -> `requestAvatarGesture({ gesture, eventId, runId })`
- run complete -> `completeTtsRun(runId?)` (run cleanup deferred to TTS completion)
- stop/error/navigation/unmount -> `abortAvatarRun(runId?)` (immediate speech + run reset)

`ChatInterface` also drives listening signal:

- dictation active -> `beginListeningCapture()`
- dictation inactive/unmount -> `endListeningCapture()`

The avatar render loop consumes these signals each frame via `AvatarCanvasActor` and the avatar animation runtime.

## 10) Practical debugging checklist

1. Verify the selected Anima, issued runtime revision and `canChat` before debugging transport.
2. Confirm `run_id` consistency across submit body and SSE events.
3. Check `streamingRunId`, `streamingSegments`, and `streamingDisplayText`
   transitions in `useChatSession`.
4. Validate dictation provider selection and the active provider callback path for STT issues.
5. Validate TTS provider availability and chunk queue drain behavior.
6. Inspect avatar store updates (`startRun`, `markSpeechStarted`, `markSpeechEnded`, `applyEmotionUpdate`, `requestGesture`, `finishRun`) for animation mismatch.

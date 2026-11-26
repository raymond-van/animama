# Common web composition and hosted artifact contracts

This contract defines the common browser compositions and immutable hosted
application produced by Animama. It covers admission, session lifetime, shared
capabilities, private API traffic and closed application/resource delivery. The
[coverage map](../docs/plans/hosted-web-parity/hosted-web-parity-coverage.md) records
retained actions and their verification boundaries. A consumer implements these
contracts without importing local routes, installation state or a sibling checkout.

Product routes every composition serves live in `animama.product_http` ([ADR
0021](../docs/adr/0021-shared-product-http-routes.md)). A consumer mounts
`animama.product_http.routes.ROUTERS` from the published wheel, installs its own
`ProductPorts` (owner sessions under its commit authority, repositories, content
services and byte delivery, upload storage, speech, the model catalog policy, role
defaults and embedding refresh status, the Memory Manager service, and the chat
policy, chat-turn guard and turn collaborators) and sets its request-principal
resolver as `app.state.request_principal_resolver`; without either, shared routes
answer 503. Its byte delivery (`file_response`) receives `immutable=True` for
revision-named runtime members and complete binary bundles ([ADR 0028](../docs/adr/0028-cacheable-runtime-revision-members.md))
and for Included content files read at their digest URL,
`/v1/content/files/{file_ref}/sha256/{sha256}` ([ADR 0033](../docs/adr/0033-digest-keyed-included-content-file-urls.md)),
and chooses its own cache policy for them.
A composition whose shared catalog rows never change at runtime sets
`SHARED_CATALOG_ROWS_IMMUTABLE` (from `content_catalog_repo`) in the `info` of owner
sessions that run the shared loadout services, so their reads lock only owner rows.
Its content port decides package admission: a
composition that withholds Anima creation builds
`ContentPackageService(allow_anima_import=False)`. A composition that serves only
its own catalog sets `ModelCatalogPolicy(validate_role_preferences=True)`, so
settings writes refuse a role preference its catalog cannot serve
(`422 model_role_unavailable`). Its speech port refuses an operation it does not
offer, and its Memory Manager port may wrap each operation with its own admission;
either refuses with `ProductRefusal`, which the route reports as `detail.code`
with the refusal's status. The route
inventory marks each route shared, local-only or withheld by a capability. Shared
byte routes answer GET only: a consumer that serves HEAD or Range for them adds
those through its own delivery port or routes.

`POST /v1/animas/{anima_id}/chat:sse` asks the consumer's guard to admit each turn
(`admit_chat_turn`) after the Anima ownership and runtime-revision checks and
before any write or model call; a refusal is a `ProductRefusal` (reported as
`detail.code` with its status, plus any denial fields) or the consumer's own
exception. It then runs the turn with the consumer's model clients,
web search, attachment embedder and speech (`chat_turn`); a consumer that does
not offer Gemini voice returns `None` from `ChatTurnServices.gemini_speech`, so
a Gemini request gets no speech frames. Pre-send compaction, post-reply
compaction and the title each use the registry `utility_model_clients` returns
for their purpose, so a metering consumer can limit them apart from the reply's
rounds. The guard's lease is
checked while the model streams and before each step after the reply, and settled
exactly once, after every turn task stopped, as `unstarted`, `completed`, `failed`
or `interrupted`; a stop before the reply is saved ends the turn with an error
frame carrying its code and message ([chat-turn
guard](../docs/backend/runtime/chat.md#chat-turn-guard)). A `ProductRefusal` raised while the turn runs (a model request, web search or
the consumer's deferred commit of a turn write) or a stop may carry
`DenialDetails`; its `error` frame keeps the code and those fields (see Hosted
denials). The chat policy's
`public_error_text` is the text of every `error` frame except a stop's, which
shows the stop's own message, and replaces the details of all others except a
denial's fields; speech error
frames carry the speech port's own messages, so it raises only browser-safe ones,
and a speech decline (`ProductRefusal`, such as `speech_allowance_exhausted`)
keeps its code in `tts.session.error` or `tts.error`.

## Admission and browser lifetime

`ProductRuntimeComposition` in `@animama/runtime-contracts` supplies one transport,
`readAdmission`, bounded idempotent `repair`, and optional account actions. An
explicit entrypoint chooses the adapter before React mounts. Shared routes never
choose authority from a deployment flag. The local adapter retains backend-owned
first-run onboarding; hosted account/profile actions belong to its account adapter.

`RuntimeAdmission` is renderable before product data is admitted: loading,
sign-in-required, ineligible, restricted, recovery or unavailable. Only `ready`
contains `RuntimeSession`, complete `RuntimeCapabilities` and onboarding state.
The adapter maps its service's existing wire states into this view; the view does
not create a new identity/session HTTP authority. Local `/v1/runtime-context`
remains local. Hosted admission uses `/v1/hosted/runtime-context`, repair uses
`POST /v1/hosted/bootstrap:ensure`, and `/v1/hosted/events` signals possible revocation,
which prompts an immediate context read.
Hosted login/callback/logout, session cookies, CSRF and central account URLs remain
consumer-owned HTTP behavior.

A signed-in `bootstrap_required` context starts that server-owned setup without
a click, one attempt at a time, behind a setup view; the context read afterwards
decides the next view. A network failure, or a 5xx reply without a hosted
`state`, is retried with the same idempotency key, and an unanswered key is
replayed by the next attempt; once the server answers, a later attempt uses a
new key. `bootstrapping` is re-read with backoff for about two minutes before
recovery is offered. `recovery` and a failed first attempt show recovery, whose
retry starts one new attempt. An admitted view whose context later requires
setup (for example after a policy update) keeps its session and drafts suspended
and repeats setup at a bounded pace until the context is active again.

`age_confirmation_required` is an admitted state, never a setup state: the
browser admits it like `active` (same capability, CSRF and session checks) with
`onboardingRequired`, and renders the app inert behind the shared 18+ dialog with
a short beta notice. Confirming posts `{"adult_confirmed": true}` to
`POST /v1/hosted/age-confirmation` with the CSRF header; the reply is the runtime
context, and an `active` reply closes the dialog in place without remounting the
app. A failed reply keeps the dialog open for another try, and a 401 reads the
context, which decides what follows. Declining sends nothing and offers sign-out.
A request refused with status 403 and `{"state": "age_confirmation_required"}` is
cancelled (an `AbortError`, handled like an ended session rather than shown as a
failure) and, unless the dialog is already open, the context is read, which
reopens it. The browser never infers or stores the answer; the server owns the
attestation.

An admitted context (`active` or `age_confirmation_required`) may carry
`setup_pending: true` while the server prepares the account's starter data.
Product reads then answer as for an empty account: the roster shows a loading
state instead of its empty prompt, and the browser re-reads the context in a
short burst (about three minutes) and then every 30 seconds, stopping when the
session ends. When `setup_pending` clears for the same
session, the browser refreshes its Anima and settings queries, so the starter
Animas appear without a reload. A browser that predates these fields treats
`age_confirmation_required` as an unknown state and ignores `setup_pending`.

The hosted context may additionally return `account_url`, an optional central
account navigation URL. The browser accepts HTTPS or its own application origin,
rejects embedded credentials, and hides its Account controls (admission screens
and the sidebar menu) while the URL is absent or invalid. This field does not
authorize API calls or alter the immutable entry document. The consumer supplies
its configured central account URL in every context response.

A hosted context with a verified session (in any state, including first-use
setup) may also supply `recovery_session_id`, a URL-safe opaque
string of 16–128 characters (`A–Z`, `a–z`, digits, `_`, `-`). It is noncredential
metadata, stable across token/CSRF refresh for one authenticated browser session
and changed on sign-in/session replacement. It never authorizes a request. The
browser stores only this generation, owner ID and a random per-tab draft namespace
(`hosted:<generation>:<tab UUID>`) in session storage. A same-tab reload can recover the original operation ID only
after fresh cookie admission confirms the same owner and generation. New tabs
get independent namespaces, including tabs that inherit opener session storage.
A browser's "Duplicate tab" copies session storage and reports a back/forward
navigation, so the duplicate shares its source tab's namespace (last write wins),
as two local tabs share local drafts.
An absent/invalid generation withholds durable reload recovery without granting
additional permissions. Session retirement removes all tabs' marked namespaces
for that generation, preserving a newer replacement generation. Explicit account
sign-out removes marked hosted history, import receipts and model download Retry
hints, including records left by older tabs/pages; retirement also removes that
generation's hints. Local installation drafts and device preferences remain
separate. Older unmarked UUID namespaces cannot be classified as hosted or local
and are never admitted through this recovery identity.

`RuntimeSession.key` identifies the admitted per-tab recovery lifetime and changes
on sign-out/reauthentication to the same owner. A confirmed same-session reload
reuses it with fresh requests and caches. It is an opaque browser partition key,
not a bearer token, account ID or server owner selector. Owner changes, revoked
admission and sign-out abort active browser requests/streams and dispose query
caches, creator drafts, object URLs, runtime mounts/leases, workers, microphone,
playback, audio graphs and avatar state before a later session mounts. Durable
server operations keep authoritative receipts: disconnect/sign-out does not prove
rollback. A pending or ambiguous commit is recovered by its operation identity.

An events connection cut after `event: ready` reconnects without pausing
requests; a reconnect that sends `event: ready` again needs no context read,
because the stream reports revocation and the server refuses an ended session's
requests. Focusing or showing a tab reads the context again, except within 60
seconds of that tab's last read while its events stream is open or reconnecting
after such a cut. An events connection that fails or ends before `event: ready`,
a context transport error or a temporary Identity outage does not establish
revocation. An already admitted view retains its draft and
resources, suspends new product requests, and retries admission with bounded
backoff, offering a reload that keeps saved creator drafts (unsent chat text is
not kept). Fresh same-session admission
resumes dispatch, including as soon as the reconnected events stream sends `event: ready`. Repeated
uncertain events preserve a pending admission read and its backoff. A revoked
event or an events 401/403 suspends requests and reads the runtime context at
once; that context alone decides whether admission ended.
Unknown initial contexts, setup/repair states and `paused` withhold admission
without erasing persisted recovery; `paused` covers transient enrollment,
capacity, rate and cooldown limits, so an open view suspends requests until it
clears. Context 401/403, the revoking states `session_required`, `ineligible`,
`restricted` and `deletion_pending` (including when a revoked event prompts the
read), sign-out and owner/session replacement still retire private work and
purge hosted recovery immediately. A draft key never substitutes
for those checks; a recovered uncertain save reconciles its existing operation
instead of allocating another commit.

Account actions provide sign-in, Cloud-scoped sign-out, account access and usage.
`RuntimeUsage` contains named user-facing used/limit/reset units; provider prices,
credentials, arbitrary endpoints and dispatch permission are never browser inputs.
Restriction/outage state and quota request errors preserve private saved data.

Sign-in sends the current path and query, without the callback marker, as
`return_path`; the consumer validates it again. A callback that returns with
`?sign_in=failed` shows an alert on the sign-in view, and the marker is removed
from the URL before the router reads it. A signed-out tab first adopts a session
that another tab has established instead of starting a sign-in that would replace
it. `POST /api/cloud/auth/login` first ends this browser's current hosted session
(server-side logout and a cleared session cookie); if that session cannot be
ended it returns 503 `{"error":"identity_unavailable"}` and starts no sign-in.
The callback still replaces any previous session on success.

Sign-out ends private browser work at once and tells other tabs, which end
theirs and read the runtime context again when next focused; only the tab that
signed out stays signed out until a sign-in there. If the remote logout fails,
the Cloud session is still live: the browser records the failure, with that
session's `recovery_session_id` when known, and every tab and reload shows a
retryable "Sign-out did not complete" view instead of readmitting it. The record
ends when a retry (with a freshly read CSRF token) finishes, when the context
shows no session or a session with another `recovery_session_id`, or when a
sign-in from that view gets a successful login response; a failed login start
keeps the view and reports the failure. Such a sign-in never adopts the live
session, and a retry leaves alone a live session whose `recovery_session_id`
shows that a newer sign-in replaced the one it targeted.

## Capabilities and requests

The sole wire schema is `app/contracts/runtime_capabilities.py`, exported offline
in `local-http` version **26.0.0** with capability `schema_version: 2`. The generated
TypeScript `RuntimeCapabilities` and validator are the same contract.
`ProductRuntimeCapabilities` is a derived `Pick` for the existing extracted chat
surface, not another wire schema. `runtime-contracts` is version 0.26.0 and
`product-ui` is version 0.22.0. Consumers explicitly admit
the new contract major before adoption.

Permissions are separate from browser support and temporary errors:

| Operation                                                  | Canonical permission                                                      | Hosted target                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Chat and operator-catalog model/role choice                | `chat`, `model_selection`, `model_role_selection`                         | Retained; roles may select only admitted models.                                         |
| Anima creation and Anima-containing package import         | `anima_creation`                                                          | False; creation-equivalent imports reject atomically before installing content.          |
| Chat attachment entry points, paste/drop and file APIs     | `chat_file_uploads`                                                       | False; staged creator media is a separate retained API family.                           |
| Document ingestion/OCR                                     | `user_file_processing.enabled`                                            | False; no processing enqueue or document originals route is admitted.                    |
| Model connections/catalog administration and keys          | `model_configuration`, `provider_credentials`, `web_search.configuration` | False; catalog/role reads and selections remain retained.                                |
| Host paths, scans, file logs and server model installation | `local_filesystem_administration`                                         | False; virtual memory paths, creator assets and browser model downloads remain retained. |
| Electron/native controls                                   | `native_features`                                                         | False; browser fullscreen/PiP use browser feature detection.                             |
| Automatic episode processing and its status                | `automatic_episode_processing`                                            | False; owner-started Memory Manager processing remains retained.                         |
| ChatGPT plan sign-in and its status                        | `chatgpt_plan`                                                            | False; hosted mounts no sign-in routes, and the local-only return is not served either.  |
| Gemini voice                                               | `gemini_tts`                                                              | Absent or null; the hosted adapter refuses a runtime that reports it.                    |

Web search use follows the runtime fields `web_search.configured`, `backend` and
`credential_state`, not `web_search.configuration`: a hosted operator who
provisions search reports `configured: true` with its backend, and tool-capable
models then offer and request `native_tools: ["web_search"]`, while owner search
settings stay unavailable.

Browser telemetry is off unless the context's capabilities include
`browser_telemetry: {"path": "<relative path>"}`. The common app then posts
OTLP/HTTP JSON metrics and error logs to `{path}/metrics` and `{path}/logs`
through the admitted session's fetch, so each post carries the session's CSRF
header and stops when the session ends. Each body is at most 64 KiB. URLs are
reduced to their path, and user agents and identifier-shaped values are replaced.
Error messages are capped but are free text, so the receiving forwarder still
validates and sanitizes every body. See
[browser telemetry](../docs/frontend/architecture/overview.md#browser-telemetry).

`offline_speech_enabled` and its versions describe current Parakeet (English)
availability, and `offline_multilingual_speech_enabled` and its versions current
SenseVoice-Small (Japanese, Korean and Chinese) availability, not permission to
use voice. An absent optional set does not remove browser voice, Pocket TTS or
supported server speech. A model-asset list without `downloads_offered`, as a
hosted one is, means downloads are offered. The
hosted capability fixture reports SenseVoice off, and the hosted build lists no
SenseVoice lazy resource. The packaged model-asset catalog nevertheless
contains `sensevoice-stt` and `sensevoice-stt-webgpu`, so a hosted consumer that
accepts only catalog IDs it knows must support or skip both before adopting a
release with that catalog. Skipped, hosted Settings shows the SenseVoice section
as not available, and the offline choice under a non-English locale shows the
"not available on this server" notice.
Content, avatar/effect runtime, memory, creators and voice stay retained without
adding blanket permissions for implementation gaps. Unknown/missing capability
responses keep hosted operations pending rather than granting permission. No
frontend flag replaces server admission.

`library_previews` says whether the runtime offers Library item previews: the
`?variant=thumbnail` copy of an item's first image, and a Particle tile's texture
and manifest tint. Unlike the permissions above, it is runtime state that withholds
no route: it is on when absent, and the hosted adapter accepts either value. The
hosted fixture reports it `false`, the seventh hosted exception: Library cards then
show their family icons and send no preview, texture or manifest request. A server
that does not render previews may refuse `?variant=thumbnail` with 422
`content_thumbnail_unsupported`; it receives none from the browser. The Library's
Preview action, Avatar portraits and other images a screen loads for its own
purpose stay retained.

Each SDK call uses its injected client/transport. Application compositions do not
configure the compatibility default client. All browser
API, SSE, byte and model requests stay on the application origin with cookies and
the composition's mutation CSRF header. Owner IDs in cache keys/URLs are never
trusted authority. Errors retain existing route contracts, including conflicts,
revision drift, policy limits and structured provider errors. `chat:sse` preserves
sanitized events and exactly one terminal `run.completed` after admitted success
side effects. Stop/cancel is bounded; uncertain provider billing stays accountable.
All nested provider/tool/title/compaction/search/embedding/MM/Reflection/speech
work must reserve before dispatch and settle measured or uncertain units.

Private bytes, runtime snapshots, jobs, creator/import stages, exports and event
cursors resolve the current server owner on every read/mutation. Cross-owner
references fail closed. Runtime revisions retain lease/integrity checks and
same-origin range semantics; private data is `Cache-Control: no-store` and never
enters a shared CDN/service-worker cache. The only exceptions a hosted server may send
are `private` policies for Included runtime revision members and complete bundles of
them (ADR 0028), Included content files (revalidated by ETag, or kept as immutable
at their digest URLs, ADR 0033), and the owner's content catalog revalidated by ETag. The hosted transport keeps each request's own cache mode, so the browser keeps
only such replies (and only for requests that allow it); its own session and admission
reads always use `no-store`. A kept reply outlives the session in the browser's HTTP
cache, so a server that lets owner data be kept clears that cache when the owner signs
out (for example with `Clear-Site-Data: "cache"` on the sign-out reply). Content-only package import/export,
Anima export, stale revisions, drafts and ambiguous-commit recovery retain their
existing receipts and error semantics. Anima import is denied regardless of UI.

## Hosted denials

Hosted account and service limits refuse a request with a stable JSON body. Its
code is in `code`, repeated in `error` for compatibility; a FastAPI-style body may
instead nest it as `detail.code`. Optional fields sit beside the code: `limit`
names the exhausted limit (a string, except the count described below),
`retry_after_seconds` (number) is the wait before a retry can succeed,
`max_characters` (number) is the longest accepted message and `download_url`
(string) is where the user can download the desktop app after the trial. A 429 or 503
denial with a known wait also sends `Retry-After`, which the browser reads when
the body omits `retry_after_seconds`.

| Code                 | Status | Meaning and browser copy                                                                                                                                                                                                                |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quota_exceeded`     | 429    | An account limit such as `account_daily_turns`, `account_daily_spend`, `account_monthly_spend` or `operation_requests`: the usage limit and, when known, its reset time. `model_input_tokens` asks for a new chat or a shorter message. |
| `capacity_busy`      | 503    | Hosted capacity is temporarily full: busy, try again after the wait or in a moment.                                                                                                                                                     |
| `budget_paused`      | 503    | The hosted service budget is paused: the same busy copy.                                                                                                                                                                                |
| `message_too_long`   | 400    | The message exceeds `max_characters`, which the copy states.                                                                                                                                                                            |
| `chat_limit_reached` | 409    | The account reached its chat allowance; `limit` is that count, as a JSON integer or decimal string, and the copy states it.                                                                                                             |
| `trial_complete`     | 403    | The account's one-time trial AI allowance is used up (`limit: "account_trial_ai"`): the trial is complete, and the copy asks the user to download Animama to keep chatting.                                                             |

A `trial_complete` denial may add `download_url`: an absolute `https:` URL without
credentials, chosen by the consumer. The browser shows it as a "Download Animama"
link in the failed turn's notice, opened in a new tab with `noopener noreferrer`.
Any other value, such as an `http:` or relative URL, is ignored and the copy shows
without a link.

Chat creation rejects with the denial body and the `chat:sse` request returns it
as an HTTP error. A denial after a turn has started ends it with an error frame that
keeps a string `error` and carries the same code; its fields may also arrive in the
frame's `details`. Denial copy never refers the user to an installation owner or
its service. Other codes keep their existing failure copy.

## Realtime speech session descriptor

An SSE `tts.session` may additionally declare `transport: "server"` and
`websocket_url` instead of a provider token. The browser accepts a WebSocket URL
only under `/v1/` on the admitted application origin, using `wss` for HTTPS and
`ws` for local HTTP. Embedded credentials, query strings, fragments and foreign
origins are rejected; a missing/invalid server descriptor never falls back to a
direct provider. The cookie authorizes the handshake. The consumer validates the
current session and Origin, reserves before provider dispatch, and owns bounded
cancellation and settlement. Browser fixtures do not establish those server gates.
The shared route sends this descriptor when the consumer's realtime session has
`transport="server"` and a `websocket_url`. The consumer then speaks only the
reply text the route hands it through `ChatTurnServices.server_speech_text`,
prepared as the browser prepares its chunks below, never the browser's socket
text. The route hands text over only once the session is a server session, ends
it after the reply's last speech, and aborts it when the turn stops, fails or
loses its client, which can follow the end (for example a stop after the reply
was saved). The sink's methods must not block or raise.

On a server socket the browser sends `{"text": " "}` when it opens, one
`{"text": "<chunk>"}` per reply chunk and `{"text": ""}` at the end. It sends no
other frames. It plays base64 `pcm_24000` from `{"audio": ...}` frames and
ends the stream on `{"isFinal": true}` or `{"is_final": true}`. The realtime model
is `eleven_v4_turbo`.

An audio frame may also carry the spoken text's character timing as
`alignment`: `{"characters": [...], "character_start_times_seconds": [...],
"character_end_times_seconds": [...]}`, timed in seconds from the run's first
audio sample. This is the shape ElevenLabs' `stream/with-timestamps` returns,
offset to the run when it spans several requests. The browser keeps it as
lip-sync evidence and ignores malformed timing. A frame without it plays as
before. A multi-user hosted app keeps this server transport: a
direct `ttd_websocket` token binds no text, voice or model, so a browser holding
one could speak anything on the operator's account, beyond any reservation.

The existing local session remains `transport: "direct"` (or an omitted legacy
transport) with its backend-issued short-lived token. Its socket is ElevenLabs'
Text to Dialogue socket, opened with a single-use `ttd_websocket` token. Direct
playback additionally requires `provider_credentials: true`. Both paths fence late session/audio work,
close audio resources on failure or teardown, and preserve text fallback.

A speech error frame with `code: "speech_allowance_exhausted"`
(`tts.session.error`, with `run_id`, `provider: "elevenlabs"` and a human
`error`) means the owner's voice allowance cannot cover that reply, and no
provider audio plays for it. ElevenLabs speech is always realtime: there is no
finalized ElevenLabs model, and the browser ignores an ElevenLabs `tts.error`.
The shared route maps a retired id (`eleven_v3`, `eleven_flash_v2_5` or
`eleven_multilingual_v2`) to `eleven_v4_turbo`. A route that does not validate
`dispatch_options.tts` with `PyAnimaTtsRunOptions` must map retired ids with
`replace_retired_elevenlabs_tts_model_id` before `merge_chat_request_options`,
which drops unsupported ids. A
decline known before the turn precedes all reply text and no `tts.session` is
sent for the run; one found while reserving the reply's speech may follow the
reply text. Either must precede `run.completed`. Where Pocket TTS runs, the
browser speaks that reply with it, choosing the voice as for any Pocket reply,
without a notice; preferences are unchanged and the next turn asks the server
again. It switches only before the run plays audio or ends its speech and before
any speech socket failure. A decline sent instead of `tts.session` must also
arrive within the browser's 1.5 s session wait, which starts at the turn's first
event, so a turn may wait for admission before its stream starts; after an
accepted session, a decline may come at any time before `run.completed`.
Otherwise, and for every other code, the reply's speech ends with the existing
notice, which shows `error` (or the session timeout message). Because `error` is
shown only when the browser cannot fall back, it never promises the fallback.

## Static application format (A5 producer / consumer contract)

Package-set format **2** retains the format-1 source/build/packages/contracts
fields and adds exactly one `applications` record. Format-1 verification remains
supported; a format-1 set cannot establish whole-app parity. The new record names
`animama-hosted-web`, its app version, tar filename, size and SHA-256. The normal
identity is `sets/v2/<source-commit>/<canonical-manifest-sha256>/`; dirty rehearsals
use the existing development identity and cannot be promoted. `SHA256SUMS` includes
the app archive. All provenance and payloads bind the same exact tracked snapshot.
Format **3** adds exactly one `sites` record to format 2, with identity
`sets/v3/…` (see [Landing site archive](#landing-site-archive)); format-2 sets
remain verifiable.

The tar contains only regular files rooted at `animama-hosted-web/`: `index.html`,
`app-manifest.json`, build output, notices and the non-static `catalog-seed/`.
Reject links, absolute/encoded paths,
empty/dot/parent segments, duplicate members, unknown files, size/hash drift and
unsupported manifest/contract versions before serving. Archive extraction is
bounded and verifies the complete inventory before atomically selecting a build.
Raw intake counts fixed headers and expanded transport bytes before reading
extension bodies. Only one canonical local PAX `path` record, at most 1,024 bytes,
may precede its matching producer long-path member; chained, duplicate, global
and GNU extension metadata is rejected before allocation or recursive parsing.
Tar termination requires two zero blocks, bounded zero padding and a verified
gzip footer.
No source maps, development test assets, `.env`, private accounts, keys, upload
bytes or host paths belong in it. No Cloud build reconstructs product routes.

`app-manifest.json` version **1** records `source_commit`, `app_version`,
`entry_document`, `backend_contracts` (explicit inclusive minimum/exclusive maximum
major bounds), `files`, `lazy_resources`, `notices` and `catalog_seed`. The manifest
does not hash itself; its archive hash binds it. Every static file appears once with relative
`path`, `sha256`, `size`, explicit `mime_type`, `cache` (`revalidate` or `immutable`)
and `range` (boolean). `entry_document` is `index.html`; referenced entry/chunk,
worker, CSS, font, image, audio and WASM files must exist in the inventory. Only
fingerprinted build files or hash/version-bound resources gain immutable caching;
HTML revalidates. API/missing-resource requests never fall back to HTML.

Static URLs start with `/_animama/static/<digest>/`. The producer first emits with
the reserved base `/__animama_resource_template__/`, adds exact runtime, model
descriptor and notice bytes, then hashes canonical sorted JSON mapping each
relative file (including entry HTML) to `{sha256,size}`. Canonical JSON uses compact
separators, UTF-8 and one trailing newline. Only then does it substitute the digest
prefix in text and relocate static files. Verification reverses that substitution
and recomputes the digest. This avoids circular hashing and distinguishes changed
emitted bytes from the same source commit or different tooling. Vite chunk names
remain fingerprinted inside that prefix. Local builds retain `/`.

Resource decisions for the full app:

| Resource                                                                     | Delivery and integrity                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry, chunks, workers, CSS/fonts/icons and reviewed small runtime art       | Shipped in the closed app inventory; Vite dependencies and notices retained.                                                                                                                                                                                                    |
| Existing 22-file browser speech runtime                                      | Preserve every pinned engine/model variant from `models/browser-runtime/manifest.json`. Ship verified engine/runtime and baseline Pocket/Smart Turn bytes; fetch model bytes only when voice requests them. A hosted build may not pass by silently omitting its speech models. |
| Optional Pocket voice/language sets, cloning encoder and Parakeet CPU/WebGPU | Fixed, versioned lazy resource descriptors from the existing model manifests; separately admitted public model bytes from the application origin. Retain the browser download/readiness flow; no user-triggered global server install or arbitrary download URL.                |
| Included avatars, loadouts, appearances/effects and content dependencies     | The archive carries the closed non-static seed resolved by the existing `starter_inventory`. Consumer owner APIs supply its catalog/runtime descriptors and authenticated bytes. Seed members never become ordinary static routes.                                              |
| Owner VRM/image/audio/samples, drafts, exports and previews                  | Account-owned service bytes outside the static inventory and shared caches; ownership, quota, validation, leases and cleanup remain server-enforced.                                                                                                                            |

A `lazy_resources` entry identifies the fixed resource ID, version, manifest
SHA-256, same-origin route prefix and notice paths. It must resolve only the exact
manifest's regular files; absence is visible readiness/download state, never a
substitute engine. Optional resources are not automatically loaded at startup.
A5 binds the referenced manifest/notice bytes in the app artifact. C1/C5 supply
an admitted resource catalog and capacity evidence; publication rights are a
separate gate from a valid checksum.

Each optional route is `/_animama/models/<id>/<raw-manifest-sha256>/<file.path>`.
Only verified regular files from that exact manifest may be opened; an active
application switch cannot replace an older tab's model bytes. The archive includes
the original manifest and its notice bytes, not optional weights. The baseline
speech inventory retains all 22 files (287,825,103 bytes), including unused model
variants; readiness cannot silently replace or omit them.

`catalog_seed` is exactly `{manifest,sha256,size}`, naming
`catalog-seed/manifest.json`. Its version-1 manifest is exactly
`{schema_version,artifact,source_commit,source_tree,inventory,files,notices}` with
`artifact: "animama-included-content"`. Each seed file is
`{path,sha256,size_bytes}` relative to `catalog-seed/` under `included/` or
`notices/`. `inventory` is the existing `animama-starter-content/1` resolver output
with its digest, per-file license/provenance and two diagnostic-free starters.
Effect art ships as WebP derivatives of the tracked PNG masters wherever WebP is
smaller and the art carries no distribution restriction. Descriptors that name
converted art are rewritten to name the derivatives; other files keep their
tracked bytes. Each
derivative's inventory row carries `derived_from: {path,sha256,size_bytes}` naming
its master and takes that master's licence. The seed's
`included/licenses/inventory.json` records the same mapping under `derivatives`.
The only extra Included file is `included/licenses/inventory.json`. Verify both
source pins, every byte and the closed seed inventory before importing it into
the owner catalog. Ordinary app HTTP serving excludes the entire `catalog-seed/`
subtree. The installed public wheel must resolve both starters from these bytes
without a source checkout. Public permission records live under
[`licenses/`](../licenses/README.md) and the seed retains their exact notice bytes;
final binary publication remains separately authorized.

The consumer reviews MIME, `nosniff`, single-range/If-Range, ETag/HEAD, cookie/CSRF,
CSP worker/media/image/font/connect sources and WASM requirements against these
inventories. Public immutable resources and private no-store bytes have distinct
cache policies. CSP never permits arbitrary provider origins or executable
uploads. Independent artifact fixtures verify route navigation, dependency
closure and hostile manifests without a Cloud checkout. C7 additionally proves
real providers, physical audio and hosted tenancy against the selected release.

The entry document needs same-origin scripts, workers, connection and media
sources; `blob:` for owned worker/media/image lifetimes; image `data:`; inline
styles; and `wasm-unsafe-eval` for the retained engines. Serve WASM as
`application/wasm`, JavaScript as `text/javascript`, and enable COOP `same-origin`
and COEP `require-corp` with same-origin resource policy. The exact verified
`/_animama/static/<digest>/tts/workers/inference-worker.js` response additionally
requires `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'`: the retained
sentencepiece Emscripten binding constructs JavaScript call wrappers. An actual
Chromium fixture initializes Pocket and observes nonzero PCM plus worklet
`playback-started` under this worker policy. The entry document and all other
responses retain their restriction against `unsafe-eval`; executable uploads
never receive this allowance.

Keep previous verified resource/model inventories for the supported old-tab and
rollback window. A two-selection browser fixture changes the entry selection
while an old page creates its worker, then loads the new page and rolls back.
Controlled byte-change fixtures prove the selection mechanism and are labelled
separately from compatibility between two exact clean source revisions. Format
1 has no application and cannot serve as that rollback predecessor.
Both selections must retain additive clip metadata (such as the
`mutedProceduralLayers` layer-mute list) through import, edit and save, and
share the runtime's 2 MiB clip read/save bound. The fixture checks that data,
not its playback: retaining a layer-mute list does not show that a selection
mutes those procedural layers.

### Landing site archive

The static animama.ai site (`pnpm -s landing:build`, see the
[landing page guide](../docs/frontend/landing-page.md)) ships in package-set
format 3, which also requires the `applications` record. The set's `sites`
list has exactly one record with exactly `kind: "site"`,
`name: "animama-landing"`, a semantic `version`, `file` equal to
`animama-landing-<version>.tar.gz`, `sha256` and `size`. The producer takes the
version from `src/frontend/desktop/package.json`, the same source as the
application's; the verifier does not require the two to be equal. `SHA256SUMS`
lists the archive, and `compare` rejects a site version rollback and any format
downgrade that drops the site.

The tar holds only regular files rooted at `animama-landing/`: every site file
and `site-manifest.json`. It is read by the same bounded intake as the
application archive (regular files and producer long-path PAX records only, the
same per-file, total, text and member-count limits) and is packed the same way
(gzip and PAX, `SOURCE_DATE_EPOCH` timestamps, mode `0644`, sorted paths).

`site-manifest.json` version **1** is canonical JSON with exactly these keys:

- `schema_version`: `1`; `site`: `"animama-landing"`; `site_version`: the set
  record's `version`.
- `source_commit` and `source_tree`: the set's source commit and tree.
- `entry_document`: `"index.html"`.
- `headers_sha256`: the digest of `_headers`, the host's response-header rules
  (Cloudflare `_headers` format) including the CSP.
- `files`: every other member once, each with exactly `path`, `sha256`, `size`,
  `mime_type` and `cache`. The manifest does not list itself.

`cache` is `immutable` for paths under `assets/` (content-hashed names) and
`revalidate` for every other path. `mime_type` follows the application's
explicit table plus `.xml` → `application/xml`, `.vrm` → `model/gltf-binary`
and `_headers` → `text/plain; charset=utf-8`; any other file type is rejected.
File suffixes are compared case-insensitively here, for MIME, text selection
and source maps. Required files are `index.html`, `_headers`, `notices.txt` and
`robots.txt`.

The site also publishes its header for the pages Cloud adds on the same host,
as `site-chrome.json` (not required by the verifier; Cloud's build requires
it). It is JSON with exactly these keys: `schema_version` (`1`); `script`, the
root-relative path of the header's entry module under `/assets/`; `styles`, the
root-relative paths of its stylesheets under `/assets/`, in load order; and
`headers`, with `default`, `about` and `download`, the header element
prerendered for every page and for the About and Download pages
(`aria-current` on their links). The markup has
no script and no inline `style` attribute. Every file it names is in the site's
`files`.

The header's script also translates Cloud's pages. A page may hold, outside
the elements they translate, inert `<template data-localizes="<id>"
lang="<locale>">` blocks, `<locale>` a UI Locale tag. The element with that
`id` carries `data-localized`. For the header's locale, the script replaces
each such element's content with a copy of its template and sets the element's
`lang`; a template's optional `data-title` sets the document title, and a
template for `main` also sets `<html lang>`. An element without a template in
that locale keeps or restores its prerendered content. Before first paint, for
a visitor whose language is not English, the site's CSS hides `data-localized`
elements for up to two seconds while the script loads, when the header has the
language picker.

It also publishes the safety and crisis protocol for Cloud's `/safety/` page as
`crisis-protocol.json` (likewise required only by Cloud's build): JSON with
exactly `schema_version` (`2`), `html` and `translations`. `html` is
`docs/safety/crisis-protocol.md` rendered to HTML; `translations` maps each
translated UI Locale tag to its `crisis-protocol.<locale>.md`, a machine
translation that says so, rendered the same way. Each starts with its `<h1>`
and has no script and no inline `style` attribute. Schema 1 had only `html`;
a consumer must accept schema 2 before it pins a set that publishes it.

A verifier rejects source maps (any path ending in `.map`), links and special
members, unsafe paths, and any difference between the archive and `files`. It
scans every text file (`_headers` and the suffixes `.html`, `.js`, `.mjs`,
`.css`, `.json`, `.svg`, `.txt`, `.md`, `.xml`) and rejects one that contains a
stage-server route (`/__preview/media/`, `/__stage/` or `/@fs/`) or a match of
this local-path pattern (Python `re` over the raw bytes; the three lines join
without line breaks):

```text
(?i:file):(?:\\?/){2}
|(?:(?<![A-Za-z0-9_.~%\\-])|(?<=\\[nrt]))\\?/(?:Users|home|root|tmp|private|var\\?/folders|Volumes|mnt|opt)\\?/
|(?<![A-Za-z0-9_])[A-Za-z]:(?:\\{1,2}|/)(?i:users)(?:\\{1,2}|/)
```

That is: `file:` in any case followed by `//` (or `\/\/`); a Unix root folder (`/Users/`, `/home/`, `/root/`,
`/tmp/`, `/private/`, `/var/folders/`, `/Volumes/`, `/mnt/`, `/opt/`, also with
JSON-escaped `\/` separators) that does not follow a letter, digit or one of
`_.~%-\`, unless it follows an escaped `\n`, `\r` or `\t`; or a Windows user
folder (`C:\Users\`, `C:\\Users\\` or `C:/Users/`, any drive letter, `Users`
in any case) whose drive letter does not follow a letter, digit or `_`. A root-relative site route such as `/home/` therefore also fails
verification. The package-set build does not run the site in a browser; its
CSP and journeys are checked by `landing:preview` and by the consumer's
static-site checks.

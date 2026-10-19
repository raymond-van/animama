# HTTP And Realtime API

Most backend routes are mounted under `/v1`. Product routes resolve a minimal
`RequestPrincipal` through the application factory's injected resolver. Local
FastAPI validates the installation's configured Host/Origin, browser metadata
and mutation marker; desktop requests also require a renderer capability cookie.
The local composition resolves the bootstrap-owned principal from server-owned
admission state. Browser identity and Authorization headers select no owner.
Tests use explicit fixture bootstrap and dependency overrides.

Shared product routes (ADR 0021) live in `product_http/routes/`. They take owner
sessions, repositories, policy, content services, byte delivery, upload storage,
speech, the model catalog, the Memory Manager service, and the chat policy,
chat-turn guard and turn collaborators from the `ProductPorts` the composition
installs, never from `get_async_session`, so tests
replace the ports (see `tests/product_http_support.py`) or call handlers with an
explicit repository bundle. Each composition delivers verified files, runtime JSON
and package archives under its own caching policy; the paragraphs below describe
the local one.

Retained product HTTP schemas live under `app/contracts/`, including chat/history,
manual memory/Memory Manager, model roles, content/loadouts/runtime, profile and
crisis-resource (`safety.py`) views. Delivery modules reexport those definitions for existing local callers.
Consumers reuse the schemas and neutral services with their own admission, tenant
persistence, provider and byte adapters; importing a schema grants no route access.
Local setup and host/key administration schemas remain in the server composition.

## Router Map

- `server/app.py`: internal `/health` and private desktop readiness.
- `server/routers/runtime_context.py`: bounded local bootstrap context, repair,
  and first-run completion.
- `product_http/routes/runtime_capabilities.py` (shared): owner-protected
  optional feature availability, as each composition's ports report it; the
  local report (`server/runtime_capabilities.py`) includes document-worker liveness.
- `server/routers/desktop_control.py`: private pack-removal preflight, never
  included in public OpenAPI or mounted in self-host composition.
- `product_http/routes/animas.py` (shared): Anima list, reads, edits,
  chat-profile and emotional-state updates, and deletion.
- `product_http/routes/voice_catalogs.py` (shared): Pocket voice-catalog
  uploads: staging, the bounded byte upload into the composition's private
  storage, finalize into a Local `voices/` file, and abort.
- `product_http/routes/chat_turns.py` (shared): direct chat SSE, under the
  composition's [chat-turn guard](../runtime/chat.md#chat-turn-guard).
- `product_http/routes/model_catalog.py` (shared): the provider/model catalog
  for model selection, under the composition's catalog policy, and the
  model-role report.
- `server/routers/model_configuration.py`: owner model connections, models and
  the capability probe (Anthropic's Models API on the built-in Anthropic
  connection). Only `create_local_app` mounts it, outside the shared `/v1`
  aggregate, because it sends requests to owner-supplied URLs.
- `server/routers/web_search.py`: owner application web search settings and
  Test. Only `create_local_app` mounts it, because a SearXNG URL is
  owner-supplied and Test sends a query to the configured backend.
- `server/routers/model_assets.py`: pinned downloadable asset install state,
  install, removal and same-origin byte delivery.
- `product_http/routes/chats.py` (shared): chat CRUD and persisted chat messages.
- `product_http/routes/settings.py` (shared): user settings and per-anima settings.
- `product_http/routes/profile.py` (shared): the owner's private display-name
  reads and edits; each composition saves the name through its ports.
- `product_http/routes/content.py` (shared): Included/Local catalog listing, item
  reads and deletes, and registered and preview byte delivery under the
  composition's caching policy.
- `server/routers/content.py`: the local Rescan (host administration).
- `product_http/routes/packages.py` (shared): reviewed package import/export,
  bounded transfer and durable operation status; its route class keeps
  submitted data and private filesystem errors out of error responses.
- `product_http/routes/typed_content.py` (shared): typed product
  List/Get/Save/Preview routes over the shared catalog, Avatar portraits and
  face parts.
- `product_http/routes/loadouts.py` (shared): typed Anima loadout read plus optimistic,
  idempotent family plan/commit commands.
- `product_http/routes/anima_runtime.py` (shared): exact runtime issuance, lease
  renewal, JSON bundles and revision-scoped registered-byte streaming.
- `product_http/routes/avatars.py` (shared): logical Avatar CRUD and catalog
  projection over the Avatar repository and the owner's content catalog.
- `server/routers/user_files.py`: installation-owned file upload initialization,
  finalization, processing enqueue, debug chunk search, listing, abort, and
  delete lifecycle.
- `product_http/routes/memory.py` (shared): scoped markdown memory entry tree
  listing, path lookup, create, patch, move/rename, and soft-delete routes, and
  the episodic-memory listing.
- `product_http/routes/memory_manager.py` (shared): Reflection and manual
  Memory Manager run/message/approval routes; the composition's ports build the
  owner's service and choose its model runtime (`server/memory_manager.py`
  locally).
- `product_http/routes/safety.py` (shared): owner-visible crisis-resource regions
  from the composition's crisis-resource table.
- `server/routers/archive.py`: archive metadata/passages and embedding search.
- `product_http/routes/elevenlabs.py` (shared): ElevenLabs voice cloning,
  text-to-speech and sound effects through the composition's speech port.
- `server/routers/elevenlabs.py`: ElevenLabs audio isolation, which has no web
  caller and stays local.
- `server/routers/gemini.py`: Gemini voice samples for the voice picker; local
  only, like Gemini voice itself.

## Health

- `GET /health`: basic service health after local bootstrap and HTTP admission.
- `GET /_desktop/health`: private supervisor readiness, excluded from OpenAPI
  and mounted only in desktop composition. A constant-time match against the per-launch
  `X-Animama-Desktop-Control` token is required; absent/invalid credentials
  return 404. Incomplete startup returns 503 `{"detail":"runtime_starting"}`;
  failed startup content reconciliation returns the terminal 503
  `{"detail":{"code":"content_startup_failed"}}`. The bounded result contains
  schema version, runtime version, build ID, Alembic head, principal ID,
  `local_http_schema_version: 1`, `process_id` and `process_start_token`.
  The latter two identify the supervisor's exact live child. The result never
  contains the control credential or renderer capability.
- `POST /_desktop/runtime:quiesce`: the same private control boundary closes new
  product admission and waits up to 15 seconds for existing work. It returns
  `200 {"schema_version":1,"state":"quiesced"}` or
  `409 {"detail":{"code":"runtime_busy"}}`. Timeout keeps admission closed
  without cancelling work; restart the unchanged owned backend to resume.

## Optional Runtime Capabilities

`GET /v1/runtime-capabilities` uses the ordinary admitted installation
`RequestPrincipal`. It returns:

```json
{
  "schema_version": 2,
  "runtime_kind": "desktop",
  "chat": true,
  "model_selection": true,
  "model_role_selection": true,
  "model_configuration": true,
  "provider_credentials": true,
  "chat_file_uploads": true,
  "anima_creation": true,
  "local_filesystem_administration": true,
  "native_features": true,
  "user_file_processing": {
    "enabled": false,
    "worker_state": "disabled",
    "last_heartbeat_at": null,
    "pack_id": "document-processing",
    "supported_extensions": []
  },
  "offline_speech_enabled": false,
  "offline_speech_asset_version": null,
  "offline_speech_gpu_asset_version": null,
  "companion_safety": {
    "enabled": true,
    "ai_notice_enabled": true,
    "crisis_detection_enabled": true,
    "operator_reminder_hours": 3.0
  },
  "web_search": {
    "configuration": true,
    "configured": false,
    "backend": null,
    "credential_state": null
  },
  "gemini_tts": {
    "models": ["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"],
    "default_model": "gemini-3.8-flash-lite-tts",
    "voices": ["Zephyr", "Puck", "Charon", "Kore"],
    "default_voice": "Kore"
  }
}
```

The `voices` list is shortened here; the response lists all 30 prebuilt voices.

The models live in `animama.app.contracts.runtime_capabilities`, outside the
local server package, so any composition can return the same contract; the local
router is a thin adapter. `runtime_kind` is presentation metadata (`desktop`,
`self_hosted_web` or `hosted`), not an authentication mode or a feature gate;
the local composition never reports `hosted`. Capability schema version 2 is
exported in `local-http` contract version 9.0.0. `chat`, `model_selection` and
`model_role_selection` admit chat and choices from the composition's catalog,
independently of provider administration. The local adapter reports them true.
`provider_credentials` and `local_filesystem_administration` describe owner key
and host administration; the local adapter reports both true. `native_features`
is true only for desktop; browser fullscreen/PiP use browser detection instead.
See the [hosted composition handoff](../../../contracts/hosted-web.md) for its
separate account authority, retained workflows and six exceptions.
`chat_file_uploads` and
`anima_creation` report whether the composition offers chat file uploads and
Anima creation. The local composition always reports both `true`; React hides
the corresponding entry points only when a value is `false`.
`model_configuration` is true when the composition's
catalog policy enables owner models, which only the local composition does; the
local-only [model configuration routes](#model-configuration) exist only then.
The shared `GET /v1/model-roles` report is served by every composition. The
self-host composition returns a null document `pack_id`; the Electron
supervisor supplies pack-dependent settings. An enabled worker is `starting`
until its expected instance has a heartbeat, `ready` for twenty seconds after
that heartbeat, then `stale`. Enabled work may queue while
starting/stale. A disabled capability returns `409` with
`{"detail":{"code":"file_processing_unavailable"}}` from explicit process
requests before repository lookup or enqueue. Original-file upload/finalization
and existing indexed-file search still work. React checks fresh capability
metadata before enqueue and before creating an offline speech worker. The
asset versions (base and WebGPU Parakeet) are opaque cache keys, never paths or
credentials. Offline speech values are computed on every request from the
composition's `ANIMAMA_PARAKEET_SOURCE`: `asset-store` (the default)
requires `ANIMAMA_PARAKEET_STT_ENABLED` and an installed `parakeet-stt` set,
and reports installed manifest digests, so installs and removals apply without
a restart; `operator` (development Compose, where Vite serves host sets)
reports the flag and no versions.
`companion_safety` reports the operator's effective safety configuration
(the global switch already applied); owner preferences live in user settings.
`web_search.configuration` is true only in the local composition, which mounts
the [web search routes](#web-search); `configured`, `backend` and
`credential_state` describe the saved backend there and stay false/null
elsewhere. While `credential_state` is `missing`, searches return a tool error.
`gemini_tts` is non-null only where the composition offers Gemini voice, which
only the local composition does. Its
`{models, default_model, voices, default_voice}` lists the Gemini TTS model
ids, Google's prebuilt voices and the defaults (`gemini-3.8-flash-lite-tts`,
`Kore`). React offers Gemini only while it is present; see
[voice and speech](../integrations/voice-and-speech.md#gemini-tts).

## Web Search

Local composition only. The installation has at most one application web
search backend, used by tool-capable models without hosted search (see
[model clients](../runtime/model-client-providers.md#application-web-search)).

- `GET /v1/web-search/settings`: `{configured, backend, base_url,
  credential_env, credential_state, managed_credential_env, timeout_seconds}`.
  `credential_state` is `configured`, `missing` or `not_required`; key values
  are never returned.
- `PUT /v1/web-search/settings`: `{backend: "searxng" | "brave", base_url,
  credential: {mode: "none" | "env" | "managed", env}, timeout_seconds}`.
  SearXNG needs an http(s) `base_url` and takes no key, so no key is ever
  sent to an owner-supplied URL. Brave needs a key: `managed` uses
  `ANIMAMA_CONNECTION_WEB_SEARCH_API_KEY` (the desktop vault); `env` accepts
  that name or `BRAVE_SEARCH_API_KEY`. An unknown `backend` fails request
  validation (422). Other invalid input returns 400 with a `detail.code`
  (`invalid_base_url`,
  `credential_required`, `credential_not_supported`, `invalid_credential_env`,
  `invalid_timeout`).
- `DELETE /v1/web-search/settings`: 204; turns application search off.
- `POST /v1/web-search/settings/test`: sends one query to the body's draft, or
  to the saved backend without a body, and returns `{ok, category,
  result_count}`. Categories: `unreachable`, `timeout`, `credential_missing`,
  `credential_rejected` (including Brave's 422 for an invalid token),
  `rate_limited`, `json_format_disabled` (a SearXNG 403: its JSON format is
  off, or a proxy in front of it refused the request) and `bad_response`. Without a saved backend or a
  body it returns 400 `web_search_not_configured`.

`POST /_desktop/feature-packs/{pack_id}:removal-check` is a separate supervisor
contract. Only a valid per-launch `X-Animama-Desktop-Control` token reaches it;
all other requests and unknown pack IDs return 404. The bounded response has
`schema_version`, `pack_id`, nullable `source_version`/`pack_version`, `removable`,
and at most 32 `{kind, id, label}` blockers. Kinds cover Anima/loadout references,
runtime and preview leases, content operations, and live document jobs. It never
returns filesystem roots. Electron repeats preflight after draining renderers
and stopping the worker, before switching pack pointers. Catalog withdrawal
reuses the same reference checks at restart, except that Included items' own
edges into the pack are rebuilt from the new scan rather than blocking (an
optional sound drops; a required dependency becomes invalid); readiness fails
closed on conflict.

## Model Assets

The shared downloader installs files listed in the release's packaged catalog
(`animama/resources/model-assets.v1.json`, schema `animama-asset-catalog/1`).
Requests name assets by catalog ID only; the release URL is never accepted from
or returned to the browser. All routes use the admitted installation principal.

- `GET /v1/model-assets` returns `{"assets": [...], "free_bytes": N}` for every
  catalog entry. `free_bytes` is the store filesystem's free space, or `null`
  when it cannot be measured.
- `GET /v1/model-assets/{asset_id}` returns one state: `id`, `status`
  (`not_installed`, `downloading`, `installed` or `failed`), `size_bytes` (all
  files), `required_free_bytes` (size plus 64 MiB headroom), `media_type`
  (`null` for a multi-file set), `license_ref`, `files_total`,
  `files_verified`, `requires` (asset IDs that must be installed first), and
  when installed `version` (a set's manifest digest or a file's digest) plus,
  for a single file, `content_url`.
  `bytes_downloaded`/`total_bytes` are set while downloading and cover every
  file, including bytes resumed from staging; `reason` is set
  when failed (`asset_download_failed`, `asset_host_not_allowed`,
  `asset_size_invalid`, `asset_hash_invalid`, `asset_store_failed` or
  `asset_insufficient_space`).
- `POST /v1/model-assets/{asset_id}:install` returns `202` with the current
  state. It is idempotent: concurrent calls share one download and an installed
  asset stays installed. A retry resumes from staged bytes. With less free
  space than the remaining bytes plus 64 MiB, nothing is
  fetched and the state is `failed` with `asset_insufficient_space`
  (`asset_store_failed` when free space cannot be measured). Poll the
  state route for progress. A failed install can be retried with the same call.
  While the asset is being removed it returns
  `409 {"detail": {"code": "model_asset_busy"}}`; until every required asset
  is installed it returns
  `409 {"detail": {"code": "model_asset_requires", "details": {"requires": [...]}}}`.
- `DELETE /v1/model-assets/{asset_id}` cancels an in-flight download
  (discarding staged bytes) or removes the installed asset, returning the
  resulting state (`failed` with `asset_store_failed` if it cannot be
  deleted). Removal is refused with
  `409 {"detail": {"code": "...", "details": {...}}}` while a use lease is live
  (`model_asset_in_use`), while an asset that requires it is installed or
  downloading (`model_asset_required_by`, `details.required_by`), or by a
  consumer guard; a concurrent removal returns `model_asset_busy`.
- `POST /v1/model-assets/{asset_id}:lease` with `{"lease_id": "..."}` (8–128
  characters of `A-Z a-z 0-9 _ -`, chosen by the client) acquires or renews a
  use lease on an installed asset and returns `asset_id`, `lease_id`,
  `ttl_seconds` (30) and `expires_at`. Renew it about every 10 seconds while
  the asset is loaded. It returns `409` with `model_asset_not_installed`,
  `model_asset_busy` or `model_asset_lease_limit` (32 live leases per asset).
  `DELETE /v1/model-assets/{asset_id}/leases/{lease_id}` releases it (`204`,
  also for an unknown or expired lease). Leases are in memory, so a backend
  restart clears them.
- `GET`/`HEAD /v1/model-assets/{asset_id}/content` serves an installed single
  file with the SHA-256 as `ETag`, `If-None-Match` and single byte ranges. It
  returns `404 {"detail": {"code": "model_asset_not_installed"}}` until
  installed. Sets have no content route; with `ANIMAMA_PARAKEET_SOURCE=asset-store`
  the Parakeet sets are served at `/onnx/models/parakeet-tdt-0.6b-v2[-webgpu]/`
  with `?v=<manifest digest>` pinning.

Unknown IDs return `404 {"detail": {"code": "model_asset_not_found"}}`. Store
location and recovery are in [model assets](../operations/model-assets.md#downloaded-model-assets).

## Content Catalog

- `GET /v1/content/catalog` lists caller-visible Included,
  installation-shared, and owned entries with scan status, safe diagnostics,
  current revision, dependencies, and opaque file registrations.
- `GET /v1/content/items/{item_id}` reads one visible item.
- `POST /v1/content:rescan` performs an authoritative scan of registered
  Included and Local type roots and returns per-source counts plus the updated
  visible catalog. It resolves unfinished Local mutations before admission.
  Valid new files become selectable but are never equipped.
- `DELETE /v1/content/items/{item_id}` deletes one expected owned Local
  revision and purges its explicit catalog identity; Included is read-only and
  content still referenced by an Avatar or Anima loadout is rejected. File
  removal and catalog deletion share recoverable mutation ownership with an
  internal operation identity; the route does not accept a retry key.
- `GET /v1/content/files/{file_ref}` authorizes one opaque registration,
  revalidates filesystem containment, regular-file/link state, exact size, and
  SHA-256, then streams the bytes. It accepts no path or storage key. Digest
  ETags are evaluated only after authorization and integrity checks.

In embedded desktop, byte delivery uses the exact immutable Included mount
recorded with the item or preview. Unmounted/mismatched sources fail closed;
neither the renderer nor a request chooses a filesystem root. The existing
public API and ownership fields do not change for mounted sources.

Changed registered bytes return `409 content_file_changed_rescan_required`.
Unknown, unavailable, guessed, or cross-owner references all return `404
content_file_not_found`.

### Package sharing

Package sharing accepts only `.zip` files with the strict
`animama-content-package/3` manifest. The extension does not bypass integrity or
typed-content validation; unrelated ZIP archives are rejected. All routes below
are under `/v1/content`:

| Method and path | Behavior |
| --- | --- |
| `POST /package-exports:summary` | Resolve selected content or one Anima and all required content; return counts, size estimate, saved-source digest and any omitted non-portable items. A non-portable root returns 409 `package_non_portable` with `detail.items` (see [non-portable content](../features/typed-content-and-marketplace.md#non-portable-content)). |
| `POST /package-exports` | Require that digest, prepare and validate exact immutable archive bytes, then return the review and export ID. |
| `GET /package-exports/{export_id}/file` | Stream those reviewed bytes with attachment filename and SHA-256; hold the cache lease through response completion. |
| `DELETE /package-exports/{export_id}` | Discard an inactive owned cache. |
| `POST /package-imports` | Allocate a private stage with operation ID, filename and total byte length. |
| `PUT /package-imports/{stage_id}/parts/{index}` | Send sequential 8 MiB binary parts (the final part may be shorter); exact retries return the original acknowledgement. |
| `POST /package-imports/{stage_id}/review` | Seal and validate the whole archive; freeze fresh content identities, dependency copies and automatic `-2`/`-3` collision names. |
| `GET /package-imports/{stage_id}` | Read received-byte progress and the public review; no private paths or install plan are exposed. |
| `POST /package-imports/{stage_id}/commit` | Submit the operation ID and review digest to install the whole package through one recoverable content/Anima transaction. |
| `GET /package-operations/{operation_id}` | Resolve the durable result or report pending/recovery state before another submission. |
| `DELETE /package-imports/{stage_id}` | Discard inactive temporary data; refuse an active or unresolved committing stage. |

Selection accepts `item_ids` or one `anima_id`. Export preparation adds
`expected_digest`; import allocation accepts `expected_size_bytes` and
`operation_id`. Import dependencies become independent editable Local copies.
Sharing an Anima creates a fresh companion with its reviewed identity and
configuration, without conversations, other memories or provider credentials.
The [portable definition](../features/typed-content-and-marketplace.md#local-package-boundary)
allowlists saved selections and supported configuration; receiver defaults supply
model and voice settings.

Export filenames combine a display name with a UTC timestamp and `.zip`.
Anima exports use the Anima's display name; content exports use the installation
owner's display name, falling back to `content` when that name is missing.
The filename is a download label and carries no import ownership or identity.

Private stages expire after 30 inactive minutes. One owner may hold two import
and export stages combined, reserving at most 8 GiB of archive space; each
archive and its expanded inspection are limited to 4 GiB. Packages allow at most
2,048 content files, a 4 MiB manifest, 16 MiB of aggregate parsed metadata and a
maximum per-file compression ratio of 200. Available disk space is checked against
the actual archive's bounded expansion before inspection. Parts stay below the unchanged
128 MiB request limit. Unknown required capabilities, undeclared files, unsafe
paths, hash mismatches and invalid typed closures fail review.

Active upload, inspection, commit and download leases prevent cleanup. After a
completed or cancelled HTTP download attempt, the cache remains retryable until
expiry, explicit discard, or quota pressure reclaims it while inactive. Ending
the HTTP response does not prove the user saved the file.
The Library completion action discards an acknowledged import's temporary stage.
Expiry and discard never delete mutation journals or durable receipts. The old
immediate export/import routes and previous package formats are not admitted.

### Mutation receipts and recovery

Save binds an owner-scoped `operation_id` to its complete request; Import binds
it to the immutable submitted review digest. Both retain their original successful response. An identical retry returns that
response before current-item or revision validation and never writes again,
including after subsequent edits or deletion. A changed request under the same
ID returns `409 operation_id_reused`; use a new ID for new work. An original
success response is historical and does not assert the item still exists.
Delete keeps its existing expected-revision contract; a repeated deletion can
return not found.

Filesystem journals and database success receipts jointly recover interrupted
mutations before startup/Rescan admission. If subsequent manual edits conflict
with restoration, `409 content_recovery_conflict` preserves both the current
files and original backups; affected admission and mutations remain blocked
until operator repair. The local bootstrap reports content repair required
through its existing bounded readiness state. Recovery evidence must not be
deleted as cache cleanup.

## Local Runtime And Profile

These accountless endpoints still require the normal request-principal
dependency; none accepts an owner ID or internal credential from the body.

- `GET /v1/runtime-context`: return schema version 1, principal ID, bounded
  bootstrap status/failed steps, first-run completion, and nullable display
  name.
- `POST /v1/runtime/bootstrap:ensure`: retry idempotent local owner bootstrap
  and return the same bounded context.
- `POST /v1/runtime/onboarding:complete`: accept only
  `{ "display_name": string, "adult_confirmed": boolean,
  "chat_model_provider_id"?: string }`. The name is
  required and nonblank (1–80 characters); `adult_confirmed` must be `true`,
  otherwise the route returns 422 `adult_confirmation_required`. It atomically
  saves private personalization, guarded `PROFILE.md` synchronization, the
  owner's 18+ self-attestation, and write-once first-run completion. The
  optional setup model must be a usable Chat model (else 422
  `chat_model_unavailable`, nothing applied); it becomes the Chat default and
  repins starter Animas still on the model they were created with.
- `GET /v1/users/me/profile`: return only nullable `display_name`.
- `PATCH /v1/users/me/profile`: require and update nonblank `display_name`
  after first run. Missing, null, blank, and overlong names return 422.

Null display names are only pending-setup placeholders. First-run completion
requires a stored name, a timestamp and an `adult` age status; an earlier skipped setup reopens
without resetting ownership or data. `GET /v1/animas` returns owned rows in
ascending creation-time/ID order so launch falls back to Annie on fresh installs.

Local profiles provide private display-name personalization. See
[Local User Profile](../features/user-profiles-and-usernames.md).

`GET /v1/safety/crisis-resources?locale=` returns `regions` (`code`, `label`),
the owner's nullable `preferred_region`, and the `resolved` region entry. The
owner's preferred region wins, then the optional BCP 47 `locale`, then the
fallback entry. The table is bundled or replaced by
`ANIMAMA_CRISIS_RESOURCES_PATH`; see [companion safety](../runtime/chat.md#companion-safety).

## Typed Content, Loadouts, And Runtime

`GET /v1/avatar-catalog` is the paginated product-Library projection over
Avatar metadata joined to valid Content Catalog models and registered
portraits. It returns Included or Local origin without exposing paths.

Gestures, Reactions, Poses, effects, Sounds,
Avatar content, Appearance, and portable voice content expose generated typed
contracts over the neutral catalog. Each family supports List/Get/Save/Preview
under its own `/v1/{typed-family}` prefix; for example:

```text
GET    /v1/gestures
GET    /v1/gestures/{item_id}
PUT    /v1/gestures/{entry_name}
POST   /v1/gestures/{item_id}:preview
```

Equivalent families are `reactions`, `poses`, `particle-effects`,
`avatar-effects`, `scene-effects`, `sound-effects`,
`avatar-content`, `appearance-content`, and `voice-content`.
The closed handler for the selected kind validates the schema-versioned
document, files, dependencies, roles, runtime projection, and portable package
references. Unknown fields and mismatched kinds are rejected. Avatar and Scene
definitions contain bounded renderer settings and registered logical resource
names; external/data/Blob URLs, scripts, shaders, and host paths are rejected.

`GET /v1/gestures/{item_id}/idle-playback` returns exact-media finite
eligibility, or a safe reason for ineligibility, for a Gesture offered to an
Anima's Idle pool. Gesture Preview includes eligible finite facts for that
candidate's idle playback; an ordinary ineligible Gesture can still be
previewed outside idle use.
Dependency `item_id` values identify caller-visible targets. Clients resolve
locator references through those identities; they must not guess a logical-key
suffix. Raw Save receipt responses may omit this optional resolution metadata.

The Pose family returns `PyPose` metadata; registered preview bytes carry the
resolved pose values. Pose Save uses the loaded catalog revision and an operation
ID, preserving the same request for ambiguous retries. Included items are read-only;
customization saves a new Local identity. Parent references are not admitted, and
there is no Pose loadout slot.

A typed `POST .../{item_id}:preview` freezes one current validated root and its
dependency-complete support closure. Exact preview bytes use
`/v1/content/previews/{preview_id}/revisions/{revision}/files/{file_ref}`.
Preview never changes an Anima.

Two bounded multi-root operations reuse the same handler validation and
dependency resolver over exactly one caller-visible catalog read:

- `POST /v1/content/evidence:resolve` accepts exact `{kind, source:
{item_id, revision_sha256}}` roots and returns per-root plus combined
  revision maps. It is metadata-only: it issues no file capability and writes
  no preview, runtime, receipt, or product row. Stale, hidden, invalid, and
  dependency failures are ordinary safe diagnostics with `complete: false`.
- `POST /v1/content/previews:prepare` accepts catalog or versioned Builtin
  roots and returns canonical typed closures. Successful roots share at most
  one owner-scoped preview lease and one deduplicated protected file list;
  failed roots may coexist with that partial lease.

Evidence cannot be upgraded to delivery with a request flag. Preview
preparation remains an ephemeral capability and never validates or creates an
Anima.

The owner-scoped loadout endpoints are:

- `GET /v1/animas/{anima_id}/loadout`;
- `POST /v1/animas/{anima_id}/gestures:plan|commit`;
- `POST /v1/animas/{anima_id}/reactions:plan|commit` (`add` takes a Reaction
  `source` plus `emotion` and `intensity` 1–4; `remove` takes the member's
  `binding_id`; `restore_starter` takes only the cell; see
  [Reaction pools](../features/custom-animas-and-content.md#reaction-pools));
- `POST /v1/animas/{anima_id}/idle:plan|commit` (`add` takes a Gesture
  `source` plus `emotion` and `intensity`, omitted for Default; `remove` takes
  the member's `binding_id`);
- `POST /v1/animas/{anima_id}/avatar:plan|commit`;
- `POST /v1/animas/{anima_id}/appearance:plan|commit`;
- `POST /v1/animas/{anima_id}/voice:plan|commit`.

Plan requests carry the expected loadout revision and a typed family intent.
Commit repeats that intent with the reviewed plan digest and an idempotency
key. Loadout `warnings` carry `code`, `scope`, an English `message` for logs
and API clients, and `params` (for example `slot`, `name` or `semanticKey`)
that clients use to word the code in the owner's UI Locale. Selections store logical catalog items; Particle, Avatar, and Scene
Effects plus Sounds remain compiler-managed support dependencies of
Gesture/Reaction roots and cannot be equipped directly.

`GET /v1/animas/{anima_id}/runtime` independently compiles selected roots and
their transitive dependencies into one persisted owner-scoped exact revision.
Concurrent reads may reuse that effective revision. The snapshot pins the
complete admitted `catalog_item_id -> revision_sha256` map and persists one
immutable typed catalog body; it does not copy a row for every file. Each
member carries its canonical opaque `content_catalog_files.file_ref`. The file
route uses one read-only joined query to recheck owner, Anima, expiry, current
access, parent pin, item status/revision, and canonical file facts, then checks
containment, size, and digest before streaming bytes. It never returns a second
download URL and never renews the lease as a side effect of a GET.

The manifest GET negotiates gzip or identity and returns the complete
`PyAnimaRuntime` JSON. Gzip work runs off the event loop; Content-Length is the
encoded length, Vary includes Accept-Encoding, and ETag hashes the actual wire
body. The local cache policy is `private, no-cache`. Each request authorizes and
issues fresh lease information: If-None-Match never skips issuance with 304,
since `effective_revision` does not include the changing lease fields. An
unsupported encoding falls back to identity unless identity is explicitly
forbidden too; no acceptable representation returns the bounded 406
`runtime_encoding_not_acceptable` error. Local HTTP serving preserves this metadata and
compressed stream without recompression. Private files retain their exact
size/digest bytes, and SSE, WebSockets, uploads and range streams are unaffected.

The optional `json_bundle` manifest field advertises a version-1 URL, `file_refs`,
and total original bytes. `GET /v1/animas/{anima_id}/runtime/revisions/{revision}/json-bundle`
combines projected optional `application/json` sequences and manifests, excluding
the Avatar's essential closure and descriptor/meta files. Selection is deterministic
and server-owned: at least two, at most 256 files, 256 KiB each and 2 MiB in total.
Other content retains individual delivery. It accepts no client paths or member lists.

The bundle envelope is `{version: 1, revision, members: [{file_ref, text}]}`;
an unavailable member has `error` instead of `text`. Text preserves the original
UTF-8 bytes, including whitespace, for browser size/SHA-256 verification. After
loading the owner's issued snapshot, one joined query checks all selected members
against the live lease, current visibility and pinned revisions. Each file is then
opened and verified on disk, with bounded reads off the event loop. Physical
changes mark the catalog scan-required; independent good members remain usable.

Complete bundles use the same gzip/identity negotiation, wire ETag/length and
`Vary: Accept-Encoding` as manifests, with the local `private, no-cache`. Unlike issuance,
bundle GET does not change a lease, so it may return 304 **after all authorization
and physical checks**. Mixed-error responses use `no-store`, omit ETag and never
return 304. Wrong owners/revisions return 404 and expired snapshots return 409.
There is no persistent archive or server authorization cache.

Mounted clients may renew an unexpired revision and send `runtime_revision` on
every `chat:sse` request. The AI-visible Gesture vocabulary and frontend
playback catalog therefore share one fence. Missing or expired revisions return
`runtime_remount_required`; Save or Equip never silently switches an active
chat. A source edit after issuance prevents unprepared files from being served
under the old pin, while bytes already retained by a prepared browser mount
remain stable until explicit remount.

## Animas

The anima router currently owns the main user-facing backend flows:

- create, list, get, update, and delete animas
- instantiate animas from avatar rows
- update the anima chat profile default model provider
- retrieve anima payloads enriched with protected avatar/voice catalog URLs
- run the direct avatar companion chat path over SSE

`GET /v1/animas` returns a dedicated list item shape: the existing safe Anima
fields plus a required `presentation` object. Both list and detail responses
include stable `display_name`, `aggregate_revision`, and `identity_status`
(`ready` or `repair_required`). The presentation contains the same live
display name, opaque revision, and optional
`RuntimeImageReference` bounded to 256 by 256 pixels. The list loads chat
profiles, custom profile candidates, and exact primary-model portrait
candidates in set-based reads; it does not call the complete runtime resolver
for each row. A valid custom Profile Image wins. Otherwise the reference uses
the registered Appearance portrait whose metadata matches the selected Avatar
model. It remains null when neither is available.

The reference includes a normalized `presentation` object with Fill/Fit,
focal point, and zoom. These fields are revisioned presentation semantics;
saved position strings are normalized for backward compatibility.

`RuntimeImageReference.source_type` is `catalog`; its API-relative
`/v1/content/files/{file_ref}` URL is fetched with normal authentication. Both
Included and Local portraits use this protected route. The presentation
revision includes selected source and crop/focal semantics, while catalog file
integrity remains independently enforced. Detail and mutation responses retain
`PyAnimaResponse` and do not compile the list projection.

Anima rows are owner-scoped by the request principal in the retained `user_id`
column. Direct creation uses the strict command below and the caller-owned
`AnimaAggregateMaterializer`. Creation writes identity/history, definition audit, chat profile, settings,
and loadout together. Strict creation selects the owner's
`chat.default_model_provider_id` preference when it names an active chat row
the chat role accepts, on an active connection (owner rows need a context
window), else the local `ANIMAMA_DEFAULT_MODEL_PROVIDER_ID` (default
`OpenAIResponsesHTTPAgent:gpt-6-luna`), which must be active. It persists
ElevenLabs voice `gJx1vCzNCD1EQHT212Ls` without a provider request. Reads use
the Anima's stable display name independently of mutable `avatar.name`. No
runtime mount or chat/greeting is created.

`PATCH /v1/animas/{anima_id}` accepts `anima.display_name` or compatibility field
`anima.avatar_id` only with a positive body `expected_aggregate_revision`.
Missing/stale guards return `409`; missing/foreign Animas return `404`.
Names trim only outer whitespace, preserve case/internal spacing, reject
controls, and contain 1–40 Unicode code points for every new creation or
explicit rename. The existing 120-character database columns remain wider so
grandfathered names can still be read and can survive unrelated identity or
loadout edits without truncation; renaming one must choose a 1–40-character
name. A real name-only change increments aggregate revision without changing
identity/loadout versions.
An Avatar change updates the logical mapping/binding and increments aggregate
and loadout once; name plus Avatar in one PATCH still increments each once.
Direct `anima.profile_picture_url` updates return `422
use_typed_appearance_command`; use reviewed typed Appearance commands instead.
Ordinary emotional state/metadata patches do not change definition revision.

Typed loadout read/plan responses carry `aggregate_revision`. Existing
`:plan`/`:commit` bodies keep `expected_revision` for the loadout; the reviewed
digest also fences aggregate revision. A name/identity change between review
and commit returns `409 loadout_plan_stale`. Commit responses include the
resulting aggregate revision (nullable when replaying a stored receipt without that field).

### Strict private creation

These interfaces are backed by creation and starter receipt tables in the
current baseline. The [five-step creator](../../frontend/features/custom-anima-creation.md)
consumes them, and frontend-server onboarding uses the generated starter command
rather than bulk or mutable request templates.

Authenticated `GET /v1/animas/creation-options` returns versioned
Recommended Starter Pack selections/counts, limits, and diagnostics. Its
recommended `reactions` list every one of the 96 cells as a pool of available
starter Reactions; counts report `*_reaction_cells` (cells with a member) and
`*_reactions` (members) separately. Read-only `POST /v1/animas:validate` accepts
`AnimaSpec` and returns the normalized spec/warnings.
`POST /v1/animas` accepts that strict spec plus a body idempotency key; the
owner is never a browser field. The spec's `reactions` names all 96 cells, each a
list of up to four distinct Reaction references (empty allowed); creation
diagnostics point at `/reactions/{emotion}/{intensity}/{index}`. The complete
`expected_source_revisions` map
includes selected roots and all typed supports with kind/revision. The server
seeds each new companion's Idle pool itself; the seed is not part of the spec.
Before the Review step, the browser obtains that map with one
`POST /v1/content/evidence:resolve` call containing the selected Avatar,
Actions and any shared voice clone, then independently submits the whole spec to
`POST /v1/animas:validate`. The strict API retains typed profile/background
Appearance fields, but the current browser sends both as explicit nulls and
makes no Appearance read or Save request. This transition creates no preview
rows and makes no typed `:preview` calls.

Creation returns 201, identical replay 200, changed-input conflict 409, and
deleted-result replay 410. Successful replay precedes current source/default
checks. Stale sources are 409 with field/Action diagnostics; missing or
inaccessible sources are 404; malformed/invalid commands are 422. The creation
error envelope is `detail: {code, message, retryable, issues}`, with at most 100
safe JSON-Pointer diagnostics and no hidden-source revision or host path.
Missing/inactive configured defaults return 503. Failed precommit
attempts leave no receipt or aggregate. No provider request, first Chat row,
runtime mount, or Blueprint side effect occurs inside creation.

`POST /v1/animas/starters:ensure` accepts `{"schema_version":1,"repairs":[]}` and uses backend-owned
`StarterAnimaSpec` values, stable owner/starter receipts, explicit legacy repair,
and deletion tombstones. The local installation bootstrap invokes the same
owner-scoped ensure behavior with the generated principal and no explicit
repairs; ordinary ensure must not resurrect deleted starters.
Results list `created`, `existing`, `adopted`, `deleted`, or `repair_required`
per stable starter slot. Explicit `adopt`/`create_missing` repairs are accepted
only for recorded unresolved legacy slots; foreign adoption is 404. Each slot
commits independently. The generated OpenAPI client includes these contracts;
`animama.domain.anima_creation` and `animama.server.schemas.anima_creation` owns their exact schema and normalization
rules. See [custom Animas and content](../features/custom-animas-and-content.md)
for the source, identity and idempotency invariants.

### Current chat-profile update

The model selector write API is:

- `PATCH /v1/animas/{anima_id}/chat-profile`

The request body is `{ "default_model_provider_id": "<catalog row id>" }`,
for example `OpenAIHTTPAgent:gpt-6-luna` or an owner row's `owner:<hex>` id.
The route verifies anima ownership and an active `model_providers` row of kind
`chat` before updating the profile; other rows return `400`.

## Chat SSE

`POST /v1/animas/{anima_id}/chat:sse` executes the supported normal avatar
companion chat turn and streams Server-Sent Events. It resolves a anima chat
profile or request-level model override, invokes an app-scoped direct model
client, derives emotion updates from the main structured response, persists
request-local side effects, and tears resources down when the stream finishes or
is closed.

The SSE stream currently emits:

- `tts.session`
- `tts.session.error`
- `tts.audio`
- `tts.done`
- `tts.error`
- `user.response`
- `emotion.update`
- `avatar.gesture.requested`
- `chat.title.updated`
- `safety.ai_notice`
- `safety.crisis_support`
- `memory.updated`
- `run.status`
- `error`
- `run.completed`

Provider adapters may consume token and lifecycle streams internally, but the
public `chat:sse` contract is domain-level rather than a raw provider-event
mirror. For normal structured turns, `user.response` is emitted after the final
model result is parsed into speech/display parts. This makes SSE useful for
clients that need a simple request-scoped stream instead of a persistent
WebSocket.

The route accepts a `PyAnimaChatRequest` with a required non-blank `message`,
optional `chat_id`, optional `run_id`, optional `model_provider_id`,
optional `dispatch_options`, optional `client_context` (`time_zone` and
`locale` for safety presentation; `ui_locale` for the conversation language),
and required `runtime_revision`. The backend
authorizes that owner's persisted runtime snapshot before provider work and
returns `409 runtime_remount_required` when it is missing or expired. The same
snapshot's Gesture inventory defines the strict model enum,
final validation, and the revision carried by `avatar.gesture.requested`.
`model_provider_id` must match an active
`model_providers.id` row of kind `chat`, on an active connection, that supports
the requested direct-chat turn features. Owner rows also need a context window,
Responses rows run only on the built-in OpenAI connection, and Anthropic
Messages rows only on the built-in Anthropic connection; setup rejects other
rows with `400` before any upstream call. When omitted, the backend
requires the anima's explicit `anima_chat_profiles` default model provider.
Missing profiles fail setup before any upstream model call.

The selected model provider also determines the chat's API standard. Missing
chat rows are created with the selected `api_standard`. Empty chat rows created
earlier through `/v1/chats` are initialized on their first `chat:sse` request.
Later requests against the same chat must use a model provider with the same
`api_standard`; otherwise setup fails before SSE opens with `409` and
structured detail:

```json
{
  "code": "chat_api_standard_mismatch",
  "chat_id": "chat-...",
  "chat_api_standard": "chat_completions",
  "requested_api_standard": "responses",
  "requested_model_provider_id": "OpenAIResponsesHTTPAgent:gpt-6-luna",
  "action": "start_new_chat"
}
```

Every `OpenAIHTTPAgent` row uses the `chat_completions` standard whatever its
connection, so a Chat Completions chat can switch between connections; a
switch to or from a Responses (`responses`) or Anthropic
(`anthropic_messages`) row needs a new chat.
When `dispatch_options.tts.enabled=true` and
`dispatch_options.tts.provider="elevenlabs"`, the route resolves the
ElevenLabs realtime session concurrently with the primary model turn and emits a
TTS-specific session or session-error event. `dispatch_options.tts.transport`
is request intent only; backend config decides the actual direct vs backend
intermediary transport. `dispatch_options.tts.model_id` may request
`eleven_v4_turbo`, the only ElevenLabs model, which is also the default. The
retired ids `eleven_flash_v2_5`, `eleven_multilingual_v2` and `eleven_v3` are
accepted and mapped to it; any other id is rejected. The selected model is
returned in `tts.session.model_id`.
With `dispatch_options.tts.provider="gemini"`, `model_id` may be
`gemini-3.8-flash-lite-tts` (the default) or `gemini-3.8-flash-tts`. A Gemini
`model_id` with another provider, or an ElevenLabs one with Gemini, is
rejected. Gemini never starts a realtime session: where the composition offers
Gemini voice, the route pushes finalized audio (sentence or
`finalized_chunking="paragraph"` batches), otherwise the run has no speech
frames. `tts.audio`, `tts.done` and `tts.error` carry the speaking `provider`
(`gemini`) and its `model_id`.
The route does not infer TTS setup from `main_structured_response`.
Before model invocation, direct chat opens cached path `IDENTITY.md` in the
active anima scope for prompt context and appends its markdown content to the
single system instruction. When memory influence is enabled it
also opens `MEMORIES.md` and appends it directly after the identity; a missing
or blank file is omitted without failing the turn. User profile memory entries are seeded
during installation bootstrap but their content is not injected into direct chat
context yet. Direct chat adds one request-local `developer` message
immediately before the latest user message. When memory influence is enabled
it starts with a `# List of memory files` section. The list includes only
user-scope file entries (`anima_id IS NULL`), uses cached paths such as
`PROFILE.md`, and omits anima-scoped files and tree formatting. Any attached-file
list follows, and the Companion Guardrails always end the
message, as they end the system instructions. `disable_memory_influence`
suppresses the list and `MEMORIES.md` while keeping required anima identity
active. Rows that do not support OpenAI's `developer` message role, including
every row on a connection with the `fold_developer_role` compatibility option,
receive the same text in a `<turn_context>` block at the start of the user
message instead. Anthropic rows receive it as a mid-conversation `system`
message after the user message; see the
[turn layout](../runtime/prompt-caching.md#turn-layout).

## Installation Events

The events router exposes:

- `GET /v1/events:sse`

Local clients reach the stream through the same-origin local HTTP boundary.
The stream is an installation-level notification channel reserved for future
owner notifications. It currently emits heartbeat comments only and has no
Redis dependency.

Realtime notification transports should be treated as delivery signals.
Durable state remains in the database.

## Model Providers

The shared model catalog router (`product_http/routes/model_catalog.py`) supports:

- `GET /v1/model-providers`: public model catalog for frontend selection
- `GET /v1/model-roles`: the model-role report described
  [below](#model-role-report)

The route returns active serialized `model_providers` rows whose connection is
active and which the composition's `ModelCatalogPolicy` allows: built-in rows
and, only when the policy enables owner models, owner rows. The default policy
exposes only the OpenAI connection's built-in rows, or exactly the rows of an
allowlist, so a hosted composition lists no Anthropic rows unless it names
them; the local composition exposes every built-in connection's rows. Secret
values, connection base URLs and credential
references, pricing metadata, and backend-only capability fields are not
returned by the public catalog. Anima chat-profile writes and request-level
`chat:sse` model overrides must name an active catalog row. Public catalog rows
also include `model_client` and `api_standard` so clients can distinguish OpenAI
Chat Completions, OpenAI Responses and Anthropic Messages rows before sending
a chat turn.

Each row also carries:

- `source`: `builtin` (release-managed) or `owner` (added by the owner);
- `connection_id` and `connection_name`: the model connection that serves it.
  Owner rows take `provider_label` and `logo_provider` from their connection's
  current name and preset;
- `model_kind`: `chat` or `embedding`. Embedding rows serve only the
  Embeddings role, so chat selectors must exclude them;
- `hidden`: the owner hid this row from model lists. Hidden rows are still
  returned, so an Anima that uses one keeps working; selectors omit them
  otherwise;
- `context_window_tokens`: the served window, or null. Owner chat rows cannot
  chat until it is set;
- `default_reasoning_effort`: the effort the chat picker preselects, or null
  to use the first of `supported_reasoning_efforts`. Anthropic Messages rows
  report `medium` when they offer it; other rows report null.

`model_label` is never empty; it falls back to the model ID. Rows sort by
`provider_label`, then `model_label`. A database failure returns
`503 {"detail": {"code": "model_catalog_unavailable"}}` instead of a partial or
static catalog. The [model catalog](../model-catalog.md) describes built-in rows
and capabilities.

### Model role report

`GET /v1/model-roles` (shared) reports, for each role (`chat`, `utility`,
`memory_manager`, `embeddings`), the effective row, its label and connection
name, its `source` (`owner`, `default`, `inherited` or `off`), the owner's
requested row and `assignment_available` (false when that request fell back).
`embeddings_refresh` reports `state` (`off`, `current`, `re_embedding` or
`retrying`), the `pending` row count and the last failure's `error_category`,
as the composition's embedding refresh status reports them.

## Model Configuration

Only `create_local_app` mounts these owner routes; `model_configuration` in
[runtime capabilities](#optional-runtime-capabilities) reports them. They use
the admitted installation principal. Responses name credential variables and
report `credential_state` (`configured`, `missing` or `not_required`) but never
carry a key value.

- `GET /v1/model-connection-presets`: owner-selectable presets (Ollama, LM
  Studio, llama.cpp, vLLM, DeepSeek, Hugging Face, OpenRouter and Custom) with
  the default base URL, whether a key is expected, a suggested key variable,
  compatibility options and the timeout. Local presets use
  `ANIMAMA_LOCAL_MODEL_HOST` as their host.
- `POST /v1/model-connection-presets/{preset_id}/detect`: for a local preset
  (`ollama`, `lmstudio`, `llamacpp` or `vllm`), request `GET {base}/models` at
  the preset's default base URL without a key, allowing 3 seconds to connect
  and to read. The request carries no address. Returns `{preset, base_url,
  reachable, models, category}`: up to 200 sorted model IDs when the server
  answers, otherwise `reachable: false`, empty `models` and a failure
  `category` such as `unreachable` or `timeout` (still `200`). Other presets
  return `400 preset_not_local`; unknown or non-selectable presets return
  `404 unknown_preset`.
- `GET /v1/model-connection-presets/openrouter/models`: OpenRouter's public
  model list as `{models: [{id, name, context_length, supports_tools,
  supports_structured_outputs}]}`. The backend reads only
  `https://openrouter.ai/api/v1/models`, without a key or redirects, within
  10 seconds and 8 MiB, and caches a successful list for 10 minutes. The two
  capability flags come from each model's `supported_parameters` (`tools`;
  `structured_outputs` or `response_format`). An upstream failure returns
  `502 openrouter_models_unavailable`.
- `GET /v1/model-connections`: active connections, including the built-in
  `openai` and `anthropic` connections, each with its active models. A model's
  `early_compaction` is its **Compact early** setting, or null when the model
  has no long-context price step.
- `POST /v1/model-connections` (`201`): create a connection from `name`,
  `preset`, `base_url`, a `credential` (below), and optional `compatibility`
  and `timeout_seconds` (1–1800; the preset's default when omitted). Base URLs
  must be `http` or `https` with a host, and without credentials, query or
  fragment; a trailing slash is dropped. Invalid input returns `400` with a
  code such as `invalid_base_url`, `invalid_preset`, `invalid_timeout` or
  `invalid_credential`.
- `PATCH /v1/model-connections/{connection_id}`: change the given fields;
  omitted fields, including the credential, keep their values. Built-in
  connections return `400 connection_read_only`.
- `DELETE /v1/model-connections/{connection_id}?confirm=`: retire the
  connection and all its models. Built-in connections return
  `400 connection_read_only`.
- `GET /v1/model-connections/{connection_id}/available-models`: the server's
  model IDs from its `/models` endpoint; on the Anthropic connection, the IDs
  Anthropic's Models API offers the key's organization.
- `POST /v1/model-connections/{connection_id}/probe`: send small requests to
  `model` and return suggested capabilities. A chat probe reports each step
  (streamed text, a strict `json_schema` reply or else JSON mode, a tool call,
  and tools with a schema in one request) with `ok` and a failure `category`;
  a failed streaming step ends the probe. It also reports the loaded
  context window when llama.cpp (`/props`), Ollama (`/api/ps`) or LM Studio
  reports one. An `embedding` probe reports the vector dimensions. A Responses
  probe checks that the model exists and is refused off the built-in OpenAI
  connection (`400 invalid_provider_type`). Without `provider_type` the probe
  uses Anthropic Messages on the built-in Anthropic connection and Chat
  Completions elsewhere. On the built-in Anthropic connection the probe sends
  no message: it reads Anthropic's Models API (`models.retrieve`) and reports one
  `available` step plus the context window, `max_output_tokens`,
  `supported_reasoning_efforts` (`none` first when the model accepts disabled
  thinking), the structured-output transport and `native_tool_support`
  (`web_search`); a failure is a failed `available` step with a category and a
  fixed detail. There, an `embedding` probe returns `400 invalid_model_kind`
  and any other provider type `400 invalid_provider_type`, as does an
  Anthropic probe elsewhere. Values the probe could not
  determine are null. Saving the model stores a summary in `probe_result`: the
  findings and each step's name, result and category; step details and notes,
  which can quote server error text, are dropped.
- `POST /v1/model-connections/{connection_id}/models` (`201`): add an owner row
  with `model`, optional `label`, `kind`, `context_window_tokens`,
  `allow_memory_writes` (default true), `probe_result` and `capabilities`, or a
  built-in chat `template_id` whose capabilities are copied. `provider_type`
  may choose `OpenAIResponsesHTTPAgent` only on the built-in OpenAI connection.
  Models on the built-in Anthropic connection are always
  `AnthropicMessagesHTTPAgent` chat rows copied from an Anthropic template or
  described by the probe; they reject JSON mode and efforts outside `none`,
  `low`, `medium`, `high`, `xhigh` and `max` (`400 invalid_capabilities`), and
  Anthropic templates and that provider type are refused elsewhere
  (`invalid_template`, `invalid_provider_type`). Other connections use Chat
  Completions. Re-adding a removed model on the same
  connection reactivates its row; adding one that is already active on it
  returns `409 model_already_added`.
- `PATCH /v1/model-providers/{model_provider_id}`: edit an owner row's label,
  capabilities, context window (`clear_context_window` unsets it), memory
  writes, probe result, `hidden` or `early_compaction`. Built-in rows accept
  only `hidden` and `early_compaction`; other fields return
  `400 model_read_only`. `early_compaction` is accepted only on a model with a
  long-context price step (`400 early_compaction_unavailable` otherwise).
- `DELETE /v1/model-providers/{model_provider_id}?confirm=`: retire an owner
  row. Built-in rows can only be hidden (`400 model_read_only`).

A connection's `credential` takes one of three modes:

- `{"mode": "none"}`: no key and no `Authorization` header;
- `{"mode": "env", "env": "NAME"}`: read the key from a variable named
  `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `HF_TOKEN`, `OPENROUTER_API_KEY` or
  `ANIMAMA_CONNECTION_<NAME>_API_KEY`, so a reference cannot read other
  secrets. `ANTHROPIC_API_KEY` is refused (`invalid_credential`): only the
  built-in Anthropic connection reads it;
- `{"mode": "managed"}`: read the key from `ANIMAMA_CONNECTION_<ID>_API_KEY`,
  derived from the connection ID, which the desktop vault sets.

Removal is soft: rows and connections become inactive because chat profiles
and chat history still reference them. When Animas or role preferences use the
target, removal without `confirm=true` returns
`409 {"detail": {"code": "model_in_use", "usage": {"animas": [...], "roles": [...]}}}`
and changes nothing; `animas` lists `anima_id`, `display_name` and
`model_provider_id`, and `roles` names preference keys such as
`models.utility_model_provider_id`. A confirmed removal returns
`{"removed": true, "usage": ...}` and clears the role preferences (including
`chat.default_model_provider_id`) that named a removed row, so those roles use
their defaults. Chat profiles keep naming the retired row, which chat setup
rejects, until the owner picks another model.

A probe or model listing that cannot start because the connection's key is
missing or its base URL is invalid returns `400` with `detail.code`
`credential_missing` or `invalid_base_url`. A model listing that fails upstream
returns `502` with a category such as `unreachable` (including a base URL
without a `/models` endpoint), `credential_rejected`, `timeout` or
`unexpected_response`. Unknown or removed connections and models return `404`
(`connection_not_found`, `model_not_found`). Connection changes, model edits
and removals wake re-embedding.

## Memory

Memory APIs expose a scoped Markdown entry tree:

- `GET /v1/memory/entries?anima_id=&parent_id=&recursive=false`
- `GET /v1/memory/anima-identities`
- `POST /v1/memory/anima-memories/{anima_id}:repair`
- `GET /v1/memory/entries/by-path?anima_id=&path=...&type=file`
- `GET /v1/memory/entries/{entry_id}`
- `GET /v1/memory/entries/{entry_id}/versions?before_version=&limit=50`
- `GET /v1/memory/entries/{entry_id}/versions/{version}`
- `POST /v1/memory/entries`
- `POST /v1/memory/entries/{entry_id}:revert`
- `PATCH /v1/memory/entries/{entry_id}`
- `DELETE /v1/memory/entries/{entry_id}?expected_version=N&recursive=false`
- `POST /v1/memory/debug/search-memory-files`
- `GET /v1/memory/episodes?status=pending&limit=100`
- `POST /v1/memory/manager/runs`
- `POST /v1/memory/manager/runs:process-episodes`
- `POST /v1/memory/manager/runs:reflect`
- `GET /v1/memory/manager/runs/current`
- `GET /v1/memory/manager/runs/{run_id}`
- `POST /v1/memory/manager/runs/{run_id}:complete`
- `POST /v1/memory/manager/runs/{run_id}/messages`
- `POST /v1/memory/manager/approvals/{approval_id}:decide`
- `POST /v1/memory/manager/approvals/{approval_id}:undo`

Memory entry routes require the resolved request principal and never accept a
client-supplied owner.
Rows are scoped by nullable `anima_id`: `NULL` is installation-owner memory, and
non-null selects one anima-specific tree after validating that the anima belongs
to the current user. The virtual root is represented by `parent_id = NULL`;
files and directories share one sibling namespace, stable IDs, cached POSIX
paths, optimistic version checks, soft deletes, and immutable version snapshots.
Stale current-row versions and non-recursive directory deletes with live children
return `409`.

Entry names are stable POSIX path segments. The service rejects blank names,
traversal segments, slashes, backslashes, control characters, non-markdown file
paths, oversized paths/segments, and display-name characters such as spaces.
The one exception is `POST /v1/memory/entries` for a file with
`create_parents=true`: in that request, `name` is a validated relative POSIX
Markdown path below `parent_id`, and every missing directory is created in the
same unit of work. `expected_version=0` prevents a retry from overwriting an
existing file, and directory requests cannot enable `create_parents`.
Move/rename rejects cycles, cross-user moves, cross-anima-scope moves, and
parenting under files. Responses include optional `description`, `metadata`,
derived `scope`, entry `type`, cached `path`, and file header fields. Blank
descriptions are stored as null.

Version history is authorized through the owned current entry, including when
that entry is soft-deleted. The list route returns content-free summaries in
newest-first order and supports bounded cursor pagination with
`before_version`; the default page size is 50 and the maximum is 100. The
detail route returns one immutable snapshot and only its adjacent change:
Version N is compared with Version N-1, while Version 1 uses a virtual empty
Version 0 creation baseline. Content is represented as a unified diff and path
and description changes as structured old/new values. Generated episode logs
have readable history, but the routes are read-only and expose no arbitrary
two-version comparison.

`POST /v1/memory/entries/{entry_id}:revert` accepts positive
`target_version` and `expected_version` values. It requires an owned editable
live Markdown file at exactly the expected Version and an existing older target
Version for the same entry. The mutation copies only content and normalized
description, preserves current identity/tree/path/kind/metadata/scope/live
state, and appends a new `revert` Version with source and target-Version
provenance. Missing or foreign entries return `404`; stale current Versions
return `409`; protected/generated/directory/deleted, current/future/missing, and
no-change targets return `400`.

Anima-scoped `IDENTITY.md` reads/writes additionally return
`aggregate_revision`. Create/repair, PATCH, and Revert for that file require
`expected_aggregate_revision` alongside the memory version (`0` for creation).
Missing/stale aggregate guards return `409`. Each successful write appends one
memory version and definition audit revision in the same transaction. The
identity must be nonblank UTF-8 Markdown, with CRLF/CR normalized to LF while
preserving meaningful whitespace, and at most the smaller of 32 KiB and
`ANIMAMA_MEMORY_FILE_MAX_BYTES`. Moving, renaming, deleting or changing the kind
of a required identity file is forbidden; deleting the Anima removes it. A missing/blank identity
blocks chat until explicit repair; there is no current-Avatar fallback.

Anima-scoped `MEMORIES.md` has the same protections but needs no aggregate
revision, may be blank, and is limited to the smaller of 16 KiB and
`ANIMAMA_MEMORY_FILE_MAX_BYTES`. Creating any other file or directory in an
Anima scope, or moving or renaming an entry within it, returns `403`. `POST /v1/memory/anima-memories/{anima_id}:repair` recreates a missing
`MEMORIES.md` from the template, returns its header, and otherwise changes
nothing; `GET /v1/memory/anima-identities` reports each header as
`memories_entry`, `null` when missing.

`POST /v1/memory/debug/search-memory-files` is a read-only authenticated debug
route for the direct-chat `search_memory_files` tool path. The request accepts a
trimmed non-empty `query` up to 2048 characters. The response echoes `query` and
returns `memory_results` without scores, match types, object-storage keys, URLs,
user IDs, embeddings, versions, hashes, timestamps, or metadata.

The episode and manager routes are also authenticated and current-user scoped.
The static manager `/runs/current` route returns the one `active` or
`waiting_approval` snapshot, or `null`, and is declared before the dynamic run
route. Creating a run atomically completes stale active state before insertion;
an unresolved approval instead returns `409 Conflict` without changing the
existing run.
`GET /v1/memory/episodes` lists source-of-truth episode rows for manual review,
defaulting to `status=pending`. Episode status is binary: `pending` requires
review and `processed` has been reviewed, regardless of whether curated memory
changed. There is no public manual status-mutation route; the specialized
processing workflow owns that transition.

`POST /v1/memory/manager/runs:process-episodes` accepts only
`auto_approve_diffs`. It locks open manager state, refuses to replace a run
with a pending approval, selects up to 51 oldest pending rows in
`(occurred_at, id)` order, and binds the first 50 to a new specialized run.
The extra row supplies `has_more`; a user with no pending rows receives
`409 Conflict` without losing the current active run. The public run response
contains `kind = "episode_processing"` and a safe task summary, never raw task
state, durable episode IDs, or copied episode text.

While the private task is `processing`, the runtime reloads the fixed owned
rows and presents them as `E01` through `E50`. Rows stay pending through model
execution and approval pauses. Only a completed terminal result with no pending
approval atomically marks exactly that batch processed, refreshes affected
daily files, and changes task status to `processed`. The run itself remains
`active`; later messages use general Memory Manager instructions with the
same run's context. Overflow and newly captured rows are not changed. Blocked or
failed runtime results fail the run and leave the task and rows pending.

`POST /v1/memory/manager/runs:reflect` accepts `anima_id` and
`auto_approve_diffs`, and starts a Reflection over that owned Anima's oldest
uncovered chat turns across all its chats, at most 400 turns or 200,000
characters of turn text. It follows the same open-run rules: it supersedes an
open run without a pending approval and returns `409` while one is pending. A missing or foreign Anima returns `404`.
It also returns `409` without creating a run when the Anima's `MEMORIES.md`
needs repair or no turn is uncovered (`There are no new turns with <name> to
reflect on`). The `201` response is the normal run snapshot with
`kind = "reflection"` and a `reflection` summary (`anima_id`, `anima_name`,
`turn_count`, `remaining_turn_count`, `started_at`); `task` stays `null`.
Proposals target `animas/<anima_id>/MEMORIES.md`. Approving one (manually or
automatically) marks the run's turns covered in the same transaction; Undo of
that approval uncovers them again. Rejection, a superseded run, failure or a
`409` version conflict leave the file and coverage unchanged.

Manager messages normally run a live workflow on the Memory Manager role's
model over a constrained virtual memory workspace: the OpenAI Agents SDK with an
approval-gated Apply Patch tool (hosted on Responses rows, a function tool on
Chat Completions rows), or, on Anthropic rows, Anthropic's memory tool whose
edits become the same approvals. `ANIMAMA_LLM_SKIP=1` switches this to the
deterministic local test runtime. See
[Memory Manager and episodic memory](../features/memory-manager-and-episodic-memory.md#runtime-implementations).
Approval decisions are real commits for valid create/update patches: approved
patches write through `MemoryEntryService` and atomically store the target entry
ID and resulting `applied_version`; public previews carry separate nullable
`old_description` and `new_description` values alongside body content/diff
fields. Rejected patches do not change
memory, and stale version/path conflicts return `409 Conflict` while leaving
the approval pending. Reject requests may include normalized
`feedback` of at most 2,000 characters; nonblank feedback is invalid with
`decision = "approve"`. Persisted feedback is returned on the approval and is
included in the rejection message the model receives so the same processing run
can propose a corrected patch. Manager create and append bodies accept
`auto_approve_diffs` (default false). When enabled, the backend follows only the
durable approval chain attributed to that submitted message, committing and
resuming sequentially up to eight times; the frontend does not orchestrate
automatic approval calls.

Approval responses also include `undone_at`, `undo_version`, and server-computed
`can_undo`. `POST
/v1/memory/manager/approvals/{approval_id}:undo` rechecks eligibility under
locks. Only the latest approved, not-yet-undone create/update for a target can
be Undone, no approval may be pending in the same run, and the editable live
target must still be at its applied Version. Update Undo restores prior content
and description together; create Undo
soft-deletes the created file while retaining generated parents.
Both append an `undo` Version and preserve the original approval decision. A
successful retry is idempotent. Missing/foreign resources return `404` and
stale or ineligible requests return `409`.

Normal direct chat assembles the current anima identity entry content into
system instruction context. Anima identity is always required, and
`disable_memory_influence` does not remove it. Anima creation seeds
anima-scoped identity entries with
`description = "Initial identity of {anima.display_name}"`. The local
installation bootstrap creates a private user-scope `PROFILE.md` from template
version 2; first-run personalization sets its `Preferred name:` line only while
nothing else has edited the file since the last managed write. AI
memory tools are runtime-scoped to user-scope file entries plus the active
Anima's own `MEMORIES.md` through the `[self]/MEMORIES.md` alias, and are
executed through application services, not provider clients.

## Chats

The preferred and currently mounted chat history API is `/v1/chats`. It exposes
product-shaped chat CRUD and message retrieval backed by `chats` and
`chat_messages`:

- `POST /v1/chats`
- `GET /v1/chats`
- `GET /v1/chats/{chat_id}`
- `PATCH /v1/chats/{chat_id}`
- `DELETE /v1/chats/{chat_id}`
- `GET /v1/chats/{chat_id}/messages`
- `POST /v1/chats/search`

Chat creation verifies the referenced anima exists and is owned by the
current user; missing or foreign animas return `404`. Chat reads, updates,
deletes, and message reads are scoped to the current user's chats. Message
responses expose `chat_id`, `run_id`, `model_provider`, `model`, and
`internal`; identifiers belong to Chats and request-local runs. Visible
assistant messages also carry nullable `memory_cue`
(`{episode: {text} | null, memories: {entry_id, version, excerpt} | null}`),
combining the reply's stored `MEMORIES.md` change with the episode note
captured from it; see [Chat Memory Cue](../features/memory.md#chat-memory-cue).
Message reads hide internal rows by default, and
`include_internal=true` includes those rows with `internal=true`. Chat responses
include nullable `api_standard`, `last_model_client`, `last_model_id` and
`last_model_provider_id` fields. `last_model_provider_id` is the catalog row of
the latest successful turn; clients restore the chat's model by it, since
`last_model_id` alone cannot tell connections that serve the same model name
apart. Responses also carry cumulative usage totals accumulated from persisted
assistant message usage plus `active_context_tokens`: the latest normal
assistant turn's last model request (its prompt and reply, minus output
reasoning tokens), which stays in the next turn's context. A turn with tool
rounds bills every request but counts only the last here. When a server streams
no usage, the turn records a character-based estimate marked `usage_estimated`,
so the count still grows and compaction can trigger. Chats created
through `POST /v1/chats` can return null standard and last-model fields until
the first model-backed `chat:sse` request initializes the standard and a
successful durable turn records the last model snapshot. Non-empty
null-standard chats are treated as invalid transcript state by `chat:sse` and
should be replaced by a new chat.

Chat search runs PostgreSQL full-text search over visible current-user chat
messages. Structured assistant speech and display text are concatenated for
indexing and snippets; snippets hide the speech's audio tags
([audio tags](../integrations/voice-and-speech.md#audio-tags)), while matching uses the stored speech. Messages without
structured response text fall back to raw `content`. The API accepts `query`, `limit`, and `offset`, uses sanitized
prefix FTS for partial terms instead of web-search operator syntax, hides
internal rows, uses a generated `search_vector` column backed by a partial GIN
index scoped to visible user/assistant content, joins through
`chats` for ownership, and returns one result per chat. The best matching
visible message in each chat supplies the snippet and score, while the response
includes chat/anima metadata including the anima `profile_picture_url` for
result rendering.

## Settings

Settings routes manage:

- user-level settings
- anima-level settings

User `locale` is the UI Locale: `en`, `ja`, `ko`, `zh-Hans` or `zh-Hant`, or
`null` for "System default" (the client resolves it from the OS or browser).
It controls interface text and formatting; the client reports the locale it
applied with each chat turn (`client_context.ui_locale`), which sets the
Conversation language. It is never the crisis region. `POST`/`PATCH` accept
`null` to clear it; any other tag, including `en-US`, returns 422. Stored
unsupported values read as `null`.

Before `POST`, `PATCH` or `DELETE /v1/users/me/settings` writes, shared routes
await `ProductPorts.prepare_user_settings_change(session, principal, mutation)`.
The immutable `UserSettingsMutation` identifies `create`, `patch` or `reset` and
preserves exactly the supplied fields, including omitted versus explicit `null`
locale; reset has an empty patch. The hook runs after request validation, model
role validation and the create-conflict check, before defaults are materialized
or local settings are written. The local composition does nothing in this hook.
A composition with an external preference authority validates its additional
field and ownership rules before performing external effects, using the same
composition-owned write session as the settings repositories.

The composition may raise `ProductRefusal` from the hook or its deferred commit;
the function-scoped session closes before the HTTP response is sent. Hosted
locale errors distinguish conflict, authority unavailability, an unknown save
outcome and a confirmed locale save followed by a failed settings write; see
[the hosted contract](../../../contracts/hosted-web.md). A confirmed external
save is not compensated by the shared routes. Compositions that defer commits
also defer the existing `user_settings_changed` notification until their commit
succeeds.

Anima settings include runtime preferences such as memory influence, memory
updates, emotional analysis, and presentation flags for animation or visual
effects. Dispatch option resolution combines request-level overrides, settings,
and anima defaults.

User `preferences` also hold model choices as catalog row IDs:

- `chat.default_model_provider_id`: the default model for new Animas and the
  chat role;
- `models.utility_model_provider_id`: titles and compaction;
- `models.memory_manager_model_provider_id`: the Memory Manager;
- `models.embedding_model_provider_id`: upload and archive embeddings.

`PATCH /v1/users/me/settings` replaces the whole `preferences` object. The local
composition stores these IDs without validating them; a composition whose
catalog policy sets `validate_role_preferences` refuses an ID naming a row that
cannot do its role with `422 {"detail":{"code":"model_role_unavailable"}}`.
Role resolution checks the row when it is used and falls
back to the role's default when the row is removed, of the wrong kind or lacks
a needed capability: the operator default (`ANIMAMA_DEFAULT_MODEL_PROVIDER_ID`
for chat, `ANIMAMA_DEFAULT_{UTILITY,MEMORY_MANAGER,EMBEDDING}_MODEL_PROVIDER_ID`
for the others), then the chat role for utility and the Memory Manager, while
embeddings stay off.
`GET /v1/model-roles` shows the result. Role resolution applies these
preferences only when the composition's catalog policy enables owner models.
Writing user settings wakes re-embedding.

## Avatars And Uploads

`/v1/avatars` manages logical Avatar metadata and its identity template.
Creating or renaming an Avatar to a name the owner already uses returns
`409 {"detail":{"code":"avatar_name_conflict"}}`; other owners' names never
conflict.
Playable VRM bytes are valid Included or Local `avatar` catalog items. A
private Avatar associates `catalog_item_id`; Included rows resolve their
source-controlled model to the matching catalog item.

Avatar creator Save publishes a normal `content/local/avatars/<name>.vrm` plus
an optional sidecar through `PUT /v1/avatar-content/{entry_name}`. The shared
VRM validator admits only structurally valid self-contained VRM 0.0/1.0 up to
100 MiB. Identical bytes reuse a valid caller-owned Avatar without changing
metadata; different-byte collisions require rename or revision-checked replace.
The optional form `creation_context=true` prevents replacing an in-use Avatar.

`PUT /v1/appearance-content/{entry_name}` canonicalizes bounded static
PNG/JPEG/WebP inputs (16 MiB, 8192 per side, 40 million pixels). The portrait
endpoint `PUT /v1/avatar-content/{item_id}/portrait` takes multipart `file`,
`entry_name`, `operation_id`, and `expected_avatar_revision`; a 512-square WebP
capture becomes a normal owner-scoped 256-square Appearance up to 256 KiB.
It does not modify the Avatar or any Anima. Confirmed content survives cancelled
or rejected creation. Typed previews expose `expected_source_revisions` for
the creation-compatible root/support closure, independent of preview pins.

`GET /v1/avatar-content/{item_id}/face-parts` returns the effective
face-part correction as `{item_id, revision, source, face_parts}`, where
`source` is `local_metadata`, `included_override` or `none`.
`PUT` takes `{expected_revision, face_parts}`; `face_parts: null` clears it.
A stale revision returns `409 catalog_revision_conflict` with
`current_revision`, and a correction whose `vrm_sha256` is not the Avatar's
model digest returns `422 content_invalid` with reason
`avatar_face_parts_digest_mismatch`. A Local save rewrites the sidecar and
returns the new revision; an Included save stores only the caller's override.
See [face-part corrections](../features/custom-animas-and-content.md#face-part-corrections).

Appearance and portrait images are typed `appearance` catalog items. Focused
`/v1/animas/{anima_id}/appearance:plan` and `:commit` commands store
profile/background selection plus crop/focal configuration.

## User Files

The user-files router manages installation-owned document uploads, processing jobs,
and backend debug search. It exposes:

- `POST /v1/files/uploads`: validate filename, allowlisted extension, and
  declared size; create a pending `user_file` row; return a private
  API-relative PUT target.
- `PUT /v1/files/{file_id}/content`: resolve the bootstrap-established owner, bound the streamed
  body, spool beneath `data/staging/uploads`, and atomically promote the exact
  bytes to `data/user-files/<user-id>/<file-id>/original`.
- `POST /v1/files/{file_id}:finalize`: verify the current user's pending row,
  opaque local locator, file existence, and exact size; mark the row
  `uploaded`.
- `POST /v1/files/{file_id}:process`: enqueue or reuse a durable processing job
  for the current user's finalized file. The API process only enqueues; parsing
  runs in the `animama-file-worker` process.
- `POST /v1/files/debug/search`: search current-user processed chunks in
  `keyword`, `semantic`, or `hybrid` mode. Keyword search uses PostgreSQL
  full-text search. Semantic search embeds the query with the Embeddings role
  and searches chunk vectors from that model; it returns `503` while the role is
  off. Hybrid search combines keyword and semantic candidate ranks with
  reciprocal rank fusion, and returns keyword results alone while the role is
  off or the searched files await re-embedding.
- `POST /v1/memory/debug/search-memory-files`: run the AI memory-tool debug
  search over user-scope markdown memory entries.
- `GET /v1/files`: list the current user's non-deleted file records newest first.
  Responses include cheap processing summaries: chunk count and latest job
  summary when available.
- `GET /v1/files/{file_id}`: return one current-user file record or `404`.
- `DELETE /v1/files/{file_id}`: best-effort delete the local original and mark the row
  `deleted` or `delete_pending`; stored chunks are removed from debug search.
- `DELETE /v1/files/uploads/{file_id}`: abort a non-finalized upload and
  best-effort delete its staged/local bytes.

Original download URLs are not exposed. Direct chat accepts validated
`attached_file_ids` and reads processed chunks through bounded tools; see
[user files](../features/user-files.md#search-and-retrieval). Supported extensions are:
`.txt`, `.md`, `.rst`, `.org`, `.json`, `.csv`, `.tsv`, `.html`, `.htm`, and
`.xml`, plus digital rich documents `.pdf`, `.docx`, `.pptx`, and `.xlsx`.
Macro-enabled Office files, executables, scripts, installers, and archives remain
blocked.

See [user files](../features/user-files.md) for the end-to-end local upload
flow, parser worker lifecycle, statuses, configuration, and debug UI behavior.

## Archives

The archive router manages anima archive metadata and passages. Passage writes
embed text with the Embeddings role model when the role is on. Search ranks by
vector similarity against that model's vectors, and falls back to PostgreSQL
full-text search (ignoring `threshold`) while the role is off, while passages
await re-embedding or when the query cannot be embedded. Archive data is
separate from the scoped Markdown memory filesystem.

## ElevenLabs

The ElevenLabs router exposes utility routes for voice clone, text-to-speech
preview, sound effects, and audio isolation. Text-to-speech
(`POST /v1/elevenlabs/text-to-speech`) speaks through Text to Dialogue with
`eleven_v4_turbo`. Its `text` holds at most 2,000 characters, Text to
Dialogue's request limit. Its `voice_settings` take only
`stability` and `similarity_boost`, since v4 has no Style, Speed or Speaker
Boost. `POST /v1/animas/{anima_id}/chat:sse` owns chat TTS
bootstrap and audio delivery.

Realtime chat TTS resolves the anima voice from
`speech.elevenlabs.primary_voice`, ignores legacy saved variant maps, selects
`eleven_v4_turbo`, and emits `tts.session` with a single-use `ttd_websocket`
token for ElevenLabs' Text to Dialogue socket, with `sync_alignment: true`.
The session requests ElevenLabs character timing, which the browser keeps as
lip-sync evidence; the backend never sees it.
ElevenLabs offers no finalized chat speech; Gemini is the only provider whose
audio the route pushes.

## Gemini voice samples

`GET /v1/gemini/voices/{voice}/sample?model_id=` returns a brief `audio/wav`
sample of one prebuilt voice for the voice picker. `model_id` defaults to
`gemini-3.8-flash-lite-tts`; an unknown voice or model is a 422 before any
request. The first play of each model and voice uses the Gemini key. Later
plays return the kept file with an ETag (`private, no-cache`, 304 when
unchanged), even without a key. Errors carry `detail.code`; the Gemini errors
also carry a browser-safe `detail.message`:

- 503 `gemini_tts_missing_credential`, asking for a Gemini API key;
- 502 `gemini_tts_sample_failed`, naming at most the HTTP status (a 429 says
  the rate limit or daily quota was reached);
- 503 `content_unavailable` (code only), when the data root is not ready.

The route is local only; [voice and speech](../integrations/voice-and-speech.md#gemini-voice-samples)
covers the cache.

## Client-side speech

Frontend and desktop speech flows use client-side Parakeet STT, MicVAD,
smart-turn, Pocket TTS, ElevenLabs TTS and Gemini TTS. The local API does not
mount STT or LiveKit session routes.

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
  local report (`server/runtime_capabilities.py`) includes the liveness of the
  server's upload processing runner.
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
- `server/routers/chatgpt_plan.py`: the [ChatGPT plan](#chatgpt-plan) sign-in,
  its status and preferences, the plan's model list, and the sign-in return
  `GET /auth/callback`. Only `create_local_app` mounts it, because the session
  is kept on this machine and the return must reach it on loopback.
- `server/routers/web_search.py`: owner application web search settings and
  Test. Only `create_local_app` mounts it, because a SearXNG URL is
  owner-supplied and Test sends a query to the configured backend.
- `server/routers/generation.py`: the [content assistant](#content-assistant):
  its conversations, the run stream, the page's check reports and review
  frames, and draft actions. Only `create_local_app` mounts it, because a run
  spends the owner's own plan or key. `server/generation.py` composes what the
  handlers call; the run itself is `app/generation/`.
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
- `server/routers/avatar_settings.py`: the owner's per-Avatar settings (wind and
  materials). Only the local composition mounts it; without an
  `avatar_settings` store in `ProductContent` it answers 503
  `avatar_settings_unavailable`.
- `product_http/routes/loadouts.py` (shared): typed Anima loadout read plus optimistic,
  idempotent family plan/commit commands.
- `product_http/routes/anima_runtime.py` (shared): exact runtime issuance, lease
  renewal, delivery bundles and revision-scoped registered-byte streaming.
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
  "library_previews": true,
  "local_filesystem_administration": true,
  "native_features": true,
  "user_file_processing": {
    "enabled": true,
    "worker_state": "ready",
    "last_heartbeat_at": "2026-11-12T18:40:18Z",
    "pack_id": "document-processing",
    "supported_extensions": [".csv", ".docx", ".htm", ".html", ".json", ".md",
      ".org", ".pdf", ".pptx", ".rst", ".tsv", ".txt", ".xlsx", ".xml"]
  },
  "offline_speech_enabled": false,
  "offline_speech_asset_version": null,
  "offline_speech_gpu_asset_version": null,
  "offline_multilingual_speech_enabled": false,
  "offline_multilingual_speech_asset_version": null,
  "offline_multilingual_speech_gpu_asset_version": null,
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
exported in `local-http` contract version 28.0.0. `chat`, `model_selection` and
`model_role_selection` admit chat and choices from the composition's catalog,
independently of provider administration. The local adapter reports them true.
`provider_credentials` and `local_filesystem_administration` describe owner key
and host administration; the local adapter reports both true. `native_features`
is true only for desktop; browser fullscreen/PiP use browser detection instead.
See the [hosted composition handoff](../../../contracts/hosted-web.md) for its
separate account authority, retained workflows and eight exceptions.
`chat_file_uploads` and
`anima_creation` report whether the composition offers chat file uploads and
Anima creation. The local composition always reports both `true`; React hides
the corresponding entry points only when a value is `false`.
`library_previews` says whether Library cards load item previews (the
`?variant=thumbnail` copy of a content file and a Particle tile's manifest tint).
It defaults to `true`, so an adapter that omits it keeps previews; the local
adapter reports `true`. When it is `false`, cards show their family icons and
request none. The Library's Preview action and Avatar portraits do not depend on it.
`model_configuration` is true when the composition's
catalog policy enables owner models, which only the local composition does; the
local-only [model configuration routes](#model-configuration) exist only then.
`chatgpt_plan` (absent means false) is true only in the local composition,
which mounts the [ChatGPT plan routes](#chatgpt-plan).
`content_generation` (absent means false) is true only in the local
composition, which mounts the [content assistant's routes](#content-assistant).
The shared `GET /v1/model-roles` report is served by every composition. Every
local composition [processes uploads in its server](../features/user-files.md#in-server-processing):
`user_file_processing.enabled` follows `ANIMAMA_USER_FILE_PROCESSING_ENABLED`
(default `true`), and `worker_state` is `starting` until the server's
processing runner has a heartbeat, `ready` for twenty seconds after that
heartbeat, then `stale`. `pack_id` is a fixed `document-processing` label on
desktop and null in self-host; it names no installable pack. Enabled work may
queue while starting/stale. A disabled capability returns `409` with
`{"detail":{"code":"file_processing_unavailable"}}` from explicit process
requests before repository lookup or enqueue. Original-file upload/finalization
and existing indexed-file search still work. React checks fresh capability
metadata before enqueue and before creating an offline speech worker. The
`offline_speech_*` fields describe Parakeet (English) and the
`offline_multilingual_speech_*` fields SenseVoice-Small (Japanese, Korean and
Chinese); the multilingual fields default to off, so adapters that omit them
remain valid. The asset versions (base and WebGPU set of each engine) are
opaque cache keys, never paths or credentials. Offline speech values are
computed on every request from the composition's `ANIMAMA_PARAKEET_SOURCE`,
which governs both engines: `asset-store` (the default) requires the engine's
operator switch (`ANIMAMA_PARAKEET_STT_ENABLED` or
`ANIMAMA_SENSEVOICE_STT_ENABLED`) and its installed base set (`parakeet-stt` or
`sensevoice-stt`), and reports installed manifest digests, so installs and
removals apply without a restart; `operator` (development Compose, where Vite
serves host sets) reports the switch and no versions.
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
`browser_telemetry` is absent or null unless the composition forwards browser
telemetry. The local composition never reports it, even with its
`/api/telemetry/{signal}` forwarder enabled. When present, its `path` (default
`/api/telemetry`) is a relative same-origin path matching
`^(/[A-Za-z0-9_-]+)+$`, and the web app posts bounded OTLP/HTTP JSON metrics and
error logs to `{path}/metrics` and `{path}/logs`; see
[browser telemetry](../../frontend/architecture/overview.md#browser-telemetry).

## Automatic Episode Processing

Local composition only (`automatic_episode_processing` capability). See
[automatic episode processing](../features/memory-manager-and-episodic-memory.md#when-automatic-runs-start-local-composition).

- `GET /v1/memory/automatic-processing`: `{threshold, state, pending_count,
  runs_today, last_error, next_attempt_at, batch_size, started_at}`. `state` is
  `off`, `memory_off`, `needs_model`, `needs_plan_sign_in`,
  `needs_plan_agreement`, `plan_paused`, `running`, `paused`, `backing_off`,
  `waiting` or `ready`; `batch_size` and `started_at` are set while `running`.
  The `needs_plan_*` and `plan_paused` states mean the Memory Manager's model
  is a ChatGPT plan model that may not run automatic work yet: its sign-in or
  plan use needs the owner, the owner has not agreed, or a usage limit paused it.
- `PUT /v1/memory/automatic-processing`: `{threshold}`, 0 (Off) or 5–50; other
  values fail validation (422). A changed value lifts a failure pause. Returns the
  status and starts a check at once.

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
all other requests and unknown or retired pack IDs (such as
`document-processing`) return 404. The bounded response has
`schema_version`, `pack_id`, nullable `source_version`/`pack_version`, `removable`,
and at most 32 `{kind, id, label}` blockers. Kinds cover Anima/loadout references,
runtime and preview leases, and content operations. It never
returns filesystem roots. Electron repeats preflight after draining renderers,
before switching pack pointers. Catalog withdrawal
reuses the same reference checks at restart, except that Included items' own
edges into the pack are rebuilt from the new scan rather than blocking (an
optional sound drops; a required dependency becomes invalid); readiness fails
closed on conflict.

## Model Assets

The shared downloader manages files listed in the release's packaged catalog
(`animama/resources/model-assets.v1.json`, schema `animama-asset-catalog/1`).
Requests name assets by catalog ID only; the release URL is never accepted from
or returned to the browser. All routes use the admitted installation principal.
The final release turns local downloads off (`MODEL_DOWNLOADS_OFFERED`):
assets installed earlier then keep working and can be removed, and nothing new
is downloaded.

- `GET /v1/model-assets` returns
  `{"assets": [...], "free_bytes": N, "downloads_offered": true}` for every
  catalog entry. `free_bytes` is the store filesystem's free space, or `null`
  when it cannot be measured. `downloads_offered` is false once downloads have
  ended; it is optional, and an absent value means true.
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
  state. An installed asset returns `202` as installed. While downloads are not
  offered, an asset that is not installed returns
  `409 {"detail": {"code": "model_downloads_ended", "details": {}}}` before
  any requirement or free-space check, and nothing is fetched or staged. Otherwise it is
  idempotent: concurrent calls share one download and an installed
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
  the speech-to-text sets are served at `/onnx/models/parakeet-tdt-0.6b-v2[-webgpu]/`
  and `/onnx/models/sensevoice-small[-webgpu]/` with `?v=<manifest digest>`
  pinning.

Unknown IDs return `404 {"detail": {"code": "model_asset_not_found"}}`. Store
location and recovery are in [model assets](../operations/model-assets.md#downloaded-model-assets).

## Content Catalog

- `GET /v1/content/catalog` lists caller-visible Included,
  installation-shared, and owned entries with scan status, safe diagnostics,
  current revision, dependencies, and opaque file registrations. Content Health
  polls it, so it negotiates gzip or identity and is delivered through the
  composition's JSON policy; locally that is a wire ETag (`private, no-cache`)
  and an unchanged catalog answers `If-None-Match` with 304 before any of its
  body is built. The route hands the policy a `DeferredJsonBody` whose
  validator combines the response's schema with
  `ContentCatalogService.visible_revision`: the caller's identity, the
  catalog's Included generation and a revision of the caller's own and
  installation-shared rows. The ETag adds the negotiated encoding. A policy
  passes that body on to `encoded_json_response` while the request's session is
  still open. The SQL adapter derives both revisions from row `updated_at`
  values, so every write to a catalog row must set it. Only the schema and the
  Included generation follow releases. The SQL generation changes with a release
  only because the local composition reconciles every row at start-up. A
  composition that does not must override `included_generation` with a value
  that changes with every application revision, such as that revision.
  Unsupported encodings fail with 406 `content_encoding_not_acceptable`.
- `GET /v1/content/items/{item_id}` reads one visible item.
- `GET /v1/content/items/{item_id}/usage` names what keeps an owned Local item
  from being deleted, as `{item_id, used_by}`; other items are 404.
- `POST /v1/content:rescan` performs an authoritative scan of registered
  Included and Local type roots and returns per-source counts plus the updated
  visible catalog. It resolves unfinished Local mutations before admission.
  Valid new files become selectable but are never equipped.
- `DELETE /v1/content/items/{item_id}` deletes one expected owned Local
  revision and purges its explicit catalog identity, with a Local Avatar's
  unused portrait; Included is read-only. Content an Anima or other content
  uses is 409 `catalog_item_in_use` with `used_by`, and a registered file
  changed on disk is 409 `catalog_item_changed` with the `current_revision`
  after a Local rescan ([Deleting Local content](../features/custom-animas-and-content.md#deleting-local-content)).
  File removal and catalog deletion share recoverable mutation ownership with an
  internal operation identity; the route does not accept a retry key.
- `GET /v1/content/files/{file_ref}` authorizes one opaque registration,
  revalidates filesystem containment, regular-file/link state, exact size, and
  SHA-256, then streams the bytes. It accepts no path or storage key. Digest
  ETags are evaluated only after authorization and integrity checks. The local
  reply is `private, no-cache`.
- `GET /v1/content/files/{file_ref}/sha256/{sha256}` does the same for an
  Included file whose registered digest is `sha256`, and the local reply is
  `private, max-age=31536000, immutable` (ADR 0033). A file that is not
  Included, or whose digest has changed, is `404 content_file_not_found`, so
  the URL never answers with other bytes; a digest that is not 64 lowercase hex
  characters is 422. Catalog items, typed content files, Anima presentation
  images and Avatar portraits name each file by its `url`: this route for
  Included files, the one above for every other file.
- On either route, `?variant=thumbnail` returns a Library-sized copy instead: a PNG, JPEG or
  WebP larger than 128 pixels on a side becomes a WebP within 128 × 128
  (first frame, aspect and alpha kept) whose ETag is its own digest; smaller
  rasters and SVG return unchanged. Decoding uses the bounded image reader
  (40 million pixels, 16,384 per side), so an oversized canvas is refused from
  its header. The source is shrunk before EXIF orientation and a JPEG decodes at
  a reduced scale; a source that would still decode to more than 4096 × 4096
  pixels (a larger PNG or WebP) is refused, and at most two decode at once per
  process, so a preview's memory stays bounded. Thumbnails are cached in process
  by source digest. Other media types, or an image that is over budget or cannot
  be decoded, fail with 422 `content_thumbnail_unsupported`.

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
| `POST /package-imports/{stage_id}/review` | Seal and validate the whole archive; freeze fresh content identities, dependency copies and automatic `-2`/`-3` collision names. Each item lists `notices` about what the import leaves out: `avatar_setting_not_stored` when it carries Avatar settings this composition does not store, and `avatar_extension_unsupported` when an Avatar's model uses a glTF extension the runtime cannot decode yet (Draco; it still imports). |
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
  required and nonblank (1–30 characters); `adult_confirmed` must be `true`,
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
- `POST /v1/animas/{anima_id}/gestures:plan|commit` (`add` takes a Gesture
  `source`; `update` and `reconfigure` take the row's `binding_id` and a
  `source`; `remove` takes the `binding_id`; the loadout's `gestures` are exactly
  these rows);
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
and API clients, and `params` (for example `slot`, `name` or `contentId`)
that clients use to word the code in the owner's UI Locale. Selections store logical catalog items; Particle, Avatar, and Scene
Effects plus Sounds remain compiler-managed support dependencies of
Gesture/Reaction roots and cannot be equipped directly.

`GET /v1/animas/{anima_id}/runtime` independently compiles selected roots and
their transitive dependencies into one persisted owner-scoped exact revision.
Concurrent reads may reuse that effective revision. It compiles and projects on
the composition's read session without locks or writes, then opens a short write
session. It first marks files found changed for Rescan, which commits on its own,
then locks the loadout row, rechecks the loadout revision, every pinned item and
the complete file union, and inserts or renews the snapshot. If the loadout changed in between, or a reused
snapshot expired meanwhile, issuance prepares again, up to three attempts in all,
then refuses with 409 `snapshot_conflict`. An
unexpired snapshot compiled from the same inputs (the backend build, loadout
revision, root selections, every catalog entry the roots reach, and the owner's
Included Avatar face-part overrides) is renewed without compiling, reading content
bytes or projecting again; the final transaction still rechecks it like a new one.
Byte and bundle reads that reach the server verify every file, so a file changed
on disk without a catalog change is caught there and marked for Rescan; a browser
reusing an immutable cached copy sends no such request (ADR 0028). The snapshot pins the
complete admitted `catalog_item_id -> revision_sha256` map and persists one
immutable typed catalog body; it does not copy a row for every file. Each
member carries its canonical opaque `content_catalog_files.file_ref`. The file
route uses one read-only joined query to recheck owner, Anima, expiry, current
access, parent pin, item status/revision, and canonical file facts, then checks
containment, size, and digest before streaming bytes. It never returns a second
download URL and never renews the lease as a side effect of a GET. Its URL names the
exact revision and file, so the local composition serves it
`private, max-age=31536000, immutable` (ADR 0028); a browser that reuses a cached
copy sends no request, so these checks run only on requests that reach the server.

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

The manifest's `bundles` list advertises delivery bundles of optional members, each
with an `id`, a `format` (`json` or `binary`), its URL, `file_refs` and total original
bytes. `GET /v1/animas/{anima_id}/runtime/revisions/{revision}/bundles/{bundle_id}`
serves one. Selection is deterministic and server-owned (`domain/runtime_bundles.py`)
and runs once at issuance, which stores each bundle's member list with the snapshot,
so a bundle ID (a SHA-256 of its format and member set) names the same members for
the revision's life; an unknown ID returns 404. Selection takes projected optional members only,
never the Avatar's or voice's closures or descriptor/meta files. It partitions them
into Idle JSON, Idle binary, other JSON and other binary (Idle bundles come first),
sorts each by `file_ref` and packs it next-fit: JSON `sequence` and `manifest` files
of at most 256 KiB, up to 256 members and 2 MiB per bundle; PNG, JPEG and WebP images
of at most 512 KiB, up to 64 members and 4 MiB per bundle. A bundle needs at least
two members, and a revision has at most 32. Other content keeps individual delivery.
The route accepts no client paths or member lists.

A JSON bundle answers `{version: 1, revision, members: [{file_ref, text}]}`; an
unavailable member has `error` instead of `text`. Text preserves the original UTF-8
bytes, including whitespace, for browser size/SHA-256 verification. A binary bundle
answers the frame `AMB1`, a 4-byte big-endian header length, a UTF-8 JSON header
`{version: 1, revision, members: [{file_ref, size}]}` (or `error` instead of `size`),
then the available members' bytes in header order. After loading that bundle's member
list from the owner's issued snapshot, one joined query checks all of its members against the live lease,
current visibility and pinned revisions. Each file is then opened and verified on
disk, with bounded reads off the event loop. Physical changes mark the catalog
scan-required in a write session of their own; independent good members remain
usable.

Complete JSON bundles use the same gzip/identity negotiation, wire ETag/length and
`Vary: Accept-Encoding` as manifests, with the local `private, no-cache`; binary
bundles are never compressed, carry an ETag of the frame's SHA-256 and, when
complete, the local `private, max-age=31536000, immutable` (ADR 0028), like runtime
file responses. Unlike
issuance, bundle GET does not change a lease, so it may return 304 **after all
authorization and physical checks**. A bundle with an unavailable member is never
cached (`no-store`); a JSON one omits ETag and never returns 304. Wrong
owners/revisions return 404 and expired snapshots return 409.
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
`RuntimeImageReference`. Its schema bounds width and height to 512, the size
of stored portraits; a custom Profile image can be larger, and the list
response is not validated against that bound. The list loads chat
profiles, custom profile candidates, and exact primary-model portrait
candidates in set-based reads; it does not call the complete runtime resolver
for each row. A valid custom Profile Image wins. Otherwise the reference uses
the Avatar's exact portrait (`presentation.avatar_item_id`), else the
Included portrait whose metadata matches the selected Avatar model. It remains null when neither is available.

The reference includes a normalized `presentation` object with Fill/Fit,
focal point, and zoom. These fields are revisioned presentation semantics;
saved position strings are normalized for backward compatibility.

`RuntimeImageReference.source_type` is `catalog`; its API-relative URL is
fetched with normal authentication: `/v1/content/files/{file_ref}/sha256/{sha256}`
for an Included image and `/v1/content/files/{file_ref}` for a Local one. The presentation
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
Body `pinned: true` pins the Anima in the sidebar and `false` unpins it;
omitting it keeps the pin. A pin is runtime state: it needs no
`expected_aggregate_revision` and changes neither aggregate revision nor
`updated_at`. A rename sent with it still needs the revision. Pinning a pinned
Anima keeps its pin time. Anima responses carry nullable `pinned_at`.
`GET /v1/animas` keeps its creation order; clients list pinned Animas first.

`DELETE /v1/animas/{anima_id}` deletes the owner's Anima with its chats and
messages, its `IDENTITY.md` and `MEMORIES.md`, its pending episode items and
the chat images only its chats use, and clears a `last_active_anima_id` that
names it. Shared memory, processed episodes and Library content stay. Like a
chat delete, it first stops any streaming reply in its chats and returns `409
chat_turn_stopping` when one does not stop in time (see [Chats](#chats)).

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
for example `OpenAIHTTPAgent:gpt-6-luna` or an owner row's `owner:<hex>` id,
with an optional `reasoning_effort`. The route verifies anima ownership and an
active `model_providers` row of kind `chat` before updating the profile; other
rows return `400`. A `reasoning_effort` string must be one of the row's
supported efforts (else `400`), and null clears it. Omitting it keeps the saved
effort when the model is unchanged and clears it when the model changes. The
response's `chat_profile.reasoning_effort` is the saved value, null meaning the
model's default.

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
context yet. When a turn has context, direct chat adds one request-local
`developer` message immediately before the latest user message. When memory influence is enabled
it starts with a `# List of memory files` section. The list includes only
user-scope file entries (`anima_id IS NULL`), uses cached paths such as
`PROFILE.md`, and omits anima-scoped files and tree formatting. Any attached-file
list follows. The Companion Guardrails end the system instructions; the turn
context does not repeat them. `disable_memory_influence`
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
A role waiting on an unavailable ChatGPT plan model, directly or by inheriting
the chat role, reports no row, `source` `off` and `assignment_available` false.
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
  `openai`, `anthropic` and `chatgpt_plan` connections, each with its active
  models. The `chatgpt_plan` connection's `credential_state` comes from the
  sign-in session: `configured` while an account is signed in with plan use,
  otherwise `missing`. A model's
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

The built-in `chatgpt_plan` connection's models are the signed-in account's
([model catalog](../model-catalog.md#chatgpt-plan-connection)): adding a model
to it, listing its available models and probing it return
`400 connection_read_only`, and its rows accept only `hidden`. Its list is
read again through [`POST /v1/chatgpt-plan/models:refresh`](#chatgpt-plan).

A connection's `credential` takes one of three modes:

- `{"mode": "none"}`: no key and no `Authorization` header;
- `{"mode": "env", "env": "NAME"}`: read the key from a variable named
  `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `HF_TOKEN`, `OPENROUTER_API_KEY` or
  `ANIMAMA_CONNECTION_<NAME>_API_KEY`, so a reference cannot read other
  secrets. `ANTHROPIC_API_KEY` is refused (`invalid_credential`): only the
  built-in Anthropic connection reads it;
- `{"mode": "managed"}`: read the key from `ANIMAMA_CONNECTION_<ID>_API_KEY`,
  derived from the connection ID, which the desktop vault sets.

A key that a connection names is sent only to its own origin (the built-in
OpenAI connection keeps the operator's `OPENAI_BASE_URL`). A provider variable's key goes only to
that provider's API (`PROVIDER_CREDENTIAL_ORIGINS` in
`app/model_clients/credential_store.py`). An `ANIMAMA_CONNECTION_<NAME>_API_KEY`
key goes only to the origin in `ANIMAMA_CONNECTION_<NAME>_ORIGIN`, which the
desktop vault delivers with the key and a self-hosted operator sets. No such
key is sent over plain HTTP unless the host is this computer. A connection whose key
cannot be sent to its base URL reports `credential_state: "missing"`. Create and
update refuse `400 credential_insecure_transport` for any key over plain HTTP to
another computer, and `400 credential_origin_mismatch` for a provider key at
another origin or an operator's connection key whose `_ORIGIN` differs. A
managed key moved to another origin is accepted and reports `missing` until the
owner enters it again.

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

## ChatGPT Plan

Local composition only (`chatgpt_plan` capability). These routes manage the
owner's Sign in with ChatGPT session
([ADR 0039](../../adr/0039-chatgpt-plan-sign-in-and-connection.md)) with the
admitted installation principal. No response carries a token or an
authorization code; only starting a sign-in returns the authorization URL.

- `GET /v1/chatgpt-plan`: `{sign_in_available, unavailable_reason, state,
  email, plan_use_granted, sign_in_pending, confirmation_due,
  background_agreed, paused, failure}`. `state` is `signed_out`, `signed_in` or
  `sign_in_required` (OpenAI rejected the tokens, which were removed).
  `unavailable_reason` is `remote_origin` when the installation's origin is not
  a loopback `http` origin the sign-in return can reach, or
  `secure_storage_unavailable` on a desktop without its vault key. `failure` is
  the code of the last sign-in that did not complete, such as `access_denied`.
  `paused` is true after a usage limit until one of the owner's own plan
  requests succeeds.
- `POST /v1/chatgpt-plan/sign-in`: `{enable_plan_use, ui_locale}` returns
  `{authorize_url}` (`no-store`), OpenAI's page for the client to open in the
  system browser. One attempt is pending at a time, for at most ten minutes.
  Where sign-in is unavailable it returns
  `409 chatgpt_plan_sign_in_unavailable` with `reason`.
- `DELETE /v1/chatgpt-plan/sign-in` (`204`): cancel the pending attempt.
- `POST /v1/chatgpt-plan:sign-out`: revoke the session at OpenAI, remove the
  tokens and retire the plan's models. Returns `{was_signed_in, confirmed}`;
  `confirmed` is false when OpenAI could not confirm the revocation.
- `PUT /v1/chatgpt-plan/preferences`: `{confirmed, background_agreed}` records
  the one-time confirmation and whether automatic episode processing may use
  the plan, for the signed-in account. Returns the status.
- `POST /v1/chatgpt-plan/models:refresh`: list the account's models again and
  store them ([model catalog](../model-catalog.md#chatgpt-plan-connection)).
  Returns `{model_provider_ids}`, the active rows.
- `GET /auth/callback`: OpenAI's return to
  `http://127.0.0.1:<port>/auth/callback`, outside the public schema, admitted
  by [its own rule](../operations/local-http-components.md#request-admission).
  It completes the pending attempt only when its `state` matches, stores the
  account's models before the sign-in reads as finished, and answers with a
  fixed `no-store` page in the language sent with the sign-in start: signed in
  (`200`), or declined, expired or failed (`400`). Its query is never logged,
  traced or shown.

Request bodies with unknown fields fail validation (`422`). A session that
cannot be used returns `503 chatgpt_plan_temporarily_unavailable` while its
storage or OpenAI is unavailable, and otherwise `409 chatgpt_plan_<code>`, for
example `chatgpt_plan_not_signed_in` from a model refresh while signed out.

## Content Assistant

Local composition only (`content_generation` capability). The assistant
authors Gesture and Reaction drafts in a conversation that is not a Chat: it has its own
[tables](data-model.md#content-assistant), no Anima, and nothing that chat
lists, chat search, memory or Reflection reads. The backend builds every model
request from its own instructions and tools. A caller sends the person's
message, the chosen model, what the page measured, and the ids of the
person's own Library Gestures, images and style preset; request bodies with
any other field fail validation (`422`). Every route serves only the caller's
conversations and drafts, and another owner's id answers like a missing one
(`404 generation_not_found`). The page's side, and what reaches a model
provider, are in
[Content generation](../../frontend/features/content-generation.md); the
reasons for the split are in
[ADR 0041](../../adr/0041-backend-built-content-assistant-runs.md).

- `GET /v1/generation/conversations`: `{conversations}`, the most recently
  written to first. Each is `{id, title, scope, style_preset, created_at,
  updated_at}`; `scope` is `{kind: "page"}` or `{kind: "creator", intent,
  catalog_item_id}`, and `title` is the person's first message on one line,
  cut to 80 characters (empty until they send one). A creator's conversation
  that outlived what it belongs to is removed first, with its messages and
  drafts: one whose `catalog_item_id` is no longer the id of a Gesture or
  Reaction (by its `intent`) among the caller's catalog rows, and one with no
  `catalog_item_id` (an unsaved item) that was not written to for seven days.
  The row's scan status does not matter: an item that is invalid, misses a
  file or a dependency, or waits for a rescan still exists and keeps its
  conversation. Nothing is removed while a run is in flight on any of the
  caller's conversations (checked again before each removal), or while the
  Library cannot be read, and a `page` conversation is never removed this
  way.
- `POST /v1/generation/conversations` (`201`): `{scope}` starts an empty
  conversation.
- `GET /v1/generation/conversations/{conversation_id}`: `{conversation,
  messages, drafts, usage}`. A message is `{id, role, text, data,
  created_at}`; `data` holds what the turn carried besides text (`intent`,
  `draft_id`, `answers`, `references`, `images` and `images_sent` on the
  person's turn; `run_id`, `outcome`, `usage`, `model`, and where they apply
  `unfinished_requests`, `cost`, `draft_id`, `questions`, `error` and `batch`
  on the assistant's). A draft is described under [Drafts](#drafts) and `usage`
  under [Token use and cost](#token-use-and-cost). With no run in flight, a
  draft whose status does not describe it is settled before it is returned:
  by its current version's report, to `checking` when that version has none,
  or deleted when it never got a project. That is a draft a run left in one
  of its steps without settling (the server stopped under it), and a draft
  whose report arrived after it was left, while another run held the
  conversation.
- `DELETE /v1/generation/conversations/{conversation_id}` (`204`): delete the
  conversation with its messages and drafts, and the
  [reference images](#references-and-style-presets) nothing else uses.
- `PUT /v1/generation/conversations/{conversation_id}/style-preset`:
  `{style_preset}` stores one of the backend's
  [style presets](#references-and-style-presets) by id, or `null` for none.
  Returns the conversation; `422 generation_style_preset_unknown` for an id
  that is not on the list.
- `POST /v1/generation/conversations/{conversation_id}/runs:sse`: one
  [run](#runs).
- `PUT /v1/generation/drafts/{draft_id}/check-report`: the page's
  [check report](#check-reports-and-review-frames) for the draft's current
  version. Returns the draft.
- `PUT /v1/generation/drafts/{draft_id}/review-frames?version=N` (`204`): the
  contact sheets a run asked for.
- `POST /v1/generation/drafts/{draft_id}:restore`: put back the project from
  before the person's last revising message, as a new version with status
  `checking`. Returns the draft; `409 generation_nothing_to_restore` when there
  is none.
- `POST /v1/generation/drafts/{draft_id}:mark-saved`: `{item_id}` records the
  Library item the person saved the draft as. Saving itself is the creator's
  own save route. Returns the draft.
- `DELETE /v1/generation/drafts/{draft_id}` (`204`): discard the draft. A run
  working on it ends.

One run is in flight for a conversation at a time. While it is, a second run,
deleting the conversation and restoring one of its drafts return
`409 generation_run_in_progress`.

### Drafts

A draft is `{id, conversation_id, intent, position, status, version, project,
has_previous_version, check_report, checked_version, repair_count,
failure_reason, saved_item_id, created_at, updated_at}`. `project` is an
`animamaActionProject/1.0` document the creator's Import accepts. It is stored
only after the server validated it, and is `null` on a draft that failed
before any version validated or that a batch planned and has not written yet.
Its `dependencies` are the effects its timeline events play, derived by the
server ([Effects on the timeline](#effects-on-the-timeline)); a draft without
events has none. `version` grows with every stored project.
`check_report` is the page's report for `checked_version`, which may be older
than `version`. `status` is `writing`, `checking`, `repairing` or `reviewing`
while a run works on the draft, and `ready`, `warnings` or `failed` (with
`failure_reason`) when it is left. A draft with no run in flight and a version
nobody checked is `checking`: the page checks it, and its report then settles
the status.

### Runs

The run body is `{message, model_provider_id, draft_id?, intent?, ui_locale?,
answers?, avatar_expressions?, reasoning_effort?, document?, references?}`.
`message` is 1 to 4,000 characters. `references` are described under
[References and style presets](#references-and-style-presets). With
`draft_id` the run revises that draft, keeping its kind; without it, it writes
a new draft of `intent` (`gesture`, the default, or `reaction`). A Reaction's
clip may hold no field that moves the body, and its details are `emotion` (a
tracked emotion) and `intensity` (1 to 4). A name the assistant writes, for
either kind, must be one the Library would save an item under
(`readable_entry_name`, the save route's own rule): in Latin script only
letters, digits, spaces, dots, underscores and hyphens, starting with a
letter or digit. A draft cannot be renamed on the Generate page, so any
other name is a refused tool call.

A conversation whose scope is `creator` authors its item's kind whatever
`intent` says, and its run may carry `document`: the item open in the creator
as an `animamaActionProject/1.0` project. The run then revises that document
instead of a stored project, and stores the result in `draft_id`'s draft, or
in a new draft without one. Nothing of the document is kept that the backend
does not know:

- **The clip** keeps only the fields the 2.0 format defines (`V2_CLIP_FIELDS`,
  the list the frontend parser shares through the vocabulary fixture). Its
  `id` and `name` are derived from the item's name, not taken from the
  caller. It then passes the validation a model's clip passes (size, depth,
  structure, at most 60 seconds, no body field in a Reaction, no timeline
  event, no playback lifetime), and no string in it may exceed 512
  characters.
- **The details the item has** are held to the catalog's rules for a saved
  item, not a draft's: a name of at most 120 characters, a description of at
  most 4,096, a Selector ID the catalog accepts (dots and hyphens included),
  a tracked emotion and an intensity from 1 to 4. No pass may change them:
  the tools do not offer those fields and ignore them in a call. A blank
  detail is not the item's yet; a pass writes it, under a draft's rules.

Otherwise the answer is `422 generation_document_invalid` with `reason`:
`timeline`, `details`, or `document` for a wrong project schema or kind and
for a document on a conversation that is not a creator's.

Every pass that works on a draft (revise, repair, review) gives the model the
draft's details and clip inside one tagged data block with `<` escaped, which
the instructions define as data and never as instructions.

`answers` is `{skipped}` or `{answers: [{question, answer}]}` for the questions
the assistant last asked, with the request they were about sent again as
`message`; questions are asked once for a request, a request that follows them
counts as skipped when it carries no answers, and answers to questions nobody
asked are ignored. A run that failed or was stopped before it stored a draft
or a revision leaves the questions outstanding, so a retry sends the same
`answers` again; one that stored its draft first has used them, and its turn
names the draft (`draft_id`). Questions whose stream closed as they arrived
are stored with the stopped run's turn and are answered the same way.
`avatar_expressions` maps a family to the chosen preview Avatar's expression
names. Only names are sent; at most 400 of at most 64 characters reach the
model, as data. `reasoning_effort` is applied to every model request of the
run, in the request option chat uses; without it the model's default applies.

#### The model

The model row must exist and be an active chat model that calls tools and
streams, on an active connection, with room for a pass: a recorded context
window of at least 64,000 tokens (`MIN_CONTEXT_WINDOW_TOKENS`), or none
recorded where chat accepts that. Otherwise the answer is
`422 generation_model_unusable` with `reason`:

| `reason` | The model row |
| --- | --- |
| `not_found`, `inactive`, `connection_inactive` | is missing, turned off, or on a connection that is turned off. |
| `not_chat_model` | is not a chat model. |
| `tools_unsupported`, `streaming_unsupported` | cannot call tools, or cannot stream. |
| `context_window_missing` | is the owner's own model with no context window recorded. |
| `context_too_small` | records a context window under 64,000 tokens. |
| `unsupported` | is one chat's own validator refuses on its connection. |
| `no_model_client` | has no model client in this server. |

No other model is used instead. `reasoning_effort` must be a level the model
can run a pass at: one its row lists, and one its route takes with function
tools (OpenAI's Chat Completions takes them on GPT-5.4 and later at `none`
only). Otherwise the answer is `422 generation_reasoning_effort_unsupported`.
A draft to revise must belong to the conversation (`404`) and, without a
`document`, hold a project (`409 generation_draft_empty`).

#### Passes and limits

A run makes at most five model passes for a draft: one write or revise pass,
three repair passes and one frame review, each at most eight model responses.
It waits up to 120 seconds for a version's check report (then leaves the
draft `warnings` with the report `{unchecked: true}`) and up to 60 seconds for
review frames (then skips the review). Reports and review frames are keyed by
draft and version, so two items of a batch that wait at once never take each
other's. Closing the stream stops the run: its model requests are cancelled,
a draft keeps its last stored project, and the conversation is free for the
next run. Nothing restarts a stopped run.

On an OpenAI API key's Responses models, a pass's later tool rounds name the
response the provider stored (`previous_response_id`). When the provider
cannot resolve it (`openai_previous_response_unresolvable`: the organisation
stores no responses, or the response expired), the round is sent once more
without the cursor, carrying the whole exchange, and no later round of the
run names one, in that pass or the passes after it. A run for one draft
therefore spends at most one refused request, and a batch at most two.
Chat's own stale-cursor check decides
(`should_retry_without_previous_response_id` in
`app/model_clients/tool_rounds.py`). The refused request is no response: it
is neither one of the pass's eight nor counted in `usage`, and it does not
count as an unfinished request.

#### The event stream

The response is `text/event-stream`. Each frame has an `event` name and JSON
`data`; a comment line (`: heartbeat`) follows every 15 seconds of silence.

| Event | Data |
| --- | --- |
| `run.started` | `{run_id}` |
| `progress` | `{phase, draft_id?}`; `phase` is `thinking`, `writing`, `checking`, `repairing` or `reviewing_frames` |
| `message.delta` | `{text, draft_id?}`: more of the assistant's text; the pieces in order are the stored message. `draft_id` names the item when the text is one batch item's note, which begins with the draft's name |
| `questions` | `{questions: [{question, options}]}`; the run ends here |
| `batch.planned` | `{items: [{draft_id, intent, brief}]}`: the planned items in order, once their drafts exist; one `draft.updated` for each follows |
| `draft.updated` | `{draft}`: the whole draft after a new version or status |
| `frames.requested` | `{draft_id, version}`: upload the review frames of this version |
| `item.failed` | `{draft_id, code, category, details}`: one item of a batch failed, as `run.failed` describes a run's failure; the run goes on |
| `run.failed` | `{code, category, details}` |
| `run.completed` | `{usage: {input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, requests}}` |

Every event about a draft names it, so the page can follow the items of a
batch: `progress`, `draft.updated` and `frames.requested` always did, and a
planned item that has had no `progress` yet waits its turn. A run for one
draft sends the frames it always sent. A page that does not know
`batch.planned`, `item.failed` or the `draft_id` of a `message.delta` still
sees every draft through `draft.updated`.

`run.completed` is the last frame of every run the server ends, after
`run.failed` when the run failed. When the stream itself fails (an event that
cannot be sent, or a failure the run did not report), the run is stopped
first and `run.completed` counts no tokens; the run's own count is in its
stored message. A model failure carries the model client's own `code` and the
`category` and connection `details` chat's error frame carries, so a usage
limit, a missing key or an expired sign-in reads as it does in chat. The
assistant's own failures have category `generation`
(`generation_no_valid_draft`, `generation_not_found`,
`generation_batch_time_limit`) or `internal`
(`generation_run_failed`). The conversation and its drafts stay.

#### Batches

The write pass of a run for a new draft on a `page` conversation may answer
with a plan instead of a draft (`plan_batch`): 2 to 10 items, each with a
brief of at most 400 characters and its kind. A plan of more is refused whole
and the model plans again; nothing is cut to fit. A creator's run and a
revision never offer the tool.

The run then creates one draft for each item, in plan order (`writing`, no
project), and gives each its own write pass from the request and its brief,
its own checks, repairs and frame review, and its own status. Two items are
in flight at a time. An item's pass asks no questions and plans nothing, and
a brief reaches it as tagged data. A batch is one run: the conversation
takes no other until it ends, and `usage` and the stored cost add up the
planning pass and every item's passes.

- An item whose write produces no valid draft is left `failed` with
  `generation_no_valid_draft`. An item that meets a model error or an
  internal failure sends `item.failed`; its draft is left `failed` with the
  failure's code when it has no project, and otherwise keeps its project and
  is settled from its report. The other items go on, and the run does not
  fail.
- A model failure that every item would meet ends the batch instead, as a
  failed run: `run.failed` carries that error, so the page shows the notice
  a single run shows, with its sign-in or usage action. Those are the model
  clients' error categories about the connection or its allowance
  (`EVERY_ITEM_FAILURES`): `credential_missing`, `credential_rejected`,
  `sign_in_required`, `not_eligible`, `model_not_found`, `quota_exceeded`
  and `usage_limit`. No further item starts, drafts already written are kept
  and settled, and planned items never written are removed. A rate limit
  (`rate_limited`) is not one of them: it refuses one request for a moment
  and some routes do not retry it, so it fails only its own item.
- Discarding an item's draft during the run ends that item only. The draft
  is looked for before an item's first model request and after each model
  response of its passes, so a discarded item is asked nothing more.
- Two items cannot take one Selector ID: an id another item's draft holds
  counts as in use.
- Closing the stream stops every item. A draft with a project is kept and
  settled as a stopped run's draft is; a planned item never written is
  removed.

A batch's worst case is fixed by constants in `app/generation/run.py` and
`tools.py`: 408 model responses (the planning pass's 8, and 10 items of at
most 5 passes of 8), two provider streams open at once, and 60 minutes for
its items (`MAX_BATCH_SECONDS`), after which the run ends as a stopped run
does, with `run.failed` code `generation_batch_time_limit`. A route that
lost its stored responses costs at most two refused requests, one for each
item in flight that found out, and a failure every item would meet costs at
most two requests for the same reason.

#### References and style presets

`references` is `{starting_point?, examples?, images?}`. Each part names the
caller's own content by id. The backend reads it itself, so no clip, text or
image bytes come from the request body.

- `starting_point` is the item id of a Gesture in the caller's Library. Only
  a request for a new Gesture on a `page` conversation takes one; with
  `draft_id`, for a Reaction, or in a creator it is refused (`not_allowed`).
  The clip keeps only the fields the 2.0 format defines, loses its `events`,
  `playback` and `role`, and passes the validation a model's clip passes. The
  new draft starts as a copy of it with details of its own: the Gesture's
  name with ` 2` (its plain characters when the Library would not save the
  name) and a Selector ID no other Gesture uses (`wave_hello_2`). The run
  makes a revise pass on that copy and plans no batch. When the pass leaves a
  valid draft, the copy is stored as the draft's first version and the
  assistant's revision as the next, in one transaction, so a restore returns
  to the Gesture itself and a run stopped at that point keeps neither. When
  the pass leaves none, or it asks questions, no draft is stored.
- `examples` are at most three Library Gestures, shown to the model in the
  write, revise and batch-item messages as examples of the feel: each one's
  name, description and clip (without `events`, `playback` and `role`) as one
  JSON line in a tagged data block. A clip may be at most 32 KiB as compact
  JSON and the three together at most 64 KiB (`too_large`).
- `images` are at most four `{file_id, kind?}` entries naming the caller's
  ready image files, as a chat turn's attached images are named
  ([Chat images](../features/user-files.md#chat-images)). `kind` is `image`
  or `video_frames`: one strip of frames the page sampled from a short local
  video, in time order from left to right. On a model that accepts images
  the canonical stored copies ride on the write or revise pass, and on each
  batch item's write pass, as image parts of the user message with their
  bytes on the request, under ids and names the backend makes
  (`reference-image-1`); the person's file names and file ids are not sent.
  The message says how many images there are, that they are data, and which
  is a strip of frames. On a model that takes no images nothing is read or
  sent. Either way the images are linked to the conversation
  (`generation_reference_images`) and the person's turn records them in
  `data.images`. `data.images_sent` starts false and is set true just before
  the run's first model request that carries them, so it stays false on a
  model that takes no images, under the deterministic author, and for a run
  that failed before it asked a model anything.

A reference that cannot be used refuses the run before anything is stored or
any model is asked:

- `422 generation_reference_refused` with `reason`: `not_found` (no usable
  Gesture of the caller has that id), `non_portable`, `not_a_clip` (an
  imported motion file), `invalid` (the starting clip fails validation),
  `too_large`, `not_allowed`, or `unavailable` (the Library cannot be read).
  A non-portable Gesture is refused before any of its bytes is opened,
  whatever the caller sends.
- `400 attached_image_unavailable` for an image id that names no ready image
  of the caller, or whose stored copy cannot be read or no longer matches its
  record; `422` for more than four.
- `503 uploads_unavailable` when the model accepts images and the upload
  store itself cannot be reached (its root is missing or unmounted), the
  answer the file routes give then. The image is not at fault, so the code
  is not `attached_image_unavailable`. A model that takes no images reads
  none, and its run needs no store.

Discarding a conversation deletes the reference images only it uses: an
image another conversation links, or a message of one of the caller's chats
attaches, stays. The images are read before the delete and removed after it
commits, each deleted and committed on its own as a deleted chat's images
are. While the upload store cannot be reached, the conversation is still
deleted and its images stay in the Library, where the person can delete
them. Removing a creator's conversation that outlived its item follows the
same rule.

A conversation's style preset is one of five ids (`anime_expressive`,
`soft_natural`, `cute_playful`, `cool_composed`, `dramatic_theatrical`). A
run reads the id when it is planned and adds that preset's one sentence,
written in `app/generation/style_presets.py`, to the instructions of every
pass, before the reply-language rule. An id that is not on the list adds
nothing. Choosing a preset does not move the conversation in the list.

#### Effects on the timeline

A Gesture draft on a `page` conversation may play Avatar, Particle and Scene
Effects that are already in the caller's Library. Its write, revise and
repair passes offer two more tools:

- `list_effects` (`kind?`, `search?`): the id, kind, name and description of
  at most 100 effects a call. Names are cut to 80 characters and descriptions
  to 160.
- `read_effect` (`id`): one effect's event (the minimal timeline event that
  plays it) and, for an Avatar Effect, its region and the parts an event's
  `override` may replace (`attachment`, `appearance`, `motion`,
  `soundAlias`). Its art and file names are not shown.

The Library read for the run holds only usable, portable items of the three
kinds, Included and Local; a non-portable effect can be neither listed nor
read. Both results are tagged data blocks with `<` escaped: what an effect's
maker wrote is never instructions. An effect's `id` is an alias the server
derives from its name; it is the same for the same Library.

The clip may then hold `events` of kind `avatar_vfx`, `particle_vfx` or
`scene_vfx`, at most 24, that pass the clip validation and:

- name an effect the run listed or read, or one the draft's stored project
  already depends on, by `effectId` (`presetId` for a Scene Effect). A draft's
  own alias keeps meaning the item it pinned;
- name it in that field only: `effectId`, `presetId` or `cueId` on an event
  whose kind does not use it is refused whatever it holds, since the creator
  reads the first alias field an event has;
- use the event kind of that effect, and for a Scene Effect its lane
  (`sceneKind`);
- carry only an `override` its Avatar Effect can play, checked with
  `check_clip_effect_overrides`, the check Save applies;
- are never `sfx`: a Gesture sounds only through its effects.

Anything else is a refused tool call whose result names the event and what to
change. The server derives the project's `dependencies` from the events, one
for each effect: `{alias, content_type, source: {type: "catalog",
catalog_item_id, logical_key}}`, the creator's own dependency shape, so the
creator's import, preview and save read it unchanged. A model never writes a
dependency or a content id.

When a draft's effect is no longer in the Library, a pass that works on the
draft is refused every edit until the event is removed or replaced. When the
effects cannot be read at all, nothing can be listed and a draft keeps the
events it has. They are held only to the kind their dependency pins; Save
checks the rest.

A Reaction draft and a creator's run hold no events: the tools are not
offered and any event is refused. The creator's page keeps the open item's
own events and dependencies off the request and puts them back on the
result.

#### Without a model

With `ANIMAMA_LLM_SKIP` set, a deterministic author stands in for every model
pass: it submits a packaged example Gesture, or for a Reaction the packaged
example Reaction, named after the request (without the punctuation a saved
name cannot hold), lengthens the clip on a revision or repair, and accepts a
review. A request with a starting point gets that Gesture's copy with the
same fixed change, and reference images are sent to no model. Words in the
request choose what journeys need: `batch of N` plans N items, `item K
fails` makes item K of that plan fail to validate, and `with an effect`
makes a Gesture list the Library's Avatar Effects and play the first.

### Token use and cost

The conversation's `usage` is `{input_tokens, cached_input_tokens,
output_tokens, reasoning_tokens, requests, runs, cost, cost_complete,
last_run}`, added up from what its stored assistant turns recorded. `runs`
counts those turns, and `requests` the model responses that completed.

- `cost` is `{currency, amount}` or `null`. `amount` is a decimal string. A
  run's cost is estimated one response at a time, with
  `estimate_model_token_cost` against the model row as the run read it when
  it started, and stored with the run's turn. A run gets no estimate when
  its row has no price, when a response reports prompt-cache writes (the
  catalog has no rate for them), when the provider reported no usage for a
  response, when no response arrived, and always on the ChatGPT plan. An
  Anthropic run's first response writes the prompt cache, so such a run
  usually has none.
- A run also gets no estimate when a request it started never returned a
  final response: the run was stopped or a batch ran out of time while the
  request was open, or the request failed. What that request used is not
  known, so an amount without it would be understated. The run's turn then
  records `unfinished_requests`, the number of such requests.
- The token counts add every completed response's figures; an unfinished
  request reported none. For a response whose
  provider reported no usage those are its adapter's: a rough count on a
  Chat Completions server that streams no usage, and nothing otherwise.
- The conversation's `cost` adds the runs that have an estimate, and is
  `null` when none has or when they are in more than one currency.
  `cost_complete` is false when a run that made a model request, answered
  or not, has none.
- `last_run` is the last stored run: the token counts above with `run_id`,
  `model_provider_id`, `plan` (it ran on the ChatGPT plan) and its own
  `cost`.

### Check reports and review frames

After `draft.updated` with a version nobody checked, the page validates the
clip, runs the motion checks and sends `{version, loadable, issues: [{path,
message}], findings, expression_names: {missing, avatar_only}}`. A finding is
the frontend's `MotionCheckFinding`. The body is bounded: 200 issues, 200
findings, strings of 500 characters, 400 expression names of 64 characters and
256 KB in all (`413 generation_check_report_too_large`); an unknown category
or any other field fails validation. A `version` that is not the draft's
returns `409 generation_stale_version`. The report only decides repairs and
warnings: a run repairs when the clip does not load, has an issue or has a
finding of severity `fail`. A draft that loads is left `warnings` by an issue,
a finding of either severity or a `missing` name; `avatar_only` names are a
note the report keeps, and alone leave it `ready`. Loading and saving never
depend on the report. With no run in flight on the conversation, the report
also settles the draft's status. While a run is in flight the status is that
run's to set; a report for a draft the run is not working on is stored, and
the next read of the conversation after the run settles that draft from it.

Review frames are a `multipart/form-data` body with one or two `frames` files
of at most 4 MB each. They are taken only for the draft version a run is
waiting to review (`409 generation_frames_not_requested`,
`409 generation_stale_version`), read wholly in memory, decoded by the bounded
image opener chat images use, and dropped when the review ends. A sheet keeps
its size up to 2,048 pixels on its longer edge (a six-row sheet is 2,008
pixels tall), where a chat image is scaled to 2,000. They are never
written to a table or a file. Refusals: `422 generation_frames_invalid`,
`422 generation_frame_not_an_image`, `413 generation_frame_too_large` and
`413 generation_frames_too_large`.

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
uncovered chat turns across all its chats, at most 400 turns or 51,000
estimated tokens of turn text. It follows the same open-run rules: it supersedes an
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
`description = "{anima.display_name}'s identity"`. The local
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
deletes, and message reads are scoped to the current user's chats.

`PATCH /v1/chats/{chat_id}` takes `pinned: true` to pin the chat in the
sidebar and `false` to unpin it; omitting it keeps the pin. A pin is not an
edit: `updated_at` stays unchanged, so `GET /v1/chats` keeps its most recent
first order and clients list pinned chats first. Pinning a pinned chat keeps
its pin time. Chat responses carry nullable `pinned_at`. Deleting a chat or its
Anima deletes the pin with it.

`DELETE /v1/chats/{chat_id}` deletes the chat's messages, its pending episode
items and the chat images only it uses (an image a content assistant
conversation keeps as a reference stays); processed episodes and the memory
written from them stay (see [Memory](../features/memory.md#episodic-memory-capture)).
If a reply is streaming in the chat, the delete first stops it as a client
disconnect would (a reply save that has begun finishes) and waits for it. A
reply that has not stopped within 10 seconds returns `409` with
`detail.code = "chat_turn_stopping"`; nothing is deleted, and a retry is safe.

Message responses expose `chat_id`, `run_id`, `model_provider`, `model`, and
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
`chats` for ownership, and returns one result per chat. A message must match
every query word. A word containing a non-ASCII letter or digit, such as `京都`,
matches as a case-insensitive substring of the indexed text instead, because the
`english` parser keeps unspaced Japanese, Chinese and Thai text as one token
([memory search](../features/memory.md#search_memory_files) has the details). A
query of only such words scans the owner's visible messages without the index.
At most eight prefix terms and eight substring words are used. The best matching
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
embeddings stay off. A row of the ChatGPT plan connection that is unavailable
(retired at sign-out, or no longer listed for the account) does not fall back:
the role resolves to no model and waits, so its work never moves to another
connection, and utility and the Memory Manager wait too when they inherit such
a waiting chat role. Other unavailable assignments still fall back.
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
`operation_id`, `expected_avatar_revision`, `renderer_version` and
`capture_preset_version`; a 1024-square WebP capture of a Local Avatar becomes
its one owner-scoped 512-square Appearance (up to 256 KiB) at
`appearances/avatar-portrait-{item_id}.webp`, replaced in place by later
saves. Its metadata records the Avatar revision and capture versions. An
Included Avatar returns `409 portrait_requires_local_avatar`.
When the Avatar already has another exact portrait (imported, or saved
elsewhere), the save returns `409 avatar_portrait_exists` and keeps it. Saving
does not modify the Avatar or any Anima binding, but an Anima that bound the
portrait itself as its Profile or Background shows the replaced image. Avatar
content List and Get responses carry `portrait` (`url`,
`avatar_revision_sha256` for a Local capture, `renderer_version`,
`capture_preset_version`) or null. Confirmed content survives cancelled
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

`GET /v1/avatar-content/{item_id}/settings` (`get_avatar_settings`) returns
the caller's effective settings for a current admitted Local or Included Avatar
as `{item_id, spring_mode, spring_mode_source, wind_strength,
wind_strength_source, material_mode, material_mode_source}`. `spring_mode` is
`automatic`, `on`, `off` or `springs_off`; `wind_strength` is a whole percent
from 0 to 200 (100 by default); `material_mode` is `automatic`, `liltoon` or
`simple`; each source is `stored` or `default` (nothing is saved).
`PUT` (`save_avatar_settings`) takes `{spring_mode?, wind_strength?,
material_mode?}` and returns the same state: an omitted field keeps its stored
value, and `automatic`, `null` or a strength of 100 clears it. An unknown, invalid or non-Avatar item, or
another owner's Local Avatar, returns `404 content_not_found`; an unknown
value or key returns 422. Saving writes no Avatar files and leaves the
revision unchanged. Both routes are local-only. See
[Avatar settings](../features/custom-animas-and-content.md#avatar-settings).

Appearance and portrait images are typed `appearance` catalog items. Focused
`/v1/animas/{anima_id}/appearance:plan` and `:commit` commands store
profile/background selection plus crop/focal configuration.

## User Files

The user-files router manages installation-owned document and chat-image
uploads, processing jobs, and backend debug search. It exposes:

- `POST /v1/files/uploads`: validate filename, allowlisted extension, and
  declared size; create a pending `user_file` row; return a private
  API-relative PUT target.
- `PUT /v1/files/{file_id}/content`: resolve the bootstrap-established owner, bound the streamed
  body, spool beneath `data/staging/uploads`, and atomically promote the exact
  bytes to `data/user-files/<user-id>/<file-id>/original`.
- `POST /v1/files/{file_id}:finalize`: verify the current user's pending row,
  opaque local locator, file existence, and exact size; mark the row
  `uploaded`. A chat image (PNG, JPEG, WebP or GIF) is then replaced by its
  canonical copy and marked `ready`, or marked `failed` with a reason and its
  bytes deleted.
- `POST /v1/files/{file_id}:process`: enqueue or reuse a durable processing job
  for the current user's finalized file and wake the server's processing
  runner. The request only enqueues; the runner parses the file afterwards in
  a bounded child process. Returns `409` `file_processing_unavailable` while
  processing is turned off. A chat image has no job: the route returns its
  state, first storing the canonical copy of one left `uploaded`.
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
- `GET /v1/files/{file_id}/content`: return the stored copy (PNG or JPEG) of a
  current-user chat image that is `ready`, revalidated by its digest `ETag`;
  `?variant=thumbnail` returns a WebP copy at most 128 px on its long edge and
  `?variant=preview` one at most 320 px (the chat transcript's size), or the
  stored copy when it is already that small. Other files are `404`; stored
  bytes that are missing or no longer match the record are `409`
  `user_file_content_changed`, and a storage read failure is `503`.
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
flow, in-server processing, statuses, configuration, and debug UI behavior.

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

Frontend and desktop speech flows use client-side offline STT (Parakeet and
SenseVoice-Small), MicVAD, smart-turn, Pocket TTS, ElevenLabs TTS and Gemini
TTS. The local API does not
mount STT or LiveKit session routes.

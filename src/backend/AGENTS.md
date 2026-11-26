# Backend Agent Guide

This file is for AI assistants working in the FastAPI backend under
`src/backend/animama`. Read `../../docs/backend/README.md` first, then follow the more
specific docs linked from there.

## Backend Shape

- `server/` is the FastAPI delivery layer: local app startup, local routers,
  dependency wiring, the local ports, notification WebSocket handling, asset
  helpers, and persistence sinks/subscribers.
- `product_http/` holds the product HTTP shared by every composition (ADR 0021):
  the route inventory, the request principal, the composition-installed
  `ProductPorts`, the shared routers of every stage and the direct chat SSE
  turn (`product_http/chat/`). Each composition installs its ports with
  `install_product_ports`; the local app installs
  `server/product_ports.py::LocalProductPorts`. It is shared code.
- `domain/` contains framework-free dataclasses and event types.
- `app/services/` contains use-case services over repository ports.
- `app/ports/` defines repository, unit-of-work, and model-provider protocols.
- `app/contracts/` owns neutral Pydantic schemas used by shared mappers;
  `server/schemas/` reexports these where HTTP routes need them.
- `app/chat/` contains direct chat context compilation and turn execution.
- `app/model_clients/` defines provider-neutral model-client contracts,
  `MC*` stream-event types, sanitization, and stream-event summaries.
- `adapters/` contains SQLAlchemy repositories, mappers, and direct model-client
  adapters.
- `orm/` contains SQLAlchemy async models.
- `local/` owns installation identity/model/repository, HTTP admission and
  lifecycle, and local database creation. Its dependencies may point into
  shared code; shared code must never import it.
- `resources/` contains packaged shared catalogs and, under `authoring/`, the
  authoring guidance the app's assistant and the `animama-animation` skill
  share; `logging.py` supplies an unconfigured logger. Local logging setup
  stays in `logging_config.py`.
- `workers/` contains maintenance background processes such as upload cleanup.

Prefer this dependency direction:

```text
server routers -> app services -> app ports -> adapters/orm
server routers -> app chat/model_clients -> adapters/model_clients
domain <- app/services
domain <- app/chat
```

Do not import FastAPI or SQLAlchemy into `domain/`. Keep provider SDK calls in
model-client adapters and keep chat orchestration out of route handlers where a
small app service can own it.

Every transitive import of `domain/`, `app/` and `product_http/` must stay independent of
`local/`, `server/`, `runtime/`, `hooks.py`, and `logging_config.py`. Importing a
shared API must not configure logging, resolve local roots, create database
engines, register the installation model, or read installation state. Run
`uv run --no-sync python scripts/repository-boundary/check-python-imports.py`.

## Product Runtime Model

Animama is an AI Avatar Desktop Companion app. The normal backend path is
`POST /v1/animas/{anima_id}/chat:sse`: one resolved owner principal, one
anima/avatar, one selected model provider, streamed SSE responses, avatar
emotion/gesture updates, memory side effects, and durable chat history in
`chats` and `chat_messages`.

Keep normal product chat request-local. Use the direct model-client boundary
and persist transcript state through ChatManager; workflow orchestration requires
a separate API contract.

## Current Docs

- `../../docs/backend/architecture/overview.md`
- `../../docs/backend/architecture/http-api.md`
- `../../docs/backend/architecture/data-model.md`
- `../../docs/backend/runtime/chat.md`
- `../../docs/backend/runtime/model-client-providers.md`
- `../../docs/backend/runtime/prompt-caching.md`
- `../../docs/backend/model-catalog.md`
- `../../docs/backend/features/memory.md`
- `../../docs/backend/features/custom-animas-and-content.md`
- `../../docs/backend/integrations/voice-and-speech.md`
- `../../docs/backend/operations/development.md`

Update these docs when a change leaves useful guidance missing or misleading;
apply the [reader-value standard](../../AGENTS.md#documentation).

## Runtime Notes

Normal chat is the shared `POST /v1/animas/{anima_id}/chat:sse` route
(`product_http/routes/chat_turns.py`), whose stream and chat-turn lease live in
`product_http/chat/stream.py`. It resolves a anima chat profile or request
`model_provider_id`, validates the selected `model_providers` row, prepares the
direct turn through `product_http/chat/turn_setup.py`, invokes a shared direct
model client through `DirectChatTurnExecutor`, derives emotion and gesture
updates from the main structured response, formats frames in
`product_http/chat/sse_events.py` with bridge helpers in
`product_http/chat/sse_runtime.py`, and performs request-local cleanup. Its
collaborators come from the composition's ports (locally
`server/product_ports.py`). The route owns the single public `run.completed`
frame after TTS, title generation, compaction, and other success-side effects.
Provider stream observations stay behind the model-client boundary as sanitized
`MC*` events and compact metadata; do not expose raw upstream OpenAI stream
events directly over `chat:sse`.

## Auth And Ownership

The local application has no user credentials. Backend routes receive the
minimal `RequestPrincipal` through `get_current_principal`, which delegates to
the resolver installed by `create_local_app`. The local HTTP boundary validates
Host, Origin, Fetch Metadata and mutation CSRF markers before admitting a
request. Desktop additionally requires a per-launch renderer capability cookie.
Completed bootstrap supplies the installation principal; request headers never
select it. Private controls require their separate desktop token. Tests use
explicit fixture bootstrap, ordinary browser metadata and FastAPI dependency
overrides, with separate hostile-input boundary tests.

Built Compose publishes only FastAPI on loopback; development publishes Vite,
which proxies a closed set of application routes to private FastAPI. PostgreSQL
stays private. Only the opt-in `dev-tools`
profile adds localhost pgAdmin/Dozzle access for operators; it does not change
product authentication. See `../../docs/backend/operations/development.md` for commands,
port overrides, and safe enable/disable behavior. Never publish PostgreSQL or
route these privileged tools through the application as a shortcut.

Always filter owner-scoped rows by `RequestPrincipal.id`. Existing `user_id` and
`owner_user_id` names remain ownership columns. Do not trust client-provided
owner IDs, object-storage keys, or presigned URL inputs.

`OwnerBootstrapService` receives owner IDs and neutral ports explicitly. Local
installation bootstrap resolves the generated owner before calling it. A
different composition must supply its own identity resolver, defaults policy,
repositories, and storage without importing local installation services.

## Persistence Rules

Use services, ports, repositories, and mappers for new persistence behavior.
Some routes use ORM models directly; keep changes local there unless you
are intentionally refactoring the route.

Change the schema with a new revision in `src/backend/migrations/versions/`,
together with the ORM change. Name the file `NNNN_<topic>.py` and the revision
`<topic>_<YYYYMMDD>` (at most 32 characters), with the current head as its
`down_revision`. Write it with Alembic operations or SQL, without importing the
ORM, so it upgrades an existing database in place and leaves it with the same
schema as a fresh one. Never edit `0001_baseline.sql`, which is frozen at the
schema released in desktop 0.1.2, or a merged revision: installed profiles
already carry them ([ADR 0035](../../docs/adr/0035-released-schema-changes-use-forward-migrations.md)).
`tests/test_alembic_fresh_install.py` compares the migrated schema with the ORM:
tables, columns, types, nullability, server defaults, indexes, and unique and
foreign-key constraints. It does not compare CHECK constraints or index
predicates, so check a revision against those by hand. Update seeds or application defaults directly for data changes.

The local Alembic graph owns the entire accountless local schema. It contains no
hosted identity tables or foreign keys. A future hosted composition must use a
separate migration history, app factory, principal resolver, bootstrap
orchestrator, and environment contract. Shared domain/services accept explicit
owner IDs and must not read installation state.

`create_local_app` owns a lazy `local.database.LocalDatabase`, or accepts an
explicit `session_factory` for composition tests. Request and streaming sessions
resolve from that app, never a process-global factory. Local Alembic registers
`local.installation_model` explicitly; importing shared ORM models does not.

The desktop frozen CLI in `runtime/cli.py` uses these same local resources and
bootstrap services. It must not search repository parents, invoke global
Alembic, or generate a second identity. Desktop database operations verify the
supervisor's expected PGDATA before writes. Readiness under `/_desktop/health`
requires a separate private control token and is never a browser API.

Desktop Included content is an ordered set of immutable `source-id@version`
mounts. Persist exact mount provenance, verify bytes beneath that mount, and
never create or write-probe Included directories. Only Local is watched; absent
optional sources can be withdrawn only after reference and lease checks. Keep
the ordinary single Included root behavior when desktop source variables are
absent.

Every local composition processes uploads inside the server.
`server/user_file_processing.py` runs one durable job at a time and parses each
file in a `parse-upload` child (`adapters/parsers/parse_child.py`) under time
and memory limits with network access blocked; never parse upload bytes in the
server process. A chat image is the one exception, and it is not a processing
job: `:finalize` (and `:process`, for an image an interrupted finalize left at
`uploaded`) decodes the bytes in the server with Pillow through
`canonicalize_chat_image_stream`, which shares the bounded opener and pixel
limits content images use and adds the GIF decoder, two at a time on a worker
thread. `ANIMAMA_USER_FILE_PROCESSING_ENABLED` does not apply to images, and an
image's original is replaced by its canonical copy, never kept.
Parser libraries come from the `documents` extra, which the hosted composition
does not need. Admission stays in the service, not just the
renderer: `ANIMAMA_USER_FILE_PROCESSING_ENABLED=false` keeps originals and
rejects enqueue with `file_processing_unavailable`, while an enabled but
starting or stale processor still accepts durable work. Keep heartbeat instance
matching and own-job lease renewal separate from the public owner-protected
capability endpoint.

## API Contracts

When FastAPI routes, request/response schemas, or OpenAPI output change, update
the relevant backend docs and coordinate frontend generated client regeneration.
Do not hand-edit generated frontend clients to paper over backend contract
changes.

## Library Documentation

Use Context7 when backend work needs the latest documentation or API reference
for a library already in use. Resolve the library ID first, then query the
current docs before relying on memory for version-sensitive APIs, configuration,
or migration behavior.

## Code Comments

Use Python docstrings for new or changed classes, functions, methods, services,
runners, and route helpers when their purpose, inputs, side effects, or
invariants are not immediately obvious. Add concise inline comments for
important non-obvious lines, guard clauses, ownership checks, runtime accounting,
or persistence side effects. Explain intent and constraints instead of restating
what the code already says.

## Memory Rules

Manual memory APIs are separate from direct chat context compilation. Preserve
incognito mode and memory-disabled dispatch options when adding memory behavior.

Do not make core dispatch depend on external queues or background workers.

## Assets And Voice

Avatar/voice content uses staged uploads and the canonical Included/Local
filesystem catalog; private originals stay beneath `ANIMAMA_DATA_ROOT`.
Validate owner, status, containment, size and format before finalizing. Serve
registered bytes through the admitted FastAPI boundary. Do not reintroduce R2/S3 presigned
URLs or renderer-chosen paths for local content. Desktop's immutable mounts,
private environment and recovery rules are in `../../docs/backend/operations/desktop-runtime.md`.

ElevenLabs routes are current for TTS/voice operations. Current frontend speech
uses client-side STT/VAD/turn detection. The local API has no STT or LiveKit
session routes.

## OpenAI Integrations

When changing model-provider behavior or OpenAI platform integrations, consult
current official OpenAI Developer Docs through an available documentation MCP
server or the official website before changing request fields, model names,
tool behavior, streaming semantics, or rate-limit/auth assumptions. No imported
agent skill is required for this workflow. Apply the same rule to the Anthropic
Messages adapter and Memory Manager runtime with Anthropic's current platform
documentation and the installed `anthropic` SDK types.

## Commands

Run from the repository root.

```bash
make sync
uv run python -m animama.server.native_entrypoint
uv run alembic -c src/backend/alembic.ini upgrade head
uv run pytest -q
uv run ruff check
make check-test
uv run --no-sync python scripts/repository-boundary/check-python-imports.py
uv build --wheel
```

Shared animation manifest bytes and the authoring joint table
(`resources/authoring/joints.md`) are generated from canonical frontend
files. After editing one of those inputs, run
`uv run --no-sync python src/backend/packaging/shared_catalogs.py --write`.
Wheel/editable builds reject drift; shared resource reads use package resources
and work without a source checkout. See `../../docs/backend/operations/development.md`.

Workers:

```bash
uv run python -m animama.workers.avatar_upload_cleanup
```

Use focused tests for narrow changes. Use `make check-test` when behavior touches
shared runtime, persistence, or API contracts and time allows.

## Change Checklist

- Keep edits scoped to backend files unless the task requires frontend changes.
- Add or update tests for behavioral changes.
- Update `../../docs/backend/` when architecture, routes, runtime behavior, or
  operational steps change.
- Preserve auth, ownership, incognito, memory-disabled, and suppressed-response
  behavior.
- Do not revert unrelated dirty work in the repository.

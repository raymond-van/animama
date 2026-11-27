# Architecture Overview

The backend is a FastAPI application plus application-layer direct chat
building blocks. The FastAPI layer resolves an owner principal, loads persisted anima
state, resolves anima chat profiles and model-provider catalog rows, invokes
shared model clients, streams direct chat events, and persists side effects.

## Package Layout

- `product_http/`: product HTTP shared by every composition (ADR 0021): the route
  inventory, the request-principal dependency, the `ProductPorts` each composition
  installs (owner sessions, repositories, content services, byte delivery, upload
  storage, speech, the model catalog, the Memory Manager service, and the chat
  policy, chat-turn guard and turn collaborators), the shared routers of every
  stage, and the direct chat SSE turn under `product_http/chat/`.
- `server/`: delivery and local-composition layer. Contains the separately named
  local FastAPI app factory, its `LocalProductPorts`, installation
  bootstrap, local routers, Content Catalog delivery, owner event SSE helpers,
  local upload helpers, persistence sinks/subscribers, and telemetry.
- `domain/`: pure dataclasses and enums for animas, content catalog entries,
  chats, model providers, settings, and runtime events.
- `app/ports/`: protocols for repositories, unit-of-work boundaries, and model
  providers.
- `app/contracts/`: neutral Pydantic schemas consumed by shared mappers. The
  matching `server/schemas/` modules reexport the same types for HTTP routes.
- `app/services/`: use-case services for animas, editable content, exact
  runtime closures, chats, model provider catalog access, owner model
  configuration, model role resolution, embedding refresh, title generation,
  compaction, and settings. These operate on domain objects and ports.
- `app/chat/`: direct chat memory context reads, OpenAI-compatible prompt
  assembly, request options, `DirectChatTurnExecutor`, and direct-turn helpers
  for model stream collection, provider state, response formatting, and
  persistence payloads.
- `app/generation/`: the content assistant of local compositions: storage of
  its conversations and drafts, draft validation, the authoring tools and
  prompts, one model pass, and the run pipeline that the
  [`/v1/generation` routes](http-api.md#content-assistant) stream.
- `app/model_clients/`: provider-neutral direct model-client contracts, `MC*`
  stream-event types, event sanitization, compact event summaries, connection
  credential resolution, the capability-probe port, error categories, usage
  estimates, and the tool-round helpers (`tool_rounds.py`) that chat and the
  content assistant build their next request with.
- `adapters/`: concrete implementations. The containment-safe content
  filesystem store, SQLAlchemy repositories, ORM/domain mappers, and direct
  model-client adapters live here. OpenAI Chat Completions, OpenAI Responses
  and Anthropic Messages adapters are split into request, stream-event,
  final/usage, and client lifecycle modules. The Memory Manager runtimes
  (OpenAI Agents SDK and the Anthropic memory-tool loop) live under
  `adapters/memory_manager/`.
- `orm/`: shared SQLAlchemy 2.0 async models, without installation registration.
- `local/`: installation principal, repository, and model; local HTTP admission,
  lifecycle and assets; local database engine/session ownership. Alembic and local app
  bootstrap register and compose these explicitly.
- `resources/`: packaged shared product catalogs usable without checkout paths.
- `logging.py`: logger adapters with no configuration side effects. The local
  composition configures handlers through `logging_config.py`.
- `workers/`: maintenance background processes such as staged upload cleanup.

## Dependency Direction

The preferred dependency flow is:

```text
server routers -> app services -> app ports -> adapters/orm
server routers -> app chat/model_clients -> adapters/model_clients
domain <- app/services
domain <- app/chat
```

Domain objects should not import FastAPI, SQLAlchemy, or server modules.
Application services should depend on protocols in `app/ports`. Adapters satisfy
those protocols using SQLAlchemy or provider SDKs. The server layer wires the
pieces together.

All transitive dependencies of `domain/`, `app/` and `product_http/` are checked by
`scripts/repository-boundary/check-python-imports.py`. They cannot reach local
installation state, FastAPI composition/configuration, migration/frozen runtime
helpers, logging configuration, or private service modules. Ports carry owner
IDs, storage access, and policy explicitly. `OwnerBootstrapService` uses
caller-supplied defaults and ports; the local bootstrap orchestrator resolves
the installation principal before invoking it.

Some routes still use ORM models directly. For new behavior, prefer the
service, mapper, repository, and unit-of-work patterns unless the local router
already uses direct ORM access and a focused change can preserve that boundary.

## Layer Rules

- Domain objects are pure business objects. They do not serialize themselves and
  do not perform I/O.
- Ports use domain dataclasses in their method signatures and avoid framework
  imports.
- Services group related repository calls and call the unit of work once on
  success. They should not import FastAPI, SQLAlchemy sessions, or provider SDKs.
- Mappers under `adapters/mappers/` translate schema to domain and domain to
  ORM. Keep Pydantic and SQLAlchemy types at the edge.
- Tests can use `adapters/repositories/inmemory.py` for fast service and port
  tests where a real database is not needed.

## Direct Chat Concepts

Normal product chat resolves its model through the Anima chat profile:

- `anima_chat_profiles.default_model_provider_id` stores the anima's
  default catalog row.
- `model_providers` stores provider/model rows, capabilities, lifecycle
  state, and pricing metadata. Built-in rows are seeded from the release
  catalog; the owner can add rows and hide built-in ones.
- `model_connections` stores the model server each row belongs to: the
  built-in OpenAI connection, the built-in Anthropic connection (Anthropic's
  Messages API) or an owner-configured OpenAI-compatible Chat Completions
  endpoint, with its base URL, credential variable name, compatibility
  options and timeout. Requests for a row go only to its connection with only
  that connection's key.
- `ModelCatalogPolicy` is a composition input that decides which rows a
  composition exposes. Shared services default to the OpenAI connection's
  built-in rows only; the local composition enables owner models, the
  Anthropic built-ins and App Settings roles.
- Model roles assign rows to installation-wide jobs: chat (the default for new
  Animas), utility (titles and compaction), the Memory Manager and embeddings.
  `ModelRoleResolver` reads them from user preferences when the policy
  enables owner models, falls back to operator defaults, and checks that each
  row can do its job.
- `DirectChatTurnExecutor` validates the selected provider, opens required
  anima identity context, assembles one OpenAI-compatible `DirectChatPrompt`,
  calls the shared direct model client, parses the main structured response,
  emits domain events, and persists the turn through `ChatManager`.
- `product_http/chat/turn_setup.py` builds request-local direct-turn
  dependencies before the SSE stream starts; `sse_runtime.py` owns bridge,
  drain, and frame mechanics; `session_services.py` owns short-lived database
  session adapters for final persistence and memory tool execution.
- Direct model clients under `adapters/model_clients/` may hold reusable SDK or
  HTTP resources, but all user/anima/chat/run state is supplied by the
  direct chat executor. Provider adapters receive a narrow `ModelClientRequest`
  with the selected provider, assembled `DirectChatPrompt`, provider options,
  and continuation cursor.
- Provider adapters emit ordered `ModelClientDelta` values. Public text/final
  deltas feed the chat turn; `MC*` event deltas record provider lifecycle,
  finish, usage, assistant phase, native tool, and unknown-event observations for
  logs and compact metadata.

## FastAPI Application

`server/app.py::create_local_app` creates the local app:

- global telemetry middleware from `server/telemetry.py`
- `LocalProductPorts` installed with `install_product_ports`, which the shared
  product routes resolve their sessions, repositories, content and delivery from
- `/health`
- the `/v1/...` routers through `server/routers/__init__.py`: the shared
  `product_http` routers interleaved with local routers in inventory order
- `app.state.model_catalog_policy` with owner models enabled, and the
  local-only `model_configuration` router for owner connections, models and
  roles, which that aggregate omits
- private desktop control routes when desktop control is configured

Startup performs process-level setup:

- validates the supported native launcher's loopback-only bind setting
- requires the migration-generated installation principal
- establishes HTTP readiness for the bootstrap-owned principal after content
  runtime startup; failed startup cannot admit product requests
- reconciles local content and idempotently ensures the private profile,
  settings, `PROFILE.md`, and configured Starter Animas
- reconfigures logging
- initializes the app-scoped direct model-client registry
- starts the embedding refresh worker, which re-embeds stored upload chunks and
  archive passages whose model differs from the owner's Embeddings role
- watches Local content; ordinary single-root installations also watch Included,
  while immutable desktop Included mounts are scanned without a watcher

The app owns a lazy `local.database.LocalDatabase`, or an explicitly injected
`session_factory`. Request dependencies, startup scans, and streaming chat
resolve sessions from that app. Engines are created on the serving event loop;
cross-loop reuse before disposal fails clearly. Shutdown stops the embedding
refresh worker and closes app-owned database resources and model clients. An
injected factory remains owned by its caller. There is no process-global
request session factory.

## Configuration

`server/config.py` is the local backend settings source. Shared services receive
policy values or ports from their composition. Important local settings include:

- database URL and PostgreSQL fallback variables
- the default chat model `ANIMAMA_DEFAULT_MODEL_PROVIDER_ID` and role defaults
  `ANIMAMA_DEFAULT_{UTILITY,MEMORY_MANAGER,EMBEDDING}_MODEL_PROVIDER_ID`
  (catalog row IDs)
- the built-in OpenAI connection's `OPENAI_API_KEY` and `OPENAI_BASE_URL`,
  `ANIMAMA_MODEL_CLIENT_TIMEOUT_SECONDS` for connections without their own
  timeout, and `ANIMAMA_LOCAL_MODEL_HOST`, the host that local-server presets
  suggest (`host.docker.internal` in Compose)
- ElevenLabs configuration
- readable `ANIMAMA_CONTENT_ROOT` and private `ANIMAMA_DATA_ROOT` settings
- `ANIMAMA_LOCAL_BIND_HOST` for the supported native loopback launcher;
  Compose uses a separate private-network entrypoint
- `ANIMAMA_PUBLIC_ORIGIN` and optional built `ANIMAMA_WEB_ROOT`
- paired desktop renderer-capability and private-control credentials
- user-file, content, Avatar, and voice size limits
- avatar upload limits and cleanup intervals
- local/test flags such as `ANIMAMA_LLM_SKIP`

The app builds settings with Pydantic settings. Avoid reading environment
variables ad hoc from routes unless the configuration is truly route-local.

## Local Principal Boundary

The local application has no signup, sign-in, password, session, JWT, or API
key. The `baseline_20260908` baseline creates one canonical UUIDv4
`installation_principal_id`; that durable, non-secret ID owns all local rows.
Existing `user_id` and `owner_user_id` names remain in shared product code.

Protected routes depend on `get_current_principal`, defined in the shared
`animama/product_http/principal.py` and re-exported by `server/deps.py`. It
delegates to the `RequestPrincipalResolver` installed by the application
composition; without one, routes fail closed with 503
`request_principal_unavailable`. The local HTTP boundary checks configured Host/Origin, Fetch
Metadata and mutation markers; desktop requests also need the current launch
capability cookie. Successful admission records an object identity in server
request state. `AdmittedLocalPrincipalResolver` resolves only that state after
completed bootstrap establishes the migration-owned principal. Caller-supplied
owner headers confer no authority. Unit tests use explicit
fixture bootstrap and dependency overrides; no production auth bypass exists.

This local factory, bootstrap orchestrator, runtime APIs, environment contract,
and migration graph serve a local installation. A hosted service requires its
own database, app factory, and principal resolver. Reusable domain services and
repository ports receive an explicit owner ID and do not read `installation_settings`.

The installed-wheel consumer in
`scripts/repository-boundary/consumers/backend.py` checks shared service and
streaming reuse with explicit owners while rejecting local imports and
checkout-resolved modules.

## Runtime Ownership

Normal chat is request-local and stateless from the FastAPI process's
perspective. The shared `product_http/chat/stream.py` resolves the selected
catalog model provider, prepares a direct model-client turn through
`product_http/chat/turn_setup.py`, fans current-run events through
`product_http/chat/sse_runtime.py` and `product_http/chat/sse_events.py`, and
closes request-local resources when the stream completes or closes; the
composition's [chat-turn guard](../runtime/chat.md#chat-turn-guard) holds the
whole turn. The route owns the
single public `run.completed` SSE frame after success-side effects such as TTS,
title generation, and compaction. Shared model clients live on the app and close
on shutdown. Each request carries its owner, Anima, Chat and run context; the
API process does not retain a companion session between turns.

## Realtime Delivery

The backend emits direct chat events through a request-local bridge owned by the
active `chat:sse` stream. Current consumers include:

- SSE chat formatting
- request-local emotional-state persistence

Account-level notifications are separate from normal chat requests.
`GET /v1/events:sse` remains mounted as an authenticated reserved stream and
currently emits heartbeat comments only.

The request-local stream bridge is scoped to the current chat turn. Clients
should treat realtime events as delivery signals rather than the only source of
durable state.

## Telemetry

`server/telemetry.py` installs request/response telemetry middleware. Direct
chat uses domain events such as `USER_RESPONSE`, `EMOTION_UPDATE`,
`AVATAR_GESTURE_REQUESTED`, `ERROR`, and `DROP`. The public `run.completed`
SSE frame is route-owned rather than emitted by the app-layer executor.

When adding new runtime behavior, prefer emitting typed runtime events instead
of adding route-specific side channels.

# Data Model

## Neutral Content Catalog

Gesture, Reaction, Particle Effect, Avatar Effect, Scene Effect, Sound Effect,
Avatar, Appearance, voice, and static Pose content share
one readable Content Catalog. The `anima` kind is reserved/rejecting;
live Animas are private aggregates. Included and Local are filesystem sources,
not parallel domain models. Concrete validators and runtime players remain
type-specific; ordinary creator Save updates an editable catalog item instead
of creating an immutable release.

The backend uses SQLAlchemy 2.0 async models under `orm/`. Domain objects live
under `domain/`, and repository adapters map between ORM rows and domain
dataclasses. Routers should generally avoid leaking ORM rows into application
logic.

## Database Engine

`local/database.py` builds the local async engine. Each local app owns its
database resources; requests and chat streams obtain their session factory from
the app. Tests or another local composition can inject `session_factory` into
`create_local_app`. Explicit app settings take priority for the database URL
and pool values. Otherwise the URL comes from `ANIMAMA_DATABASE_URL` when set.
If that is absent, PostgreSQL environment
variables are used. Development defaults point to a local asyncpg PostgreSQL
database.

The engine normalizes common PostgreSQL URL variants, including `sslmode`
conversion for asyncpg. Tests use pytest/testcontainers with a pgvector-enabled
PostgreSQL image, so regular test runs do not need a developer-managed database.

The installation settings model lives in `local/installation_model.py` and is
registered explicitly by local Alembic and bootstrap. Shared ORM imports do not
register installation state or create an engine. Local CLI compatibility
helpers retain their own cached engine, separate from app-owned resources.

The async engine passes explicit pool sizing to SQLAlchemy instead of relying on
implicit defaults. Configure these values with:

- `ANIMAMA_DATABASE_POOL_SIZE` default `10`
- `ANIMAMA_DATABASE_MAX_OVERFLOW` default `20`
- `ANIMAMA_DATABASE_POOL_TIMEOUT_SECONDS` default `30`
- `ANIMAMA_DATABASE_POOL_RECYCLE_SECONDS` default `-1`
- `ANIMAMA_DATABASE_POOL_PRE_PING` default `true`

For deployment sizing, budget approximately
`backend_processes * (ANIMAMA_DATABASE_POOL_SIZE + ANIMAMA_DATABASE_MAX_OVERFLOW)`
possible backend connections, plus worker processes and other services that use
the same Postgres instance. Keep that total below the database's
`max_connections` with headroom for migrations, admin tools, and maintenance
workers.

## Schema and migrations

Alembic revision `baseline_20260908` creates the accountless local schema
released in desktop 0.1.2 from `src/backend/migrations/versions/0001_baseline.sql`.
The SQL creates the tables, constraints, indexes, runtime-worker heartbeats and
content mutation receipts directly, without importing live ORM metadata. Later
schema changes are revisions on top of it: `reasoning_effort_20261112` adds
`anima_chat_profiles.reasoning_effort`, and `content_generation_20261126` adds
the [content assistant's](#content-assistant) three tables.
Database bootstrap (desktop startup, or `./reset.sh` for a Compose stack) runs
`alembic upgrade head`, bringing an existing database forward. The baseline SQL
and merged revisions are never edited
([ADR 0035](../../adr/0035-released-schema-changes-use-forward-migrations.md)).
Update seeds or application defaults for data changes.

The baseline creates and seeds the singleton installation settings row with a
new UUIDv4 principal in the same migration transaction. The principal is not a
fixed seed identity. Alembic ensures extensions before product DDL. The data-only
SQL seeds in `src/backend/migrations/seeds/` run after migrations through the shared database
bootstrap service used by Compose reset and desktop. Catalog seeds and
application owner/default/starter bootstrap
retain their separate responsibilities and idempotence.

Databases stamped with any removed revision cannot upgrade through this graph.
Retain the matching old checkout to read or restore those databases/backups, or
explicitly recreate a disposable development database. Do not stamp an old
schema as the baseline. Ordinary startup and restarts do not clear data. A full database reset
loses database-owned content and creates a new owner; retained Local files and
private upload bytes need separate recovery consideration. See
[Database operations](../operations/development.md#database).

The local graph contains no hosted identity tables and is not used by the
future hosted Animama Cloud database. Fresh databases contain only the neutral
catalog, loadout, runtime snapshot and other active product tables. Package
manifests are generated at import/export time rather than persisted as everyday
Local content.

## Core Entities

### Installation Settings

`ORMEpisodeProcessingSettings` (local only, `episode_processing_settings`, keyed by
`user_id`) holds the owner's automatic episode-processing `threshold` (NULL for the
default, 0 for Off, otherwise 5–50, checked) and its last change, `reset_at`.

`ORMInstallationSettings` maps the singleton `installation_settings` row. Its
small-integer primary key is constrained to `1`.
`installation_principal_id` is non-null and unique; the baseline generates
its canonical UUIDv4 once in the same transaction that creates the row.
`first_run_completed_at` is nullable and write-once. Ordinary restarts and
application restarts preserve this row and therefore preserve ownership. A
full database purge creates a new principal. A missing singleton or malformed
principal is a fatal local configuration error.

### Readable Content Catalog

`ORMContentCatalogItem` maps `content_catalog_items`. It stores one
logical identity reconciled from an Included or Local entry: source,
authorization scope, optional owner, typed kind, human-readable relative
locator, optional descriptor/logical key, display name, scan status, revision
SHA-256, provenance, metadata, diagnostics, and scan timestamps. Desktop
Included items also carry a `source_mount_id` such as `core@<build-id>`; it is
an immutable-source selector, not an owner or path. Absolute paths
are forbidden by architecture and never persisted.

`ORMContentCatalogFile` maps opaque `file_ref` values to exact item-local
regular files, roles, media types, sizes, and SHA-256 digests. The protected
delivery route joins back to the item for scope/owner/status authorization,
then uses the item's exact mounted source plus the stored relative path. Missing
items lose usable file registrations.

`ORMContentCatalogDependency` stores ordered declared references and the
resolved target item when unambiguous. Authoritative reconciliation marks
unresolved, ambiguous, or cyclic roots invalid. It never substitutes a similar
entry.

One exception lets Included effects be removed before launch without migrating
Local content: a Local Gesture or Reaction whose `builtin:` Avatar, Particle or
Scene Effect dependency no longer exists (no present entry claims the ref)
stays valid with a `missing_effect_dependency` diagnostic naming the ref. Its
edge keeps a null target and is exposed as `missing_dependencies`, not as a
member, so typed views, the runtime closure and loadouts see only the remaining
dependencies. The runtime projection lists the removed effects by clip alias
(`missing_references`), and the player skips their events; Portable export
refuses the Action (`package_dependency_missing`) until its creator maps or
removes them, and Save and package import refuse to admit one: only Actions
saved before the removal outlive it. An invalid or ambiguous target, a Local
ref, a sound, an Included Action or any other kind still invalidates the
Action.

Animama no longer provides Twemoji, so a Scene Effect `emoji` marquee or
scatter item is refused everywhere except in Local content saved before the
removal: the Local scan keeps such a Scene valid with one
`scene_emoji_item_removed` diagnostic per item (`LOCAL_TOLERATED_DIAGNOSTICS`)
and checks the rest of its definition as it plays, without those items. The
same diagnostic invalidates an Included Scene. Save refuses an emoji item
(`saved_content_invalid` with the item, such as `marquee.items.0`, as
`field`); Portable export and package import refuse it with
`scene_emoji_item_removed`, as they do a package declaring a retired
`animama/twemoji/…` capability.

`ORMContentMutationReceipt` stores successful Save, Delete, and Import results
in the same database transaction as their catalog, owner, and provenance
changes. An existing operation result is immutable: identical requests replay
it, while a different digest conflicts. Receipts are retained across item
deletion and are not runtime leases or filesystem recovery journals. Filesystem
journals retain original bytes until this committed database decision is known;
startup and Rescan resolve them before admitting Local content.

A same-path edit preserves the item and opaque file reference while updating
digests. Explicit logical keys and an otherwise unique content revision allow
safe rename reconciliation. Ambiguous renames leave the old row missing and
create a new identity.

Mounted Included reconciliation scopes identity matching to the stable source
ID. Replacing one source version can retain its item IDs, but identical files
from another mount cannot adopt them. An absent optional mount is withdrawn
atomically only after Avatar, loadout, dependency, active-preview, and runtime
pin checks. It is not misclassified as a missing core file.

`ORMContentPreview` and `ORMContentPreviewFile` freeze the owner,
catalog revision, expiry, and exact file facts for one ephemeral typed preview.
Each preview file also retains its exact `source_mount_id`; issuing a preview
rechecks the current locked item/revision/mount before publishing the lease.
`ORMAvatarFacePartOverride` maps `avatar_face_part_overrides`: one owner's
face-part correction for one Included Avatar item, keyed by
`(owner_user_id, avatar_item_id)` and cascaded with the item. It applies only
while `avatar_revision_sha256` equals the item's current revision; Local
Avatars keep the correction in their sidecar instead.
`ORMAvatarSettingOverride` maps `avatar_setting_overrides`: one owner's
settings for one Local or Included Avatar item, keyed by
`(owner_user_id, avatar_item_id)` and cascaded with the item. Nullable
`spring_mode` (`on`, `off`, `springs_off`), integer `wind_strength`
(0–200 percent) and `material_mode` (`liltoon`, `simple`) are checked by
constraint; NULL means Automatic (100 percent for the strength), and the
repository removes a row once all three are NULL. Rows have no revision or digest binding, so
they survive an in-place Avatar update.

Typed documents themselves are framework-neutral domain values and are parsed
by the closed kind-handler registry; the catalog's bounded metadata projection
is not the application semantic model.

### Local User Profile

`ORMUserProfile` stores private installation personalization in
`user_profiles`. Its primary key is the installation principal in the retained
`user_id` ownership column. The only mutable field is nullable
`display_name VARCHAR(30)`; null is allowed only for the pending-setup
placeholder. Saving personalization requires a nonblank name. Creation and update
timestamps complete the row.

`LocalInstallationBootstrapService` creates the missing profile through the
neutral `OwnerProfileBootstrapPort`. First-run completion updates the profile,
the guarded bootstrap-managed `PROFILE.md` version, and
`installation_settings.first_run_completed_at` in one transaction. A direct
user edit to `PROFILE.md` disables later automatic synchronization.

The application path is:

```text
User Profile router schema -> UserProfileService -> UserProfileRepository -> SQLAlchemyUserProfileRepository -> ORM
```

See [Local User Profile](../features/user-profiles-and-usernames.md) for the
current API and privacy rules.

### Companion Safety State

`ORMCompanionSafetyState` maps `companion_safety_state`, one row per owner
principal keyed by `user_id`. It never stores message content. `age_status` is
`unknown`, `adult` or `minor` (default `unknown`), with nullable
`age_status_source` (`self_attestation`) and `age_status_recorded_at`; first-run
completion records `adult` in the same transaction. The AI-notice cadence uses
`last_notice_at`, `last_notice_local_date`, `interaction_started_at`, and
`last_turn_started_at`; `chat:sse` locks the row while it decides whether a
notice is due. See [companion safety](../runtime/chat.md#companion-safety).

### Content Catalog And Anima Loadouts

Each valid catalog item owns its current readable revision, registered files,
and resolved dependencies. Creator Save atomically updates the Local source and
reconciles this state. Included entries are read-only.

`content_mutation_receipts` retains original Local mutation results under the
composite key `(owner_user_id, operation_id)`. Each row stores the request digest,
JSON success result and creation timestamp. It has no item foreign key: later
edits or hard deletion must not erase original-success replay.

Avatar and Scene Effect catalog metadata stores closed, bounded renderer
definitions and logical local resource names. The catalog never stores a
signed URL, external media URL, or absolute path. Gesture and Reaction
dependency rows point at the exact catalog targets selected by their
descriptors.

`ORMAnimaLoadout` maps `anima_loadouts` and owns the optimistic revision and the
starter loadout version the loadout started from. An Anima's Gestures are
exactly its `gesture:<semantic_key>` rows
([ADR 0030](../../adr/0030-anima-gestures-are-binding-rows.md)). A Compose
development database created before then keeps an unused `starter_exclusions`
column, and any starter it showed without a row must be re-equipped; a packaged
desktop profile reports `database_schema_mismatch` until it is reset, as after
any baseline edit.
`ORMAnimaContentBinding` stores typed logical catalog selections and their
family-specific configuration. Gesture semantic-key uniqueness and the
four-member Reaction pool limit are enforced by the service. Idle pool members
are Gesture rows with slot `idle:<cell>:<catalog_item_id>`, and Reaction pool
members are Reaction rows with slot
`reaction:<emotion>-<intensity>:<catalog_item_id>` and empty configuration
(the `typed_slot_shape` check requires that member shape), so the
`(anima_id, slot_key)` key admits each Gesture or Reaction once per cell.
Effects and Sounds reached through an Action are compiler-managed dependencies
rather than peer loadout rows. Legacy
Music/clip kind values and Music indexes remain readable for preserving
transitions and historical receipts; they grant no current product admission. `ORMAnimaLoadoutMutationReceipt` makes lost-response retries idempotent;
`ORMAnimaLoadoutDiagnostic` preserves visible warnings for rejected persisted or
externally invalid equipment without deleting its catalog item.

Runtime compilation persists one `anima_runtime_snapshots` row for each exact
owner/Anima/effective revision. Its bounded `admitted_item_revisions` JSON
object pins every admitted catalog item to the revision used by the typed
projection; canonical file facts remain registered once in
`content_catalog_files`. The snapshot also stores the immutable typed catalog
body and its digest, and `bundles`, the delivery bundles issued with it (each
bundle's format and member list by bundle ID), so a bundle read loads only its
own members. `inputs_digest` digests everything the snapshot was compiled from, so
issuing an unchanged loadout again renews it instead of compiling; it is null for a
compile that found changed files. Response URLs and the current lease expiry are
overlaid when the snapshot is read. There is no per-runtime file-membership table.

Chat turn setup authorizes the issued snapshot and consumes its persisted
Gesture/Reaction inventory instead of rebuilding against mutable catalog
state. Runtime file delivery joins the snapshot, requested canonical file, and
parent item in one read-only query. It permits delivery only when the parent is
still accessible, valid, and at the pinned revision, then rechecks the actual
filesystem size and digest before streaming.

### Anima

`ORMAnima` stores the user-owned anima aggregate:

- `user_id`: explicit owner principal (the installation principal locally)
- `display_name`: stable owner-edited name, independent of Avatar metadata
- `aggregate_revision`: positive definition revision, initially 1
- `identity_status`: `ready` or `repair_required`
- optional archive and avatar foreign keys
- optional profile picture URL
- emotional state JSON
- user-controlled metadata
- relationships to chat profile rows and chats

Display names belong to Anima, independently of the joined Avatar. The Avatar
FK is `RESTRICT`; deleting an equipped Avatar cannot silently clear it.

New writes also create the typed loadout described above. That association is
the authoritative source for the live canvas and direct-chat runtime; the
Avatar aggregate supplies its selected catalog model and optional portrait.

The current [live creation model](../features/custom-animas-and-content.md)
includes stable Anima name/revision and compact `anima_definition_revisions` records
keyed by `(anima_id, aggregate_revision)`, with display name, identity entry and
version pointer, actor, reason, and timestamp. Identity stays in the existing
Anima-scoped `memory_entries`/`memory_entry_versions` SQL virtual filesystem,
with no physical `IDENTITY.md` projection. New aggregate, identity, and loadout
revisions start at 1. Name changes advance aggregate revision; identity writes
and Revert advance aggregate and memory version; equipment changes advance
aggregate and loadout revision once. Runtime state, chats, and ordinary settings
do not advance definition history. The materializer writes all children through
one caller-owned session and leaves commit/rollback to the caller.

New Animas receive identity through the materializer. The baseline does not
backfill identity in databases outside its supported revision graph.

The baseline includes owner-scoped
`anima_creation_receipts` and stable `anima_starter_receipts`.
Creation uniqueness is `(owner_user_id, operation, idempotency_key)`, with a
normalized-spec SHA-256 and compact original result, never the submitted
identity/spec. Transaction-scoped locks serialize first attempts and retries.
Successful creation receipts and deletion tombstones
are retained for owner lifetime, not the loadout mutation receipt's expiry.
Starter uniqueness is owner plus `starter:annie`/`starter:andrew`, independent
of specification version. The baseline neither reads an account table nor
pre-populates account-derived receipts. The local installation bootstrap creates missing
Starter receipts for the generated principal through the normal idempotent
service. Intentional deletion is preserved. The receipt owner columns have no
account foreign key; the original Anima ID survives as a tombstone. Receipt and aggregate writes share one
caller-owned unit of work; first runtime issuance happens after commit.

### Anima Chat Profile

`ORMAnimaChatProfile` stores product-level chat configuration for one anima.
Its current source-of-truth field is `default_model_provider_id`, a foreign key
to `model_providers.id` such as `OpenAIHTTPAgent:gpt-6-luna` or an owner row's
`owner:<hex>` ID. Because profiles reference catalog rows, removed models are
retired rather than deleted. Normal
`chat:sse` uses this row when a request does not pass an explicit
`model_provider_id`, and the frontend model selector updates it through
`PATCH /v1/animas/{anima_id}/chat-profile`. The nullable `reasoning_effort`
stores the owner's effort for that model (null for the model's default); the
composer reads it and sends the effort with each turn, and a model change
clears it.

### Model Providers

`ORMModelProvider` stores the durable provider/model catalog in
`model_providers`. Each row is one adapter/model pair served by one model
connection. Built-in rows use IDs such as `OpenAIHTTPAgent:gpt-6-luna`; owner
rows use opaque `owner:<hex>` IDs. The unique key
`uq_model_providers_connection_model` covers
`(connection_id, provider_type, model, source)`, so two connections can serve
the same model name, and a release can add a built-in row that the owner
already added on the OpenAI connection.

Rows include public selection metadata, runtime capability metadata such as
`supports_developer_role`, `supports_tools`, `tools_with_structured_output`
(whether tools and a response schema work in one request) and the
backend-internal `structured_output_transport`, lifecycle fields (`active` and
`deprecated_at`), and backend-internal pricing/source metadata. Rows store no
base URL or credential; both come from the connection. Connection and owner
configuration columns are:

- `connection_id`: non-null foreign key to `model_connections.id`;
- `source`: `builtin` (release-managed) or `owner`;
- `model_kind`: `chat` or `embedding`;
- `hidden`: the owner hid the row from model lists;
- `early_compaction` (default true): the owner's **Compact early** setting,
  which applies only to Anthropic rows with a long-context price threshold
  (see [model catalog](../model-catalog.md#compact-early));
- `allow_memory_writes`: false limits direct chat to read-only memory tools;
- `probe_result`: nullable JSONB summary of the capability probe the owner
  applied: its findings and each step's name, result and category, never the
  server's error text.

The deterministic post-schema seed is generated from `MODEL_CATALOG`. It
upserts the built-in `openai`, `anthropic` and `chatgpt_plan` connections and
built-in rows, never changes `hidden`, `early_compaction`, `source` or
`connection_id`, never touches owner rows, and retires
built-in rows missing from the catalog, except the `chatgpt_plan` connection's
rows: sign-in and model refresh store those from the signed-in account's model
list, and sign-out retires them (see
[model catalog](../model-catalog.md#chatgpt-plan-connection)). Owner rows and connections are retired
(`active = false`), never deleted, and re-adding a model on the same connection
reactivates its row. Public `/v1/model-providers` responses omit pricing fields
and `structured_output_transport`.
Application cost helpers consume these rows together with `Usage` counters to
produce Decimal token-cost estimates, but account billing and quota enforcement
are not implemented in this table. Owner rows are unpriced.

Model role assignments are catalog row IDs in user preferences (see
[Settings](#settings)); they have no foreign key, and removal clears them.

### Model Connections

`ORMModelConnection` maps `model_connections`: one model server that catalog
rows belong to. Columns are `id`, `source` (`builtin` or `owner`), `name`,
`preset`, nullable `base_url`, nullable `credential_env`, `compatibility`
JSONB, nullable `timeout_seconds`, `active` and timestamps. The seeded
built-in connections store no base URL or credential reference: `openai` uses
the process `OPENAI_BASE_URL` and `OPENAI_API_KEY`, `anthropic` uses only
`ANTHROPIC_API_KEY` against Anthropic's API and serves only
`AnthropicMessagesHTTPAgent` rows, and `chatgpt_plan` uses the owner's ChatGPT
plan sign-in, whose tokens live in a private session file and never in the
database, and serves only `ChatGPTPlanResponsesHTTPAgent` rows. `credential_env`
stores only an environment variable name, never a key. `compatibility` holds
the request-shape options `fold_developer_role`, `send_openai_extensions`,
`send_stream_usage`, `strip_function_strict` and `reasoning_mode`. Removing a
connection retires it and all its rows.

### Web Search Settings

`web_search_settings` holds at most one row (`id = 'installation'`): the
application web search `backend` (`searxng` or `brave`), a nullable SearXNG
`base_url`, a nullable `credential_env` (a variable name, never a key) and a
nullable `timeout_seconds`. No row means application web search is off.

### Memory

The schema stores scoped markdown memory as a hybrid tree plus cached
path index:

- `ORMMemoryEntry` maps to `memory_entries`, the current live or soft-deleted
  row for one filesystem entry. Rows are scoped by `user_id` plus nullable
  `anima_id`: `NULL` is account-wide user memory, and non-null selects one
  anima-specific tree. Fields include nullable `parent_id`, `type` (`file` or
  `directory`), `name`, `normalized_name`, cached `path`,
  `normalized_path`, file-only `content`, `content_sha256`, `size_bytes`,
  current `version`, optional `kind`, optional `description`, metadata JSON,
  timestamps, `deleted_at`, and a generated PostgreSQL `search_vector` over
  path, description, and content for direct memory tool full-text search.
- `ORMMemoryEntryVersion` maps to `memory_entry_versions`, an internal
  append-only audit table. Each successful create, update, move, delete, Undo,
  or Revert appends a row keyed by entry ID plus version. Version rows snapshot scope,
  parent/name/path, entry type, file content fields where applicable, entry
  metadata, deletion state, separate change provenance, operation, and
  timestamp.
- `ORMMemoryEpisodeItem` maps to `memory_episode_items`, the source-of-truth
  table for raw episodic-memory notes captured after successful non-incognito
  `chat:sse` turns. Rows store user ownership, optional chat/run/message
  provenance, `occurred_at`, `local_date`, generated `episode_path`, text,
  binary status (`pending` or `processed`), processing metadata, and source
  metadata JSON. `processed` means reviewed, whether or not the review changed
  curated memory. Generated daily markdown files under `episodes/**` are
  projections of this table.
- `ORMMemoryManagerRun`, `ORMMemoryManagerMessage`, and
  `ORMMemoryManagerApproval` map to `memory_manager_runs`,
  `memory_manager_messages`, and `memory_manager_approvals`. Runs persist a
  constrained `kind` (`general`, `episode_processing` or `reflection`) and an
  optional versioned private `task_state`. An episode-processing task stores the fixed
  ordered episode IDs, run-local aliases `E01` through `E50`, batch size,
  `has_more`, timestamps, and `processing` or `processed` status; episode text
  is reloaded from its source rows rather than copied into the run. A
  Reflection task stores its Anima ID and name, the coverage it started from
  (position and run ID, or none), the batch boundary position, batch and total
  uncovered turn counts, start time and the owner's time zone; turn text is
  read from chat history rather than copied into the run. Runs record the
  catalog row that ran their latest step in `model_provider_id`, which
  approval resumes use. Runs also
  store the internal nullable `openai_previous_response_id` Responses cursor
  and serialized runtime state while an approval is paused (Agents SDK state,
  or the Anthropic runtime's stored conversation). Visible
  messages form the UI/audit transcript. Approval rows contain target path,
  operation, expected version, old/new content, nullable old/new description,
  unified diff preview, decision status, optional rejection-only
  `decision_feedback`, decision timestamps, the positive `applied_version`
  committed by approval, and a consistent nullable
  `undone_at`/positive `undo_version` pair. Constraints
  prevent non-positive application/Undo Versions and incomplete Undo audit
  pairs. The partial unique indexes enforce at most one owner-started run
  (`uq_memory_manager_runs_user_open`) and one automatic run
  (`uq_memory_manager_runs_user_open_automatic`, `metadata.origin =
  'automatic'`) per user whose status is `active` or `waiting_approval`. Superseded active runs retain their
  transcript and durable runtime state and record
  `metadata.completion_reason = "superseded_by_new_run"`.
- `ORMAnimaMemoryReflection` maps to `anima_memory_reflections`, one row per
  Anima (primary key `anima_id`, `ON DELETE CASCADE` to `anima`) recording
  Reflection coverage: `user_id`, the covered-through chat message position
  (`covered_through_created_at`, `covered_through_message_id`), the `run_id`
  of the Reflection that set it, and `updated_at`. Turns at or before that
  position are covered. No row means nothing is covered. Only an applied
  Reflection `MEMORIES.md` change moves it, in the approval's transaction;
  Undo of that change restores the previous position. `run_id` has no foreign
  key, so coverage does not depend on manager-run retention.

Neither the Responses cursor nor private task state is projected through the
public manager API. The API exposes only run kind, a safe episode task summary with
status, batch size, `has_more`, `started_at`, and `processed_at`, and a
Reflection summary with the Anima ID and name, turn count, remaining turn count
and `started_at`. Visible messages remain the UI/audit transcript. On
Responses rows the cursor is the live model-context chain; Chat Completions
rows keep no server state, so each turn replays the run's stored user and
assistant messages. Serialized agent state is separate: it stores an exact
paused Apply Patch interruption and is cleared after the SDK resumes without
another interruption.

The baseline includes run kind, task state, the Responses cursor,
approval feedback, old/new descriptions, applied Version and Undo audit fields.
Schema changes add an Alembic revision.
Databases outside the supported revision graph require their matching checkout
or an explicitly disposable reset; a routine restart does not add missing
schema or discard data.

Undo and Revert preserve the append-only model. An approved Memory Manager
patch records the exact entry and Version it produced. Undo appends a new
`operation = "undo"` snapshot and records source approval/run/applied-Version
provenance in `change_metadata`; update Undo restores the approval's old body
and old description together and does not rewrite the approved decision.
Revert appends `operation = "revert"` and records source-entry plus selected
target-Version provenance. In both cases `change_metadata` explains why the
version exists for audit purposes and remains separate from the entry's own
metadata snapshot. The inverse mutation, appended Version, and approval audit
fields share one transaction.

The native Apply Patch harness uses a synthetic description header only while
the model reads and diffs a virtual file. Strict parsing separates the result
before persistence: `memory_entries.content`, `content_sha256`, `size_bytes`,
search vectors, and every `memory_entry_versions.content` snapshot contain only
the Markdown body, while `description` remains the first-class metadata field.
One accepted native patch updates both fields and appends one Version.

Public entry routes validate any non-null `anima_id` against the admitted
installation principal before resolving or creating entries in an anima scope.
Partial unique indexes enforce one live namespace for files and directories:
root user entries, root anima entries, non-root siblings, user-scope cached
paths, and anima-scope cached paths all ignore rows with `deleted_at IS NOT
NULL`. A virtual root is used instead of a persisted root row; `parent_id = NULL`
means the top level of the selected scope.

The baseline includes the memory-manager open-run index. Changes to this
invariant add an Alembic revision.

The application path is:

```text
memory entry router schema -> MemoryEntryService -> MemoryEntryRepository -> SQLAlchemyMemoryEntryRepository -> ORM
memory manager router schema -> MemoryManagerService -> MemoryManagerRepository -> SQLAlchemyMemoryManagerRepository -> ORM
```

`MemoryEntryService` owns name/path normalization, type-specific validation,
byte limits, SHA-256 calculation, description trimming and blank-to-null
normalization, optimistic version checks, version increments, descendant path
cache updates for moves, soft deletes, audit-row writes, and ownership-scoped
version-history reads.

`memory_entry_versions` is append-only and keyed by stable entry ID plus a
positive monotonically increasing version. History list queries are content-free,
newest first, and paginated by `before_version`. Exact detail reads load Version
N and its immediate Version N-1 predecessor; Version 1 alone uses a virtual
empty Version 0 baseline. The service returns a unified content diff plus
structured path and description changes without mutating current state. History
authorization loads the owned current entry even when soft-deleted, and
generated episode-log snapshots are readable through the same interface.

Source/provenance details for seeded files belong in memory-entry `metadata`
instead of dedicated columns. Materialization seeds an anima-scoped `IDENTITY.md`
entry with `kind = "anima_identity"` and
`description = "{anima.display_name}'s identity"`, plus a template
`MEMORIES.md` with `kind = "anima_memories"` and
`description = "{anima.display_name}'s memories"`. An anima scope admits only these
two root files. Starter adoption
can inspect persisted `avatar_identity_seed` metadata and Version 1 history;
ordinary creation does not invent that adoption evidence.

Normal direct chat fetches cached path `IDENTITY.md` in the active anima scope
at turn setup as required anima configuration and inserts its markdown content
into the system instruction, followed by the content of `MEMORIES.md` when
memory influence is enabled and the file is nonblank. Installation bootstrap creates a
user-scope `PROFILE.md` entry for the installation owner with `kind = "user_profile"`
and `description = "User profile"`. Its guarded bootstrap
metadata allows first-run preferred-name synchronization until the owner edits it.

Direct chat also renders a request-local `# List of memory files` developer
message immediately before the latest user message when memory influence is
enabled. The list contains only user-scope file entries (`anima_id IS NULL`),
uses cached paths such as `PROFILE.md`, and omits anima-scoped files and tree
formatting. Each entry contains only `path` and `description`.
The list is not persisted as a chat message or memory-entry version; persisted
`metadata.memory_context.opened_files` keeps the `(anima_id, path)` scoped
version/SHA fingerprints used for backend refresh checks. When
`disable_memory_influence` is true, direct chat omits the list but still keeps
required anima identity. AI memory tools can list/read/search/write user-scope
file entries and read/edit the active Anima's own `MEMORIES.md` through the
`[self]/MEMORIES.md` alias; they cannot access identities or other Animas'
files.

The Memory Manager commits an approved create or update through
`MemoryEntryService` and resumes the paused runtime state. Specialized
episode-processing runs bind at most 50 pending rows to one private task. A
successful terminal runtime result with no pending approval atomically marks
that exact batch processed, regenerates every affected daily episode file,
changes task state to `processed`, and leaves the run `active` for ordinary
follow-up conversation. Blocked or failed execution leaves task state
`processing` and the fixed rows pending.

Reflection reads chat history by Anima, joining `chat_messages` to
`chats.anima_id` across all of the owner's chats with that Anima. A turn is the
visible user and assistant rows sharing a chat and `run_id` (a row without a
run is its own turn), ordered by its last message's `(created_at, id)`.
Internal rows are never read, and every row of a turn whose assistant row has
`message_data.memory.updates_enabled = false` is skipped; a missing flag counts
as enabled. Incognito turns are never persisted.

The Alembic baseline creates these tables on fresh installations;
application startup does not create them from live ORM metadata.

### Chats And Messages

The product-facing backend boundary treats a user thread as a `Chat`: one
resolved owner principal chatting with one anima/avatar. The public durable API uses
`/v1/chats` and `chat_id`; `chat:sse` resolves the same owner-scoped Chat row.

`ORMChat` stores chat metadata in `chats`:

- `id`
- `user_id`
- `anima_id`
- title
- `api_standard`, nullable. This is the chat transcript compatibility key.
  Supported values are `chat_completions`, `responses` and
  `anthropic_messages`; CHECK constraints enforce both lists.
- `last_model_client`, nullable. This records the model-client profile from the
  latest successful durable `chat:sse` turn: `openai_chat_completions`,
  `openai_responses` or `anthropic_messages`.
- `last_model_id`, nullable. This records the catalog model slug from the
  latest successful durable `chat:sse` turn.
- `last_model_provider_id`, nullable text with no foreign key. This records the
  catalog row ID from the same turn, so clients can restore the exact row when
  several connections serve the same model name.
- metadata JSON
- `metadata.memory_context`, a direct-chat manifest recording the latest opened
  memory file fingerprints for the chat. The manifest includes opened `path`,
  nullable `anima_id`, status (`opened`, `current`, or `refreshed`), version,
  SHA-256, kind, the
  `disable_memory_influence` flag, run metadata, and the message turns
  persisted for the run. These fingerprints are persisted metadata used for
  freshness and diagnostics, not prompt instruction text.
- `openai_previous_response_id`, the latest OpenAI Responses API cursor for
  providers that continue chat state with `previous_response_id`; normal
  `OpenAIResponsesHTTPAgent` turns advance this from the final assistant
  message's compact `message_data.openai.response_id`
- created/updated timestamps
- cumulative usage counters: `cum_input_tokens`, `cum_output_tokens`,
  `cum_total_tokens`, `cum_cached_input_tokens`, and
  `cum_output_reasoning_tokens`
- `active_context_tokens`, the latest normal assistant turn's last model
  request (prompt and reply, minus output reasoning tokens) for compaction
  trigger decisions. A turn with several requests records that footprint as
  `context_tokens` in the assistant row's provider metadata; a server that
  streams no usage gets a character-based estimate marked `usage_estimated`
- `next_turn`, the next per-chat `chat_messages.turn` value to reserve

The compatibility columns remain nullable because `/v1/chats` may create an
empty chat before a model provider is selected. `ChatManager` writes
`api_standard` when `chat:sse` creates a missing chat row, initializes it on an
empty pre-created row, allows later model switches only when the stored
`api_standard` matches the selected provider's `api_standard`, and rejects
non-empty null-standard chats as invalid transcript state. Successful
non-incognito turns update `last_model_client`, `last_model_id` and
`last_model_provider_id` together with usage totals and turn reservation. The
baseline includes these columns; it does not backfill legacy databases.

`ORMChatMessage` stores persisted messages in `chat_messages`:

- required `chat_id` foreign key to `chats.id`
- `run_id`
- `message_type`
- role/content/message data. Normal visible roles are `user` and `assistant`;
  internal direct-memory tool result rows use role `tool`. Direct-chat
  assistant `content` stores the raw structured model response JSON, while
  public history routes project it back to display or speech text.
- nullable `raw_provider_message`, the Chat Completions-style message object
  used for next-turn replay. User rows store user messages, final assistant
  rows store raw assistant content, internal assistant rows store `tool_calls`,
  and internal tool rows store `tool_call_id` plus tool output. Anthropic final
  assistant rows store Anthropic content blocks instead: the turn's latest
  server compaction block, when there is one, then the reply text; their
  internal rows store `anthropic_tool_use` and `anthropic_tool_result` items.
- optional `model_provider` and `model` snapshot for provider-generated rows,
  indexed but without a foreign key, so history survives retired or
  same-named rows on other connections. User messages and non-provider rows
  intentionally keep these fields null.
- `message_data.structured`, the parsed direct-chat structured response used by
  history readers, search, emotion updates, gesture requests, and TTS
- `message_data.model_client`, the provider-neutral metadata envelope for the
  visible assistant row. It records the provider type, selected
  `model_provider_id`, and JSON-safe `raw_provider_metadata` from the final
  model-client result.
- `message_data.model_client.raw_provider_metadata.stream_event_summary`, when
  present, stores compact sanitized model-client stream observations: event
  counts, finish reasons, usage visibility, terminal events, assistant phases,
  output item summaries, native hosted tool summaries, unknown-event counts, and
  warnings. Raw provider stream event payloads are not stored here.
- `message_data.openai`, present for OpenAI Responses assistant rows with a
  final response ID, stores compact continuation and replay metadata such as
  provider, API, model, `response_id`, request `previous_response_id`, output
  item IDs, assistant `phase`/`phase_counts`, `message_phases`, annotations,
  native tool summaries, unknown output item types, and
  `stream_event_summary`.
- `message_data.anthropic`, present for Anthropic assistant rows: message ID,
  stop reason, usage (with compaction `iterations`), block
  types, billed web searches, search summaries and citations. Sources are
  stored, not displayed; thinking and encrypted search content are never
  stored.
- `message_data.memory`, on the final visible assistant row of a persisted
  direct-chat turn: `updates_enabled` and the turn's `MEMORIES.md` change
  (`{entry_id, version, excerpt}` or `null`), read back as the chat memory cue.
- Stored/debug payloads may contain `message_data.raw_response`; normal
  chat-history responses remove raw-provider details before returning messages
  to clients
- per-message usage counters
- optional `turn`, populated by normal chat persistence as a per-chat message
  ordinal starting at `1`
- `internal`, used for backend-only rows such as compaction context and direct
  memory tool call/result records
- `created_at`

Chat message search stores a generated `search_vector` column computed from
structured speech and display text concatenated together, falling back to raw
`content` when neither structured field is available. Search-result snippets
show the same user-facing text, with the speech's audio tags hidden
([audio tags](../integrations/voice-and-speech.md#audio-tags)); matching still uses the stored speech. This keeps search user-facing even
though raw assistant content is durable JSON. A partial PostgreSQL GIN index
covers that vector only for visible user/assistant rows with non-null content.
The search API builds a
sanitized prefix `to_tsquery` from alphanumeric terms, so partial terms such as
`Reac` can match `React` without interpreting web-search operators such as
quoted phrases, `OR`, or negation. The API joins messages through `chats` and
`anima`, so result rows remain scoped to the current request principal and can
include anima display
metadata such as `profile_picture_url`. Matching messages are collapsed to one
result per chat; the best matching visible message supplies the snippet and
score.

`ORMChatCompaction` stores hidden continuity summaries in `chat_compactions`.
Rows are separate from the visible transcript and include:

- `chat_id`, `user_id`, and `anima_id`
- status (`active`, `superseded`, or `failed`)
- `summary_text`
- covered turn boundaries (`start_turn` and `end_turn`)
- `source_message_count`
- compaction model/provider/prompt fields
- actual compaction model usage counters when available
- metadata JSON for threshold, preserved-message count, and trigger token count

The active compaction row is hidden continuity context for the next direct chat
turn. It is selected by `ChatManager` and injected before recent exact messages;
it is not exposed as a normal chat message. Anthropic chats never use
`chat_compactions`: their history starts at the newest assistant row whose
stored content begins with a server compaction block.

`ChatManager` is the normal direct-chat persistence service. It verifies or
creates the owned chat for the current user/anima, fetches visible chat
history plus any active compaction summary for each turn, records user and
assistant messages with incrementing per-chat `turn` values, and increments chat
usage totals in the same unit of work as message persistence. Non-incognito
direct-chat turns also merge the latest memory-context manifest into chat
metadata in that transaction. Incognito turns skip durable message writes, chat
usage updates, and chat metadata updates.
Providers return text, usage, tool-call metadata, and structured data; they
should not create chats or write messages directly.

When a provider returns multiple assistant rows for one turn,
`ChatManager` persists them in reserved turn order. For
`OpenAIResponsesHTTPAgent`, only the final payload that should advance the
OpenAI cursor is authoritative for `chats.openai_previous_response_id`; voice
split display rows should not duplicate full raw provider payloads.

Internal or backend-maintenance output is represented as
`chat_messages.internal = true`. `/v1/chats/{chat_id}/messages` hides internal
rows by default and exposes them only with `include_internal=true`.

### Content Assistant

The content assistant's conversations are not Chats. They live in three tables
of their own, with no Anima and no row in `chats` or `chat_messages`, so chat
lists, chat search, memory, episode notes and Reflection never read them
([HTTP API](http-api.md#content-assistant)). `GenerationService`
(`app/generation/service.py`) owns every rule below and filters every read
and write by the owner. Deleting a conversation deletes its messages and
drafts.

`generation_conversations`:

| Column | Notes |
| --- | --- |
| `id` | UUID text, primary key |
| `owner_user_id` | The owner; indexed |
| `title` | The person's first message on one line, cut to 80 characters; empty until they send one |
| `scope` | JSONB: `{"kind": "page"}`, or `{"kind": "creator", "intent", "catalog_item_id"}` for a conversation started in a creator |
| `style_preset` | Nullable text, unused so far |
| `created_at`, `updated_at` | `updated_at` moves with each message, which orders the conversation list |

`generation_messages`:

| Column | Notes |
| --- | --- |
| `id` | UUID text, primary key |
| `conversation_id` | Foreign key, cascading delete; indexed |
| `role` | `user` or `assistant` (CHECK) |
| `text` | The turn's text; empty for a turn that only asked questions |
| `data` | JSONB. The person's turn: `draft_id`, `answers`. The assistant's turn: `run_id`, `outcome` (`draft`, `questions`, `reply`, `failed` or `stopped`), `usage`, and where they apply `draft_id`, `questions`, `error` |
| `created_at` | Wall-clock time of the insert; messages read back in `created_at`, `id` order |

`generation_drafts`:

| Column | Notes |
| --- | --- |
| `id` | UUID text, primary key |
| `conversation_id` | Foreign key, cascading delete; indexed |
| `owner_user_id` | The owner, repeated so a draft is read by id without its conversation |
| `intent` | `gesture` or `reaction` (CHECK) |
| `position` | Order within the conversation: a new draft takes one more than the highest, so a deleted draft leaves a gap unless it was the last |
| `status` | `writing`, `checking`, `repairing`, `reviewing`, `ready`, `warnings` or `failed` (CHECK) |
| `version` | Starts at 1 with no project; grows by one with every stored project |
| `project` | JSONB, nullable: the `animamaActionProject/1.0` document, stored only after server validation |
| `previous_project` | JSONB, nullable: the project from before the person's last revising message, which a restore puts back once |
| `check_report` | JSONB, nullable: the page's bounded report, or `{"unchecked": true}` |
| `checked_version` | The version `check_report` is for; may be older than `version` |
| `repair_count` | Repair passes since the last revision began |
| `failure_reason` | A code, kept only while the status it came with stands |
| `saved_item_id` | The Library item the person saved the draft as |
| `created_at`, `updated_at` | |

A project read back from JSONB has its keys in the database's order, not the
order they were written in. Review frames are never stored: they are held in
the server's memory for one frame review.

### Settings

Settings models store user-level settings and anima-level settings. Anima
settings affect dispatch behavior, including memory influence, memory updates,
emotional analysis, and presentation flags for animation or visual effects.
User preferences may hold `safety.crisis_resource_region` and
`safety.reminder_hours`; malformed values fall back to defaults. Model choices
are catalog row IDs: `chat.default_model_provider_id` (the default for new
Animas) and the role assignments `models.utility_model_provider_id`,
`models.memory_manager_model_provider_id` and
`models.embedding_model_provider_id`. They are validated when used, not when
saved; an unusable ID falls back to the role's default. An ID naming a ChatGPT
plan model that is unavailable (retired at sign-out, or no longer listed for
the account) is the exception: the role resolves to no model and waits rather
than moving its work to another connection, and Utility and the Memory Manager
wait too when they inherit such a waiting chat role
([ADR 0039](../../adr/0039-chatgpt-plan-sign-in-and-connection.md)).

`generation.model_provider_id` is the content assistant's model. It is not a
role: the page sends it with each run, the run route checks it
(`422 generation_model_unusable`), and no default stands in for it
([ADR 0041](../../adr/0041-backend-built-content-assistant-runs.md)).

### Avatar And Uploads

`ORMAvatar` stores Avatar metadata, catalog association, and the shared markdown
`identity` template used as optional creation assistance. Avatar `name` is
unique per owner (`uq_avatar_owner_name`, `UNIQUE NULLS NOT DISTINCT (user_id,
name)`): different owners may reuse a name, and ownerless Included/seeded rows
share one namespace. It is not a live Anima's display name. Catalog
materialization suffixes a colliding name as `<name> (<avatar id>)` only within
the target owner. Avatars can be public catalog avatars or private user avatars.

`catalog_item_id` associates a private Avatar with one validated Local model.
Included Avatar `file_path` values are matched to the corresponding Included
catalog locator. Anima Avatar/loadout choices resolve through catalog items;
there is no Avatar release pin.

Profile/background Appearance choices and Included Avatar portraits are normal
Appearance catalog entries. `ORMAnimaContentBinding` stores their logical
selection and crop/focal configuration. These bindings and the Avatar catalog
model contribute to exact runtime snapshots; presentation changes advance the
Avatar presentation revision without creating a content release.

`ORMAvatarUpload` is the retained staging record for non-content workflows such
as:

- `avatar_vrm`
- `pocket_voice_catalog`

Upload rows include owner, status, opaque local storage locator, file metadata, expiration, and
cleanup state. Valid statuses include `pending`, `finalized`, `aborted`,
`expired`, and `cleanup_pending`.

### User File

`ORMUserFile` stores owner-scoped original file upload metadata for the local
private-file lifecycle. Rows are scoped by the retained `user_id` ownership column and use
backend-generated opaque locators of the form
`user-files/{user_id}/{file_id}/original`, resolved only beneath `data/`.

Fields include:

- opaque local storage locator and display-only original filename
- normalized extension
- declared and detected content type
- declared and stored byte size
- optional SHA-256 placeholder for later processing
- status, upload expiration, processing timestamp, last error, and metadata JSON

Valid statuses are `pending_upload`, `uploaded`, `processing`, `ready`,
`ready_keyword_only`, `aborted`, `failed`, `delete_pending`, and `deleted`.
Current APIs list only non-`deleted` files for the resolved request principal.

`ORMUserFileProcessingJob` is the durable Postgres-backed processing queue. Jobs
store `file_id`, `user_id`, `queued`/`running`/terminal status, attempts,
`run_after`, lease fields, timestamps, last error, and metadata. The server's
upload processing runner claims jobs with row leases. A failure that a retry
cannot fix fails the job at once; others retry up to the configured max
attempts, and a job whose lease expired on its last attempt fails as
interrupted.

`ORMUserFileChunk` stores searchable chunks extracted from uploaded files.
Chunks denormalize `user_id`, keep deterministic `chunk_index` per file, store
text, optional pgvector embedding, character/token estimates, metadata, and
timestamps. A unique `(file_id, chunk_index)` constraint makes reprocessing
replacement idempotent. Keyword search uses PostgreSQL full-text search over
chunk text; semantic search uses chunk embeddings when available.

Vectors are dimensionless (`vector` without a size), so any embeddings model
fits. `embedding_model_id` records the catalog row that embedded the chunk; it
is also set, without a vector, for text that model cannot embed.
`embedding_rejections` counts how often `embedding_rejected_model_id` refused
the text on its own; re-embedding records it without a vector at three and
clears both whenever it stores a result (editing a passage's text clears them
too). `archive_passages` has the same pair.
`embedding_text` stores the contextualized text that was embedded when it
differs from the display text, so re-embedding produces the same vectors as
fresh processing. The `(user_id, embedding_model_id)` index finds chunks that
do not match the owner's Embeddings role. Search compares only vectors from
the current role; other chunks wait for the re-embedding task.

Chunk metadata holds `chunk_type`, the `headings` path, a PDF chunk's `pages`,
and `table_index`, `row_start` and `row_end` for rows of one table (see
[chunking](../features/user-files.md#chunking)). The heading path is prefixed
only to `embedding_text`, which is never returned by public APIs. Chunks that
the retired Docling parser stored keep its compacted keys (`parser`, `chunker`,
`headings`, `captions`, `origin`, `doc_items`, `doc_item_count` and
`token_count`) until their file is reprocessed.

The original-file, chunk, and queue tables are part of the accountless Alembic
baseline. Turning processing off retains those rows, and queued work resumes
when it is turned back on.

`ORMRuntimeWorkerHeartbeat` stores one row per worker kind, with `instance_id`
and UTC `heartbeat_at`. The server's upload processing runner upserts the
`document-processing` row every five seconds and renews only running jobs with
its own `locked_by`. Stopping clears only its own instance's heartbeat, so an
older process cannot erase a replacement's liveness. No provider key, process
path, or local account is stored here. The public capability endpoint compares
the row with the running server's own runner and uses a twenty-second
freshness threshold; queue leases retain their separate timeout.

### Archive

Archive models store anima archive metadata and passages. Passage vectors are
dimensionless, and `archive_passages.embedding_model_id` records the catalog
row that embedded each one. Vector search compares only passages from the
current Embeddings role; while the role is off, passages await re-embedding
or the query cannot be embedded, search falls back to PostgreSQL full-text
search over passage text. Archive
data is distinct from the scoped Markdown memory filesystem.

## Repository And Mapper Pattern

Adapters under `adapters/repositories/` implement repository ports using
SQLAlchemy sessions. Mappers under `adapters/mappers/` convert between ORM rows,
domain dataclasses, and API schemas.

New persistence behavior should usually follow this path:

```text
router schema -> app service -> repository port -> SQLAlchemy adapter -> ORM
```

Use direct ORM access only when maintaining an existing route with direct ORM access and the
change is intentionally local.

## Session And Transaction Scope

HTTP routes that depend on `get_async_session()` get a request-scoped
`AsyncSession`. Application services commit through `SQLAlchemyUnitOfWork` when
they complete a unit of work. Direct chat closes its setup session before
streaming and opens short-lived sessions for persistence and tools. A content
assistant run does the same, and holds no session while it waits for the model
or for the page's check report. Shared model clients must not retain request
sessions.

Background workers create their own engines/session factories and open a fresh
database session per job instead of retaining FastAPI request sessions.

## Ownership And Access

Most owner-scoped rows include `user_id` and should be filtered by the current
`RequestPrincipal`. Avatar rows can be built-in catalog entries or private typed
Avatars. Catalog access uses explicit Included, owner, or installation-shared
scope. Staged uploads must be checked against row ownership, configured root
containment, exact size, and digest before promotion.

## JSON Metadata

Several models store flexible metadata JSON. Use named constants and mappers
where available instead of scattering string keys through route handlers.
Content metadata may contain portable type-specific configuration and safe
provenance; it must not contain absolute paths or delivery capabilities.
Normal `chat:sse` does not read persisted `runtime_graph`, `chat_runtime`, or
`metadata.direct_chat` metadata.

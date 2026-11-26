# Custom Animas And Content

An Anima combines private identity/chat state with logical selections from the
neutral Content Catalog. Its loadout may select an Avatar, Gestures, Reactions
and Appearance, and always holds the Anima's own Idle pool. Gesture and Reaction roots
bring their required VFX and Sound dependencies with them; users do not equip
those supports independently.

A Gesture requires a stable semantic selector and AI-facing description because
the chat model may choose it. A Reaction document may carry a suggested
emotion/intensity placement, while the Anima loadout may add that complete
Reaction Action to the pool of any cell (see [Reaction pools](#reaction-pools)).
Both use `animaPoseClip/2.0` clips;
Gestures may also use VRMA. Event-only clips
are valid, but a clip with neither a track key nor an event is not. A Local
scan lists a clip in another format, such as the retired `animaPoseClip/1.0`,
as invalid with `clip_format_unsupported`, and Save refuses it.

Creator Save writes the ordinary Local source through its typed product route,
such as `PUT /v1/gestures/{entry_name}` or
`PUT /v1/reactions/{entry_name}`. The kind handler strictly validates the same
document used by scan, Preview, runtime, and packages. Typed Preview freezes
the dependency-complete current revision without changing an Anima.

Loadout mutation is a reviewed, family-specific command. The client posts an
intent and expected revision to `/v1/animas/{anima_id}/{family}:plan`, then
commits that exact plan digest with an idempotency key to the matching
`:commit` endpoint. VFX and SFX remain dependencies reached through an Action;
clip sequences are files owned by that Action.
The digest includes the Anima's aggregate revision as well as the loadout and
source revisions: a concurrent name or identity edit invalidates a reviewed
equipment plan. Each successful equipment edit advances aggregate and loadout
revision once; an idempotent replay advances neither.

`GET /v1/animas/{anima_id}/runtime` resolves those logical selections to one
exact internal revision. Handler-owned projectors produce the typed runtime
entries after the generic closure compiler validates graph membership and
files. The service independently omits broken optional roots while keeping
text chat available. `chat:sse` requires the issued revision. Save, filesystem
edits, Rescan, and Equip therefore take effect on the next mount rather than
mid-conversation.

## Idle pool

Every Anima owns one Idle pool ([ADR 0026](../../adr/0026-built-in-idle-pool-per-anima.md)):
a Default pool plus a cell for each tracked emotion at intensities 1–3. Each
member is an `anima_content_bindings` row with kind `gesture` and slot
`idle:<cell>:<catalog_item_id>`, where `<cell>` is `default` or
`<emotion>-<intensity>`. Playback picks Default half the time and, the other
half, the dominant emotion's cells from Mild up to its intensity; neutral, or an
emotion with no Gestures there, uses Default alone, and an empty pool schedules
nothing. The seed lists each Gesture once, in the lowest cell that plays it.
Membership never adds
a Gesture to the AI-invocable list, and a pooled Local Gesture cannot be deleted
until it is removed, like an equipped one.

`POST /v1/animas/{anima_id}/idle:plan|commit` adds a Gesture `source` to one
cell (omit `emotion`/`intensity` for Default) or removes one member by its
`binding_id`, which also works for an unavailable Gesture. An add reads the Gesture's
registered VRMA/clip bytes: repeat playback needs an explicit positive finite
count, and clips with phase/state/run lifetimes are not idle-eligible
(`idle_gesture_ineligible`). Duration overrides cannot repair unknown timelines.
Runtime admits each distinct member as its own root, so one unavailable or
ineligible Gesture is dropped with a diagnostic while the rest keep playing.

The [starter loadout](#starter-loadout)'s `idle` section seeds the pool: it maps the twelve Included
idle Gestures and the five `mixamo-motion` idle loops to Default and emotion
cells, each cell listing only what it adds. Only installed, idle-eligible
Included Gestures are seeded, so an installation without the `mixamo-motion`
source gets the core mapping unchanged. The pool is written once, with the
loadout; installing content later does not change an existing pool. Old
`idle-styles/` folders are not scanned.

## Reaction pools

Every Anima has 96 Reaction cells: each tracked emotion at intensities 1–4
(Mild, Moderate, Strong, Intense). Each cell holds a pool of up to four
distinct Reactions, and a Reaction may sit in any number of cells. Each member
is an `anima_content_bindings` row with kind `reaction` and slot
`reaction:<emotion>-<intensity>:<catalog_item_id>`; the row's catalog item is
authoritative and members carry no binding configuration. Chat plays one member
of the cell named by the turn's emotion and Reaction intensity, chosen at
random without repeating the previous pick; an empty cell plays nothing and
never borrows another cell. A pooled Local Reaction cannot be deleted until it
is removed from every pool.

`POST /v1/animas/{anima_id}/reactions:plan|commit` takes one intent:

- `add` puts a Reaction `source` in the cell named by `emotion` and
  `intensity`. A Reaction already in the cell is refused with
  `reaction_member_duplicate`, a fifth member with `reaction_pool_full`, and a
  missing or non-Reaction source with `loadout_source_unavailable`.
- `remove` deletes one member by its `binding_id`, which also works for an
  unavailable Reaction; an unknown binding is `unchanged`.
- `restore_starter` makes the cell's pool exactly its available Included
  starter Reactions (plan action `revert`). An unavailable starter Reaction is
  skipped with a `starter_reaction_unavailable` plan warning.

An invalid cell is `reaction_cell_invalid`, and any other operation
`reaction_operation_invalid`. A refused intent leaves the revision unchanged.
The loadout lists each cell's `members` (name, availability, source and
`origin`: `starter` for one of the cell's Included starter Reactions) and its
`state`: `empty` without members, `starter` when the members are exactly the
cell's available starter Reactions, otherwise `custom`.

The [starter loadout](#starter-loadout) lists one `reactions` entry per
starter member, so a cell may appear several times; a cell without entries starts empty. New and starter
Animas start from those pools through the creation request; package import
restores exactly the packaged pools. Runtime
admits each distinct pooled Reaction as one root with all its cells, budgeted
after the Avatar, Idle and Gestures from its lowest cell (intensity, then
emotion), so one missing or over-budget Reaction is omitted with a diagnostic
while the others keep playing.

## Live Anima definition

An Anima owns its stable `display_name`, positive `aggregate_revision`, and
SQL-backed virtual `IDENTITY.md` (`kind=anima_identity`). The identity body and
its append-only history remain in `memory_entries`/`memory_entry_versions`.
`anima_definition_revisions` records the name, identity entry/version pointer,
actor, reason, and timestamp without copying the identity body. Chat and
presentation use the live name and identity, never continuing Avatar fallbacks.

`AnimaAggregateMaterializer.materialize` accepts an internal `ResolvedAnimaSpec`
and authenticated owner through one caller-owned `AnimaAggregateUnitOfWork`.
It associates the logical Avatar, writes identity/history and the template
`MEMORIES.md`, defaults/settings, chat profile, and exact typed selections
through `AnimaLoadoutService.initialize`, which locks, reads and writes the
Gestures and Reactions in one batch per family, so its statement count does not
grow with them.
Aggregate, identity, and loadout revisions start at 1. It never commits,
contacts a provider, writes files, or issues runtime. The configured active
model row is checked locally; default ElevenLabs voice is `gJx1vCzNCD1EQHT212Ls`.
Emotion starts neutral, with no archive, chat or greeting. A selected shared
clone adds the typed Voice binding. Relationship memory (`MEMORIES.md`) starts
as the untouched template, meaning no shared history yet. Direct creation and
starter provisioning seed the Idle pool; package import restores the packaged
pool instead. An explicit validated creation voice choice
replaces the default. New browser commands include both provider configurations;
legacy commands may omit voice.

Direct creation and backend starter provisioning use this materializer through
the strict creation service below. Whole-Anima package import uses it inside the
same transaction as its newly copied content. `/animas/new` uses the five-step
live creator and submits the complete reviewed spec through `POST /v1/animas`.

New creation materializes the selected identity into the Anima's own memory
entry. Missing or blank identity requires explicit repair before chat can invoke
a model. The baseline creates this schema directly and provides no
identity backfill for databases outside its supported revision graph.

Explicit identity edits/reverts require both the memory version and aggregate
revision. Name edits advance the aggregate only; Avatar/Appearance/loadout
edits advance aggregate and loadout once. Chat, emotion, relationship memory
(`MEMORIES.md` edits), model selection, and unrelated settings do not advance
the definition. The required `IDENTITY.md` and `MEMORIES.md` files cannot be
renamed, moved or deleted, and an Anima's memory scope holds no other entries;
deleting the Anima permanently removes both.
Content an Anima uses cannot be deleted (see
[Deleting Local content](#deleting-local-content)), and deleting an Anima never
deletes Library content. External file changes may break the next runtime
mount, but cannot change the live name or identity.

## Strict private creation

The [five-step browser creator](../../frontend/features/custom-anima-creation.md)
consumes the current [HTTP creation contract](../architecture/http-api.md#strict-private-creation).
Authenticated
`GET /v1/animas/creation-options` returns policy-derived recommendations/counts,
limits, diagnostics, and source revision evidence. The Idle seed is not part of
the browser spec; the server resolves it when the Anima is created.
`POST /v1/animas:validate` validates a whole `AnimaSpec` without writes.
The optional `voice` field carries `provider`, a Pocket preset ID or pinned clone
reference, and `elevenlabs_voice_id`. Explicit voice choices write speech preferences
and the shared voice loadout binding atomically at revision 1. Clone sources join
the normal owner/kind/revision/dependency checks and must use the Pocket catalog
codec. Presets use the packaged copy of the same release selection as the browser.
Omitted legacy voice fields preserve their original receipt hashes and defaults.
`POST /v1/animas` accepts that spec plus a body `idempotency_key`; the old
Avatar-only direct request is rejected. The browser freezes and durably saves
this exact request before dispatch and restores unknown outcomes before
revalidating mutable sources.

The strict command creates one private live Anima, never a content item.
It includes a required stable display name and Markdown identity, one typed
Avatar, optional profile/background Appearance, exact Gesture selections, all
96 explicit Reaction cells (each a pool of up to four distinct Reactions, empty
allowed), the versioned Recommended Starter Pack identity,
and `expected_source_revisions`. Every selected root and
transitive support is present in that map with kind and SHA-256 revision.
Zero Gestures/all-empty Reaction pools are valid with warnings. Invalid selected
content blocks creation instead of using runtime's optional-root omission.
New creation and explicit live-Anima rename accept 1–40 Unicode code points.
The wider 120-character persistence columns remain unchanged so a legacy long
name stays readable and survives unrelated edits until its owner explicitly
renames it. The browser creator does not configure Appearance: it submits
`profile: null` and `background: null`, while these strict typed fields remain
available to other reviewed backend consumers.

The owner comes from authentication. `AnimaCreationService` writes the
idempotency receipt in the same caller-owned transaction as the materialized
Anima, name/identity history, settings, chat profile, and typed loadout. Catalog
rows and the active model are locked for creation; exact membership, access,
typed semantics, budgets, revisions, and verified source bytes are rechecked
after the receipt write. Validation does not Rescan or mark catalog rows.

An owner-scoped body idempotency key binds only after successful commit.
Identical replay resolves before current-source/default validation; changed
input conflicts, deleted results return 410, and precommit failure leaves no
receipt or partial aggregate. Successful receipts/deletion tombstones remain
for the owner's lifetime. Runtime issue/preparation is a separate post-commit
step, so a mount failure cannot create another Anima.

Review evidence uses a bounded number of requests without weakening those
guards. `POST /v1/content/evidence:resolve` resolves every selected root against one visible catalog snapshot and returns the
complete revision union without files or database writes. The browser rejects
partial results and still calls whole-spec validation; final creation
re-resolves and rechecks the same exact revisions authoritatively.

The separate `POST /v1/content/previews:prepare` operation is only for
playback consumers such as edited Action dependencies. It can issue one
short-lived capability for several overlapping roots, but it cannot create,
validate, equip, or mutate an Anima.

Backend-owned `StarterAnimaSpec` values `starter:annie` and `starter:andrew`
use the same private command through `POST /v1/animas/starters:ensure` with
`{"schema_version":1,"repairs":[]}`. Each starter commits independently, so
retry retains the first result if the second fails. Spec version is metadata,
not the stable owner/starter identity. Successful or deleted slots are never
rewritten by a later spec version.

### Starter loadout

`resources/starter-loadout.v1.json` is the one definition of a starter Anima's
assets: its `gestures`, its `reactions` pool members and its `idle` pool seed.
Starting a loadout copies all three into binding rows from the content
installed then, so later installs and policy edits never change an existing
Anima. Each loadout also stores the policy `version` it started from, which
Reaction `origin`, cell `state` and the cell's `restore_starter` read.
`schema_version` 2 added the `idle` section. The Starter Pack identity in
creation options and drafts is the policy's SHA-256 revision, so any policy
edit makes earlier drafts stale.

A starter Gesture's row uses the semantic key its Included document declares,
which the model selects and packages carry (`air_quotes`, while its content id
ends in `air-quotes`). An Anima's Gestures are exactly its rows: removing one
removes it, and re-adding one is an ordinary add. There are no starter
exclusions or starter-specific Gesture operations
([ADR 0030](../../adr/0030-anima-gestures-are-binding-rows.md)).

Creation and starter provisioning apply the policy through the creation
request. A composition that equips starters without one creates the loadout
with `AnimaLoadoutService.create_starter_loadout`, in the owner's transaction:
it writes a row for each available starter Gesture, the same Idle pool as
creation, and each Reaction cell's available starter Reactions, as
`restore_starter` leaves it. It leaves out an unavailable starter Gesture or
Reaction and returns it as a `starter_gesture_unavailable` or
`starter_reaction_unavailable` diagnostic. It then sets the Avatar and other
selections through ordinary plan/commit changes. The starter step reads, locks
and writes its Gestures and pools in a bounded number of statements and locks
every member until the owner's commit. A composition whose shared catalog rows
(rows with no owner) never change at runtime sets `SHARED_CATALOG_ROWS_IMMUTABLE` from
`content_catalog_repo` to `True` in the session's `info`. The loadout reads
(`get_visible_item` and `get_visible_items`) then lock only owner rows, so
concurrent owners' loadout writes never wait on a shared row; `lock_items` and
reconciliation still lock the rows they name.

Newly provisioned starters use Annie version 3 (`Annie.vrm`, Eve Pocket
voice, ElevenLabs `gJx1vCzNCD1EQHT212Ls`) and Andrew version 1 (`Andrew.vrm`, a university student; Michael
Pocket voice, ElevenLabs `4e32WqNVWRquDa1OcRYZ`), with matching
Included portraits when available.
Their identities write out every section of the `IDENTITY.md` template.
Existing ready/deleted starter receipts are preserved. Automatic adoption
recognizes existing data only for a starter with legacy identifiers (Annie);
Andrew has none, so he is created rather than adopted.

Desktop staging excludes Chibi 2, `AvatarSample_R2`, their derived portraits,
downloaded voice samples, and Tokyo backgrounds/thumbnails.
Existing Animas bound to excluded content need explicit replacement before
moving to a bundle without those bytes; staging never rewrites owner data.

Accountless installation bootstrap calls the owner-scoped ensure command
without explicit repairs. Automatic adoption requires exactly one original Avatar/profile/identity-seed-history
match; it preserves subsequent customization. Missing, partial, or ambiguous
legacy evidence returns `repair_required`, never automatic recreation. Explicit
`adopt` or `create_missing` repairs apply only to those recorded unresolved slots.
Intentional deletion remains a tombstone. Receipt tables retain owner columns
without Better Auth foreign keys and have no live-Anima foreign key, so deleted
result IDs survive.

## Confirmed Avatar and Appearance content

Typed Avatar Save and scanning use the shared strong, self-contained GLB/VRM
validator for VRM 0.0/1.0, with a 100 MiB source limit. Identical model bytes
reuse only a valid caller-owned Local Avatar, preferring the requested path
then stable item ID; existing metadata is not overwritten. Included and other
owners' entries are never reuse candidates. Different-byte name collisions
require explicit rename or revision-checked replace. `creation_context=true`
forbids replacing an Avatar used by a live Anima.

Appearance Save accepts static PNG/JPEG/WebP up to 16 MiB, 8192 pixels on either
side, and 40 million decoded pixels. It rejects animation, SVG, corrupt bytes,
and misleading MIME types, then uses the existing canonical WebP pipeline.
Profile/background framing remains explicit `fit`, focal coordinates, and zoom;
null background creates no binding. `PUT /v1/avatar-content/{item_id}/portrait`
accepts a confirmed 1024-square WebP capture of a Local Avatar and its
expected revision, producing that Avatar's one owner-scoped 512-square
Appearance of at most 256 KiB; saving again replaces it.
Create Anima saves a Local Avatar's portrait through this endpoint in the
background when it is missing or was captured from another revision; it offers no crop, upload or background controls, and
Appearance management remains separate from creation.
Confirmed Saves survive cancellation and failed creation, and neither Save nor
creation calls a provider.

### Face-part corrections

An Avatar may carry an `animama/avatar-face-parts/1` correction of its detected
face skin, irises and optional eye/hair parts. It names glTF primitives as
`node:mesh:primitive` keys and records the model file's `vrm_sha256`, so it
applies only to those exact VRM bytes; a value for other bytes is never
effective. A Local Avatar stores it as `face_parts` in its `.meta.json`
sidecar (an invalid value makes the Avatar invalid with
`avatar_face_parts_invalid`), so saving one creates a new Avatar revision. An
Included Avatar is never written: each owner's correction is a row in
`avatar_face_part_overrides` bound to the Avatar revision it was saved against,
and is ignored, not deleted, once that revision changes.
`GET`/`PUT /v1/avatar-content/{item_id}/face-parts` read and save the effective
value, which also appears as `face_parts` on typed Avatar responses (list, get,
preview and prepared preview batches) and the runtime `avatar`. Packages carry it in the Avatar's portable sidecar; exporting
an Included Avatar, including an Anima's, merges the exporter's current
override, so the imported Local copy keeps it.

### Avatar settings

Each owner may choose three settings per Avatar, wherever it is used:
`spring_mode` (wind and ambient forces on spring bones: `automatic`, `on`,
`off` or `springs_off`), `wind_strength` (a whole percent of the default
wind and updraft, 0–200; 100 is the default) and `material_mode`
(`automatic`, `liltoon` or `simple`). Local and Included Avatars alike store them as one owner-scoped row
in `avatar_setting_overrides`, keyed by Avatar item only; a missing value is
`automatic` (for `wind_strength`, 100). Saving writes no Avatar files, mints no Avatar revision and does
not change any runtime snapshot; clients read the settings separately and apply
them to the loaded Avatar. An Avatar updated in place keeps the owner's
choice; a Local Avatar file that is moved, renamed or re-added becomes a new
item and starts at Automatic.
`GET`/`PUT /v1/avatar-content/{item_id}/settings` read and save them; only the
local composition serves these routes (see the
[HTTP contract](../architecture/http-api.md#avatars-and-uploads)).

The settings table is their only authority. A Local Save strips any
`spring_mode`, `wind_strength` or `material_mode` key from an Avatar sidecar, and a value
hand-written into a Local sidecar is admitted (an invalid one makes the Avatar
invalid with `avatar_setting_invalid`) but never applied. A package is the one
document that carries them: export writes the exporter's stored non-Automatic
values into the Avatar's portable sidecar, replacing any document value, and
they are part of the export review digest. Import writes them into the
importer's table in the same transaction as the new Local Avatar, whose
sidecar omits them. A composition built without the settings store exports
none; on import its review marks the Avatar with the notice
`avatar_setting_not_stored` before the user confirms, and the copy uses
Automatic. The completed import receipt is the same either way.

### Avatar files in packages

Uploads accept any glTF extension, but a package's VRM and VRMA files may use
or require only the extensions in `_GLTF_EXTENSIONS`
(`app/services/content_package_capabilities.py`); any other makes export and
import fail with `package_definition_invalid`. Beside the standard glTF and VRM
extensions the web loaders read (including `VRMC_springBone_extended_collider`,
which `vrm:optimize` keeps), the list holds what converted and optimized
Avatars carry: Mochiya Avatar Tools' `MOCHIYA_avatar_composition` and
`MOCHIYA_materials_liltoon`, Animama Avatar Converter's
`ANIMAMA_avatar_conversion` (MMD conversions), and the `EXT_meshopt_compression` and
`KHR_draco_mesh_compression` mesh compressions. Meshopt Avatars load. The
browser runtime does not serve the Draco decoder yet
(`UNDECODED_GLTF_EXTENSIONS`), so a Draco Avatar imports instead of the package
being refused: the import review marks it `avatar_extension_unsupported` before
the user confirms, and its Diagnostics name the extension (see
[Sharing a converted Avatar](../../frontend/runtime/vrchat-avatar-conversion.md#sharing-a-converted-avatar)).
The web loaders' list plus the undecoded one is exactly `_GLTF_EXTENSIONS`; the
shared `package-capabilities.json` fixture pins both sides. These names need no
package capability, so an install from before they were accepted rejects such a
package with the same generic error.

## Local creation boundary

Create Anima creates a private live companion with editable dependencies.
Separately, [Library sharing](typed-content-and-marketplace.md#local-package-boundary)
can export its saved definition and content as a reviewed `.zip` package.
Import creates a new companion without copying conversations, other memories,
provider settings or a synchronization relationship to the source Anima.

The Library Avatar catalog omits retired shipped model defaults, including rows
retained for historical Anima references. Repeatable database seeding includes
only the two currently shipped VRM models. It removes a retired default only
when its original ID and model path still match, it has no owner or catalog
mapping, and neither an Anima nor an upload references it. Existing selections
are never silently cleared or reassigned.

Avatar catalog `preview_url`, typed Avatar `portrait` and the Anima portrait
fallback use a valid visible portrait registered for the model's exact
`presentation.avatar_item_id` (`app/services/avatar_portraits.py`); generated
portraits record this association and the Avatar revision they were captured
from.
Packaged Included portraits retain the `avatar_model` metadata fallback,
independently of an Anima's custom profile appearance. Missing or invalid portraits leave the URL empty for icon fallback.

## Deleting Local content

`DELETE /v1/content/items/{item_id}?expected_revision=…` deletes one owned Local
item at that exact revision, removing its registered files and catalog identity
in one recoverable mutation. Included and installation-shared items are
read-only and answer 404.

- **In use.** An item an Anima uses, or that other content depends on, is
  refused with 409 `catalog_item_in_use` and `used_by`: at most ten
  `{kind, id, name}` entries, Anima uses first. `anima_avatar`,
  `anima_appearance` (profile or background), `anima_voice`, `anima_gesture`,
  `anima_idle` (an Idle pool member), `anima_reaction` (a Reaction cell member)
  and `anima_music` name the Anima; `content` names the item that depends on
  it. To free the item, change that Anima's selection or delete the dependent
  item first. `GET /v1/content/items/{item_id}/usage` returns the same list
  without changing anything, so a client can show it before Delete; an empty
  list means Delete is not refused as in use.
- **Avatar portraits.** Deleting a Local Avatar also deletes the portrait
  Appearance whose `presentation.avatar_item_id` names it, in the same
  mutation, unless something uses that portrait. A used portrait stays as an
  ordinary Appearance.
- **Stale revision.** An `expected_revision` that is no longer current is
  refused with 409 `catalog_revision_conflict` and the `current_revision`; the
  client refreshes and offers the delete again.
- **Changed files.** If a registered file changed, vanished or became a link
  since the last scan, nothing is deleted and the refusal is 409
  `catalog_item_changed`. Local is rescanned before the refusal returns, so its
  `current_revision` and the catalog describe the files as they are now, and a
  retry with that revision acts on them. A `missing` item keeps its last
  revision; deleting it removes only its catalog row, never files the scan did
  not attribute to it.
- **No revision.** Every kind, including an invalid entry, registers at least
  its descriptor or primary file and so has a revision. Only an entry none of
  whose files could be read (for example, because of file permissions) has a
  null `revision_sha256`, and it cannot be deleted from the app: fix or remove
  the file on disk, then Rescan.

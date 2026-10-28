# Typed Content and Local Packages

Animama models runtime media as concrete product types: Avatars, Gestures,
Reactions, Particle Effects, Avatar Effects, Scene Effects, Sound Effects,
Appearance Images, voices, and static Poses. All types
share one neutral Content Catalog while keeping strict versioned documents,
handlers, APIs, and runtime projectors. The `anima` catalog kind is
reserved and rejecting; live Animas are private application aggregates, not
catalog items. Blueprint is not an admitted catalog kind.

## Editable catalog model

Included and Local files are indexed by `content_catalog_items`,
`content_catalog_files`, and `content_catalog_dependencies`. `source` is
`included` or `local`; access scope is a separate field. Creator Save edits an
ordinary Local file or entry-named descriptor directly and records a new
catalog revision. It does not create an immutable release.

Simple leaf entries may stand alone, such as `.vrm`, audio, or self-describing
JSON. Gesture and Reaction creator output always uses an Action folder:
`<entry>.meta.json` is the typed product document and `<entry>.json` or
`<entry>.vrma` is the playable Pose Clip or animation. Action-owned Pose Clips
are files, not separate catalog dependencies. Action documents can declare exact logical
dependencies on independently reusable Particle, Avatar, and Scene Effects
plus Sounds. The runtime compiler resolves the complete closure and rejects
missing, wrong-kind, ambiguous, cyclic, or over-budget roots.

The catalog persists generic identity, file/digest registrations, normalized
dependency edges, status, provenance, and a bounded search projection. Product
meaning is parsed into framework-neutral `*DocumentV1` values by the closed
typed-handler registry; application services do not interpret arbitrary
catalog metadata dictionaries. Scan, Save, manual admission, Preview, runtime,
export, and import all call the same handler for a kind.

Included content follows the same catalog contract but is read-only and
ownerless. There is no separate code-shipped runtime catalog for playable
bytes. Browser-engine/application resources remain outside typed content where
appropriate. When an application update removes an Included item, reconciliation
retains an internal missing tombstone for stable identity but does not expose it
as a user-repairable Library item or content-health issue.

Music and standalone catalog Pose Clips are retained only for local recovery.
Startup and Rescan remove active Music bindings, retaining prior binding
evidence under private operation storage. An Action that still references a
retired Pose Clip (always `animaPoseClip/1.0`) is listed invalid with
`clip_format_unsupported`. Retired rows cannot be selected, previewed,
newly saved, packaged or admitted to runtime. Exact completed Save/import and Music equipment-commit retries
replay their stored result; no legacy package migration is supported. Static
Poses, Action clip JSON and TTS/SFX remain supported.

## Account-owned content composition

The same catalog, Save and package use cases can run over an account-owned byte
store. Construct `ContentCatalogService` with a catalog and store declaring the
same server-resolved `owner_id`, plus explicit `ContentMutations` and
`ContentPublication` adapters. The service rejects a different caller before
catalog access or receipt replay. Every adapter operation without an owner
argument, including locator lookup, locks and invalidation, still belongs to
that bound namespace. Two owners may use identical readable locators; those
locators are neither object keys nor host paths. Included content remains
ownerless and read-only.

`ContentMutations` owns atomic byte visibility, catalog writes and the durable
operation receipt. A failed publication exposes none of the closure; an unknown
commit outcome is resolved from the receipt. Retries return its original result
before consulting expired or missing temporary stages. Cancellation must finish
owned work and release resources before propagating. `ContentPublication.refresh`
admits verified projections inside that transaction without requiring a filesystem
scan. The default local composition continues to use its existing scanner,
filesystem journals, source locks and compensation. Its installation-wide SQL
catalog is not an account catalog; storage-key prefixes alone do not change that.

Construct `ContentPackageService` with explicit `PackageStages` and
`PackageInspector` adapters for an account composition. Leases expose streams,
bounded reservations, immutable review metadata and cleanup exclusion. The
inspector owns its bounded resources until publication finishes and must enforce
all existing archive, member, hash, typed-document, capability and runtime
validation rules. `TemporaryPackageInspector` provides the canonical validator
for opaque stage streams using an owned, bounded temporary tree. It verifies
sealed bytes while copying, checks archive and expansion limits, and cleans the
tree on success or failure. It imports no installation composition. Prepared imports reopen
verified resources one at a time; they do not require object keys to masquerade
as paths. Export callers use `exports.download` and close its lease after the
response. `get_export`/`exports.cached` retain their local-path compatibility
contract and are not the account download API.

A composition may set `allow_anima_import=False` to reject Anima-bearing package
reviews and commits before installing any dependencies. Policy denial releases
the temporary archive and stage reservation after inspection closes, unless the
publication coordinator still has an unresolved operation that needs recovery.
Ordinary content imports
and exports remain available. Avatar registration and full Anima import, when
enabled, still require the aggregate unit of work to share the publication
transaction; it must not commit independently.

The standalone `scripts/repository-boundary/consumers/content.py` fixture exercises
these services with opaque memory adapters and can run against an installed wheel
outside this checkout. It covers owner isolation, actual package bytes, conflicts,
rollback, receipt recovery, cancellation and cleanup. It runs both a narrow
memory-only Gesture inspector and the production temporary inspector over the
same opaque persistent store. The narrow inspector is only a test adapter.

## Product APIs

The infrastructure surface remains neutral:

```text
GET    /v1/content/catalog
GET    /v1/content/items/{item_id}
POST   /v1/content:rescan
DELETE /v1/content/items/{item_id}
GET    /v1/content/files/{file_ref}
GET    /v1/content/files/{file_ref}/sha256/{sha256}
```

Product List/Get/Save/Preview uses one typed route family for each admitted
kind:

```text
GET    /v1/{typed-family}
GET    /v1/{typed-family}/{item_id}
PUT    /v1/{typed-family}/{entry_name}
POST   /v1/{typed-family}/{item_id}:preview
```

The family response is a generated discriminated contract such as
`PyGesture`, `PyReaction`, `PyPose`, `PyParticleEffect`, or `PySoundEffect`,
not a semantic `metadata` dictionary. Typed routers delegate
safe paths, optimistic catalog revisions, atomic replacement, reconciliation,
and preview freezing to shared catalog services; they do not own parallel
release/upload persistence. Browser history and request bodies never carry
host paths or delivery capabilities.

Typed Preview file descriptors carry two deliberately different identities:
an opaque `file_ref` authorizes delivery, while `logical_path` is the portable,
item-relative name used inside manifests and effect definitions (for example
`textures/heart.png`). The API never exposes the host path. A preview closure
keeps both values for every root and support file so the frontend can resolve
nested VFX/SFX resources without guessing from closure-wide ordinals or
duplicate basenames.

Avatar and Scene Effect definitions contain bounded renderer configuration and
logical local filenames only. External/data/Blob URLs, scripts, shaders, and
arbitrary model selectors are rejected. A parent action's reference map binds
local event aliases to resolved support items so similarly named resources
cannot be substituted globally.

Avatar Effect Save applies the package export rules
(`validate_avatar_effect_document`), so every saved effect can be exported.
A rejected definition returns 422 with
`{"code": "content_invalid", "reason": "avatar_effect_definition_invalid",
"message": …, "field": "definition.<json path>"}`; other document errors carry
the same `message` and, when known, `field`. Gesture and Reaction Save checks
each `avatar_vfx` event's override against the effect it names, when that
effect is visible: the definition the use plays must be valid, or Save returns
reason `action_effect_override_invalid` with `field`
`event.<event id>.override.<json path>`. Package import and export apply the
same check with `package_definition_invalid`.

## Anima loadout and runtime

`AnimaLoadoutService` and `AnimaRuntimeService` are transactional SQL aggregates,
with direct joins across catalog, binding, receipt and snapshot tables. They
receive the composition's session; the internal SQL catalog supplies visible
item reads and runtime invalidation, not the account mutation/locator boundary
described above. An account composition must bind the entire transaction to the
authenticated owner and enforce row security on every joined table, preserve
Included immutability during invalidation, and retain the outer transaction's
commit/rollback authority. Injecting only a catalog or private byte store does
not isolate those joins. Runtime file authorization also rechecks item ownership
and the issued revision before returning a canonical byte descriptor.

`GET /v1/animas/{anima_id}/loadout` returns the typed aggregate. Each family
changes through `POST /v1/animas/{anima_id}/{family}:plan` and its matching
`:commit`, with an expected revision, reviewed plan digest, and idempotency
key. Gesture semantic keys are unique. Each Reaction binding is one member of
one emotion/intensity cell's pool (up to four per cell), and any Reaction Action
may join any cell's pool. A Reaction descriptor may omit `placement_hint`; when
present, it must supply both a tracked emotion and intensity 1, 2, 3, or 4. This
is only a suggested default: saving, previewing and packaging do not require it,
while equipping still names a cell. Unplaced typed responses have null `emotion`
and `intensity`. The Idle pool holds finite Gestures per cell and is never
AI-callable; Avatar, Appearance, and voice keep focused selection rules. Effects and Sounds remain
compiler-managed dependencies rather than independent Anima equipment.

`GET /v1/animas/{anima_id}/runtime` compiles current selections into an exact
internal runtime revision with a complete bounded map of admitted catalog-item
revisions and canonical catalog file descriptors. Chat requests carry that
revision so AI-visible Gesture selectors and frontend playback cannot drift
during one mount. Runtime delivery authorizes each canonical file through its
pinned parent item without per-snapshot file rows. A later Save or Equip is
adopted only after remount.

## Local package boundary

Packages use the strict `animama-content-package/3` manifest in local `.zip`
files. Content export accepts one or more Avatars, Gestures, Reactions, static
Poses, effects or Sounds and includes their complete required
closure. Avatar portraits and selected Anima profile/background images travel
as associated Appearance content; Appearance is not a standalone export root.
Music and standalone catalog Clips are not package types. Voice is allowed only
as the active saved PocketTTS clone referenced by a complete Anima.

An Anima export reads the saved name, full identity, Avatar, effective Gesture
selections and semantic keys, all 96 Reaction cells as pools of Reaction
entries (including empty cells),
the Idle pool (Default and non-empty cells of Gesture entries), and
profile/background images with framing. Supported
binding configuration and effective starter choices are preserved. Missing
selected content or unsupported configuration fails export rather than silently
changing the definition. Conversations, identity history, other memories,
private uploads, model/provider settings and voice preferences are excluded.
Import creates a new private Anima using the receiver's defaults for those settings.
The exception is an active saved PocketTTS clone: its encoded neutral catalog is
bundled without the original recording, installed as an independent Local Voice
and selected with fresh PocketTTS preferences. Presets, inactive clones and
ElevenLabs IDs do not travel. The `animama/pocket-voice/1` capability requires
validated binary contents; standalone Voice entries and raw recordings reject.
A Gesture or Reaction clip requires `animaPoseClip/2.0`, plus
`animama/builtin-pose/1/<id>` for its base pose, if any. A reader without a
required capability rejects the package. A package that declares `animaPoseClip/1.0`, or
contains a clip in any format other than 2.0, is refused with
`clip_format_unsupported` and a fixed message naming the retired format.
Effective provider changes invalidate a pending export review.

Export summary resolves source revisions and saved facts; preparation requires
the returned digest and rechecks them before sealing the reviewed archive.
The writer and reader share strict manifest, capability, typed-content and
runtime-budget validation. Portable entry references carry no owner, catalog,
file-delivery or host-path authority.

Import reviews the whole package and allocates fresh identities for every entry,
including dependencies already present with identical bytes. Names use automatic
`-2`, `-3` suffixes when needed, including collisions with Included content.
Commit rechecks the sealed bytes, destinations and receiver prerequisites,
then installs all files, catalog rows and any Anima aggregate in one recoverable
operation. A changed destination requires a fresh review; import never replaces
an existing item or installs only part of the package. License and provenance
facts accompany the independent editable copies.

### Non-portable content

[Non-portable](../architecture/local-content-storage.md) items never enter a
package. Content export refuses a non-portable root, and any non-portable item
reached other than through an effect's optional sound, with
`package_non_portable` and the item names in `detail.items`. A built-in effect exports
without its optional non-portable sound: the edge and the `soundAlias` naming it
are removed, kept optional edges are written as ordinary edges, and no reference
is recorded. An Anima export omits non-portable Gestures, whether equipped or in
the Idle pool. Any other
non-portable binding (for example an Avatar) blocks the export. The summary lists
omitted items (`omitted`), and the manifest's `non_portable_references` record
each omitted Gesture's logical key, name and uses (a `gesture` slot with its
selector and config, or the `idle` pools it was removed from), with the
`animama/non-portable-references/1` capability. Packages without references omit the field and stay readable by
earlier versions.

On import, the review lists each reference as `rebound` when this installation
has a valid non-portable Included item with the same kind and logical key, or
`unavailable` otherwise. Rebound items return to their Anima slot or Idle
pools. Unavailable ones are left out: the Gesture is not equipped, and its Idle
cells keep their other Gestures. Import and typed save reject any file whose SHA-256 matches a
non-portable payload (`package_non_portable`, `content_non_portable`) without
echoing its contents. Matching files added to the Local folder by hand are
scanned as non-portable instead.

Local content never uses optional edges or non-portable Sound Effects. Catalog
reconciliation marks such Local items invalid (`dependency_optional_not_allowed`,
`non_portable_dependency`), so typed save fails with
`content_optional_dependency` or `content_non_portable_dependency` and rolls
back, and package inspection refuses an entry that declares an optional edge
(`package_optional_dependency`). Import gives every entry a fresh Local
identity, so an imported copy of a built-in effect is a Local effect without
the licensed sound, even where this installation has the pack.

### Actions that use a removed Included effect

A Local Gesture or Reaction that names a removed Included effect stays valid
and plays without it ([data model](../architecture/data-model.md)). Item and
Anima export refuse it, and anything that includes it, with
`package_dependency_missing` and the item names in `detail.items`, until its
creator maps or removes those events. A Save or package import that would
admit such an Action is refused (`saved_content_invalid` with field
`dependencies`, `package_catalog_admission_failed`): only Actions saved before
the removal outlive it.

### Scene Effects with a Twemoji item

A Local Scene Effect saved with an `emoji` item (Animama no longer provides
Twemoji) stays valid, plays without the item and is listed in Content Health
with a `scene_emoji_item_removed` diagnostic per item
([data model](../architecture/data-model.md)). Item and Anima export refuse it,
and anything that includes it, with `scene_emoji_item_removed` and the item
names in `detail.items`, until its creator replaces or removes those items.
Package import refuses an emoji item, or a declared `animama/twemoji/…`
capability, with the same code; Save refuses it as `saved_content_invalid`
with the item as `field`.

Resource filenames inside a content directory stay unchanged so embedded image
and texture references remain valid when the containing item receives a collision
suffix. Avatar imports also register the logical model used by Library and Anima
creation, even for content-only packages. Deleting an unused Local model removes
that mapping; an Anima using the model still blocks deletion.

See the [package HTTP contract](../architecture/http-api.md#package-sharing) for
routes, limits and receipt recovery, and [Library sharing](../../frontend/features/library.md#import--export)
for the user workflow. Package manifests exist only at the sharing boundary,
not in everyday Local folders.

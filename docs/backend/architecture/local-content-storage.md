# Self-Hosted Content Storage And Trust

> The migration-generated
> installation principal owns local data. FastAPI admits browser traffic at
> the configured application origin; desktop adds a per-launch capability.
> React starts without user credentials. Coordinated backups preserve the principal.

This is the architecture contract for Animama's readable Included/Local
library, private data, neutral Content Catalog, previews, packages, and mounted
runtime delivery.

## Deployment boundary

The built Docker composition publishes FastAPI on loopback to serve React and
the API. Development publishes Vite, which proxies a closed application route
set to private FastAPI; PostgreSQL and optional workers stay private. Unpackaged
Electron may open that application origin. The embedded macOS runtime supervises
its own PostgreSQL, FastAPI and cleanup worker, with FastAPI serving packaged
web files on the saved origin. Signed release acceptance remains separate.
Browser and Electron renderers receive no arbitrary host filesystem access.

FastAPI is the shared local application core. It scans and validates readable
content, persists logical identity and access scope, performs safe writes,
resolves dependencies, compiles exact runtime closures, and returns registered
bytes. It never exposes an absolute host path or redirects the browser to an
object store.

## Trust boundary

The local composition is single-owner and loopback-only. FastAPI validates
Host, Origin, browser metadata and mutation CSRF markers. Desktop additionally
requires its renderer capability; private controls use a distinct token. The
principal comes from completed bootstrap, never an identity header. There is
no built-in network or multi-account mode. Remote self-hosting requires TLS and
authentication in an operator-owned VPN, tunnel or reverse proxy before the
application; every admitted request still acts as the one installation owner.

## Readable filesystem contract

```text
content/
  included/                   read-only application content
    avatars/
    gestures/
    poses/
    reactions/
    vfx/{particle,avatar,scene}/
    sfx/
    appearances/
    voices/
    animas/
    licenses/
  local/                      editable creator/import/operator content
    <the same typed roots except licenses>
data/
  user-files/
  staging/{uploads,imports,exports}/
  internal/{operations,runtime,derivatives,reconciliation}/
```

A simple self-describing leaf file is one entry, such as `avatars/mika.vrm` or
`sfx/chime.wav`. Creator-managed Actions use stable product
folders even when their implementation is one file:

```text
gestures/wave/
  wave.meta.json
  wave.vrma

reactions/happy/
  happy.json
  happy.meta.json
```

The `.meta.json` file is the typed Action control document; the `.json` file is
the actual `animaPoseClip/2.0` sequence owned by that
Action. Independently reusable VFX and
SFX remain typed dependencies and are included through the runtime/package
closure.

Old `pose-clips/` and `music/` files remain on disk for recovery and do not
appear as supported Library content. Retired Pose Clips were `animaPoseClip/1.0`,
so a Local Action whose motion still references one is listed invalid with
`clip_format_unsupported` rather than converted. Startup and Rescan preserve
originals and prior binding facts under `data/internal/operations/transitions/`
before removing Music bindings. A failed transition retains its evidence and
reports a diagnostic instead of discarding content.

Local Avatar Effects with an `animama/avatar-effect/1` definition convert to
`/2` in place in the same transition (`AvatarEffectTransitionService`): only
`definition` changes, the folder, content ID and files stay, and the original
bytes are retained first. A definition that cannot convert leaves the item
invalid with `avatar_effect_conversion_failed`. Descriptor folders outside the
Local library, such as Included content, convert with
`uv run python scripts/content/convert_avatar_effects.py --write <folder>`;
without `--write` it only reports. After conversion `/1` is refused at Save,
preview, loadout and package import with `avatar_effect_conversion_required`.
A `/1` package cannot be converted in place, because its manifest, sizes and
digests cover the original bytes; the import hint asks for the source content
to be converted and the package exported again.

Local Gestures and Reactions that name an Included Avatar Effect removed by
the 2026-10-14 merge ([ADR 0025](../../adr/0025-per-use-avatar-effect-overrides.md))
are rewritten in place in the same transition
(`AvatarEffectMergeTransitionService`): the dependency names the family
effect, and each event carries the override and sound that reproduce the
removed effect, from `resources/avatar-effect-merges.json`. The folder,
content ID and other files stay, and the original bytes are retained first. An
Action that cannot be rewritten stays as it was and plays without the removed
effect; the failure is logged.

Standalone Poses use `poses/<entry>/<entry>.json`: a `pose` descriptor containing
one resolved `animaPose/1.0` payload with matching identity and name. Admission
rejects parent references, unknown bones, invalid transforms and expression
weights. The descriptor is bounded to 1 MB and has no dependent files. Included
starter poses and Local editor saves use this same contract; the browser stores
only transient pose edits. Poses can be previewed and packaged, but cannot be
equipped in an Anima loadout.

Package manifests are created only during export/import. Internal snapshots
and staging live under `data/`.

Embedded desktop keeps this writable Local/private layout under Electron's
user-data directory, but mounts Included separately from immutable application
resources. `ANIMAMA_INCLUDED_CONTENT_SOURCES_JSON` supplies ordered
`{id, version, root, pack_id}` records, core first, and
`ANIMAMA_LOCAL_CONTENT_ROOT` supplies the writable Local root. Non-core sources
use `pack_id` `expanded-included-content` or a private pack (`mixamo-motion`,
`wow-comedy-sfx`). Each source has its own `licenses/inventory.json`. An entry
is non-portable when a rule in its own source's inventory sets
`"distribution": "non-portable"` (any unrecognised value also counts), or when
any of its files matches a hash in a private pack manifest or the vendor preview
deny list under `animama/resources/` (`RESTRICTED_RESOURCES` in
`content_portability.py`), wherever it is stored. A packaged source's inventory
may also record `derivatives`: effect art that packaging re-encoded as WebP
(`runtime/included_derivatives.py`). Each derivative is matched against the
rules by its PNG master's path, so it keeps its master's licence and
distribution. The Included scan drops a
built-in effect's optional sound edge when that sound isn't mounted
([ADR 0022](../../adr/0022-optional-licensed-effect-sounds.md)). When a pack is
unmounted, Included dependency edges are rebuilt rather than blocking the
withdrawal; Local items, bindings and leases still block it. The
scanner records the result in `provenance.distribution` after merging
descriptor metadata, so descriptors cannot set or clear it, and catalog
responses expose it as `portability`. Startup transitions never copy
non-portable bytes into Local content. The backend
never creates or write-probes an Included mount, rejects cross-source logical,
file, case, and Unicode collisions, and watches only Local. Each catalog item
and preview file retains its exact `source_mount_id`. Bytes are delivered only
from that mounted source; the browser cannot supply a root. Removing an optional
mount requires reference/lease checks and atomic catalog withdrawal, not missing
core tombstones. Electron downloads, verifies and atomically activates optional
packs; public pack/signature acceptance requires approved release inputs. See [Desktop operations](../operations/desktop-runtime.md) for
roots, private environment, lifecycle and recovery. Compose's coordinated
backup/reset scripts do not apply to the separate desktop profile or vault.

## Typed handlers, scanner, and neutral catalog

`domain/content_documents.py` defines the framework-neutral, schema-versioned
Gesture, Reaction, Pose, Effect, Sound, Avatar, Appearance, and
portable voice documents, plus private legacy decoders for stored Music and clip rows. `content_kind_registry.py` is a
closed registry with one handler for every scannable kind. Each handler owns
strict parsing, bounded media validation, dependency legality, canonical file
roles, searchable projection, runtime projection, and package-reference
rewriting. Random files never become executable content. `animas/` remains a
reserved rejecting lane; live Animas are not catalog content.

An authoritative scan walks only registered roots without following symlinks,
parses standalone files/sidecars/descriptors, rejects traversal, links, special
files, case collisions, malformed input and exceeded bounds, hashes every
admitted file, resolves declared dependencies, and reconciles the source into
PostgreSQL. Before invalidating Local entries, the watcher takes the same source
transaction fence as Save and checks a fresh bounded source scan against the
admitted catalog revisions. Delayed notifications for identical, valid entries
do not undo a successful Save. Changed or missing bytes, invalid membership,
duplicate logical identities and unknown scan/recovery state still fence affected
entries and their dependents as `scan_required`. Included notifications retain
unconditional invalidation, including license changes. An authoritative scan
after the quiet window admits genuine changes. This correctness check adds one
Local source scan per coalesced watcher batch; it does not skip external events
or introduce a timed suppression window. The watcher ignores hidden paths that
scans never read, such as mutation staging and backups under
`.animama-mutations`; `.animama-operation` markers still notify. Startup, `reset.sh`, and
`POST /v1/content:rescan` use that same reconciliation path. Every scan recovers
unfinished Local mutations under the source transaction lock before admitting
files; bootstrap therefore never scans an interrupted publication first.

The core tables are:

- `content_catalog_items`: logical identity, Included/Local source, access
  scope, optional owner, kind, readable relative locator, status, revision,
  metadata, provenance, diagnostics, and scan timestamps;
- `content_catalog_files`: opaque `file_ref`, item-relative path, role, media
  type, size, digest, and ordinal;
- `content_catalog_dependencies`: declared reference and resolved target;
- `content_mutation_receipts`: owner/operation identity, complete request digest,
  and immutable original success result, retained independently of item deletion;
- `content_previews` and `content_preview_files`: short-lived exact preview
  memberships;
- `anima_loadouts`: one optimistic revision root per live Anima;
- `anima_content_bindings`: typed logical Avatar, Gesture, Reaction, Idle pool,
  Appearance, and voice selections resolved at remount;
- `anima_loadout_mutation_receipts`: bounded idempotent commit results;
- `anima_loadout_diagnostics`: warnings for rejected persisted or manually
  invalid equipment.

No table stores absolute paths. Included and Local are source enum values,
not separate application-domain models.

## Direct Save and deletion

`LocalContentMutations` owns Save, Delete, Import, and Rescan coordination over
one catalog/store pair. A Local source transaction lock spans file promotion,
reconciliation, ownership/provenance changes, and the durable success receipt.
Catalog writes flush within that scope; only its owner commits. A failed
mutation rolls back catalog changes and restores journaled files. Recovery uses
the database receipt to distinguish committed work from work to restore.

A Save's entry name comes from the display name: lowercase, hyphenated ASCII
(`Heart Hands` → `heart-hands`). Accents fold away, so `Café` and `Cafe` share
`cafe`. A name in another script keeps a short hash of the name, so different
names in that script get different entries (`お辞儀` → `item-0f2f10u`); package
import paths do the same (`content-<hash>`). The web app derives Gesture
semantic keys and Local logical keys with the same hash
(`app/services/content_names.py`, `web/src/lib/content/nameIdentifiers.ts`), and
`src/frontend/web/src/lib/content/fixtures/name-identifiers.json` pins both
sides. The display name itself is stored unchanged.

Standalone Save streams a bounded upload to an adjacent temporary file,
validates it through the target kind's handler, fsyncs, and atomically replaces
the normal Local file. Descriptor Save validates the typed document and every
companion file and publishes the entry-named descriptor last. Save and Delete
retain recoverable originals, as Import does. Private filesystem journals live
under `data/internal/operations`; originals stay in
`content/local/.animama-mutations` so restoration remains on the same filesystem.
They are recovery evidence, not selectable content or disposable caches.

For Save and Import, retrying the same owner-scoped operation ID and complete
request returns its original successful result before checking current items
or revisions. It never
rewrites files, even after a subsequent edit or deletion. Reusing that ID for a
different request returns `operation_id_reused`; a new operation needs a new ID.
The original response can describe an item that has since changed or disappeared.
Delete uses an internally generated operation ID for recovery; its HTTP contract
does not accept a retry key or promise success for a repeated deletion.

Avatar Save and scan use the shared structural VRM 0.0/1.0 validator (100 MiB
source, 16 MiB glTF JSON, bounded humanoid/buffers/accessors, no external
resources). Identical model bytes reuse only a valid caller-owned Local item,
without replacing its metadata; an Included or foreign copy never qualifies.
Name collisions with different bytes require explicit rename or expected-revision
replacement. A wizard Save with `creation_context=true` cannot replace an
Avatar used by any live Anima. Destination and owner/digest locks coordinate
concurrent Saves. A new Local item receives the installation owner in the same
reconciliation commit, never temporarily as shared content during a concurrent
scan. Package provenance is published in that same transaction.

Static Appearance inputs are PNG/JPEG/WebP, bounded to 16 MiB, 8192 per side,
and 40 million pixels. Save canonicalizes them to WebP; framing stays on the
live binding. The Avatar portrait Save endpoint admits a 1024-square browser
capture as a Local Avatar's one ordinary 512-square owned Appearance, replaced
in place on the next save. Confirmed content persists
after cancelled/failed Anima creation. Creation itself writes only SQL state;
its receipt and aggregate are atomic, and its exact source evidence never
becomes a durable runtime mount or an additional copy of the files.

Save updates an editable catalog item in place. It does not create a release,
auto-equip content, or mutate an active chat. Delete requires the expected
revision and targets only an owned Local entry; Included remains read-only.
Explicit API deletion removes both the registered files and that catalog
identity, so a following exact GET returns 404. A manual host-file removal is
different: reconciliation retains its `missing` tombstone for repair. Content
in use, an Avatar's portrait and files changed on disk follow
[Deleting Local content](../features/custom-animas-and-content.md#deleting-local-content).

Direct Save error details use stable `code` values and may include a canonical
`field` when one creator control is unambiguously responsible. Name validation
and destination collisions target `name`; empty, oversized, duplicate, or
unsupported primary/companion files target `files`. Revision conflicts,
missing items, typed validation failures, and other ambiguous failures omit the
field so clients keep them at the document level rather than highlighting a
misleading control.

Manual host edits bypass operation receipts. They are inert until scan and can
make the item invalid, missing, or scan-required. Reconciliation never silently
substitutes another entry.

If restoring an uncommitted mutation finds later changes to its bytes, it returns
`content_recovery_conflict`, preserves the current files and original backups,
and refuses admission or further mutations until the conflict is repaired. It
never silently overwrites the operator's later edits. See
[recovery instructions](../operations/development.md#custom-roots-permissions-and-disk-full)
before touching journals or backups.

## HTTP surface

```text
GET    /v1/content/catalog
GET    /v1/content/items/{item_id}
GET    /v1/content/items/{item_id}/usage
POST   /v1/content:rescan
DELETE /v1/content/items/{item_id}?expected_revision=...
POST   /v1/content/evidence:resolve
POST   /v1/content/previews:prepare
GET    /v1/content/files/{file_ref}
GET    /v1/content/files/{file_ref}/sha256/{sha256}
GET    /v1/content/previews/{preview_id}/revisions/{revision}/files/{file_ref}

GET    /v1/{typed-family}
GET    /v1/{typed-family}/{item_id}
PUT    /v1/{typed-family}/{entry_name}
POST   /v1/{typed-family}/{item_id}:preview

GET    /v1/animas/{anima_id}/loadout
POST   /v1/animas/{anima_id}/{family}:plan
POST   /v1/animas/{anima_id}/{family}:commit
GET    /v1/animas/{anima_id}/runtime
POST   /v1/animas/{anima_id}/runtime/revisions/{revision}:renew
GET    /v1/animas/{anima_id}/runtime/revisions/{revision}/files/{file_ref}
```

Typed families are `gestures`, `reactions`, `poses`,
`particle-effects`, `avatar-effects`, `scene-effects`, `sound-effects`,
`avatar-content`, `appearance-content`, and
`voice-content`. `/v1/content` is deliberately infrastructure-only; it no
longer accepts a generic semantic Save or Preview contract.

Registered-byte routes resolve the admitted installation principal first, verify visibility/membership,
resolve the safe relative locator inside its configured root, reject links and
non-regular files, and recheck exact size and SHA-256 before streaming. They
accept no path. Digest ETags are evaluated after authorization and integrity
checks. Local delivery uses private revalidation, except runtime revision members,
complete binary bundles (ADR 0028) and Included files read at their digest URL
(ADR 0033), which the browser may keep for a year
(`private, max-age=31536000, immutable`); authorization never depends on
browser cache state for any request that reaches the server.

Catalog and typed file descriptors carry each file's `url`. An Included file's
`file_ref` survives a release that changes its bytes, so its URL also names its
digest, `/v1/content/files/{file_ref}/sha256/{sha256}`, and a release that
changes the bytes changes the URL. That route serves only Included files whose
registered digest still matches, and answers anything else, including the old
digest after a release, with `404 content_file_not_found`. Owner and
installation-shared files keep `/v1/content/files/{file_ref}` and its
revalidated policy. Anima presentation images and Avatar portraits follow the
same rule.

Mounted runtime-manifest JSON has gzip/identity content
negotiation. Its full descriptor and current lease remain in each response;
authorization and issuance run even on a conditional request. Wire-specific
ETags and `Vary: Accept-Encoding` distinguish representations, but never turn
an effective content revision into permission to reuse an expired lease.
Registered bytes are not compressed by this policy: size/digest verification and
streaming stay unchanged, and their caching follows the registered-byte policy
above. See the
[HTTP API](http-api.md) for negotiation and metadata details.

Runtime delivery bundles aggregate delivery only; creator files remain individually
editable and retain their catalog refs and revisions. Bundles select small
executable JSON sequences and manifests and small PNG, JPEG and WebP images outside
the Avatar's and voice's closures, Idle members first (limits in the
[HTTP API](http-api.md)). Issuance stores each bundle's member list with the
snapshot. Every request reads only that list from the live owner snapshot,
bulk-authorizes current catalog pins, then reopens and verifies each source file
before considering a 304. JSON text retains original bytes; images keep their exact
bytes in a framed body. One changed file produces an isolated error and
scan-required marking. Complete JSON bundles use private revalidation and gzip,
complete binary bundles the immutable policy;
mixed errors use `no-store`. Bundles create no files, lease extensions,
shared cross-Anima caches, or backup requirements. VRM/VRMA, audio and larger files
retain their individual byte routes.

## Preview, Equip, and runtime

A typed preview parses the current document through its handler, resolves the
dependency-complete closure, and freezes exact file facts for a short
owner-scoped lifetime. The browser's `PreviewByteSession` fetches and verifies
those protected bytes in memory and revokes its object URLs on disposal.

Batch evidence and preview preparation share one multi-root resolver. It loads
the caller-visible catalog once, parses each visible typed item at most once,
memoizes shared subgraphs, and applies runtime entry/byte budgets to the
deduplicated union. Evidence returns only exact revision maps and never touches
`content_previews`. Preview preparation stores one `content_previews` row
anchored to the canonical first successful root and one
`content_preview_files` row per unique `file_ref`; overlapping and repeated
roots do not duplicate memberships. Existing expiry, owner isolation, and
verified-byte delivery rules apply unchanged.

Loadout changes use a family-specific plan followed by an optimistic,
idempotent commit. The commit writes a logical item selection to
`anima_content_bindings` and advances the Anima loadout revision. A Gesture is
unique by effective semantic key. Each Reaction cell (24 emotions at
intensities 1–4) holds a pool of up to four Reactions, one row each, and a
Reaction Action may join any cell regardless of its authored placement hint.
Each Idle cell holds any number of idle-eligible Gestures, one row each, and
Avatar/Appearance/voice use their own single-selection rules. VFX and SFX remain transitive
dependencies and are rejected as direct equipment. No loadout write copies
bytes or hot-swaps an active mount.

Runtime issuance resolves each selected root independently, reopens and hashes
its complete dependency closure (all of a compile's files in one worker-thread
call), deduplicates members, enforces budgets, and
persists one exact internal revision, safe diagnostics, and a bounded map of
every admitted catalog item to its revision. A changed or broken root and its
dependents are omitted; unrelated roots and text chat remain available.
Canonical path, role, media type, size, and digest facts remain registered once
in `content_catalog_files`; runtime issuance does not copy them into per-file
rows. Compilation takes no locks and writes nothing. Files it found changed are
marked for Rescan first; then a short final transaction locks the loadout row,
confirms its revision is the one compiled, and one set-based check proves the
complete item/file union still matches the compiled descriptor before insertion. Issuing an unchanged loadout again renews its unexpired
snapshot after the same checks, without compiling or reopening files (see the
[HTTP API](http-api.md)). Idle playback facts are cached in process by the motion
file's SHA-256 and the Gesture's implementation and settings.

The runtime file route resolves the canonical `file_ref`, its parent item, and
the snapshot pin in one read-only database statement. It rejects expired,
unowned, unpinned, changed, or inaccessible content, then rechecks containment,
size, and digest while opening the file. Only explicit mount/reuse and
`:renew` operations extend leases; fetching a file never writes to the
database.

The frontend fetches every admitted unique byte during mount preparation,
verifies size/digest, and owns Blob URLs/decoded resources until unmount,
sign-out, route replacement, or remount. Playback uses prepared resources and
performs no later typed-content request. There is no application-managed
persistent Cache Storage, IndexedDB, or OPFS library.

## Package boundary

The [local package contract](../features/typed-content-and-marketplace.md#local-package-boundary)
uses `animama-content-package/3`. Export resolves saved authority and exact source
revisions, canonicalizes descriptors and writes immutable reviewed bytes under
`data/staging/exports`. Installation-local references are rewritten to opaque
package entry IDs. The manifest never appears in everyday Local folders.
An Avatar's portable sidecar may carry the exporter's owner settings
(`spring_mode`, `wind_strength`, `material_mode`). Neither Save nor import writes them into a
Local sidecar: Save strips them and import moves them into the importer's
`avatar_setting_overrides` (see
[Avatar settings](../features/custom-animas-and-content.md#avatar-settings)).

Import receives sequential bounded parts directly into one private archive under
`data/staging/imports`. Review seals its hash, validates the complete typed graph
and freezes fresh IDs, collision suffixes, destinations, associations and any
Anima definition. Commit verifies that same archive and plan before publishing
new files without overwriting existing destinations. All catalog rows, provenance,
license facts and the optional Anima aggregate commit in one SQL unit of work,
behind the mutation journal and catalog visibility fence. No partial member
becomes selectable; changed destinations require a fresh review.

Stages and export caches have bounded quotas and leases; see the
[HTTP limits](http-api.md#package-sharing). Temporary-byte expiry or discard never
removes durable operation receipts. Commit and operation-status lookup consult
receipts before requiring a stage, so a lost response can recover the original
result even after expiry, restart, later edits or deletion. Startup recovers or
compensates unfinished mutations before catalog admission. Conflicting manual
edits preserve current files and original backups for operator repair; journals
are not disposable staging data.

## Private data

`ANIMAMA_DATA_ROOT` is private, non-portable storage. Default self-hosting uses
an ignored `data/` directory in the checkout; named stacks and desktop profiles
have their own managed roots.

```text
user-files/                  private chat attachments
staging/uploads/             bounded upload staging
staging/imports/             hostile package validation staging
staging/exports/             generated export staging
internal/operations/         safe-Save operation receipts
internal/runtime/            short-lived runtime state
internal/derivatives/        generated previews, portraits and Gemini voice samples
internal/reconciliation/     scanner bookkeeping
```

Back up durable private data with PostgreSQL and `content/local`. Only a
consistent documented backup procedure may exclude staging or reconstructible
bookkeeping; never discard receipts or attachments as source cleanup.

Chat attachments are not portable content. The authenticated upload route
streams through `data/staging/uploads` and atomically promotes to an opaque
`data/user-files/<user>/<file>/original` locator. Workers read through the
private local-storage port. These files never enter the Content Catalog,
runtime closures, or packages.

## Operations

Normal `reset.sh` preserves PostgreSQL, `content/local`, and `data`; `--purge`
is explicit and stack-scoped. `scripts/backup-local.sh` quiesces application
writes and backs up those three authorities as one unit.
`scripts/restore-local.sh ... --confirm` retains a pre-restore rollback bundle,
restores the three authorities, runs Alembic while application services are
stopped, requires the existing principal, and performs
an authoritative content rescan. Included is restored from the matching
application version. Browser memory, HTTP caches, model caches, downloaded
model assets and environment secrets are not part of the backup.

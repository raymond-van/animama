# Local Content Runtime

> **Accountless local contract:** FastAPI admits private-byte and runtime
> requests at the application origin. Development Vite proxies the same routes
> without granting identity. React has no session or bearer callback.

Web and Electron use the same admitted local HTTP services. A normal
browser cannot enumerate a Docker host directory, and the sandboxed Electron
renderer receives no arbitrary filesystem IPC. FastAPI scans `content/`, owns
safe writes and dependency validation, and streams registered bytes. The
frontend receives catalog metadata and opaque `file_ref` values, never host
paths or a second storage URL.

## Neutral HTTP contract

```text
GET    /v1/content/catalog
GET    /v1/content/items/{item_id}
POST   /v1/content:rescan
DELETE /v1/content/items/{item_id}
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

The catalog contains visible Included, installation-shared, and caller-owned
entries. `source` is `included` or `local`; it is not a separate frontend
domain. Entries carry status, diagnostics, revision, dependencies, and exact
registered files. Rescan validates manual host edits and never equips them.

Creator Save writes through the matching typed product route. Gesture and
Reaction Actions use one readable folder: `<stem>.meta.json` is control data
and `<stem>.json` or `<stem>.vrma` is the playable payload. Action-owned Pose
Clips stay with their owning Action; reusable effects and sounds follow those
Actions. An Anima's Idle pool binds whole Gestures, never their parts. The same closed kind handler validates Save, Rescan, Preview,
runtime projection, and package rewriting. Save does not create a release or
Apply step.
Library/creator health surfaces expose valid, scan-required, invalid, and
missing states with an explicit Rescan. `/v1/content` remains the neutral
health, deletion, package, and byte-delivery boundary rather than a generic
semantic API.

An explicit revision-fenced DELETE removes the owned Local files and catalog
identity, so an exact follow-up GET returns 404. This differs from a manual
host-file removal, whose `missing` catalog tombstone remains visible for repair.
Items still referenced by an Avatar or Anima loadout must be unequipped first.

## Protected preview preparation

`PreviewByteSession` consumes a short-lived `PyContentPreview`. It checks the
declared budget, downloads exact protected files through the application origin,
verifies size and SHA-256, creates in-memory Blob URLs, and revokes them on
disposal. Preview sessions never satisfy a mounted runtime and never write a
persistent browser library.

Each typed preview file preserves both its opaque `file_ref` and its portable,
item-relative `logical_path`. The opaque reference remains the delivery
identity; the logical path links particle manifests, Avatar/Scene definitions,
and other nested resources to the correct authorized file. Preview adapters
match by `file_ref` rather than closure-wide ordinal, so duplicate filenames or
ordinals across an Action and its dependencies cannot substitute bytes.

Direct VFX previews and Gesture/Reaction previews use the same typed support
projection. Particle, Avatar, and Scene support entries receive their
type-specific slot defaults plus dependency overrides, not the outer
`runtime_defaults` envelope. Both the Library dock and the Anima Loadout stage
attach the shared clip-event bridge: the Avatar owns Avatar/Particle VFX,
while the React preview surface owns Scene VFX and SFX playback.

All playable Included and Local content has registered file descriptors.
Typed descriptors and runtime projections contain no `public_url`, public
`/vrm` or `/animations` alias, host locator, or second download URL. Frontend
code must not infer one from an Included label. Browser-engine resources such
as ONNX models, PocketTTS workers, Basis decoders, fonts, UI imagery and
authoring-only engine templates remain version-coupled application resources;
they are not content dependencies or portable package members. The Scene
Effect creator's sticker set is such a resource only until a sticker is
chosen: its bundled image (WebP in production builds) is then copied into the
effect as the effect's own image.

## Mounted runtime preparation

`AnimaRouteProviders` issues one runtime revision and fences it for the route.

- `VerifiedByteLoader` performs protected FastAPI GETs, bounds responses,
  joins duplicate in-flight requests within one preparation, and verifies
  expected size/digest.
- `RuntimeMountPreparer.start()` prepares the selected model's executable
  dependency closure first. Its `essentialReady` promise returns one stable
  mount. `startOptional()` releases the remaining work only after the canvas
  draws the model in canonical relaxed-rest. A missing or failed model starts
  optional work from the fallback boundary instead of waiting for a frame.
  Optional work runs in two stages: the Idle pool's roots first, then the rest.
  `idleReady` resolves between them (at once for an empty pool). The Idle stage
  requests only Idle members, plus each usable bundle (JSON or binary) that carries
  an Idle member (one request each; if one falls back, its other members wait for
  the later stage). Each
  stage keeps up to eight requests in flight (configurable from one to eight),
  topping the pool up when a bundle falls back, with duplicate-member
  elimination, cancellation, and a 512 MiB total byte budget reserved for
  essential files first. Optional files that exceed the remainder degrade
  their roots without evicting the model. Background workers yield between
  files; one slow file holds only its own worker.
- `PreparedRuntimeMount` owns Blob URLs and decoded resource disposers until
  unmount, remount, runtime-owner replacement, or route replacement.

There are five distinct milestones: essential bytes verified, first posed frame
rendered, the Idle pool's roots prepared, each root's playback resources
verified, and preparation settled (`ready` or `degraded`). Visual readiness does not imply full playback readiness.
Optional private requests continue through the same verifier after the avatar
appears; after settlement, playback uses prepared Blobs without another
typed-content HTTP fetch. Decoding those Blobs may still be asynchronous.

The adapter publishes a root only when its whole executable dependency closure
is verified. One `AnimaRuntimeCatalog` appends these ready resources without
replacing existing model, motion, effect, or audio entries. The issued descriptor
and revision never change. Gesture selectors and Reaction pools contain only
admitted Action roots (one root per Reaction, however many cells hold it);
pending roots remain in the server's authoritative loadout, and a pool skips a
pending member and picks among the others. Accessors skip pending requests with a bounded
diagnostic, and the planner consumes a pending gesture before phase queueing so
it cannot replay after preparation. Required decoding also rechecks the current
run/plan before applying an action.

Model/VRMA loaders resolve external dependencies only through verified resource
maps, never an unprepared private URL. VRMA decode caches belong to the mounted
catalog, and motion/particle warming shares a 64 MiB eager byte budget across
incremental admissions. Cancellation drains workers and ignores late callbacks;
disposal releases Blob, mixer, GPU, and audio resources. The all-ready `prepare()`
API for preview/creation uses this same session with optional work released
immediately. An exact owner/revision creation handoff reuses its prepared mount
without downloading the files again.

Performance traces include four bounded marks per live mount:
`animama:runtime-N:manifest-ready`, `essential-bytes-ready`, `first-posed-frame`,
and `optional-settled` (all with the same prefix). Three milestone marks share one
name across mounts, with the mount number `N` in `detail.mount`:
`animama:runtime-first-frame`, `animama:runtime-idle-ready` and
`animama:runtime-settled`; only the newest mount's entry is kept under each name.
The first-frame marks are emitted on the frame following an actual main-camera
mesh draw, not on `Avatar.load` or a React update. Marks contain no content/owner
identity and are cleared on unmount.

Avatar canvases without a mounted typed catalog use an explicitly empty media
provider. They never fall back to the old code-shipped Particle/Avatar/Scene
effect registries. Preview and live playback gain executable media only by
mounting an exact typed catalog session.

The backend snapshot pins whole catalog-item revisions and runtime file URLs
carry the canonical opaque catalog `file_ref`. The browser does not interpret
that ref or receive the internal pin map. File GETs are read-only and do not
extend the lease; explicit `:renew` retains the same exact snapshot. If a
catalog item changes before preparation finishes, the old URL requires a
remount instead of serving replacement bytes.

There is no application Cache Storage, IndexedDB, or OPFS copy of the content
library. Chromium's HTTP cache may reuse runtime revision members and complete
binary bundles (ADR 0028), and Included files read at their digest URL (ADR 0033),
without a request, and revalidates other protected responses; a cache hit is never
required for correctness, and every reused member is verified again. Library
thumbnails and particle manifests use the `url` each file descriptor names rather
than building one from `file_ref`, and Anima presentation images are read with
`cache: "default"`, so a later visit reuses Included files and a release that
changes their bytes changes their URLs. Browser memory and HTTP caches are disposable and are not
backed up.

The manifest GET negotiates gzip with an identity fallback. Its
JSON is compressed; the complete descriptor, diagnostics, limits and
lease fields are retained. FastAPI delivers the encoded bytes and the browser decodes them normally.
The development proxy preserves that representation. Responses use `private, no-cache`,
`Vary: Accept-Encoding`, the encoded Content-Length and an ETag for the actual
wire representation. Every GET still authorizes and issues current lease
information, even with If-None-Match. `effective_revision` is not a validator
for the whole body because lease fields can change without a content change.
Registered file responses remain uncompressed with their exact size/digest. Runtime
revision members and complete binary bundles are `private, max-age=31536000,
immutable` in the local composition (ADR 0028), since their URLs name an exact
revision; other private bytes keep private revalidation, and manifests never take
the immutable policy. `VerifiedByteLoader` and `RuntimeBundleLoader` fetch with
`cache: "default"` and, after a size or digest mismatch or a malformed bundle, read
once more with `cache: "reload"` before failing the member.

### Optional bundle delivery

`PyAnimaRuntime.bundles` advertises same-origin delivery bundles of optional
members, Idle members' bundles first: `json` bundles of small JSON sequences and
manifests and `binary` bundles of small images. This is a transport optimization,
not a merged authoring format. Models and their essential dependencies, VRMA,
audio, metadata, and oversized files still use individual routes.

`RuntimeMountPreparer` puts each usable bundle's job first in an optional stage
after the first posed frame: the Idle stage when the bundle carries an Idle member,
otherwise the later stage. A bundle is usable when every member is optional,
reserved, of the bundle's kind (JSON sequences and manifests, or PNG, JPEG and WebP
images) and in no earlier bundle. Other workers continue loading binaries while it waits.
All advertised members must already fit the mount's single reserved byte budget;
otherwise the existing individual path loads only members that fit. No bundle
fetch is needed for old snapshots or preview callers without an advertisement.

`RuntimeBundleLoader` checks each advertisement against its format's limits (JSON:
at most 256 members, 256 KiB each, 2 MiB original bytes and a 16 MiB decoded
envelope; binary: at most 64 images, 512 KiB each, 4 MiB) and requires a same-origin
URL that ends in the revision and the bundle's own ID. A JSON envelope's exact
revision/ref set is validated and its original UTF-8 bytes reconstructed. A binary
frame is validated whole before any member is used: the `AMB1` magic, a header of at
most 64 KiB naming the exact member set, each delivered member's descriptor size,
and a total length with no missing or trailing bytes. Each member then goes through
the same size/SHA-256 verifier as individual files. A bad member fails only its
dependent roots; a malformed envelope or frame admits none and does not fall back. Successful members become
the same mount-owned Blobs and use the existing root publication/disposal path.
Cancellation stops admission and cancels the request; the app adds no cache of its
own beyond the browser's HTTP cache. Successfully bundled files are never fetched
individually too.

A complete binary bundle, like a runtime file, may be reused from the browser cache
for a year with no request (ADR 0028), so the server checks nothing for that read. A
JSON bundle is revalidated: the backend still checks current access, lease and every
physical file before 304, and it does not renew a lease. Gzip/identity representation validators
are distinct. Mixed errors are `no-store`. Transport failure, 404 (unavailable
endpoint) or 5xx may fall back once to individual requests in the same bounded
queue, which rechecks the same authorization. Auth/lease denial (401, 403, 409),
other 4xx, malformed or oversized envelopes and frames, and checksum failures do not
trigger fallback. Reload/remount
to recover changed content; do not clear the installation or alter its owner.

Measure revisit reuse in a persistent browser profile (Playwright's
`launchPersistentContext`); the desktop app's `persist:animama` partition and
ordinary browser profiles cache on disk. Playwright's default context is off the
record: Chromium caps its in-memory HTTP cache at 50 MB, which one starter Anima
visit can exceed, so earlier bundles are evicted and refetched with a plain 200.

## Fault isolation and no hot swap

`canChat` is independent from optional playback preparation.
`playbackStatus` reports `preparing`, `ready`, or `degraded`, and safe
reason-coded diagnostics back one discreet warning surface. While optional
work continues, a usable avatar is not covered by a loading overlay. The status
lines above the chat input (`ChatLoadingStatus.tsx`) show one line for each item
still in progress: the Avatar until its first posed frame, then animations and effects
with completed/total members, the PocketTTS model during its first load with
its setup step (the worker's five status stages, matched by text in
`use-pocket-tts-runtime.ts`), Parakeet while dictation or Voice Mode starts,
and any Parakeet CPU/GPU or Voice Clone encoder download, wherever it was
started (`ui/app/ModelDownloads.tsx`). Local reads say "Loading"; downloads say
"Downloading", with size and progress. Pocket voices are small and are not
listed. Chat readiness is not repeated there: the composer disables Send until
chat is ready. A missing or invalid optional
root is excluded from playback with its dependents; unrelated content and text
chat continue. A missing, invalid, or unposable Avatar uses the non-avatar
fallback and a recovery diagnostic, never an unposed model.

Content-health diagnostics identify the affected item, error code, message and
portable `content/<path>` locator. Creator Save failures retain the draft and
expose the actionable error. All typed creators
normalize direct FastAPI and older wrapped error envelopes at the shared
`saveCatalogItem` boundary. Stable failure codes explain what failed, the next
corrective step, and whether the draft remains safe; network failures recommend
checking the local stack, while unknown server failures direct the operator to
the backend logs without exposing a raw response object. When the backend can
identify one corrective control, the error detail also carries a canonical
`field` target. Creators focus and highlight duplicate or invalid names and
highlight the relevant file/image picker for empty, oversized, duplicate, or
unsupported files. Editing that control clears its targeted failure. Revision,
not-found, validation, and unexpected failures remain global unless their
source is unambiguous. The browser infers the same targets from stable codes so
an updated frontend remains useful against an older local backend.

The Avatar, Particle and Scene Effect creators share one Save, recovery, undo
and leave flow in `ui/content-creator/` (`useCreatorSave`,
`useCreatorLeaveGuard`, `CreatorLeaveDialog`), `ui/creator-history/`
(`useCreatorDocumentHistory`) and `lib/content/creatorRecoveryStore.ts`. Each
kind supplies an adapter with its payload, recovery record, edit route and,
for Particle, packaging notices to review before saving again.

- **Recovery** autosaves 350 ms after an edit while the document differs from
  what was loaded or last saved, and clears once it matches again. Drafts are
  keyed by owner and item ID, `new`, or `new:template:<id>` for a draft started
  from a template (`useCreatorTemplateStart`), so a template never replaces the
  plain new draft. IndexedDB holds image Blobs; the
  localStorage fallback keeps the document without them. Each kind's database,
  store and fallback names are fixed so existing drafts keep loading. A
  restored draft shows "Recovered unsaved … changes." with **Discard
  recovery** (`CreatorRecoveryNotice`, or Particle's combined notice): a new
  document returns to blank and a saved one reloads its saved version. A
  template route asks in its own dialog instead.
- **Save** resolves a blank name, writes recovery, then saves with the draft's
  operation ID. A retry after a failure or pause reuses that ID. Success clears
  recovery and replaces the route with the edit route, bypassing the guard.
- **Leaving** a creator with unsaved changes asks to discard them and their
  recovery; leaving during Save keeps recovery. On a `/new` route, a change of
  search parameters (the starting point) counts as leaving.
- **Templates** seed `/new?template=<id>` as a new, unsaved draft (it shows
  Unsaved until its first Save). If that template's key already holds a draft
  that differs from the template, the creator asks to continue it or to discard
  it and start from the template; an identical draft is continued silently.

Save, filesystem edits, Rescan, and Equip affect a later mount. The active
route keeps its already prepared exact bytes. Switching Animas or explicitly
remounting is the boundary that adopts a new catalog revision.

## Packages and Electron

[Library sharing](../features/library.md#import--export) uses the reviewed
[package HTTP protocol](../../backend/architecture/http-api.md#package-sharing)
for selected content or a saved Anima. Export downloads sealed backend-generated
bytes. Import uploads sequential bounded parts, reviews the complete package,
and installs fresh Local copies plus any Anima in one recoverable transaction.
The frontend persists operation/review identifiers before commit and resolves
unknown outcomes by operation status; navigation or request cancellation never
implies rollback. It never stores package bytes, selected files or File System
Access handles as a canonical browser content library.

Packaged Electron supervises PostgreSQL and FastAPI. FastAPI serves
the production React build at one saved loopback origin. There is no Vite server
in the installed app. Immutable core/optional Included mounts and writable Local
data use the same Content Catalog and protected byte APIs; React never enumerates
the host filesystem.

Only unpackaged external-stack development loads `ANIMAMA_DESKTOP_WEB_URL` or
`http://localhost:8000`. Packaged mode rejects that override and requires a
per-launch HttpOnly renderer capability. See [Desktop overview](../desktop/overview.md),
[Feature packs](../desktop/feature-packs.md) and
[Desktop backend operations](../../backend/operations/desktop-runtime.md).
See [Installation](../desktop/installation.md) for release availability.

# Typed Content Previews

Typed previews let a user or creator play one exact validated catalog revision
without changing an Anima loadout. Gestures and Reactions resolve their
complete clip/VFX/SFX dependency closure; component, Idle Style,
Avatar, and Appearance previews resolve their own exact media.

## Preview surfaces

The common Library uses one route-independent Preview Dock. Anima management
delegates preview playback to its existing Avatar stage. Creator editors own
their isolated authoring Canvas where required. These interactive surfaces use
the shared `AvatarPreviewSurface` for viewport measurement, R3F setup, camera
profiles/orbit controls, lighting, scene layers, lifecycle telemetry, and
disposal, but they do not teleport one global Canvas between routes. Dialogs
never mount a second Canvas; they receive a preview callback and status from
their launching surface.

The full-body camera profile serves Gestures and ordinary previews. Reaction
authoring uses the portrait profile, centered from the loaded Avatar's head,
with wheel and pinch zoom. The Particle Effect creator retains its emitter
camera settings through the same shell. Live chat and the one-shot hidden
portrait renderer are intentionally outside this shared interactive surface.

Every Avatar-bearing Dock preview uses the owned Anima recorded in
`user_settings.last_active_anima_id`, with the first owned Anima as the stable
fallback when that preference is stale. Gesture and Reaction closures are
mounted over that Anima's exact runtime catalog just like individual Particle,
Avatar, and Scene Effects. The Dock waits for the runtime before preparing a
scene and shows a clear blocker when no Anima or runtime is available; it never
silently substitutes a bundled neutral model.

The Dock keeps one Canvas and its loaded Avatar while targets replace each
other and while it is minimized or closed. Targets that share a model revision
reuse that Avatar without another model fetch; a different revision mounts a
fresh Avatar in the same Canvas. Destroying the minimized preview, the
five-minute warm-idle eviction, or a management or creator surface claiming the
renderer unmounts the Dock.

Standalone Pose targets first load their registered descriptor through
`PreviewByteSession`, verifying size, digest and selected revision. Preparation
converts its resolved values to a temporary one-beat `animaPoseClip/2.0` hold
(bone rotations, hips position and expressions; other bone positions are not
previewed) with an item-based preview ID that cannot collide with an equipped Gesture. The existing Dock player
owns that clip and selected Anima runtime; no Pose loadout slot is introduced.
Changing target or closing aborts pending reads and releases temporary byte URLs.

All preview sessions:

- identify one deliberate Included/Local item or one bounded Action-component
  root set;
- prepare a temporary catalog without mutating the query cache or loadout;
- abort stale preparation when the target changes;
- reuse renderer ownership and disposal rules already established by the host;
- stop audio, effects, and scene layers on close, route handoff, or unmount;
  and
- surface required dependency failures while allowing explicitly optional
  degradation warnings.

## Read-only playback observation

The Library Preview Dock, Anima loadout stage, and creator stage each expose one
versioned, hidden semantic output while a preview target is selected:

```html
<section data-playback-surface="library-dock">
  <output hidden data-playback-observation data-schema-version="1">
    {"version":1,"surface":"library-dock",...}
  </output>
</section>
```

The other valid surface values are `anima-loadout-stage` and `creator-stage`.
The JSON follows the
frontend-owned `PlaybackObservationV1` contract. It identifies the current
target and lifecycle status, then reports bounded summaries for VRMA motion,
pose clips, reaction clips, selected expression weights, Particle VFX, Avatar
VFX, Scene VFX, and typed diagnostic codes. Inactive collection channels are
empty arrays, while inactive pose and reaction clips are `null`. Numeric
timings, weights, and expression values are rounded to three decimal places.
The current Avatar VFX public snapshot does not expose an animation clock, so
its `elapsedSec` field is explicitly `null` in schema version 1.

This output is an observation seam, not a playback API. It samples existing
public Avatar/controller snapshots and React-owned Scene VFX state at no more
than 5 Hz. Sampling runs only while an active preview is loading or playing,
pauses while the document is hidden, and is removed on target change or
unmount. Status changes still render immediately without an idle timer. Product
code never reads the element, and changing its text or attributes cannot start,
stop, seek, or otherwise affect
playback. The projection allowlists logical IDs, small counts, enumerated
states, and rounded values; it excludes resource URLs, file paths, arbitrary
error text, model data, and controller references. Avatar VFX is captured
through a cached observation-only snapshot of active logical IDs, target roles,
animation presets, render modes, and warning count rather than its full
catalog/binding snapshot.

The Action creator reads its existing timeline's absolute playhead because
authoring applies samples directly rather than running a catalog clip player.
Expression weights still come from the Avatar's public live-value getter.
Standard facial channels and authored expression names remain observable even
when a sparse later sample omits them, so clearing a channel is measured rather
than assumed. One post-commit sample captures stopped timeline edits after the
editor applies them, without an idle timer or an extra runtime store.

Scene VFX also exposes focused DOM metadata for exact render evidence. Effect
roots carry `data-scene-vfx-id` and `data-scene-vfx-kind`; visible pattern and
marquee layers carry `data-scene-vfx-layer`; the animated marquee owner carries
`data-scene-vfx-marquee-track`; and resolved image cells carry
`data-scene-vfx-item-id`. Disabled layers render none of their layer, track, or
item markers.

## Action previews

Gesture and Reaction typed preview routes compile the same bounded closure used
by Save validation and runtime assembly. Creator-local preview adapters may
prepare the current in-memory sequence plus exact files and dependency
references. They do not require the preview Anima to equip the referenced
effects or sounds.

The frontend maps compiler-provided aliases into a temporary
`AnimaRuntimeCatalog`. Gesture preview can exercise motion, expressions, VFX,
and SFX. Reaction preview applies the same reaction projection rules as chat.
Missing required content blocks playback as one coherent root rather than
silently omitting a channel.

A standalone Reaction preview uses the final segment of its logical key as the
runtime ID, preserving a saved creator clip's identity. Its Joy/intensity
placement hint does not rename that preview to `joy-1`; equipped runtime
Reaction cells retain their normal emotion/intensity identity.

The Library motion preview reports `loading` while private clips and their
dependencies resolve. Once the player starts, it applies a zero-time Avatar
update before reporting `playing`. Its first renderer frame also uses zero
elapsed time because that frame's interval began before preparation completed.
Subsequent Dock frame deltas are capped at 0.1 seconds: a long suspended or
software-rendered frame cannot consume a whole short Reaction immediately.
Normal subsequent deltas are unchanged, as are the main chat and Anima runtime
clocks.

The Gesture/Reaction creator maps every current dependency alias onto one
canonical unique source set. Opening a saved Action reuses the root/support
preview already loaded for hydration, so it does not immediately re-preview
those dependencies. A new, recovered, imported, or edited dependency set uses
one `POST /v1/content/previews:prepare` request and one shared lease. Repeated
aliases and overlapping supports reuse the same bytes. The lease renews only
near expiry; ordinary focus/reconnect does not create a request burst. Timeline
Play, Pause, Restart, Seek, and Scrub operate only on the in-memory sequence,
loaded Avatar, and that local catalog. Transport controls do not re-resolve
the closure.

Save and Save & Equip
perform authoritative typed-document and closure validation before directly
replacing the editable Local entry; only Save & Equip enters the reviewed
loadout mutation flow.

## Component and media previews

Particle, Avatar, Scene, and Sound previews use their concrete typed source
union. Idle Style preview selects a Gesture from the chosen pool and carries its full
support closure plus finite playback facts from the same saved preview snapshot.
An empty pool has no preview occurrence. Editor candidate previews use the same
finite playback contract. VRMA and clip previews honor authored
speed and finite repetitions, retain sound/effect events and stop only their owned
resources. Avatar and Appearance preview targets carry the exact revisioned
model or image reference.

Included and Local sources both create an owner-scoped preview snapshot with
opaque file memberships. No typed projection contains a hidden public content
URL. Avatar and Scene component previews also carry their validated portable
definition, exact logical-image map, and optional Sound support entry. The
Preview Dock mounts that support into the same isolated catalog, loads images
asynchronously, and stops preview-owned apply audio on Stop, Close, route
handoff, or replacement.

The Library uses the typed preview resolver for Included and Local Avatar and
Scene Effects. The result is adapted to the same `componentPreviewTarget`, so
logical images, nested Sound support, remembered Anima context, and cleanup are
not separate preview implementations. Owned Edit links return to the stable
catalog item route; preview IDs and file capabilities are never editor
identity.

## Private file capability flow

Preview file delivery checks owner, expiry and exact membership, then verifies
size and digest before creating session-owned Blob URLs. See
[Protected preview preparation](../architecture/local-content-runtime.md#protected-preview-preparation)
for the shared loader and disposal contract.

## Live runtime boundary

Preview catalogs are not live chat catalogs. `AnimaRouteProviders` freezes an
issued `/v1/animas/{anima_id}/runtime` snapshot for the mounted route, and chat
uses that same revision. Closing a preview restores the host's already-mounted
catalog without rebuilding or hot-swapping the chat runtime.

Live chat can reveal a verified model in relaxed-rest while optional roots are
still preparing. Preview/creation callers retain the all-ready
`RuntimeMountPreparer.prepare()` contract, implemented by the same staged
verification session with optional work released immediately. Creation's first
chat handoff transfers that fully prepared mount only to the same owner, Anima,
and exact revision, without another byte fetch. The live canvas still establishes
and draws relaxed-rest before starting automatic playback from the handoff.
See [Mounted runtime preparation](../architecture/local-content-runtime.md#mounted-runtime-preparation)
for readiness, cancellation, and resource ownership.

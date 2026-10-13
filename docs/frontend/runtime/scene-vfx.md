# Scene VFX Guide

Scene Effects are typed catalog content and dependencies of Gestures and
Reactions. The product creator authors Local Background Layers or Focus Lines
items, while runtime preparation keeps those lanes distinct and resolves their
registered files and configuration for Preview and playback.

Scene effects render in DOM/SVG layers behind or in front of the Avatar and
can cover application overlays. Mesh-bound effects belong to
[Avatar VFX](avatar-vfx.md).

## 2) Main files

### Scene VFX core

- `src/frontend/web/src/lib/scene-vfx/types.ts`
- `src/frontend/web/src/lib/scene-vfx/catalog.ts`
- `src/frontend/web/src/lib/scene-vfx/presets.ts`
- `src/frontend/web/src/lib/scene-vfx/patterns.ts`
- `src/frontend/web/src/lib/scene-vfx/assets.ts`
- `src/frontend/web/src/lib/scene-vfx/focus-lines.ts`
- `src/frontend/web/src/lib/scene-vfx/runtime-state.ts`
- `src/frontend/web/src/stores/scene-vfx-store.ts`

Catalog source:

- `src/frontend/web/src/assets/effects/scene-vfx/catalog.json`

The JSON catalog owns the bundled background-layer and focus-line presets.
`catalog.ts` validates that JSON and exposes runtime-ready entries to the
TypeScript helpers. It has no line items, so each preset's marquee starts
empty; the creator adds stickers or private images to it.

On a live Anima route, the mounted `AnimaRuntimeCatalog` resolves exact built-in
App sources and private `animama/scene-effect/1` definitions. Private
background images are fetched through revision-scoped authorized file
references, bounded by media budgets, rewritten to owned Blob URLs, and
revoked on disposal. Clip events await private resolution and discard stale
results; an unavailable ID does not fall through to the global JSON catalog.
Standalone debug/editor surfaces may opt into the explicit built-in provider.

Private entries remain selectable as Gesture or Reaction dependencies rather
than independent loadout rows. Their optional local Sound alias is rewritten
through the parent Action's prepared reference map and played once when the
effect is applied. The ordinary scene background image is loadout-owned: live
`Scene` rendering uses the typed Appearance binding and never falls back to a
settings-owned media URL.

### Rendering

- `src/frontend/web/src/ui/main/scene-vfx/SceneVFXLifecycleBridge.tsx`
- `src/frontend/web/src/ui/main/scene-vfx/SceneVFXUnderlayHost.tsx`
- `src/frontend/web/src/ui/main/scene-vfx/SceneVFXOverlayHost.tsx`
- `src/frontend/web/src/ui/main/scene-vfx/SceneVFXLayers.tsx`
- `src/frontend/web/src/ui/main/scene-vfx/SceneVFXBackgroundLayersEffect.tsx`
- `src/frontend/web/src/ui/main/scene-vfx/SceneVFXFocusLinesEffect.tsx`
- `src/frontend/web/src/ui/main/scene-vfx/SceneVFXSolidLayer.tsx`
- `src/frontend/web/src/ui/main/scene-vfx/SceneVFXPatternLayer.tsx`
- `src/frontend/web/src/ui/main/scene-vfx/SceneVFXMarqueeLayer.tsx`

### Runtime integration

- `src/frontend/web/src/ui/main/canvas/Scene.tsx`
- `src/frontend/web/src/ui/main/MainShell.tsx`
- `src/frontend/web/src/ui/main/canvas/SceneRuntimeContext.tsx`
- `src/frontend/web/src/lib/avatar/Avatar.ts`
- `src/frontend/web/src/styles/scene-vfx.css`

### Debug authoring

- `src/frontend/web/src/ui/debug/VRMEditorDebugModal.tsx`

### Product authoring

- `src/frontend/web/src/routes/_app/scene-effects.new.tsx`
- `src/frontend/web/src/routes/_app/scene-effects.$sceneEffectId.edit.tsx`
- `src/frontend/web/src/ui/scene-effect-creator/SceneEffectCreatorPage.tsx`
- `src/frontend/web/src/ui/scene-effect-creator/useSceneEffectSave.ts`
- `src/frontend/web/src/lib/scene-vfx/editor/`
- `src/frontend/web/src/lib/scene-vfx/stickers.ts`
- `src/frontend/web/src/lib/content/catalogApi.ts`

The creator uses the neutral Effect creator primitives in
`ui/content-creator/`, including the shared Save, recovery and leave flow
described in [local content runtime](../architecture/local-content-runtime.md).
The document and private image collection are Scene-specific.

## 3) High-level model

The current scene-VFX runtime and authoring path are built around six pieces:

1. `runtime-state` and `scene-vfx-store`
   - the pure runtime-state module normalizes, stamps, and derives presentation
     flags without selecting an owner
   - owns the active live scene effects
   - resolves defaults into runtime-ready entries
   - enforces one active effect per `SceneVFXKind`
   - derives cover-state separately for underlay and overlay bands

2. `SceneVFXLifecycleBridge`
   - owns expiration and dismiss-on-input side effects for all active scene effects

3. `SceneVFXUnderlayHost`
   - adapts the live store to the pure `SceneVFXUnderlayLayers` renderer
   - renders under-canvas scene effects inside `Scene.tsx`
   - currently hosts `background_layers` and `focus_lines` with `renderPlacement: "behind_avatar"`

4. `SceneVFXOverlayHost`
   - adapts the live store to the pure `SceneVFXOverlayLayers` renderer
   - renders over-canvas scene effects inside `MainShell.tsx`
   - currently hosts `focus_lines` with `renderPlacement: "front_of_avatar"`

5. `VRMEditorDebugModal`
   - owns local draft editing per scene-VFX kind
   - previews or applies entries through the shared store

6. `SceneEffectCreatorPage`
   - owns a versioned portable editor document and private image resources
   - renders the production pure underlay/overlay layers inside an isolated
     `AvatarPreviewSurface`
   - never reads or writes `useSceneVFXStore`
   - saves readable Local files through the typed Scene Effect catalog Save API

There are currently two scene-VFX kinds:

- `background_layers`
- `focus_lines`

The Library Content Preview Dock is a second state owner, not a second scene-VFX
runtime. It uses the same pure normalizer and layer renderers with a local
single-effect state value, its own viewport provider, and its own Avatar
context. Preview Stop/Minimize/Close therefore cannot mutate scene effects in a
simultaneously mounted live Anima scene.

## Tools

`pnpm -s effects check`, `effects:render` and `animation:preview` take Scene
Effect folders and Library items (`library:scene-effect/…`) and draw the
Scene layers as chat does; `effects save` takes folders, and `effects
promote` folders or `library:local/<name>` items. `effects:bench --reaction`
measures a Reaction's Scene Effects. See the [effect
tools](avatar-vfx.md#9-effect-tools); the `animama-scene-vfx` skill wraps
them into the authoring pipeline, with the layer fields and ranges.

## Product creator behavior

Routes:

- `/scene-effects/new`
- `/scene-effects/:sceneEffectId/edit`

New Scene Effects start from the Effects template picker (the sidebar Create
menu's **Effects** item, the Create page's Scene FX card or `/effects/new`).

Background Layers combines Solid, Gradient, Pattern, Tile, Screen, Marquee,
up to three Scatter layers and an Entry flash; Scene Setup lists them front
to back, Entry flash first, and each has an inspector. Marquee and scatter
items can be reordered; each is one of the effect's own images, either an
Animama sticker or a private PNG/JPEG/WebP/SVG. A tile uses one private image.

The sticker picker lists Animama's built-in stickers by family, with
thumbnails. Choosing one fetches its PNG and adds it through the same path as
**Add private image**, labelled with the sticker's name, so Save, browser
recovery and Portable packages carry its bytes like any other image; the same
bytes added twice are carried once. The set is
`content/included/resources/scene-vfx/stickers/`: owner-authored PNGs listed
in `stickers.json` (`animama/scene-stickers/1`; each item has an `id`, a
`label`, a `family` and its `file`). `lib/scene-vfx/stickers.ts` bundles the
manifest and the PNGs as build assets, so the picker works in development, a
built app and the packaged desktop app; an unlisted PNG or a listed file that
is missing fails the web tests (`lib/scene-vfx/stickers.test.ts`). To add a sticker, copy its PNG into the
folder, add its item to `stickers.json` in the order the picker shows it,
and add an owner-form `licenses/source-review.json` record for the file
(the folder's licence rule, `resources/scene-vfx/stickers/**`, already
covers it).

Animama no longer provides Twemoji. A Local Scene Effect saved with an
`emoji` marquee or scatter item opens with each such item marked missing and a
prompt to replace it with a sticker or image, or remove it; Save is refused
until it is (the check names the item, such as `marquee.items.0`). There is no
automatic conversion. Chat, previews and review renders draw the Scene without
the item and request nothing for it. The Local scan keeps the Scene valid
with a `scene_emoji_item_removed` diagnostic per item, so Content Health lists
it; backend Save refuses an emoji item (`saved_content_invalid`, with the item
as `field`), and Portable export and package import refuse it with
`scene_emoji_item_removed`, as they do a package that declares a retired
`animama/twemoji/…` capability.

A chosen image is checked before it is decoded against the
Scene image limits (`lib/effects/effectArtLimits.ts`: 8 MiB and 4096 px per
image, 16 images and 32 MiB per effect), and is saved under a name whose
extension matches its bytes (`petal.png`, not `petal.webp`).
SVG images must be UTF-8, self-contained static artwork: shapes, groups,
gradients, clips, masks and local fragment references. Scripts, event handlers,
CSS styles, animation, embedded images and external references are rejected on
Save.
Focus Lines exposes render placement, procedural geometry, Avatar-face or
normalized manual-box targeting, flicker animation and style controls.
Selecting a built-in template updates the editable draft. The background
templates, one per Scene family (Shoujo Bloom, Radiance, Festive Pop,
Anticipation, Shock, Rage, Queasy and Gloom), take their family's Included
emotion background's solid, pattern, gradient, rays or lines and flash, read
at build time; they start without that effect's images. The focus templates
are the bundled `dark` and `light-streak` presets. The picker offers the 24
Included emotion backgrounds by family and the two Included focus presets,
with rendered thumbnails; `/scene-effects/new?template=<stem>` starts a new,
unsaved draft named after the chosen item. For now the draft takes the
starting template of the background's family (or the focus preset), without
the Included item's images.

The portable `animama/scene-effect-editor/1` JSON contains logical image names
and exact Sound sources only. It never contains Blob URLs, download URLs, or
storage capabilities. Private image `File` objects and their object URLs live
outside the document. Save collects the referenced image files and companion
paths, the Scene Effect definition, Sound dependency references, and the
portable authoring document into a catalog Save request. It includes an
operation ID and, for an existing item, its ID and expected revision. The
backend validates and atomically updates readable Local files and reconciles
the catalog; there is no server draft or immutable-release finalization step.

Recovery stores the document, operation identity, and bounded image Blobs in
IndexedDB. A metadata-only localStorage fallback keeps the authored document
and save identity but surfaces a repair state requiring the user to reselect
private images. Retries preserve the operation identity. Reloads retain recovery
while changes are unsaved; a successful Save or explicit discard clears it. Discarding never changes the
saved Library item.

The preview reuses the production pure scene renderers and an editor-owned
Avatar/viewport context. Backgrounds render below the Avatar; Focus Lines honor
`behind_avatar` or `front_of_avatar`. No preview draft is dispatched to the
global live scene store, so leaving the creator cannot alter a mounted Anima
runtime.

Anima management, Scene Effect creators, and Gesture/Reaction editors extend
Background Layers across the application viewport beneath the floating panels,
including the sidebar. Only the background has this wider viewport: avatar
canvas dimensions, camera framing, interaction coordinates, and Focus Lines
keep their original preview bounds. The background measures its own surface so
marquee rows fill the full width and follow window resizing. Dock previews keep
their backgrounds inside the dock.

The common Library resolves Included and Local Scene Effects through typed
catalog previews and returns editable Local rows to this stable edit route.
Once the item is saved, the creator can hand its catalog item ID and
`scene_effect` token to a new Gesture or Reaction. Definitions, private images,
and preview capabilities remain out of route history.

## 4) Runtime flow

The current runtime flow is:

1. `MainShell` measures the canvas host and provides viewport data through `CanvasViewportProvider`.
2. `MainShell` also provides the live `Avatar | null` through `SceneRuntimeProvider` so scene effects can resolve avatar-dependent targets without putting the avatar instance in Zustand.
3. `Scene` renders:
   - the mounted Anima Appearance Image, if configured
   - `SceneVFXUnderlayHost`
   - the transparent `<Canvas>`
4. `MainShell` renders `SceneVFXOverlayHost` as a sibling above the scene host.
5. `SceneVFXLifecycleBridge` watches every active scene effect and:
   - sets expiry timers from `expiresAtMs`
   - attaches temporary capture-phase dismiss listeners only when at least one live entry has `dismissOnInput: true`
6. `scene-vfx-store` resolves and stores one runtime entry per kind.
7. `MainShell` uses the store's derived cover flags to raise either the whole scene host or just the overlay host when needed.

One additional safety rule still exists in `MainShell`:

- if the UI leaves scene mode, it clears all scene VFX so elevated cover state cannot get stuck

## 5) Render placement and z-order

Scene VFX is intentionally not rendered inside Three.js.

There are two DOM render bands:

### Underlay band

Mounted in `Scene.tsx` like this:

1. static anima background image
2. `SceneVFXUnderlayHost`
3. transparent React Three Fiber canvas

This is where:

- `background_layers` always renders
- `focus_lines` renders when `renderPlacement === "behind_avatar"`

### Overlay band

Mounted in `MainShell.tsx` as a sibling above the scene host.

This is where:

- `focus_lines` renders when `renderPlacement === "front_of_avatar"`

That split is what makes true "in front of avatar" rendering possible. A child inside `Scene.tsx` can never outrank the canvas or the surrounding DOM overlays by itself.

### Cover behavior

The store derives three booleans:

- `underlayCoverUiOverlaysActive`
- `overlayCoverUiOverlaysActive`
- `coverUiOverlaysActive`

Current behavior:

- underlay cover raises the scene host wrapper so the whole scene stack can sit above normal UI overlays
- overlay cover raises only the overlay host
- if both are active, underlay cover wins and the overlay host is raised above that elevated scene host

## 6) Store model and runtime semantics

File: `src/frontend/web/src/stores/scene-vfx-store.ts`

The store state is intentionally small:

- `activeByKind`
- `coverUiOverlaysActive`
- `underlayCoverUiOverlaysActive`
- `overlayCoverUiOverlaysActive`
- `applySceneVFX(...)`
- `applySceneVFXPreset(...)`
- `clearSceneVFXKind(...)`
- `clearAllSceneVFX()`

Current semantics:

- only one active entry may exist per `SceneVFXKind`
- applying a new entry replaces the old entry for that kind only
- `background_layers` and `focus_lines` can coexist
- applying an entry with `enabled: false` clears that kind
- presets are still only a `background_layers` feature

Default resolution happens in the store:

- `durationMs` defaults to `5000`
- `coverUiOverlays` defaults to `false`
- `dismissOnInput` defaults to `true` for `background_layers`
- `dismissOnInput` defaults to `false` for `focus_lines`
- `durationMs: null` means sticky and does not auto-expire
- legacy `emoji` marquee and scatter items are skipped (Animama no longer provides Twemoji)
- marquee `itemRotationMode` defaults to `"upright"` if missing
- marquee `itemRotationOffsetDeg` defaults to `0` if missing

Focus-lines-specific normalization also happens in the store:

- `lineCount` is clamped to `[50, 200]`
- `opacity` is clamped to `[0, 1]`
- `baseThicknessPx` is clamped to `[1, 48]`
- `thicknessVariationPx` is clamped to `[0, 32]`
- `lengthVariation` is clamped to `[0, 0.75]`
- `overscanPx` is clamped to `[0, 256]`
- `target.paddingXPx` is clamped to `[0, 240]`
- `target.paddingYPx` is clamped to `[0, 240]`
- `animation.opacityJitter` is clamped to `[0, 1]`
- `seed` defaults to a deterministic hash of `entry.id`

The live runtime shape adds:

- `startedAtMs`
- `expiresAtMs`

There is also a small compatibility shim in the store for older focus-line entries that still used a single `target.paddingPx` field.

## 7) `SceneVFXLifecycleBridge`

File: `src/frontend/web/src/ui/main/scene-vfx/SceneVFXLifecycleBridge.tsx`

`SceneVFXLifecycleBridge` is the side-effect boundary between the store and the DOM scene effects.

Responsibilities:

- subscribe to all active runtime entries
- schedule effect expiry
- attach and remove temporary dismiss listeners

Dismiss behavior follows these rules:

- keydown dismiss ignores modifier keys, repeated keys, and editable targets
- only `Escape`, `Enter`, and `Space` are treated as dismiss keys
- pointer dismiss only reacts to primary-button pointerdown
- if any dismissible active effect has `coverUiOverlays: true`, the first dismissing input is consumed so hidden UI does not receive an accidental click

Important implementation detail:

- there is no timer per triangle in the focus-lines renderer
- the lifecycle bridge only creates one timeout per active scene effect that has an expiry

## 8) Effect kind: `background_layers`

File: `src/frontend/web/src/ui/main/scene-vfx/SceneVFXBackgroundLayersEffect.tsx`

It renders these DOM layers, back to front; the optional ones (`gradient`,
`tile`, `screen`, `scatters`, `flash`) are off when absent, so definitions
written before them are unchanged and keep `animama/scene-effect/1`:

1. `SceneVFXSolidLayer`
2. `SceneVFXGradientLayer`: a linear (`angleDeg`) or radial (`centerX`,
   `centerY`) gradient of 2–4 stops.
3. `SceneVFXPatternLayer`
4. `SceneVFXTileLayer`: one image (`image` in a stored definition, `src` at
   runtime) repeated at `size` px, drifting one tile per cycle in a marquee
   direction at `speedPxPerSec`.
5. `SceneVFXScreenLayer`: procedural `rays` (count, centre, wedges or a
   `spiky` starburst, `turnSeconds` with the sign giving the direction,
   `throbPerSec`) or `lines` hanging from the top edge (count, length and
   width ranges, `swaySeconds`), drawn as SVG from a `seed`.
6. `SceneVFXMarqueeLayer`
7. `SceneVFXScatterLayers`, one layer per `scatters` entry: `count` items
   picked from `items`, with seeded per-item size, rotation and opacity
   ranges, a region, `keepFaceClear`, drift in a marquee direction, a spin
   range (`alternateSpin`) and a `pulse` (`twinkle`, `pop` or `flicker`).
   `sceneScatterPlacements` places a Scene's layers together; items count as
   circles of their size:
   - Still items never overlap each other, within a layer or across layers.
     Each rests wholly inside its region and the view, spread by seeded
     best-candidate placement so gaps to neighbours and to the region's
     edges come out even. When they cannot all fit at full size (small
     views such as picture-in-picture), every still item of the Scene
     shrinks by one common factor, found by bisection, down to 0.4; only a
     region still too crowded at that floor keeps the least overlap it can.
     `keepFaceClear` keeps their centres out of the column behind the head
     (the middle 30% of the width, top 60% of the height).
   - Drifting items cross the whole view on off-screen tracks, so nothing
     appears or vanishes mid-view. They run in equal lanes across the motion
     (the region for left and right motion, the view width for up and down,
     minus the face column's width with `keepFaceClear`), as many as the
     largest item fits, and each lane's items are evenly spaced along the
     track with neighbouring lanes staggered, so the layer stays evenly
     filled. Its items do not touch unless the layer is too crowded for its
     span and track (too many or too large items).
   - Layers moving the same way whose spans meet share that span: each gets
     its own lanes, interleaved and in proportion to `count × maxSize`, so
     they never collide, even at different speeds, while the span holds a
     lane as wide as each layer's largest item (for left and right motion,
     overlapping regions merge). A drifting item may pass over
     another layer's still items, and layers moving in different directions
     may cross.

8. `SceneVFXFlashLayer`: one fade from `color` over `durationMs` when the Scene
   starts.

The geometry is in `lib/scene-vfx/layerGeometry.ts`, so a definition and view
size give the same picture on every surface. Motion is CSS keyframes in
`styles/scene-vfx.css`; the review tools and the headed preview pause and seek
them. Ranges and counts for every field, old and new, are in
`lib/scene-vfx/limits.ts`; the creator checks them before Save and the backend
(`app/contracts/scene_effect_limits.py`) at Save, Local scan and package import,
with `lib/content/fixtures/scene-effect-limits.json` as the parity record; a
Local Scene outside them shows a `scene_definition_invalid` diagnostic naming
the field.
Every Scene colour is six-digit hex (`#rrggbb`), in the runtime parser and the
backend, because colours reach CSS gradients and SVG paint. Scene images are
held to the image limits at Save, scan and import and again when the runtime
loads a private Scene; a Local Scene whose image is over them shows a
`scene_image_limit` diagnostic and does not play until the image is replaced
with a smaller one (an image saved before the limits may need this).

### Solid fill

File: `src/frontend/web/src/ui/main/scene-vfx/SceneVFXSolidLayer.tsx`

This layer is a fullscreen absolutely positioned `div` with `backgroundColor`.

### Static SVG pattern

Files:

- `src/frontend/web/src/ui/main/scene-vfx/SceneVFXPatternLayer.tsx`
- `src/frontend/web/src/lib/scene-vfx/patterns.ts`

The pattern layer uses generated SVG data URLs rather than building lots of decorative DOM nodes.

Current pattern kinds:

- `none`
- `polkadot`
- `heart`
- `star`

### Marquee

Files:

- `src/frontend/web/src/ui/main/scene-vfx/SceneVFXMarqueeLayer.tsx`
- `src/frontend/web/src/styles/scene-vfx.css`
- `src/frontend/web/src/assets/effects/scene-vfx/catalog.json`
- `src/frontend/web/src/lib/scene-vfx/assets.ts`

This is the animated layer in the background-VFX system.

A runtime marquee or scatter item is `png` or `svg` and names its URL. A
stored definition names each item's image by logical name
(`{ kind: "image", image }`), which `sceneEntryFromDefinition` maps to the
image's URL; a legacy `emoji` item is skipped.

Custom `svg` line items are project-owned public assets under
`/effects/scene-vfx/svg/`. The catalog validator rejects SVG `src` values
outside that directory, paths with traversal, and paths with query or hash
suffixes. SVG assets should stay static and flat: no scripts, external
references, embedded raster images, or runtime/user-controlled inline SVG
strings.

Current direction options:

- `static`
- `left`
- `right`
- `up`
- `down`
- `diagonal-up-left`
- `diagonal-down-left`
- `diagonal-up-right`
- `diagonal-down-right`

The actual motion is driven by the global `scene-vfx-marquee-shift` keyframes in `styles/scene-vfx.css`.

### Background-layer presets

Catalog source: `src/frontend/web/src/assets/effects/scene-vfx/catalog.json`

Runtime wrapper: `src/frontend/web/src/lib/scene-vfx/presets.ts`

The bundled catalog holds no background presets, only `none` (which clears the
live background effect) and the focus presets below. Backgrounds are Included
Scene Effects: one per emotion, `content/included/vfx/scene/scene-vfx-emotion-<emotion>/`,
which reach the runtime through the mounted catalog. Each intensity-3 Reaction
plays its emotion's background through a `scene_vfx` event whose `presetId` is
the dependency alias `scene-vfx-emotion-<emotion>`.

## 9) Effect kind: `focus_lines`

Files:

- `src/frontend/web/src/lib/scene-vfx/focus-lines.ts`
- `src/frontend/web/src/ui/main/scene-vfx/SceneVFXFocusLinesEffect.tsx`
- `src/frontend/web/src/lib/avatar/Avatar.ts`

`focus_lines` is a screen-space manga emphasis effect rendered as SVG triangles.

Focus-line presets are also catalog-backed. Current preset ids:

- `dark`
- `light-streak`

It supports two placement modes:

- `behind_avatar`
- `front_of_avatar`

It supports two target modes:

- `avatar_face`
- `manual_box`

### Target resolution

`manual_box`:

- authors a normalized `0..1` rectangle
- resolves to viewport pixels at render time

`avatar_face`:

- projects `left eye`, `right eye`, and `mouth` anchors to viewport space
- builds a loose face-focused rectangle from those points
- expands that rectangle with independent padding values:
  - `paddingXPx`
  - `paddingYPx`
- returns `null` when no valid points are available, which means nothing renders

Current default face padding is:

- `paddingXPx = 48`
- `paddingYPx = 96`

The avatar-side projection helper lives on `Avatar` because the avatar already owns:

- the camera reference
- face landmark snapshots
- face texture anchor snapshots

### Geometry model

The renderer builds polygons in `buildFocusLinePolygons(...)`:

1. resolve a focus rect and center point
2. treat that focus rect like an ellipse-shaped exclusion zone
3. march around the center at `lineCount` evenly spaced angles with jitter
4. cast each line outward until it reaches the overscanned viewport bounds
5. build a thin triangle from:
   - two outer points offset by thickness
   - one inner tip near the exclusion ellipse

The geometry is deterministic for a given seed, so previews are stable and repeatable.

### Animation model

Focus lines do not animate through React timers.

Each triangle gets:

- a deterministic duration
- a deterministic negative delay
- a deterministic max opacity

The actual flicker is driven entirely by the global `scene-vfx-focus-lines-flicker` keyframes in `styles/scene-vfx.css`.

This means:

- no timer per triangle
- no per-frame React updates
- only CSS opacity animation on mounted SVG polygons

### Runtime update model

`manual_box`:

- resolves only from viewport and draft/runtime data
- does not poll avatar state

`avatar_face`:

- polls target resolution at `1000 / 2` ms
- compares the new target against the previous target with `areResolvedTargetsSimilar(...)`
- only rebuilds geometry when the resolved target materially changes

Avatar projection reuses work within each sampling pass:

- camera matrices are updated once per sampling pass
- a reusable scratch `THREE.Vector3` is used for projection work instead of allocating one per sampled point

## 10) Pose Clip Events

`AnimaPoseClip` playback can trigger scene VFX through timed clip events. Scene
events keep a catalog `presetId` and `sceneKind` (`background_layers` or
`focus_lines`) in the clip JSON. `PoseController` schedules the event, while the
runtime adapter applies it through the existing scene VFX store and lifecycle
hosts.

Scene clip events follow existing store semantics: only one active entry may
exist per scene kind, so a later same-kind scene event replaces the earlier
active entry. Clip playback cleanup clears or restores clip-owned scene effects
so background cover and focus-line overlay state should not remain stuck after a
clip stops, resets, or unloads. `presentation.disable_vfx` skips new
clip-owned scene VFX applies and clears tracked clip-owned scene records, but it
does not disable manual/debug scene VFX controls or clip SFX events. Baked pose
clip export keeps scene VFX events as catalog references rather than embedding
preset definitions.

## 11) Debug modal integration

File: `src/frontend/web/src/ui/debug/VRMEditorDebugModal.tsx`

Scene VFX is exposed through a dedicated top-level `Scene VFX` section in the VRM debug modal.

This is intentionally separate from the avatar `Effects` section because the two runtimes have different ownership and rendering surfaces.

The modal keeps independent draft state per scene-VFX kind:

- background draft state
- focus-lines draft state
- background preview bookkeeping
- focus-lines preview bookkeeping

When the modal opens for a target:

- if a live `background_layers` effect exists, the background draft is seeded from it
- otherwise the background draft is seeded from the empty `none` entry
- if a live `focus_lines` effect exists, the focus-lines draft is seeded from it
- otherwise the focus-lines draft is seeded from `createDefaultSceneFocusLinesVFXEntry()`

### Preview vs Apply

Preview and apply are isolated per kind.

Preview:

- clones the current draft for that kind
- adds a `-preview` id suffix and preview label
- sets `durationMs: null`
- sets `dismissOnInput: false`
- stores the previous live entry for that same kind so it can be restored later

Apply:

- clears preview bookkeeping for that kind
- writes the normal draft entry to the live store

Because preview state is tracked per kind, previewing `focus_lines` does not overwrite `background_layers`, and vice versa.

## 12) Performance notes

`background_layers`:

- pattern is cheap because it is one cached SVG background tile
- marquee uses CSS transforms instead of per-frame React updates
- main cost is DOM size when the marquee grid gets dense
- at their densest allowed settings, gradient, tile, rays, lines and the flash
  each add at most about 0.3 ms of frame time and all layers together about
  2.1 ms (Apple M5, DPR 2, `effects:bench --reaction`); scattered items are
  the costliest layer (about 1.8 ms for 96 large spinning, pulsing drifters)

`focus_lines`:

- triangle creation is O(`lineCount`) and is usually cheap at the current `50-200` clamp
- the main steady-state cost is SVG paint plus opacity animation
- there is no timer per line
- the only recurring JS timer in this path is the avatar-face sampling interval, and only when `target.kind === "avatar_face"`

The current implementation also avoids a common `useSyncExternalStore` pitfall by subscribing `SceneVFXLifecycleBridge` to `activeByKind` and deriving arrays with `useMemo`, instead of returning a fresh array directly from the Zustand selector.

## 13) Current limitations

- Scene Effects are triggered by configured clip events or explicit preview/
  debug controls; they are not a separate autonomous scene planner.
- Persistent authoring belongs to typed catalog items and Action dependencies,
  rather than Anima settings or preferences.
- Shader-based, canvas-composited, and world-space Three.js scene effects are
  not implemented by this DOM/SVG layer.

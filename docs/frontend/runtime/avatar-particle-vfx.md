# Avatar Particle VFX

Particle VFX are Three.js particle effects loaded through `three.quarks` and
owned by the live `Avatar` runtime. They are separate from avatar texture VFX
and DOM scene VFX.

Particle Effect is the product-domain name exposed under
`/particle-effects`. Typed Local entries reuse the existing Three.quarks
validation and budgets, preview without an Anima loadout write, and compose
directly into Gestures/Reactions. A Gesture or Reaction references the exact
typed catalog item by dependency alias. Complete Preview mounts its current
validated revision automatically; it is never a separate equip choice.

The Gesture and Reaction editors browse this typed catalog directly. Adding a
Particle Effect records its exact source plus a local alias and creates its
timeline event in the same editor change. Removing its final use prunes the
declaration before Save.

Runtime code lives under:

- `src/frontend/web/src/lib/avatar/particle-vfx/`
- `src/frontend/web/src/lib/avatar/poses/animaPoseClip/`
- `src/frontend/web/src/lib/avatar/Avatar.ts`

`AVATAR_PARTICLE_VFX_CATALOG` is read at build time from the Included
descriptors (`quark/<stem>/<stem>.json`) and backs the debug panel and authoring
defaults; there is no hand-written copy. Live playback resolves only the
verified entries in the mounted `AnimaRuntimeCatalog`.

## Bundled media

Curated particle media is tracked under
`content/included/vfx/particle`. Each playable Particle Effect directory owns
its manifest and referenced textures as registered catalog files. Raw
downloaded texture packs are authoring source material only; mounted runtime
entries do not fetch them through public paths.

The creator's curated built-in textures live in
`content/included/vfx/particle/particle-vfx/textures/`. Regenerate them with:

```bash
node scripts/generate-particle-vfx-assets.mjs \
  --output-dir /path/to/new-staging-directory \
  --kenney-root /path/to/kenney-particle-pack \
  --brackeys-root /path/to/brackeys-pack
```

Run from `src/frontend`. The source roots must contain the original pack
layouts. The generator requires a new staging directory outside
`content/included` and refuses an existing destination. It writes PNG textures,
the texture manifest and the folder README for review; it does not install or
update Included content. Review the generated paths and provenance before
copying outputs. Particle Effects are authored in the creator and carry their
own texture copies under safe manifest-relative paths.

Use PNG with transparent alpha for billboards, prefer square 256x256 or
512x512 textures for static sprites (up to 1024x1024 for detailed hero art), disable particle material depth writes,
and keep local-space emitters for effects that should follow avatar anchors.
Curated flipbook atlases are tracked in the same texture directory. The
generator normalizes Brackeys TGA flipbooks and predrawn PNG atlases into PNG
runtime assets, then records `uTileCount`, `vTileCount`, frame counts,
`blendTiles`, and recommended `FrameOverLife` ranges in the editor manifest.

### Effect textures

A Particle Effect carries its own textures: image files listed with role
`texture` in its descriptor and named by the manifest's image URLs
(`textures/<name>.png`). The creator imports one with **Import PNG texture**
(as `textures/<name>-N.png`) or fills a texture the effect names but lacks
with **Choose file for <name>**. Each is checked before it is decoded
(`lib/effects/effectArtLimits.ts`, mirrored by the backend at Save, scan and
package import):

| Limit | Value |
| --- | --- |
| Format | PNG on import; saved items and packages may also carry JPEG or WebP |
| Each texture | 4 MiB, 2048 px per side, 2048² px |
| Per effect | 16 textures, 32 MiB |
| Sprite sheet grid | at most 16 tiles each way (U and V tile counts) |

three.quarks' billboard shader tone-maps (ACES Filmic in chat) but has no
sRGB output step, so a texture with an empty `colorSpace` (every Included
effect) shows pure white near RGB 194. A manifest may set a texture's
`colorSpace` to `"srgb"`; the loader, creator preview, review renders and Save
keep it, but it only darkens mid-tones and does not restore white.

A manifest material may set the three.js field `toneMapped: false` to skip
tone mapping for the emitters that use it. Their stored texture values then
reach the canvas unchanged (white 255, grey 128 stays 128) with the texture's
`colorSpace` left empty; an `"srgb"` texture would render darker. Animama's
batch renderer (`lib/avatar/particle-vfx/batchedRenderer.ts`) keeps such
emitters out of tone-mapped batches; chat, the creator preview and the review
renders all use it, and Save, export and the backend keep the field.
Materials without it render exactly as before. Switching an effect retunes
its colours: tone mapping compresses highlights and shifts saturated hues,
so art and `startColor` tuned under it look brighter and harsher without it.

Save also packages each built-in creator texture an emitter uses (the
curated files below, referenced as `textures/<file>`) as a file of the saved
item, so a saved or packaged effect is self-contained. An effect's own art
must not reuse a built-in's file name: the creator draws and saves its
built-in art for that reference, and `effects check` and `effects save`
refuse such a folder. New textures use the `particle-texture` and
`particle-sheet` [art budgets](avatar-vfx.md#effect-art).

A creator draft autosaves to browser recovery with its textures, up to
37 MiB (5 MiB of JSON plus the 32 MiB texture total). A larger draft is not
recovered; when only the localStorage fallback is available, a draft of up
to 1 MiB of JSON restores without its textures and the creator asks for them
again.

The editor texture picker is driven by
`web/src/lib/avatar/particle-vfx/editor/textureManifest.ts`. Each manifest
entry records a stable id, display label, runtime file name, authoring role
such as glow, spark, smoke/dust, trail/streak, or symbol, and recommended
blending and render mode defaults. Atlas entries also carry tile metadata and a
recommended linear frame-over-life range. New blank emitters use those
recommendations when a texture is selected so stretched streak textures start
with the stretched billboard render mode, smoke/dust textures start with normal
blending, and flipbook textures start with matching tile counts and frame
animation.

## Particle Effect creator

The protected `/particle-effects/new` and
`/particle-effects/:particleEffectId/edit` routes provide the
Animama-owned authoring surface. New Particle Effects start from the Effects
template picker (the sidebar Create menu's **Effects** item, the Create page's
Particle FX card or `/effects/new`), which offers Start from scratch and the
16 Included Particle Effects as templates. A template opens
`/particle-effects/new?template=<stem>`; the creator does not load the
template's settings yet and opens blank. The editor creates a direct Particle Effect
document, selects its bounded resources, previews it in its isolated Canvas,
and saves one editable Local entry.

Included sources are read-only. Editing an Included template starts a new Local
typed item rather than modifying shipped files. Unsaved changes autosave to
browser recovery, as in the other effect creators; the stable editor route
carries only the catalog item ID.

The editor preserves the existing curated texture manifest, particle-budget
validation, import/export tools, and Three.quarks preview lifecycle.
Its estimate (`editor/particleEstimate.ts`) is a conservative bound on the
particles alive at once, which the declared `max_particles` must cover: each
emitter contributes its maximum `emissionOverTime` × the upper bound of
`startLife` (capped by its `duration` plus one 0.1 s frame unless it loops)
plus one for the runtime's rounding up, a trail's life extended by the frames
its trail takes to drain (`startLength` × 0.1 s), each burst's count (rounded up) for every
assumed wave (`cycle`, `interval` apart; three.quarks 0.17.1 fires each burst
once per loop, so this only over-counts) and, for a looping emitter, every
repeat whose particles are still alive; emitter peaks are summed. A 30 s loop
at 20/s with 2 s lives counts 41, not the 600 it emits. Save refuses an
estimate above the declared budget or 512, and `effects check` prints it. A
Local effect saved before this estimate (it counted every particle emitted)
can now read lower, or, for a loop whose lives outlast the other emitters,
higher, so re-Saving it may ask for a larger budget; it still loads and plays. Save uses
`PUT /v1/particle-effects/{entry_name}` and atomically replaces the ordinary
Local entry. It never equips the effect to an Anima; Gesture and Reaction
creators reference it as a dependency.

Import takes three.quarks JSON or the creator document Export offers
(`animama/particle-vfx-editor/1`: name, description, settings in the stored
`runtime_defaults.slots.particle_vfx` form, and the Quarks effect). Quarks JSON
keeps the current name and settings and the textures the effect already
carries; a creator document replaces them, so its textures that are neither
embedded nor built in show as missing until their files are chosen. `effects
save` imports this document ([effect tools](avatar-vfx.md#9-effect-tools)).

The left panel separates emitter selection from whole-effect defaults. Name lives
in the header; internal IDs, resource JSON and clip-event snippets are available
in the export dialog. Existing descriptions are retained without a main-editor
field. Preload and performance limits remain available under Advanced settings.
The header validation indicator opens issues that need attention and stays hidden
when there are none.

The Inspector opens on Appearance, followed by Position, Emission, Shape and
Behavior. The selected emitter's name is editable in the panel header.
Emitter cycle duration and looping control each system; Effect playback duration
and the advanced maximum duration bound the entire instance. Allow emitter looping
permits authored loops without removing the instance lifetime or particle budget.
The Preview Timeline pauses, resumes or restarts the isolated creator preview;
it does not author clip events or dependencies.

## Tools

`pnpm -s effects check`, `effects:render` and `animation:preview` take
Particle Effect folders and Library items (`library:particle-effect/…`);
`effects save` takes folders, and `effects promote` folders or
`library:local/<name>` items. `effects:bench --reaction` measures a
Reaction's Particle Effects. See the [effect tools](avatar-vfx.md#9-effect-tools);
the `animama-particle-vfx` skill wraps them into the authoring pipeline.

## Clip Events

`animaPoseClip/2.0` clips support timed particle events:

```json
{
  "id": "bang-1",
  "time": 0.25,
  "kind": "particle_vfx",
  "effectId": "heart-burst",
  "anchor": "head",
  "duration": 2,
  "followAnchor": true,
  "transform": {
    "offset": { "x": 0, "y": 0.2, "z": 0 },
    "depthOffset": 0.2,
    "scale": { "x": 1, "y": 1, "z": 1 }
  }
}
```

`effectId` must be an effective runtime ID mounted for the current Anima. Raw
quarks JSON locators stay behind the authoring provider or the prepared
registered catalog files. An unavailable ID fails locally and is never replaced by a
similarly named built-in effect.

Supported anchors are `root`, `hips`, `spine`, `chest`, `neck`, `head`,
`leftHand`, `rightHand`, `leftFoot`, and `rightFoot`. `transform.offset` is in
avatar-local meters. `transform.depthOffset` is avatar-local Z: positive means
in front of the avatar and negative means behind.

If `duration`, `anchor`, `transform`, or `followAnchor` are omitted, the runtime
uses the catalog defaults and follows the anchor. Requested durations are capped
by each catalog entry's performance budget. `envelope` and
`parameterKeyframes` parse for forward compatibility but are not mapped onto
quarks emitter internals.

Clip-owned particle events are always duration-backed. Manual particle lifetime
is available through explicit runtime/debug calls to
`ParticleVFXController.playEffect({ lifetime: { kind: "manual" } })` for
catalog entries whose budget allows looping. Manual instances still follow
anchors, update quarks batches, report diagnostics, and clear through
`clearEffect`, `clearAll`, avatar unload, or controller disposal, but they do
not expire from elapsed time.

Authored quarks JSON can contain `worldSpace: true` particle systems, especially
when imported from public examples. Animama still spawns those effects at the
selected anchor, but disables continuous anchor follow for that active instance
and records a diagnostic warning. Use local-space emitters for effects that must
stay attached to a moving head, hand, or foot for their full lifetime.

An emitter may override the effect/event anchor through its optional serialized
`userData.animamaParticleAnchor`. Supported values are the same anchors listed
above; missing metadata inherits the effect or clip event anchor. The Inspector's
Inherit option removes the override. Each emitter's authored offset and enclosing
transforms are applied relative to its resolved anchor, while the global transform
continues to affect offsets. Overrides follow independently when anchor following
is enabled; the existing whole-instance world-space safeguard still applies.

“Fit rectangle to avatar” is available when rectangle emitters exist. Its selector
limits fitting to the named rectangle emitters; other shapes are unaffected.
Width/height padding and minimum/maximum sizes are in meters; an omitted maximum
has no limit beyond the runtime safeguards. Fitting changes emission dimensions,
not camera framing or emitter placement. Each emitter keeps its anchor and offset.

Avatar-bounds rectangle fitting is resolved once per play from rendered mesh
bounds. It ignores existing particle roots so active effects do not inflate the
avatar bounds, patches cloned `emitterShape` objects only, and leaves cached
prefabs untouched. If bounds cannot be computed or no matching rectangle
emitter is found, playback retains normal anchor placement and records a
warning.

## Runtime Flow

`PoseController` and `ReactionClipPlayer` dispatch `particle_vfx` events through
the same clip event sink used by avatar VFX, scene VFX, and SFX. `Avatar`
handles those sink callbacks by calling `particleVFXController.playEffect(...)`
with the clip `appliedId`, then clears the same id when the event duration
expires or the clip stops.

The planner selects Reaction clips through the mounted motion catalog
using the equipped emotion/intensity mapping. Particle playback comes from
those clips' `particle_vfx` events. There is no direct `AvatarPlanner`
`particleVfx` lane, so clip-owned particles inherit the same-run Reaction
lifecycle and non-TTS presentation completion policy.

For a Local Particle Effect, Save validation accepts only safe
relative image references and derives bounded system, duration, looping, and
particle-capacity metadata. Runtime loading fetches the private manifest and
exact referenced textures with authorization, enforces the declared sizes and
the 64 MiB package limit, rewrites only those validated image references to
owned Blob URLs, and rejects missing, extra, external, absolute, encoded, or
traversal references. The manifest body is not exposed by the runtime API.

The `presentation.disable_vfx` preference suppresses clip-owned avatar VFX,
scene VFX, and particle VFX from pose and reaction clip playback. Toggling it
off clears currently tracked clip-owned avatar, scene, and particle effects.
Manual/debug particle controls, manual runtime avatar VFX controls, and SFX
events are intentionally unaffected.

The pose creator can import, preserve, validate, preview, create, and edit
particle events. Use the Effect Catalog `Particle` tab to insert an event at
the playhead, then use Event Inspector controls for effect id, timing,
duration, anchor, follow-anchor behavior, local offset, depth offset, rotation,
and scale.

`AnimationDebugModal` keeps the manual runtime Particle VFX surface and also
shows particle runtime state from clip/reaction diagnostics: active count,
loaded count, latest warning or error, lifetime mode, and active applied ids.
It lists every Included Particle Effect; manual lifetime is available for an
effect whose budget allows looping.

The runtime evicts failed JSON load promises so transient asset fetch errors can
be retried, and controller disposal clears active systems, cached prefab
references, quarks batch renderer resources, pending fetches, and owned Blob
URLs. It permits at most four concurrent particle instances and accounts at
most 512 active particles. An effect with `can_coexist=false` clears conflicting
instances before it starts.

Tier-A particle entries preload after the avatar is live through
`ParticleVFXController.preloadCatalogTier("tierA")`. Preload is non-blocking:
failures are diagnostic warnings and do not block avatar readiness or normal
chat runtime behavior. All eager private model/motion/particle work shares a
64 MiB budget per mounted Anima; entries beyond it remain available lazily.

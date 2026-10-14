# Using the Particle Effect creator

Read this for in-app operation, resources, preview, and persistence. Rendering
semantics are in [three-quarks.md](three-quarks.md); playback in Actions is in
[integration.md](integration.md).

## Open and operate the document

In the app, new effects start from the Effects template picker (sidebar Create
→ **Effects**, then **Particle FX**), which offers Start from scratch and the
Included Particle Effects as templates (a template opens an unsaved Local copy
of that effect, textures included, named for example "Heart Burst 1"). Use
`/particle-effects/new` for a blank document and
`/particle-effects/$particleEffectId/edit` for an existing catalog item. The edit
parameter is the item ID, not the Quarks runtime ID or effect name. Use the creator
Load picker or Library entry to obtain the correct item. The route owns an
exclusive preview Canvas and uses the shared creator shell and toolbar.

The toolbar provides document name, New, Load, JSON Import/export, Undo/Redo,
validation feedback, the Simple | Advanced switch, and Save. Every opened
effect starts in **Simple**: the left panel shows its template or name, where
it plays and its layer count; the right panel has Amount, Size, Speed and
Spread (below). Switch to **Advanced** to author emitters: its left panel
manages emitters and whole-effect settings, and its right Inspector operates
on the selected emitter. Selecting a lane in Preview Timeline also selects that
emitter.

**Simple controls** scale the whole effect from a reference (the effect when
Simple was first used after opening or after the last Advanced edit), so
100 % restores it exactly. Amount scales the per-second and per-metre rates
and every burst's count (single-particle layers stay single); Size scales
start sizes; Speed is tempo
(speeds × k, forces × k², lifetimes, cycles, burst times and durations ÷ k);
Spread scales offsets, shape sizes, speeds, forces and noise but not particle
sizes. Each stops, with a note, before the estimate passes 512 particles or a
duration 30 seconds; the declared budget rises with the estimate (up to 512,
never below the reference's). The values
are written into the effect, so Advanced shows them; any Advanced edit resets
Simple to 100 % of the edited effect (renaming does not). Recovery keeps the
positions; Save returns them to 100 % of the saved effect, as reopening does.
Field-by-field rules are in
`editor/simpleControls.ts`. Use Simple for whole-effect tuning and Advanced
for per-emitter authoring; automation that uses emitter or texture controls
must switch to Advanced first, as `effects save` does.

Add starts another emitter; Duplicate copies the selected emitter; Remove cannot
remove the last one through the UI. Rename the selected emitter in the Inspector
header. Applying Pop, Aura, Smoke Fade, Speed Streak, or Sparkle Burst replaces
settings on that emitter; these are authoring presets, not separate saved effects.

## Control map

Advanced's panels:

| Area | Controls and scope |
| --- | --- |
| Settings | Default anchor and whole-effect playback duration |
| Transform | Whole-effect offset in meters, Euler rotation in radians, scale multiplier, depth offset |
| Advanced settings | Preload metadata, maximum duration, declared particle budget, permission for looping emitters, simultaneous-effect policy |
| Appearance | Texture, atlas tiles/frames, initial color, lifetime color, renderer and material settings |
| Position | Emitter cycle duration/looping, anchor override, local XYZ position, world-space simulation |
| Emission | Particle lifetime, initial speed/size/rotation, rates per second/meter, first burst settings |
| Shape | Point/Sphere/Cone/Rectangle and applicable dimensions, arc, thickness, mode, spread, shape speed |
| Behavior | Force XYZ, size toggle, color fade, speed, rotation, 3D rotation, orbit, noise, turbulence, speed limit, trail width |

"Loop this emitter" and "Allow emitter looping" serve different purposes: the
former authors the system; the latter permits looping in the saved runtime budget.
Neither grants unlimited playback. Initial size is in meters, speed in meters per
second, and rotation in radians. Equal range endpoints represent a fixed value.

"Fit rectangle to avatar" appears when rectangle emitters exist. Select which
named emitters it affects and set padding/minimum/optional maximum dimensions in
meters. It changes their emission dimensions, not position or camera framing.

The Behavior color-fade toggle and Appearance lifetime-color controls both affect
Color Over Life. Treat them as views of the same serialized behavior, not two
independent fades. Read the [library limitations](three-quarks.md) before relying
on burst repetitions, soft particles, or freeform size curves.

## Textures and imported resources

The texture picker groups curated entries into Glow, Spark, Smoke/Dust,
Trail/Streak, and Symbol. `textureManifest.ts` owns their IDs, filenames,
recommended rendering, and atlas metadata. The creator does not crop artwork,
remove a background, or split an arbitrary image into meaningful animation frames.

Changing texture resets blending, render mode, U/V tile counts, tile blending,
and Frame Over Life to that texture's recommendations. Set the texture before
making overrides to those fields, or recheck them afterward. For example, Spark
Pop 6×5 has 30 cells but 26 authored frames, so its range is 0–25. Fire 8×8 and
Flame 16×4 have 64 frames with range 0–63.

**Imported textures.** In Advanced, the Inspector's Appearance tab lists *This effect's
textures*: PNGs the effect carries itself. **Import PNG texture** adds one as
`textures/<name>-N.png` and assigns it to the active emitter; any listed
texture can be assigned to the active emitter by clicking it. A texture the
effect refers to without bytes (after a JSON Import, or a reopened effect
whose file is gone) is shown as missing for the emitter that uses it, with
**Choose file for <name>**, which stores the chosen PNG under that existing
reference whatever the file is called. Each texture must be a PNG within
4 MiB and 2048 px per side (16 textures, 32 MiB per effect); a sprite sheet
is one PNG whose U and V tile counts (at most 16 each) you set under Atlas
tiles. Make and check the art with `animama-effect-assets` (`particle-texture`
for one sprite, `particle-sheet` for a sheet) before importing it.

Save packages every texture the effect's images use as a file of the saved
item, built-in curated ones included (copied from the creator's own
`/effects/vfx/particle-vfx/textures/`), so a saved effect is self-contained.
Most curated textures are third-party art (CC0 Kenney and Brackeys, one
CC-BY); promotion keeps their records (see [promote](promote.md)).

Authoring resolves curated previews through same-origin `/effects/vfx/` paths.
Live Anima playback uses registered content files instead; those public authoring
paths are not the runtime dependency contract.

## Preview mechanics

Show or hide the preview Avatar, choose its model, and use the selected emitter's
shape/direction outline to inspect placement. Hiding the Avatar switches to the
emitter-oriented view and bypasses avatar placement; it is not evidence that an
anchor override or rectangle fit works on a VRM.

Edits restart the effect. Preview Timeline can pause, resume, stop, and restart;
its lanes select emitters. It does not author Action events, drag emitter start
times, or provide arbitrary-time particle scrubbing. A burst's Time field is how
the Inspector authors its spawn time.

Preview parses a fresh JSON clone with `QuarksLoader`, registers systems with its
own `BatchedRenderer`, and uses shared placement/anchor/fitting helpers. It does
not run through `ParticleVFXController` admission limits. At the playback duration,
the timeline pauses simulation; it does not demonstrate runtime instance removal.
Validate actual ending and cancellation in Action playback when requested.

## Import, export, and validation

JSON Import accepts a raw Quarks resource object or the creator document
Export offers (`animama/particle-vfx-editor/1`: name, description, settings in
the stored `runtime_defaults.slots.particle_vfx` form, and the Quarks effect).
Raw Quarks JSON keeps the current name and catalog settings, including
placement and performance, and textures this effect already carries; a creator
document replaces both, so its textures that are neither embedded (`data:`
PNG URLs, which become `textures/embedded-N.png`) nor built in show as missing
until their files are chosen. Importing over a dirty document prompts before
replacing it. Unsupported values can be preserved in the draft while still
blocking portable Save.

The export dialog shows the exact Quarks JSON and, under *Creator document,
catalog settings and clip event*, the creator document (Import keeps its name
and settings), a catalog snippet and a clip event snippet. Download exports the
Quarks JSON only; neither bundles texture bytes. The clip snippet uses the
draft runtime ID; use the Action catalog integration to resolve actual mounted
IDs and dependency aliases. `pnpm -s effects save` imports the creator
document and chooses the missing textures for you.

The header exposes validation messages when present. Save also checks the package,
so an enabled Save button or a working preview is not proof of save readiness.
Frontend package limits at the verified baseline are:

| Resource | Limit |
| --- | --- |
| Emitters | 1–16 |
| Object graph | Group/ParticleEmitter nodes; at most 128 nodes |
| Resource arrays | At most 64 entries each in geometries/materials/textures/images |
| Unique textures | 16 |
| Quarks manifest | 5 MiB |
| Each texture | PNG, 4 MiB, 2048 px per side and 2048² px |
| All textures | 32 MiB per effect |
| Sprite sheets | At most 16 tiles in each direction |
| Whole package | 64 MiB |
| Maximum duration | 30 seconds; defaults and emitter durations must fit it |
| Particle budget | Declared budget and Save estimate must fit 512 |

Package texture references must be safe relative paths with resolvable bytes.
Remote, absolute, data, Blob, encoded, or traversal references are not portable
Save inputs. The general editor validator's softer warnings do not override the
package rules.

Advanced's left-panel particle estimate is the one Save enforces (and `effects check`
reports): each emitter's maximum rate over its duration plus all its burst
entries, with a looping emitter counted over the longest emitter's duration.
It is not a measured live count or a complete motion/lifetime model. Do not
increase budgets merely to hide a warning without understanding the fields.

## Save, reopen, and handoff

Save constructs `particle.json`, referenced textures, runtime defaults, and
`animama/particle-vfx-authoring/1` metadata, then uses the typed Local-content save
path. Included entries are read-only templates: editing them saves a Local copy.
Owned entries use revision-aware updates. Successful Save navigates to the edit
route and records a clean document state.

Reopen to verify persisted resources and settings when authoring is requested.
Browser recovery in `useParticleVFXSave` is written during a Save attempt after
package preparation; it is not continuous autosaving of every edit. Save/discard
clears that route's recovery. Preserve the current draft if Save fails and report
the actual error instead of assuming recovery covered earlier preparation failure.

After saving owned content, **Use in…** opens a new Gesture or Reaction with its
item ID and component type. This is the supported handoff to Action composition;
it does not change an Anima's loadout by itself.

## Source navigation

- UI and isolated renderer: `src/frontend/web/src/ui/particle-vfx-creator/ParticleVFXCreatorPage.tsx`.
- Draft/patch behavior: `src/frontend/web/src/lib/avatar/particle-vfx/editor/draft.ts`.
- Simple controls: `src/frontend/web/src/lib/avatar/particle-vfx/editor/simpleControls.ts`
  and `src/frontend/web/src/ui/particle-vfx-creator/ParticleSimplePanels.tsx`.
- Texture defaults: `src/frontend/web/src/lib/avatar/particle-vfx/editor/textureManifest.ts`
  and `textures.ts` in that directory.
- Save rules: `src/frontend/web/src/lib/avatar/particle-vfx/editor/contentReadiness.ts`
  and `src/frontend/web/src/lib/content/particleVFXContentPackage.ts`.
- Persistence/recovery: `src/frontend/web/src/ui/particle-vfx-creator/useParticleVFXSave.ts`.
- Action handoff: `src/frontend/web/src/ui/content-creator/CreatorEffectHandoffActions.tsx`.

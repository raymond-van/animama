# Avatar VFX Guide

An **Avatar Effect** (`avatar_effect` content) is reusable art drawn on or
around an Anima's Avatar: painted onto the face, floating in front of it,
following a body point, placed beside the Avatar as a sticker, or filling its
silhouette. Effects are never equipped directly. A Gesture or Reaction plays
one through an `avatar_vfx` clip event, which owns when it starts and ends and
its fade; the effect owns its art, look and motion. An effect's optional Sound
is a second exact dependency of that Action.

Emitted sprites are [Particle Effects](avatar-particle-vfx.md); backgrounds
and focus lines are [Scene Effects](scene-vfx.md). See
[VRM inspection](vrm-inspector-editor.md) for the debug panel.

## 1) Main files

Frontend paths are relative to `src/frontend/web/src/`.

| Area                   | Files                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Definition contract    | `src/backend/animama/app/contracts/avatar_effect.py` (the one source; generated into `@animama/runtime-contracts`)                                     |
| Parser and limits      | `lib/avatar/vfx/definition.ts`, `effect-image-limits.ts`, `effect-image.ts`, `effectSource.ts`                                                         |
| Runtime                | `lib/avatar/vfx/AvatarVFXController.ts`, `AvatarAttachmentEffects.ts`, `silhouetteOverlay.ts`, `animation.ts`, `types.ts`                              |
| Face parts and anchors | `lib/avatar/vfx/faceParts.ts`, `profiles.ts` (name fallback), `AvatarFaceLandmarks.ts`, `AvatarFaceTextureAnchors.ts`, `lib/avatar/humanoidAnchors.ts` |
| Creator                | `ui/avatar-effect-creator/`, editor document `lib/avatar/vfx/editor/`, shared creator code `ui/content-creator/`                                       |
| Template picker        | `lib/effects/effectTemplates.ts`, `ui/create/EffectTemplatePickerDialog.tsx`, thumbnails `assets/effect-templates/`                                    |
| Conversion             | `src/backend/animama/app/services/avatar_effect_conversion.py`, `scripts/content/convert_avatar_effects.py`                                            |
| Tools                  | `web/scripts/effect-render.mjs`, `effect-thumbnails.mjs`, `effect-bench.mjs`, `animation-preview.mjs`                                                  |

## 2) The `animama/avatar-effect/2` definition

The strict Pydantic models in `app/contracts/avatar_effect.py` define every
field, enum and bound. They type the Avatar Effect API projections, so
`pnpm openapi-ts` generates the TypeScript type and the
`zAvatarEffectDefinitionV2` validator that the runtime and creator use. Do not
copy enums or bounds into frontend code; derive them from the generated types.
Backend Save, typed preview, loadout and package import and export validate with
the same models, and an error names a JSON path such as
`definition.attachment.offset.x`.

```json
{
    "schema": "animama/avatar-effect/2",
    "region": "eyes",
    "attachment": {
        "kind": "face_landmark",
        "landmark": "eyes",
        "side": "right",
        "mirror": true
    },
    "art": {
        "image": "swirl.png",
        "flipbook": { "columns": 4, "rows": 2, "frames": 8, "fps": 12 }
    },
    "appearance": { "opacity": 0.9, "blend": "normal" },
    "motion": { "spin": { "degreesPerSecond": 90 } },
    "faceOptions": { "forceBlink": true }
}
```

- **`attachment`**, by `kind`:
    - `face_surface`: painted onto a face `part` (`face_skin`, `eye_iris`,
      `eye_highlight`, `eyeline`, `eyelash`). `area` `full` or `eyes` covers the
      part's texture layout; `undereye`, `blush` or `mouth` places a decal at a
      face anchor on `face_skin`. Paired areas need `layout` (`single`: one side,
      with `side` and optional `mirror`; `span`: one image across both sides).
      `mode` is `overlay` or `replace` (decals are overlay only). `pivot` is the
      image point placed on a decal's anchor. `offset` is in fractions of the
      texture.
    - `face_landmark`: a plane in front of the `eyes`, `mouth`, `forehead`, `top`
      or `top_edge`, with `position` (`left`, `middle`, `right`, and the
      `top_edge` corners) for the last three. `offset` is in metres in the
      Avatar's front frame at the head (+x toward the viewer's right when
      facing the Avatar, +y up, +z forward, on VRM 0 and 1); `rotationDeg` has
      x, y and z, and keyframe offsets use the same frame.
    - `body`, `sticker` and `silhouette`: see [Attachments beyond the
      face](#6-attachments-beyond-the-face).

    Rotations are degrees. A mirrored copy (an eye or cheek drawn on the other
    side) mirrors its horizontal offset.

- **`art`**: `image`; `otherEyeImage`, drawn unmirrored by the mirrored copy,
  so asymmetric designs such as a wink need one effect (only with a mirrored
  eye or paired face placement); and `flipbook`: frames left to right, top to
  bottom on a `columns` × `rows` grid, with `fps` and `loop` (`loop`, `once`,
  `pingpong`).
- **`appearance`**: `opacity`, an optional `#rrggbb` multiplicative `tint` and
  `blend` (`normal`, `additive`, `multiply`). A `replace` surface below full
  opacity shows the original texture beneath it.
- **`motion`**: the `pulse`, `spin` and `drift` presets (a preset is on when
  present) and `keyframes`: `frames`, each with a time `t` and optional
  `opacity`, `scale`, `rotationDeg` and `offset`, plus `loop`, on the effect's
  own timeline. Keyframe scale and opacity multiply the presets; rotation and
  offset add.
- **`faceOptions`**, accepted only where the renderer honours them:
  `forceBlink`, `hideEyeDetails`, `faceCleanup`, `skinBackdrop` and `hideParts`
  on an eye landmark; `faceCleanup` and `skinBackdrop` on a mouth landmark;
  `faceCleanup` on a mouth decal; `hideParts` on a `full` or `eyes` surface.
  `forceBlink`, `hideEyeDetails` and `faceCleanup` default on where they apply;
  `skinBackdrop` defaults off.
- **`region`**: the replacement group (see [Coexistence](#coexistence)). Face
  attachments use `eyes`, `undereye`, `blush`, `mouth`, `emote` or
  `full_face`; the other attachments use their own kind.
- **`soundAlias`**: an optional root-local Sound dependency alias. Built-in
  effects name an `optional` Sound dependency from the private
  [comedy sound pack](../../backend/operations/comedy-sound-pack.md); the
  Included scan drops it, with the alias, when the pack isn't installed.

The runtime maps image names and the Sound alias through the exact catalog
revision's file and dependency maps. There is no bundled Avatar Effect catalog:
a `runtime_catalog` source reports `avatar_vfx_source_unsupported`, and an
unknown runtime ID fails without a fallback.

### Converting `/1`

Only `/2` is accepted. A `/1` definition is refused at Save, preview, loadout,
package import and in the frontend parser with
`avatar_effect_conversion_required` and a hint; API lists show such an item with
`definition: null` and `definition_error`.

- **Local library:** `/1` effects convert in place at startup, on
  `POST /v1/content:rescan`, or with
  `uv run python -m animama.server.content_cli`. The folder, content ID and
  files are kept, and the original bytes are retained in the transition
  journal. An effect that cannot convert stays invalid with
  `avatar_effect_conversion_failed` in Content Health.
- **Descriptor folders** outside the Local library, such as Included content:
  `uv run python scripts/content/convert_avatar_effects.py --write <folder>`
  from the repository root. Without `--write` it is a dry run. It rewrites only
  `definition` and leaves converted descriptors unchanged.
- **Packages** cannot be converted: their manifest, sizes and digests cover the
  original bytes. Convert the source content in the exporting installation and
  export again.

A Local `/1` eye effect with a mirrored placement and a nonzero
`transform.offset.x` now mirrors that offset on the other eye; `/1` shifted
both eyes the same way. The transition logs `avatar_effect_offset_mirrored` and
the script prints a note. No Included effect is affected.

### Limits

Definitions and images are untrusted. They are bounded before decoding or GPU
upload:

| What                                        | Limit                                                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Image                                       | 16 MiB; 4096 px per side and 16.7 M pixels, read from the PNG, JPEG or WebP header before decoding and checked again after |
| Definition                                  | 64 KiB serialized                                                                                                          |
| Flipbook                                    | grid at most 16 × 16, at most 256 frames, at most 60 fps                                                                   |
| Keyframes                                   | at most 64, `t` at most 600 s                                                                                              |
| Scale                                       | at most 20                                                                                                                 |
| Rotation                                    | ±3600°                                                                                                                     |
| Active body, sticker and silhouette effects | 4                                                                                                                          |

The backend stores effect images unresized (it admits up to 16,384 px), so the
creator refuses an oversized image when it is chosen, and an imported or
hand-placed Local image over the limit fails when it loads: the effect is
skipped with a diagnostic.

## 3) Runtime flow

1. `Avatar.load` detects the face parts (`detectAvatarFaceParts`), applies the
   Avatar's saved correction, then builds `AvatarFaceLandmarks`,
   `AvatarFaceTextureAnchors` and `AvatarVFXController`.
2. The controller scans the live primitive bindings
   (`buildRuntimePrimitiveBindings`, keyed `node:mesh:primitive`) and assigns
   them roles from the part map.
3. `parseAvatarEffectDefinition` validates a definition with the generated zod
   schema and normalizes it into an internal entry. Face attachments keep the
   older internal names, which the controller and debug snapshots use:

    | `/2` attachment                         | Internal entry                     | Surface                          |
    | --------------------------------------- | ---------------------------------- | -------------------------------- |
    | `face_landmark` eyes, mouth             | `hover` `eye_hover`, `mouth_hover` | plane in front of the face       |
    | `face_landmark` forehead, top, top edge | `hover` `box_hover`                | plane in front of the face       |
    | `face_surface` undereye, blush, mouth   | `face_anchored`                    | composite texture on `face_skin` |
    | `face_surface` full, eyes               | `texture`                          | composite texture on the part    |
    | `body`, `sticker`, `silhouette`         | attachment entry                   | `AvatarAttachmentEffects`        |

4. The mounted catalog loads the images (one Blob URL per image, revoked when
   the catalog is disposed) and the controller applies the entry through
   `applyTextureVFX`, `applyFaceAnchoredVFX`, `applyHoverVFX` or
   `applyAttachmentVFX`; `applyAvatarVFXEffectById` chooses one. Stale async
   results are discarded.
5. Animated effects update on the controller's 30 FPS tick: planes change their
   transforms, and animated composites redraw and re-upload their texture.

Effects apply to live primitive usages, not to shared material definitions.
Clip-owned applied IDs are namespaced by clip and event, so cleanup removes
only the effects that clip started. `presentation.disable_vfx` suppresses
clip-owned effects.

## 4) Face effects

### Painted effects (`face_surface`)

Composites clone the runtime material of each affected primitive once and draw
one composite canvas per active slot (`map` and, when present,
`shadeMultiplyTexture`). Full-surface layers draw first, then anchored decals;
within a kind, later applies draw on top. Re-applying the same applied ID
replaces that instance.

- **`full` and `eyes`** use the part's texture layout, so full-face art must
  match the Avatar's UV layout. `hideParts` hides other detected parts while
  the effect is active.
- **Decals** (`undereye`, `blush`, `mouth`) are placed at UV anchors that
  `AvatarFaceTextureAnchors` computes at load: a 3D landmark is projected onto
  the `face_skin` mesh and its UV is interpolated. The anchor sets position,
  pivot and reference size; it does not clip the art, so a tear can run below
  the eye. `span` stretches one image across both anchors; use it only for art
  drawn that way.

### Floating effects (`face_landmark`)

Planes are parented to the normalized head bone (render order 950, depth tested,
so hair can hide them). Normalized bones keep the model's axes (VRM 1 faces +Z,
VRM 0 faces −Z), so each placement turns to face the front, and its offset,
rotation and motion apply in that turned frame. The creator measures drags in
the same frame, so a drag stores the same value on either Avatar. Eye planes
sit just in front of the iris landmarks; mouth planes start at the projected
mouth point, sized from its anchor; forehead and top planes use positions around
the face bounds, clear of detected hair.

Eye planes default to closing the eyes (`forceBlink` holds `blink` at 1 at full intensity; a fading event weights it, see the fades section),
hiding eye highlights, lines and lashes (`hideEyeDetails`) and cleaning up the
painted eye area (`faceCleanup`). `skinBackdrop`, off by default, adds a
skin-coloured plane behind eye or mouth art (render order 949).

### Face cleanup

`faceCleanup` (eye planes, mouth planes and mouth decals) runs a flatten pass
on the `face_skin` composite: the controller samples the average skin colour
from a central patch and paints soft ellipses over the painted eyes or mouth
before other layers draw. It never edits the VRM. One effect turning cleanup
off does not cancel another's request. `skinBackdrop` uses the same sampled
colour. `setFaceFlattenPreview` shows the pass in debug tools.

### Coexistence

Face effects with the same `region` replace each other for `eyes`, `undereye`,
`blush` and `mouth`; `emote` and `full_face` effects stack. Region decides
replacement only, not placement: a mark above the head saved with region `eyes`
still replaces eye effects. Body, sticker and silhouette effects coexist with
face effects and with each other (see below).

## 5) Face parts

Effects find the face from VRM signals rather than material names, which the
VRM specification does not define. `detectAvatarFaceParts`
(`lib/avatar/vfx/faceParts.ts`) reports these parts:

| Part                             | Signal                                                                                                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eye_left`, `eye_right` (irises) | Primitives with at least half their skin weight on the humanoid `leftEye`/`rightEye` bones (or whose material a look-at expression moves through a texture transform). Iris, white and highlight are told apart by projected area and depth. One primitive may hold both eyes. |
| `face_skin`                      | The head-skinned primitive of the mesh that both `blink` and `aa` morph, with the most area around the eyes.                                                                                                                                                                   |
| `eye_highlight`                  | Separated from the iris by size and depth.                                                                                                                                                                                                                                     |
| `eyeline`, `eyelash`             | Small primitives of the face mesh that `blink` moves almost entirely; the larger is the eye line.                                                                                                                                                                              |
| `hair`                           | Primitives in the head subtree with a real share of spring-joint weight (used to keep forehead and top planes clear).                                                                                                                                                          |

Each part reports its `node:mesh:primitive` bindings, a source (`signals`,
`names`, `corrected` or `missing`) and a confidence. Material and node names
(`profiles.ts`) are a fallback per part; if detection itself fails, the Avatar
still loads with name matching and logs `avatar_face_parts_detection_failed`.
Detection takes a few milliseconds per Avatar and never writes world matrices.

### Corrections

A user corrects a part in the creator's [Face parts panel](#face-parts-panel).
The correction is an `animama/avatar-face-parts/1` document
(`app/contracts/avatar_face_parts.py`): primitive keys for `face_skin`,
`eye_left` and `eye_right`, optional keys for the other parts (an empty list
marks a part absent), and the VRM file's `vrm_sha256`.

- **Local Avatars** store it as `face_parts` in their `.meta.json` sidecar, so
  saving one creates a new Avatar revision.
- **Included Avatars** are never written. Each owner's correction is a row in
  the `avatar_face_part_overrides` table, bound to the Avatar revision it was
  saved against and ignored once that revision changes.
- `GET` and `PUT /v1/avatar-content/{item_id}/face-parts` read and save the
  effective value with an expected revision. Typed Avatar responses and the
  runtime snapshot's `avatar` carry it, and packages carry it with the Avatar.
  See the backend's [face-part
  corrections](../../backend/features/custom-animas-and-content.md#face-part-corrections).

Primitive keys are stable only for identical VRM bytes. A correction whose
`vrm_sha256` does not match the loaded file is ignored with a diagnostic, so it
never applies to a different model; clearing it restores detection. The chat
canvas passes the correction and the VRM digest to `Avatar.load`;
`Avatar.setFacePartCorrections` rebuilds the parts, landmarks, anchors and
bindings and re-applies the active effects.

One mesh can hold several parts: Annie's eyelashes, for example, are drawn in
her eye-line mesh. Each binding therefore serves every role whose part lists
it, and an effect on any of those roles uses it. A part the user changed comes
first, so it is the binding's primary role, and correcting Eyelashes to the
eye-line mesh paints eyelash effects there while eye-line effects still work.
Hiding eye details never hides a mesh that is also face skin or an iris.

### Missing parts

An effect whose part is missing (face skin for every face effect, the covered
eye for an eye plane, the painted part for a surface effect) is not applied.
The controller logs one `avatar_effect_face_part_unavailable` warning per
effect and part and lists it in its snapshot warnings, which the VRM debug
panel shows. In chat, the Gesture or Reaction continues without the effect. The
creator names the missing part on its stage and toolbar.

## 6) Attachments beyond the face

Body, sticker and silhouette effects need no face part. They follow the Avatar
through Gestures, Reactions and idle motion, and `AvatarVFXController`
delegates them to `AvatarAttachmentEffects`.

- **`body`**: a plane on a humanoid point (`root`, `hips`, `spine`, `chest`,
  `neck`, `head`, hands or feet), parented to the normalized bone.
  `resolveHumanoidAnchorObject` uses the same fallback chain as Particle Effect
  anchors (for example `chest` → `upperChest` → `spine` → `hips`). `offset` is
  in metres in the bone's frame (+x toward the viewer's right when facing the
  Avatar, +y up, +z forward, on VRM 0 and 1); `size` is the plane height in
  metres. It faces each camera (`facing: "camera"`) or keeps the bone's
  orientation (`"bone"`).
- **`sticker`**: a camera-facing image beside the head (`around: "head"`) or
  the body centre (between the hips and head). `size` and the screen-plane
  `offset` are fractions of the Avatar's height, measured at load from the bind
  pose, so stickers stay readable on any model. They ignore depth (render order
  960), so the Avatar never hides them.
- **`silhouette`**: art drawn only over the Avatar's visible pixels. Each
  depth-writing primitive gets an overlay mesh sharing its geometry, skeleton
  and live morph weights (render order 940, `LessEqual` depth with a small
  polygon offset). It honours the original material's alpha cutout and changes
  no material or canvas option. MToon outlines and layers that write no depth
  (irises, highlights, brows, eye lines, lashes) get no overlay.
  `fill: "pattern"` tiles the art in screen space from the hips (at
  `patternScale` 1 a tile is a quarter of the Avatar's on-screen height, so
  tileable art works best) and `scroll` moves it in tiles per second;
  `fill: "tint"` fills with the art's alpha-weighted average colour times
  `appearance.tint`.

Appearance, flipbooks, keyframes and event fades apply to all three. At most
four are active (`MAX_ACTIVE_ATTACHMENT_EFFECTS`); applying a fifth removes the
oldest and logs `avatar_effect_attachment_limit`. An attachment and a face
effect with the same applied ID replace each other. Attachments survive a
face-part correction and are disposed by `removeEffect`, `clearAllEffects`,
clip cleanup and `presentation.disable_vfx`.

## 7) Timing, fades and motion

The effect owns its own motion: presets, keyframes and flipbook frames run on
its own timeline from the moment it applies. Pulse multiplies scale; spin
below one turn rocks back and forth and otherwise wraps; drift moves
continuously, in fractions of the art's size per second, with no return.
Planes animate their transforms; composites redraw around each placement's own
centre. Flipbooks on planes move texture `repeat`/`offset` without a
re-upload; composites draw one frame through a source rectangle.

The Gesture or Reaction event owns start, end and fade. For an `avatar_vfx`
event whose End is **After** a duration, the clip inspector's **Fade in** and
**Fade out** (seconds) write `envelope.intensity`. `PoseController` and
`ReactionClipPlayer` sample it each frame and pass it through the Avatar's clip
sink (`setAvatarVFXIntensity`) to `AvatarVFXController.setEffectIntensity`,
which multiplies the art's and the skin backing's opacity; a value that
arrives while the effect is loading is held until it applies. The effect's face
changes follow the same value: **Close the eyes** blinks by it, and hidden face
parts and face cleanup switch on and off at half intensity, so a fading eye
effect never shows bare eye sockets under faint art. The Gesture and Reaction
creator's preview samples the envelope too, while playing and when paused.
Events that end **With Action** do not fade. Parameter
keyframes are not supported for Avatar Effects.

## 8) Creator

### Starting an effect

The sidebar Create menu's **Effects** item, the Create page's effect cards and
`/effects/new` open the Effects template picker. Step 1 chooses Particle FX,
Avatar FX or Scene FX; step 2 offers **Start from scratch** and that kind's
templates, with Back. The templates are listed in
`lib/effects/effectTemplates.ts`, each with a thumbnail rendered on the
Included Avatar Annie: the 16 Included Particle Effects by mechanic (Bursts,
Streams and auras, Orbits and drifts, Fireworks, Weather), the Included Avatar
Effects grouped as Eyes, Cheeks, Whole face, Around the head, Mouth and Body,
and the 24 Included Scene backgrounds by family plus the two focus-line
presets. Choosing an Avatar FX template opens
`/avatar-effects/new?template=<id>`, which
copies the Included effect into a new, unsaved Local draft with an unused name;
Save creates a separate Local item and never changes the Included one.
`/avatar-effects/new` and `/avatar-effects/:avatarEffectId/edit` remain the
creator routes, and Library Edit links open the second.

Save, recovery, undo and the leave guard are shared with the Particle and Scene
creators (see [local content runtime](../architecture/local-content-runtime.md)).
Save replaces the Local entry through `PUT /v1/avatar-effects/{entry_name}`
after backend validation. A rejected field opens the tab holding its control
and outlines it. Drafts in the earlier editor format are dropped with a notice.

### Controls

The editor document (`animama/avatar-effect-editor/2`, the creator's JSON
export) mirrors the `/2` definition and keeps images as metadata and digests;
`File`s, Blob URLs and live `Avatar` objects stay outside it.

- **Effect Setup** (left): **Attach to** (Floating on the face, Painted on the
  face, On the body, Sticker beside the avatar, Fill the silhouette), then only
  that attachment's fields in plain words: **Where**, **Position**, **Which
  eyes** or **Which side**, **Art is drawn for the**, **Where on the face**,
  **Paint on**, **Image point placed on the face**, **Keep the original
  underneath**, **Body point**, **Always face the camera**, **Beside the** or
  **Fill**. Below them are **Image**, **Other side image**, **Animated sprite
  sheet**, the face options the attachment honours (**Close the eyes**, **Hide
  eye details**, **Clean up the eye area** or **mouth area**, **Skin-coloured
  backing**, **Hide other face parts**), **Sound when applied**,
  **Description** and **Advanced → Replaces** (the region; Automatic follows
  the attachment, and a manual choice is kept while it still suits it).
- **Inspector** (right): **Placement** shows only the axes that apply, in
  centimetres, percent of the texture or percent of the Avatar's height, with
  size, **Rotation (°)** and, for floating art, tilt; **Look** has opacity,
  tint and blend (Normal, Glow, Shade); **Motion** has Pulse, Spin (°/s),
  Drift and a keyframe list.
- **Preview controls**: **Model** (both Included Avatars and the active
  Anima's model), **View** (Face, Three-quarter, Portrait, Full body), Play,
  Stop, Restart, **Guides**, **UV preview** and **Face parts**. An effect
  opens in a View that frames its art (`avatarEffectInitialView`: Portrait
  for art above the head, on the forehead, on the body or beside the Avatar),
  and Save keeps the Model and View. The header
  holds the name, New, Import, JSON, Save and, once a Local item exists, **Use
  in… → Use in a Gesture** or **Use in a Reaction**.

### Direct manipulation

Drag the art on the preview to place it: across the face for painted art (a
`Raycaster` finds the UV under the pointer, `meshUvLocator.ts`), in the head or
bone plane for floating and body art, and in the screen plane for stickers.
Corner handles resize and the round handle turns; art drawn smaller than
32 px gets its handles on a 32 px box, and a press up to 12 px outside the art
still moves it rather than turning the camera. Each drag is one undo step,
and with the preview focused the arrow keys nudge the art (Shift moves
further). Placement edits reach the preview through
`AvatarVFXController.updateEffectTransform` without reloading the image
(composites redraw at most 30 times a second), and the Placement fields follow.
Other edits re-apply the effect.

**Guides** marks the placement basis with open circles and faint lines and
outlines the whole image rectangle, including transparent padding, in pink.
Left and right are the Avatar's sides. **UV preview** shows the selected part's
live texture and the art's footprint; **Skin coverage** shows the cleanup
regions and the sampled skin patch. Guides affect only the preview.

### Face parts panel

**Face parts** lists the selected Avatar's parts with their status: Detected
with a confidence, uncertain (found by name or below 70%), Corrected (only a
part the user changed; a saved correction also pins the required parts at
their detected values) or Missing. **Edit** a part, then tick its mesh parts in
the list or choose **Pick on the avatar** and click the Avatar. **Save correction** stores it with the
Avatar through the face-parts route and rebuilds the preview, and **Use detected
parts** removes it. A draft correction belongs to the Avatar it was made on and
is discarded when the model changes.

## 9) Effect tools

`effects:assets`, `effects check`, `save` and `promote`, `effects:render` and
`animation:preview` take Avatar, Particle and Scene Effects; picker thumbnails
are Avatar-only, and `effects:bench` measures Avatar Effects or, with
`--reaction`, a Reaction's three kinds. The `animama-avatar-vfx`,
`animama-particle-vfx` and `animama-scene-vfx` skills wrap them into each
kind's authoring pipeline. Run them from `src/frontend/web`. Only `effects
save` needs a running stack; `library:local/...` sources need its record
sourced (or `--local-content`).

### Effect art

`pnpm -s effects:assets` checks and repairs effect images, from any source:

```bash
pnpm -s effects:assets check art/*.png --budget landmark
pnpm -s effects:assets fix art/drop-src.png --out art/drop.png --remove-background --trim --pad 8 --square --budget landmark
pnpm -s effects:assets flipbook frames/*.png --out art/steam.png --cell 256 --fps 10
pnpm -s effects:assets preview art/drop.png --out /tmp/drop-preview.png
```

- `check` fails art with no real transparency (Scene tiles and backgrounds may
  be opaque), a painted checkerboard, no visible pixels, or sizes over the
  app's limits or the named budget. It warns
  about a flat backdrop, near-opaque alpha (250–254, common in generated
  images), faint alpha noise, see-through patches inside floating art and wide
  margins. An unreadable file fails as `unreadable` without stopping a batch.
- `fix` removes a painted backdrop, trims, shrinks to the budget, pads (in
  output pixels), clears faint alpha, raises near-opaque alpha to 255 and bleeds
  edge colour into transparent pixels so texture filtering shows no fringe. It
  never overwrites its input. Art whose margins place it keeps its size and
  margins, and `fix` refuses `--trim`, `--square` and `--pad` for it:
  face-surface art (`--budget surface`) lies over the face texture's UV
  layout, and a Scene tile's or background's margins are its spacing and
  framing. Only art placed by its own framing (iris and decal art) is
  reframed, with `--canvas`.
- `flipbook` lays frames out left to right, top to bottom, within the grid
  limits, fitting them into `--cell` when sizes differ and settling their alpha
  after resampling, and prints the `art.flipbook` fragment. `--trim` crops
  every frame to one shared box so the frames stay aligned.
- `fix --canvas <px> --art-size <px>` trims the art, scales it and centres it
  on a fixed canvas, the framing painted iris and decal art is placed by.
- `preview` shows the art on dark, light and checkered backdrops.

Budgets (longest side and file size):

| Budget | Use | Size |
| --- | --- | --- |
| `landmark`, `body`, `sticker` | Avatar Effect art floating at the face, on a body point or beside the Avatar | 512 px, 256 KiB |
| `surface`, `silhouette` | Painted on the face (keeps its layout); silhouette overlay | 1024 px, 512 KiB |
| `flipbook` | A whole Avatar Effect flipbook sheet | 2048 px, 1024 KiB |
| `particle-texture` | One Particle sprite | 1024 px, 512 KiB |
| `particle-sheet` | A Particle sprite sheet | 2048 px, 2048 KiB |
| `scene-sticker` | A Scene marquee or scatter item | 512 px, 256 KiB |
| `scene-tile` | A repeating Scene tile (may be opaque; keeps its margins) | 512 px, 256 KiB |
| `scene-background` | A full Scene background (may be opaque; keeps its framing) | 2048 px, 1024 KiB |

Particle budgets also apply the Particle texture limits, and Scene budgets
the Scene image limits, instead of the Avatar Effect image limits. The
`animama-effect-assets` skill wraps these steps around optional image
generation.

### Check, save and promote

`pnpm -s effects` carries an effect source from a draft folder to Local and
Included content, like `pnpm -s animation` for Gestures:

```bash
source ../../../.animama-stack.env   # for library:local/... and save
pnpm -s effects check ./sweat-drop library:local/Blush
pnpm -s effects save ./items.json
pnpm -s effects promote ./promote.json --dry-run
```

- `check` runs the art through `effects:assets check` with its budget (an
  Avatar Effect's attachment; a Particle texture's `particle-texture`, or
  `particle-sheet` when an emitter tiles it; a Scene's PNG tile against
  `scene-tile` and PNG items against `scene-sticker`, other Scene formats
  being left to the backend), parses the definition as the runtime does
  (naming the field), applies it on both Included Avatars (a controller
  warning, such as a missing face part, fails) and renders each time and view
  with the effect and against a baseline (for face effects, the same effect
  with transparent stand-in images, so closed eyes and face cleanup are in
  both): the art must show on every Avatar in some frame. A Particle Effect
  also gets Save's readiness rules and its estimate of particles alive at
  once against its declared budget and the 512-particle limit, and fails an
  own texture named like a built-in creator texture (Save would keep the
  built-in art); a Scene Effect
  gets the shared Scene limits and its image list. Each check prints a PASS
  or its problems. `--times` defaults to 0.25 s and 1 s.
  `--with-clip <clip.json|Gesture folder|library:<gesture>>` poses both
  Avatars with that Gesture at each time (resolved as for `effects:render`),
  so art on a hand or other moving bone is checked where the Gesture puts it.
  It exits 1 on any FAIL.
- `save` takes `[{ "source", "name"?, "description"? }]` and saves each
  Avatar, Particle or Scene Effect source through its own creator in headless
  Chromium: it imports the creator document (for a Particle Effect, the
  `animama/particle-vfx-editor/1` document, which carries the settings),
  chooses the images (the Avatar art; each Particle texture the creator
  reports missing, built-in textures excepted; each Scene image, named as the
  creator names it), saves, reads the item back and compares the definition
  or settings and Quarks effect and every image's bytes with the source, then
  reopens it. A Local effect of the same kind and name is revised. Names must
  be valid Local names (letters, digits, spaces, `.`, `_`, `-`); it prints the
  Local folder each name saves to. Effects with a sound are saved by hand.
  `ANIMAMA_EFFECT_SAVE_STACK=1 node --test scripts/effect-save.stack.test.mjs`
  exercises Particle and Scene saves against the sourced stack and deletes
  what it saved.
- `promote` writes owner-approved items into Included content: `add` (new
  stem), `replace` (keeps the folder, content ID, version and name; a Scene
  also keeps its kind) or `delete` (refused while Included content depends on
  it). `"kind"` is `avatar_effect` (the default, `vfx/avatar/<stem>/`),
  `particle_effect` (`vfx/particle/quark/<stem>/`, ID
  `builtin:particle-effect:<stem>`) or `scene_effect` (`vfx/scene/<stem>/`, ID
  `builtin:scene-effect:background|focus:<stem>`). Sources are
  `library:local/<name>` of that kind from the sourced stack, or a folder;
  file names must be plain, Scene art must be PNG and effects with a sound
  are refused. It validates each source as `check` does (definition or
  settings, particle budget, Scene limits) and re-checks the art against its
  budget. New art is owner-authored: Avatar files fall under the
  `vfx/avatar/**/*` licence rule and Scene PNGs under `vfx/scene/**/*.png`,
  and each promoted Particle Effect gets its own `vfx/particle/quark/<stem>/**`
  rule ahead of the generated-art rule, removed again by its delete. Every
  written file gets a `licenses/source-review.json` record in the Avatar
  Effect form, except a file whose bytes repeat third-party Included art
  (such as a built-in creator texture, which the creator's Save copies): it
  keeps that file's record and, in a rule for the copy, its licence terms.
  Deleted files lose their records and rules, and a removed or replaced
  third-party record is reported so its evidence can be updated. Particle
  textures sit at most one folder deep (`textures/<name>.png`).
  Templates, thumbnails and pinned tests are updated separately.
- The same run can `replace` the Reactions and Gestures that use the
  effects (`"kind": "reaction" | "gesture"`), from a creator project file
  (`animamaActionProject/1.0`) holding the Included clip with its effect
  events changed and dependencies that each carry a `ref` (a creator export
  renames the clip and has no `ref`). It keeps the Included meta and the clip's id,
  role and lifetime, keeps Reactions expression-only, re-points dependencies
  on Local effects promoted in the run to their Included IDs, and refuses a
  dependency that is not Included content of its declared type afterwards or
  an event whose effect, scene or sound no dependency declares. A delete is
  checked against dependents after the run's replacements, so an effect and
  its last users can change together.

`library:local/...` sources read `ANIMAMA_LOCAL_CONTENT_HOST_PATH`, set by
sourcing the stack record, unless `--local-content` is given.

### Review renders

`pnpm -s effects:render` renders effects on both Included Avatars in headless
Chromium (SwiftShader) with the chat canvas settings (ACES Filmic, sRGB, the
default scene lights), stepping fixed 60 Hz frames with automatic animation
off, so renders are deterministic (a Reaction that starts two Particle Effects
in one frame can still differ by a few pixels between runs):

```bash
pnpm -s effects:render ./my-effect --out /tmp/my-effect.png
pnpm -s effects:render --all-included --out /tmp/effect-sheets
pnpm -s effects:render ./heart ./doki ./stripes --together --with-clip library:soldier-salute --out /tmp/follow
pnpm -s effects:render ./my-effect --thumbnail /tmp/my-effect.webp
pnpm -s effects:render --diff before.png after.png --out diff.png
```

- A source is an Avatar, Particle or Scene effect folder, a descriptor `.json`
  or `library:[particle-effect/|scene-effect/][included/|local/]<stem|content_id|name>`
  (without a kind, an Avatar Effect); `library:local/…` needs
  `--local-content <content root>`. Scene Effects show behind and in front of
  the Avatar as in chat.
- Rows are times after applying (`--times`, default 0.1, 0.5, 1 and 2 s);
  each Avatar gets front, ¾ and face tiles (`--views`, `--tile`).
  `--expression` holds a VRM expression, `--with-clip` plays a Gesture or
  Reaction clip at the same times; a Library item or folder plays its Avatar,
  Particle and Scene effect events as in chat and renders without sources (a
  bare clip `.json` has no dependencies, so its effect events are skipped
  with a warning), and
  `--together` applies every source on one sheet.
- The run exits 1 when an effect leaves a controller warning or no active
  effect.
- `--all-included` renders every Included Avatar Effect. `--thumbnail`
  renders an Avatar Effect on Annie with the portrait head framing, keeping
  the effect's own expression state.
- `--diff` counts a pixel when a channel changes by more than `--threshold`
  (default 8 of 255) and writes a diff image. The same source and revision diff
  to 0 pixels.

`pnpm -s effects:thumbnails [--kind avatar|particle|scene] [template-id...]`
regenerates the picker's thumbnails (320 px WebP, 1 s after applying, or at
the template's `thumbnail.time`) into `src/assets/effect-templates/` (Avatar
FX at the top level, Particle and Scene FX in `particle/` and `scene/`) and
removes files for templates that no longer exist, only in the folders of the
kinds it rendered. Particle and Scene FX are captured through the review stage
(seeded particles, Scene layers composited), each in a freshly loaded page
with CPU rasterization so reruns are byte-identical; a
`thumbnail.framing: "head"` template is framed closer with room above the
head. For Avatar FX, a `thumbnail.framing: "wide"` template is framed wider to
show chest or side art, and `"body"` is framed from the head to the upper
thighs, centred on the torso, for art at the belly, hips or a lowered hand. For art attached to a
hand, which hangs out of frame in the rest pose, set `thumbnail.clip` to an
Included Gesture's folder stem with wide framing: Annie is posed by that
Gesture sampled at the thumbnail time, with the effect applied at 0, as
`--with-clip` does (for example `idea_bulb_fingertip` uses `have-an-idea` at
3 s). Run it after changing the
template list or an Included effect it uses, review the images, and keep that
folder's README provenance current.

### Headed preview

`pnpm -s animation:preview` reviews an effect live on both Included Avatars in
the system browser, with the motion preview's camera presets (Front, ¾, Side,
Face and Portrait, the chat's Portrait preset at the rest head, as the review
renders frame it), transport and review notes:

```bash
pnpm -s animation:preview ./my-effect                # folder or descriptor .json
pnpm -s animation:preview library:avatar-effect/eye_confused_swirl --duration 2
pnpm -s animation:preview library:particle-effect/hearts-v1
pnpm -s animation:preview library:scene-effect/scene-vfx-emotion-joy
pnpm -s animation:preview library:included/joy-3   # a Reaction with its effects
```

- An effect source is resolved like `effects:render`'s. An Avatar Effect is
  parsed with the `/2` parser and applied through `applyAvatarVFXEffectById`;
  a Particle Effect plays through the Avatar's particle controller; a Scene
  Effect is drawn in the view's Scene layers, behind and in front of the
  Avatar as chat draws them. A field-level problem is shown while the last
  valid version keeps playing.
- It re-applies every 4 s, on its own cycle beside a longer Compare row; a
  Particle Effect repeats 0.5 s after its default lifetime ends, and a Scene
  Effect with its own duration 0.5 s after that. `--duration <s>` keeps it that long, removes it
  for 0.5 s and repeats. Seeking re-applies it and steps its frames to the
  chosen time. Scene animations follow the playhead, so pausing and scrubbing
  hold them too.
- Keep each effect descriptor in its own `<stem>/` folder. The preview watches
  that folder recursively, so a new or changed image, manifest or texture
  reloads the effect at once, and unrelated files in a shared folder would
  reload it too. The version covers the bytes of every file the effect plays,
  so a reload with no change does nothing.
- The picker's **Effect sources** list the named effect folders and every
  other effect folder beside them, so one preview reviews a batch of drafts.
- Notes go beside the effect's folder (`my-effect.review.json`). For anything
  inside Library content (under the Included or Local root, a `vfx/avatar/`,
  `vfx/scene/` or `vfx/particle/[quark/]` item folder, or a `<stem>/` folder
  holding `<stem>.meta.json`) they go in the working directory, because the
  content scanner would count them as item files.
- A Library Gesture or Reaction, or a project file, plays its Avatar,
  Particle and Scene Effects with their fades, resolved from its dependencies.
  The **Effect warnings** panel lists what it cannot play (sounds, unresolved
  aliases), controller warnings, failed clip events (such as a Scene event
  whose dependency is the other Scene kind) and skipped face parts.

### Frame-cost benchmark

`pnpm -s effects:bench` measures frame cost on the development machine's GPU.
It plays a looping Gesture on a chat-equivalent canvas (800 × 600 at DPR 2,
antialiasing, ACES) and times `avatar.update` plus render on the CPU, and the
render on the GPU (`EXT_disjoint_timer_query_webgl2`), per Included Avatar,
with no effects and with a heavy combination (an animated full-face texture, an
animated eye plane, a body effect and a silhouette). The scenarios alternate
over `--rounds` passes, and GPU samples voided by a disjoint event are dropped
and counted. The budget is a mean added frame time of at most 2 ms. A software
WebGL renderer is refused. Options: `--frames`, `--warmup`, `--rounds`,
`--clip`, `--effects`, `--headed`, `--json <file>`.

`--reaction <path|library:reaction/...>` measures one Reaction's Avatar,
Particle and Scene Effects instead: the Reaction replays every `--replay`
frames (default 90) with and without its effect events, the Scene layers
draw around the canvas as in chat, and the frame rate is uncapped so the
interval between frames includes the layers' style, layout and compositing.
Its budget is a mean added frame interval (and GPU time) of at most 4 ms.
`library:local/...` Reactions need `--local-content <content root>`.

## 10) Performance

Landmarks, texture anchors and face parts are built at load (and again after a
correction); placements are resolved when an effect applies. Per tick, planes
update transforms and animated composites redraw and re-upload. The controller
caches the original texture, cleanup fills, static layers and static segments
between animated layers, so a tick redraws only what moves. An animated
full-face texture is the most expensive effect; it dominates the heavy
combination's GPU p95. Camera-facing planes and stickers compose one matrix
per render; a silhouette adds one skinned draw per overlaid primitive (about
11–13 on the Included Avatars).

## 11) Troubleshooting

| Symptom                                                                                                    | Check                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save fails naming a field                                                                                  | The backend refused the definition (`avatar_effect_definition_invalid`); the creator opens and outlines the control. Fix that value.                                                                                       |
| "Conversion required" at Save, preview, Equip or import                                                    | A `/1` definition. Rescan or run `content_cli` for Local content, the conversion script for a descriptor folder; re-export a package from a converted installation. A failed Local conversion is listed in Content Health. |
| Effect never appears on one Avatar                                                                         | The snapshot or **Effect warnings** list `avatar_effect_face_part_unavailable`: open **Face parts**, correct the missing or uncertain part and save.                                                                       |
| A saved correction has no effect                                                                           | The VRM bytes changed (`vrm_sha256` mismatch) or an Included Avatar's revision changed; correct the parts again.                                                                                                           |
| Requests reading Avatars or starting chat fail with `relation "avatar_face_part_overrides" does not exist` | The development database predates the table. Reset it (see [development operations](../../backend/operations/development.md#database)).                                                                                    |
| A body, sticker or silhouette effect vanished                                                              | A fifth attachment replaced the oldest (`avatar_effect_attachment_limit`).                                                                                                                                                 |
| Blush or tears disappear when another effect starts                                                        | Both use the same replacing region; check **Advanced → Replaces**.                                                                                                                                                         |
| Large outline, small visible art                                                                           | Transparent padding counts toward size and pivot; trim the image or adjust size.                                                                                                                                           |
| Visible skin patch around eye or mouth art                                                                 | Compare **Clean up**, **Skin-coloured backing** and **Skin coverage**; the sampled colour or anchors may be poor on this model.                                                                                            |
| Full-face art misaligned                                                                                   | It must match the Avatar's UV layout; use a decal for localized marks.                                                                                                                                                     |
| Image refused or effect skipped on load                                                                    | It exceeds the image limits; resize it.                                                                                                                                                                                    |
| Floating art saved with a sideways or forward offset sits mirrored on a VRM 0 Avatar                       | It was saved when floating offsets followed the head's model axes. Floating offsets use the Avatar's front frame on every model; drag it back or flip the sign of `offset.x`/`offset.z`.                                   |
| A mirrored eye moved the wrong way after conversion                                                        | `avatar_effect_offset_mirrored`: `/2` mirrors x offsets on the mirrored copy. Adjust the offset.                                                                                                                           |
| Works in the creator but not in chat                                                                       | The effect must be in a saved, selected Gesture or Reaction in the mounted catalog, and Disable VFX must be off.                                                                                                           |

## 12) Limitations

- Detection is tuned and tested on the two Included (VRoid) Avatars; other
  models may need a correction. Without eye bones, side assignment may be wrong.
- Hidden face parts and face cleanup cannot fade; they switch at half the
  event's envelope.
- Decal quality depends on the cached anchors, and cleanup quality on the
  sampled skin region.
- Surface effects target both `map` and `shadeMultiplyTexture` when present.
- Floating planes are depth tested, so hair can cover eye art; stickers are not.

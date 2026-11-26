# Avatar VFX Guide

An **Avatar Effect** (`avatar_effect` content) is reusable art drawn on or
around an Anima's Avatar: painted onto the face, floating in front of it,
following a body point, placed beside the Avatar as a sticker, or filling its
silhouette. Effects are never equipped directly. A Gesture or Reaction plays
one through an `avatar_vfx` clip event, which owns when it starts and ends and
its fade, and may override the effect's placement, look, motion and sound for
that one use ([section 7](#7-timing-fades-and-motion)); the effect owns its
art and their defaults. An effect's optional Sound is a second exact
dependency of that Action.

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
| Texture layouts        | `lib/avatar/vfx/textureUvMapping.ts` (UVs to image positions), `faceIsland.ts` (the face's UV island), `faceSkinClip.ts` (clips whole-face art to the face skin) |
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
   the catalog is disposed). For an event with an override,
   `loadAvatarVFX(id, override)` parses that use from the effect's definition
   and the same images (`parseAvatarEffectUse`) and never caches it under the
   effect's id; a use the effect cannot play resolves to null and the event is
   skipped. The controller applies the entry through
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
  the effect is active. `full` art is drawn only on the face skin's own
  triangles of its texture: in each `face_skin` primitive on that image, the
  face's UV island (`selectFaceIsland`, as anchors use) and the islands
  outside its outline in the front view, such as VRoid's ears, less any
  eye-line or lash `regions` and, in a primitive that also holds the neck or
  body (under 90% head-weighted), the triangles not weighted to the head
  (`createFaceVertexFilter`); a small neck island on a mostly head-weighted
  face primitive lies outside the outline and keeps the art. A face that is
  the head region of a whole-body primitive keeps only its face island
  ([Faces inside a whole-body mesh](#faces-inside-a-whole-body-mesh)).
  An inner mouth, teeth or eyes inside the face's outline are left out. The
  clip is made only where it removes something: when another primitive's
  material also draws the image (a texture atlas), or when those rules drop
  triangles. Each clip triangle grows about 1–1.5 px at the texture's full
  resolution, so filtering there leaves no seam at the island's edge. The
  clip is built once per binding and slot as a `Path2D`; an opaque clipped
  replacement hides the original texture only inside it. VRoid faces on
  their own texture, the Included Avatars among them, need no clip.
  `eyes` art is drawn for a VRoid iris texture: one
  iris per half, the art cell being the whole half, about twice the iris.
  When an iris does not sit in its half that way (inside it, roughly centred,
  covering at least 40% of it in each direction), as on an Avatar whose eyes
  share a texture atlas with other parts, `resolveIrisEyeLayout` draws each
  eye's art in a cell 1.9 times its own iris rectangle, clipped to that
  rectangle so it cannot reach the other eye. The iris rectangle is that of
  the eye landmark's island, or of a layer over the whole eye with a larger
  texture area (its painted art). On VRoid irises the image's x grows toward
  the Avatar's left on both eyes; an eye whose art runs the other way
  (`textureMirrored`, mirrored UVs) has its cell `flipped`, so everything drawn
  there (art, offsets and turns) is mirrored about the cell's centre and reads
  as on VRoid. Eyes sharing one rectangle draw the same art, unmirrored and
  oriented for the viewer's left eye; with mirrored UVs the other eye shows
  it mirrored, as on VRoid.
- **Decals** (`undereye`, `blush`, `mouth`) are placed at UV anchors that
  `AvatarFaceTextureAnchors` computes at load: a 3D landmark is projected onto
  the `face_skin` mesh and its UV is interpolated. Projection stays on the face
  skin's own UV island, because a converted Avatar's face primitive can also
  hold its neck, inner mouth or eye sockets on other parts of the texture: the
  island nearest the point between the eyes among those spanning both eye
  centres, within half the eyes' spacing of that point. Without one (a face
  unwrapped in two halves) the whole primitive is used. The anchor sets position, pivot and
  reference size; it does not clip the art, so a tear can run below the eye,
  except on a face inside a whole-body mesh, whose decals keep to the face.
  `span` stretches one image across both anchors; use it only for art drawn
  that way.
- **Covered anchors.** Art painted on the skin does not show under a surface
  modelled just in front of it, up to 10% of the eyes' spacing in front along
  the face's front axis (`FaceCover` in `faceCover.ts`): the face primitive's
  triangles outside its island (eye dots, a low-poly eye shape, a nose) and
  the iris, white and highlight parts. Hair in its own primitives is not
  counted, but hair, a hood or a hat in the face primitive is, when it lies
  outside the face's island that close (a whole-body or partly head-weighted
  face). Eye-line and lash parts are left out, since their strands are
  usually cut out of a texture; eye-line and lash regions of the face
  primitive count only when the face material is opaque. An under-eye or
  cheek anchor under a surface moves down in steps of 1% of the eye spacing
  until nothing covers it, by at most half the spacing, and then half its
  reference height further where that stays uncovered, so the art sits below
  eyes modelled larger than their estimate. A mouth anchor counts as covered
  only when the points half its width to either side are covered too, since
  mouth art reaches past a nose over its centre. An anchor still covered keeps
  `covered: true` in the snapshot, and decals placed on it are skipped with
  `effect_anchor_covered`; the load log lists the anchors moved and left
  covered. Anchors nothing covers, the Included Avatars' among them, stay
  where they were.
- **Darkening art on a dark face.** Before a `multiply` decal is drawn, its
  change is estimated per colour channel from means: multiply scales each
  channel of the surface by the art's, so at opacity `o` a channel changes by
  about `o × S × (1 − A × T)` from the surface's mean colour `S` under the
  decal (the brightest of its placements), the art's mean colour `A` and its
  tint `T`. Where the largest channel change is under 8/255 (the step the
  review renders count as visible), the decal is skipped with
  `effect_surface_too_dark`: Included `shiver_undereye` on the neutral dark
  grey screen of a low-poly robot face, say (about 7/255). It changes the red
  channel of the Included Avatars' skin by about 34/255 and of a dark brown
  skin by about 25/255. Being an estimate from means, it can skip
  art that would show faintly on a few lighter pixels of a mixed surface.
  Whole-face art is not checked.
- **What the face shows.** Painted `face_skin` art needs the face material to
  draw a base colour texture (`map`) through the first UV set, the one anchors
  and the clip read, and, for an overlay, one whose image can be painted.
  Otherwise (a texture read through a second UV set, or art that would reach
  only MToon's shade texture, which shows in shadow) the effect is skipped
  with `effect_face_texture_hidden`.
- **Texture transforms.** Anchors, iris rectangles, the face clip and the
  creator's surface handles read positions on the texture's image, not raw
  UVs (`TextureUvMapping`): the UV through the base texture's transform
  (`KHR_texture_transform` offset, scale and rotation; three-vrm ports VRM 0's
  `_MainTex_ST` tiling to the same transform), then wrapped by its
  `wrapS`/`wrapT` (repeat, mirrored repeat or clamp) when outside 0–1. A
  shape (a triangle, an anchor's extent) wraps whole by one reference point.
  An untransformed texture maps UVs inside 0–1 to themselves.

### Floating effects (`face_landmark`)

Planes are parented to the normalized head bone (render order 950, depth tested,
so hair can hide them). Normalized bones keep the model's axes (VRM 1 faces +Z,
VRM 0 faces −Z), so each placement turns to face the front, and its offset,
rotation and motion apply in that turned frame. The creator measures drags in
the same frame, so a drag stores the same value on either Avatar. Eye planes
sit just in front of the iris landmarks; mouth planes start at the projected
mouth point, sized from its anchor; forehead and top planes use positions around
the face bounds, clear of detected hair.

Planes follow the Avatar's measured size ([Size-aware
placement](#size-aware-placement)). Eye planes are 6 cm high, scaled up by eyes
taller than 4 cm (the Included irises are 2.4–3.3 cm), and an estimated eye's
plane also stays a twentieth of the eye spacing in front of the face surface
measured over it. Forehead and top planes are 8 cm high; on a big-headed Avatar
they scale with the face, and the top-edge row moves from the face's top to
the top of the head box (ears, hat or hood included), so horns or a crown sit
on a robot's head rather than its screen.

### Size-aware placement

`avatarProportions.ts` measures each VRM at load and after a face part
correction, before effects or poses change it:

- The face's size: the larger of the height and width of the face's UV island
  within the face bounds (0.220–0.223 m on the Included Avatars), which
  `Avatar` registers from its texture anchors. Ears, hats, hoods and hair the
  face mesh carries are left out. Without a face, the head box below stands
  in, against the Included head boxes' 0.25 m.
- The head box: vertices skinned mainly to the head and eye bones, in the
  normalized head bone's space, as the review renders judge "on the head".
  Accessories skinned to the head count; head art keeps clear of it. Only a
  missing face or a big head reads it, so it is measured only then, from the
  meshes the model showed at load, which leaves out effect art added since.
- `avatarScale`: the head bone above the feet over 1.25 m.
- The body, on a big head only: rest heights below the head bone of the neck,
  shoulders (upper arms), upper chest, chest, spine, hips, feet and ground,
  the torso's width (half the shoulders' plus half the hips') and the arm and
  leg lengths, read against the Included Avatars' (`REFERENCE_AVATAR_BODY`).

The face's share of the head bone's height decides how far placement follows
it: up to 0.3 nothing changes (the Included Avatars measure 0.16–0.18, anime
proportions up to about 0.25); from 0.4 (twice the Included share: chibi,
mascot and robot Avatars) placement uses the face's size over the Included
face (`headSized`), ramping between. That scales box planes, body planes on
the head bone, stickers around the head (below), Particle Effects
([Avatar Particle Effects](avatar-particle-vfx.md)), hand contacts on the
head ([Avatar animation](avatar-animation.md)), and the chat's camera presets.

The camera presets are framed for the Included Avatars. Portrait and Portrait
(close) scale their offsets from the head bone and their distance by
`headFramingScale`; Full body and Full body (close) scale their camera and aim
about the floor by `bodyFramingScale`. Both are 1 on the Included Avatars and
the body's size (`bodyEffectScale`) for other adult proportions. On a big head
Full body follows the height to the top of the head box over the Included
Avatars' 1.15 times their head bone's, so a short chibi fills the frame and
its head stays in view. Portrait follows the face's size but shows no more
than Full body (close), and Portrait (close) no more than three quarters of
Portrait, since a chibi's face is about half its height; both aim at the head
box's centre (`headFramingCenter`) rather than the head bone at the skull's
base, so a hat stays in view. Choosing a preset, or loading another Avatar with one
chosen, frames it afresh. Creator previews, which reuse these presets, the
review renders' face view and `animation:render` follow suit.

Eye planes default to closing the eyes (`forceBlink` holds `blink` at 1 at full intensity; a fading event weights it, see the fades section),
hiding eye highlights, lines and lashes (`hideEyeDetails`) and cleaning up the
painted eye area (`faceCleanup`). `skinBackdrop`, off by default, adds a
skin-coloured plane behind eye or mouth art (render order 949). It is lit like
the face when the face uses MToon or a built-in material; on a lilToon or
other custom-shader face it is a plain, unlit card.

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
| `eye_left`, `eye_right` (irises) | Primitives with at least half their skin weight on the humanoid `leftEye`/`rightEye` bones (or whose material a look-at expression moves through a texture transform). Without either, the primitives skinned to the head (eye bones included, as an eye mesh may skin only its irises to them) within that eye region with a triangle behind an eyelid `blink` moves on the face skin: its outline meets the lid's in the front view and a corner lies no deeper than 15% of the lids' width behind the lid's front, so an eye card larger than the lid counts; sides follow the head's left-right axis. A part deep inside the head or beside it (ears) whose outline merely spans the lids does not count. Iris, white and highlight are told apart by projected area and depth. One primitive may hold both eyes. An eye with no geometry of its own is `estimated` (see below). |
| `face_skin`                      | The head-skinned primitive of the mesh that both `blink` and `aa` morph (presets left empty are filled from MMD, ARKit or VRChat shapes first, `faceSignals.ts`), with the most area around the eyes. A face skinned partly to the neck or jaw (under 90% head weight) wins instead when its head-weighted vertices cover more and blink moves it; primitives on spring joints (merged-in hair) never do. With neither, a primitive they morph that holds the body (under half its weight on the head, or over 35% below the neck) is face skin as its head region (see below). When `aa` morphs no mesh (a mouth swapped between separate meshes by material binds, or none authored), the same rules pick among the primitives `blink` alone morphs, and the mouth anchor is estimated from the eyes; only when that finds nothing either does Diagnostics warn that the expressions move no mesh. |
| `eye_highlight`                  | Separated from the iris by size and depth.                                                                                                                                                                                                                                     |
| `eyeline`, `eyelash`             | Small primitives of the face mesh that `blink` moves almost entirely; the larger is the eye line. Islands of the face or eye primitives that `blink` moves the same way are part `regions` (triangle lists, runtime only): lashes, or each eye's largest island as its line when no line primitive exists. Elsewhere an island must move at least half as far as the lid, but inside the box an eye's lid sweeps on the face skin (its `blink` region grown by a quarter of its size, reaching no higher than the open lid's lash line), a tenth is enough: lower lashes and eyeliner wing tips follow the lid only part of the way. Such an island is always a lash, never the line. Brows sit above the lash line, so a brow `blink` drags is left out. |
| `hair`                           | Primitives in the head subtree with a real share of spring-joint weight (used to keep forehead and top planes clear).                                                                                                                                                          |

Each part reports its `node:mesh:primitive` bindings, a source (`signals`,
`names`, `corrected`, `estimated` or `missing`) and a confidence. Face landmarks span every
`face_skin` binding (a correction may list several), counting only the
head-weighted vertices of one that also holds the neck or body, or the head
region of one that holds the whole body; texture
anchors project onto the face binding nearest the eyes. Material and node names
(`profiles.ts`) are a fallback per part; if detection itself fails, the Avatar
still loads with name matching and logs `avatar_face_parts_detection_failed`.
Detection takes a few milliseconds per Avatar and never writes world matrices.

### Eyes without geometry

An eye painted on the face skin, or modelled inside the face primitive, has no
mesh part to find. When the face skin is known and detection, names and any
correction leave an eye missing, it is `estimated` with an `estimate` naming
what places it, in this order. Detection measures the place once
(`eyeEstimates` on the part map, on the first face skin binding as the
landmarks take it) and the landmarks build the eye from it.

- `blink`: where `blink` moves the face skin on that side. The eye's region is
  the vertices it moves at least half as far as the farthest there (the lid and
  lash line), keeping the connected piece with the most vertices and pieces
  overlapping it, so a brow it also lowers is left out. The landmark sits
  halfway between their open and closed positions, averaged by how far each
  moves, and is sized like an iris (55% of the region's width, 67% of its
  height, as on the Included Avatars). Its `textureRect` bounds the region's
  UVs on the face texture.
- `eye_bone`: the humanoid eye bone, moved along the face's front axis onto
  the front of the face, with an iris 14% of the face's width. Only triangles
  facing the front, in the front half of the face's depth, count, so the back
  of the head cannot; where none covers the bone (an eye hole) the nearest
  one's depth is used. The bone must sit at least 10% of the face's width to
  its own side, inside the face in the front view and above its lowest
  quarter; otherwise the eye stays missing. This assumes the bone sits behind
  the eye, as VRChat rigs place it; VRoid's eye bones sit nearer the nose, but
  VRoid eyes always have meshes.

The VRM look-at origin does not place eyes: three-vrm fills a default offset
when a file has none, so it says nothing about where this model's eyes are.

The landmark carries the same `estimate`. Eye planes on such an Avatar hang
from the head as usual but are held by the face skin binding, since no binding
is an iris; blush, under-eye, mouth, forehead and top placements read the
landmarks as for any eye. An estimated eye's `textureRect` lies on the face
texture, so the iris layout (`resolveIrisEyeLayout`) ignores it. Iris surface
art (`face_surface` `eyes`) still needs an iris mesh part; on an estimated eye
it is skipped with `effect_iris_mesh_missing` ("this avatar's left eye has no
iris mesh"). With neither a
blink region nor eye bones that mark the eyes, the eyes stay missing, and eye
effects are skipped naming them.

### Faces inside a whole-body mesh

Low-poly Avatars often keep the whole body in one primitive on one material and
texture, with the face painted on. When no other face skin qualifies, a
primitive that `blink` and `aa` (or `blink` alone, as above) morph and that
holds the body (under half its skin weight on the head, or over 35% below the
neck, as on a one-mesh chibi) is face skin as its head region: the triangles
whose corners are all skinned mainly to the head (or its non-spring
descendants) and that face forward, with their centre in the front half of
the head's depth. The back and sides of the head, the neck, the body and hair
on spring joints are left out.
`blink` or `aa` must move a vertex of the region, so the face is where the
Avatar blinks or speaks. Among several such primitives the one covering the
most of the eye window (or of the front view) wins.

The region then narrows to the face itself: the UV island between the eyes,
chosen as texture anchors choose it (`findFaceIslandTriangles` in
`faceIsland.ts`), and the islands inside its outline (painted-on eyes, mouth,
brows). The eyes are where `blink` moves the primitive on each side, else the
humanoid eye bones; without both, or without such an island, the region stays
whole. A fringe, hood rim or visor skinned to the head in front of the face is
its own island and goes, so it neither sets the face's front (where eye planes
and anchors sit) nor takes its art.

The region is the part's `regions` entry for that binding (triangle lists,
runtime only; `findFaceSkinRegion`), and everything that reads the face keeps
to it: landmark bounds and eye estimates (`createFaceVertexFilter`), texture
anchors, and the `full` art clip, which keeps the face island alone. The body
shares the texture, so decals and the face cleanup under eye and mouth art are
clipped to the same island; on other faces they draw unclipped.
The clip is measured as the face is drawn without effects, so it stays whole
after an effect hid the face. Where it cannot be built (UVs the clip cannot
read, or no face triangle left to draw through), whole-face art is not drawn
and the controller warns (`effect_placement_failed`), since unclipped it would
cover the body. Hiding face skin (`hideParts`, the creator's hide face skin)
hides only the region's triangles, as eye details are hidden, never the
primitive and the body with it, and never the face the effect's own art is on
(whole-face art, or eye art held by the face when the eyes have no mesh). Body, sticker and
silhouette effects are unaffected. Detection runs once at load; Avatars whose
face skin is found otherwise never run it.

A correction or a material name that makes such a primitive face skin keeps it
to its head region when one can be measured. Without one, a corrected
primitive is face skin whole, as the user chose it. One found only by its name
needs what detection needs, a head region that blinking or the mouth moves;
otherwise it is not face skin, so a whole-body mesh detection rejected cannot
become the face by its material's name.

Diagnostics shows such a face as found by "Head of a whole-body mesh part",
held in one shared part. When such primitives exist but none has a head region
that blinking or the mouth moves (a rig whose mesh never uses its head bone,
say), detection reports `face_parts_whole_body_head_missing` and face effects
are skipped as for any missing face skin.

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
  saved against and ignored once that revision changes, for example when an
  update re-encodes the file. The owner saves the correction again for the new
  revision.
- `GET` and `PUT /v1/avatar-content/{item_id}/face-parts` read and save the
  effective value with an expected revision. Typed Avatar responses and the
  runtime snapshot's `avatar` carry it, and packages carry it with the Avatar.
  See the backend's [face-part
  corrections](../../backend/features/custom-animas-and-content.md#face-part-corrections).

Primitive keys are stable only for identical VRM bytes. A correction whose
`vrm_sha256` does not match the loaded file is ignored with a diagnostic, so it
never applies to a different model; clearing it restores detection. The chat
canvas and Avatar previews (the Library dock, Included Avatars picked in the
creators, Avatar Diagnostics) pass the correction and the VRM digest to
`Avatar.load`;
`Avatar.setFacePartCorrections` rebuilds the parts, landmarks, anchors and
bindings and re-applies the active effects.

One mesh can hold several parts: Annie's eyelashes, for example, are drawn in
her eye-line mesh. Each binding therefore serves every role whose part lists
it, and an effect on any of those roles uses it. A part the user changed comes
first, so it is the binding's primary role, and correcting Eyelashes to the
eye-line mesh paints eyelash effects there while eye-line effects still work.
Hiding eye details never hides a mesh that is also face skin or an iris.
Regions of those meshes are hidden instead: while the effect is on, their
triangles are rewritten in place as degenerate triangles
(`PrimitiveRegionHider`, reference-counted per effect, outlines included) and
restored when the last effect using them ends, and before face parts are
detected again. A region in an unindexed primitive cannot be hidden; the
effect still plays and reports `eye_detail_not_hidden`. When a face has no
line or lash geometry at all, its lashes are taken to be painted into the face
texture, and eye cleanup covers each eyelid `blink` moves rather than an
eye-sized region; lines painted beside lash geometry are not cleaned up. The
Face parts panel shows a part found only as regions as "Found inside another
mesh part"; correcting that part replaces its regions with the chosen
primitives.

### Missing parts

An effect whose part is missing (face skin for every face effect, the covered
eye for an eye plane, which an estimated eye serves, the painted part for a
surface effect) is not applied.
The controller logs one `avatar_effect_face_part_unavailable` warning per
effect and part and lists it in its snapshot warnings, which the VRM debug
panel shows. In chat, the Gesture or Reaction continues without the effect. The
creator names the missing part on its stage and toolbar.

### Diagnostic codes

Every finding the face parts, landmarks, texture anchors, springs and the VFX
controller report carries a stable code with parameters (part roles, binding
keys, counts, runtime effect ids) beside its English text, in `issues` next to
the existing `diagnostics` or `warnings`. A Local effect's runtime id derives
from its name, so shareable reports name effects by source and item id
instead. `lib/avatar/diagnostics/issues.ts`
lists the codes, such as `face_parts_correction_other_file`,
`landmarks_eyes_missing` and `effect_face_part_missing`. [Avatar
diagnostics](../features/anima-management.md#avatar-diagnostics) and the Avatar
Effect creator's toolbar word them from the `animas` catalog; the English text
remains for logs and the debug panels. A new warning gets a code there and a
catalog entry in every locale.

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
  metres. Both are authored for the Included Avatars: a model whose
  `avatarScale` (rest head height above the feet over 1.25 m, the measure
  contacts use) lies outside `BODY_EFFECT_SCALE_BAND` (0.91–1.2, the Included
  Avatars' 1.012 and 1.094 widened by 10%) scales them by its size over the
  nearer edge. On the `head` bone of a big-headed Avatar they scale by the
  head's size instead ([Size-aware placement](#size-aware-placement)), so a
  sparkle stays beside the head. It faces each camera (`facing: "camera"`) or
  keeps the bone's orientation (`"bone"`).
- **`sticker`**: a camera-facing image beside the head (`around: "head"`) or
  the body centre (between the hips and head). `size` and the screen-plane
  `offset` are fractions of the Avatar's height, measured at load from the bind
  pose, so stickers stay readable on any model; around a big head they are
  fractions of 1.6 m (the Included Avatars' height) times the head scale, so
  they keep beside it. They ignore depth (render order 960), so the Avatar never
  hides them.
- **`silhouette`**: art drawn only over the Avatar's visible pixels. Each
  depth-writing primitive gets an overlay mesh sharing its geometry, skeleton
  and live morph weights (render order 940, `LessEqual` depth with a small
  polygon offset). It honours the original material's alpha cutout, including
  a lilToon cut-out's `_Cutoff`, tiling and alpha mask, and changes no
  material or canvas option. MToon outlines and layers that write no depth
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

The effect sets its default motion (an event may override it for one use):
presets, keyframes and flipbook frames run on its own timeline from the moment
it applies. Pulse multiplies scale; spin
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
Events that end **With Action** have no envelope of their own. Every Avatar
Effect in a Gesture or Reaction also fades with its fade-out, and a Reaction's
with the fade-in of a Reaction that replaces it. Parameter
keyframes are not supported for Avatar Effects.

An event's optional `override` changes the effect for that use only
([ADR 0025](../../adr/0025-per-use-avatar-effect-overrides.md)): any of
`attachment` (same kind), `appearance` and `motion`, each replacing the
effect's part whole, and `soundAlias`, which picks one of the effect's
declared sounds (an unknown or unmounted one is silent). Clip parsing checks
the shape; backend Save and package import/export also check the definition
the use plays and name the failing field (`event.<id>.override…`), as the
reason `action_effect_override_invalid` at Save. In the Action creator, an
`avatar_vfx` event's inspector shows **This use**: the effect creator's
placement, look and motion controls, direct manipulation on the paused
preview, a sound choice when the effect declares several, and **Reset to
effect**. Edits store only the parts that differ from the effect.

## 8) Creator

### Starting an effect

The sidebar Create menu's **Effects** item, the Create page's effect cards and
`/effects/new` open the Effects template picker. Step 1 chooses Particle FX,
Avatar FX or Scene FX; step 2 offers **Start from scratch** and that kind's
templates, with Back. Avatar FX templates are the Included Avatar Effects,
grouped as Eyes, Cheeks, Whole face, Around the head, Mouth and Body in
`lib/effects/effectTemplates.ts`, with thumbnails captured on the Included
Avatar Annie. Choosing one opens `/avatar-effects/new?template=<id>`, which
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
with a confidence, uncertain (found by name or below 70%), Position estimated
(an eye without a mesh part of its own, see [Eyes without
geometry](#eyes-without-geometry)), Corrected (only a part the user changed; a
saved correction also pins the required parts at their detected values) or
Missing. A correction names mesh parts for both eyes, so it cannot be saved
while an eye is only estimated. **Edit** a part, then tick its mesh parts in
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
pnpm -s effects:assets frames art/mark.png --mode boil --out-dir frames
pnpm -s effects:assets flipbook frames/mark-boil-01.png frames/mark-boil-02.png frames/mark-boil-03.png frames/mark-boil-04.png --out art/mark-sheet.png --fps 8
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
- `frames <key.png> --mode boil|draw-on --out-dir <dir>` derives consistent
  flipbook frames from one key image, each on the key's canvas, so painted
  face art keeps its UV layout. `boil` (4 frames by default) warps the art by
  a smooth, seeded random displacement of at most `--amplitude` px (default
  1.25% of the key's longer side, at most 8) per frame, so the lines wobble
  like hand-traced art; `--seed` repeats or varies it. `draw-on` (6 frames)
  reveals the art outward from `--origin x,y` (fractions of the canvas;
  default the art's centre) or as a wipe toward `--direction
  right|left|up|down`; `--break-off` (8 frames) reveals in the first half and
  then clears the art from the same start. `--frames`
  sets the count (2–64). Frames get `fix`'s alpha clean-up and edge bleed,
  are written as `<key>-<mode>-NN.png`, and the command prints the `flipbook`
  command with a suitable rate (boil loops at 8 fps, a draw-on plays once at
  12 fps). It never overwrites the key.
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
  budget. An item without licence entries is owner-authored: Avatar files
  fall under the `vfx/avatar/**/*` licence rule and Scene PNGs under
  `vfx/scene/**/*.png`, each new Particle Effect gets its own owner-authored
  `vfx/particle/quark/<stem>/**` rule ahead of the generated-art rule, and
  every written file gets the owner's `licenses/source-review.json` record;
  it is refused where the rule that applies to one of its files (the first
  match, whatever its glob's shape) names a creator other than the owner. Work the owner did not author (such as agent-made
  effects and Reactions) carries owner-approved `licence` and `sourceReview`
  entries, as `animation promote` takes them: the rule for the item's folder
  (`<folder>/**`, or a shared `glob` such as `reactions/**/*`) and its files'
  records (`basis` one text or one per file). A file whose bytes repeat other
  Included art (such as a built-in creator texture or sticker, which the
  creator's Save copies) keeps that file's record and, when the copy's rule
  grants other terms, an exact-path rule with its own. A delete removes the
  effect's records and rules, and a removed or replaced third-party record is
  reported so its evidence can be updated. Particle textures sit at most one
  folder deep (`textures/<name>.png`).
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
- A new Reaction is a Reaction `add` (`"placement_hint": { "emotion",
  "intensity" }`, optional `"name"`): it writes `reactions/<stem>/` with ID
  `builtin:reaction:<stem>`, version 1 and the project's name, from a project
  whose clip id is the stem, under the same clip and dependency rules, and
  gives its two files source-review records (the owner's, or its
  `sourceReview`).

`library:local/...` sources read `ANIMAMA_LOCAL_CONTENT_HOST_PATH`, set by
sourcing the stack record, unless `--local-content` is given.

### Review renders

`pnpm -s effects:render` renders effects on both Included Avatars in headless
Chromium (SwiftShader) with the chat canvas settings (enhanced rendering by
default: Neutral tone mapping at exposure 1.1, sRGB and three-point lights;
`--rendering classic` uses ACES Filmic and the single key light), stepping
fixed 60 Hz frames with automatic animation
off, so renders are deterministic (a Reaction that starts two Particle Effects
in one frame can still differ by a few pixels between runs):

```bash
pnpm -s effects:render ./my-effect --out /tmp/my-effect.png
pnpm -s effects:render --all-included --out /tmp/effect-sheets
pnpm -s effects:render ./heart ./doki ./stripes --together --with-clip library:soldier-salute --out /tmp/follow
pnpm -s effects:render ./my-effect --thumbnail /tmp/my-effect.webp
pnpm -s effects:render --diff before.png after.png --out diff.png
```

To watch effects in motion with their sounds, `pnpm -s animation:reel --effects
--out effects.mp4` records every Included effect into one video (see the
[animation guide](avatar-animation.md)). To add, swap, retime or place effects
and sounds on Included Gestures and Reactions, use `pnpm -s content:tune`
([Tuning Included content](avatar-animation.md#tuning-included-content)).

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
  effect, or when an Avatar Effect's art (applied directly or played by the
  clip) draws nothing visible or mostly outside the head; the failure names
  the effect. Each Avatar Effect is judged on its own: every tile is rendered
  again without only its art, as `effects check` does (a face effect keeps
  its face options with transparent stand-in images, and a Reaction plays
  the same clip, so its mood face and other effects are in both). Changed
  pixels (a channel off by more than 8) count where the art belongs: within
  the head's projected bounds for art painted on the face, those bounds
  grown by half on each side for art placed at the eyes, mouth, forehead or
  top, anywhere for body, sticker and silhouette art. Art must change 0.1% of
  a tile there in at least one tile, so tiny eye art can fall under it on
  small front-only tiles or on a large head the views frame loosely. Face and
  landmark art must keep at least half of its changes there in the front and
  ¾ views; a `--views face` run skips that test, because the face view shows
  only the head. Neither test judges where on the head art lands or how much
  of it shows: art misplaced inside the head, or hidden but for a sliver by a
  hood, fringe or modelled eye, passes, so look at the sheets. Body and sticker
  art centred outside every tile (art in a hand below the frame in the rest
  pose; check it with `--with-clip <gesture>`) and a clip's effect not
  active at any rendered time are not judged; the run prints a `Note:` line
  for each. Particle and Scene Effects are left out of these
  captures and keep only the warning and active-effect checks.
- `--all-included` renders every Included Avatar Effect. `--thumbnail`
  renders an Avatar Effect on Annie with the portrait head framing, keeping
  the effect's own expression state.
- `--diff` counts a pixel when a channel changes by more than `--threshold`
  (default 8 of 255) and writes a diff image. The same source and revision diff
  to 0 pixels.
- `--avatar-file <a.vrm>` renders on that VRM instead of the Included
  Avatars, for example a converted Avatar kept outside the repository; keep its
  sheets outside the repository too.
- `--materials simple` loads the Avatar with the Simple material setting: a
  lilToon Avatar's glTF fallback materials, or an Avatar whose materials all
  ignore light without the toon shading Animama adds
  ([Unlit materials](avatar-animation.md#unlit-materials)); `liltoon` and the
  default `automatic` draw lilToon and the toon shading. Other Avatars look the
  same under every value.
- `--rendering classic` renders the classic Avatar look instead of the app's
  default enhanced rendering (the chat canvas's CSS filter is not part of the
  rendered pixels). `CHROMIUM_PATH` points Playwright at a preinstalled
  Chromium.

`pnpm -s effects:thumbnails [template-id...]` regenerates the picker's Avatar FX
thumbnails (320 px WebP, 1 s after applying, or at the template's
`thumbnail.time`; a `thumbnail.framing: "wide"` template is framed wider to
show chest or side art, and `"body"` is framed from the head to the upper
thighs, centred on the torso, for art at the belly, hips or a lowered hand) into `src/assets/effect-templates/`
and removes files for templates that no longer exist. For art attached to a
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
antialiasing, the chat's tone mapping and lights) and times `avatar.update`
plus render on the CPU, and the render on the GPU
(`EXT_disjoint_timer_query_webgl2`), per Included Avatar,
with no effects and with a heavy combination (an animated full-face texture, an
animated eye plane, a body effect and a silhouette). The scenarios alternate
over `--rounds` passes, and GPU samples voided by a disjoint event are dropped
and counted. The budget is a mean added frame time of at most 2 ms. A software
WebGL renderer is refused. Options: `--frames`, `--warmup`, `--rounds`,
`--clip`, `--effects`, `--headed`, `--json <file>`, `--rendering
<enhanced|classic>` and `--avatar-file <a.vrm>`, which measures that VRM
instead of the Included Avatars (not with `--reaction`). Further options, not
with `--reaction`: `--materials <automatic|liltoon|simple>` loads the Avatar
with that Materials setting; `--pixel-ratios 1,1.5,2` repeats each measurement
at those device pixel ratios; `--fps <n>` paces frames like the app
(`nextSceneFrame`; chat renders at 60 fps, or 30 while idle) instead of using
every display frame; and `--saturate <n>` times batches of n frames rendered
back to back instead (below).

Pace GPU comparisons with `--fps 60`. Headless Chromium can run at 120 frames
per second. A heavy Avatar then saturates the GPU, and the timer query also
counts queued work, so a lilToon Avatar's GPU time reads high and changes
inconsistently. Light loads can run at a lower GPU clock, so their absolute
times read higher than a busy GPU's would. Compare results only from runs made
under the same conditions. Each pass's GPU mean is kept in the JSON
(`passes`), so another job using the GPU shows up as drift between rounds.

Because a paced light frame runs at a lower clock, paced timings also narrow the
differences between scenarios: a change that halves a frame's work can read as a
small saving. To measure the work itself, use `--saturate 10` (1–100). Each
sample renders that many frames back to back, waits for the GPU with a 1-pixel
readback and reports the wall time per frame (labelled "frame (saturated)", and
kept in `passes` in place of the GPU mean) with the submission time per frame as
CPU time; `--fps` then sets only the animation step. Each stage first renders
back to back for about 2 s so the clock is up, and each pass starts with idle
gaps of 400 ms and 150 ms, so a GPU trace taken alongside (Instruments' Metal
System Trace with `--all-processes` and a time limit that ends before the bench
exits) can be cut into passes. Where a frame's wall time is close to its CPU
time the run is CPU-bound and hides the GPU's share, as for the Included
Avatars.

`--breakdown <materials,features,layers,mixed|all>` breaks the Avatar's plain
frame cost down instead (no effects). The baseline alternates with scenarios
that each change one thing. Every scenario reports GPU and CPU time, draw
calls and triangles from `renderer.info`. It also reports the share of the
Avatar's pixels that change in one probe frame of the same pose:

- **materials:** each glTF material hidden, and each drawn alone;
- **features:** each lilToon feature switched off on every material that
  uses it (toon shadow, rim, matcaps, emission, normal maps, reflection and
  the other `_Use*` switches; the outline pass, the two-pass pre-pass,
  blending and alpha test through the shader variant), then all but
  transparency together. Then the runtime's depth pre-pass for opaque lilToon
  primitives is switched off, and prototype drawing changes follow; none of
  them ships. They are blending off on opaque materials, morph targets
  dropped, and morph weights read from a uniform array;
- **layers:** each structural layer hidden: the eye stack, irises, eye
  highlights, eye-bone eye whites, eye lines, eyelashes, face skin and hair
  as face-part detection finds them, the alpha-blended and alpha-tested
  primitives, and the rest;
- **mixed:** lilToon on chosen materials, with the rest drawn with the glTF
  fallbacks of a second, Simple load of the file.

`--apply <ids>` applies feature scenarios by id (for example
`outline,shadow`) to every measurement. It measures a combination, or
a breakdown on top of one. The output names materials by glTF index and
layers by structure, never by the file's material or mesh names. It labels
the Avatar with its file name, so rename a private file before sharing
results.

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
combination's GPU p95. Where whole-face art needs a clip, each redraw also
clips with the face skin's cached `Path2D` (VRoid faces on their own texture
need none). Camera-facing planes and stickers compose one matrix
per render; a silhouette adds one skinned draw per overlaid primitive (about
11–13 on the Included Avatars).

## 11) Troubleshooting

| Symptom                                                                                                    | Check                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save fails naming a field                                                                                  | The backend refused the definition (`avatar_effect_definition_invalid`); the creator opens and outlines the control. Fix that value.                                                                                       |
| "Conversion required" at Save, preview, Equip or import                                                    | A `/1` definition. Rescan or run `content_cli` for Local content, the conversion script for a descriptor folder; re-export a package from a converted installation. A failed Local conversion is listed in Content Health. |
| Effect never appears on one Avatar                                                                         | The snapshot or **Effect warnings** list `avatar_effect_face_part_unavailable`: open **Face parts**, correct the missing or uncertain part and save.                                                                       |
| An effect is skipped or degraded on one Avatar in chat                                                     | Anima settings → **Avatar diagnostics** → **Warnings** names the effect and the reason, with its [code](#diagnostic-codes).                                                                                                |
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
| An effect event never shows; the console warns "Avatar VFX override cannot play"                           | The event's override makes a definition the effect cannot play (Save names it: `action_effect_override_invalid`, `event.<id>.override…`). Fix that field, or use **Reset to effect** under the event's **This use**.       |
| Works in the creator but not in chat                                                                       | The effect must be in a saved, selected Gesture or Reaction in the mounted catalog, and Disable VFX must be off.                                                                                                           |

## 12) Limitations

- Detection is tuned on the two Included (VRoid) Avatars and tested on them
  with synthetic additions (lashes inside the face mesh, a face skinned partly
  to the neck, no eye bones, eyes without meshes); other models may need a
  correction. A face inside a whole-body mesh is found by skinning, facing
  and UV islands: a face unwrapped on one island with a fringe or hood rim
  takes the effect's art there too, and a cheek or chin skinned partly to the
  neck, facing sideways or unwrapped apart from the face stays unpainted. A
  face mesh is taken as a whole-body mesh when under half its skin weight is
  on the head or over 35% is below the neck (a one-mesh chibi). One skinned at
  least half to the head with little body weight (a VRChat face with its neck,
  or a mascot whose face mesh carries a small body) keeps every head-weighted
  triangle instead, so whole-face art also tints its ears and any hair, hat or
  hood skinned to the head bone. A small
  head-skinned primitive that `blink` and `aa` also morph (in the same mesh,
  say) takes the face from a whole-body primitive, because the whole-body
  rule applies only when no other face skin qualifies. Eyes without meshes are
  estimated, not measured: an estimate
  from the eye bone is off where the bone does not sit behind the eye, and
  one from blinking leans toward the lid above the eye and is sized like an
  iris, but at least 30% of the eye spacing wide and high; blush and
  under-eye art move below eye dots or shapes larger than that ([Painted
  effects](#painted-effects-face_surface)), the cheek as far down as the
  under-eye art so they stay apart. Painted eyes much larger or smaller than
  that still get art sized for the estimate. With both eye bones, eye
  landmarks skip islands wider than the distance between them, such as a
  dome some VRChat eye meshes put around each eyeball.
- Size-aware placement scales by the face's UV island, so a face unwrapped
  with its ears, hat or hood on one island counts them, and an Avatar loaded
  without a face falls back to the head box, which counts every ear, hat, hood
  or hair skinned to the head bone without hair bones. On a big head,
  top-edge art sits on the head box's top, ears, hats and hoods included, so
  horns can float well above a tall ear. On adult proportions, forehead and
  top art sits at the face and body art on the head bone at its authored
  offset, so a hood or helmet standing well clear of the face can hide most
  of an anger mark or a Reaction's sparkle. A big head's art is placed by
  scaling about the head bone, which assumes the bone sits at the skull's
  base as on VRoid models.
- Whole-face art (`full`) is laid out for VRoid's dedicated face texture and
  clipped to the face's island. Where the face is a small island of a shared
  texture, as on many BOOTH and low-poly Avatars, most of the image falls
  outside it: a tint such as `face_red` covers the face, but detail drawn
  across the image, such as `petrified_cracks`' crack lines, barely shows,
  and an island laid out unlike VRoid's face can be covered only in part.
- The checks that skip art which would not show are partial. Only
  `multiply` decals are compared with the surface under them, so dark eye or
  mouth art over a dark painted face (a robot's screen) is placed but barely
  shows, and nothing checks whether a fringe, hood or modelled eye in front
  hides floating art.
- Eye overlays that close the eyes hide only the eye details `blink` moves:
  a lower-lid line that stays still when the Avatar blinks remains visible,
  as do lash layers above the open lid's lash line. Lids that do not quite
  meet when closed (some converted VRChat Avatars) show a faint dotted seam
  where the eye behind them shows through.
- The mouth anchor follows the vertices the mouth shapes (`aa`, `ee`, `ih`,
  `oh`, `ou`) move most, or an estimate without them; on a face whose jaw
  moves with those shapes (some converted VRChat Avatars), mouth decals sit
  slightly low.
- The `full` art clip tells the face's own islands by their outline in the
  front view: an island unwrapped apart inside the face's outline (a nose
  patch, say) is left out with the inner mouth, and an inner part reaching
  past the outline is kept. A face unwrapped in halves, with no island
  spanning both eyes, keeps every island. Lower mipmap levels can still blend
  art across an island's border, as the growth holds only at full
  resolution.
- An iris layout mirrors an eye whose art runs mirrored against VRoid's, but
  `span` iris art is drawn across both cells without it; the painted-art layer
  is chosen by texture area, so a stretched layer covering the whole eye can
  be taken for it.
- Texture transforms are read when the anchors, landmarks and clip are built,
  so an expression that moves a texture (a texture-transform bind) is not
  followed. Decal anchors assume the shade texture shares the base texture's
  transform, and only the first UV set is read.
- Hidden face parts and face cleanup cannot fade; they switch at half the
  event's envelope.
- Decal quality depends on the cached anchors, and cleanup quality on the
  sampled skin region.
- Surface effects target both `map` and `shadeMultiplyTexture` when present.
- Floating planes are depth tested, so hair can cover eye art; stickers are not.

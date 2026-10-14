# How to use the Avatar Effect creator

Use this reference to author content through Animama's UI. For why an attachment
behaves as it does, read [What an Avatar Effect is](what.md).

Contents: [Open and prepare](#open-and-prepare) · [Choose placement](#choose-placement) ·
[Check face parts](#check-face-parts) · [Fit the art](#fit-the-art) ·
[Look, motion and sound](#look-motion-and-sound) · [Verify the region](#verify-the-region) ·
[Save and use](#save-and-use) · [Review outside the app](#review-outside-the-app) ·
[Recipes](#recipes) · [Troubleshooting](#troubleshooting)

## Open and prepare

Use the available browser automation tool's documented interaction and file-upload
facilities. Inspect the current page and locate controls by their visible labels
or accessible names rather than assuming screen coordinates. Read screenshots for
visual judgment; a DOM snapshot alone cannot verify a rendered effect.

1. Find the existing app origin. Do not hardcode a worktree's port or start/reset
   services merely to author content in an already running app.
2. Open the Effects template picker: the sidebar Create menu's **Effects** item,
   the Create page's **Avatar FX** card (which opens straight at the second
   step), or `/effects/new`. Choose **Avatar FX**, then **Start from scratch**
   or a template (grouped as Eyes, Cheeks, Whole face, Around the head, Mouth and Body). A template opens `/avatar-effects/new?template=<id>` as a
   new, unsaved Local copy with an unused name; it never changes the Included
   effect. Saved items reopen at `/avatar-effects/{avatarEffectId}/edit`, also
   reachable from their Library row.
3. Check whether the creator holds an unsaved or recovered draft. If a template's
   earlier draft differs from the template, the creator asks to continue it or
   discard it; continue only if it belongs to this task. Do not accept a discard
   prompt blindly.
4. Select the intended avatar with **Model** (Annie, Caitlyn or the active
   Anima's model). Use **View → Face** for fitting, **Three-quarter** for depth
   and **Portrait** for normal-size readability. Preview selection is not an
   assignment of the effect to that Anima.
5. Give the effect an explicit name in the header so the Library item is easy to
   identify.
6. In **Effect Setup**, use **Image → Browse** or drop one image. PNG, JPEG and
   WebP are accepted, up to 16 MiB and 4096 px per side. PNG or alpha-bearing
   WebP suits isolated symbols; JPEG cannot preserve transparency, and a
   checkerboard painted into the image is not alpha.

Wait for the image and avatar to finish loading before judging placement. The
upload preserves image bytes and framing. It does not crop transparent borders,
resize a sprite, remove its background, or split an atlas. If asset preparation is
needed, preserve the original and prepare a separate derivative within the task's
scope.

Start from scratch opens art floating in front of both eyes, mirrored, with Close
the eyes, Hide eye details and Clean up the eye area on; unit size, no offset, no
motion and no sound. Set the attachment explicitly; a symbol above the head
should not inherit eye behaviour.

## Choose placement

**Attach to** chooses one of five attachments; Effect Setup then shows only the
fields that apply.

### Floating on the face

**Where**: Eyes, Mouth, Forehead, Top of the head or Above the head. The last
three add **Position** (Left, Middle, Right; Above the head adds Far left and Far
right). These are positions around the face bounds, clear of detected hair.

For Eyes, **Which eyes**:

| Intended artwork                               | Choice                                         | Notes                                                                                               |
| ---------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| One-eye sprite shown on both eyes              | Both eyes, mirrored                            | **Art is drawn for the** names the eye the drawing was made for; the other eye gets a mirrored copy |
| A different drawing for the other eye (a wink) | Both eyes, mirrored, plus **Other side image** | The other image is drawn unmirrored                                                                 |
| One-eye sprite on one eye                      | Left only or Right only                        |                                                                                                     |
| One image already containing both eyes         | One image between the eyes                     | One centred plane; fit the pair as a whole                                                          |

Eye art offers **Close the eyes** (holds blink), **Hide eye details** (eye
highlights, eye lines, lashes), **Clean up the eye area** (soft skin-coloured
fills over the painted eyes), **Skin-coloured backing** (a sampled-skin plane
behind the art, off by default) and **Hide other face parts**. Mouth art offers
**Clean up the mouth area** and **Skin-coloured backing**. Hidden parts apply to
detected parts on both eyes, not only the chosen side; inspect both.

### Painted on the face

**Where on the face**: Whole part, Eyes, Under the eyes, Cheeks or Mouth. Whole
part and Eyes add **Paint on** (Face skin, Eyes (iris), Eye highlights, Eye
lines, Eyelashes) and **Keep the original underneath** (overlay when on, replace
when off). Under the eyes, Cheeks and Mouth paint a decal on face skin at a face
anchor and add **Image point placed on the face** (the pivot: nine positions from
Top left to Bottom right).

For Eyes, Under the eyes and Cheeks, **Which eyes** or **Which side** offers both
sides mirrored, one side only, or **One image across both sides** (only for art
drawn as one wide image); Eyes also offers **Both eyes** using the part's two eye
areas. The other side image works as for floating art.

Use Centre for ordinary cheek stamps and Top for a tear that hangs below an eye.
The pivot refers to the whole file rectangle, so transparent padding may still
need an offset. Mouth decals offer **Clean up the mouth area**; whole-part and
eye art offer **Hide other face parts** (for a star iris, hiding Eye highlights
keeps the original highlight from competing). Use **UV preview** to see what the
part's texture actually contains before relying on whole-part art.

### On the body

**Body point**: Feet (whole avatar), Hips, Waist, Chest, Neck, Head, either hand
or either foot. **Always face the camera** turns the plane toward each view; off,
it keeps the bone's orientation. Position is in centimetres from the point and
size is the plane height in centimetres.

### Sticker beside the avatar

**Beside the** Head or Body. Position and size are percentages of the avatar's
height in the screen plane, so the sticker stays readable on any model and is
always drawn over the avatar.

### Fill the silhouette

**Fill**: **Repeat the image as a pattern** (with **Tile size** and **Scroll X/Y**
in tiles per second; use tileable art) or **Tint with the image's colour** (a
flat fill in the art's average colour times the Look tint). It draws only over the
avatar and changes none of its materials.

## Check face parts

Open **Face parts** before fitting a face effect on a new model. Each part shows
Detected with a confidence, an uncertain status (found by name or below 70%),
Corrected or Missing. Face skin and both eyes are required.

To correct a part, choose **Edit**, then tick its mesh parts in the list or
choose **Pick on the avatar** and click the avatar. **Save correction** saves it
with that Avatar and rebuilds the preview; **Use detected parts** removes a saved
correction. A correction applies only to that exact model file. When the effect
needs a part the model lacks, the stage and toolbar name it, and chat will skip
the effect. A correction changes the Avatar, not the effect: save it only when
the user wants that Avatar corrected.

## Fit the art

1. Keep motion off while fitting. Drag the art on the preview to move it: across
   the face for painted art, in the head or bone plane for floating and body
   art, in the screen plane for stickers. Drag a corner handle to resize and the
   round handle to turn. With the preview focused, arrow keys nudge the art
   (Shift moves further). Each drag is one undo step.
2. **Inspector → Placement** shows the same values: position in the
   attachment's units (cm, % of the texture or % of the avatar's height), size,
   **Rotation (°)** and, for floating art, **Tilt forward** and **Turn
   sideways**. Use it for exact values; do not copy numbers between attachments.
3. Turn on **Guides**. Open circles and faint lines mark the placement basis;
   pink outlines show the whole image rectangle, including transparent margins.
   Reference bounds are not clipping masks; estimated anchors are labelled.
4. For painted art, open **UV preview** and compare the reference, artwork and
   pivot marks on the part's texture. **Skin coverage** shows the cleanup
   regions and the sampled skin patch.
5. Inspect the face from the front and three-quarter views on both Included
   Avatars. Check hair covering floating art and seams or deformation under
   painted art. Verify the avatar's left and right, not the screen's. A mirrored
   copy mirrors its horizontal offset; inspect that side too.
6. Return to Portrait to judge the silhouette and line weight at normal size.

Play applies the current effect; Stop clears it rather than freezing a frame;
Restart re-applies from the first frame. Camera and guide settings are preview
only.

## Look, motion and sound

**Inspector → Look**: **Opacity (%)**, **Tint** and **Blend** (Normal, Glow (add
light), Shade (multiply)).

**Inspector → Motion**: enable only what the effect needs; channels combine.

| Motion    | Controls                                                                                          | Practical use                                                   |
| --------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Pulse     | **Smallest size (×)**, **Largest size (×)**, **Pulses per second**                                | Restrained emphasis, a throbbing anger mark                     |
| Spin      | **Speed (°/s)**, **Range (turns)**, **Direction**                                                 | Continuous spirals, or rocking when the range is below one turn |
| Drift     | **Sideways** (art widths/s), **Up/down** (art heights/s)                                          | A slowly rising symbol over a bounded event                     |
| Keyframes | **Time (s)**, **Opacity (%)**, **Size (×)**, **Turn (°)**, **Move X/Y**; **Repeat the keyframes** | A pop-in, a wobble, a shake                                     |

Drift accumulates with no return: test the whole intended event duration.
**Animated sprite sheet** in Effect Setup plays frames from the image as a grid
(**Columns**, **Rows**, **Frames**, **Frames per second**, **Playback**: Repeat,
Play once, Back and forth).

**Sound when applied** selects a Sound Effect; the saved effect refers to exact
sound content, and an Action event can disable it for one occurrence. Do not add
audio merely because the control is available. Licensed built-in sounds are not
offered, and a copy of a built-in effect leaves its sound behind (the creator
says so under the picker).

## Verify the region

**Advanced → Replaces** sets the region that governs replacement, separate from
where the art appears. Automatic follows the attachment: `eyes` for eye art,
`mouth` for mouth art, `emote` for forehead and above-head art, the area for
cheek and under-eye decals, `full_face` for whole-part art, and the attachment's
own region for body, sticker and silhouette effects. A manual choice is kept
while it still suits the attachment.

`eyes`, `undereye`, `blush` and `mouth` replace an earlier effect in the same
region; `emote` and `full_face` stack. Body, sticker and silhouette effects
coexist, up to four at once. Region does not move the image.

## Save and use

Save writes a Local catalog item with the images, definition, authoring data and
optional sound dependency. An owned item updates at its expected revision; a
template or Included source becomes a new Local item. Choose a distinct name for
a new effect. Do not save a variant only to place, tint or move existing art
differently in one Action: override the effect on that Action's event instead.

The backend validates the definition on Save. A rejected field opens the tab
holding its control and outlines it; a missing image also blocks Save. A missing
face part on the preview model does not block Save, but leaves that model
unverified.

Wait for a successful save and the stable `/edit` route, then reopen the item and
check its images, placement, look, motion, region, face options and sound.
Recovery of an unsaved draft is not proof of persistence; recovered drafts may
need images reselected. On a save failure, use the reported error and the existing
retry path; check Library before retrying as a new effect.

When the task includes playback, use **Use in… → Use in a Gesture** or **Use in a
Reaction** after saving. In the Action creator, set the event's Start and End;
for an End after a duration, **Fade in** and **Fade out** set its fades. Preview
it with the other components and save the Action. Use the app's Anima content
selection workflow when equipping is requested. Test combinations there: the
creator preview shows one effect at a time.

## Review outside the app

From `src/frontend/web`, with no running stack:

- `pnpm -s effects check <folder|library:<name>>` checks the art budget, the
  definition, the attachment on both Included Avatars and that the art is
  visible; see the skill's workflow. `--with-clip <clip.json|library:<gesture>>
  --times …` checks hand- or foot-attached art in the pose of the Gesture
  that uses it.
- `pnpm -s effects:render <folder|descriptor.json|library:<name>> --out <png>`
  renders contact sheets on both Included Avatars (front, ¾ and face at several
  times). `--with-clip library:<gesture>` checks that body, sticker and silhouette
  art follows motion; add `--replace-effect <alias|ref>` to play the source in
  place of that Gesture's dependency, from its events and with their
  overrides. `--together` combines sources. It exits 1 on a controller
  warning, such as a missing face part, or when a replacing source is not
  active at any `--times`.
- `pnpm -s animation:preview <effect folder | library:avatar-effect/<name>>`
  plays the effect live on both Avatars in the browser, with camera presets,
  scrubbing and review notes; `--duration <s>` applies it for a set time. Keep a
  descriptor in its own `<stem>/` folder, which the preview watches. A Library
  Gesture or Reaction source plays its Avatar, Particle and Scene Effects as in
  chat.

Renders and previews use the chat canvas lighting but not a live Anima; they do
not replace checking the saved Action in chat when that is the outcome.

## Recipes

These are starting configurations, not universal values. Fit them to the chosen
avatar and the image's actual framing.

| Intended result           | Setup                                                               | Region and useful checks                                                        |
| ------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Angry forehead vein       | Floating → Forehead → Left or Right                                 | `emote`; static fit, then restrained pulse; check hair                          |
| Surprise mark, steam puff | Floating → Above the head → a position                              | `emote`; preserve silhouette; use a Particle Effect for repeated emissions      |
| Nervous sweat drop        | Floating → Forehead, right or left position, nudged up or down      | `emote`; a short downward drift needs a bounded event                           |
| Spiral eyes               | Floating → Eyes → Both eyes, mirrored                               | `eyes`; check both eyes and the ¾ view, then spin or a sprite sheet             |
| Wink                      | Floating → Eyes → Both eyes, mirrored + Other side image            | `eyes`; check which eye gets which image                                        |
| Cheek blush               | Painted → Cheeks → Both sides, mirrored; Centre point               | `blush`; check alpha against the skin and alongside tears                       |
| Crying stream             | Painted → Under the eyes → Both sides, mirrored; Top point          | `undereye`; account for top padding; check it follows the cheek                 |
| Cartoon mouth             | Floating → Mouth, or Painted → Mouth to follow the skin             | `mouth`; inspect cleanup and mouth motion; backing applies only to floating art |
| Star iris                 | Painted → Eyes → Paint on Eyes (iris), keep the original underneath | `eyes`; inspect the iris UV layout; hide Eye highlights if they compete         |
| Sick or gloom face        | Painted → Whole part → Face skin                                    | `full_face`; needs UV-matched art; check lips, eyes and seams                   |
| Heart on the chest        | On the body → Chest, facing the camera                              | `body`; check it follows a Gesture                                              |
| Comic lettering           | Sticker → Head                                                      | `sticker`; check readability at Portrait size                                   |
| Despair shade             | Fill the silhouette → pattern                                       | `silhouette`; use tileable art; check outlines and eyes                         |

## Troubleshooting

| Symptom                                               | Check and response                                                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blank preview                                         | Confirm the avatar and image loaded and Play is active. Check **Face parts** for a missing part, then scale, position, opacity and transparency.                     |
| Effect shows on one Avatar but not another            | A face part is missing or wrong on that model. Correct it in **Face parts**.                                                                                         |
| A saved correction no longer applies                  | The model file or the Included Avatar's revision changed; correct the parts again.                                                                                   |
| One centred image instead of two eyes                 | **Which eyes** is One image between the eyes. Choose Both eyes, mirrored for a one-eye sprite.                                                                       |
| Unexpected second eye or cheek                        | A mirrored choice draws the other side. Choose Left only or Right only.                                                                                              |
| Tears or blush disappear when another effect starts   | Both share a replacing region; check **Advanced → Replaces** and the Action timing.                                                                                  |
| A body, sticker or silhouette effect vanished         | A fifth such effect replaced the oldest.                                                                                                                             |
| Large outline, tiny visible art                       | Transparent margins count toward size. Adjust size or prepare a tighter derivative.                                                                                  |
| Visible skin patch                                    | Compare **Skin-coloured backing** and **Clean up** independently; inspect **Skin coverage** and the sampled colour.                                                  |
| Painted art right in UV preview but wrong on the head | Inspect seams, estimated anchors, the painted part and mesh deformation in 3D.                                                                                       |
| Original eye detail remains                           | Check **Hide eye details** and **Hide other face parts**, and that the parts are detected.                                                                           |
| Drift leaves the face quickly                         | Drift is per art width or height per second and never returns. Reduce it and test over the event duration.                                                           |
| Save names a field                                    | Fix the outlined control; the value breaks a `/2` rule.                                                                                                              |
| "Conversion required" on an older effect              | It is still `/1`. Local content converts on Rescan; a package must be re-exported from a converted installation.                                                     |
| JSON imported but Save needs an image                 | Reselect the image; the editor export contains no bytes.                                                                                                             |
| Saved effect never appears during chat                | It must be in a saved, selected Gesture or Reaction in the mounted catalog, triggered at the intended time, with Disable VFX off; a missing face part also skips it. |

## Source navigation

- Route, preview, toolbar and dialogs: `src/frontend/web/src/ui/avatar-effect-creator/AvatarEffectCreatorPage.tsx`.
- Setup fields and labels: `AvatarEffectSetupFields.tsx`; attachment options,
  side choices and units: `avatarEffectPlacement.ts`; Inspector tabs:
  `AvatarEffectInspector.tsx`; motion: `AvatarEffectAnimationControls.tsx`.
- Dragging and handles: `AvatarEffectManipulator.tsx`, `avatarEffectDrag.ts`,
  `directManipulation.ts`.
- Face parts: `AvatarEffectFacePartsPanel.tsx`, `facePartsPanel.ts`,
  `useFacePartDraft.ts`.
- Editor document, regions and validation:
  `src/frontend/web/src/lib/avatar/vfx/editor/{defaults,document,types}.ts`.
- Save and recovery: `useAvatarEffectSave.ts` and the shared
  `src/frontend/web/src/ui/content-creator/useCreatorSave.ts`.
- Templates: `src/frontend/web/src/lib/effects/effectTemplates.ts`.
- Post-save handoff: `src/frontend/web/src/ui/content-creator/CreatorEffectHandoffActions.tsx`.

Finish with a compact handoff: saved item names and edit URLs, preview models,
chosen attachments and regions, any face-part corrections, which of visual
preview, reopen, combined Action playback, and live Anima playback were
verified, and any unresolved warnings.

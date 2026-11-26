# Faces

Gestures and Reactions shape the face the same way: a clip's `expressions`
holds one track per named shape, with weights from 0 to 1 keyed on beats like
any other track. This guidance is the same for both kinds.

## The names an Avatar offers

A shape is keyed by its name. An Avatar's names fall into the families below,
and a list of the chosen Avatar's names is grouped the same way. Key only
names from that list, or from the two portable families, which every Avatar
plays.

| Family | Names | Plays on |
| --- | --- | --- |
| VRM presets | Moods `happy`, `relaxed`, `sad`, `angry`, `surprised`, `neutral`; `blink`, `blinkLeft`, `blinkRight`; vowels `aa`, `ih`, `ou`, `ee`, `oh` | Every Avatar |
| VRoid parts | `Fcl_<Region>_<Mood>`: region `ALL` (whole face), `BRW` (brows), `EYE` (eyes) or `MTH` (mouth); mood `Joy`, `Fun`, `Sorrow`, `Angry` or `Surprised` | Every Avatar: its own part, else its standard MMD morph, else a mix of its ARKit shapes, else the mood's preset. A mouth part has no preset to fall back to |
| MMD morphs | Japanese names such as まばたき, ウィンク, 笑い, なごみ, にこり, 困る, 怒り, じと目, びっくり and あ い う え お, and any others the model carries | Avatars that have that morph |
| ARKit shapes | The 52 face-tracking names, such as `browInnerUp`, `eyeSquintLeft`, `mouthSmileLeft`, `jawOpen`, `cheekPuff` and `tongueOut`. The list gives them under these standard names however the file spells them | Avatars with ARKit shapes |
| The author's own shapes | Any other name in the list, exactly as spelled | That Avatar, and others with a shape of the same name |

The moods correspond: Joy is `happy`, Fun is `relaxed`, Sorrow is `sad`,
Angry is `angry` and Surprised is `surprised`. `Fcl_ALL_<Mood>` and the
preset are the same whole face. An Avatar with no face shapes at all keeps a
neutral face.

## Choosing names

1. Build the mood from VRM presets or VRoid parts. They are the portable
   vocabulary: playback turns them into whatever the Avatar has, so the item
   shows a face on every Avatar.
2. Use the parts when the regions should differ. Brows and eyes carry the
   feeling while the mouth is left free. Use a whole-face preset when one
   mood covers the face and the mouth may open.
3. Then add the chosen Avatar's other named shapes for what a mood cannot
   say: a puffed cheek (`cheekPuff`), a tongue (`tongueOut`), one raised brow
   (`browOuterUpLeft`), a half-lidded stare (じと目), or a blush or heart eyes
   its author made. Key them on top of the mood, not in place of it, so the
   item still reads on an Avatar without them. Add none for what the mood
   already does, such as a smile shape over `happy`. In your note, name the
   shapes that only some Avatars can play.
4. A name outside the chosen Avatar's list and the two portable families
   shows nothing. Do not key one.

## One name for each movement

Give each movement of the face one name. Names that make the same movement
move the same part of the face, their weights add up, and playback only
partly limits the stacking.

- **A whole face or its parts, never both for one mood.** The preset and
  `Fcl_ALL_<Mood>` are the same face, and the mood's `BRW`, `EYE` and `MTH`
  parts are its pieces. For one mood key the preset, or `Fcl_ALL_<Mood>`, or
  the parts: never `happy` with `Fcl_EYE_Joy`, and never `relaxed` with
  `Fcl_ALL_Fun` or the Fun parts.
- **One family for one movement of a region.** Do not key a preset or part
  together with an MMD morph or ARKit shape that moves the same region the
  same way, such as `Fcl_EYE_Joy` with 笑い, or `happy` with `mouthSmileLeft`
  and `mouthSmileRight`.
- To make a movement stronger, raise the weight of the name that already
  makes it.

Two moods blended in one form are not doubled: `relaxed` 0.5 with `happy`
0.2, or `Fcl_BRW_Sorrow` with `Fcl_BRW_Joy`.

## Faces by region

Start from these weights and adjust on the face view.

| Feeling | Brows | Eyes | Mouth |
| --- | --- | --- | --- |
| Joy, delight | `Fcl_BRW_Joy` 0.5–0.75 | `Fcl_EYE_Joy` 0.5–0.75 | `Fcl_MTH_Fun` 0.5–1 (closed smile); `Fcl_MTH_Joy` up to 0.15 to part the lips |
| Warm, content | `Fcl_BRW_Fun` 0.35–0.6 | `Fcl_EYE_Fun` 0.35–0.6 | `Fcl_MTH_Fun` 0.5 |
| Sad, sorry | `Fcl_BRW_Sorrow` 0.6–1 | `Fcl_EYE_Sorrow` 0.6–1 | `Fcl_MTH_Sorrow` up to 0.2 |
| Angry, annoyed | `Fcl_BRW_Angry` 0.5–1 | `Fcl_EYE_Angry` 0.5–1 | `Fcl_MTH_Angry` 0.5–1 (closed) |
| Surprised | `Fcl_BRW_Surprised` 0.6–1 | `Fcl_EYE_Surprised` 0.6–1 | `Fcl_MTH_Surprised` up to 0.12 |
| Embarrassed | `Fcl_BRW_Sorrow` 1 with `Fcl_BRW_Joy` 0.5 | `Fcl_EYE_Sorrow` 1 with `Fcl_EYE_Joy` 0.5, `blink` 0.35 | `Fcl_MTH_Fun` 0.5 |

As whole faces: joy is `happy` 0.6–0.8; warm is `relaxed` 0.5 with `happy`
0.2; curious is `surprised` 0.3 with `happy` 0.2; surprised is `surprised`
0.7–0.9, briefly; thinking is `relaxed` 0.3, with `sad` 0.1 when unsure; shy
is `happy` 0.4 with `sad` 0.15; sad is `sad` 0.5–0.7; annoyed is `angry`
0.3–0.5.

## Rules for every family

- Keep whole-face presets moderate (0.5–0.85). At 1 they read as exaggerated
  on most models. Brow and eye parts can go to 1.
- A keyed `blink`, `blinkLeft` or `blinkRight` lowers the lids. Use it for
  winks, narrowed eyes and closed-eye smiles. On an open-eyed face 0.3 is a
  soft lid drop and 0.45 or more reads as closed.
- A smile already closes the eyes: `happy` and `Fcl_EYE_Joy` close them, and
  `relaxed` and `Fcl_EYE_Fun` narrow them. Playback scales blink by the
  closure the mood leaves open, so blink cannot push the lids past shut, and
  under `happy` 0.8 a keyed blink barely moves them. Key the look you want,
  not a compensated blink: key `blink` high (up to 1) for closed eyes or
  winks, where under a partial smile it only fills the closure still open,
  and lower the mood itself for eyes that should stay open.
- Lip-sync wins over mouth shapes while the Anima speaks. Vowels and wide
  mouths belong to silent moments. Where speech may overlap, keep the mouth
  closed or barely open.
- Do not key the look presets (`lookUp`, `lookDown`, `lookLeft`,
  `lookRight`). Gaze belongs to the eyes and head.
- Look at the face view on each Avatar you can. Lids, brows and bangs differ,
  and bangs can hide the brows entirely.

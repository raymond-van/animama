# Authoring a Reaction

A Reaction is the face an Anima shows while it talks. Chat picks one by the
turn's emotion and intensity, fades it in, holds its last face for as long
as the Anima talks, and fades it out when talking ends. You write it as one
**`animaPoseClip/2.0` clip** that holds expression tracks on beats and
nothing for the body. The same file opens in the Reaction creator and is
what Save stores.

The [clip format](clip-format.md) gives the fields, beats and keys, and
[faces](faces.md) gives the names and weights. The rules below hold only for
Reactions.

## Emotion and intensity

- `emotion` is the one tracked emotion the face shows. `intensity` says how
  strong the feeling is: 1 Mild, 2 Moderate, 3 Strong, 4 Intense. Together
  they are a hint for where the Reaction fits.
- A stronger intensity is not the same face at higher weights. The Included
  Reactions carry a stronger feeling with effects, which a draft cannot use
  yet, and with the fades below. Anger keys one face in all of its Included
  Reactions; every other emotion's face differs between some of them, in
  the moods it blends or in their weights.
- An emotion between two moods blends their parts. Two Included examples:
  the Mild curiosity Reaction keys Surprised at 1 with Joy at 0.38, and the
  Mild disappointment Reaction keys Fun at 1 with Sorrow at 0.78.

## The face

- Key the brow, eye and mouth parts (`Fcl_BRW_*`, `Fcl_EYE_*`, `Fcl_MTH_*`),
  not a whole-face preset or `Fcl_ALL_*`: a whole face also opens the
  mouth, and a Reaction plays over lip-sync.
- Brows and eyes carry the emotion. A Reaction plays on top of the face the
  Anima's mood already shows, and a part only fills the room that face
  leaves for the same mood, so brows and eyes never go past a full
  expression.
- Keep the mouth closed or barely open. Use the closed mouths `Fcl_MTH_Fun`
  and `Fcl_MTH_Angry`, or `Fcl_MTH_Joy`, `Fcl_MTH_Sorrow` and
  `Fcl_MTH_Surprised` at the low weights
  [faces](faces.md#faces-by-region) gives. Key no vowel.

## The clip

- A Reaction has no body motion. Its clip holds none of `joints`,
  `rotations`, `hipsPosition`, `hands`, `contacts`, `plantFeet`, `basePose`
  or `mutedProceduralLayers`.
- One face needs one beat: `peak` at time 0, with every expression keyed on
  it. The fade-in brings the face up and the hold keeps it.
- A face that flashes before it settles needs two beats: `pop` at 0 and
  `settle` at 0.25. Key the flash on `pop` (surprised brows and eyes at 1,
  say) and the held face on `settle`.
- Set `duration` to 2, as every Included Reaction without effects does. It
  does not limit the hold; it is how long the creator's preview shows the
  held face.
- Leave `loop` out. A Reaction holds its last face and does not repeat.
- Fade in faster and out slower as intensity rises:

| Intensity | `fadeIn` duration | `fadeOut` duration |
| --- | --- | --- |
| 1 | 0.2 | 0.34 |
| 2 | 0.18 | 0.38 |
| 3 | 0.16 | 0.48 |
| 4 | 0.14 | 0.66 |

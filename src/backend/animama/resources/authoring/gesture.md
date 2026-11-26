# Authoring a Gesture

A Gesture is an Action in which an Anima moves its body, usually with a
facial expression, to accompany what it says. You write it as one
**`animaPoseClip/2.0` clip**: named beats on a timeline, and anatomical joint
angles keyed to those beats. The same file plays in chat, opens in the
Gesture creator and is what Save stores, so a saved Gesture stays editable
from its Library item.

The rest of this guidance covers the [clarifying interview](interview.md),
[motion principles](motion-principles.md), the [clip format](clip-format.md),
[human movement](human-movement.md), [hands](hands.md), [faces](faces.md),
the [motion checks](checks.md) and the [joint list](joints.md).

## Rules

- Describe intent anatomically (degrees on named joint components) on
  readable beats; playback handles bases, VRM 0 conversion, smoothing, hand
  fitting and planted legs on each Avatar.
- Keep each key on the beat it belongs to, offset with `dt`, so retiming a
  beat in the creator moves the right motion with it.
- Stagger regions: the eyes/head lead, the torso follows, arms trail and
  overshoot, hands and fingers settle last. Uniform timing looks robotic.
- Set `"plantFeet": true` (2.0 clips do not plant feet unless asked) and move
  weight through hips offset and small pelvis rotation; the legs are solved
  automatically on each Avatar.
- Shape hands with a preset (fitted to each Avatar's fingers) plus
  `fingers` offsets on the same key; key finger `joints` only for what
  offsets cannot express (finger twist, splay of the outer segments, the
  thumb metacarpal). Use `pinch` and `ok` for touching pads rather than
  aiming the thumb by hand. See [hands](hands.md).
- Declare every intended touch as a contact with the `point` that touches
  (`palm`, `tip`) and `solve`, so playback lands it on every Avatar despite
  their different arm lengths. Solving moves only the upper arm and elbow:
  key the arm within a few centimetres of the touch and turn the palm
  yourself (add `facing` to have the checks verify it). Mute the head and
  torso layers when a solved touch is on the head. See
  [clip format](clip-format.md#contacts).
- Repeated pulses (laughs, giggles, bounces) run at 2.5–3.3 Hz, three or
  four per burst, decaying and staggered across regions; faster, phase-locked
  pulses read as twitching. See
  [human movement](human-movement.md#laughing-and-bouncing).
- Effects in a Gesture are action-bound: play an Avatar Effect only where it
  carries the motion's meaning, anchored to the acting hand, mouth, head or
  body (or coming out of the motion as a puff, pop, impact or sparkle) and
  timed to a beat. Most conversation beats stay clean. Reactions already show
  emotion face paint in the same turn, so prefer action-bound effects; reusing
  an Included blush, sweat, anger or gloom effect is allowed where it adds to
  the Gesture's meaning, accepting some doubling with Reactions. Reuse an
  Included effect before asking for new art, and fit it to the Gesture
  through the event's `override` (another place, look, motion or declared
  sound) instead of asking for a variant effect; see
  [clip format](clip-format.md#avatar-effect-events).
- A Gesture sounds only through its effects (no `sfx` events). When effects
  start together, keep one sound and set `playAccompanyingSound: false` on
  the others; an idle Gesture sets it on every effect event.
- List `mutedProceduralLayers` explicitly: a clip without it mutes nothing.
  Usually mute all but `breathing`; keep `cursorLookAt` unmuted only when the
  head does not move.
- **Selector IDs and tiers:** the Selector ID is how chat picks a Gesture.
  Use lowercase snake_case naming the action (`wave_hello`); for intensity
  tiers of one action, share the stem and add the tier (`laugh_mild`,
  `laugh_medium`, `laugh_hysterical`), and say in each AI description when
  that tier fits. Ask the owner which Selector ID a replacement for an
  existing Gesture should use.
- Long Gestures (10–20 s) are sequences of short actions: give each its own
  beats, let each settle briefly before the next, and keep loops of attention
  (blinks, small head moves) alive through the holds.

## The face in a Gesture

Shape the face as [faces](faces.md) describes. These rules hold only for
Gestures:

- A Gesture that keys any mood preset (`happy`, `relaxed`, `sad`, `angry`,
  `surprised` or `neutral`) replaces the Anima's emotion face while it plays:
  that face fades out for the Gesture and back afterwards. A Gesture that
  keys only parts or other names leaves the rest of the emotion face in
  place. Key the expression the motion needs, and key no mood preset when the
  Gesture should keep the Anima's current emotion.
- Let the face rise slightly ahead of the action (0.1–0.2 s) and fade with
  the return.
- A keyed `blink` replaces automatic blinking while the Gesture plays; keep
  it brief.
- Give the mood its body cue:

| Mood | Body cue |
| --- | --- |
| Joy, greeting | lifted chest, open hands |
| Warm, content | slow, soft settle |
| Curious, interested | head tilt 6–10°, lean in 3–5° |
| Surprised | quick head back, hands up |
| Thinking, unsure | head tilt and turn, eyes up |
| Embarrassed, shy | head down and aside, shoulders in |
| Sad, sorry | head and chest down, slow |
| Annoyed | sharp head turn, arms in |

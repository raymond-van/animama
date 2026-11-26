---
name: animama-animation
description: Author natural, expressive Animama Gestures from a text prompt by writing an animaPoseClip/2.0 clip (beats and per-joint tracks), validating it, running the motion checks, live preview and review renders on both Included Avatars, and saving it as Local content through the Gesture creator; starts with a short clarifying interview, authors up to ten Gestures as a batch, and revises saved Gestures from their Library item. Use for new or revised body-and-face Gesture motion; VRM internals, Avatar Effects (animama-avatar-vfx), Particle Effects (animama-particle-vfx) and Scene Effects (animama-scene-vfx) have their own skills.
---

# Animama Animation

Turn a motion prompt into a Gesture that reads well in chat. You write an
**`animaPoseClip/2.0` clip**: named beats on a timeline, and anatomical joint
angles keyed to those beats. The same file plays in chat, opens in the Gesture
creator and is what Save stores. Checks, the live preview and renders show
what it does on both Included Avatars. Never hand-write quaternions or bypass
creator Save. Never write into `content/included/` except through the gated
**Promote to Included** step (step 9).

Use `animama-vrm` for VRM, coordinate and runtime facts. Repository paths are
relative to the Animama Git root. Commands run from `src/frontend/web`; in a
fresh checkout run `pnpm install` and `pnpm packages:build` in `src/frontend`
first.

## Workflow

0. **Interview.** Before planning, ask the owner the few questions whose
   answers would change the clip (when chat uses it, one-shot or held,
   intensity, leading hand, contacts, face), with your recommended option
   first, and confirm the resulting brief. Each animation gets its own
   questions; for several animations, send all of them in one message. Skip
   it when the prompt already settles the performance or the owner says to
   use your judgement. See [interview](references/interview.md).
1. **Plan the performance.** Read the prompt into beats with times:
   anticipation → action → follow-through → settle (one-shot), or an alive hold
   that loops seamlessly (held). Choose duration, loop, which body regions lead
   and lag, facial expressions, hand shapes, contacts and layer mutes.
   Read [motion principles](references/motion-principles.md).
2. **Write the clip** as a draft `<name>.clip.json` in the location the owner
   names; otherwise in `.animama-drafts/` at the repository root (ignored by
   Git). Drafts are working files: once saved (step 6), the Library item in
   `content/local/` is the clip, and Included content lives only in
   `content/included/`. Do not add clip copies anywhere else in the repository.
   Look up joints and ranges with `pnpm -s animation joints` and base values
   with `pnpm -s animation base`. Read [clip format](references/clip-format.md),
   [human movement](references/human-movement.md) and
   [hands and face](references/hands-and-face.md).
3. **Validate:** `pnpm -s animation validate <file>.clip.json`. It reports
   structural problems and values beyond anatomical limits with JSON paths,
   and the saved size against the 2 MB the app loads.
4. **Check:** `pnpm -s animation check <file>.clip.json`. Fix every FAIL;
   treat WARN as a prompt to look. Besides range, smoothness, intersections
   and feet, it measures each contact at its `point` (a solved one within
   1.5 cm, naming a target the arm cannot reach), warns when a solved arm is
   far from its touch before solving or a palm does not turn toward a
   `facing` target, finds fingers through fingers, palms or the other hand,
   and warns on rapid oscillation (a joint swinging faster than about 4 Hz
   for three cycles). See [checks and review](references/checks-and-review.md).
5. **Preview and look:** `pnpm -s animation:preview <file>.clip.json`
   plays it live on both Avatars, lit like the chat canvas, with live layers,
   beat markers and camera presets (a Library item or project file also plays
   its Avatar, Particle and Scene Effects), and reloads as you edit; its pickers
   switch to other clips and Library items without a restart. Judge timing there; use
   `pnpm -s animation:render <file>.clip.json --out <dir>` for still contact
   sheets (`--times` for beats, `--side left` for left-handed action) and
   `--view hands` for close-ups of one hand from four angles, to judge hand
   shapes, finger contacts and palm direction. Revise
   and repeat from step 2 until it reads clearly and naturally. When the owner
   leaves review notes, apply them and resolve each with
   `pnpm -s animation resolve` (see checks and review).
6. **Save through the creator:** `pnpm -s animation:save <items.json>` saves
   each listed clip with its name, AI description and Selector ID through the
   Gesture creator (a new Local Gesture, or a revision when that Selector ID
   is already saved) and reopens it; or do the same by hand (see
   [checks and review](references/checks-and-review.md)). Never Save & Equip
   unless the owner asks.
7. **Chat check** when mutes or expressions matter: play it on a test Anima.
8. **Hand off** with the saved item, check summary, preview notes, render
   sheets, the chat check and known limits.
9. **Promote to Included** (never by default): only when the owner explicitly
   approves each item and its licence entries, on a task branch with a PR.
   Promote the saved Local item the owner reviewed (`"clip":
   "library:local/<selector>"`): `pnpm -s animation promote <items.json>
   --dry-run`, then without `--dry-run`, writes the Included Gesture, its
   metadata, licence rule and source-review records. An add lists the
   Included effects its events play as `dependencies` (promote a new effect
   first); a replace changes the display name or loop kind only with
   `"rename": true` or `"loopChange": true` for changes the owner approved;
   rename-only items are edited by hand. See [promote](references/promote.md).

**Several Gestures at once:** follow [batch mode](references/batch.md) for up
to ten per batch: every animation's interview questions sent at once,
parallel authoring, a consistency pass, one preview for the owner and one
save run.

**Revising a saved Gesture:** start from the Library item itself
(`content/local/` or `content/included/`). Preview it with
`pnpm -s animation:preview library:<selector>`, which prints its clip file's
path. Copy that file to `.animama-drafts/`, edit it, then validate, check and
preview with `--compare library:<selector>` to see old and new together.
Save a Local Gesture with `animation:save` under the same Selector ID (or
import it in the creator and Save); the item keeps its identity. Changing an
Included Gesture's bytes is a promotion (step 9) with `mode: "replace"`.

## Decision rules

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
  aiming the thumb by hand. See [hands and face](references/hands-and-face.md).
- Declare every intended touch as a contact with the `point` that touches
  (`palm`, `tip`) and `solve`, so playback lands it on every Avatar despite
  their different arm lengths. Solving moves only the upper arm and elbow:
  key the arm within a few centimetres of the touch and turn the palm
  yourself (add `facing` to have the checks verify it). Mute the head and
  torso layers when a solved touch is on the head. See
  [clip format](references/clip-format.md).
- Repeated pulses (laughs, giggles, bounces) run at 2.5–3.3 Hz, three or
  four per burst, decaying and staggered across regions; faster, phase-locked
  pulses read as twitching. See [human movement](references/human-movement.md).
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
  [clip format](references/clip-format.md#avatar-effect-events).
- A Gesture sounds only through its effects (no `sfx` events). When effects
  start together, keep one sound and set `playAccompanyingSound: false` on
  the others; an idle Gesture sets it on every effect event.
- A Gesture's keyed emotion expressions replace the emotion face while it
  plays. Key expressions that suit the motion, and leave them out when the
  Gesture should keep the Anima's current emotion.
- List `mutedProceduralLayers` explicitly: a clip without it mutes nothing.
  Usually mute all but `breathing`; keep `cursorLookAt` unmuted only when the
  head does not move.
- **Selector IDs and tiers:** the Selector ID is how chat picks a Gesture.
  Use lowercase snake_case naming the action (`wave_hello`); for intensity
  tiers of one action, share the stem and add the tier (`laugh_mild`,
  `laugh_medium`, `laugh_hysterical`), and say in each AI description when
  that tier fits. Ask the owner which Selector ID a replacement for an
  existing Gesture should use.
- **AI descriptions:** the AI description is a Gesture's one text. Chat
  sends it for every equipped Gesture with each message and the Library shows
  it, so keep it to about 120 characters. Lead with when chat
  should choose the Gesture ("Use when …"), then describe the look in a few
  words. Keep the words that tell tiers and similar Gestures apart.
- Long Gestures (10–20 s) are sequences of short actions: give each its own
  beats, let each settle briefly before the next, and keep loops of attention
  (blinks, small head moves) alive through the holds.
- Checks catch anatomy, collisions, grounding and continuity; they cannot
  judge naturalness. Always look at the preview and renders, and report what
  was not reviewed.

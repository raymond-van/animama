---
name: animama-animation
description: Author natural, expressive Animama Gestures from a text prompt by writing an animaPoseClip/2.0 clip (beats and per-joint tracks), validating it, running the motion checks, live preview and review renders on both Included Avatars, and saving it as Local content through the Gesture creator; starts with a short clarifying interview, authors up to ten Gestures as a batch, and revises saved Gestures from their Library item. Use for new or revised body-and-face Gesture motion; VRM internals, Avatar Effects (animama-avatar-vfx), Particle Effects (animama-particle-vfx) and Scene Effects (animama-scene-vfx) have their own skills.
---

# Animama Animation

Turn a motion prompt into a Gesture that reads well in chat. You write an
**`animaPoseClip/2.0` clip**: named beats on a timeline, and anatomical joint
angles keyed to those beats. Checks, the live preview and renders show
what it does on both Included Avatars. Never bypass creator Save. Never write
into `content/included/` except through the gated **Promote to Included** step
(step 9).

Use `animama-vrm` for VRM, coordinate and runtime facts. Repository paths are
relative to the Animama Git root. Commands run from `src/frontend/web`; in a
fresh checkout run `pnpm install` and `pnpm packages:build` in `src/frontend`
first.

## Authoring guidance

What to write is described by the authoring guidance in the backend package,
which the app's authoring assistant reads too. This skill adds the
command-line procedure. Read the guidance a step names before doing the step:

| Guidance | File |
| --- | --- |
| What a Gesture clip is, the authoring rules and the face in a Gesture | `src/backend/animama/resources/authoring/gesture.md` |
| Clarifying interview | `src/backend/animama/resources/authoring/interview.md` |
| Motion principles | `src/backend/animama/resources/authoring/motion-principles.md` |
| Clip format | `src/backend/animama/resources/authoring/clip-format.md` |
| Human movement | `src/backend/animama/resources/authoring/human-movement.md` |
| Hands | `src/backend/animama/resources/authoring/hands.md` |
| Faces | `src/backend/animama/resources/authoring/faces.md` |
| Motion checks and contacts | `src/backend/animama/resources/authoring/checks.md` |
| Joints, ranges and base pose | `src/backend/animama/resources/authoring/joints.md` |

Follow the authoring rules in `gesture.md` throughout.

## Workflow

0. **Interview.** Before planning, ask the owner the few questions whose
   answers would change the clip (when chat uses it, one-shot or held,
   intensity, leading hand, contacts, face), with your recommended option
   first, and confirm the resulting brief. Each animation gets its own
   questions; for several animations, send all of them in one message. Skip
   it when the prompt already settles the performance or the owner says to
   use your judgement. Keep the brief in the hand-off so later revisions can
   see the intent. See the clarifying interview guidance.
1. **Plan the performance.** Read the prompt into beats with times:
   anticipation → action → follow-through → settle (one-shot), or an alive hold
   that loops seamlessly (held). Choose duration, loop, which body regions lead
   and lag, facial expressions, hand shapes, contacts and layer mutes.
   Read the motion principles guidance.
2. **Write the clip** as a draft `<name>.clip.json` in the location the owner
   names; otherwise in `.animama-drafts/` at the repository root (ignored by
   Git). Drafts are working files: once saved (step 6), the Library item in
   `content/local/` is the clip, and Included content lives only in
   `content/included/`. Do not add clip copies anywhere else in the repository.
   Read the guidance on the clip format, human movement, hands and faces.
   `pnpm -s animation joints` prints the joints and ranges and
   `pnpm -s animation base` the base values, which the joint list guidance
   holds as a file. The Included 2.0 Gestures
   (`content/included/gestures/<slug>/<slug>.json`) are full examples;
   preview one with `pnpm -s animation:preview library:included/<slug>`. The
   whole format is described in `docs/frontend/runtime/avatar-animation.md`
   (Pose and clip JSON artifacts).
3. **Validate:** `pnpm -s animation validate <file>.clip.json`. It reports
   structural problems and values beyond anatomical limits with JSON paths,
   and the saved size against the 2 MB the app loads, and writes nothing when
   anything is invalid.
4. **Check:** `pnpm -s animation check <file>.clip.json`. Fix every FAIL;
   treat WARN as a prompt to look. The motion checks guidance says what each
   finding means and how to fix it, and how declared contacts are measured;
   [checks and review](references/checks-and-review.md) describes the
   command.
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
   `pnpm -s animation resolve` (see
   [checks and review](references/checks-and-review.md)).
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

## At the command line

- An effect event's `override` copies parts of the effect's definition; the
  `animama-avatar-vfx` skill's effect folder reference describes its fields.
  The Gesture's effect dependencies are declared as
  [promote](references/promote.md) shows.
- The faces guidance takes an Avatar's own shapes from a list of its
  expression names. Without one, key only the two portable families;
  `pnpm -s vrm:inspect <file.vrm>` prints an Avatar file's morph-target names
  and the ARKit shapes it resolves.
- The checks cannot judge naturalness. Always look at the preview and
  renders, and report what was not reviewed.

---
name: animama-avatar-vfx
description: Create, revise and tune Animama Avatar Effects (animama/avatar-effect/2) from a written brief — art through the effect-asset skill, a /2 effect folder, `pnpm -s effects check`, review renders and the owner's live preview on both Included Avatars, Save as Local content through the creator, and an owner-gated Promote to Included step — and operate the Effects picker and Avatar Effect creator by hand (attachments painted or floating on the face, body, sticker, silhouette; placement, face parts, look, motion, sound; Gesture or Reaction use). Use for avatar-attached visual effects; general VRM questions, particle emitters (animama-particle-vfx) and scene backgrounds (animama-scene-vfx) have their own skills.
---

# Animama Avatar VFX

Turn an idea into an Avatar Effect that lands its beat in chat. You write a
**brief**, make its art with the `animama-effect-assets` skill, write an
**effect folder** (`<stem>/<stem>.json` with a `/2` definition, plus its
images), check and render it, show it to the owner live, and save it as
Local content through the creator. Never write `content/included/` except
through the gated **Promote to Included** step (step 9).

Repository paths are relative to the Animama Git root; drafts live in its
`.animama-drafts/` (ignored by Git). Commands run from `src/frontend/web`,
and relative paths in them resolve from there, so write draft paths as
`../../../.animama-drafts/...` (or absolute). When `src/frontend/node_modules`
is missing or a command cannot import `@animama/runtime-contracts`, run
`pnpm install` and `pnpm packages:build` in `src/frontend` first.
`effects save` needs the running stack; `library:local/...` sources need only
its record sourced (`source ../../../.animama-stack.env`).

## Workflow

0. **Interview.** Ask the owner only what would change the effect (what it
   expresses, the moment it plays, how loud it should be), with your
   recommended option first; skip it when the request settles these or the
   owner says to use your judgement. See [brief](references/brief.md).
1. **Write the brief** before any art, in
   `.animama-drafts/effects/<stem>-work/brief.md`: what it expresses, the
   comedic or emotional beat, attachment and placement, the Reaction
   intensities (1–3) it suits, motion and duration, the art, and its budget.
   Comedic uses are preferred. Confirm it with the owner when a batch or new
   library item depends on it. Template in [brief](references/brief.md).
2. **Make the art** with `animama-effect-assets`. Keep generated sources and
   previews in `.animama-drafts/effects/<stem>-work/` and put only the final
   images in the effect folder `.animama-drafts/effects/<stem>/` (ignored by
   Git), one folder per effect. Its budget follows the attachment.
3. **Write the effect folder:** `<stem>/<stem>.json` beside its images, with
   `content_type: "avatar_effect"`, a name, a description and a `/2`
   definition. Start from the closest Included effect
   (`content/included/vfx/avatar/<stem>/<stem>.json`; its `content_id`,
   `version`, `dependencies` and `files` are Library metadata a draft leaves
   out) or a recipe in [effect folder](references/effect-folder.md), which
   lists every field and its rules. For attachments and face parts read
   [what an Avatar Effect is](references/what.md). Choose the **name** now:
   Local names use letters, digits, spaces, `.`, `_` and `-` only (no
   brackets), and the saved Local folder is the lowercased name with spaces
   and `_` as `-` (`Sweat Drop` → `vfx/avatar/sweat-drop/`), not the draft
   stem.
4. **Check:** `pnpm -s effects check <folder>`. It checks the art against its
   budget, parses the definition as the runtime does (naming a bad field),
   applies it on both Included Avatars (a missing face part or bone fails)
   and renders each Avatar with the art and against a baseline without it
   to prove the art is visible, in the front, ¾ and face views at 0.25 s
   and 1 s. Fix every FAIL; read every WARN. Each Avatar must show the art
   in some frame. A time where nothing shows yet (before a late fade-in) is
   a WARN "nothing shows at …"; single missed views are listed as "not in
   …", expected for the face view's tight crop with stickers and body art.
   Use `--times` for effects that appear late. Art on a bone a Gesture moves
   (a hand or foot) is out of frame or misplaced in the rest pose, where it
   fails as "no visible art": check it in the pose it is used in with
   `--with-clip <clip.json | library:<gesture>>` and `--times` inside the
   moment it shows (seconds from the Gesture's start; the effect is applied
   at 0).
5. **Look:** `pnpm -s effects:render <folder> --out
   ../../../.animama-drafts/effects/<stem>-work/renders/<stem>.png` for
   contact sheets (front, ¾ and face on both Avatars). Pick `--times` that
   cover the effect's whole life and its keyframe peaks (for a 0.12 s
   overshoot held 4 s: `--times 0.06,0.14,0.3,1.5,4`). The ¾ view looks from
   the Avatar's right, so art on its left side turns away there; judge it in
   the front and face views. Use `--with-clip library:<gesture>` when it must follow
   motion (with `--replace-effect <alias>` when revising an effect that
   Gesture already plays) and `--together` with the effects it will share a
   Reaction with.
   Read the sheets yourself and revise until the effect reads as the brief.
   Then start the live preview for the owner:
   `pnpm -s animation:preview <folder>` (`--duration <s>` for an effect held
   that long). Apply the owner's review notes and resolve each with
   `pnpm -s animation resolve <notes.review.json> <id> <what changed>`.
6. **Save through the creator:** `pnpm -s effects save <items.json>` with
   `[{ "source": "<stem>", "name": "...", "description": "..." }]` (paths
   relative to the items file). It imports the document into the Avatar
   Effect creator, chooses the images, saves, reads the item back and
   reopens it; a Local effect with the same name is revised. It prints the
   Local folder each name saves to and refuses names the app would refuse.
   Or do the same by hand ([creator](references/how.md)). Never equip unless
   asked. An effect with a sound is saved by hand.
7. **Use it** when the brief names a Gesture or Reaction: add the effect in
   the Action creator, set Start/End and fades, preview it there, and check
   it on a test Anima in chat when timing against speech matters. When that
   use needs the effect in another place, look or motion, override it on the
   event (see the decision rules).
8. **Hand off** with the brief, the saved item and edit URL, the check
   summary, the render sheets, preview notes and what was not reviewed.
9. **Promote to Included** (never by default): only when the owner
   explicitly approves each item, on a task branch with a PR. Promote the
   saved Local item the owner reviewed. A new built-in effect plays one
   licensed sound from the private comedy pack unless the owner wants it
   silent: propose one and have the owner approve it, or no sound, with the
   art. A replace keeps a merged effect's several sounds.
   See [promote](references/promote.md).

**Several effects at once:** follow [batch](references/batch.md): briefs
confirmed together, art and folders in parallel, one review preview, one
save run.

**Revising an effect:** start from its Library item
(`pnpm -s animation:preview library:avatar-effect/<name>` prints its folder).
Copy the folder to `.animama-drafts/effects/`, edit, check and preview, then
save a Local effect under the same name. Changing an Included effect is a
promotion with `"mode": "replace"`.

**Upgrading an effect to a flipbook:**

1. Start from the Library item
   (`pnpm -s animation:preview library:avatar-effect/<name>` prints its
   folder; copy it to `.animama-drafts/effects/`) and keep its image as the
   key frame.
2. Make the frames with `animama-effect-assets` step 7: `frames --mode
   boil` or `draw-on` from the key, or frames each edited from the one
   before when the shape changes. Assemble the sheet with `flipbook` on the
   key's canvas (`--cell 256`, no `--trim`, so the effect keeps its size,
   placement and per-use sizes), point `art.image` at it and add the
   printed `art.flipbook`.
3. Choose its playback: `loop` or `pingpong` for an effect held through a
   Reaction, `once` for a beat (its last frame holds until the event ends).
4. Check and render with `--times` spread across the frames, one in the
   middle of each (`(k + 0.5) / fps` s for frame `k`), plus a late time for
   a held effect. To see the draft in a Gesture that uses the effect, add
   `--with-clip library:<gesture> --replace-effect <alias|ref>`: the draft
   stands in for that dependency and plays from the Gesture's events with
   their overrides, so `--times` are seconds from the Gesture's start (the
   run prints when the events start). Without it, the Gesture plays its own
   (Included) effect beside the draft applied at 0. Then start the live
   preview for the owner (step 5).
5. Save it as Local content (step 6). Replacing the Included effect is a
   promotion with `"mode": "replace"`, only with the owner's approval
   (step 9); its Gestures and Reactions pick up the sheet.

## Decision rules

- Design for the gag. Avatar (and Scene) Effects borrow anime's visual
  comedy: each is a symbol an anime artist would draw on a character for a
  joke or a beat. Name the trope and a known example in the brief and in
  every art prompt, keep the shape iconic and exaggerated, and judge the
  result by whether the joke reads, not by how polished it looks. Art the
  owner supplies takes precedence.

- The brief decides the attachment: floating face art for emotes and eye
  shapes, painted face art for blush, tears and skin tints, body art for
  things on the chest or hands, stickers for comic text and props beside the
  head, the silhouette for a whole-body mood. Read the attachment table in
  [what](references/what.md).
- An effect a Gesture plays is action-bound: it carries the motion's meaning,
  sits on the acting hand, mouth, head or body (or comes out of the motion)
  and lands on a beat. Reactions already show emotion face paint, so prefer
  action-bound art; a Gesture may still reuse an Included blush, sweat, anger
  or gloom effect where it adds meaning. Effects only
  idle Gestures play are silent (`"sound": null` when promoted), and idle
  Gestures set `playAccompanyingSound: false` on every effect event.
- An effect owns its art (image and flipbook), region, face options and
  declared sounds, and its default attachment, look and motion (pulse, spin,
  drift, keyframes). The Gesture or Reaction event owns when it plays and its
  fades, and may override the effect's attachment (same kind), appearance and
  motion for that one use and pick one of its declared sounds. Keep the
  effect's motion short and loop-friendly.
- Reuse before adding: when a Gesture or Reaction needs an existing Library
  effect in a different place, look or motion, or with another of its
  declared sounds, place it through that event's `override` (fields in the
  `animama-animation` skill's clip format) instead of authoring a variant
  effect. Create a new effect only for new art or a new attachment kind.
- Use a flipbook when the shape itself changes (a drop forms, a puff
  billows, lines shoot out) or should look hand-drawn (line boil); use pulse,
  spin, drift or keyframes to move, scale, turn or fade the art. Combine them
  when both help, such as a boiling mark that pops in with keyframes.
- Eye effects usually hide the real eyes (`forceBlink`, `hideEyeDetails`,
  `faceCleanup` default on). Keep highlights or lashes only when the art is
  drawn to sit on them.
- Effects on the lip-synced mouth are previewed and saved but not used in
  Reactions or Gestures.
- Effects in the `eyes`, `undereye`, `blush` or `mouth` region replace each
  other (a new eye effect replaces the old one); `emote` and `full_face`
  effects stack. Body, sticker and silhouette effects coexist, up to four at
  once.
- Prefer the smallest art that reads at chat size; budgets in
  `animama-effect-assets` are the default ceiling.
- Checks prove the effect is valid, attached and visible; they cannot judge
  whether it is funny or fits the expression. Look at the renders and the
  preview, and report what was not reviewed.

## Verification and currency

Commands and references match Avatar Effects v2 as of 2026-10-08. Browser
procedures in [how](references/how.md) are source-derived. Recheck named
source symbols when behavior differs. Distinguish check output, render
sheets, the owner's live preview, save/reopen, Action playback and live chat
playback in the hand-off.

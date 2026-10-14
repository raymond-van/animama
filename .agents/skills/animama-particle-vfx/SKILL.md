---
name: animama-particle-vfx
description: Create, revise and tune Animama Particle Effects (three.quarks emitters attached to an Avatar) from a written brief — textures through the effect-asset skill, an effect folder (descriptor, Quarks manifest, PNG textures), `pnpm -s effects check`, review renders and the owner's live preview on both Included Avatars, Save as Local content through the Particle Effect creator, use in a Gesture or Reaction, and an owner-gated Promote to Included step — and operate the /particle-effects/ creator, three.quarks settings and Animama's particle playback by hand. Use for particle bursts, streams, orbits, rain and glows around the Avatar; Avatar Effect decals and Scene backgrounds have their own skills.
---

# Animama Particle VFX

Turn an idea into a Particle Effect that lands its beat in chat. You write a
**brief**, make its textures with the `animama-effect-assets` skill, write an
**effect folder** (`<stem>/<stem>.json`, its `particle.json` Quarks manifest
and `textures/`), check and render it, show it to the owner live, and save it
as Local content through the creator. Never write `content/included/` except
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
   expresses, how loud, its mechanic, how long), with your recommended option
   first; skip it when the request settles these or the owner says to use
   your judgement. See [brief](references/brief.md).
1. **Write the brief** before any art, in
   `.animama-drafts/effects/<stem>-work/brief.md`: what it expresses, the
   Reaction emotions and intensities it suits, its **mechanic** (one
   long-lived particle, a burst, a stream, an orbit, rain or layered pops),
   its emitters and how they fit together, anchor and placement, duration,
   art direction and budget. Confirm it with the owner when a batch or new
   library item depends on it. Template in [brief](references/brief.md).
2. **Make the textures** with `animama-effect-assets`: `--budget
   particle-texture` for one sprite, `particle-sheet` for a sprite sheet
   (frames near 256 px, a grid of at most 16 × 16 that matches the emitter's
   U and V tile counts). Particle art is glossy polish (glows, glints, soft
   streaks, bokeh) with an anime symbol where the emotion needs one, distinct
   from Scene art's flat motifs: in the asset prompt, replace the template's
   flat-colour style line with that (soft gradients, a glow, a glint). Draw
   art for a stretched billboard lying horizontally (see [effect
   folder](references/effect-folder.md)). A texture that still fails after
   one targeted regeneration is dropped or replaced by another texture of the
   effect, and the hand-off says so. Keep sources and previews in
   `.animama-drafts/effects/<stem>-work/` and only final PNGs in the effect
   folder's `textures/`.
3. **Write the effect folder** from the closest Included effect
   (`content/included/vfx/particle/quark/<stem>/`) or a creator export, as
   [effect folder](references/effect-folder.md) describes: descriptor with
   `content_type: "particle_effect"`, name, description and
   `runtime_defaults` (anchor, durations, `max_particles`), the manifest's
   emitters, and every texture listed with role `texture`. For what each
   emitter field does, read [three.quarks mechanics](references/three-quarks.md).
   Choose the **name** now: Local names use letters, digits, spaces, `.`, `_`
   and `-` only, and the saved Local folder is the lowercased name with
   spaces and `_` as `-` (`Twinkle Shimmer` → `vfx/particle/twinkle-shimmer/`).
4. **Check:** `pnpm -s effects check <folder>`. It checks every texture
   against its budget (a texture an emitter tiles is held to
   `particle-sheet`), applies Save's readiness rules (emitters, references,
   limits, own textures named like built-in ones), prints Save's estimate of
   particles alive at once (a conservative upper bound from rates, bursts and
   the longest `startLife`, not a measured count) against the declared
   `max_particles` and the 512 limit, and renders both Included Avatars with
   and without the effect to prove it is visible. Fix every FAIL; read every
   WARN; an accepted art WARN (such as `interior_translucency` on a glow)
   repeats on every run, so say in the hand-off which you accepted. Each
   Avatar must show particles in some frame. The default times are
   0.25 s and 1 s; pass `--times` inside the effect's life (a 0.9 s burst:
   `--times 0.05,0.2,0.5`), and expect a WARN "nothing shows at …" for a
   time after it has faded.
5. **Look:** `pnpm -s effects:render <folder> --out
   ../../../.animama-drafts/effects/<stem>-work/renders/<stem>.png --times
   0.05,0.2,0.5,1,2` (pick times that cover emission, the peak and the fade),
   and larger tiles when direction matters (`--tile 512x640 --views front`).
   Renders use a fixed random seed, so a sheet repeats exactly. Use
   `--with-clip library:<gesture>` (or `library:reaction/<name>`) when it must
   follow motion or sit among a Reaction's other effects (its own Avatar,
   Particle and Scene Effects play too; `--replace-effect <alias>` plays yours
   in place of one of its Particle Effects, from its events), and
   `--together` with other effect folders. Judge it against the
   Scene backgrounds of the Reactions it suits: a pale effect can vanish on a
   pale Scene. Read the
   sheets yourself and revise until the effect reads as the brief. Then start
   the live preview for the owner: `pnpm -s animation:preview <folder>` (it
   opens the system browser unless `--no-open`, uses port 5173 or `--port`,
   and repeats 0.5 s after the effect's playback duration; `--duration <s>`
   holds it longer; its **Portrait** camera frames the Avatar as chat does).
   Keep the preview running until the owner has reviewed it
   (run it in the background and give them its URL), and stop it afterwards.
   The owner approves it here before it is saved. Notes go to
   `<stem>.review.json` beside the effect folder; apply each and resolve it
   with `pnpm -s animation resolve <notes.review.json> <id> <what changed>`.
6. **Save through the creator:** `pnpm -s effects save <items.json>` with
   `[{ "source": "<stem>", "name": "...", "description": "..." }]` (paths
   relative to the items file). It imports the creator document (manifest and
   settings) into the Particle Effect creator, chooses each texture the
   creator reports missing (built-in textures come from the creator's own
   copies), saves, reads the item back, compares settings, manifest and
   texture bytes with the folder, and reopens it; a Local effect with the same
   name is revised. It prints the Local folder each name saves to, refuses
   names the app would refuse and own textures named like built-in ones, and
   prints `Saved <name>: <url>` (or `Revised`) only after the read-back and
   reopen pass. A failed read-back leaves the item saved as the creator kept
   it: fix the folder and save again, which revises that item. Or do the same by hand
   ([creator](references/creator.md)). Never equip unless asked.
7. **Use it** when the brief names a Gesture or Reaction: add a particle event
   in the Action creator (anchor, offset and timing are the event's; the
   effect's defaults apply otherwise), preview it there, and check it on a
   test Anima in chat when timing against speech matters. For a heavy
   Reaction, `pnpm -s effects:bench --reaction library:reaction/<name>`
   measures its effects on this machine's GPU (budget: 4 ms added per frame).
   See [integration](references/integration.md).
8. **Hand off** with the brief, the saved item and edit URL, the check summary
   (estimate against budget), the render sheets, preview notes and what was
   not reviewed.
9. **Promote to Included** (never by default): only when the owner explicitly
   approves each item, on a task branch with a PR. Promote the saved Local
   item the owner reviewed. See [promote](references/promote.md).

**Several effects at once:** follow [batch](references/batch.md).

**Revising an effect:** start from its Library item (`pnpm -s
animation:preview library:particle-effect/<name>` prints its folder). Copy
the folder to `.animama-drafts/effects/`, edit, check and preview, then save
a Local effect under the same name. Changing an Included effect is a
promotion with `"mode": "replace"`.

## Decision rules

- Particle Effects are glossy, glowing polish, like a selfie filter or a
  gacha pull, that feels three-dimensional at chat size. A full effect is
  built in layers, one emitter each, using those it needs:
  1. a **hero**: the main shape as one long-lived particle that swells,
     beats or turns (Size, Color and Rotation Over Life);
  2. an additive **halo**: a soft glow sprite behind the hero, larger and
     faint;
  3. **sparkles and dust**: small, short-lived additive particles around or
     trailing the hero;
  4. **extras** where the beat needs them: a pulse, an arrival or exit burst,
     a ring.
  The owner's quality bar is Heart Burst, whose approved folder is checked in
  at [references/heart-burst/](references/heart-burst/) (check, render or
  preview it like any effect folder, and read its `particle.json` for how the
  layers are built): its hero is glossy, with a highlight and soft shading
  rather than a flat single colour, its glow is gentle, and its ring and
  sparkles have their own particles. Match that level of quality and finish;
  a simpler effect may use fewer layers (no ring, no sparkles) and any motion
  the beat needs, not necessarily a pop. Pass its
  `textures/glossy-heart.png` as the style reference when generating art.
  Glow comes from additive layers, not bloom: the chat canvas is transparent
  and has no post-processing. A flat single sprite reads as a sticker, and a
  symbol an anime artist draws on a character (a sweat drop, an anger vein)
  belongs to Avatar Effects.
- Design for the beat: the mechanic and timing carry the emotion (a burst for
  surprise, a slow stream for affection, a drizzle for gloom). Name the polish
  or trope it borrows in the brief and in every texture prompt.
- Keep the three durations apart: an emitter's cycle, each particle's
  lifetime, and the effect's playback duration. Looping an emitter does not
  lift the playback limit, and a particle born late lives past its emitter.
- Declare the smallest `max_particles` that covers the estimate; do not raise
  budgets to silence a check without understanding the fields.
- Prefer the effect's own textures; reuse a built-in creator texture only on
  purpose (it is third-party art and keeps its own licence record).
- An emitter per layer, at most 16; prefer fewer, larger, readable sprites
  to many tiny ones at chat size.
- The creator edits only part of three.quarks. A field in upstream docs is
  not proof the creator or runtime supports it; read the limitations in
  [three.quarks mechanics](references/three-quarks.md).
- Checks prove the effect is valid, budgeted and visible; they cannot judge
  whether it lands the beat. Look at the renders and the preview, and report
  what was not reviewed.

## Read for the task

- Emitter behaviour, generators, rendering, JSON and compatibility:
  [three.quarks mechanics](references/three-quarks.md).
- Creator controls, textures, import/export, preview, Save and recovery:
  [creator](references/creator.md).
- Anchors, lifetime, budgets, content resolution and Actions:
  [integration](references/integration.md).

## Verification and currency

Commands and references match the Particle and Scene Effects work (#297) as
of 2026-10-10, with `three.quarks`/`quarks.core` 0.17.1 and Three.js 0.182.0;
confirm the lockfile before version-sensitive claims. Distinguish check
output, render sheets, the owner's live preview, save/reopen, Action playback
and live chat playback in the hand-off.

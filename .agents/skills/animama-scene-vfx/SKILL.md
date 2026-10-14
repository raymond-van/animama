---
name: animama-scene-vfx
description: Create, revise and tune Animama Scene Effects (animama/scene-effect/1 backgrounds and focus lines drawn behind and in front of the Avatar) from a written brief — art through the effect-asset skill, an effect folder (descriptor with its definition, plus PNG images), `pnpm -s effects check`, review renders and the owner's live preview on both Included Avatars, Save as Local content through the Scene Effect creator, use in a Gesture or Reaction, and an owner-gated Promote to Included step — and operate the /scene-effects/ creator's layers (solid, gradient, pattern, tile, rays and lines, marquee, scatter, entry flash) and focus lines by hand. Use for emotion backgrounds and screen-wide anime effects; Avatar-attached art and particle emitters have their own skills.
---

# Animama Scene VFX

Turn an idea into a Scene Effect that sets the mood of a beat in chat. You
write a **brief**, make its art with the `animama-effect-assets` skill, write
an **effect folder** (`<stem>/<stem>.json` with an `animama/scene-effect/1`
definition, plus its images), check and render it, show it to the owner live,
and save it as Local content through the creator. Never write
`content/included/` except through the gated **Promote to Included** step
(step 9).

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
   expresses, background or focus lines, how loud, held or timed), with your
   recommended option first; skip it when the request settles these or the
   owner says to use your judgement. See [brief](references/brief.md).
1. **Write the brief** before any art, in
   `.animama-drafts/effects/<stem>-work/brief.md`: what it expresses, the
   Reaction emotions and intensities it suits, its **kind**
   (`background_layers` or `focus_lines`), its layers back to front and how
   they fit together (keep a calm zone behind the face), motion, duration,
   art direction and budget. An emotion background follows its approved
   family design when one exists: the family brief's layers, palette and
   motion govern; its mock and sample art are sketches, and its layer names
   are design shorthand to map onto [layers](references/layers.md). When you
   depart from it without an interview, list each departure in the brief so
   the owner can accept or reject it at the preview. Template in
   [brief](references/brief.md).
2. **Make the art** with `animama-effect-assets`: `--budget scene-sticker`
   for scatter and marquee items, `scene-tile` for a repeating tile (it may be
   opaque and keeps its margins). Scene art is a flat anime background motif:
   bold clean silhouettes, flat colour with at most one cel-shade step, thin
   tinted outlines; it differs from Particle art's glossy glow. A family's
   sample art is draft direction: pass it as the style reference, not as the
   final image. Make PNGs: a promoted Scene keeps only PNG art. Name each file as the definition will
   name it, with letters, digits, `.`, `_` and `-` only. Keep sources and
   previews in `.animama-drafts/effects/<stem>-work/`.
3. **Write the effect folder** as [effect folder](references/effect-folder.md)
   describes, starting from its example descriptor, the closest Included
   Scene (`content/included/vfx/scene/<stem>/`; most are the older marquee
   style) or the every-layer example
   `src/frontend/web/src/lib/content/fixtures/scene-effect-all-layers.json`.
   Layer fields and ranges are in [layers](references/layers.md); focus lines
   in [focus lines](references/focus-lines.md). Choose the **name** now: Local
   names use letters, digits, spaces, `.`, `_` and `-` only, and the saved
   Local folder is the lowercased name with spaces and `_` as `-`
   (`Proud Radiance` → `vfx/scene/proud-radiance/`).
4. **Check:** `pnpm -s effects check <folder>`. It checks each PNG against its
   budget (a tile against `scene-tile`, items against `scene-sticker`), the
   definition against the shared Scene limits the creator and backend apply
   at Save, that every image an item shows is listed (and warns about listed
   images nothing shows), and renders both Included Avatars with the Scene
   layers as chat draws them to prove something is visible; each check
   prints a PASS or its problems. Fix every FAIL; read every WARN.
5. **Look:** `pnpm -s effects:render <folder> --out
   ../../../.animama-drafts/effects/<stem>-work/renders/<stem>.png --times
   0.1,0.5,1.5,2.5`, and judge density on a chat-shaped sheet (`--tile 960x600
   --views front`): line and scatter counts are spread across the whole view,
   so narrow tiles look denser than desktop chat. An entry flash needs an
   early time; a drifting layer repeats every travel ÷ speed seconds (a drop
   falling 230 px/s across 600 px loops in about 3 s), so pick times inside
   one loop. Scatter placement comes from the seed and the view size: copy
   the folder once per seed under its own stem (`effects:render` has no seed
   option), render the copies in one run with `--out` a directory (one sheet
   each; not `--together`, which shows one Scene per kind), and keep the seed
   that spaces items best. Use
   `--with-clip library:reaction/<name>` to see it with a Reaction; a
   Reaction that plays its own Scene of the same kind replaces yours, so pick
   one without, add `--replace-effect <alias>` to play yours in place of
   that Scene from its event, or judge that in step 7. Read the
   sheets yourself and revise until it reads as the brief and the face stays
   clear. Then start the live preview for the owner: `pnpm -s
   animation:preview <folder>` (a held Scene re-applies every 4 s and a Scene
   with its own duration 0.5 s after it ends; `--duration <s>` holds it
   longer; sway and drift show only live, not in still renders). Keep the
   preview running until the owner has reviewed it (run it in the background
   and give them its URL), and stop it afterwards.
   The owner approves it here before it is saved. Notes go to
   `<stem>.review.json` beside the effect folder; apply each and resolve it
   with `pnpm -s animation resolve <notes.review.json> <id> <what changed>`.
6. **Save through the creator:** `pnpm -s effects save <items.json>` with
   `[{ "source": "<stem>", "name": "...", "description": "..." }]` (paths
   relative to the items file). It imports the editor document into the
   Scene Effect creator, chooses each image (the creator fills every use of a
   missing image with the file of the same name), saves, reads the item back,
   compares the definition and image bytes with the folder, and reopens it;
   a Local Scene with the same name is revised. It prints the Local folder
   each name saves to, refuses names the app would refuse, and prints `Saved
   <name>: <url>` (or `Revised`) only after the read-back and reopen pass. Or do the same
   by hand ([creator](references/creator.md)). Never equip unless asked. A
   Scene with a sound is saved by hand.
7. **Use it** when the brief names a Gesture or Reaction: add a Scene event in
   the Action creator (it lasts until the clip clears it or its own duration
   ends, and a clear brings back the Scene shown before), preview it there,
   and check it on a test Anima in chat. One Scene of each kind shows at a
   time.
8. **Hand off** with the brief, the saved item and edit URL, the check
   summary, the render sheets, preview notes and what was not reviewed.
9. **Promote to Included** (never by default): only when the owner explicitly
   approves each item, on a task branch with a PR. Promote the saved Local
   item the owner reviewed. See [promote](references/promote.md).

**Several effects at once:** follow [batch](references/batch.md).

**Revising an effect:** start from its Library item (`pnpm -s
animation:preview library:scene-effect/<name>` prints its folder). Copy the
folder to `.animama-drafts/effects/`, edit, check and preview, then save a
Local Scene under the same name. Changing an Included Scene is a promotion
with `"mode": "replace"`, which keeps its kind.

## Decision rules

- A Scene sets the mood around the Avatar; the face carries the expression.
  Keep a calm zone behind the head (`keepFaceClear` on scatters, paler
  gradient bands, lines that thin out before the face). In chat the face sits
  at about 0.3–0.45 of the view height, centred.
- Layers stack back to front: solid, gradient, pattern, tile, screen (rays or
  lines), marquee, scatters (up to three), entry flash. Use the fewest that
  land the mood; each layer gets one job.
- Motion is slow and loop-friendly; save fast motion and the entry flash for
  surprise and shock beats.
- `durationMs: null` holds the Scene until something clears it (an Action's
  clear, input when `dismissOnInput`); a number (100–30000 ms) ends it.
- Every colour is six-digit hex (`#rrggbb`).
- Checks prove the definition is valid, within limits and visible; they
  cannot judge whether the mood fits. Look at the renders and the preview,
  and report what was not reviewed.

## Read for the task

- Layer fields, ranges and how they look: [layers](references/layers.md).
- Focus lines: [focus lines](references/focus-lines.md).
- The creator, images, import/export and Save: [creator](references/creator.md).
- The runtime, z-order and clip events:
  `docs/frontend/runtime/scene-vfx.md`.

## Verification and currency

Commands and references match the Particle and Scene Effects work (#297) as
of 2026-10-10. The shared limits are `src/frontend/web/src/lib/scene-vfx/limits.ts`
(parity record `src/frontend/web/src/lib/content/fixtures/scene-effect-limits.json`);
recheck them when a value matters. Distinguish check output, render sheets,
the owner's live preview, save/reopen, Action playback and live chat playback
in the hand-off.

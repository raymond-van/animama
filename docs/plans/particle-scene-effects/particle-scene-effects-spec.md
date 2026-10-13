# Launch-quality Particle and Scene Effects, their pipelines and simpler creators

Status: Agreed (owner, 2026-10-09)
Owner decision: Intent discovery on 2026-10-09 settled the problem, scope, the
three-plan delivery order and the decisions listed under
[Open questions and decisions](#open-questions-and-decisions). The owner then
asked for this draft and, on review the same day, resolved its open questions
(see the dated spec-review decisions) and accepted the spec. Items still marked
**Proposal** are
fixed by the named plan or gate: the R2 capability list and R6 budget values by
Plan 1, the R9 and R10 lists before Plan 2 starts (decided 2026-10-10).
Authoritative source: [#297](https://github.com/raymond-van/animama/issues/297),
published 2026-10-09 and updated with the before-Plan-2 decisions, the
Plan 2 R9 additions, the owner's Plan 2 review, the Plan 3 R16 trim and the
Plan 3 design decisions (read back at 2026-10-13T19:44:59Z). This file is a snapshot of that issue text; refresh it
from the issue before resuming and do not edit it as a competing source.
Related: [#298](https://github.com/raymond-van/animama/issues/298) (Avatar
Effects v2: unified effects creator, effect preview, shared effect-asset skill
and the Avatar Effect pipeline this work mirrors).
Source revision: `bfc0de4` (main after #345 and #378).

## Problem and intended users

Avatar, Particle and Scene Effects make chatting with an Anima engaging and a
little magical. Avatar and Scene Effects borrow from anime, for emphasis and
comedy. Particle Effects borrow from selfie filters and gacha games. Avatar
Effects were rebuilt in #298. Particle and Scene Effects were deferred here and
are below launch quality.

**The Particle library looks the same everywhere.** There are 19 Included
Particle Effects (`content/included/vfx/particle/quark/`):

- Only 6 are used, all by Reactions at intensity 2 or 3: hearts, sparkles,
  stars, question-marks, exclamation and rain-cloud.
- Most are single bursts of 256 px generated icons that float up and fade. The
  owner judges only `hearts-v1` good enough to ship, and nothing uses it.
- Five are creator leftovers with placeholder names: `hearts-v2`,
  `question-v1`, `exclamation-v1`, `star-v2` and the debug `flame-loop`.
  `flame-loop`'s estimated particle count (79) exceeds its declared budget
  (64).
- Several overlap: four heart effects, `sad-rain-puff` ⊃ `rain-cloud`,
  `sleep-bubbles` ⊃ `zzz`.

Effects should be varied and rich. They should be built from coherent layers
and use the mechanic that fits the moment. Sometimes that is one long-lived
particle, and sometimes many short-lived ones.

**Scene backgrounds are near-identical emoji scrolls.**

- 19 of the 24 Included Scene Effects are per-emotion backgrounds. They differ
  only in a pastel colour, a white dot, heart or star pattern, and a diagonal
  marquee of Twemoji images.
- Only intensity-3 Reactions play them. Caring, desire, confusion, annoyance
  and remorse have none.
- `comic-pop`, `shoujo-hearts` and `dark` are used by nothing.
- Every image is an unmodified Twemoji SVG (CC BY 4.0), which needs
  attribution. The licence records disagree on the copy count (31 or 26) and
  on the upstream fork.
- Scene layers offer only a solid colour, three procedural patterns, an image
  marquee and focus lines. They have no gradients, custom pattern tiles,
  frame animation or per-item variation.

**The creators are hard for new users.**

- The Particle creator exposes raw three.quarks parameters across five tabs.
  Particle FX offers only Start from scratch in the template picker.
- The Particle creator identifies a texture by matching its file name against
  a fixed built-in list of 38 textures. A texture outside that list opens as
  no texture, so effects with new art cannot be edited, saved as Local content
  or offered as templates.
- Scene FX templates are colour swatches, not renders.

**No agent pipeline exists for either kind.**

- `animama-particle-vfx` is an operating manual, and there is no Scene skill.
- `pnpm -s effects check`, `save`, `promote` and `effects:render` handle Avatar
  Effects only. `animation:preview` plays a Reaction's Particle Effects but
  cannot preview one on its own, and it does not show Scene Effects.
- `animama-effect-assets` has no budgets for particle textures or Scene art.

Intended users:

- **Anima users** see varied, well-crafted particles and backgrounds in chat.
  Their strength grows with a Reaction's intensity.
- **Creators**, including new users, start from a template and adjust a few
  broad controls. Experienced creators keep every control.
- **Coding agents** author Particle and Scene Effects, and their art, with
  repository skills for owner review.
- **The owner** reviews each effect in a live preview before it enters the
  launch library.

## Goals, scope and non-goals

Delivery uses three ExecPlans under this one specification, in order. Each has
its own branch and PR.

- **Plan 1, platform:** R1–R8.
- **Plan 2, content:** R9–R14. It starts after Plan 1 merges.
- **Plan 3, creators:** R15–R17. It starts after Plan 2 merges. Content does
  not wait for the creator work.

In scope:

1. Particle texture import, with textures carried by saved and packaged
   effects.
2. Scene layer capabilities that the approved background designs need.
3. Check, render, preview, save and promote tooling for Particle and Scene
   Effects, and asset budgets for their art.
4. Pipeline skills: `animama-particle-vfx` rewritten as a pipeline, and a new
   `animama-scene-vfx`.
5. About 10–12 Particle Effects, chosen for Reactions and varied in mechanics.
   `hearts-v1` is kept unchanged.
6. About 8 Scene background designs, one per emotion family. All 24 emotions
   get a preset with their own custom art and colour.
7. An Animama sticker set that replaces Twemoji in the Scene creator.
8. Reactions rewired on an escalating intensity ladder.
9. Removal of every other current Included Particle Effect and every current
   Included Scene Effect once its replacement is approved. This includes
   duplicate copies in bundled app catalogs and tests.
10. Simple-first Particle and Scene inspectors with the full controls under
    Advanced, and rendered template thumbnails.

Allowed when an approved design needs them (not required):

- Sounds for new effects.
- Using new effects in more Gestures.
- Changes to the particle runtime or its limits (today 4 active effects and 512
  declared particles), with the reason recorded.

Non-goals:

- Redesigning Focus Lines. Their renderer stays. Their presets and templates
  may change.
- The Avatar Effect model, creator and library (#298).
- The unified creator shell and template picker themselves, which exist. This
  work adds Particle and Scene templates to them.
- Chat selecting effects directly rather than through Actions.
- Proof on VRM models other than the two Included Avatars.

## Required behavior

### Plan 1 — platform

#### R1 — Particle texture import

- In the Particle creator, a user can add a PNG texture to an emitter. Its
  frame grid can be stated, so it can be used as a sprite sheet. The texture is
  stored with the effect, alongside today's built-in textures, which stay
  selectable.
- Opening an effect whose textures are not in the built-in list keeps those
  textures, including Included effects, templates and imported JSON. Saving it
  as Local content, reopening it and exporting or importing it in a Portable
  package keep them too.
- An oversized, malformed or non-PNG file is refused with a message naming the
  limit. The refusal happens before the file is decoded or uploaded to the GPU,
  and the draft is unchanged.
- Draft recovery keeps imported textures, within a stated storage bound.

#### R2 — Scene layer capabilities

- The Scene renderer, the Scene creator and saved Scene Effects gain the layer
  capabilities that the approved background designs (R10) require.
- **Proposal:** the likely candidates are linear and radial gradients, custom
  image pattern tiles, procedural anime screens (vertical gloom lines,
  radiating rays), per-item size, rotation and opacity variation in the
  marquee, and frame-animated items.
- The final list is fixed when the R10 designs are agreed and is recorded in
  the plan. Plan 1 drafts the eight family briefs and mock renders for owner
  approval before it builds them (owner decision, 2026-10-09). Capabilities no
  approved design uses are not built.
- Each capability:
  - renders the same in chat, in the creator, in the Library preview dock and
    in desktop picture-in-picture where scene layers show today;
  - round-trips through Save, reopen and Portable package export and import;
  - has validation and size limits enforced on the frontend and backend.
- Existing `animama/scene-effect/1` definitions keep working. If the
  definition changes incompatibly, the plan states how saved effects are
  handled.

#### R3 — Check and render

- `pnpm -s effects check` accepts a Particle or Scene effect folder. It:
  - checks art against its budget (R6);
  - parses the definition as the runtime does and names any bad field;
  - checks particle counts against the declared budget and runtime limits;
  - plays the effect on both Included Avatars;
  - proves from rendered frames, compared with a baseline without the effect,
    that the effect is visible.
- `pnpm -s effects:render` writes contact sheets of a Particle or Scene Effect
  on both Included Avatars at chosen times. Particle Effects render in the 3D
  scene. Scene Effects render their layers behind and in front of the Avatar as
  the chat scene draws them.
- Both commands accept an effect folder or a Library item. Rendering several
  effects together (for example a Reaction's Avatar, Particle and Scene
  Effects) shows them as chat would.

#### R4 — Live preview

- The headed preview (`animation:preview`) shows a Particle or Scene effect
  source or Library item on both Included Avatars. It reloads when the source
  changes and records review notes.
- A Reaction or Gesture played in the preview shows its Scene Effects as well
  as its Avatar and Particle Effects, as in chat.

#### R5 — Save and promote

- `pnpm -s effects save` saves Particle and Scene effect folders as Local
  content through each kind's creator, in the same way as for Avatar Effects:
  it imports, attaches the art, saves, reads the item back and reopens it. It
  refuses names the app would refuse.
- `pnpm -s effects promote` promotes an owner-approved Local Particle or Scene
  Effect, or a Reaction or Gesture that depends on one, to Included content on
  a task branch. It writes the licence and source-review records the release
  checks require. It replaces or removes Included items when told to.

#### R6 — Asset budgets

- `animama-effect-assets` and `pnpm -s effects:assets` gain named budgets for
  particle textures, particle sprite sheets, Scene stickers, Scene pattern
  tiles and full Scene backgrounds.
- **Proposal:** the budget values follow the existing Avatar Effect budgets,
  with frames near 256 px and sheets up to 2048 px. The plan fixes the values.
- The app enforces the same limits on import (R1, R2).

#### R7 — Pipeline skills

- `animama-particle-vfx` becomes a pipeline skill, and a new `animama-scene-vfx`
  pipeline skill is added. Both follow the `animama-avatar-vfx` shape:
  - a short interview;
  - a written brief before any art;
  - art through `animama-effect-assets` (optionally the global `image-gen`
    skill);
  - an effect folder;
  - check and renders;
  - the owner's live preview;
  - Save as Local content through the creator;
  - use in a Gesture or Reaction;
  - a hand-off;
  - an owner-gated Promote to Included step.
- Each skill also carries its kind's operating knowledge: three.quarks
  mechanics and the creator for Particle; layers, focus lines and the creator
  for Scene. Batch authoring follows the Avatar Effect skill's batch reference.
- Each brief states:
  - what the effect expresses;
  - the Reaction emotions and intensities it suits;
  - its mechanic (for example one long-lived particle, a burst or a stream);
  - its layers and how they fit together;
  - its art direction;
  - its duration and its budget.
- A fresh-agent dry run follows each skill end to end, and the gaps it finds
  are fixed.

#### R8 — Documentation

The following describe texture import, the new Scene capabilities and the
tooling:

- the runtime guides (`docs/frontend/runtime/avatar-particle-vfx.md`,
  `docs/frontend/runtime/scene-vfx.md`);
- the glossary;
- the effect skills that refer to Particle or Scene work (`animama-avatar-vfx`,
  `animama-effect-assets`, `animama-animation`).

### Plan 2 — content

#### R9 — Particle Effect library

- About 10–12 Particle Effects are chosen for the Reactions where users see
  them.
- Across the set they use different mechanics: a single long-lived particle,
  bursts, streams, orbits, rain and layered pops.
- The style is mixed. Some effects are pure selfie-filter or gacha polish
  (glows, bokeh, sparkle, light rays). Others carry an anime symbol where the
  emotion needs one.
- `hearts-v1` is kept unchanged and counts toward the set.
- Art direction is chosen per effect in its brief. Particle art generally
  differs from Scene art, and an effect's layers are consistent with each
  other.
- Each effect uses new or imported textures where its brief calls for them. It
  stays within the runtime limits unless a runtime change is agreed (see
  [Goals, scope and non-goals](#goals-scope-and-non-goals)).

**Final set (owner, 2026-10-10):** all candidates except #8 (Sweat spray).
Heart burst (#2) is the effect approved in Plan 1's dry run.

| # | Effect | Mechanic and layers | Emotions |
| --- | --- | --- | --- |
| 1 | Heart stream (`hearts-v1`, kept) | Steady stream of hearts from the head | love, caring, desire |
| 2 | Heart burst | One large heart swells and beats, then bursts into small hearts over a soft glow | love, caring, desire, admiration |
| 3 | Twinkle shimmer | A few long-lived glints scale in and out among soft bokeh | admiration, gratitude, optimism |
| 4 | Halo rays | Slow rotating light rays with rising gold motes (aura) | respect, confidence, gratitude, optimism |
| 5 | Star burst | Gacha-pull flash, expanding ring, star shards, lingering glitter | excitement, joy |
| 6 | Confetti | Burst of confetti and ribbons that flutter down under gravity | joy, amusement, excitement |
| 7 | Question orbit | Question marks orbit and bob around the head | curiosity, confusion |
| 8 | Sweat spray | Droplets flicked outward in a panic | nervousness, fear, embarrassment |
| 9 | Fume puffs | Steam puffs vent from the head (overheating) | annoyance, embarrassment, disapproval |
| 10 | Rage aura | Layered flame aura with rising embers from the chest | anger |
| 11 | Stink miasma | Green wisps and bubbles drifting up | disgust |
| 12 | Rain cloud | Cloud with drizzle and splashes over the head | sadness, grief, disappointment |
| 13 | Gloom wisps | Pale will-o'-wisps drift slowly around the Avatar | grief, remorse, disappointment |

**Additions (owner, 2026-10-11 and 2026-10-12, Plan 2 gate G2):** three
fireworks effects, designed with creative freedom, and Sparkle Hearts, from an
owner reference image, join the set, so it has 16 effects with `hearts-v1`.
Their emotions are the Plan 2 ladder's proposals, pending the owner's G4
review.

| # | Effect | Mechanic and layers | Emotions |
| --- | --- | --- | --- |
| 14 | Fireworks show | Three shells burst one after another behind the Avatar, then glitter twinkles down | excitement |
| 15 | Heart fireworks | Two heart-shaped fireworks bloom beside the head, then sparkle and drift down | desire |
| 16 | Golden willow | A golden willow firework opens behind the head and its branches droop and fall | optimism |
| 17 | Sparkle hearts | Heart outlines drawn in tiny twinkling glitter float around the face | caring |

#### R10 — Scene background library

- About 8 background designs, one per emotion family. Each family has its own
  layers, motion and art direction, so families do not look alike.
- Each of the 24 emotions has a background preset in its family's design, with
  its own custom art and colour.
- No emoji or Twemoji art is used.

**Proposal:** the families follow the domain's emotion groups
(`src/backend/animama/domain/emotions.py`). The owner may move an emotion to
another family for visual fit; for example, embarrassment may fit affection
better than revulsion.

| Family | Emotions | Design direction (proposal) |
| --- | --- | --- |
| Affection | admiration, caring, love | Shoujo bloom: soft gradient, drifting petals and bubbles, sparkles |
| Esteem | respect, confidence, gratitude | Radiance: rotating golden rays behind the Avatar |
| Delight | amusement, excitement, joy | Festive pop: bright halftone, bouncing stickers |
| Drive | desire, curiosity, optimism | Anticipation: starry bokeh rising on a gradient |
| Alarm | fear, nervousness, confusion | Shock: dark or flash background with jagged lightning ("gaan") |
| Rejection | anger, annoyance, disapproval | Rage: hot gradient, radiating spikes, anger marks |
| Revulsion | disgust, embarrassment, remorse | Queasy: wobbling swirls in sickly tones |
| Gloom | disappointment, grief, sadness | Gloom: desaturated gradient, vertical gloom lines, falling drops |

#### R11 — Animama sticker set

- The Scene creator's built-in image set is the new Animama art from R10. It
  replaces the 28-item Twemoji list. Users can still add their own images.
- Twemoji files, the bundled emoji catalog entries and the backend emoji
  allowlist are removed. Its licence records and attribution notices are
  removed with them.
- A Local Scene Effect that still contains an emoji item opens in the creator
  with that item marked missing and asks for a replacement. Chat skips the item
  without errors. There is no automatic conversion (owner decision,
  2026-10-09).

#### R12 — Reactions on an escalating ladder

For each of the 24 Reaction emotions:

- **Intensity 1:** no Particle or Scene Effect.
- **Intensity 2:** a fitting Particle Effect where one fits.
- **Intensity 3:** a bigger Particle Effect or a stronger variant, plus the
  emotion's Scene background.

Assignments follow each effect's brief, and their timing works with the
Reaction's expression and its Avatar Effects. A Reaction uses an effect only
when it adds a clear beat. Reaction and Gesture edits use
`animaPoseClip/2.0`. (The `shy-finger-poke` rewiring was dropped on
2026-10-10: #406 deleted that Gesture, and no Included Gesture plays a Particle
or Scene Effect.)

#### R13 — Removal of old content

- Every current Included Particle Effect except `hearts-v1` is removed. Every
  current Included Scene Effect is removed, or replaced under the same content
  ID.
- An item is removed only after the Reactions and Gestures that used it point
  to approved replacements.
- Removal includes the duplicate copies in the bundled app catalogs
  (`src/frontend/web/src/lib/avatar/particle-vfx/catalog.ts`,
  `src/frontend/web/src/assets/effects/scene-vfx/catalog.json`). It also
  includes tests that pin the old mapping, unused curated textures that no
  remaining effect or built-in list needs, and their licence records.
- **Proposal:** debug panels that play `flame-loop` switch to a remaining
  effect or drop the shortcut.

#### R14 — Promotion to Included content

- Each R9 and R10 item, the R11 sticker set, and each R12 change is promoted to
  `content/included/` only after the owner approves it in the live preview on
  both Included Avatars. Promotion is an explicit, owner-approved step in
  Plan 2's PR.
- New Particle and Scene art is promoted under owner-authored licence rules
  worded like the existing `vfx/avatar/**/*` rule: one rule per promoted
  Particle Effect folder (`vfx/particle/quark/<stem>/**`, ahead of the legacy
  `vfx/particle/quark/**` rule, as Gestures are promoted), and one kind-wide
  `vfx/scene/**/*.png` rule. Source-review records use the owner-authored
  form. There is no per-effect "AI-generated" wording, as #298 decided (owner
  decision, 2026-10-09). The included-content integrity and starter closure
  tests pass.

### Plan 3 — creators

#### R15 — Particle inspector, Simple first

- A Particle Effect opens in Simple mode. Simple shows the effect's template or
  name and a few broad controls: amount, size, speed, spread and colour theme.
- Each control adjusts the whole effect and keeps the relationships between its
  emitters, so a layered template stays coherent.
- Advanced shows today's full controls. Values set in either mode show in the
  other. Undo, redo, recovery and Save cover both.

#### R16 — Scene inspector, Simple first

- A Scene Effect opens in Simple mode, with broad controls for its art
  (choosing stickers), colours and motion speed. (Direction and density were
  dropped from Simple on 2026-10-13 to keep it small; they stay under
  Advanced.)
- Advanced shows today's full layer controls, including the R2 capabilities.
  The same mode, undo and recovery rules as R15 apply.

#### R17 — Templates

- The template picker offers the approved Particle Effects and Scene
  backgrounds as Particle FX and Scene FX templates.
- Each template has a thumbnail rendered from the effect on an Included
  Avatar, not a colour swatch.
- Starting from a template opens the creator with that effect's settings and
  art, ready to save as a new Local effect.

## Constraints

- **Compatibility:**
  - Content kinds `particle_effect` and `scene_effect` stay.
  - `particle_vfx` and `scene_vfx` events in `animaPoseClip/2.0` are unchanged
    unless an agreed design needs a new field.
  - `hearts-v1` keeps its content ID and behavior.
  - Existing Local Particle Effects that use built-in textures keep opening and
    playing.
- **Pre-launch removal:** following the #298 precedent, Included items are
  removed outright after re-pointing their users, without a migration for
  Local content that copied or referenced them. A Local Action that references
  a removed Included effect plays without it, and the creator reports the
  missing dependency. **Proposal:** the plan confirms this behavior with a
  test.
- **Data:** during development, update ORM and
  `alembic/versions/0001_baseline.sql` directly; add no Alembic revisions.
  Portable packages must carry imported textures and Scene art.
- **Security:**
  - Imported textures and Scene art are untrusted input. Enforce type, size,
    dimension and frame limits on the frontend before decoding or uploading to
    the GPU, and again on the backend at Save and import.
  - SVG remains restricted as today.
  - Effects make no network requests.
- **Performance:**
  - Stay within the runtime limits unless a runtime change is agreed.
  - For the heaviest intensity-3 Reaction, playing its Particle and Scene
    Effects adds no more than 4 ms of frame time on the owner's development
    Mac, compared with the same Reaction without them (owner decision,
    2026-10-09; #298 set 2 ms for Avatar Effects alone).
- **Accessibility:** the `presentation.disable_vfx` preference continues to
  suppress clip-owned effects. Simple controls are keyboard-operable and
  labelled.
- **Repository boundaries:**
  - The build, tests and app must not depend on an image generator, Codex or
    any skill.
  - Asset scripts work on any PNG.
  - No Cloud dependencies.
- **Creator UI:** following #298's later decision for the Avatar Effect
  creator, the Particle and Scene creators keep the existing shell, layout,
  styling and shared components. Simple mode is a new default view, not a
  visual redesign (owner decision, 2026-10-09).
- **Desktop first:** UI work is verified at desktop sizes, then at narrower
  widths.

## Acceptance criteria

- [ ] **R1:**
  - Tests and a browser walkthrough show the following, on an Included effect
    with non-built-in textures as well as a new one: importing a PNG and a
    sprite sheet into an emitter, saving, reopening, recovering a draft, and
    exporting and re-importing a Portable package.
  - An oversized or non-PNG file is refused with a message, and the draft is
    unchanged.
- [ ] **R2:**
  - Each agreed Scene capability renders in chat, the creator and the preview
    dock.
  - Each round-trips Save and package export and import.
  - Each has frontend and backend validation tests.
  - Existing saved Scene Effects still play.
- [ ] **R3–R5:**
  - `effects check` and `effects:render` produce verdicts and contact sheets
    for a Particle and a Scene effect folder on both Included Avatars.
  - The headed preview plays a Particle source, a Scene source and a Reaction
    with Avatar, Particle and Scene Effects.
  - `effects save` saves and reopens each kind.
  - `effects promote` writes an Included Particle and Scene Effect with their
    records on a test branch.
  - The asset and check scripts have tests.
- [ ] **R6, R7:**
  - For each skill, a fresh agent produces one new effect from a brief, passes
    the checks and renders, and saves it as Local content.
  - The gaps found are fixed.
- [ ] **R8:** the listed documentation is updated.
- [ ] **R9, R10:** each effect in the final agreed lists has a brief and has
      been approved by the owner in the live preview on both Included Avatars.
- [ ] **R11:**
  - The Scene creator offers the Animama sticker set and no Twemoji.
  - No Twemoji file, catalog entry or attribution remains.
  - Emoji-item handling matches the agreed decision.
- [ ] **R12:**
  - A table in the plan lists every Reaction's Particle and Scene Effects by
    intensity, and the owner approves the wired Reactions in the live preview.
  - Every emotion has a background at intensity 3.
- [ ] **R13, R14:**
  - No removed item, bundled duplicate or stale test remains.
  - Promoted content passes `tests/test_included_content_integrity.py`,
    `tests/test_included_content_catalog.py` and the starter content closure
    tests.
- [ ] **Performance:** a recorded measurement of the heaviest intensity-3
      Reaction meets the agreed budget.
- [ ] **R15–R17:**
  - A browser walkthrough with screenshots at desktop and narrow widths covers
    creating each kind from a template, adjusting it in Simple mode, refining
    it in Advanced, undo and redo, save and reopen, and recovery.
  - Template thumbnails are renders.
  - The owner reviews the walkthrough.
- [ ] Applicable checks pass, with any unperformed checks stated:
  - from `src/frontend`: `pnpm check`, `pnpm web:lint`, `pnpm web:test` and
    `pnpm build`;
  - from the repository root: `uv run pytest -q` for the affected backend
    tests and `uv run ruff check`;
  - for content and creator changes, the full `pnpm e2e:test` before merge.

## Open questions and decisions

Decisions (owner, 2026-10-09, intent discovery):

- One spec covers content, pipeline skills and the inspector redesign.
  Delivery runs platform, then content, then creators.
- Particle Effects are chosen for Reactions and varied in mechanics. Their
  style mixes pure magic polish (selfie-filter and gacha) with anime symbols
  where the emotion needs one.
- New art is made with `animama-effect-assets` or `image-gen`. It enters
  effects through a Particle creator texture import, so agent drafts can be
  saved as Local content before promotion and users can bring their own art.
- Scene backgrounds use a distinct design per emotion family, with per-emotion
  art and colour, covering all 24 emotions.
- The Scene renderer may grow to support what the designs need.
- An Animama sticker set replaces Twemoji in the Scene creator, and Twemoji
  and its attribution are removed.
- Reactions follow the escalating ladder in R12.
- Two pipeline skills: `animama-particle-vfx` rewritten as a pipeline and a new
  `animama-scene-vfx`.
- Inspectors are Simple first, with the full controls under Advanced.
- All current Included Particle and Scene content is replaced except
  `hearts-v1`, which is kept unchanged. `shy-finger-poke` is rewired.
- Art direction is chosen per effect. Scene art will generally differ from
  Particle art.
- Focus Lines redesign is out of scope. Sounds, more Gesture use and particle
  runtime changes are not excluded.

Decisions (owner, 2026-10-09, review of this draft):

- **Glossary.** A single long-lived particle is a valid layer of a Particle
  Effect when it uses particle behaviour (emission, life curves, bursting into
  other particles), usually alongside other layers. Art that only sits on the
  Avatar and moves as one piece stays an Avatar Effect. Plan 1 clarifies the
  glossary entry (R8).
- **Scene capability list.** Plan 1 includes an early design step: it drafts
  the eight family briefs and mock renders for owner approval, then implements
  only the capabilities the approved designs need (R2). Final art is Plan 2
  content.
- **Performance budget.** 4 ms of added frame time for the heaviest
  intensity-3 Reaction's Particle and Scene Effects, measured on the owner's
  development Mac (see Constraints). The proposed 2 ms was not adopted.
- **Local emoji items.** Marked missing in the creator, skipped in chat, no
  automatic conversion (R11).
- **Creator UI.** Plan 3 keeps the existing creator shell, layout and styling;
  Simple mode is a new default view (see Constraints).
- **Allowed extras.** Sounds, more Gesture use and particle runtime or limit
  changes are allowed when an approved design needs them, with the reason
  recorded. None is required.
- **Final lists.** Trimming the R9 candidates and confirming the R10 families
  are deferred until before Plan 2 starts. Plan 1's design step may propose
  family changes.
- **Licence rules for new art (Plan 1 review, D1).** The existing
  `vfx/particle/quark/**` rule describes generated CC0 derivatives and new
  Scene PNGs would fall to the catch-all rule, so promotion uses owner-authored
  rules instead (R14).
- **Agreement.** The owner accepted this spec on 2026-10-09 and authorized
  Plan 1 (phases P1–P9) the same day.

Decisions (owner, before Plan 2):

- **R10 families (2026-10-09, Plan 1 gate G1).** The eight family designs as
  drafted, with embarrassment moved from Revulsion to Affection for its Scene
  design.
- **R9 final set (2026-10-10).** All candidates except Sweat spray. The Plan 1
  dry-run effects Heart burst and Gloom Sadness (the Gloom family's sadness
  preset) are used as approved. Quality bar: the level of Heart burst; simpler
  effects are fine and sparkles or rings are not required in each.
- **R9 additions and runtime limits (2026-10-11 and 2026-10-12, Plan 2
  gate G2).** The four effects above join the set (16 in all). The Particle
  emitter limit rises from 8 to 16 and the particle art budgets to 1024 px /
  512 KiB (texture) and 2048 px / 2 MiB (sheet), so layered effects and closed
  auras fit; each new effect's visible span is 20% longer; the particle
  estimate counts particles alive at once. The owner approved all 14 new or
  retuned effects on 2026-10-12.
- **R12 (2026-10-10).** The `shy-finger-poke` rewiring is dropped (the Gesture
  was deleted by #406); this supersedes that part of the 2026-10-09 decisions.

- **R12 ladder (2026-10-10, Plan 2 gate G1).** Intensity 3 escalates through
  the emotion's background, with a bigger Particle Effect where one fits; where
  both tiers share an effect, the background is the step up (no intensity-3
  variants), and fear, nervousness and disapproval have no Particle Effect.
  The approved table is in the Plan 2 ExecPlan.

- **Owner review of Plan 2 (2026-10-12).** G2, G3 and G4 are approved with
  three revisions: every intensity-1 Reaction plays one fitting Avatar Effect
  without its accompanying sound (still no Particle or Scene Effect; it uses
  existing effects, including #462's Kira Star, Question Mark and Sigh Puff,
  and one new effect, Single Tear, plus the droop-style Sigh Puff Droop kept
  as an alternate that no Reaction uses; mouth effects stay out of Reactions because
  they sit on the lip-synced mouth, so amusement-1 uses a redrawn, bolder Eye VV
  and amusement-2 adds #462's Heh Lettering);
  Scene stickers are spread evenly, still stickers never overlap another still
  sticker, layers moving the same way never collide, and a moving sticker may
  pass over another layer's still one, with still stickers in the upper half of
  the emotion backgrounds; Heart Burst plays smaller at the chest with fewer
  small hearts, and caring-3 drops its chest Heart Throb.

- **Plan 3 design (owner, 2026-10-12 and 2026-10-13).** Both creators open in
  Simple; a Simple | Advanced switch in the toolbar changes both panels, and
  Advanced is today's panels. Particle controls are proportional by layer:
  Amount keeps single-particle layers single, Size is particle size, Spread
  scales the footprint, Speed is tempo, and the particle budget auto-fits up
  to 512. The colour theme (Original, Rose, Gold, Mint, Sky, Violet, White)
  recolours the textures and emitter colours together, saving recoloured
  textures as the effect's own. Scene Simple edits each distinct colour and
  the stickers, with one Speed control (R16 trim). Simple controls compute
  from a reference that an Advanced edit resets; a reopened effect starts
  from the effect as saved. Particle templates are the 16 Included effects
  grouped by mechanic; Scene templates are the 24 backgrounds by family plus
  the two focus presets; thumbnails are renders on Annie in per-kind
  folders. `hearts-v1` is displayed as Heart Stream (ID and behaviour
  unchanged).

Open: none.

## Spec

Published in [#297](https://github.com/raymond-van/animama/issues/297); this
file is its snapshot.

## ExecPlan

Plan 1 (R1–R8):
[particle-scene-effects-execplan.md](particle-scene-effects-execplan.md).
Plan 2 (R9–R14):
[particle-scene-effects-content-execplan.md](particle-scene-effects-content-execplan.md).
Plan 3 (R15–R17):
[particle-scene-effects-creators-execplan.md](particle-scene-effects-creators-execplan.md).

## Delivery links

Parent: [#297](https://github.com/raymond-van/animama/issues/297). Plan 1
phases: #386–#394. Plan 2 phases: #443–#449, #466 (PR #463). Plan 3 phases:
#488–#493. Related:
[#298](https://github.com/raymond-van/animama/issues/298).

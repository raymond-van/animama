# Simple-first Particle and Scene creators and their templates (Plan 3, creators)

Source agreement: [#297](https://github.com/raymond-van/animama/issues/297)
(snapshot: [particle-scene-effects-spec.md](particle-scene-effects-spec.md),
matching the issue at 2026-10-13T19:44:59Z, with the R16 trim and the Plan 3
design decisions published), requirements R15–R17 and the Constraints, with
the owner's Plan 3 design decisions of 2026-10-12 and 2026-10-13 (Decision
Log).
Authorized scope: P1–P4 (owner, 2026-10-13, with every agent proposal
accepted). P5 and P6 wait for the owner's go-ahead; gates G1 and G2 apply.
Starting revision: `95a2db39` (`main` after Plan 2, #463).
Branch: `feat/particle-scene-creators`, in a dedicated task worktree. One
branch and one PR for this plan. The PR closes #297 and every phase issue.
Issues: parent #297; phases P1 #488, P2 #489, P3 #490, P4 #491, P5 #492,
P6 #493, sub-issues of #297, each blocked by its predecessor (P4 and P5 by
P3; P6 by P4 and P5). Plans 1 and 2:
[particle-scene-effects-execplan.md](particle-scene-effects-execplan.md)
(#386–#394, #441) and
[particle-scene-effects-content-execplan.md](particle-scene-effects-content-execplan.md)
(#443–#449, #466, #463), whose creators, tooling and library this plan builds on.

## Purpose and context

Plan 3 makes the Particle and Scene creators approachable for new users and
gives them the launch library as starting points:

- **R15:** the Particle creator opens in **Simple** mode: the effect's
  template or name and five broad controls (Amount, Size, Speed, Spread,
  Colour theme). Each control adjusts the whole effect and keeps the
  relationships between its emitters. **Advanced** is today's full set of
  controls.
- **R16:** the Scene creator opens in Simple mode with Art (stickers),
  Colours and Speed. Advanced keeps today's layer controls, including Plan
  1's R2 layers, and is where direction and density are changed (owner trim,
  2026-10-13).
- **R15 and R16:** values set in one mode show in the other. Undo, redo,
  recovery and Save cover both.
- **R17:** the Effects template picker offers the 16 Included Particle
  Effects and the 24 Included Scene backgrounds (plus the two focus presets).
  Each has a thumbnail rendered from the effect on an Included Avatar.
  Choosing one opens the creator with that effect's settings and art, as a new
  unsaved Local draft.

Constraints that shape every phase (spec):

- **Creator UI.** Keep the existing creator shell, layout, styling and shared
  components. Simple mode is a new default view, not a redesign. Do not use
  external prototypes.
- **Accessibility.** Simple controls are keyboard-operable and labelled.
- **Desktop first.** Verify at 1440 × 900, then at about 900 px wide.
- **Compatibility.** `particle_effect` and `scene_effect` stay unchanged.
  Existing Local effects keep opening and playing. Included content keeps its
  IDs.
- **Boundaries.** The build, tests and app depend on no skill, image
  generator or Cloud checkout.

Commands run from the repository root unless stated. Frontend scripts run from
`src/frontend/web`, frontend workspace commands from `src/frontend`.

### Simple control behaviour (owner decisions, 2026-10-12)

**Particle.** All four sliders are proportional (decision P-MAP):

- **Amount** scales the emission (rate per second, rate per metre and every
  burst's count) of each multi-particle layer. A single-particle layer is one
  that emits exactly one particle per cycle, such as a hero, halo, ring or
  flash; it stays single.
- **Size** scales every particle's start size. Size-over-life curves are
  relative, so they are unchanged.
- **Spread** scales the effect's footprint without resizing particles:
  emitter offsets, emission-shape sizes (radius, width, height; angles and arcs
  are unchanged), start speeds, forces, and noise and turbulence amplitudes.
- **Speed** is tempo. The effect plays faster or slower with the same
  choreography:
  - start speeds × k and forces × k²;
  - lifetimes, emitter cycle durations, burst times and burst intervals ÷ k;
  - emission rate per second, rotation, spin and orbit speeds × k;
  - the effect's playback and maximum durations ÷ k.
- **Particle budget.** The declared budget auto-fits the estimate, up to the
  512 limit. A slider stops at the largest value the limits allow and says
  which limit it reached.

**Colour theme (decision P-COLOUR).** A swatch row: Original, Rose, Gold,
Mint, Sky, Violet and White. The swatch list is an agent proposal.

- A theme rotates the hue of the effect's textures and of every emitter colour
  by the same step. The step moves the effect's dominant hue onto the chosen
  hue. White desaturates instead.
- Recoloured textures become the effect's own PNGs, within the particle
  texture budgets. Near-grey textures stay as they are.
- Nothing changes in the runtime or the saved format.

**Scene.**

- **Art:** each sticker layer is listed with its stickers. A sticker can be
  replaced, added or removed through the existing sticker picker or a private
  image, within the layer limits. The background tile can be replaced with a
  private image, as today.
- **Colours (decision S-COLOUR):** one swatch per distinct colour in the
  enabled layers (gradient stops, solid, pattern, rays or lines, flash, focus
  lines), each labelled by where it is used. Changing a swatch changes every
  field that uses that colour.
- **Speed:** a multiplier on every motion rate: scatter drift and spin, tile
  and marquee speed, ray turn and throb, line sway, and focus-line flicker
  timing.
- **Direction and density** are not in Simple (decision S-TRIM). They stay
  in Advanced: each layer's direction, scatter counts, ray and line counts,
  marquee gaps and pattern spacing.
- Controls that do not apply to the effect are hidden, for example Art for
  focus lines and Speed when nothing moves.

**Both creators.**

- **Mode switch (decision LAYOUT).** A Simple | Advanced switch sits in the
  creator toolbar, using the existing `Tabs` component.
  - In Simple, the left panel shows the effect: its template or name, where it
    plays and how many layers it has. The right panel shows the broad
    controls.
  - Advanced shows today's panels unchanged.
  - At narrow widths, the shell's existing panel tabs show the same content
    for the selected mode.
- **Opening.** A creator always opens in Simple (R15, R16). The mode is UI
  state; it is not undoable and not saved.
- **Reopening (decision REOPEN).** Simple values are written into the effect
  itself. A reopened effect shows its result with the controls back at 100 %
  and Original. Within a session, the control positions are part of the
  editor draft, so undo, redo and recovery restore them.
- **Reference and rebase (accepted 2026-10-13).** Simple
  numeric controls and the colour theme compute from a reference: the effect
  as it was when a Simple control was first used after opening or after the
  last Advanced edit. This is exact, so moving a control back to 100 % or
  Original restores the reference, and rounded burst counts do not drift. An
  Advanced edit makes the current effect the new reference and resets those
  controls to 100 % and Original. Edits in Simple that write values directly
  (Scene art and colours) apply to the effect and its reference together.

### Templates (owner decisions, 2026-10-12)

- **Particle FX:** the 16 Included Particle Effects, grouped by mechanic
  (decision P-GROUP):

  | Group | Templates |
  | --- | --- |
  | Bursts | Heart Burst, Star Burst |
  | Streams and auras | Heart Stream (`hearts-v1`), Fume Puffs, Halo Rays, Rage Aura, Stink Miasma |
  | Orbits and drifts | Question Orbit, Gloom Wisps, Sparkle Hearts, Twinkle Shimmer |
  | Fireworks | Fireworks Show, Heart Fireworks, Golden Willow |
  | Weather | Rain Cloud, Confetti |

  The group assignment is an agent proposal within the owner's "by mechanic"
  choice.
- **Scene FX:** all 24 Included emotion backgrounds, grouped under their eight
  families (Affection, Esteem, Delight, Drive, Alarm, Rejection, Revulsion,
  Gloom; embarrassment in Affection). The Dark and Light Streak focus presets
  form a Focus lines group (decision S-TEMPLATES). They replace the eight
  art-less family templates in the picker and in the creator's Starting
  template list.
- **Thumbnails** are 320 px square WebP renders on the Included Avatar Annie,
  as for Avatar FX. Particle Effects are rendered in the 3D scene. Scene
  Effects are rendered with their layers behind and in front of the Avatar.
  Both use a fixed random seed, at a per-template time and framing.
- **Starting from a template** opens `/particle-effects/new?template=<stem>` or
  `/scene-effects/new?template=<stem>`. The creator copies the Included
  effect's settings and every texture or image into a new, unsaved Local draft
  with an unused name (for example "Heart Burst 1"). It reuses the shared
  continue-or-discard flow and the recovery key `new:template:<id>`. Save
  creates a separate Local item; Included content is never changed.

### Implementation orientation

Survey of `95a2db39`. Paths: frontend relative to `src/frontend/web/src/`,
scripts to `src/frontend/web/scripts/`, content to `content/included/`.
Line numbers drift as work proceeds.

| Area | Current state and significance |
| --- | --- |
| Creator shell | `ui/content-creator/CreatorWorkspaceShell.tsx` (left and right `CreatorFloatingPanel`s; at narrow widths the panels become Setup, Inspector and Preview tabs, :87–129). `CreatorToolbar.tsx` has a `domainActions` slot (:76, :307) but no mode slot. `CreatorFloatingPanel` has an unused `headerActions` slot. Shared `Tabs`, `Slider` (Radix, `ui/components/slider.tsx`, unused by both creators), `Select`, `Switch`. No creator has a Simple/Advanced mode; the closest patterns are `<details>` "Advanced" disclosures (Particle :1123, :4339; `AvatarEffectSetupFields.tsx:913`). |
| Particle creator | `ui/particle-vfx-creator/ParticleVFXCreatorPage.tsx` (~4,980 lines). Left: emitter list, Add/Duplicate/Remove, Settings (estimate, anchor, playback duration, auto-fit), Transform, Advanced settings (budget, durations, looping). Right: `EmitterAuthoringTabs` (:2396) with emitter name, emitter preset select and tabs Appearance, Position, Emission, Shape and Behavior. Bottom: Preview Timeline. Inputs are `CreatorNumberField` (commits every change) and native colour inputs. |
| Particle document | `lib/avatar/particle-vfx/editor/`: `ParticleVFXEditorDraft` (`types.ts:433`) with `catalog` (effect settings and budget), `quarksJson` (source of truth) and derived `emitters`, rebuilt after every mutation (`draft.ts:512`). Values are `ConstantValue`/`IntervalValue` ranges (`numbers.ts`); bursts via `emitters.ts:271–344` (only the first is editable; others are kept); shapes `shapes.ts`; colours `colors.ts` (`ConstantColor`, `ColorRange`, `Gradient`; the per-emitter colour "theme" is not stored and reads back as a range, `colors.ts:40–66`); behaviours `behaviors.ts`, `advancedBehaviors.ts`. Estimate `particleEstimate.ts:42–105`; readiness `contentReadiness.ts` (16 emitters, 512 particles, 16 textures). Included effects: 1–15 emitters (106 in all), every start size, speed and life Constant or Interval, every rate Constant; 82 `ConstantColor` and 24 `ColorRange` start colours; every Color Over Life a `Gradient`; most textures carry their own colour (glossy heart, flames, cloud). |
| Particle opening | Blank (`draft.ts:116`), Library item (page :402–490: catalog preview, manifest and texture files; only owned items become the clean baseline, so Included items open dirty and save as a copy), imported JSON (:755). No `?template=` (`routes/_app/particle-effects.new.tsx`), no `useCreatorTemplateStart`, `onRestore` is `hydrateDraft`, and dirty compares against `initialDraftRef` (:365). Only `catalog.label` names the effect. |
| Scene creator | `ui/scene-effect-creator/SceneEffectCreatorPage.tsx` (~2,240 lines). Left `SceneSetupPanel`: Background / Focus Lines tabs, Starting template select, layer cards front to back, Effect behavior. Right `SceneInspectorPanel`: the selected layer's inspector; layer inspectors in `sceneLayerControls.tsx` (`ColorField`, `SelectField`, `RangeFields`, `SeedField`, `ImageInput`, `SceneItemsEditor`, `StickerPicker`, `MotionFields`). Every edit restarts the preview. |
| Scene document | `lib/scene-vfx/editor/types.ts` (8 layer slots, scatters array), reducer and validation `document.ts`, limits `lib/scene-vfx/limits.ts` (mirrored by the backend `app/contracts/scene_effect_limits.py`). Motion is unit-specific: scatter, tile and marquee px/s with nine directions (the marquee has a 20 px/s floor), rays `turnSeconds` (seconds per turn, signed) and `throbPerSec`, lines `swaySeconds`, focus flicker in ms. Every scatter, even disabled, needs 1–8 items. |
| Scene opening | Library item: `hydrateSceneEffect` (:2142) downloads every image; Included items get the `__included_copy__` baseline. Templates: `defaults.ts` builds the 8 family templates from Included descriptors without their tile and scatters, so they carry no art; focus templates are the bundled `dark` and `light-streak`. Reopen rebuilds from `definition` and never reads the saved `authoring` document. |
| History and recovery | `ui/creator-history/useCreatorDocumentHistory.ts` (limit 50; `beginGroup`/`endGroup` exist but neither creator uses them; the pose creator groups slider drags on pointer down and up, `PoseCreatorBoneSection.tsx:771`). Particle snapshots are the whole draft with its texture table; Scene snapshots are the document plus image Files. Recovery: `lib/content/particleVFXRecovery.ts` (`/3`, catalog, Quarks JSON, texture Blobs; 5 MiB JSON plus the texture total) and `lib/scene-vfx/editor/recovery.ts` (`/1`, document and image Blobs, 34 MiB); neither stores UI state. Shared save and recovery: `ui/content-creator/useCreatorSave.ts`; template drafts `useCreatorTemplateStart.ts` (key `new:template:<id>`). |
| Template picker | `lib/effects/effectTemplates.ts`: plain data (no runtime imports, so `effect-thumbnails.mjs` imports it); 75 Avatar templates in six groups; 10 Scene template IDs; Particle has none. UI `ui/create/EffectTemplatePickerDialog.tsx` (`TemplateStep` :221; Scene previews are CSS swatches :454–493; Particle shows "There are no Particle FX templates yet"). Avatar thumbnails: `assets/effect-templates/<id>.webp` (75, 320 px), loaded by `lib/effects/effectTemplateThumbnails.ts`; Avatar template start `loadAvatarEffectTemplate` (`AvatarEffectCreatorPage.tsx:1495`). |
| Thumbnails and renders | `scripts/effect-thumbnails.mjs` resolves Avatar sources only and deletes every `.webp` that is not an Avatar template. Its `--thumbnail` path (`effect-render/render.ts` `renderThumbnail` :539) opens no review stage and passes no particles, uses `captureAvatarPortrait` (WebGL only, so no Scene DOM layers) and does not seed randomness. The sheet path already renders all three kinds: `openReviewStage` (seeded), `showReviewFrame(time, view)`, screenshot of `#review-stage` with Scene underlay and overlay composited. Defect: `effect-render.mjs:534` `rendered.avatars.flatMap(avatarFailures)` passes the array index as `expected`, so a thumbnail never reports "no active effect". |
| Included content | 16 Particle Effects (`vfx/particle/quark/<stem>/`; `hearts-v1`'s name is "hearts-v1" and its description "hearts"); 26 Scene Effects (24 `scene-vfx-emotion-<e>`, held, 1–4 PNGs each; focus `dark`, `light-streak`). Creators fetch Included files through `previewCatalogItem` and `contentPreview.ts`; the Vite public aliases are not in embedded or hosted builds. |
| Tooling that drives the creators | `scripts/effect-save.mjs` selects emitters (`Select emitter …`), texture inputs (`Choose file for …`) and the Scene tile layer, all Advanced controls (:483–523; stack test `effect-save.stack.test.mjs`). The skills' `creator.md` references describe today's layout. |
| Journeys | Template picker (`accountless-effect-template-picker.spec.ts`: Particle "no templates yet", 75 Avatar images, Scene Dark Focus), texture import, Scene layers, VFX layout and creator discard journeys use Advanced controls; helper `e2e/helpers/creator-surfaces.ts`. The selected specs are the regex in `playwright.config.ts` (`chromium` project). |
| Licences | Avatar thumbnails have per-file `licenses/source-review.json` records (Annie capture, `LicenseRef-pixiv-VRoidPreset`), the folder README, `art-NOTICES.md`, `desktop/runtime/license-sources.json` ("Avatar FX template thumbnails") and `desktop/runtime/notices/effect-template-thumbnails-attribution.txt`; all are worded for Avatar Effects. `scripts/public-release/prepare_source.py` requires a record per tracked file. |

## Progress

- [x] Plan drafted (2026-10-12) from `95a2db39` with the owner's design
      decisions.
- [x] Phase issues #488–#493 created as sub-issues of #297 with their
      dependencies (2026-10-12, read back).
- [x] Paused by the owner after the plan and issues (2026-10-12).
- [x] Owner review of the plan: P1–P4 authorized and every agent proposal
      accepted (2026-10-13).
- [x] Preparation (2026-10-13): `main` (`7a25aa34`) merged into the branch;
      decisions and Plan 3 links published to #297 and read back
      (2026-10-13T19:44:59Z); spec snapshot refreshed.
- [x] P1 — Template catalogue and rendered thumbnails (R17). #488 — review
      passed at round 2 (2026-10-13); gate G1 (thumbnail sheet) pending.
- [x] P2 — Starting from a template (R17). #489 — review passed at round 1
      (2026-10-13).
- [x] P3 — Simple mode and the Particle broad controls (R15). #490 —
      review budget spent at round 3 with one layout blocker; fixed and
      measured by the coordinator, awaiting the owner's go-ahead for P4.
- [ ] P4 — Particle colour theme (R15). #491
- [ ] P5 — Scene Simple mode (R16). #492
- [ ] P6 — Journeys, documentation and acceptance (R15–R17). #493
- [ ] Final integration review; PR.
- [ ] Gates G1 (thumbnails) and G2 (walkthrough); merge approval.

## Surprises & Discoveries

- 2026-10-12 (planning): Scene templates carry no art today. They take only
  the family background's code-drawn layers. R17 needs the Included item
  itself, loaded as the edit route already does.
- 2026-10-12 (planning): the thumbnail path cannot show Scene layers, because
  it captures WebGL only. It also does not seed particle randomness. The
  review-stage path used by `effects:render` already does both, so thumbnails
  move to it.
- 2026-10-12 (planning): `effects:thumbnails` deletes every `.webp` it does
  not own, so new kinds need their own folders. `effect-render.mjs:534`
  hides a missing-effect failure in thumbnails (the `flatMap` index defect).
- 2026-10-12 (planning): most Included textures carry their own colour. A
  tint-only theme would darken the glossy heart or the flames rather than
  change their hue. This is why the colour theme recolours art (P-COLOUR).
- 2026-10-12 (planning): `effects save` drives Advanced controls in both
  creators. Making Simple the default view breaks it unless it switches to
  Advanced, so P3 and P5 update it with their journeys.
- 2026-10-12 (planning): neither creator groups history steps, and every
  edit restarts the preview. Slider drags need grouped undo and a preview
  update that keeps up with dragging.
- 2026-10-12 (planning): reopening reads only the saved definition and
  runtime defaults, never the `authoring` record. This supports decision
  REOPEN without a format change.

## Decision Log

- 2026-10-13, owner (**S-TRIM**): trim P5. Scene Simple keeps Art, Colours
  and Speed; Direction and Density stay in Advanced only. This supersedes
  S-DIR. Rationale (agent recommendation): the Scene creator's Advanced
  controls are already plain-language; templates with art (P2) carry most of
  the benefit for new users; Direction's same-step rotation was the costliest
  control for the least gain. Published to #297 as an inline R16 note and
  read back (2026-10-13T18:01:41Z); spec snapshot refreshed.
- 2026-10-12, owner (Plan 3 kickoff): start Plan 3 on
  `feat/particle-scene-creators` off `main`. Write this plan, create the phase
  issues under #297, then stop for review. Keep the creator shell, layout and
  styling. Verify at desktop sizes first. Run the full `pnpm e2e:test` on a
  named built stack before handoff, then tear it down. Hosted CI is disabled.
  The PR closes #297 and the phase issues.
- 2026-10-12, owner (Plan 3 design choices, asked before planning):
  - **P-MAP:** proportional, layer-aware Particle controls (Amount keeps
    single-particle layers single; Size is particle size; Spread is the
    footprint; Speed is tempo; the budget auto-fits up to 512).
  - **P-COLOUR:** the colour theme recolours the art and the emitter colours
    together. Recoloured textures are saved as the effect's own. No runtime
    change.
  - **S-TEMPLATES:** all 24 Scene backgrounds, grouped by family, plus the two
    focus presets. They replace the eight art-less templates.
  - **LAYOUT:** both panels switch with a Simple | Advanced switch in the
    toolbar. Advanced is today's panels.
  - **S-COLOUR:** edit each distinct Scene colour.
  - **S-DIR:** rotate every moving layer together (superseded by S-TRIM on
    2026-10-13).
  - **REOPEN:** a reopened effect starts from the effect as saved, with the
    controls back at 100 % and Original.
  - **P-GROUP:** Particle templates are grouped by mechanic.
- 2026-10-13, owner: authorized P1–P4 and accepted every agent proposal
  below (reference and rebase, Heart Stream, swatches, ranges and groups,
  thumbnail folders and focus templates).
- 2026-10-12, agent proposals (accepted 2026-10-13):
  - **Reference and rebase** (see Simple control behaviour). The alternative,
    multiplying current values step by step, lets rounded burst counts drift
    and cannot restore Original art exactly.
  - **Heart Stream.** Rename `hearts-v1`'s display name to "Heart Stream" with
    a one-sentence description, so its template and new drafts are not called
    "hearts-v1 1". Its content ID, files and behaviour are unchanged. If this
    is declined, the template shows "hearts-v1".
  - **Swatches and ranges.** Theme swatches: Original, Rose, Gold, Mint, Sky,
    Violet, White. Slider ranges: Amount 25–400 %; Size, Spread and Speed
    25–300 %, all within the limits.
  - **Focus templates** load the Included `dark` and `light-streak` items like
    the backgrounds. The bundled copies stay for their other users.
  - **Thumbnail files:** `assets/effect-templates/particle/<stem>.webp` and
    `assets/effect-templates/scene/<stem>.webp`. The 75 Avatar files stay where
    they are, so their records do not churn.
  - **Particle template groups** as tabled above.

## Gates

| Gate | When | Who | Effect |
| --- | --- | --- | --- |
| G1 | End of P1 | Owner reviews the contact sheet of the 42 new thumbnails | Per-template time and framing are revised before merge; later phases do not wait |
| G2 | End of P6 | Owner reviews the R15–R17 walkthrough (screenshots at 1440 × 900 and about 900 px) and tries the creators on the task stack | Spec acceptance for R15–R17; merge approval stays separate |

The spec requires G2 ("the owner reviews the walkthrough"). Neither gate is a
phase or an issue. If the owner asks for changes at a gate, they are taken as
a revision phase, as Plan 2's P8 was.

## Preparation (workspace setup)

1. Recheck the root and frontend `AGENTS.md`, the branch, HEAD and the dirty
   state. LFS assets are hydrated in this worktree (274 files).
2. `workspace-setup`, once the owner authorizes phases:
   - publish the 2026-10-12 decisions to #297 (a dated decisions entry and
     the Plan 3 delivery links), read it back, and refresh the spec snapshot;
   - reconcile phase issues #488–#493 (sub-issues of #297,
     each blocked by its predecessor; P4 and P5 by P3; P6 by P4 and P5).
3. Dependencies: from `src/frontend`, `pnpm install --frozen-lockfile` (done
   during planning), `pnpm packages:build`, `pnpm e2e:install`. Backend:
   `uv sync --python 3.12.13` before any SDK regeneration (none is expected).
4. Task stack for interactive checks:
   - start it from the worktree root:
     `COMPOSE_ENV_FILES="$HOME/.config/animama/dev-secrets.env,$PWD/.env" ./reset.sh --name p3creators --base-port 8300`;
   - first-run setup:
     `pnpm e2e:test -- --project installation-setup` with
     `ANIMAMA_E2E_ALLOW_MUTATIONS=1` and the stack record sourced;
   - a fresh development stack can stall in Vite's dependency optimizer;
     restarting its `web` service clears it.
   The worktree `.env` holds nonsecret settings only. Stop the stack after
   its last use in a working session.
5. Work test-first (`tdd`) for the pure scaling, recolouring, template and
   tooling code. Wrap every delegated test command in `timeout`.

## Phased implementation

Each phase starts after its predecessor's checks and bounded review pass. Each
phase gets one full `sdlc-reviewer` review and at most two repair rounds.
Record per phase:

- issue and starting SHA;
- commits, as `<type>(<scope>)[p#]: …`, with scopes such as `effects`,
  `particle`, `scene`, `creators`, `e2e`, `docs`;
- commands and results;
- review records;
- remaining gates.

Each phase keeps the suites green. A phase that changes a default view also
updates the journeys, helpers and `effects save` steps it breaks.

### P1 — Template catalogue and rendered thumbnails (R17). Gate G1. #488

Outcome: the picker lists the Particle and Scene templates in their groups,
each with a rendered thumbnail, from one tested catalogue. P2 makes choosing
one open a draft with art.

1. **Catalogue** (`lib/effects/effectTemplates.ts`, still plain data):
   - `PARTICLE_EFFECT_TEMPLATES` (16; `id` is the Included stem, plus
     `contentId`, `name`, `group`, `thumbnail` options) with the mechanic
     groups;
   - `SCENE_EFFECT_TEMPLATES` (24 backgrounds by family, two focus presets)
     replacing `SCENE_EFFECT_TEMPLATE_IDS`;
   - search parsers for both kinds;
   - tests that pin each list to the Included descriptors by content ID, name
     and kind, as the Avatar list is pinned.
2. **Thumbnail tooling** (`scripts/effect-thumbnails.mjs`,
   `effect-render.mjs`, `effect-render/render.ts`):
   - render Particle and Scene templates through the review stage at a
     per-template time and view on Annie, with the fixed seed;
   - capture a larger square and downscale it to 320 px WebP;
   - write per-kind folders and make stale-file removal and
     `effectTemplateThumbnails.ts` kind-aware;
   - fix the `flatMap(avatarFailures)` defect test-first;
   - extend `effect-thumbnails.browser.test.mjs` to one Particle and one Scene
     template, checking that the effect is visible and the output is
     deterministic.
3. **Generate** the 42 thumbnails (16 Particle, 26 Scene) and inspect each.
   Use per-template `thumbnail` options where a default frame misses the
   effect: an early time for bursts, after any entry flash, a wide view
   for full-body auras.
4. **Picker** (`EffectTemplatePickerDialog.tsx`): Particle and Scene steps
   show "Start from scratch" plus grouped `TemplateCard`s with the rendered
   thumbnails. Use the existing card, loading, error and empty states; the CSS
   swatch preview goes. Links target `?template=<id>`.
5. **Licences:**
   - an owner-form `licenses/source-review.json` record per new file, whose
     basis names the Annie capture and the Included effect, with `hearts-v1`'s
     generated texture set named in its own record;
   - the thumbnail folder README, `art-NOTICES.md`, the desktop
     `license-sources.json` entry and the attribution notice widened from
     Avatar FX to effect template thumbnails.
6. **Heart Stream** (approved 2026-10-13): the `hearts-v1` descriptor's name and
   description, with the Included catalog and integrity tests.

Checks:

- `effectTemplates.test.ts`, `EffectTemplatePickerDialog.test.tsx`, the
  thumbnail browser test and the script tests (`node --test` on the changed
  `scripts/*.test.mjs`);
- `pnpm check`, `pnpm web:lint`, `pnpm prettier:check`;
- `uv run pytest -q tests/test_included_content_integrity.py
  tests/test_included_content_catalog.py
  scripts/public-release/test_prepare_source.py`.

Completion:

- the picker shows 16 Particle and 26 Scene rendered thumbnails in their
  groups at 1440 × 900 and about 900 px;
- a contact sheet of the 42 thumbnails is ready for G1.

#### P1 record

Starting source and issue: `4a63a419` (after merging `main` `7a25aa34`),
#488. Task stack: `p3creators`, development, `http://animama-p3creators.localhost:8700`
(port 8300 was taken by another task's stack).

- **Catalogue:** `PARTICLE_EFFECT_TEMPLATES` (16, five mechanic groups) and
  `SCENE_EFFECT_TEMPLATES` (24 backgrounds in eight families, plus a Focus
  lines group with `dark` and `light-streak`) in `effectTemplates.ts`, with
  `effectTemplates(kind)`, `effectTemplateGroups(kind)` and search parsers for
  both kinds; `SCENE_EFFECT_TEMPLATE_IDS` is gone. Tests pin both lists to the
  Included descriptors (content ID, name, type, focus kind) and each kind's
  thumbnail folder to its templates.
- **Thumbnails:** `pnpm -s effects:thumbnails [--kind avatar|particle|scene]
  [template-id...]`; Particle and Scene thumbnails are captured on the review
  stage at 768 px on Annie (front view, chat Portrait framing; `framing:
  "head"` aims higher and closer) and downscaled to 320 px WebP. For
  byte-stable output the stage group reloads the page before each job (state
  from earlier stages: the VRMA cache and three.quarks' noise seeds), runs in a
  CPU-raster Chromium launch, freezes paused animations and decodes Scene
  images before showing. The Avatar job launch is unchanged, and its 75 files
  are byte-identical. Stale-file removal is per kind folder. The
  `flatMap(avatarFailures)` defect is fixed test-first. Per-template options
  are in the catalogue: for example Star Burst `head, 0.4`, Heart Stream
  `head, 3.5`, Emotion Disappointment `0.5`.
- **Picker:** every kind shows Start from scratch plus grouped cards with the
  rendered thumbnails (`TemplateThumbnail({ kind, templateId })`); the CSS
  swatch preview is gone. The Particle route parses `?template=` (the page
  opens blank until P2). An interim, commented shim in
  `SceneEffectCreatorPage.tsx` maps a background stem to its family's code
  template until P2 loads the Included item.
- **Licences:** 42 owner-form source-review records (Annie capture of the named
  Included effect; Heart Stream's names its generated texture set); the
  thumbnail README, `art-NOTICES.md`, the desktop `license-sources.json` entry
  and attribution notice cover all effect template thumbnails.
- **Heart Stream:** `hearts-v1`'s name, description and slot label and
  description; ID, runtime ID, version, files and behaviour unchanged.
- **Docs:** `avatar-vfx.md`, `avatar-particle-vfx.md`, `scene-vfx.md`, the
  Particle skill's `creator.md`, and both skills' `promote.md` (review F1).

Checks (implementer, then reviewer and coordinator after the revisions):

- `pnpm web:test` (from `src/frontend`): exit 0, 486 files, 4351 passed and
  1 skipped, with the script and browser suites passing, including
  `effect-thumbnails.browser.test.mjs` 7/7 (Heart Burst and Emotion Love
  rendered twice, visible and byte-identical).
- `pnpm check`, `pnpm web:lint`, `pnpm prettier:check` and `pnpm e2e:check`:
  exit 0.
- `uv run pytest -q tests/test_included_content_integrity.py
  tests/test_included_content_catalog.py scripts/public-release/test_prepare_source.py
  tests/test_starter_content_closure.py`: 48 passed.
- The reviewer reran the sheet and check browser tests (52/52) and confirmed
  Avatar thumbnails are reproduced byte for byte.
- After the revisions: `pnpm check`, `pnpm web:lint` and `pnpm prettier:check`
  exit 0; vitest `src/lib/effects src/ui/create src/lib/scene-vfx` 26 files,
  258 passed.
- Browser, task stack: the picker at 1440 × 900 (Particle FX groups with
  thumbnails) and at 900 px (Scene FX families);
  `pnpm e2e:test -- accountless-effect-template-picker` 3 passed.
- G1 material: `.animama-drafts/plan3/p1-thumbnails-contact-sheet.png`
  (ignored). The thumbnails the implementer judged weakest are Heart Stream
  (sparse by nature), Fireworks Show (first shell mostly faded), and Emotion
  Optimism and Disappointment (pale by design).

#### Code Review #1 Findings

Round 1 (`sdlc-reviewer`, working tree on `4a63a419`), blocked:

- **P1-R1-F1 (Required):** the Particle and Scene skills' `promote.md` did
  not say that a promoted effect needs a picker template, a thumbnail and its
  source-review record, which the new tests require; deletes would leave all
  three behind.
- **P1-R1-F2 (Required, evidence):** no browser view of the picker at either
  width; the edited journey had not run.
- **P1-R1-F3 (Optional):** `sceneEffectTemplateLabel` became dead code.
- Nits: the first stage thumbnail loads the page twice; a JSDoc line is over
  120 characters; the interim shim has no unit test (acceptable, P2 removes
  it).

The reviewer verified the catalogue pins, per-kind stale removal, the CLI's
argument handling, the containment of the determinism measures to thumbnails,
the defect fix, picker reuse and accessibility, and the licence records (42
added, none changed).

#### Code Review #1 Revisions

- **F1 accepted:** a step 2 in both `promote.md` "Afterwards" sections
  mirrors the Avatar skill: the template list and group, `effects:thumbnails
  --kind`, the record, thumbnail options, and regenerating on replace or
  removing on delete.
- **F2 accepted:** browser views at both widths and the journey run (see the
  record). At 900 px "Emotion Embarrassment" was clipped mid-word; the card
  label now uses `break-words` and truncates with an ellipsis.
- **F3 accepted:** removed.
- **Nits:** the JSDoc line is reflowed. The double load is kept: it costs one
  page load per run.

#### Code Review #2 Findings

Round 2 (repair round 1, targeted recheck): **pass**. F1–F3 resolved and no
regressions; the reviewer measured the picker labels with Playwright at 1440,
900 and 640 px. Non-blocking: **P1-R2-F1** "Emotion Embarrassment" and
"Emotion Disappointment" are clamped below desktop width and sighted users
never see the whole name; **P1-R2-F2** the JSDoc line was still long;
**P1-R2-F3** the new `promote.md` lines ran past the surrounding wrap;
**P1-R2-F4** a promoted Scene with a new stem (for example a new focus
preset) would show a card that the interim shim cannot open, which P2's
loader resolves.

#### Code Review #2 Revisions

- **F1 accepted:** the card label carries `title={label}`.
- **F2, F3 accepted:** reflowed.
- **F4 deferred to P2:** P2 loads any catalogue template from its Included
  item and removes the shim.
- Rechecked: `pnpm prettier:check` and ESLint on the changed files pass; vitest
  `src/ui/create` 130 passed. Repair rounds used: 1 of 2.

### P2 — Starting from a template (R17). #489

Outcome: choosing any Particle or Scene template opens its creator with that
effect's settings and art, as a new unsaved Local draft that saves as a new
Local effect.

1. **Particle:**
   - `routes/_app/particle-effects.new.tsx` parses `?template=` and keys the
     page by template.
   - The page adopts `useCreatorTemplateStart`: recovery key
     `new:template:<id>`, the continue-or-discard dialog, and a
     fingerprint-based baseline instead of `initialDraftRef` for template
     drafts.
   - `loadParticleEffectTemplate` finds the Included catalog item by content
     ID, then opens it through the existing preview and texture loading. It
     names the draft `createUniqueContentName` and keeps every texture as the
     draft's own file.
   - The draft records its template ID for Simple's label (UI state, not
     saved).
2. **Scene:**
   - `loadSceneEffectTemplate` loads the Included item with its images
     through `hydrateSceneEffect`, instead of building from `defaults.ts`.
   - The Starting template select lists the same catalogue. Applying a
     template to the current draft loads its art, as one undoable step that
     carries the image Files.
   - Remove the art-less family template builder and its tests. Keep the
     bundled focus presets for their other users.
3. **Save and recovery:**
   - a template draft saves as a new Local item and reopens with its art;
   - reload before Save restores the draft, with its textures or images,
     through the continue-or-discard dialog;
   - Included items are unchanged.
4. Tests: route parsing; template loading with mocked catalog previews
   (settings, every texture or image, unique name, recovery key); Scene
   Starting-template application and undo; `useCreatorTemplateStart` for
   Particle.

Checks:

- focused vitest, then `pnpm web:test`;
- `pnpm check`, `pnpm web:lint`;
- the template picker journey, updated for the new templates.

On the task stack, start Heart Burst, Sparkle Hearts, Emotion Love and Dark
from the picker. Save each and reopen it, then reload one before Save.

Completion: every template opens with its art. A saved copy reopens equal to
its Included source except for its name. The journey passes.

#### P2 record

Starting source and issue: `4e9ab2d8`, #489.

- **Shared lookup:** `lib/content/includedTemplateItem.ts`
  (`findIncludedTemplateItem`: the Included item by content ID, with an unused
  draft name). The Avatar, Particle and Scene loaders all use it.
- **Particle:**
  - The edit route's loader moved to `particleVFXCatalogDraft.ts`
    (`loadParticleVFXCatalogDraft`), which the edit route and
    `loadParticleEffectTemplate` share.
  - The page adopts `useCreatorTemplateStart`: recovery key
    `new:template:<id>`, the continue-or-discard dialog, and "Loading
    template…" with an inline error.
  - `initialFingerprintRef` replaces `initialDraftRef`, with the template
    baseline for template drafts.
  - On template routes, a recovered draft is held for the dialog, and New
    goes to plain `/particle-effects/new`.
  - The template ID stays in page state for P3's label.
- **Scene:**
  - `hydrateSceneEffect` moved to `sceneEffectCatalogDocument.ts` with
    `loadSceneEffectTemplate`, which loads the Included item and its images,
    focus presets included.
  - The Starting template select lists the catalogue in groups for the
    current kind. Choosing one starts the draft over from that item as one
    undoable step that carries the image Files (`sceneEffectTemplateEdit`):
    it takes the kind, timing, behaviour, layers and images, and keeps the
    name, description and sound.
  - Loading holds the image-busy state; a failure leaves the draft unchanged.
- **Removed:** the P1 interim shim, `SCENE_EFFECT_TEMPLATE_OPTIONS`,
  `sceneEffectTemplate`, `templateBackground`, the eight descriptor imports and
  the template-ID types. The bundled focus presets stay for their other users.
- **Tests:**
  - every Particle template loads all its textures, and every Scene template
    all its images, and validates;
  - unique names and the recovery key;
  - the Particle page's template flow;
  - Scene template application and undo of its images.
  The template journey now covers Heart Burst's emitters and textures, Emotion
  Love's layers and art, a Starting template with Undo, and a Heart Burst
  draft that recovers, saves and reopens with its art.

Checks:

- implementer: focused vitest 767 passed; `pnpm web:test` exit 0 (4362
  passed, 1 skipped; node suites pass); `pnpm check`, `pnpm web:lint`,
  `pnpm prettier:check`, `pnpm e2e:check` exit 0;
- journeys on the task stack:
  - `accountless-effect-template-picker` 4 passed;
  - `accountless-particle-texture-import` 2 passed;
  - `accountless-scene-layers` 2 passed;
  - `accountless-creator-discard` 8 passed, 3 failed: the Gesture cases,
    whose Save stays disabled. They fail the same way at `4e9ab2d8` without
    P2, so they are recorded for the P6 full run on a built stack.
- reviewer: vitest 98 files, 637 passed, plus a recovery round-trip of all
  42 template drafts (same fingerprint);
- coordinator, after the revisions: `pnpm check` and `pnpm web:lint` exit 0,
  `pnpm prettier:check` pass, vitest `src/ui/scene-effect-creator
  src/lib/scene-vfx` 128 passed, `accountless-effect-template-picker` 4
  passed.
- Browser at 1440 × 900:
  - Emotion Love from the picker opened with its art; it saved as "Emotion
    Love 1" and reopened with its petals, sparkles and tile.
  - Sparkle Hearts opened with its 15 emitters and textures, and Dark as a
    focus draft.
  - Choosing a Starting template by keyboard kept focus on the select through
    the load.

#### Code Review #1 Findings

Round 1 (`sdlc-reviewer`, working tree on `4e9ab2d8`): **pass**, no Required
findings. The reviewer traced every Particle entry path (blank, owned and
Included Library items, import, template, recovery, Save, New) against HEAD.
Optional findings:

- **P2-R1-F1:** the Starting template select was disabled while loading, so a
  keyboard choice could drop focus to the page; the status paragraph appeared
  with its text, so some screen readers would not announce it.
- **P2-R1-F2:** `scene-vfx.md` said a Starting template keeps the draft's
  timing.
- **P2-R1-F3:** the draft keeps its description, so a route-started draft
  that then takes another template keeps the first template's description.
- **P2-R1-F4:** the select's template is page state, so after Undo it still
  names the undone template (pre-existing).

#### Code Review #1 Revisions

- **F1 accepted:** the select stays enabled (`aria-busy` while loading;
  choosing again aborts the earlier load), and the messages sit in a
  persistent `aria-live` region. Verified by keyboard in the browser.
- **F2 accepted:** the doc says the template's kind, timing, behaviour,
  layers and images are taken.
- **F3 kept (agent decision):** name, description and sound are the user's
  fields and are never overwritten by a template.
- **F4 deferred to P5:** the Scene Simple label must follow the document, so
  P5 derives it there rather than from page state.

### P3 — Simple mode and the Particle broad controls (R15). #490

Outcome: the Particle creator opens in Simple with Amount, Size, Speed and
Spread working on any effect as P-MAP defines. Advanced is today's view.
Undo, redo, recovery and Save cover both modes.

1. **Shared mode switch:**
   - a `CreatorToolbar` slot for a labelled Simple | Advanced `Tabs` control;
   - mode as page state, defaulting to Simple on every open, restore and
     template start;
   - each mode's panel content passed to `CreatorWorkspaceShell`, so the
     narrow-width tabs follow the mode.
   - No new styling: existing panel, field and typography components only.
2. **Simple controls** (pure, test-first, in
   `lib/avatar/particle-vfx/editor/simpleControls.ts`):
   - the reference snapshot and per-control factors stored in the draft, so
     history snapshots and recovery include them (recovery `/4`, which still
     reads `/3`);
   - `applyParticleSimpleControls(reference, factors)` implementing P-MAP for
     every field it names, including all bursts, world-space emitters and
     auto-fit shapes (auto-fit shapes keep fitting the Avatar; Spread scales
     their offsets and speeds);
   - budget auto-fit and limit-aware slider bounds;
   - rebase on any Advanced edit;
   - factors excluded from the Save package.
   - Tests use the 16 Included effects: Amount 200 % keeps every
     single-particle layer single; Speed keeps the ratios of every timing
     field; Spread leaves sizes alone; 100 % restores the reference exactly;
     the estimate stays within the declared budget and 512.
3. **Simple panels:**
   - left: the template name (P2) or the effect name, where it plays, and its
     layer count;
   - right: four `Slider`s with visible percentage values and labels;
   - each drag is one history group (`beginGroup` on pointer down, `endGroup`
     on commit); keyboard steps are single steps;
   - preview updates are throttled to animation frames while dragging.
4. **Values across modes:** Advanced shows the scaled values. An Advanced
   edit rebases Simple, so Simple returns to 100 %.
5. **Tooling and journeys:**
   - `effect-save.mjs` switches the Particle creator to Advanced before its
     emitter and texture steps, with its tests;
   - the texture-import, VFX-layout and creator-discard journeys and
     `creator-surfaces.ts` gain the same step where they use Advanced
     controls.
6. Accessibility: the switch and the sliders are reachable by keyboard and
   labelled (`Amount`, with the value as text); the focus order follows the
   panel order.

Checks:

- focused vitest for the scaling, draft, history and recovery code, then
  `pnpm web:test`;
- `pnpm check`, `pnpm web:lint`, `pnpm prettier:check`;
- the `effect-save.stack.test.mjs` run against the task stack;
- the affected journeys on the task stack.

Browser checks at 1440 × 900 and about 900 px, in light and dark themes:
Heart Burst and Fireworks Show adjusted in Simple, inspected in Advanced,
undone and redone, saved, reopened and recovered.

Completion: the R15 items except the colour theme are demonstrated and
tested, and `effects save` still saves and reopens a Particle folder.

#### P3 record

Starting source and issue: `d9450f96`, #490.

- **Pure layer:** `editor/simpleControls.ts` (with tests over the 16 Included
  effects and synthetic cases). `draft.simple = { reference: { catalog,
  quarksJson }, factors } | null`; factors are integer percentages on a 5 %
  grid, and null means 100 %. The scaled effect is always recomputed from the
  reference, so 100 % restores it byte for byte. The root object is scaled
  when it is itself an emitter (imported single-emitter JSON). The
  field-by-field treatment is in the module's JSDoc. For example:
  - Amount: `emissionOverTime` × a·k; burst counts × a, rounded and at least 1;
    single-particle layers (rates 0, burst counts summing to ≤ 1) are
    untouched;
  - Size and Spread: `startSpeed` × k·p; Size scales `startSize`;
  - Speed: forces × k²·p; lifetimes, cycles and burst timing ÷ k;
  - stretched billboards: `speedFactor` ÷ k·p;
  - budget: `maxParticles` = min(512, max(reference, estimate)).
- **Bounds:** Amount and Speed are scanned on the 5 % grid against the
  512-particle and 30 s limits, with a note naming the limit. Size and Spread
  never change a limited field, so they get the full range. Bounds are frozen
  during a drag. Amount is disabled when every layer is a single particle.
- **History, recovery, Save:** history snapshots carry `simple`. History
  equality also compares the factors; the Save and dirty fingerprint does
  not. Any non-Simple edit that changes the effect rebases, at the page's
  `updateDraft`/`commit` boundary. Recovery is `/4` (reads `/3` and `/2` at
  100 %). Save emits only the scaled effect, and the saved draft starts at
  100 %.
- **UI:** `CreatorModeSwitch` (`Tabs`) in a new `CreatorToolbar`
  `modeControl` slot; compact below 2xl so a saved effect's name still fits
  beside "Use in…" at 1440 px. `ParticleSimplePanels` (Effect: template or
  name, Plays at, Layers; Adjust: four labelled `Slider`s with percentage
  values and `aria-describedby` notes). One undo step per pointer drag, with
  rAF-throttled updates. The narrow-width tabs follow the mode
  (Effect/Adjust, Emitters/Inspector). Shared `HUMANOID_ANCHOR_LABELS`.
- **Agent decisions:**
  - renaming keeps the Simple positions;
  - New, Import and every load open in Simple;
  - Save returns the controls to 100 % of the saved effect, including
    within the session, because Save normalizes the effect.
- **Tooling and journeys:** `effects save` switches to Advanced and waits for
  the Emitters panel. The texture-import and template journeys switch modes.
  The template journey covers the Simple flow: Amount 200 % doubles only
  multi-particle layers, one Undo, Redo, recovery at 200 %, then Save and
  reopen at 100 % with the saved values.
- **Docs:** the creator section of `avatar-particle-vfx.md` and the skill's
  `creator.md`.

Checks:

- implementer, final source: focused vitest 710 passed; `pnpm web:test`
  exit 0 earlier in the phase (4491 passed, 1 skipped; browser suites 119);
  `pnpm check`, `pnpm web:lint`, `pnpm prettier:check`, `pnpm e2e:check`
  exit 0;
- `ANIMAMA_EFFECT_SAVE_STACK=1 node --test scripts/effect-save.stack.test.mjs`:
  1 passed;
- journeys on the task stack:
  - `accountless-effect-template-picker` 4 passed;
  - `accountless-particle-texture-import` 2 passed;
  - `accountless-vfx-layout` 6 passed;
  - `accountless-creator-discard` 8 passed, with the 3 known Gesture failures;
  - `accountless-journeys` 5 passed, 1 failed: the chat test expects a mock
    reply and the development stack answers with a real model; this is
    unrelated.
- Browser: screenshots in `.animama-drafts/plan3/p3/` (ignored):
  - Heart Burst in Simple and Advanced at 1440 and 900 px, light and dark;
  - Fireworks Show checked at 1440 × 900: adjust in Simple, inspect in
    Advanced, undo and redo, rename, Save, reopen at 100 % with the saved
    values, and recovery after reload.
- Coordinator: a drag of Amount and Spread on Heart Burst, where one Undo
  reverted one drag, and the toolbar fit of a saved effect at 1440 px. Two
  Local test items, "Emotion Love 1" and "Fireworks Show 1", remain on the
  task stack.

#### Code Review #1 Findings

Round 1 (`sdlc-reviewer`, working tree on `d9450f96`), blocked. Field
treatments were checked against three.quarks 0.17.1, and the rebase boundary,
history, recovery `/4`, Save exclusion and mode switch were verified.

- **P3-R1-F1 (Required):** an emitter that is the Quarks root object was
  never scaled. Size and Amount did nothing, and Speed broke readiness.
- **P3-R1-F2 (Required):** slider bounds (up to 14 ms) were recomputed every
  animation frame during a drag.
- **P3-R1-F3 (Required, evidence):** the browser checks were not reported.
- Optional:
  - O1: Save resets Simple within the session;
  - O2: record the agent decisions;
  - O3: `effect-save.mjs` did not wait after switching mode;
  - O4: an unused `disabled` prop;
  - O5: the notes are not linked to the sliders;
  - O6: recovery holds a second copy of the effect while Simple is not at
    100 % (fine at Included sizes, 44 KB at most);
  - O7: renaming rebuilt the reference each keystroke;
  - O8: the skill text misstated the budget;
  - O9: a forward note for P4: recovery must keep the reference's original
    textures.

#### Code Review #1 Revisions

- **F1 accepted:** the root emitter is scaled, test-first.
- **F2 accepted:** bounds are memoized on the reference and the drag-start
  factors; Size and Spread are not scanned. Tests count the searches.
- **F3 accepted:** the evidence is listed in the record above.
- **O1, O2 accepted:** recorded as agent decisions; the docs say Save
  returns the controls to 100 %.
- **O3, O4, O5, O7, O8 accepted.**
- **O6 kept:** the second copy is small at Included sizes and well under the
  bound.
- **O9 taken into P4.**

#### Code Review #2 Findings

Round 2 (repair round 1, targeted): F1 and F2 resolved; F3's evidence is
valid, though one Fireworks screenshot predates the compact switch.

- **P3-R2-F1 (Required):** the reviewer measured a saved effect's name box
  (with the mode switch and "Use in…" in the toolbar, sidebar open) at 26 px
  at 1024 and 18 px at 1280, against 187 and 158 px without the switch; at
  1366 it showed one word.
- Non-blocking: the first drag after opening, an Advanced edit or Save runs
  one bounds search mid-drag (once per drag, unchanged values); renaming
  before any Simple use searches once per keystroke (cheap).

#### Code Review #2 Revisions

- **F1 accepted:** "Use in…" shows its label only at 2xl, like New and
  Library, and gains `aria-label`, because it had no accessible name whenever
  the label was hidden. When a toolbar has a mode switch, its type label is
  icon-only below 2xl, with the text still announced; the Avatar Effect
  creator is unchanged. Measured name widths on the saved "Fireworks Show 1":
  113 px at 1024, 147 at 1280 (fits), 233 at 1366 and 234 at 1440.
  Rechecks:
  - `pnpm check` and `pnpm web:lint` exit 0; `pnpm prettier:check` passes;
  - vitest over the four creator folders: 185 passed;
  - journeys: `accountless-effect-template-picker` 4,
    `accountless-particle-texture-import` 2 and `accountless-vfx-layout` 6
    passed.
- Non-blocking notes kept: each costs at most one search per drag or
  keystroke.

#### Code Review #3 Findings

Round 3 (repair round 2, the last allowed): **blocked**. P3-R2-F1 is fixed at
1024, 1280, 1366 and 1440, but:

- **P3-R3-F1 (Required):** at exactly 1536 (2xl) every label returns at once
  and the name box drops to 111 px ("Fireworks Sh…"). It is 175 px at 1600
  and fits from 1680.
- Non-blocking: 1024 still truncates at 113 px (acceptable as the narrowest
  desktop); `not-sr-only` overrode `truncate` at 2xl; the icon-only "Use in…"
  had no tooltip.

The reviewer verified accessible names at every width, that the header does
not overflow, and that the Avatar FX toolbar is unchanged.

#### Code Review #3 Revisions

- **F1 accepted:** with a mode switch, the type label is icon-only at every
  width (text kept for assistive technology). The coordinator measured with
  the reviewer's scripts: the saved "Fireworks Show 1" name box is 113 px at
  1024, 147 at 1280, 233 at 1366, 234 at 1440 and 1535, 198 at 1536 (fits),
  and 234 at 1600, 1680 and 1920. New Avatar FX stays at 266 px everywhere.
- **Tooltip accepted:** "Use in…" has `title`.
- Rechecks: `pnpm check` and `pnpm web:lint` exit 0; Prettier passes on the
  changed files; vitest `src/ui/content-creator src/ui/particle-vfx-creator`
  114 passed.
- **The review budget is spent.** This fix is verified by measurement, not by
  an independent review. Progress to P4 waits for the owner's go-ahead
  (SDLC bounded review).

### P4 — Particle colour theme (R15). #491

Outcome: choosing a theme swatch recolours the whole effect, art and colours
together, as one undoable step that survives recovery, Save, reopen and
Portable packages.

1. **Recolouring** (pure, test-first, `editor/colourTheme.ts`):
   - the dominant hue, read from texture pixels weighted by saturation and
     alpha, and from emitter colours;
   - hue rotation of `ConstantColor`, `ColorRange` and `Gradient` keys, with
     White as desaturation;
   - Original returns the reference colours.
2. **Texture recolouring:**
   - decode each saturated texture of the reference, hue-rotate its pixels
     (alpha kept) off the main thread where `OffscreenCanvas` allows, and
     encode a PNG;
   - check it against the particle texture budgets before adding it;
   - reference it under a deterministic name (`<texture>-<theme>.png`);
   - drop unreferenced recoloured copies.
   - Built-in textures that are recoloured become the effect's own files;
     near-grey textures stay as they are.
   - Show a busy state while recolouring. A failure leaves the draft
     unchanged and says why.
3. **History and recovery:** the theme change is one history step carrying
   its texture Blobs. Recovery keeps them within its existing bound, and a
   record over the bound fails as today.
4. **Simple panel:** a labelled radio group of swatches using the existing
   colour-swatch styling; the selected swatch is marked for assistive
   technology.
5. Tests:
   - pixel tests on small PNG fixtures (hue moved, alpha and lightness kept);
   - colour key rotation;
   - Original restored exactly;
   - Save, package and recovery carrying recoloured textures;
   - a rebase after an Advanced colour edit.

Checks:

- focused vitest, then `pnpm web:test`;
- `pnpm check`, `pnpm web:lint`;
- an `effects:render` sheet of Heart Burst, Rage Aura and Rain Cloud in Sky
  and Gold, read by the agent (saved and reopened Local copies rendered
  through `library:local/…`);
- on the task stack, theme, Save, reopen and Portable export and import of
  one effect.

Completion: the colour theme part of R15 is demonstrated and tested.

#### P4 record

Not started.

#### Code Review #1 Findings

#### Code Review #1 Revisions

### P5 — Scene Simple mode (R16). #492

Outcome: the Scene creator opens in Simple with Art, Colours and Speed
working as decided, for backgrounds and focus lines. Advanced is today's
view and keeps direction and density. Undo, redo, recovery and Save cover
both.

1. **Simple controls** (pure, test-first, `lib/scene-vfx/editor/simpleControls.ts`):
   - the reference and factors in the editor document's session state, which
     history and recovery carry (recovery `/2`, reading `/1`) and which Save
     excludes;
   - Speed by unit as defined above, clamped to `SCENE_EFFECT_LIMITS`;
   - the distinct-colour model and one-to-many colour writes;
   - rebase on Advanced edits.
   - Tests over the 24 Included backgrounds and both focus presets: limits
     hold at both slider ends; directions and counts are unchanged; 100 %
     restores the reference; a colour edit reaches every field that used
     the colour.
2. **Simple panels:**
   - left: the template name or effect name, its kind and its duration
     (held or timed);
   - right: **Art** (each sticker layer's stickers with Replace, Add and
     Remove through `SceneItemsEditor` and `StickerPicker`; the tile through
     `ImageInput`), **Colours** (one `ColorField` per distinct colour,
     labelled by use), **Speed** (a `Slider`);
   - drag grouping and preview throttling as in P3.
3. **Tooling and journeys:** `effect-save.mjs` switches the Scene creator to
   Advanced for its tile and layer steps. The Scene-layers, VFX-layout,
   creator-discard and template journeys gain the same step.
4. Accessibility as in P3.

Checks: as in P3, plus an `effects:render` sheet of two Simple-adjusted
backgrounds (saved Local copies) on the chat-shaped tile. Browser checks at
1440 × 900 and about 900 px in both themes: Emotion Love and Emotion Sadness
adjusted in Simple, inspected in Advanced, undone, saved, reopened and
recovered.

Completion: R16 is demonstrated and tested, and `effects save` still saves
and reopens a Scene folder.

#### P5 record

Not started.

#### Code Review #1 Findings

#### Code Review #1 Revisions

### P6 — Journeys, documentation and acceptance (R15–R17). Gate G2. #493

1. **Journey:** a new `accountless-simple-creators.spec.ts`, added to the
   `chromium` project's selection. For each kind it covers:
   - start from a template;
   - adjust in Simple, then check the values in Advanced;
   - refine in Advanced and check that Simple rebases;
   - undo and redo;
   - Save, reopen and the art carried;
   - reload recovery.
2. **Walkthrough** for G2: screenshots at 1440 × 900 and about 900 px of the
   picker, both creators in Simple and Advanced, a template start, an
   adjustment, a theme and recovery. Summarize them in the PR; raw images
   stay out of Git.
3. **Documentation** (reader-value standard):
   - `docs/frontend/runtime/avatar-particle-vfx.md` (creator, templates,
     Simple mode);
   - `docs/frontend/runtime/scene-vfx.md` (product creator, templates);
   - `docs/frontend/runtime/avatar-vfx.md` §8–9 (picker, thumbnails for every
     kind);
   - `docs/frontend/testing/browser-journeys.md` (the new spec);
   - the `animama-particle-vfx` and `animama-scene-vfx` `creator.md`
     references (Simple first, Advanced for authoring);
   - `GLOSSARY.md` only if Simple or Advanced become terms of art.
4. **Full checks:**
   - from the repository root: `uv run pytest -q`, `uv run ruff check`,
     `make check`;
   - from `src/frontend`: `pnpm check`, `pnpm web:lint`,
     `pnpm prettier:check`, `pnpm web:test`, `pnpm build`,
     `pnpm desktop:check`, the changed browser script tests;
   - an embedded-desktop build check that the thumbnails and templates are
     bundled.
5. **Full browser journeys:** on a purged named built stack:
   - start it with
     `ANIMAMA_LLM_SKIP=1 ANIMAMA_WEB_BUILD_MODE=production ./reset.sh --name p3e2e --base-port <free> --purge`;
   - run first-run setup and `pnpm e2e:test` (full);
   - then `docker compose -p animama-p3e2e down` and remove its stack record.

Completion: the R15–R17 acceptance evidence is complete and the full
journeys pass. G2 materials are ready.

#### P6 record

Not started.

#### Code Review #1 Findings

#### Code Review #1 Revisions

## Final integration review

One full `sdlc-reviewer` review of `origin/main...HEAD`, with at most two
repair rounds. It covers:

- combined acceptance;
- the boundaries between the shared shell, both creators and the tooling;
- no regression in the Avatar Effect creator, whose toolbar is shared;
- the licence records;
- still-valid phase evidence.

Then open the PR with the template, `Closes #297` and `Closes #<phase>` for
each phase issue (one per line), the validated revision line, the local
evidence, and the statement that no hosted checks ran (Validation is
disabled).

## Validation and acceptance

| Spec criterion | Evidence | Phase |
| --- | --- | --- |
| R15 | Simple and Advanced for Particle: scaling and theme unit tests over the Included effects; journey; walkthrough; `effects save` stack test | P3, P4, P6 |
| R16 | Simple and Advanced for Scene: control unit tests over the Included Scenes; journey; walkthrough | P5, P6 |
| R17 | 16 Particle and 26 Scene templates; rendered thumbnails (browser test, G1); template drafts with art saved as new Local items (unit tests, journey) | P1, P2, P6 |
| Accessibility | Keyboard and label checks on the switch, sliders, swatches and selects | P3–P5 |
| Owner review | G1 thumbnails; G2 walkthrough | P1, P6 |
| Checks | Full local suites and the full `pnpm e2e:test` on a purged built stack | P6 |

## Idempotence and recovery

- **Thumbnails** are regenerated with `pnpm -s effects:thumbnails`. Per-kind
  folders keep each kind's stale-file removal from touching the others.
- **Template drafts** are new Local drafts. Discarding one never changes the
  Included item.
- **Recovery formats:** `/4` (Particle) and `/2` (Scene) read their
  predecessors. A record from a newer build is ignored with the existing
  notice.
- **User content:** Simple adds no saved field. Effects saved with Simple
  adjustments are ordinary effects, and existing Local effects open in Simple
  at 100 %.
- **Database:** no schema change is expected. If one is needed, update the
  ORM and `alembic/versions/0001_baseline.sql` directly.
- **Stacks:** `p3creators` (development, port 8300) and `p3e2e` (built, for
  the full journeys) are task-owned. Stop each after its last use and keep its
  data unless a purge is needed.

## Outcomes & Retrospective

Not started.

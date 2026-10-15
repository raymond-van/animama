# Expand and restyle the Gesture and effect library

Source agreement: parent issue
[#575](https://github.com/raymond-van/animama/issues/575) (goals G1–G4, owner
decisions of 2026-10-15).
Authorized scope: the whole plan, Phases 1–5 (owner, 2026-10-15).
Branch: `feat/content-library-expansion` in its own worktree, created at
`dca4af86` (`origin/main`, 2026-10-15). One PR for the whole plan.

## Purpose and context

Owners chat with one Anima whose Avatar plays Gestures and Reactions, and
those play Avatar, Particle and Scene Effects. The Included library has 111
Gestures, 87 Avatar Effects and 30 Particle Effects. This plan adds 20 new
Gestures, restyles the off-brand Avatar Effects, adds new Avatar and Particle
Effects and pairs them with the new Gestures. It changes content only; no
runtime, creator or backend code.

House styles agreed for this plan:

- **Avatar Effects:** colored manga with light screentone and a hand-drawn
  pencil, crayon or marker texture, each a flipbook (drawn frame by frame
  when the shape changes, otherwise a line boil from one key image). No new
  lettering. Style anchors among the current effects: `craving_drool`,
  `steam_puffs`, `teary_sparkle_eyes`, `tehe_star`, `happy_flowers`,
  `stomach_butterflies` and the boiling letterings. Glossy, plastic or flat
  vector art is off-brand.
- **Particle Effects:** the glowing 3D look of `sparkle-hearts`; the
  hand-drawn style does not apply.
- **Gestures:** rich, multi-joint motion with weight through the hips and
  pelvis, staggered regions, readable holds and an unhurried settle;
  references `hysterical-laughter`, `stretch-break`, `double-take` and
  `soul-leaves-body`. Expressions are keyed on the beats.

Authoring is delegated to Codex CLI agents (at most four at a time, owner
2026-10-15) that follow the repository content skills; the orchestrating
agent reviews their render sheets and decides what is kept, revised or
dropped before the owner's live review.

## Progress

- [x] 2026-10-15 Owner agreed the Gesture list and the Avatar and Particle
  Effect lists; issue #575 opened.
- [x] Phase 1: 22 Gesture clips drafted, revised after the agent's sheet
  review and the owner's preview notes (G1, 2026-10-15).
- [x] Phase 2: Avatar Effects batches A and C drafted and revised.
- [x] Phase 3: 10 Particle Effects drafted and revised.
- [x] Phase 4: batches B and D drafted; effect events paired into 21
  Gestures; owner notes on the pairings applied (G1).
- [x] Phase 5: owner approved items, sounds and licence wording (G2,
  2026-10-15); Local saves and promotion done (`ccd969e5`).
- [ ] Phase 5: full browser journeys and PR.

## Decision Log

- 2026-10-15 owner: 20 Gestures; table flip, shoulder shimmy, achoo, ninja
  seals and mic drop replaced (a mic that falls when the hand opens cannot be
  done reliably) by excited two-arm wave, jazz-hands ta-da, sniff sniff, big
  arm heart and idol glowstick cheer. Rock Paper Scissors ships as three
  throws (`rps_rock`, `rps_paper`, `rps_scissors`).
- 2026-10-15 owner: Gesture durations about 15% longer than first briefs;
  earlier generated Gestures looked rushed.
- 2026-10-15 owner: replace angry, heart_eyes, money-eyes, little-devil-horns,
  mind_blown_burst, tiny-victory-crown, suspicious-side-eye and
  streaming_tears; replace Musical Cascade and Hearts v1; approve the agent's
  further replacement and new-effect lists in #575.
- 2026-10-15 owner: also redraw `twitching-cat-ears`, in Annie's chestnut
  hair colour and about 22% smaller.
- 2026-10-15 owner: include the VRM 0 particle placement fix (#579) in this
  PR (cherry-picked from the closed #580) instead of a separate PR.
- 2026-10-15 owner: approved the new-effect sounds (seven comedy-pack keys;
  the rest silent; Particle Effects silent because their sounds do not play)
  and the agent-authored licence wording.
- 2026-10-15 owner: replace three Particle Effect textures that were edited
  copies of CC0 Kenney art with procedurally generated textures, so every new
  file carries one agent-authored record.
- 2026-10-15 agent: the idol cheer's glowsticks became a hand-attached
  `glowstick` Avatar Effect (owner note: "look more like a glowstick"); the
  `glowstick-trails` Particle Effect was dropped because a hand-following
  emitter cannot leave world-space trails in the current runtime.
- 2026-10-15 agent: the 22 new Gestures are Library roots, not starter
  loadout entries, because the starter loadout is unchanged unless the owner
  asks; owners equip them from the Library.

## Gates

| Gate | When | Owner action | Effect |
| ---- | ---- | ------------ | ------ |
| G1 | After each batch's drafts | Review items in the live preview (`animation:preview` Review picker) and leave notes | Approved drafts are saved as Local content |
| G2 | Before promotion | Approve each item and the promote dry-run list (adds and replacements) | Only approved items enter `content/included/` |
| — | Before merge | Exact-candidate merge approval | Separate from G1/G2 |

## Phased implementation

Commands run from `src/frontend/web` unless noted. Drafts live in the
Git-ignored `.animama-drafts/`; render sheets stay outside the repository.

### Phase 1: Gesture drafts (G1 of #575)

Author the 22 clips from the confirmed briefs with `animama-animation` batch
mode: `animation validate` and `animation check` with zero FAIL, render sheets
on both Included Avatars, a consistency pass across the batch, then one
`animation:preview` session for the owner. Save approved clips with
`animation:save`.

### Phase 2: Avatar Effects, batches A and C

Art through `animama-effect-assets`, folders and checks through
`animama-avatar-vfx` (`effects check`, `effects:render`, preview, `effects
save`). Batch A replacements are revised from their Library items and saved
under the same names so a later `promote` with `mode: "replace"` keeps their
identity.

### Phase 3: Particle Effects

Two replacements and eight new effects through `animama-particle-vfx`, in the
`sparkle-hearts` style; textures through `animama-effect-assets`.

### Phase 4: Avatar Effects B and D; pairing

Batch B replacements and batch D new effects as in Phase 2. Add action-bound
effect events to the new Gestures (reusing Included effects through event
`override` where possible) and re-run checks and renders.

### Phase 5: review, promote and journeys

Owner live review of every remaining item, `promote --dry-run` lists for each
kind, promotion of approved items (effects before the Gestures that depend on
them), then the full browser journeys.

## Validation and acceptance

- Per item: `pnpm -s animation validate`, `pnpm -s animation check`,
  `pnpm -s effects check` — zero FAIL; accepted WARNs listed in the PR.
- Before merge: `pnpm -s effects check` over the promoted folders, `pnpm
  check`, and `pnpm e2e:test` from `src/frontend` on a disposable built stack.

## Idempotence and recovery

Drafts and saves are repeatable: `animation:save` and `effects save` revise an
existing Local item with the same Selector ID or name instead of duplicating
it. Promotion is reviewed with `--dry-run` first; a wrong promotion is undone
by reverting its commit.

## Outcomes & Retrospective

Delivered: 22 Gestures (133 Included), 13 new and 27 redrawn Avatar Effects
(100 Included), 7 new and 2 rebuilt Particle Effects (37 Included), the VRM 0
particle placement fix, Prev/Next review controls in `animation:preview`, and
`animation:save` items that carry a creator project with effect dependencies.

Validation before the PR (local, macOS): `effects check` over every promoted
effect (hand-attached ones `--with-clip`), `animation validate` and `check`
for all 22 Gestures (motion WARNs only, recorded in the PR), the backend
Included/starter/release pytest files, `pnpm check`, `pnpm web:lint`,
`pnpm build`, the source unit tests and focused content vitest files, and
`make format-check`. Browser journeys: see the PR.

Lessons:

- Delegating authoring to parallel agents worked best with one brief per
  item group, shared review-note files and a save lock: two saves on one stack
  must never overlap.
- Render sheets caught stiff motion, hidden art and occluding particles, but
  timing and feel needed the owner's live preview; the Prev/Next controls made
  that review fast.
- Particle sounds are declared but not played, and particle event fades are
  ignored at runtime; hand-following emitters cannot leave world-space trails.
  These limit what Particle Effects can express today.

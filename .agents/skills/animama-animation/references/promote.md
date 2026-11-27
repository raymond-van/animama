# Promote to Included

Promotion turns reviewed Local Gestures into Included content that ships with
the app. It changes distributed content and its licence record, so it is
never part of the normal workflow.

## Approval gate

Promote only when all of these hold:

- the owner has explicitly approved **each item** by name, including whether
  a replacement takes over the original's slug, content ID and Selector ID,
  and any change of its display name or loop/one-shot kind;
- the owner has approved **the licence entries**: the inventory rule's
  creator, provenance, `license_id` and `redistribution_review`, and the
  source-review record. Show the exact wording before writing anything. Everything
  merged is published, so that approval is the redistribution clearance:
  record it as `cleared-<date of approval>`; a `pending` rule fails
  `tests/test_included_content_integrity.py`;
- the work is on a task branch that goes through a PR.

Do not change the starter loadout (`starter-loadout.v1.json` and the backend
`EXPECTED_STARTER_GESTURE_IDS` together) unless the owner asks.

## Items

`items.json` reuses `animation:save`'s items and adds the promotion fields.
It is a working file: keep it in `.animama-drafts/` and record the approved
items and licence wording in the PR instead of committing it.

`clip` is the saved Local item the owner reviewed, as a Library source
(`library:local/<selector>`, resolved like `animation:preview` sources from
the sourced stack's `ANIMAMA_LOCAL_CONTENT_HOST_PATH`), or a clip file path
relative to the items file.

```json
[
  {
    "clip": "library:local/blow_kiss",
    "mode": "add",
    "name": "Blow a Kiss",
    "selectorId": "blow_kiss",
    "aiDescription": "Kisses the fingertips and sends the kiss forward ...",
    "licence": {
      "creator": "...",
      "provenance": "...",
      "license_id": "LicenseRef-Animama-agent-authored",
      "redistribution_review": "cleared-YYYY-MM-DD"
    },
    "sourceReview": {
      "candidate_license": "AGPL-3.0-only",
      "basis": "...",
      "copyright": "...",
      "review": "prepared-not-release-approved"
    }
  }
]
```

- `mode: "add"` creates `content/included/gestures/<slug>/` with content ID
  `builtin:gesture:<slug>`. The slug defaults to the clip file name without
  `.clip.json` (a Local item's folder name); set `slug` to override it.
- `mode: "replace"` gives an existing Included Gesture new bytes. It keeps the
  folder, content ID, Selector ID and dependencies. Use the original Selector
  ID and set `slug` to the Included folder: a Local copy's folder and
  Selector ID differ (such as `<original>-v2`). It also keeps the display
  name unless the item sets `"rename": true`, and the loop/one-shot kind
  unless it sets `"loopChange": true`; set each only for a change the owner
  approved for that item. Each is refused when the item makes no such
  change, so an approved change the clip or item lacks is caught.

Unknown item fields are refused, so a misspelt `rename` or `loopChange` fails
instead of being ignored. No two Included Gestures may share a display name
(case-insensitive) once every item in the run is applied; renames in one run
may swap names.

The clip is validated like `animation validate` and stored as the compact
file the creator saves, pretty-printed, with `id` set to the slug and `name`
to the item's name.

### Gestures that play effects

A clip whose events play Avatar Effects, Particle Effects, Scene Effects or
sounds needs `dependencies` on an add, in the form Included metas store
them:

```json
"dependencies": [
  {
    "ref": "builtin:avatar-effect:idea_bulb_fingertip",
    "alias": "idea_bulb_fingertip",
    "content_type": "avatar_effect",
    "config": {}
  }
]
```

Every event's `effectId`, `presetId` or `cueId` must name a declared `alias`
of the matching type, and every `ref` must already be Included content of
that `content_type`. Prefer an Included effect placed through the event's
`override` ([clip format](clip-format.md#avatar-effect-events)) to a new
variant effect: two events may play one dependency, such as the same ticks
on each hand. Promote a new effect only for new art or a new attachment
kind. A new effect is promoted first, with the
`animama-avatar-vfx` skill's `pnpm -s effects promote` (`mode: "add"`); then
promote the Gesture with the effect's `builtin:` ID as `ref`. The draft
project's `local:` refs are not accepted. A replace keeps the Included
Gesture's dependencies and refuses a clip whose events they do not cover; to
change them, replace the Gesture with `effects promote` (a `"kind":
"gesture"` item) instead.

### Display-name-only renames

When only the display name changes and the clip's motion does not, edit by
hand instead of promoting: set `name` in `<slug>.meta.json` and in the clip
file, keeping each file's form (legacy clips are one compact line), then run
`pnpm -s animation validate` on the clip. If the Gesture has a motion
manifest entry (`file` is the slug), set its `name` too in
`src/frontend/web/src/assets/vrm/animations/manifest.json` and refresh the
backend copy with
`uv run --no-sync python src/backend/packaging/shared_catalogs.py --write`
from the repository root. A replace would write the item's
licence fields as a rule for the folder, which misattributes owner-authored
files; a hand edit keeps the existing licence rule and source-review records,
which describe the motion. The folder, content ID and Selector ID stay, so
Loadouts keep working.

## Run

From `src/frontend/web`, with the stack record sourced:

```bash
source ../../../.animama-stack.env
pnpm -s animation promote <items.json> --dry-run
pnpm -s animation promote <items.json>
```

The dry run lists every file it would create or update, with notes under the
files whose name, kind or dependencies change, for example:

```text
Would update content/included/gestures/right-finger-point/right-finger-point.json
  a loop → a one-shot
Would update content/included/gestures/right-finger-point/right-finger-point.meta.json
  name "right-finger-point" → "Right Finger Point"
```

Show the owner this list. The write:

- writes the Included clip and `<slug>.meta.json`. The frontend's built-in
  catalog bundles `content/included/gestures` directly, so there is no other
  copy to update;
- adds a `gestures/<slug>/*.json` rule to
  `content/included/licenses/inventory.json` ahead of `gestures/**/*.json`,
  whose owner-authorship attestation does not cover agent-made clips;
- adds or updates `licenses/source-review.json` records for the clip and
  metadata files.

A second run of the same items as `replace` changes nothing, once any
`rename` or `loopChange` the first run applied is removed (they then describe
no change and are refused).

## After promoting

1. `git add` the new files: the backend Included-content tests and desktop
   staging read tracked files only.
2. Update the pinned counts deliberately: `catalog.content.test.ts` (Gesture
   and 2.0 counts), `includedGestures.test.ts` (2.0 Gesture count) and the
   lower bound in `tests/test_included_content_integrity.py`. Record new and
   replaced clips in `includedClipBaseline.test.ts` by its documented
   procedure, and drop a re-animated Gesture from `MOTION_CHECK_EXEMPT`, or a
   retuned one from `KNOWN_ANDREW_FAILURES` (the test fails while a listed clip
   already passes on Andrew). When
   a replace changes a clip's duration or loop, update its motion manifest
   entry (`duration`, `loop_count`). After a rename or kind
   change, update what names the Gesture or its kind: the motion manifest
   (`src/frontend/web/src/assets/vrm/animations/manifest.json`, then
   `uv run --no-sync python src/backend/packaging/shared_catalogs.py --write`
   from the repository root for the backend copy) and tests or journeys that
   find it by name.
   A new non-idle Gesture is a starter: with the owner's approval, add it to
   `src/backend/animama/resources/starter-loadout.v1.json` and
   `EXPECTED_STARTER_GESTURE_IDS` in `tests/anima_creation_service_support.py`
   (`tests/test_anima_starters.py` requires every non-idle Gesture there).
   Ship other new items (idle Gestures and effects no starter uses) in
   desktop core: add each content ID to `CORE_LIBRARY_ROOTS` in
   `src/backend/animama/runtime/starter_content.py` and its folder (plus the
   entry/file counts) to `CORE_LIBRARY_LOCATORS` in
   `tests/test_starter_content_closure.py`; that test fails while any valid
   Included item is left out of core. A new idle Gesture reaches new Animas
   only when, with the owner's approval, it is added to a pool in the `idle`
   section of `src/backend/animama/resources/starter-loadout.v1.json`; update the seed
   expectations in `tests/test_starter_idle_pool.py` and
   `tests/test_anima_starters.py` with it.
3. Run the backend Included-content tests (full `uv run pytest -q`
   preferred), `pnpm verify`, `pnpm web:test:browser`, and the desktop runtime
   stage and audit.
4. In the PR, record the owner's approvals and the licence wording. Installed
   apps rehash a replaced item at startup (same logical ID, new revision);
   Local copies stay independent, and the owner may delete them once the
   Included version is confirmed.

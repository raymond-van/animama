# Checks, review and hand-off

## Motion checks

`pnpm -s animation check <clip.json> [--json]` runs the motion checks on both
Included Avatars and exits 1 on any FAIL; `--json` prints the report as JSON.
What each finding category means, its typical fix and how declared contacts
are measured are in the motion checks guidance,
`src/backend/animama/resources/authoring/checks.md`.

## Live preview and review notes

`pnpm -s animation:preview <source> [--compare <source>]` opens the motion in
the system browser on both Included Avatars, through the app's own `Avatar`
playback with the chat canvas lighting: fades, live layers (toggle them off to
see the clip alone), layer mutes and expression precedence look as they do in
chat. A source is an `animaPoseClip/2.0` clip, a creator project file, or a
Library item
(`library:<folder | selector | name>`, prefixed `included/` or `local/` when
ambiguous; Local items come from `--local-content <dir>` or the sourced stack
record). A Library Gesture or Reaction, or a project file, plays its Avatar,
Particle and Scene Effects from its dependencies, with their fades; sounds are
not played, and the page's **Effect warnings** panel lists them. The preview also
takes an Avatar, Particle or Scene Effect source (an effect folder, its
descriptor, or `library:avatar-effect/`, `library:particle-effect/` or
`library:scene-effect/<name>`); see the `animama-avatar-vfx`,
`animama-particle-vfx` or `animama-scene-vfx` skill. Use it to
judge timing, which still frames miss:

- play at 0.25–1× speed, loop, scrub, or click a beat marker;
- switch camera presets (front, ¾, side, face, and portrait, the chat's
  Portrait framing);
- `--compare library:<original>` plays an existing Gesture in a second row,
  for example next to its replacement;
- switch sources in the page: the **Review** and **Compare** pickers list the
  example clips, the clips in each file source's folder, and the Included and
  Local Gestures, Reactions and Avatar Effects. To hand the owner several Gestures, start one
  preview and name the items to pick; there is no need for one run per item.

Edits to the source reload the page. Notes the owner adds in the page are
saved beside a file source as `<file name without .json>.review.json`
(`laugh.clip.json` → `laugh.clip.review.json`) or beside an effect's folder
(`sparkle/` → `sparkle.review.json`). They go in the working directory instead
for a Library item and for any file inside Library content: under the Included
or Local root, in a `vfx/avatar/<stem>/` folder, or in a `<stem>/` folder that
holds `<stem>.meta.json` (the content scanner would count a notes file there as
one of the item's files). `--notes <file>` overrides this for the command-line
source. After revising the source for a note:

1. `pnpm -s animation review <notes.review.json>` lists notes with their ids.
2. `pnpm -s animation resolve <notes.review.json> <id> <what you changed>`
   marks one resolved by the source's current version.
3. Ask the owner to look again; **Previous version** in the page plays the
   version the latest note was made against (or else the one before the
   current version) alongside the current one.

Review sidecars and retained versions are ignored by Git under
`src/frontend/web`; summarise the notes and resolutions in the hand-off instead.

## Review renders

`pnpm -s animation:render <clip.json> --out <dir> [--times 0,0.4,0.8] [--rows 8] [--side right|left]`
writes `<clip id>.png`: one row per time and, for each Avatar, a front view,
a ¾ and a side view from the Avatar's own `--side` (default right) and a face
close-up, without live layers. The front view faces the Avatar, so its right
hand appears on the viewer's left. Use `--side left` when the left arm acts,
and larger tiles (`--tile 440x660`) with a few `--times` to judge small
motions, palms or hand shapes; `--view hands` renders close-ups of one hand
instead (see Hand close-ups below). Render the beats (keys of
the main action) and a few in-between times. Look for: readable silhouette at
each beat, staggered arrival, arcs, hand shapes, facial expression, odd
forearm directions, wrist breaks, intersections the capsules miss, and
agreement between the Avatars. Write output to a scratch directory, never the
repository.

### Hand close-ups

```sh
pnpm -s animation:render <clip.json> --out <dir> --view hands [--side left] [--times 0,0.5,1]
```

Renders the `--side` hand (right by default) on both Avatars from the front,
¾, below and facing the palm, one row per time, into
`<clip id>.<side>-hand.png`. Use it to check hand shapes, finger contacts and
palm direction; body sheets are too small to judge fingers.

## Creator confirmation and save

Save through the Gesture creator so the Library item, its metadata and the
runtime catalog stay consistent. `pnpm -s animation:save <items.json>` does
this headlessly for one or more clips (see [batch mode](batch.md) for the
items file); the steps below are the same save by hand. Import a project file
to set the name, the AI description (when chat should choose the Gesture) and
the Selector ID together:

```json
{
  "schema": "animamaActionProject/1.0",
  "intent": "gesture",
  "name": "Mild Laugh",
  "aiDescription": "A short, light laugh at something mildly funny.",
  "semanticKey": "laugh_mild",
  "sequence": { "schema": "animaPoseClip/2.0", "…": "the clip" },
  "dependencies": []
}
```

1. Open `/gestures/new`, Clip tab → Import → choose the file (or paste it) →
   Import. A plain clip file also imports: a new Gesture takes the clip's
   name and the Selector ID follows it, so fill only the AI description.
2. Check the beats on the Pose lane and Clip settings (timeline settings
   button) → Mute while playing.
3. Play it with each Avatar selected in the preview; the creator runs no live
   layers.
4. **Save** (Local content). Use Save & Equip only when the owner asks.
5. Reopen the saved Gesture and play it again.

To revise a saved Gesture, open it from the Library, import the revised clip
on the Clip tab and Save; the item keeps its identity and Selector ID.

## Chat check

On a test Anima, equip the Gesture (or use the debug Gesture trigger) and
watch it in a chat: muted layers should settle while it plays, keyed
expressions should replace the emotion face, and everything should return
afterwards.

## Hand-off

Report:

- the saved item and Avatars reviewed;
- the saved Library item (`library:local/<selector>`), which holds the clip
  and is where later revisions start; drafts in `.animama-drafts/` are not
  kept;
- check results with any accepted WARNs and why;
- render sheets, preview review notes and their resolutions, and the chat
  check;
- known limits.

Automated checks and renders do not prove natural-looking motion. Say which
reviews were done and leave the final judgement to the owner.

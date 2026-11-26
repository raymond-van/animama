# Anima Management Guide

Anima management covers owned Animas, identity, and the direct typed runtime
loadout used by chat.

Routes:

- `/create`: browse the creator hub.
- `/animas/new`: Avatar → Voice → Identity → Actions → Review live creation;
  existing links and optional logical Avatar handoffs remain intact.
- `/animas`: resolve to the first owned Anima or `/animas/new`.
- `/animas/:animaId`: view the rendered `IDENTITY.md` document by default.
- `/animas/:animaId?tab=memories`: read the Anima's relationship `MEMORIES.md`.
- `/animas/:animaId?tab=loadout`: configure the typed loadout.
- `/animas/:animaId/identity`: edit the Anima's `IDENTITY.md` memory entry.
- `/:animaId`: enter the live Avatar/chat surface.

The [live creation journey](custom-anima-creation.md) uses stable live
name/identity authority, atomic creation, and durable idempotency receipts.
Installation bootstrap/repair uses backend starter specifications and preserves existing
customization and deletion. [Library sharing](library.md#import--export) can copy
a reviewed saved definition to a new independent Anima.

## Identity

Identity is the safe default for a bare or invalid management URL. The URL
continues to call this state `overview`, while the visible tab says Identity.
The panel renders the Anima-scoped `IDENTITY.md`; if that file is unavailable,
the selected Avatar's starter identity is shown as a fallback. Edit identity
opens a nested modal route and closing it returns focus to the Identity panel.
Saving updates the shared memory-entry query used by the rendered preview and
subsequent chat turns.

## Memories

The Memories tab renders the selected Anima's relationship `MEMORIES.md`.
Edit memories opens that exact entry in a Markdown editor modal, preserving the
Memories tab and returning focus to its edit button on close.
An empty file remains editable; a missing
file offers Repair memories, which recreates the template without overwriting
an existing file. Load failures offer Retry.

## Chat profile modal

The Anima's profile modal above chat keeps Identity and Memories in tabs below
the portrait and mood. It opens on Identity each time. Each tab's edit button
opens the corresponding Markdown editor without leaving chat; closing the
editor restores focus to that button and keeps the selected tab. Saving updates
the shared document preview.

## Appearance editor

The [Appearance editor](avatar-releases-and-appearance.md) manages independent
Profile and Background images, framing and Avatar portrait fallback.

## Avatar settings

Anima settings (the Settings tab, and Settings in the chat profile modal) end
with an **Avatar** section. It starts with an **Avatar** row naming the Anima's
current Avatar. **Change Avatar** opens a picker (`AnimaAvatarPicker`) listing every Included
and Local Avatar with its portrait. It can also upload a VRM, which passes Create
Anima's browser checks and is saved as a new Local Avatar. **Use Avatar** plans
and commits only the Loadout's `avatar` slot (`POST
/v1/animas/{anima_id}/avatar:plan|commit`) against the Loadout revision the
picker showed. A newer revision refuses the change and asks for a retry. The
Anima keeps its identity, memories, chats, Actions and voice. A chat showing
that Anima remounts its runtime (`remountLatest`) and shows the new model. It
does this at once when idle, or after the current reply, its speech and any
voice turn end (`remountWhenIdle`), because a remount disposes the catalog and
voice a turn still uses. Other surfaces read the next runtime, and an open
desktop picture-in-picture window keeps the old Avatar until it is reopened. On the local runtimes (desktop and
self-hosted web) the section also holds the settings of the Anima's Avatar item, stored per owner and Avatar
through `GET`/`PUT /v1/avatar-content/{item_id}/settings`, so they apply
wherever that Avatar is used:

- **Wind and ambient forces**: Automatic, On, Off or Springs off (see
  [`SpringBonePhysicsController`](../runtime/avatar-animation.md#springbonephysicscontroller)).
  A change applies live on every surface showing the Avatar.
- **Wind strength**: 0–200% of the default wind and updraft, shown under
  Automatic and On. It applies live, and Automatic weighs it when deciding
  whether the Avatar's hair can hold against them.
- **Materials**: shown only for a file whose materials it changes, or while a
  stored choice is not Automatic:
  - a file with authored lilToon materials offers Automatic, lilToon or
    Simple (see
    [Authored lilToon materials](../runtime/avatar-animation.md#authored-liltoon-materials)).
    Automatic loads lilToon and lowers the canvas's frame rate to 45, 30 or
    24 fps where this machine's GPU needs it, and Simple only when it cannot
    draw lilToon at 24 fps (the GPU check in the linked section);
  - a file whose materials all ignore light offers Automatic, which adds toon
    shading and outlines, or Simple, which keeps them flat
    ([Unlit materials](../runtime/avatar-animation.md#unlit-materials)).

  Materials are built at load, so a change reloads the Avatar wherever it is
  shown. Which materials a file has is known once any surface has loaded it in
  this session, or the Library's Avatar settings have read its file facts
  (`useAvatarFileTraitsStore`, keyed by the VRM's sha256).

The Library offers the same rows for any Avatar item (see
[Library](library.md)); both use `AvatarSettingsRows`, keyed by Avatar item.
For a Local Avatar the Library also offers Replace VRM, which changes the
model of every Anima that uses it.
Create Anima has no settings: an unsaved upload has no Avatar item to keep
them for.

Automatic is stored as no value. Every surface that loads a saved Avatar (chat
canvas, Anima page stage, content previews, the content creators, the Pose
creator, Create Anima and Diagnostics' own load) reads the settings through
`useAvatarLoadSettings`, which waits for the read before loading so a Simple
Avatar is not loaded twice; a failed read means Automatic and never blocks the
load. The hosted app never calls the local-only route and shows neither row.
Packages carry the exporter's stored values; an importing runtime that cannot
keep them says so in the import review.

## Avatar diagnostics

The Avatar section's **Avatar diagnostics** row opens a dialog showing what
Animama found in the Anima's Avatar and how it plays it:

- **File**: container and VRM version, size, required and used glTF
  extensions, mesh, mesh-part and material counts by kind (MToon, lilToon,
  unlit, standard), each embedded image's pixel size and, for a file with
  lilToon materials, whether they render with lilToon or as Simple materials
  and why. Under Automatic it gives the GPU check's result: the frame rate
  lilToon renders at and the fastest measured lilToon frame time against that
  rate's budget, or that this GPU is not measured yet or the browser cannot
  time the GPU (lilToon in both cases). A "Next load" line says what the next
  load uses when a measurement since this load changes the materials or frame
  rate. Clearing the measurements measures again ([GPU check](../runtime/avatar-animation.md#authored-liltoon-materials)).
- **Face**: how each face part was found (model data, material names, a saved
  correction, estimated from blinking or the eye bone for an eye without its
  own mesh, the head of a whole-body mesh part for a face painted on a
  one-mesh Avatar, or not at all) and whether face landmarks and
  texture anchors are ready.
- **Expressions**: the standard VRM expressions present (a preset that plays
  nothing counts as missing), those played through ARKit mixes or MMD morphs,
  blinks and visemes filled from the file's left and right blinks or from MMD,
  ARKit or VRChat shapes, ARKit shape coverage, each mood's source per face
  region ([Faces on non-VRoid Avatars](../runtime/avatar-emotion.md#faces-on-non-vroid-avatars)),
  and names Gestures, Reactions or moods asked for that the Avatar lacks.
- **Motion**: humanoid bones, missing required bones, missing optional bones
  that content uses with what stands in for each
  ([Optional bones a rig lacks](../runtime/avatar-animation.md#optional-bones-a-rig-lacks)),
  the rest pose (arms
  from a T-pose and hands from VRoid's, and whether each was normalized:
  [Rest normalization](../runtime/avatar-animation.md#rest-normalization)),
  spring joints and colliders, and the wind setting in effect with whether
  wind and updraft apply. Each setting also shows whether it is saved for the Avatar or the
  default.
- **Warnings**: every face-part, landmark, texture-anchor, expression (no
  usable face expressions; `Fcl_EYE_Iris_Hide` with no iris part to hide),
  spring and effect finding, once each, and, read from the file before
  loading, each glTF extension the file needs that Animama cannot load (such
  as Draco compression) and materials that all ignore light, which Animama
  toon-shades unless the Materials setting is Simple.

Diagnostics describes one of three sources (`useAvatarDiagnostics`):

- an Anima's Avatar (this row): the Avatar on the chat stage when that Anima
  is there. Only this source lists effect warnings, which depend on the
  Anima's Gestures and Reactions; the other two leave out the effect
  findings the dock's or stage's own previews leave on their Avatar (other
  findings from content played there, such as an iris hide with no iris part
  or a mood the Avatar lacks, still show until that Avatar reloads);
- an Avatar item, from the Library's Avatar settings: the preview dock's
  Avatar when the dock shows that revision of the item
  (`usePreviewDockAvatarStore`);
- an unsaved upload, from Create Anima: file facts from the chosen file and
  live facts from the creator stage's Avatar once it loads. Under
  "Previewing …" the step shows one status line (checking, no problems found,
  the number of problems, or that the file could not load) with **View
  diagnostics**.

Without an Avatar on screen, it loads the Avatar separately, with its saved
face part correction and settings, and releases it on close. An Avatar that
does not load still shows its file facts and the load error. **Copy report** copies a plain-text report and **Raw JSON** shows
the same `animama/avatar-diagnostics/1` report as a collapsible tree, with
Copy JSON for the whole document. Reports identify the
Avatar, and any effect a warning names, by source and item id
(`local:<item id>`), an unsaved upload by kind alone (`upload`), and hold counts, standard names (VRM expressions and
bones, ARKit shapes, VRoid `Fcl_` parts) and codes only: no file paths, URLs,
or Avatar, material, effect or custom expression names. The dialog itself
names effects on screen. Diagnostics uses only the runtime snapshot, loadout,
the shared Avatar preview route and content delivery, with nothing
local-only, so hosted builds include it.

## Loadout

`GET /v1/animas/{anima_id}/loadout` supplies one typed aggregate containing:

- a short active Gesture list;
- the Anima's Reaction pools: one cell per emotion and intensity (Mild,
  Moderate, Strong, Intense), each holding up to four Reactions;
- the Anima's own Idle pool (Default plus emotion/intensity cells);
- one Avatar content selection; and
- typed profile/background Appearance Images with fit, focal point, and zoom.

Gestures and Reactions are complete actions. Their Particle, Avatar, and
Scene Effects and Sound Effects are compiler-managed dependencies, so those
ingredients never appear as separate loadout checkboxes.

The Behavior tab shows the Anima's Loadout: Voices, Gestures, Reactions and Idle.
Voices configures PocketTTS and ElevenLabs for this Anima, regardless of the
active application provider. The Avatar is chosen in
[Avatar settings](#avatar-settings) and Appearance in its own editor.
Imported encoded-only voice clones remain selectable for speech; their original
recording preview is unavailable because the recording is not shared.

The unified Gesture list includes every ready Local and Included Gesture; the
Anima's Gestures are exactly its equipped rows, so a removed Gesture stays
listed, unequipped, until it is equipped again. The header shows the
number equipped out of the full inventory, independent of search or filters.
The filter menu offers independent Show included and Show local controls;
Included content remains Included when explicitly equipped. Local search matches
any part of a name; rows show the name, and the description appears in a
tooltip on hover or focus. The menu filters equipped or unequipped rows
and sorts Custom first (Local before Included, as in the Library), by name A–Z,
or by name Z–A. Motion type can be narrowed
to VRMA or Clips; Clips maps to the normalized
`anima_clip` implementation. A compact checked status identifies
equipped rows. Equip and Remove continue through the server-backed loadout
review before commit; every row's menu opens the Library, and an equipped
row's menu also removes it. Creating a Gesture makes it
available here but does not equip it automatically.

Reactions show one expandable row per emotion, summarising how many Reactions
it holds, with its four intensity cells. Each cell lists its Reactions with
the Starter badge for the cell's Included starter Reactions, Preview and
Remove; an empty cell reads "No Reaction". Each emotion event in chat plays one
member of its cell, chosen at random ([avatar planner](../runtime/avatar-planner.md)).
The cell's Add picker lists every ready Local and Included Reaction, with its
optional suggested emotion and intensity as context only: any Reaction can join
any cell. Reactions already in the cell are marked and cannot be added again.
A cell holds at most four Reactions; at four, Add is disabled and the cell says
why. The cell menu opens the Library and, unless the cell already holds exactly
its starter Reactions, offers Restore starter. Removing the last member leaves
the cell empty, which plays no Reaction. A starter Reaction that cannot be
restored is skipped with a warning. Unavailable members stay listed, marked,
so they can be removed.

Adding, removing and restoring apply at once through `reactions:plan|commit`
without the review dialog, like Idle. A failure shows an error and leaves the
pool as it was; a stale revision refetches the Loadout and asks the owner to
try again. Changes reach chat on the next runtime mount.

Idle is the Anima's built-in pool of Gestures for quiet moments
([ADR 0026](../../adr/0026-built-in-idle-pool-per-anima.md)); it always exists
and cannot be swapped for another. The section shows Default first, then one
expandable row per emotion with its Mild, Moderate and Strong cells, each
listing its Gestures with Preview and Remove. Moderate and Strong also list,
read-only, the Gestures they inherit from lower intensities. Each idle is a
Default Gesture half the time and a Gesture from the current emotion's cells at
or below its intensity the other half; a cell with nothing to add reads
"Default only". An empty pool schedules nothing, while breathing and resting
continue. Neutral uses Default. A Gesture in the pool is never equipped
for AI invocation, and the same Gesture can sit in several cells.

Each cell's Add picker lists ready Local and Included Gestures not already in
or inherited by that cell. Choosing one checks its finite playback first
(`GET /v1/gestures/{item_id}/idle-playback`); an ineligible Gesture stays in the
list, disabled, with the reason. Both VRMA and `animaPoseClip` Gestures need
finite authored playback. Adding and removing apply at once through
`idle:plan|commit` without the review dialog; a failure, including a stale
revision, shows an error and refetches the Loadout. Removal names the member's
binding, so an unavailable Gesture can still be removed.

Appearance choices are separate typed images rather than generic files. A
custom profile image wins over the selected Avatar content portrait; otherwise
the UI falls back to the portrait and then initials. Avatar/Appearance changes
use their typed plan/commit lanes from focused management controls.

## Review and commit

Each family uses a typed plan endpoint followed by its matching commit
endpoint. Gesture changes open a review that labels every selected Anima as
Add, Update, Replace, Remove, Revert, Leave Empty, Unchanged, or Blocked;
Reaction and Idle pool edits commit their plan at once. Target-local failures
do not hide successful targets, and a failed-only retry keeps the same
idempotency intent.

The dialog delegates Preview to the existing Library dock or management stage;
it never owns a second WebGL canvas. Dependency-complete previews are isolated
from the real loadout.

Commits carry the current optimistic revision, server plan digest, and stable
idempotency key. A stale tab refetches instead of overwriting newer state.
Changes appear on the next chat mount because a mounted route keeps its issued
runtime revision.

## Runtime and presentation

`AnimaRouteProviders` freezes one `GET /v1/animas/{anima_id}/runtime` snapshot.
The same `runtime_revision` is sent with every chat turn. If the snapshot is
missing or expired, chat stops before model execution and offers a remount;
the client never silently retries against a different loadout.

Anima list and management presentation uses the bounded server projection, not
a full runtime read per row. Private and Included thumbnails are fetched from
registered authenticated catalog file routes into disposable Blob URLs. The UI
does not infer a public content URL or download a VRM merely to render
navigation.

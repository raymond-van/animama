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

## Loadout

`GET /v1/animas/{anima_id}/loadout` supplies one typed aggregate containing:

- a short active Gesture list;
- a canonical emotion-by-intensity Reaction grid;
- one emotion-aware Idle Style;
- one Avatar content selection; and
- typed profile/background Appearance Images with fit, focal point, and zoom.

Gestures and Reactions are complete actions. Their Particle, Avatar, and
Scene Effects and Sound Effects are compiler-managed dependencies, so those
ingredients never appear as separate loadout checkboxes.

The Loadout panel contains Voices, Gestures, Reactions and Idle Style.
Voices configures PocketTTS and ElevenLabs for this Anima, regardless of the
active application provider. Avatar and Appearance use their own focused controls.
Imported encoded-only voice clones remain selectable for speech; their original
recording preview is unavailable because the recording is not shared.

The unified Gesture list includes every ready Local and Included Gesture,
including unequipped Gestures outside the starter set. The header shows the
number equipped out of the full inventory, independent of search or filters.
The filter menu offers independent Show included and Show local controls;
Included content remains Included when explicitly equipped. Local search matches
full names and descriptions. The menu filters equipped or unequipped rows
and sorts by custom-first, name A–Z, or name Z–A. Motion type can be narrowed
to VRMA or Clips; Clips maps to the normalized
`anima_clip` implementation. A compact checked status identifies
equipped rows. Equip, Remove, Disable, and Restore continue through the
server-backed loadout review before commit. Creating a Gesture makes it
available here but does not equip it automatically. Reaction cells visibly
distinguish Starter, custom, and intentionally empty states. Every cell's
searchable selector lists every ready Local and Included Reaction, with its
optional suggested emotion/intensity shown as context; choosing one assigns the complete
Action to the clicked cell regardless of that suggested placement. Adding,
updating, replacing, removing, reverting, or leaving a Reaction empty uses the
same review boundary. Replacing a cell names the current occupant.

An Idle Style owns pools of existing Gestures. Its Default pool can be empty;
each emotion/intensity cell inherits Default, explicitly disables idle, or uses
its own nonempty pool. Neutral uses Default. Choosing a Gesture for a Style
does not equip it for AI invocation. Both VRMA and `animaPoseClip` Gestures need
finite authored playback to be eligible.

The loadout chooses, previews, edits or duplicates one Style, or leaves idle
empty. Pool edits belong to the Style editor. Editing a shared Local Style
affects its users on their next mount; duplicate it first for independent pools.
Customizing Included content creates a Local copy. The editor preserves its
loaded revision when saving or recovering an interrupted Save.

Appearance choices are separate typed images rather than generic files. A
custom profile image wins over the selected Avatar content portrait; otherwise
the UI falls back to the portrait and then initials. Avatar/Appearance changes
use their typed plan/commit lanes from focused management controls.

## Review and commit

Each family uses a typed plan endpoint followed by its matching commit
endpoint. The review labels every selected Anima as Add, Update, Replace,
Remove, Revert, Leave Empty, Unchanged, or Blocked. Target-local failures do
not hide successful targets, and a failed-only retry keeps the same
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

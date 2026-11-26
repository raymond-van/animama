# Library

`/library` is the local product collection. It presents Avatars, Gestures,
Reactions, Poses, Particle Effects, Avatar Effects, Scene Effects, Sounds, and private
chat uploads without exposing file roles, host paths, digests, or dependency
binding mechanics.

## Route state

Library URLs are sparse and section-specific. The default state is simply
`/library`; default values and hidden-section filters are never serialized.
The canonical parameters are:

- `section=avatars|actions|fx|chat-uploads`; omitted means All
- under All, optional `type=avatars|gestures|reactions|poses|particle|avatar-effects|scene|sound`
- under Actions, optional `action=gestures|reactions|poses`,
  `gestureMotion=anima_clip|vrma`, `gestureUpdatesOnly=true`,
  `gestureStatus=equipped|unequipped`, and
  `gestureSort=name-asc|name-desc`
- under FX, optional `fx=particle|avatar|scene|sound`
- under All, Avatars, Actions, or FX, optional `showStarters=false`,
  `query`, and a non-default `sort=relevance|updated|name`
- under Chat Uploads, optional `uploadQuery` and
  `uploadStatus=pending_upload|uploaded|processing|ready|ready_keyword_only|failed`

For example, Scene FX is `/library?section=fx&fx=scene`, while
`/library?type=scene` filters the All section to Scene FX. All keeps its own
secondary type row beneath the main sections; choosing a type leaves the main
All tab selected. Choosing All in that row restores the combined inventory.
Changing sections discards section-specific filters. The route expands sparse URL
state into complete internal defaults before rendering Library components.
Gesture filters also apply under All when All types or Gestures is selected.
Gesture-only filters are cleared for Poses; its available sorts are name and
relevance. The typed Pose response has no update timestamp, so Recently updated
is unavailable for that subtype.
Discrete filters create history entries; text search replaces the current
entry so typing does not flood history.

## Product inventory

Product hooks consume concrete typed API groups over the neutral Content
Catalog. Each group owns its own loading, retry, empty, cursor, and collapse
state. Included items are read-only Starters; Local items are editable copies
created by the user, imported from a package, or added by the host operator.
Search matches any part of an item's name, ignoring case; descriptions, which
tiles show only in a tooltip, are not searched. The box keeps what you type,
spaces included, and updates the URL after a short pause. Except Avatars,
which search on the server, each family's full list is fetched once and cached;
search, origin and Gesture motion filters apply to that cached list, so typing
never re-downloads it.

Tiles show the `variant=thumbnail` copy of an item's first image (a WebP of at
most 128 pixels) and load it only near the viewport, keeping the family icon
until it draws, or if the image is too large to preview. A Particle tile reads its
manifest's tint only once its texture
has loaded. A runtime that reports `library_previews: false` offers no previews:
every item tile except Avatars shows its family icon, and the Library requests no
thumbnail, texture or manifest for it.

An attention indicator exposes affected items, validation details and Retry scan
when content is invalid, missing, awaiting a scan or unavailable. Valid content can Preview;
Edit follows Preview for Poses, Gestures, Reactions and Particle/Avatar/Scene Effects.
It opens the selected item in its creator: Local content updates that
item, while Included content starts a Local copy. Gesture/Reaction rows can Add or Manage Anima
loadout selections. Sounds offer Play/Stop and Manage for Local rename, same-format replacement and
guarded deletion. Included Sounds are read-only. Licensed built-in sounds are not
listed: they play only through their built-in effects. A Local file with the same
licensed bytes is hidden too; remove it from the Local folder by hand. Effects and Sounds offer “Use in Gesture/Reaction” because
they are action ingredients, not independent equipment.

Actions contains All, Gestures, Reactions and Poses. Poses also appear in the
combined All inventory. Pose rows offer Preview and Edit without a Starter badge.
Editing opens `/poses/$poseId/edit` with the
existing Pose controls and an isolated Avatar, without creating a Gesture or
replacing a suspended clip draft. Included customization creates a new Local
identity; it never changes the starter. The five starter Poses are Relaxed Rest,
Shy Finger Poke 1 and 2, and Thinking Head Scratch 1 and 2; the other Included
Poses are the hand-made poses the Included Gestures were built from. Poses have no Add/Manage
equipment action; only Local poses offer deletion in the creator load panel.

Avatar rows use `/v1/avatar-catalog`, which joins Avatar metadata to a valid
catalog model and registered portrait Appearance. Each row uses that model's
generated portrait (never an Anima's custom profile picture), falling back to an
icon when unavailable. Preview resolves registered VRM bytes; Create Anima hands
the Avatar to Anima creation. **Avatar settings** (on cards with a catalog
item, in both layouts) opens the Avatar's wind and Materials settings, the
same rows as Anima settings, so a change applies wherever the Avatar is used,
the preview dock included (see
[Avatar settings](anima-management.md#avatar-settings)), and **Open
diagnostics** for that item. Materials needs to know whether the file has
lilToon materials or only materials that ignore light; the backend keeps no
file facts, so the dialog reads the
file once per session when no surface has loaded it. The hosted app keeps no
Avatar settings, so there the dialog offers Diagnostics only. Entries without model files are omitted; reference-safe seed reconciliation
preserves records needed by Animas.

For a Local Avatar the dialog also has **Replace VRM** (`LibraryAvatarModelRow`),
which swaps in an updated file while keeping the same Avatar item. The chosen
file passes Create Anima's browser checks first. The owner then confirms after
reading which Animas use the Avatar and, when a face part correction is saved,
that the correction stops applying because it names the old file's digest. The
save is `PUT /v1/avatar-content/{entry_name}` with the item's own file name,
`catalog_item_id` and the reviewed revision, without `creation_context`, so an
Avatar in use can be replaced. A changed revision refuses the write and the
dialog reads the details again. The sidecar is left as it is, so the name,
description and identity stay. Avatar settings are keyed by item and stay too.
Each Anima's Loadout points at the item, so Anima pages pick up the new model
at once and a mounted chat at its next runtime mount. Afterwards the Library
previews the new model. The Dock retakes the portrait, as described under
[Avatar portraits](avatar-releases-and-appearance.md). Included Avatars cannot
be replaced.

Some Included content is **non-portable**: it plays, previews and can be
equipped, but never leaves the app as files. Its Gesture and Reaction rows show
**Not editable** in place of Edit; its tooltip, and a description read by
screen readers, give the reason.
It opens a preview-only page, with the reason in text, instead of the editor; the
same page appears for its creator URL. Its Starter is not offered for
customization. There is no visible badge. See the backend
[non-portable content](../../backend/features/typed-content-and-marketplace.md#non-portable-content)
rules.

Chat Uploads remain separate. They use `/v1/files`, private `data/` storage,
processing status, and retrieval diagnostics. They never enter the Content
Catalog or runtime package closure.

## Preview

Library Preview issues the selected catalog item's exact current preview and
prepares its files with `PreviewByteSession`. Gestures and Reactions include
their resolved VFX/Sound supports; visual and audio playback therefore uses the
same validated closure as a mounted Anima without changing any loadout.

Static Pose preview reads a verified registered descriptor and plays a temporary
hold clip in the Dock. Its preview identity is distinct from equipped Gesture
identities, and it retains the selected Anima's Avatar without changing its loadout.

Every playable Included or Local item has registered files. Preview performs
one protected FastAPI fetch per unique file during preparation and then uses
ephemeral Blob URLs. It never follows a public media alias or downloads from an
object store.

## Add and Manage

The equip dialog lists every owned Anima with its current Loadout. A Gesture
is equipped to or removed from each Anima; the row warns when equipping would
replace another Gesture with the same semantic key. Each change carries the
expected loadout revision and an idempotency key.

For a Reaction the dialog first offers an emotion and an intensity (Mild,
Moderate, Strong or Intense). It starts at the Reaction's suggested cell, or
Joy, Mild when there is none; a suggestion with an emotion but no usable
intensity starts at that emotion's Mild. The suggestion is only a hint. Each
Anima's row says whether that cell's pool holds the Reaction and offers Add or
Remove for that cell only. Other Reactions in the cell never change. When the
cell already holds four Reactions, Add is disabled with the reason; remove one
in the Anima's Loadout first. Changes apply at once, like pool edits in the
Loadout; a change made against a stale Loadout refreshes the row and asks for a
retry.

Equip advances future loadout resolution only. The current chat remains pinned
to its prepared runtime revision until the route remounts. Effects and Sounds
remain transitive dependencies of their owning Gesture or Reaction.

## Creation

`/create` links to dedicated Anima, Gesture and Reaction creators. Its effect
cards, the sidebar Create menu's **Effects** item and `/effects/new` open the
Effects template picker: choose Particle, Avatar or Scene FX, then a template or
Start from scratch. A template opens its creator with a new, unsaved Local draft;
Included content is never changed. Sound uploads live in Gesture/Reaction SFX tabs and
Avatar/Scene FX accompanying-sound pickers. Creator Save writes ordinary files through
the matching typed family route, such as `/v1/gestures/{entry_name}` or
`/v1/particle-effects/{entry_name}`. Editing a Local item updates that item
directly; there is no release, finalize, or Apply workflow.

There is no Pose entry on Create or New Pose button in Library. Author a new Pose
inside the Gesture editor, then Save to Local content. Library is for previewing,
editing and customizing these saved items. Inserting a Pose into a Gesture copies
its effective values, so later Pose edits or deletion cannot change that clip.

Gesture and Reaction creators use an immersive Avatar workspace. Gesture
supports VRMA and Anima Pose Clip motion. Reaction uses expression/VFX/SFX
timeline authoring without humanoid motion. Adding a component creates one
dependency plus a timeline event as one undoable document edit.

Load groups customizable Included templates separately from Local content.
Loading an Included template creates a new unsaved Local document; it never
modifies Included. Loading Local opens its current descriptor/sequence and
dependencies. Import/export of direct Anima Pose Clip or typed project JSON is
an editor-document workflow; package import/export is a separate Content
Catalog boundary.

Save & Equip saves the current Local item, then opens the equip dialog
described under [Add and Manage](#add-and-manage). An already-mounted chat
still adopts it only after remount.
Unknown event aliases remain visible and block Preview/Save until mapped or
removed.

Avatar-to-Anima entry links reach the four-step `/animas/new` creator with a
logical Avatar ID. The creator resolves its exact admitted revision; an
existing saved owner draft wins over a new hint and unavailable content leaves
a recoverable error instead of silently choosing another Avatar.
See the [live creation workflow](custom-anima-creation.md) for validation and recovery.

## Manual files

The local watcher scans normal host edits automatically. Catalog polling refreshes
Library and Appearance queries when content changes; scan timestamps alone do not
trigger repeated list fetches. Each poll revalidates by ETag, so an unchanged
catalog costs a 304, and the first catalog read does not refetch the lists. Valid manual files become selectable but never
auto-equip. Invalid or missing entries remain inert with discreet diagnostics and
a Retry scan action.

Music and standalone Pose Clips are not supported Library items. An Action that
still references a retired Pose Clip is listed with an unsupported-clip-format
diagnostic. Static Poses and Creator Clip/project JSON import/export remain available.

## Import / Export

The Library header has separate **Import** and **Export** buttons. Import opens
the ZIP drop/choose screen; Export opens Content and Anima selection directly.
An unfinished import resumes before either button can start a new operation.
These are local file operations, with no account, publishing or sync relationship.
Direct Creator JSON import/export remains a separate editor-document workflow.

In Content mode, select one or more saved items. Search and category filters keep
existing selections. Required content is included automatically and shown
separately from selected items in the count and size summary. Review the exact
package before **Download package**. Missing or changed sources require another
review; an expired export can be prepared again from the retained selection.
Downloaded filenames use the installation owner's display name (or `content`
when unavailable), followed by a UTC timestamp. Non-portable items are listed
but cannot be selected, except licensed sounds, which are not listed. A review
lists any non-portable items the package leaves out, for example Gestures in the
Anima's Idle pool, and says how many built-in effect sounds stay with
this app (imported copies of those effects play without them).

In Anima mode, choose a saved companion and review its full identity and selected
content before **Export Anima**. The package includes its name, identity, Avatar,
Gestures, every Reaction cell's pool including empty cells, the Idle pool, and selected
profile/background images with framing. The review's Reaction cells list each
emotion's four cells with their pools' Reaction names in package order, which
import recreates exactly. It preserves supported Action settings
and effective starter choices. If this Anima uses a cloned PocketTTS voice, the
package includes the encoded voice and selects the independent imported copy.
The original recording is excluded. Other voice choices and provider/model
settings use the receiving installation's defaults. Conversations, identity
history, other memories and private chat uploads are excluded.
Anima downloads use the companion's display name and a UTC timestamp.

Import first uploads and validates the file, then shows the complete package and
its destination names. **Import N items** or **Import Anima** installs the whole
reviewed package. All required content becomes independent editable Local copies,
even when identical content already exists. Name collisions, including Included
names, receive `-2`, `-3` and later suffixes; existing items are never replaced.
A destination change requires a fresh review. Items the sender left out because
they are non-portable are listed with their outcome: **Uses this app's copy**
when this installation has the same item, or **Not available here** when the
slot falls back to its default. An Anima import also creates a new
companion in the same operation. Completion offers **View in Library** or
**Open Anima**; acknowledging it releases temporary upload data.

### Interrupted sharing

Before commit, an interrupted upload can resume by choosing the same file. The
server verifies previously received parts as well as new bytes. **Change file**
discards the old review before preparing a replacement. Browser storage retains
only operation/recovery identifiers, not package bytes or a second content library.

After submitting an import, reopen **Import** and use **Check import status** if
its result is unknown. Closing or reloading cannot cancel an installation already
in progress. Recovery checks the original operation's durable receipt; it never starts another import
automatically. A completed result remains recoverable after temporary data expires.
A storage conflict keeps recovery pending until repaired. If the server confirms
there is no active operation, discard the recovery record before choosing the file
again. Keep an unresolved recovery record rather than clearing browser storage.

Only `.zip` files containing a valid `animama-content-package/3` archive are
accepted; unrelated ZIPs fail validation. A file may be at most 4 GiB. Two
import/export stages share a temporary quota and expire after
30 inactive minutes. Active transfers and commits are protected. Finished export
caches may be reclaimed when space is needed; a new export creates another download.
See the [package contract and full limits](../../backend/architecture/http-api.md#package-sharing)
for validation, supported content and recovery details.

# Anima Memory

Frontend memory workflows use the
scoped `/v1/memory/entries` API through generated client methods and TanStack
Query hooks.

## Current User-Facing Surfaces

`/memories` provides an installation-wide file explorer, Manual editor,
Memory Manager and Markdown preview covering user memory and every owned
Anima's identity and memories. Upload management and retrieval diagnostics
live in [Library Chat Uploads](user-file-uploads.md). Markdown previews of
memory and identity files show images as their alt text and load none.

The workspace loads content-free user entry headers recursively and the
`GET /v1/memory/anima-identities` listing. Its left explorer starts with a
virtual `Animas` root, then a virtual `Episodes` root, then ordinary physical
entries. Both virtual roots are always present, show an empty state when they
have no children, and cannot be displaced by newly created memory entries.

`Animas` holds one folder per owned Anima in creation order, each containing
only that Anima's Anima-scoped `IDENTITY.md` followed by its relationship
`MEMORIES.md`. Folders show the current name; later Animas sharing a name
receive ` (2)`, ` (3)`, and so on, skipping any suffix another Anima already uses
as its real name. The owner-facing path, such as `Animas/Annie (2)/MEMORIES.md`,
appears in tooltips, filtering and Preview; renames and new Animas refresh the
listing through the Anima definition and creation cache invalidations. If the
listing fails to load, user memory remains available and a toast offers Refresh.

A folder with a missing file shows a warning icon. Expanded, it states that the
identity is missing and needs repair, or that `MEMORIES.md` is missing with a
Repair action. Repair calls `POST /v1/memory/anima-memories/{anima_id}:repair`,
which recreates the file from its template and never overwrites an existing
one, then refreshes the listing; failures appear as a toast. The two states are
independent: an Anima can have its identity and no `MEMORIES.md`.

The generated `episodes/**` storage hierarchy is replaced by the virtual
`Episodes` root.
Canonical `episodes/YYYY/MM/YYYY-MM-DD.md` files are grouped by newest month and
displayed with friendly dates. Malformed or historical episode paths remain
visible under `Other episodes`. Generated episode files are read-only.

The explorer supports local filtering, refresh, file and directory creation,
rename, file deletion and recursive directory deletion, path tooltips, per-file
dirty indicators, and hierarchy moves. Its centered icon toolbar can expand or
collapse every directory group at once. Each ordinary row exposes the same
actions through its ellipsis and right-click menus. Directory rows can create
children; right-clicking empty explorer space creates at Memory root regardless
of the previously focused row. Destructive directory confirmation reports its
contained entries and any unsaved drafts that will be discarded. Dragging an
ordinary file or directory onto another ordinary directory moves it immediately.
The row action's searchable `Move to...` picker provides the same operation for
keyboard and touch use and is the way to move an entry back to Memory root.
Moves and renames preserve stable entry IDs; they do not change the deterministic
directory-first/name ordering.

New file accepts either a leaf name or a relative path. For example,
`projects/launch.md` creates any missing `projects` directory beneath the
current creation target and then selects `launch.md`. The final `.md` extension
is added when omitted. New directory remains a single-segment operation.

Generated episodes, virtual episode groups, the virtual Animas root and folders,
`IDENTITY.md` and `MEMORIES.md` files, `PROFILE.md`, files, the source's current
parent, the source itself, and descendants of a directory being moved are not
valid move targets as applicable. `IDENTITY.md` and `MEMORIES.md` rows keep
their protected row menus: they cannot be renamed, moved or deleted. Creation
and moves are disabled while a virtual episode group, generated episode, Animas
folder or Anima file is focused. Creation otherwise
targets the focused physical directory or the selected ordinary file's parent.
The explorer initially selects `PROFILE.md`, then the first ordinary file by
path, then the newest episode.

User memory cannot use the reserved `animas` path. A user `animas` directory
created before that reservation stays visible with a warning; its files open
read-only in Manual until they are moved or the directory is renamed, and it
cannot receive new children or moves. Rename, move and delete remain available.

Move requests use the existing version-aware patch endpoint and are not
applied optimistically. On success the explorer refetches the server tree while
selection, focus, expansion, and dirty drafts remain anchored by stable entry
IDs. Path-based selected-file URLs follow the new path. A locally initiated
path-only version increment rebases affected draft baselines without changing
their text or dirty state; any unexpected version advance is shown as a draft
conflict. A `409` keeps the visible tree unchanged, while an uncertain network
result triggers a refresh before the entry can be retried.

Desktop panes support pointer and keyboard resizing; double-clicking a separator
restores its default proportions. Sizes persist on the device, and the explorer
can collapse without losing its expanded width.

The middle Work pane switches between Manual editing and Memory Manager through
a `Manual | Memory Manager` control, with Manual first and selected by default.
Selecting a generated episode while Manual is active switches the work mode to
Memory Manager; ordinary files preserve the current mode. On smaller screens,
`Files`, `Work`, and `Preview` select one pane at a time; resize handles are not
shown, and selecting a file opens Preview.

Memory descriptions are first-class metadata, separate from the Markdown body.
They form the birds-eye file index shown to Anima chat and the Memory Manager so
an agent can decide which files merit full reads. Agent guidance requires every
content edit to review description accuracy, preserve an accurate description
verbatim, update it when scope or durable contents materially change, and give
new files useful concise descriptions. Native Apply Patch carries both fields
through a transient model-only synthetic header, but the workspace and ordinary
entry APIs always receive body-only Markdown plus the separate description.

## Manual Drafts

Editable files receive an in-memory draft when their content first loads. Each
draft retains its server version and baseline content and description. Drafts
survive file changes, explorer interactions, responsive pane changes, and
Manual or Memory Manager mode changes. The right pane renders the selected
Manual draft live, while the explorer marks every dirty file.

Save uses `expected_version`. Clean drafts follow newer query results; dirty
drafts are preserved and marked conflicted if the server version advances.
Conflict recovery offers `Use latest` and `Save over latest`. Discard and delete
require confirmation, and required entries plus generated episodes retain
their existing protection.

Identity drafts also carry the Anima aggregate revision, exactly like the
`/animas/:animaId/identity` editor: a concurrent name, Avatar, loadout or
identity change conflicts while keeping the draft, and a blank identity is
rejected before any request. Saves and reverts refresh that Anima's definition
views. `MEMORIES.md` is not part of the Anima definition: its drafts are guarded
by version only, never conflict with identity, name, Avatar or loadout edits, may
be saved blank, and do not refresh definition views. If an Anima is deleted, its
folder disappears on the next refresh and drafts for its files are dropped; the
same happens to a draft whose file becomes missing. A dirty dropped draft
produces a warning that its unsaved text could not be saved.

Dirty drafts do not interrupt normal workspace navigation. Leaving
`/memories` opens a prompt with Stay, Discard and leave, and sequential Save
and leave actions. Browser reload or close uses the native unsaved-changes
warning.

## Versions and Revert

The Preview pane shows a Copy icon followed by the selected entry's current
Version action. Copy writes the exact content currently rendered—including an
unsaved Manual draft—to the clipboard. Version opens a responsive read-only
history dialog without changing or discarding the current Manual draft.
Summaries are listed newest first and can
load older pages; the latest Version is selected initially.

Selecting Version N opens “Changes in Version N.” Version N greater than 1 is
shown only against Version N-1, and Version 1 is labeled as creation against an
empty Version 0 baseline. Content changes use the shared unified-diff renderer;
path and description changes show explicit old/new values even when content is
unchanged. On narrow screens, selection moves from the list to the detail view
and an explicit Back action returns to history.

For an older Version of an editable live Markdown file, `Revert to Version N`
opens a separate confirmation with exact current and target content in
side-by-side panels that stack on narrow screens, plus explicit
current-to-target description values. Revert is not optimistic. On success the
returned entry becomes the clean Manual-draft baseline. A `409 Conflict`
refreshes current entry and version data while preserving any newer local
draft.

If the Manual draft is dirty or conflicted, the dialog first offers `Discard
draft and continue` inline. That uses the existing discard behavior, but does
not execute the Revert: the user must still confirm it separately. Generated
episode logs and all other protected/non-editable history remain entirely
read-only. The dialog has no arbitrary two-version selector.

## Route State

The canonical route search state uses `tab=memory|uploads` and
`mode=manual|manager`, with optional `entryId`, file `path`, and `managerRunId`. An
Anima file is selected by `entryId`, so renaming its Anima keeps the selection;
a `path` such as `Animas/Annie/MEMORIES.md` resolves through the current folder
labels and is then replaced with that file's `entryId`. Links from other pages,
such as the chat [memory cue](../runtime/chat.md#memory-cue)'s Open in Memories,
use `entryId`. The Anima management and chat profile Memories tabs instead open
the file editor in place.
Task prompts are not route state. File and manager-run updates replace the
current history entry, while tab and Manual/Memory Manager mode changes push
history. Explorer search, expansion, collapse, focus, responsive pane, drafts,
and the unsent manager composer are intentionally local state.

When `managerRunId` is absent, the workspace resolves the installation owner's
one current open run, but it restores the ID only when the run is
`waiting_approval`. A prior `active`, `completed`, or `failed` run is not shown
in a fresh Memory workspace session; the composer remains a local, row-free new
conversation. This lookup protects unresolved approvals without exposing run
history.

Desktop pane proportions are also excluded from route state. They use the
versioned `animama.memory-workspace.layout.v1` browser-storage key and fall back
to the default layout when the stored value is missing or invalid.

Manual is the normalized mode when `mode` is missing or invalid. Legacy episode
links, legacy `managerOpen=true` links, and run-specific links still infer
Memory Manager when they omit an explicit mode. An explicit `mode=manual`
remains authoritative, including when a manager run is also present in the URL.

Legacy `tab=user`, `tab=episodes`, `directory`, and `managerOpen` URLs normalize
into the workspace contract. Historical `managerTask` values are accepted while
parsing old links but are dropped rather than becoming canonical state. Selected
file and manager state remain in the URL while Uploads is visible so returning
to Memory restores the prior context.

## Memory Manager

Memory Manager is available as the second mode in the inline Work pane. Opening
a new manager keeps its composer local; the first submitted message creates the
durable run and processes that message. A run created or recovered while the
current Memory page remains mounted continues normally across file, mode, and
tab changes.
Leaving `/memories`, closing the browser tab, reloading, or returning through
browser history starts a blank ordinary conversation. The only cross-session
exception is a `waiting_approval` run, whose transcript and review card are
restored so the proposed change cannot be stranded. Inline diff approval cards
refresh the explorer and persisted preview after approved changes. Selecting a
file remains visual context and does not change manager requests; only Reflect
acts on the selected file.

App Settings → Memory & Emotion sets installation-wide defaults for memory,
memory updates and emotion updates. Each Anima's settings offer "App default",
On or Off; turning memory off also stops memory updates. Where the runtime reports
`automatic_episode_processing` (the local app), the same section has "Process episode
notes automatically": Off, or a pending-note count from 5 to 50 (default 10) that
starts a backend Memory Manager run. Its description shows what the backend reports
from `/v1/memory/automatic-processing`: running, paused after failures, retrying,
the daily limit, a missing model, memory turned off, or a ChatGPT plan model that
waits for the owner's agreement, a new sign-in or the end of a usage-limit pause
([ChatGPT plan](model-settings.md#chatgpt-plan)). The value is stored by the
backend, not in preferences, so Reset app settings does not change it. Versions an
automatic run writes are labelled "Automatic update from episode notes" in a file's
version history. The Memory Manager's
model is chosen in App Settings → Models → Default models (saved as
`models.memory_manager_model_provider_id`): any tool-calling model from any
connection. "Same as Chat" clears the choice, so the manager uses the operator
default or the Chat default when it supports tools.

The text-only composer submits with Enter and inserts a newline with Shift+Enter.
Responses arrive in one request and render as Markdown; the reveal animation
does not indicate SSE streaming.

Submissions are projected locally while the request-response manager runtime is
working. The trimmed user request appears immediately with an assistant loader,
then the returned durable transcript replaces that pair without duplication. A
failed request removes the projection and restores the submitted text unless a
newer draft is present. Approval decisions, memory diffs, and memory files are
never changed optimistically; they update only after the backend confirms the
decision.

`New` completes an active run before clearing its transcript, preserving unsent
composer text. Completed or failed runs clear without another backend write.
Pending approvals and in-flight work disable New. The next submitted message
creates the replacement run.

The backend is the stale-state safety net: creating a run completes any prior
active run in the same transaction and records its supersession reason. It
refuses creation with `409 Conflict` while a run is waiting for approval, and a
database constraint prevents concurrent requests from leaving multiple open
runs. Leaving the route does not attempt an unload-time completion request;
those requests are unreliable and can race in-flight work. The next submitted
message atomically completes the abandoned active run before creating its
replacement. Switching files, Manual mode, or Uploads does not end the mounted
workspace session.

The pending-episode count appears at the right edge of the explorer's virtual
`Episodes` row and on the `Process episodes` action. Selecting that action starts
a specialized backend-owned run immediately; it never prefills or changes the
local composer and never sends client-selected episode IDs or raw notes. The
backend fixes a batch of up to 50 oldest pending episodes. While that request is
in flight, the transcript immediately projects the server-owned summary
(`Process N pending episodes.`) and assistant loader; the durable response
replaces that temporary pair without duplication. The frontend shows
only its safe task summary: batch size, processing or approval state, whether
the batch is processed, and whether another batch was pending when it started.
The composer remains disabled while the fixed batch is processing or waiting for
approval.

Episode checkboxes and the pending count refresh from authoritative backend
state. Items remain unchecked through an approval pause and become checked only
after the manager reaches terminal success and the backend finalizes the fixed
batch, whether or not any curated-memory diff was accepted. A failed run leaves
the batch pending. After successful processing, the same run remains open, the
ordinary composer becomes available, and later messages use general Memory
Manager behavior without reviewing the batch again. If more pending items exist,
`Process episodes` remains available for a new specialized batch; starting it
supersedes the current active conversation, while an unresolved approval blocks
the action. A stale no-work response refreshes the pending count without
replacing the current conversation. While an automatic run is processing, the
backend refuses the action with `409` and the toast shows its reason.

While an Anima's `MEMORIES.md` is selected, in either work mode, the Work-pane
header shows `Reflect` beside `Manual | Memory Manager` (accessible name
`Reflect on <name>'s memories`). It switches to Memory Manager and calls
`POST /v1/memory/manager/runs:reflect` with the Anima ID and the current Auto
approve consent; the backend chooses the turns. Until the server-owned
`Reflect on N turns with <name>.` exchange arrives, the transcript projects
`Reflect on turns with <name>.` and an assistant loader. Reflect has the same
locks as `Process episodes`: in-flight manager work, an unresolved run lookup
or a pending approval. If that file has a dirty Manual draft, a confirmation
first explains that the Reflection reads the saved file and that the draft and a
Reflection proposal conflict with whichever is saved second; the draft stays
open either way.

A Reflection shows a status banner built from `run.reflection` and whether the
run's approvals include an applied (approved, not undone) change. While open it
reads, for example, `Reflecting on 12 turns with Annie · 3 more remain` and notes
that the turns count as reflected only once a change from that Reflection is
applied; a completed run reads `Reflected on 12 turns with Annie`. Its composer
stays available, so follow-up messages refine the proposal as in any other
conversation. A refused start (`409` for no new turns, a pending approval, a
missing `MEMORIES.md` or a concurrent run; `404` for a deleted Anima) creates no
run: the current transcript stays, a `Reflection did not start.` toast shows the
backend reason, and the manager and Anima-folder queries refresh. The folders
then show any repair state; a pending approval from another run is recovered
only when no conversation is shown, so an open conversation stays in place until
the owner selects New. If the manager becomes busy or gains a pending approval
while the unsaved-draft confirmation is open, `Reflect anyway` closes it and the
same toast explains why nothing started.

A Reflection run can fail at start (for example, when the Memory Manager model
is unavailable) or after an owner decision. With no applied change, its banner
says the Reflection stopped with `MEMORIES.md` and those turns unchanged. An
approval commits the file and the turns' coverage before the manager resumes,
so if the run fails afterward the banner instead says the applied change stands
and the turns count as reflected. In both cases the run error explains why it
stopped.

Every diff approval, in general, episode-processing and Reflection runs, offers
Approve, plain Reject, and an optional Request changes interaction. Request
changes rejects the current diff with trimmed feedback for the manager to use
when resuming; decided cards display persisted feedback for audit. Rejection
does not itself imply that an episode is unworthy of memory, and the specialized
run may propose a revised diff or complete the review without writing.

General Memory Manager runs can propose changes to an Anima's identity when the
request is about that Anima, and to its `MEMORIES.md` when the owner asks; a
Reflection changes only its own Anima's `MEMORIES.md`. Approval cards label
these targets with the current workspace path (`Animas/<name>/IDENTITY.md` or
`Animas/<name>/MEMORIES.md`) instead of the model-facing
`animas/<anima_id>/...` path. Approving, auto-approving or undoing an identity
change refreshes that Anima's definition views; a `MEMORIES.md` change refreshes
only the memory-entry queries, including the Anima folders, so Manual and
Preview show the new Version and a dirty draft becomes conflicted. Approving a
Reflection proposal returns `409` when the file or the Anima's Reflection
coverage changed after the Reflection started; the approval stays pending and
the error toast shows the backend reason. Episode processing never proposes
changes to Anima files.

Approval previews show Markdown content changes and description changes as two
separate channels. The Description section appears only when the value changes
and labels exact Before/After values, including “No description” for set and
clear operations. A description-only proposal says “No content changes.” The
native Apply Patch synthetic header is model-only and never appears in the
approval UI, Manual editor, or version content.

An approved card shows `Undo` only while the backend projects `can_undo=true`.
Eligibility requires that approval to remain the latest approved patch for its
target, no approval to be pending in the run, and the live editable target to
remain exactly at the Version committed by the approval. Ineligible cards have
no disabled placeholder. Undo is not optimistic; after success, the original
decision remains visible as `Approved · Undone` and memory, entry, path, and
version-history caches refresh. A `409 Conflict` refetches authoritative state
and directs the user to Versions for historical recovery.

`Auto approve` is off by default and captures consent at submission time for
ordinary messages, episode processing and Reflections; enabling it does not
approve an existing pending diff. The frontend sends that consent as
`auto_approve_diffs` and does not issue automatic approval requests itself. The
backend attributes newly generated diffs to the submitted message, approves them
one at a time through the durable approval service, and resumes the manager
until the chain completes or stops on an error or eight-decision limit. Any
remaining diff stays available for manual review. Starting New resets Auto
approve to off.
The manager does not inherit main chat's model selector, uploads, dictation,
voice mode, SSE streaming, TTS playback, avatar reactions, or Anima-scoped chat
session controller.

## Anima Identity

Anima management pages read the anima-scoped `IDENTITY.md` entry and open the
memory editor from `/animas/:animaId/identity`; the Memory workspace edits the
same entry and version history. This surface intentionally
retains `MemoryEntryEditorModal`. Its editable branch composes the shared
CodeMirror editor and sanitized GFM preview. It keeps both the memory version
and Anima aggregate revision from the loaded baseline. A concurrent name,
Avatar, loadout, or identity edit can conflict; dirty drafts remain open with
their original guards for explicit resolution. Revert sends both current
guards and creates a new identity version rather than replacing history.

The backend enforces nonblank identity and prevents renaming, moving, deleting,
or kind changes for the required identity file, including untyped
legacy `IDENTITY.md` entries. `MEMORIES.md` has the same protection, may be
blank and is limited to 16 KiB; nothing else can be created in or moved into an
Anima's scope. Chat never uses a mutable Avatar fallback for a missing identity.
Legacy repair state requires explicit owner repair; a directory obstructing the
reserved path can be explicitly moved first.

Backend direct chat can generate user-scope episodic logs after completed
non-incognito turns with notable `remember` text. Model-authored memory
(`remember`, chat memory tools and Memory Manager) keeps secrets and specific
health, self-harm and crisis details out of memory unless the user asks; see
[memory](../../backend/features/memory.md). These files are generated
projections of backend episode rows and cannot be changed by users or ordinary
chat memory write tools.

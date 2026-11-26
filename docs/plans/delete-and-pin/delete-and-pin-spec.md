# Delete and pin chats and Animas, and delete Local content from the Library

Status: Agreed
Owner decision: Agreed in conversation on 2026-11-26 (scope and every
decision marked "owner, 2026-11-26").

## Problem and intended users

The person using Animama cannot delete a chat or an Anima from the app, and
cannot delete most of their own Local content. The backend routes exist
(`DELETE /v1/chats/{chat_id}`, `DELETE /v1/animas/{anima_id}`,
`DELETE /v1/content/items/{item_id}`), but the web app never calls the first
two. Library cards offer no delete, even for Local items.

The delete actions that do exist are inconsistent:

- Local Poses can be deleted only from the Pose editor's Load popover, after a
  native browser confirm.
- Owned Sound Effects use an inline confirm inside their Manage dialog.
- Voice clones use their own dialog.
- Chat uploads delete with no confirm.

The sidebar lists Animas and chats with no way to keep favourites in reach.

The backend paths also have gaps that a delete UI would expose:

- Deleting a chat leaves its pending memory episodes. Their text is still
  processed into memory later.
- Deleting an Anima leaves the images in its chats. ADR 0038 D13 accepted this
  only because the database cascade skips chat-image cleanup. It was never
  chosen for product reasons.
- Deleting Local content cannot say what is using an item. Deleting an Avatar
  leaves its portrait item behind. A file changed on disk just before the delete
  produces a 500.

Intended users: the installation owner, on desktop and the local web app.

## Goals, scope and non-goals

In scope:

1. A row menu for chats and Animas in the sidebar, with **Pin** / **Unpin**
   and **Delete**, plus **Delete** on the Anima's own page.
2. Chat and Anima deletion that also removes their pending memory episodes, and
   for an Anima, the chat images only its chats use.
3. One Library **Delete** action for every kind of Local content, with one
   confirm and in-use pattern. Existing per-kind delete entry points either
   reuse it or are removed.

Non-goals (separate follow-ups):

- Uninstalling an imported pack as a unit.
- Renaming chats.
- Bulk delete.
- Undo or trash.
- Changing what memory delete does, or the wording of its confirm dialog.
- Confirming chat-upload deletes.
- Animama Cloud. It will not adopt these changes (owner, 2026-11-26), so the
  work does not need hosted-composition support or Cloud obligations.

## Required behavior

### Sidebar row menu and pins

- **R1** Each chat row and each Anima row in the expanded sidebar has a row
  menu. It opens from a "More" button shown on hover and keyboard focus, and
  from right-click. Its items are **Pin** (or **Unpin**) and **Delete**.
  The menu is reachable and operable with the keyboard, and has accessible
  names.
- **R2** Pinned items appear first in their own list:
  - Pinned Animas sort above unpinned Animas, whatever sort is selected.
  - Pinned chats sort above unpinned chats, within the current Anima filter.
  - Within the pinned group, the list's normal order applies.
  - A pinned row shows a pin indicator.
  - There is no limit on the number of pins.
- **R3** Pins persist on the server for the installation owner, survive reloads
  and restarts, and appear in every window. Deleting an item removes its pin.
  How pins are stored is a plan decision. A schema change needs a forward
  Alembic revision (ADR 0035).
- **R4** The collapsed sidebar rail lists Animas in the same order as R2.

### Deleting a chat

- **R5** **Delete** on a chat row opens a confirm dialog. The dialog:
  - names the chat;
  - says its messages and the images only this chat uses are deleted;
  - says memories already saved from it are kept.
- **R6** Confirming deletes the chat, its messages and the images only it uses
  (existing behavior), plus the chat's **pending** memory episode items.
  - Episode items already processed, episode logs, memory files and Anima
    memories are kept (owner, 2026-11-26).
  - An episode item whose processing is running when the chat is deleted is
    not written into memory afterwards.
- **R7** After a successful delete:
  - The chat leaves the sidebar and search results.
  - If the deleted chat was open, the app opens a new chat with the same
    Anima.
  - A success toast is shown.
  - A failure keeps the dialog open and shows the reason.
- **R8** If a reply is streaming in the chat, confirming the delete first stops
  the reply, then deletes the chat (owner, 2026-11-26). No message is saved to
  the deleted chat afterwards, and no server error is logged.

### Deleting an Anima

- **R9** **Delete** on an Anima row, or on the Anima's own page
  (`/animas/{anima_id}`), opens the same plain confirm dialog. The dialog:
  - names the Anima;
  - states the number of chats;
  - says its chats, messages, Anima memory files (IDENTITY.md, MEMORIES.md)
    and the images only its chats use are deleted;
  - says shared memories and Library content are kept.
- **R10** Confirming deletes:
  - the Anima and everything that already cascades with it;
  - its pending episode items;
  - the chat images referenced only by its chats, using the same rule as chat
    delete.

  This reverses ADR 0038 D13. The ADR is amended or superseded in the same
  change. Episode items already processed and the user-scope episode logs are
  kept, consistent with R6.
- **R11** After a successful delete:
  - The Anima leaves the sidebar, the rail and the Animas page.
  - If it was open, the app opens the next Anima in sidebar order. If no Anima
    remains, it shows the existing empty-roster screen.
  - The last-active Anima setting no longer points at it.
  - A deleted starter Anima is not recreated (existing tombstone behavior).
- **R12** If a reply is streaming with that Anima, confirming stops the reply,
  then deletes the Anima, as in R8.

### Deleting Local content from the Library

- **R13** Every Local item in the Library has a **Delete** action, in the card's
  menu and in list view. This covers every kind: Avatar, Gesture, Reaction,
  Pose, Avatar/Particle/Scene Effect, Sound Effect, voice clone, Appearance and
  Anima items. Included content shows no Delete.
- **R14** Delete opens one shared confirm dialog. The dialog:
  - names the item and its kind;
  - says the item's Local files are removed;
  - offers no undo.

  Existing delete entry points use this same dialog or are removed:
  - the Pose editor Load popover;
  - the Sound Manage dialog;
  - voice clone delete.
- **R15** An item that is in use cannot be deleted. The dialog says what uses
  it, by name, and how to free it. Uses include:
  - an Anima's Avatar or Appearance;
  - a loadout or Reaction cell;
  - a voice selection;
  - other content that depends on it.

  When it is known before confirming, the delete button is disabled. The
  backend's in-use refusal therefore returns the referencing items.
- **R16** Deleting a Local Avatar also deletes the portrait Appearance item
  generated for it, unless something else uses that item.
- **R17** If an item changed since it was shown (a revision conflict, or a
  file changed on disk), the delete is refused with "This item changed. Review
  it and try again." The view then refreshes, and a retry acts on the current
  revision. A file changed on disk never produces a 500.
- **R18** After a successful delete:
  - The item leaves every Library view and picker.
  - An open editor for that item keeps any unsaved draft as unsaved work, with
    no load error.
  - A success toast is shown.

## Constraints

- **Ownership and safety.** Every route keeps its owner scoping. Included and
  installation-shared content stays read-only. No destructive action runs
  without a confirm.
- **Persistence.** Schema changes use a new Alembic revision. Merged migrations
  are never edited.
- **API.** API changes regenerate the frontend client offline. Cloud will not
  adopt these changes, so no hosted-composition work is required.
- **Localization.** New strings go through i18n in every shipped locale (see
  the i18n guide).
- **Accessibility.**
  - Row menus and dialogs work with the keyboard and a screen reader.
  - Focus returns to a sensible place after a delete.
- **Layout.** Desktop viewport first; narrower layouts must not regress.

## Acceptance criteria

- [ ] **Pins:** pinning or unpinning a chat and an Anima reorders the sidebar
  and rail as R2 describes, and survives a reload and a restart. Evidence:
  frontend tests and a manual check on a task stack.
- [ ] **Chat delete:** deleting the open chat with pending episodes lands on a
  new chat with the same Anima. Afterwards the chat, its messages, its
  chat-only images and its pending episodes are gone, and processed memories
  remain. Evidence: backend tests, browser check, database read-back.
- [ ] **Anima delete:**
  - it works from both the sidebar row menu and the Anima's page;
  - its chat-only images and pending episodes are gone, and an image also used
    by another Anima's chat stays;
  - the app moves to the next Anima, or to the empty roster;
  - the last-active setting is cleared.

  Evidence: backend tests, browser check.
- [ ] **Delete during a reply:** deleting a chat or Anima while a reply streams
  stops the reply and then deletes, with no server error in the logs.
  Evidence: backend test and manual check.
- [ ] **Library delete:** Delete appears on every Local kind and on no Included
  item. One dialog is used everywhere, and the old entry points are removed or
  reuse it. Evidence: frontend tests and a browser walk-through of each kind.
- [ ] **In use:** an in-use item names what uses it and cannot be deleted.
  Evidence: backend and frontend tests.
- [ ] **Avatar portrait:** deleting a Local Avatar removes its unused portrait
  item. Evidence: backend test.
- [ ] **Changed item:** a delete refused for a changed item refreshes, and the
  retry succeeds. A file changed on disk gives 409, not 500. Evidence: backend
  and frontend tests.
- [ ] **Docs and ADR:**
  - docs are updated (data model, user files, memory, content, frontend
    sidebar);
  - ADR 0038 is amended for D13.

## Open questions and decisions

- Agreed (owner, 2026-11-26): delete for chats and Animas lives in the sidebar
  row menu, beside a new **Pin** / **Unpin**. Anima delete is also on the
  Anima's own page.
- Agreed (owner, 2026-11-26): chat delete removes pending episodes and keeps
  everything else.
- Agreed (owner, 2026-11-26): Library Delete for all Local content, as one
  consistent action.
- Agreed (owner, 2026-11-26): Anima delete removes the images only its chats
  use and its pending episodes, and keeps processed episodes and episode logs,
  matching the chat rule. This reverses D13, whose only reasons were the
  cascade skipping cleanup and the cost to Cloud, which will not adopt this.
- Agreed (owner, 2026-11-26): every delete uses a plain confirm; Anima delete
  has no typed-name step.
- Agreed (owner, 2026-11-26): deleting during a streaming reply stops the
  reply, then deletes.
- Agreed (owner, 2026-11-26): the menu items read **Pin** and **Unpin**. "Pin"
  already names model asset revisions in the glossary, so code and docs call
  this a "sidebar pin".

## Spec

Published as https://github.com/raymond-van/animama/issues/950, which is
authoritative. This file is a snapshot captured from the issue at
2026-11-26T20:44:28Z.

## ExecPlan

Required. The work spans schema (pins), shared routes, memory and content
deletion, and several UI surfaces. It will be planned after this spec is agreed.

## Delivery links

None yet.

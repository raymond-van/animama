# Delete and pin chats and Animas, and delete Local content from the Library

Source agreement: [issue #950](https://github.com/raymond-van/animama/issues/950)
(spec snapshot [delete-and-pin-spec.md](delete-and-pin-spec.md), captured
2026-11-26T20:44:28Z). Requirement IDs R1–R18 refer to that issue.

Authorized scope: Phases 1–5 (owner approval, 2026-11-26). Gates G1 and G2
remain.

## Workspace

- Checkout: the task worktree for branch `feat/delete-and-pin`, based on
  `origin/main` `0703ca137`.
- Commits so far: `92c4fa75e` (spec snapshot) and `2d0339df8` (this plan,
  reviewed revision). The branch is pushed; there is no PR yet.
- Parent issue: #950. No phase issues: one session and one repository.
- Environment: Python 3.12 venv with the documented extras and `pnpm install`
  are done; packages are built for web tests. The task stack (`./reset.sh
  --name delflows --base-port 8300 --host localhost`, http://localhost:8300) is
  down with its data kept. Start it only for browser checks.

## Purpose and context

The owner gets four things:

- Pin and Delete for chats and Animas in the sidebar.
- Delete on the Anima's own page.
- Deletes that leave no pending episode text and no chat-only images behind.
- One Library Delete action for every kind of Local content.

Cloud will not adopt this work (owner, 2026-11-26). Shared `product_http` code
must still keep its import boundary: no `local/` or `server/` imports. Nothing
needs to work in a hosted composition.

Starting source: `main` at `0703ca137` (merge of #948), plus the spec snapshot
commit on branch `feat/delete-and-pin`.

Relevant code:

| Area | Where |
|---|---|
| Chat routes | `src/backend/animama/product_http/routes/chats.py`: `DELETE /v1/chats/{chat_id}` already deletes chat-only images through `image_file_ids_only_in_chat` and `_delete_chat_images`; `PATCH /v1/chats/{chat_id}` updates title and metadata. |
| Anima routes | `product_http/routes/animas.py`: `PATCH /v1/animas/{anima_id}` fences definition edits with `expected_aggregate_revision`; `DELETE` runs `AnimaService.delete` → `anima_repo.delete` (cascade plus Anima-scoped memory purge). |
| Chat turns | `product_http/chat/stream.py` and `routes/chat_turns.py`. A client disconnect cancels the turn's tasks, but a reply save that has started finishes. `server/product_ports.py::LocalChatTurnLease` admits every turn and holds no per-chat lock. |
| Episodes | `memory_episode_items` (`status` pending/processed, `source_chat_id`, `source_anima_id`, no FK). `app/services/memory_episode_service.py` renders each day's episode log from its items. `app/services/memory_manager_service.py` selects a batch into a run's `task_state` and marks it processed in `_finalize_episode_processing_run`; that step raises when an item is missing. |
| Content delete | `app/services/content_catalog_service.py::_delete_item`, `adapters/repositories/sqlalchemy/content_catalog_repo.py::item_has_runtime_references` (returns a bool), `adapters/content_store/filesystem_store.py::delete_entry` (raises `ContentIntegrityError` on drift, which is unmapped and becomes a 500), `product_http/routes/content.py::raise_content_mutation`. Avatar portraits link to their Avatar only through `metadata.presentation.avatar_item_id`. |
| Sidebar | `src/frontend/web/src/ui/sidebar/SidebarAnimas.tsx` (sort menu: recent, name ascending, name descending), `SidebarChats.tsx` (Anima filter), `Sidebar.tsx`, and the collapsed rail. |
| Anima page | `src/frontend/web/src/routes/_app/animas/$animaId.tsx` (`AnimaDetailsRoute`). |
| Library | `src/frontend/web/src/ui/library/LibraryContentInventory.tsx` (`ProductRow` cards with preview and manage buttons; `origin: "owned" \| "builtin"`). |
| Existing deletes to unify | Pose editor Load popover (`ui/pose-creator/PoseCreatorLibrarySection.tsx`, native confirm); `ui/library/LibrarySoundDialog.tsx` (inline confirm); `ui/animas/VoiceCloneLibrary.tsx` (dialog); shared `lib/content/catalogApi.ts::deleteCatalogItem`. |
| Chat stop | `packages/product-ui/src/chat/useProductChatSession.ts` (`stop`). Query keys: `queryKeys.chats.*`, `queryKeys.animas.*`. |

## Progress

- [x] Plan review and owner approval (gate G0): approved 2026-11-26, with D1–D5.
- [x] Phase 1: chat and Anima deletion semantics (backend). Review passed after 1 repair round. Owner question Q1 is open for G2.
- [x] Phase 2: sidebar pins (backend, schema and API). Review passed after 1 repair round.
- [x] Phase 3: Local content delete hardening (backend). Review passed after 1 repair round. The contracts bump is deferred to D6.
- [ ] Phase 4: sidebar row menu, Anima page delete and dialogs (frontend).
- [ ] Phase 5: Library Delete action (frontend).
- [ ] Final integration review, full pre-push suite and full browser journeys
  (gate G1).
- [ ] Owner manual acceptance on a task stack (gate G2).

## Surprises & Discoveries

- 2026-11-26 (planning): a reply save that has started survives a client
  disconnect (`stream.py`). A delete during a reply could therefore race a
  message insert into a deleted chat, which is an FK error. The server must stop
  and await the chat's active turns before deleting (R8, R12).
- 2026-11-26 (planning): `_finalize_episode_processing_run` raises
  `MemoryEpisodeNotFoundError` when any batch item is gone. Deleting pending
  items would strand an in-flight episode-processing run unless delete also
  ends that run.
- 2026-11-26 (planning): a day's episode log is a projection of that day's
  episode items. Removing pending items and refreshing their days removes their
  lines from the log.
- 2026-11-26 (planning): `item_has_runtime_references` returns only a bool, so
  the 409 for an in-use item cannot yet say what uses it (R15).

- 2026-11-26 (Phase 1):
  - A delete can wait on an episode-processing run's row lock while that run's
    model request is in flight, possibly tens of seconds.
  - Each episode-log refresh adds a memory-entry version, so the log's
    version history still holds removed pending lines. They are readable
    through the versions API (see open question Q1).
  - Rare deadlocks are possible between a delete and a simultaneous "Process
    episodes" or approval, because their lock orders differ. Postgres aborts
    one side, and a failed delete changes nothing.

- 2026-11-26 (Phase 2):
  - The generated Zod `z.iso.datetime()` rejects the server's timezone-less
    timestamps (`pinned_at`, like `created_at` already). Frontend callers pass
    `responseValidator: undefined`, as existing chat and Anima calls do.
  - `origin/main` moved to `0eb0520ef` (PR #936; generated-SDK descriptions
    only, no migration). Merge it before the PR and regenerate the SDK rather
    than hand-merging generated files.

## Decision Log

- 2026-11-26, owner: scope, Pin/Unpin wording, delete on the Anima page, stop
  then delete during a reply, a plain confirm for everything, chat delete
  removes pending episodes only, Anima delete removes its chat-only images and
  pending episodes, no Cloud work. Source: issue #950.
- 2026-11-26, owner: approved this plan, including D1–D5 below, and authorized
  Phases 1–5.
- 2026-11-26, agent (accepted by the owner with the plan):
  - **D1.** Removing a pending episode item also removes its line from the
    generated episode log, because the log is rendered from items. Processed
    items' lines stay. This is how "pending episodes removed, keep everything
    else" plays out in the log.
  - **D2.** If a deleted chat's or Anima's pending items belong to an
    episode-processing run that is still active or waiting for approval, the
    run ends as `failed` with "Its source chat was deleted", and its pending
    approvals are rejected. Its other items return to the pending pool for a
    later run. Changes the run already applied stay, because they were written
    before the delete.
  - **D3.** Pins are nullable `pinned_at` timestamps on `chats` and `anima`,
    set through the existing PATCH routes with `pinned: true|false`. For the
    Anima route, `pinned` is runtime state, not a definition edit, so it needs
    no aggregate revision. Deleting a row deletes its pin.
  - **D4.** Delete during a reply: the client calls `stop()` first. The server
    then cancels and awaits any active turn for the chat, or for every chat of
    the Anima, before deleting. It does so through an app-scoped active-turn
    registry that `product_http` owns. A turn that does not stop within 10 s
    returns 409 `chat_turn_stopping` (retryable), and nothing is deleted.
  - **D5.** The in-use 409 for content adds
    `used_by: [{kind, id, name}]`, listing the referencing Anima bindings or
    Avatar and dependent items, capped at 10. A drifted file maps to 409
    `catalog_item_changed`.

- 2026-11-26, agent (implementation, within the approved scope):
  - **D6.** Phases 2 and 3 both change the local OpenAPI and the generated
    SDK. One `build(contracts)` commit, right after Phase 2 and before
    Phase 4, bumps the `local-http` major in `contracts/versions.json`, the
    `runtime-contracts` version in its `package.json`, and `product-ui`'s
    version if its declarations change. The same commit updates
    `contracts/hosted-web.md` and `docs/frontend/desktop/releases.md`. The
    final integration review confirms it landed. This follows the package-set rules.
    Each phase commit carries its own regenerated SDK.

- Open question Q1 (owner, before G2): when a delete removes pending
  episode lines from a log, should the log's earlier versions that still
  contain them be purged too? Today they are kept (Phase 1, P1-F3).

## Phased implementation

### Phase 1: chat and Anima deletion semantics

Review tier: high risk (data deletion, privacy, concurrency).

Requirements: R6, R8 (server part), R10, R11 (server part), R12 (server part).

Depends on: G0.

Changes:

1. **Active-turn registry** (`product_http/chat/`). The stream registers each
   running turn under its chat and Anima ids and unregisters it when it
   settles. `stop_turns(chat_ids=…)` / `stop_turns(anima_id=…)` cancels them
   and awaits completion, with a 10 s bound (D4). It is app-scoped and created
   lazily on `app.state`; it needs no new port and stays inside the import
   boundary.
2. **Chat delete** (`routes/chats.py` and the services). In this order:
   1. stop the chat's turns;
   2. read its chat-only images (existing);
   3. delete the chat;
   4. delete its pending episode items;
   5. end any episode run that holds them (D2);
   6. refresh the affected episode-log days (D1);
   7. commit;
   8. delete the images as today.
3. **Anima delete** (`routes/animas.py`, `anima_repo.delete`):
   1. stop the Anima's turns;
   2. collect images referenced only by this Anima's chats. This needs a new
      repository query mirroring `image_file_ids_only_in_chat` across the
      Anima's chats.
   3. delete pending items with `source_anima_id` or any of its chat ids, end
      the runs that hold them, and refresh the log days;
   4. clear `user_settings.last_active_anima_id` when it points at the Anima;
   5. delete as today;
   6. after the commit, delete the images with the same per-image commit as
      chat delete.
4. **Episode repository and services.** Add `delete_pending_items(…)` returning
   the removed items. Make `_finalize_episode_processing_run` tolerate a run
   that D2 already ended.
5. **Docs.**
   - `docs/backend/features/user-files.md`: the deletion rules.
   - `docs/backend/features/memory.md`: what chat and Anima delete remove.
   - `docs/backend/architecture/data-model.md` if relevant.
   - Amend ADR 0038 Consequences for D13 with a dated note.

Checks (repository root; heavy-slot discipline per SDLC):

- `uv run pytest -q tests/test_product_http_chats.py tests/test_anima_chat_sse.py tests/test_anima_memory_directory.py tests/test_memory_manager_*.py tests/test_user_file_*.py`
  plus the new tests;
- `uv run ruff check`, `ruff format --check` and `uv run mypy` on the touched
  files;
- `uv run --no-sync python scripts/repository-boundary/check-python-imports.py`.

New tests:

- Chat delete with pending and processed items: only pending items go; the
  log loses only their lines; processed memory stays.
- Delete while a fake turn is mid-save: no FK error and nothing saved after.
- Delete while an episode run holds the items: the run is failed and its
  approvals rejected, and other items are pending again.
- Anima delete: chat-only images go; an image shared with another Anima's chat
  stays; `last_active_anima_id` is cleared.
- The 10 s stop bound returns 409, and nothing is deleted.

Completion: all of the above pass, and the review passes.

#### Results

- **Turn registry.** `product_http/chat/active_turns.py` (`ActiveChatTurns`)
  registers a turn at admission and releases it when the turn settles. A stop
  cancels the response the way a client disconnect does and waits for an
  in-progress save, within 10 s; otherwise the delete returns 409
  `chat_turn_stopping`.
- **Pending removal.** `app/services/pending_episode_removal.py` runs before
  the row delete, in the same transaction. It:
  - removes the pending items of the chat, or of the Anima and its chats;
  - fails any episode run holding them (`source_deleted`, "Its source chat
    was deleted") and rejects its approvals;
  - refreshes the affected log days.
- **Anima images.** Anima delete also removes the images only its chats use
  (`image_file_ids_only_in_anima_chats`) and clears `last_active_anima_id`.
- **Automatic processing.** It ignores `source_deleted` runs for backoff and
  pause.
- **Shared helpers.** `routes/_deletion.py` holds the routes' shared delete
  steps.
- **Docs.** User files, memory, Memory Manager, HTTP API, chat runtime and
  data model docs are updated, and ADR 0038 is amended (D13 reversed).

#### Check record

Working directory: the worktree root.

- `timeout 900 uv run --no-sync pytest -q` over the new
  `tests/test_chat_and_anima_delete.py` plus the chats, chat SSE, chat turns,
  golden, Anima, owner scope, memory directory, Memory Manager (identities,
  reflection, core, HTTP, Anthropic), episodes, automatic processing, all
  `test_user_file_*`, shared boundary, OpenAPI export, inventory and local
  composition tests → 772 passed, 1 skipped (tree `83c3d54c8`). Every new test
  was red first.
- `uv run --no-sync ruff check`, `ruff format --check` and `mypy` on the 29
  touched files → pass. `uv run --no-sync mypy src/backend/animama tests` → no
  issues. Import boundary → 0 forbidden edges.
- Not run: the full suite, browser checks.

#### Code Review #1 Findings

Reviewed `c3aa92dbb` (Phase 1 paths), high risk. **Pass, with no blocking
findings.**

The reviewer reran the record (772 passed, 1 skipped; ruff, mypy, import
boundary and `check_source.py` all pass). It also ran probes for a stale
approval after a delete, and for a delete while the model streams and during
setup.

- **P1-F1.** The `pending_episode_removal.py` docstring claims a deadlock-free
  lock order. That is false against "Process episodes" (runs, then the batch
  lock) and against approval decide/undo (approval, then run).
- **P1-F2.** A stop requested during setup does not stop the response body.
  The model request and the reply save still happen, and the delete then
  removes them.
- **P1-F3.** Removed pending lines remain in the episode log's version history
  (owner question Q1).
- **P1-F4.** A new turn admitted for the Anima while its delete runs is not
  stopped, and could fail on the FK or leave an orphan pending item. It is
  unlikely; Phase 4 should keep the dialog modal and block sending during a
  delete.
- **P1-F5.** Test gaps: no check for "no server error logged", and no test
  for a stop during setup or while the model streams.

#### Code Review #1 Revisions

- **P1-F1: accepted.** Correct the docstring; record the deadlock as a known
  limit (Surprises). No deadlock-to-409 mapping.
- **P1-F2: accepted.** Skip starting the body when the stop came first, and add
  a test.
- **P1-F3: recorded as owner question Q1.** R6 and D1 are met as written.
- **P1-F4: accepted into Phase 4** (modal dialog, sending blocked while
  deleting). There is no server change.
- **P1-F5: accepted.** Add the log, setup-stop and streaming-stop tests.
- **Repair implementation.**
  - `stream.py` sends an empty, finished response and settles `unstarted`
    when the stop came before the body. A guard at the top of the body
    covers a stop that lands just after that check.
  - The `pending_episode_removal.py` docstring and the Memory Manager doc now
    state the real lock order.
  - `tests/test_chat_and_anima_delete.py` now has 15 tests: setup stop, stop
    as the response begins, stop during streaming, no ERROR logs, and
    same-session approval after a delete.
- **Implementer checks.** The setup-stop test was red before the fix; the
  begins-stop test was red without the guard. `timeout 900 uv run --no-sync
  pytest -q` over the delete, chat SSE, transport, chat turns, golden,
  automatic processing and Memory Manager tests → 298 passed. ruff, mypy and
  the import boundary pass.
- **Code Review #2 (repair round 1): pass.** Reviewed `a51b719fe`.
  - P1-F1, P1-F2 and P1-F5 are resolved; the extra guard is correct, with no
    lost completions or hung responses; there are no regressions.
  - The reviewer reran 777 passed, 1 skipped; ruff, mypy, the import boundary
    and its probes (6 passed).
  - Non-blocking: the immediate-cancel branch in `bind_cancel` is now only
    defensive.
  - Repair rounds used: 1 of 2.

### Phase 2: sidebar pins (backend)

Review tier: high risk (schema, API and generated client).

Requirements: R2 (data), R3.

Depends on: G0. Independent of Phase 1.

Changes:

1. Alembic revision `0003_sidebar_pins.py`, revision `sidebar_pins_20261126`,
   `down_revision` `reasoning_effort_20261112`. It adds nullable `pinned_at`
   (the same timestamp type as each table's `created_at`) to `chats` and
   `anima`, written idempotently (`ADD COLUMN IF NOT EXISTS`). The ORM changes
   in the same commit.
2. `PyChatUpdate` and `PyAnimaUpdateRequest` accept `pinned: bool`. Responses
   expose `pinned_at`. List order is unchanged; the client sorts (R2).
3. Regenerate the SDK offline (`pnpm openapi-ts` from `src/frontend`). Check
   whether product-ui or runtime-contracts declarations change; if so, bump
   their versions (see the declaration bump rule).
4. Docs: the HTTP API and data model docs.

Checks:

- `uv run pytest -q tests/test_alembic_fresh_install.py tests/test_product_http_chats.py tests/test_product_http_animas*.py`
  and the new tests;
- mypy and ruff;
- from `src/frontend`: `pnpm openapi-ts`, then `git diff --exit-code` after a
  second run (deterministic), and `pnpm check`.

Recovery: `downgrade()` drops both columns.

Completion: a fresh install and an upgraded install have the same schema, pin
and unpin round-trip, and the review passes.

#### Results

- **Migration.** `0003_sidebar_pins.py` (`sidebar_pins_20261126`) adds
  nullable `pinned_at timestamp without time zone` to `chats` and `anima`.
  The ORM, domain and mappers carry it.
- **Setting a pin.** `set_pinned` is one owner-scoped UPDATE:
  - re-pinning keeps the original time (`coalesce`);
  - `updated_at` is left unchanged, so a pinned chat keeps its place within
    the pinned group.
- **Routes.** `PATCH /v1/chats/{id}` and `PATCH /v1/animas/{id}` accept
  `pinned`, and responses expose `pinned_at`. An Anima pin needs no aggregate
  revision and never advances it.
- **SDK.** Regenerated. runtime-contracts declarations changed; product-ui's
  did not (66 `.d.ts` hashes equal).

#### Check record

Working directory: the worktree root. Tree `edf958639`.

- `timeout 900 uv run --no-sync pytest -q -n0 tests/test_alembic_fresh_install.py tests/test_product_http_chats.py tests/test_product_http_animas.py`
  → 17 passed. Red first: 5 failures for the expected reasons.
- Related sets with `pytest -n 4` → 228 + 115 + 77 passed: chats, Anima
  mapping and loadouts, delete, owner scope, inventory, composition, chat
  SSE, OpenAPI export, capabilities, wiring, creation, starters, and the
  migration and bootstrap tests.
- ruff, ruff format check and mypy (19 files, then
  `mypy src/backend/animama tests`) → pass. Import boundary → 0. 
  `check_source.py` → pass.
- `src/frontend`: `pnpm openapi-ts` (two identical runs),
  `pnpm openapi-ts:check`, `pnpm packages:build` and `pnpm check` → pass.
  `src/frontend/web`: `npx tsc -b` → pass.

#### Code Review #1 Findings

Reviewed `edf958639`, high risk. **Pass, with no blocking findings.** Reruns:
17 + 420 passed; ruff, mypy, the import boundary, `check_source.py` and
`pnpm openapi-ts:check` pass. The migration was checked by hand against the
Persistence Rules.

- **P2-F1 (non-blocking).** A pin-only Anima PATCH still ran `repo.update`,
  which can normalize `emotional_state` and metadata and so change
  `updated_at`. That contradicts the docs and the docstring.
- **P2-F2 (note).** Zod rejects naive timestamps (see Surprises).
- **P2-F3 (note).** main moved; regenerate the SDK on integration.

#### Code Review #1 Revisions

- **P2-F1: accepted.** `patch_anima` calls `repo.update` only when the
  request carries an `anima` part. Verification:
  `timeout 900 uv run --no-sync pytest -q -p no:cacheprovider -n 4 tests/test_product_http_animas.py tests/test_anima_avatar_mapping.py tests/test_product_http_owner_scope.py tests/test_anima_loadouts_api.py tests/test_product_http_anima_runtime.py tests/test_local_http_composition.py`
  → 12 passed; ruff, format check and mypy on `animas.py` → pass.
- **P2-F2 and P2-F3: recorded** (Surprises; Phase 4 brief; integration).
- **Code Review #2 (repair round 1): pass.** Reviewed `8da618fb4`.
  - P2-F1 is resolved, with no regressions; the docs' `updated_at`
    statements now hold for a pin-only request.
  - The reviewer reran 320 passed across every Anima PATCH caller and the
    Anima tests. A throwaway probe confirmed that a pin, an unpin and `{}`
    leave `updated_at`, `emotional_state` and metadata untouched. ruff, mypy
    and the import boundary pass.
  - Repair rounds used: 1 of 2.

### Phase 3: Local content delete hardening (backend)

Review tier: high risk (data deletion and API contract).

Requirements: R15 (server), R16, R17 (server).

Depends on: G0. Independent of Phases 1–2.

Changes:

1. Replace the bool `item_has_runtime_references` with a lookup that returns
   referencing descriptors: Avatar and Appearance bindings (Anima names),
   loadout and Reaction cells, voice selection, and dependent items. The 409
   becomes `{code: "catalog_item_in_use", used_by: […]}` (D5). Add a read-only
   way for the client to ask before confirming. This is either the same lookup
   on `GET /v1/content/items/{item_id}` or a `…/usage` route; choose the
   smaller in the phase and update the route inventory.
2. Deleting a Local Avatar also purges the portrait Appearance item whose
   `metadata.presentation.avatar_item_id` names it, unless something else uses
   that portrait. This happens in the same mutation journal.
3. Map `ContentIntegrityError` from `delete_entry` to 409
   `catalog_item_changed`, and trigger a Local rescan so a retry sees the
   current revision.
4. Verify that every Local kind has a revision. Record any kind whose item has
   no files (for example an Anima item) and either give it a revision or define
   its delete path.
5. Docs: `docs/backend/features/custom-animas-and-content.md` and
   `docs/frontend/architecture/local-content-runtime.md`.

Checks:

- `uv run pytest -q tests/test_product_http_content.py tests/test_content_catalog*.py tests/test_avatar_portrait*.py`
  and the new tests;
- mypy and ruff;
- if the API changed, regenerate the SDK as in Phase 2.

Completion: each in-use kind reports its users, Avatar delete removes its
unused portrait, a drifted file gives 409 and the retry succeeds, and the review
passes.

#### Results

- `GET /v1/content/items/{item_id}/usage` (in the route inventory, a read)
  answers with `{item_id, used_by}`. A refused delete returns 409
  `{code: "catalog_item_in_use", used_by}` (at most 10 entries, Anima uses
  first).
- A Local Avatar delete removes its unused portrait in the same journal.
- An edited, vanished or linked file gives 409 `catalog_item_changed` with
  the revision after a Local rescan, and a retry succeeds.
- Deviations:
  - It uses a separate `/usage` route, because the item model is shared with
    the catalog listing and its cache validator.
  - A `missing` item's delete purges only its catalog row.
  - The item and its portraits are locked in ID order.
- Every kind registers a file and so has a revision. An entry whose files are
  all unreadable has none and cannot be deleted (documented).

#### Check record

Working directory: the worktree root unless noted. Tree `c3aa92dbb` (both
phases), then the repair noted below.

- `timeout 900 uv run --no-sync pytest -q -p no:cacheprovider` on 21 content
  test paths (`tests/test_product_http_content.py`, `tests/test_content_catalog*.py`,
  `tests/test_avatar_portrait*.py`, idle/reaction pools, save service, Pocket
  voice, inventory, consumer, mutation workflows and replay, package import,
  materializer, migration recovery, import contract, Pose, package HTTP,
  mutation startup, typed APIs, store mutations) → 219 passed. Red first: 7 of
  10 new tests.
- `uv run --no-sync ruff check`, `ruff format --check` and `mypy` on the 14
  touched Python files → pass. Import boundary → 0 forbidden edges.
- `pnpm openapi-ts` (`src/frontend`) regenerated the SDK: the usage route and
  `PyContentItemUsage`/`PyContentUsage` only.
- Not run: the full suite, browser checks.

#### Code Review #1 Findings

Reviewed `c3aa92dbb` (Phase 3 paths), high risk. The reviewer reran the record
(219 passed; ruff, mypy, import boundary, `pnpm openapi-ts:check` current)
and added 13 neighbouring test files (236 passed, 1 failed).

- **P3-F1 (blocking).** `server/schemas/content.py` re-exports the contracts'
  `__all__` but did not import the two new classes. A star import raised
  `AttributeError`, and
  `tests/test_shared_product_contracts.py::test_every_server_schema_module_supports_star_import`
  failed.
- **P3-F2 (blocking).** The OpenAPI and SDK changed with no `local-http` major,
  no `runtime-contracts` bump and no recorded deferral. Package-set checks
  reject that.
- Non-blocking:
  - The boundary consumer's fake catalog still had
    `item_has_runtime_references`.
  - The delete docs did not mention 409 `catalog_revision_conflict`.
  - In a deferred-commit (hosted-style) composition the post-conflict rescan
    rolls back; Cloud will not adopt this.
  - A foreign or non-private Avatar mapping with no Anima would reach the
    RESTRICT FK. Current APIs cannot create one.
  - A `missing` entry's orphan sidecar stays on disk.
  - The portrait lookup scans the visible catalog.

#### Code Review #1 Revisions

- **P3-F1: accepted.** Added `PyContentItemUsage` and `PyContentUsage` to
  `server/schemas/content.py`.
- **P3-F2: accepted as D6.** One contracts bump commit follows Phase 2.
- **Accepted non-blocking:**
  - Renamed the consumer fake to `item_usage` returning `()`.
  - Added the stale-revision bullet to "Deleting Local content".
- **Deferred non-blocking**, recorded as known limits:
  - the hosted-style rollback (Cloud is out of scope);
  - the unreachable Avatar mapping case;
  - the orphan sidecar (it matches "never files the scan did not attribute");
  - the portrait lookup cost (comparable to the rescan that follows).
- **Verification:**
  - `timeout 900 uv run --no-sync pytest -q -p no:cacheprovider tests/test_shared_product_contracts.py tests/test_content_owner_composition.py tests/test_product_http_content.py tests/test_content_catalog_delete.py`
    → 17 passed;
  - ruff check and format check on the two edited Python files → pass.
- **Code Review #2 (repair round 1): pass.** Reviewed `c4f7eedb6`.
  - P3-F1 and P3-F2 are resolved, with no regressions. D6 is acceptable
    because package-compat compares the PR's package set with main's.
  - Reruns: 248 passed (the neighbour set plus content and delete tests); the
    star-import test passes; ruff, mypy and the import boundary pass.
  - Non-blocking: name the version files in D6 (done).
  - Repair rounds used: 1 of 2.

### Phase 4: sidebar row menu, Anima page delete and dialogs

Review tier: standard (UI behavior over Phase 1–2 contracts).

Requirements: R1, R2, R4, R5, R7, R8 (client), R9, R11, R12 (client).

Depends on: Phases 1 and 2.

Changes:

1. `SidebarRowMenu`: a "More" button shown on hover and focus, plus
   right-click and keyboard access. Items: Pin/Unpin and Delete. Add it to
   chat rows and Anima rows.
2. Ordering: pinned first in both lists and in the collapsed rail, over the
   existing sort and filter, with a pin indicator on pinned rows. The
   mutations `useSetChatPin` and `useSetAnimaPin` invalidate
   `queryKeys.chats.all` and `queryKeys.animas.*`.
3. A shared destructive confirm dialog, extracted from the memory delete
   dialog's pattern. Chat and Anima variants carry the R5/R9 copy; the Anima
   variant shows its chat count.
4. Delete flows:
   - Call `stop()` first if this chat (or any chat of this Anima) is streaming.
   - Call the delete mutation. Then invalidate the chats, animas, loadout,
     settings and memory-entry caches, and the chat search results.
   - Navigate (R7, R11): to a new chat with the same Anima, to the next Anima
     in sidebar order, or to the empty roster.
   - On failure, keep the dialog open with the reason. A 409
     `chat_turn_stopping` says to try again.
5. Delete on the Anima page (`AnimaDetailsRoute`), using the same dialog.
6. i18n: add every key in every shipped locale (follow the strings guide).

Checks (from `src/frontend`):

- `pnpm check`, `pnpm web:lint`, and `pnpm web:test` on the touched tests;
  new happy-dom tests for menu, order, dialog, navigation and stop-before-delete;
- `pnpm i18n:check`;
- a desktop browser check on a task stack (1440×900, then a narrow width).

Completion: tests pass, the browser walk-through matches R1–R12, and the
review passes.

Check record, commits, Code Review #1 Findings/Revisions: _to be filled in._

### Phase 5: Library Delete action

Review tier: standard.

Requirements: R13, R14, R15 (client), R17 (client), R18.

Depends on: Phase 3.

Changes:

1. Add a card and list-row menu with Delete, shown only on `origin: "owned"`
   items of every kind. It uses one `useDeleteContentItem` mutation, which
   refreshes the kind's queries and `content.catalog` both on success and on
   refusal.
2. One `ContentDeleteDialog` with the R14 copy. When usage is known it shows
   it and disables Delete (R15). It uses the R17 message for
   `catalog_item_changed` and revision conflicts.
3. Make the Pose Load popover, the Sound Manage dialog and voice clone delete
   open this dialog. Remove `window.confirm` and the inline confirm. Remove the
   voice trash icon on the voice in use, or have it open the dialog showing
   that use.
4. Open editors: a deleted item keeps any unsaved draft with no load error
   (R18). Extend the #948 Pose behavior to the other creators that load by
   item id.
5. i18n for all locales.

Checks:

- `pnpm check`, `pnpm web:lint`, and `pnpm web:test` on the touched tests;
- the browser tests that cover the Library and creators, per the frontend
  validation checklist;
- a browser walk-through deleting one Local item of each kind, including an
  in-use one and an Avatar with a portrait.

Completion: tests and the walk-through pass, and the review passes.

Check record, commits, Code Review #1 Findings/Revisions: _to be filled in._

## Final integration review

Covers combined acceptance R1–R18 across all five phases, reusing their
evidence. After its repairs:

- run the full pre-push suite once on the final candidate (`make check-test`,
  `pnpm verify`, `pnpm web:test:browser`, `pnpm prettier:check`);
- run the full `pnpm e2e:test` against a disposable built stack. AGENTS.md
  requires it before merging changes to Animas and content cleanup.

Gate G1: the full suite and the e2e run start only after the owner says go
(owner preference: no full suite without asking). Results go in the PR.

## Validation and acceptance

Acceptance follows the issue's checklist. Evidence is gathered per phase as
listed above, plus:

- **Database read-back on a task stack:**
  - Chat delete: the chat, its messages and its chat-only images are gone;
    `memory_episode_items` keeps only processed rows; the episode-log line for
    the removed pending item is gone.
  - Anima delete: the same, plus `last_active_anima_id` is cleared, and an
    image shared with another Anima's chat stays.
- **Gate G2:** the owner checks pin, delete and the Library Delete in the app
  before merge.

## Idempotence and recovery

- Every delete is owner-scoped and idempotent at the HTTP level. A retry after
  a partial image cleanup leaves already-deleted images `deleted` or
  `delete_pending`.
- The migration is additive with `IF NOT EXISTS`; downgrade drops the two
  columns.
- Content deletes keep the existing mutation journal and compensation.
- Stopping a turn is bounded. A timeout deletes nothing and is safe to retry.

## Outcomes & Retrospective

_To be filled in at completion._

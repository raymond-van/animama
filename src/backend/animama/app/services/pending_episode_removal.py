"""Remove the pending episodes of a chat or an Anima being deleted (issue #950, R6 and R10; D1 and D2)."""

from __future__ import annotations

from collections.abc import Collection

from animama.app.ports.memory_episode_port import MemoryEpisodeRepository
from animama.app.ports.memory_manager_port import MemoryManagerRepository
from animama.domain.memory_episode import MemoryEpisodeItem
from animama.domain.memory_manager import (
    MEMORY_MANAGER_EPISODE_TASK_STATUS_PROCESSING,
    MEMORY_MANAGER_RUN_KIND_EPISODE_PROCESSING,
    MEMORY_MANAGER_RUN_STATUS_ACTIVE,
    MEMORY_MANAGER_RUN_STATUS_WAITING_APPROVAL,
    MemoryManagerEpisodeTaskState,
    MemoryManagerRun,
)
from animama.logging import get_logger

from .memory_episode_service import MemoryEpisodeService
from .memory_manager_service import SOURCE_DELETED_COMPLETION, SOURCE_DELETED_RUN_ERROR, close_run_as_failed

_log = get_logger("app.services.pending_episode_removal")


class PendingEpisodeRemoval:
    """Deletes the pending episode items captured in chats, or from an Anima, that are being deleted.

    It works in the caller's transaction and never commits. Processed items and
    the memories written from them stay. Each removed item's line leaves its
    day's generated episode log (D1). An episode-processing run still holding a
    removed item ends as failed, with its pending proposals rejected; its other
    items stay pending for a later run, and changes it already applied stay (D2).

    It locks, in this order: the owner's batch-selection lock (no new batch takes
    these items), the row of each run holding one, the items, that run's
    approvals, then the log files. A run whose model request is in flight holds
    its row, so the delete waits for that request. The Memory Manager does not
    always lock in this order: owner-started "Process episodes" locks the open
    runs before the batch-selection lock, and deciding or undoing an approval
    locks the approval before its run. A delete that coincides with either can
    rarely deadlock; PostgreSQL then aborts one side, and a delete that fails
    this way has deleted nothing and can be retried.
    """

    def __init__(
        self,
        *,
        memory_episodes: MemoryEpisodeRepository,
        memory_manager: MemoryManagerRepository,
        episode_logs: MemoryEpisodeService,
    ) -> None:
        self._memory_episodes = memory_episodes
        self._memory_manager = memory_manager
        self._episode_logs = episode_logs

    async def remove(
        self, *, user_id: str, chat_ids: Collection[str] = (), anima_id: str | None = None
    ) -> list[MemoryEpisodeItem]:
        """Remove the owner's pending items from ``chat_ids`` or from ``anima_id`` (and its chats); return them."""

        await self._memory_episodes.lock_batch_selection(user_id=user_id)
        pending = await self._memory_episodes.list_pending_items_from_sources(
            user_id=user_id, source_chat_ids=chat_ids, source_anima_id=anima_id
        )
        if not pending:
            return []
        holders = await self._lock_runs_holding(user_id=user_id, item_ids={item.id for item in pending})
        removed = await self._memory_episodes.delete_pending_items(
            user_id=user_id, source_chat_ids=chat_ids, source_anima_id=anima_id
        )
        removed_ids = {item.id for item in removed}
        for run in holders:
            if _held_items(run) & removed_ids:
                await close_run_as_failed(
                    self._memory_manager,
                    run,
                    error=SOURCE_DELETED_RUN_ERROR,
                    completion_reason=SOURCE_DELETED_COMPLETION,
                    closed_reason=SOURCE_DELETED_COMPLETION,
                )
                _log.info("Episode run ended for a deleted source", user_id=user_id, run_id=run.id)
        for day in sorted({item.local_date for item in removed}):
            await self._episode_logs.refresh_daily_episode_file(user_id=user_id, local_date=day)
        return removed

    async def _lock_runs_holding(self, *, user_id: str, item_ids: set[str]) -> list[MemoryManagerRun]:
        """Lock the owner's open episode-processing runs whose batch holds any of ``item_ids``."""

        open_runs = [
            *await self._memory_manager.list_open_runs(user_id=user_id),
            *await self._memory_manager.list_open_automatic_runs(user_id=user_id),
        ]
        locked: list[MemoryManagerRun] = []
        for candidate in sorted((run for run in open_runs if _held_items(run) & item_ids), key=lambda run: run.id):
            run = await self._memory_manager.get_run_for_update(user_id=user_id, run_id=candidate.id)
            # The run may have finished while this waited for its lock.
            if run is not None and _held_items(run) & item_ids:
                locked.append(run)
        return locked


def _held_items(run: MemoryManagerRun) -> set[str]:
    """The item ids an open episode-processing run's batch still holds; empty for any other run."""

    if run.kind != MEMORY_MANAGER_RUN_KIND_EPISODE_PROCESSING or run.status not in (
        MEMORY_MANAGER_RUN_STATUS_ACTIVE,
        MEMORY_MANAGER_RUN_STATUS_WAITING_APPROVAL,
    ):
        return set()
    try:
        task = MemoryManagerEpisodeTaskState.from_dict(run.task_state)
    except ValueError:
        return set()
    if task.status != MEMORY_MANAGER_EPISODE_TASK_STATUS_PROCESSING:
        return set()
    return {item.episode_item_id for item in task.items}


__all__ = ["PendingEpisodeRemoval"]

"""Repository protocol for episodic memory items."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date, datetime
from typing import Protocol

from animama.domain.memory_episode import MemoryEpisodeItem


class MemoryEpisodeRepositoryConflictError(Exception):
    """Raised when storage detects an episodic-memory uniqueness conflict."""

    def __init__(self, *, constraint_name: str | None = None) -> None:
        super().__init__(constraint_name or "Memory episode repository conflict")
        self.constraint_name = constraint_name


class MemoryEpisodeRepository(Protocol):
    """Persistence operations for source-of-truth episodic memory rows."""

    async def create_item(self, item: MemoryEpisodeItem) -> MemoryEpisodeItem:
        raise NotImplementedError

    async def list_items(
        self,
        *,
        user_id: str,
        status: str | None = None,
        local_date: date | None = None,
        episode_path: str | None = None,
        before: datetime | None = None,
        item_ids: Iterable[str] | None = None,
        limit: int | None = 100,
    ) -> list[MemoryEpisodeItem]:
        raise NotImplementedError

    async def count_items(self, *, user_id: str, status: str) -> int:
        """Count the owner's items with one status."""

        raise NotImplementedError

    async def list_items_by_source_message_ids(
        self,
        *,
        user_id: str,
        source_message_ids: Iterable[str],
    ) -> list[MemoryEpisodeItem]:
        """List the owner's items captured from any of these chat messages, oldest first."""

        raise NotImplementedError

    async def list_recent_items_for_anima(
        self,
        *,
        user_id: str,
        source_anima_id: str,
        exclude_chat_id: str | None,
        since_local_date: date,
        limit: int,
    ) -> list[MemoryEpisodeItem]:
        """List the owner's newest items from one Anima on or after a local date, newest first.

        Pending and processed items both qualify; items from ``exclude_chat_id``
        (the chat being answered, whose turns are already in its history) do not.
        """

        raise NotImplementedError

    async def update_items_status(
        self,
        *,
        user_id: str,
        item_ids: Iterable[str],
        status: str,
        processed_at: datetime | None,
        processed_by_run_id: str | None,
    ) -> list[MemoryEpisodeItem]:
        raise NotImplementedError

    async def lock_batch_selection(self, *, user_id: str) -> None:
        """Serialize fixed-batch selection for one owner until the current transaction ends.

        Owner-started and automatic episode processing both take it before they check
        for each other's open runs, so two runs never select the same pending notes.
        """

        raise NotImplementedError

    async def list_pending_items_for_update(
        self,
        *,
        user_id: str,
        limit: int,
    ) -> list[MemoryEpisodeItem]:
        """Lock and return the user's oldest pending items."""

        raise NotImplementedError

    async def list_items_by_ids_for_update(
        self,
        *,
        user_id: str,
        item_ids: Iterable[str],
    ) -> list[MemoryEpisodeItem]:
        """Lock an exact owned item set for finalization."""

        raise NotImplementedError

    async def list_pending_items_from_sources(
        self,
        *,
        user_id: str,
        source_chat_ids: Iterable[str] = (),
        source_anima_id: str | None = None,
    ) -> list[MemoryEpisodeItem]:
        """List the owner's pending items captured in any of ``source_chat_ids`` or from ``source_anima_id``.

        An Anima's items include those captured in any of its chats.
        """

        raise NotImplementedError

    async def delete_pending_items(
        self,
        *,
        user_id: str,
        source_chat_ids: Iterable[str] = (),
        source_anima_id: str | None = None,
    ) -> list[MemoryEpisodeItem]:
        """Delete the pending items ``list_pending_items_from_sources`` lists for the same sources; return them."""

        raise NotImplementedError


__all__ = ["MemoryEpisodeRepository", "MemoryEpisodeRepositoryConflictError"]

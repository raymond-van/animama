"""Episodic memory item service and generated daily-file renderer."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, date, datetime
from typing import Any, NoReturn

from animama.app.ports.memory_episode_port import MemoryEpisodeRepository, MemoryEpisodeRepositoryConflictError
from animama.app.ports.uow_port import UnitOfWork
from animama.domain.memory_entry import MemoryEntry
from animama.domain.memory_episode import (
    MEMORY_EPISODE_KIND_CHAT_TURN,
    MEMORY_EPISODE_LOG_ENTRY_KIND,
    MEMORY_EPISODE_STATUS_PENDING,
    MEMORY_EPISODE_STATUS_PROCESSED,
    MEMORY_EPISODE_STATUSES,
    MemoryEpisodeItem,
    episode_path_for_date,
    new_memory_episode_item_id,
)
from animama.logging import get_logger

from .memory_entry_service import MemoryEntryNotFoundError, MemoryEntryService

MEMORY_EPISODE_TEXT_MAX_CHARS = 2000


class MemoryEpisodeError(Exception):
    """Base class for episodic-memory service errors."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class MemoryEpisodeValidationError(MemoryEpisodeError):
    """Raised when an episode item request is invalid."""


class MemoryEpisodeNotFoundError(MemoryEpisodeError):
    """Raised when one or more episode items are not found for the user."""


class MemoryEpisodeConflictError(MemoryEpisodeError):
    """Raised when an episode item would duplicate an existing capture."""


def normalize_memory_episode_text(text: str) -> str:
    """Normalize model-provided episode text into one markdown-safe list item."""

    if not isinstance(text, str):
        raise MemoryEpisodeValidationError("Episode text must be a string")
    normalized = " ".join(text.strip().split())
    if not normalized:
        raise MemoryEpisodeValidationError("Episode text is required")
    if len(normalized) > MEMORY_EPISODE_TEXT_MAX_CHARS:
        raise MemoryEpisodeValidationError("Episode text is too long")
    return normalized


def render_daily_episode_file(*, local_date: date, items: Iterable[MemoryEpisodeItem]) -> str:
    """Render one generated daily markdown file from source-of-truth rows."""

    if not isinstance(local_date, date) or isinstance(local_date, datetime):
        raise MemoryEpisodeValidationError("local_date must be a date")
    sorted_items = sorted(items, key=lambda item: (item.occurred_at, item.id))
    lines = [f"# Episodes for {local_date.isoformat()}", ""]
    for item in sorted_items:
        checkbox = " " if item.status == MEMORY_EPISODE_STATUS_PENDING else "x"
        text = normalize_memory_episode_text(item.text)
        lines.append(f"- [{checkbox}] <!-- episode:{item.id} --> {text}")
    return "\n".join(lines).rstrip() + "\n"


class MemoryEpisodeService:
    """Use-case service for episodic memory rows and generated daily files."""

    def __init__(
        self,
        *,
        memory_episodes: MemoryEpisodeRepository,
        memory_entries: MemoryEntryService,
        uow: UnitOfWork,
        commit_on_write: bool = True,
    ) -> None:
        self._memory_episodes = memory_episodes
        self._memory_entries = memory_entries
        self._uow = uow
        self._commit_on_write = commit_on_write
        self._log = get_logger("app.services.memory_episode")

    async def create_episode_item(
        self,
        *,
        user_id: str,
        text: str,
        occurred_at: datetime,
        local_date: date,
        local_timezone: str | None = None,
        source_anima_id: str | None = None,
        source_chat_id: str | None = None,
        source_run_id: str | None = None,
        source_message_id: str | None = None,
        kind: str = MEMORY_EPISODE_KIND_CHAT_TURN,
        metadata: dict[str, Any] | None = None,
    ) -> MemoryEpisodeItem:
        """Create one episode row and refresh its generated daily file."""

        try:
            self._require_aware_datetime(occurred_at, field_name="occurred_at")
            self._require_local_date(local_date)
            self._require_kind(kind)
            clean_text = normalize_memory_episode_text(text)
            episode_path = episode_path_for_date(local_date)
            item = MemoryEpisodeItem(
                id=new_memory_episode_item_id(),
                user_id=user_id,
                source_anima_id=source_anima_id,
                source_chat_id=source_chat_id,
                source_run_id=source_run_id,
                source_message_id=source_message_id,
                occurred_at=occurred_at,
                local_date=local_date,
                local_timezone=self._normalize_optional_text(local_timezone),
                episode_path=episode_path,
                kind=kind,
                text=clean_text,
                status=MEMORY_EPISODE_STATUS_PENDING,
                metadata=dict(metadata or {}),
            )
            stored = await self._memory_episodes.create_item(item)
            await self.append_item_to_daily_file(stored)
            await self._commit_if_enabled()
        except MemoryEpisodeRepositoryConflictError as exc:
            await self._raise_repository_conflict(exc)
        except Exception:
            await self._rollback_if_enabled()
            raise
        self._log.info("MemoryEpisodeService.create_episode_item.created", user_id=user_id, item_id=stored.id)
        return stored

    async def list_episode_items(
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
        """List episode items for memory-manager or service-level workflows."""

        if status is not None:
            self._require_status(status)
        if local_date is not None:
            self._require_local_date(local_date)
        if before is not None:
            self._require_aware_datetime(before, field_name="before")
        bounded_limit = None if limit is None else min(1000, max(1, int(limit)))
        return await self._memory_episodes.list_items(
            user_id=user_id,
            status=status,
            local_date=local_date,
            episode_path=episode_path,
            before=before,
            item_ids=item_ids,
            limit=bounded_limit,
        )

    async def mark_items_processed(
        self,
        *,
        user_id: str,
        item_ids: Iterable[str],
        processed_by_run_id: str | None = None,
        processed_at: datetime | None = None,
        skip_missing: bool = False,
    ) -> list[MemoryEpisodeItem]:
        """Mark episode items as reviewed by the Memory Manager.

        A missing item raises ``MemoryEpisodeNotFoundError`` unless ``skip_missing``
        is set, as it is for a batch whose source chat was deleted meanwhile.
        """

        return await self._mark_items_status(
            user_id=user_id,
            item_ids=item_ids,
            status=MEMORY_EPISODE_STATUS_PROCESSED,
            processed_by_run_id=processed_by_run_id,
            processed_at=processed_at,
            skip_missing=skip_missing,
        )

    async def lock_batch_selection(self, *, user_id: str) -> None:
        """Hold the owner's batch-selection lock until the current transaction ends."""

        await self._memory_episodes.lock_batch_selection(user_id=user_id)

    async def select_pending_batch_for_update(
        self,
        *,
        user_id: str,
        limit: int,
    ) -> list[MemoryEpisodeItem]:
        """Lock and return the oldest pending items for fixed-batch creation."""

        return await self._memory_episodes.list_pending_items_for_update(
            user_id=user_id,
            limit=min(1000, max(1, int(limit))),
        )

    async def ensure_daily_episode_file(self, *, user_id: str, local_date: date) -> MemoryEntry | None:
        """Create or update the generated daily file if the day has episode rows."""

        return await self.refresh_daily_episode_file(user_id=user_id, local_date=local_date)

    async def append_item_to_daily_file(self, item: MemoryEpisodeItem) -> MemoryEntry | None:
        """Refresh the generated daily file containing a newly stored item."""

        return await self.refresh_daily_episode_file(user_id=item.user_id, local_date=item.local_date)

    async def refresh_daily_episode_file(self, *, user_id: str, local_date: date) -> MemoryEntry | None:
        """Regenerate one daily episode markdown file from table rows.

        A day without rows gets no file. A file whose rows were all removed (with a
        deleted chat's pending notes) is kept with only its heading.
        """

        self._require_local_date(local_date)
        episode_path = episode_path_for_date(local_date)
        items = await self._memory_episodes.list_items(user_id=user_id, local_date=local_date, limit=None)
        expected_version = 0
        try:
            current = await self._memory_entries.get_entry_by_path(
                user_id=user_id,
                anima_id=None,
                path=episode_path,
            )
            expected_version = current.version
        except MemoryEntryNotFoundError:
            if not items:
                return None
        content = render_daily_episode_file(local_date=local_date, items=items)
        return await self._memory_entries.put_file_by_path(
            user_id=user_id,
            anima_id=None,
            path=episode_path,
            content=content,
            kind=MEMORY_EPISODE_LOG_ENTRY_KIND,
            description=f"Generated episodic memory log for {local_date.isoformat()}.",
            metadata={
                "source": {"type": "episodic_memory"},
                "generated": True,
                "local_date": local_date.isoformat(),
            },
            expected_version=expected_version,
            create_parents=True,
            allow_system_managed=True,
        )

    async def _mark_items_status(
        self,
        *,
        user_id: str,
        item_ids: Iterable[str],
        status: str,
        processed_by_run_id: str | None,
        processed_at: datetime | None,
        skip_missing: bool = False,
    ) -> list[MemoryEpisodeItem]:
        self._require_status(status)
        unique_ids = tuple(dict.fromkeys(item_id for item_id in item_ids if item_id))
        if not unique_ids:
            return []
        effective_processed_at = processed_at or datetime.now(UTC)
        self._require_aware_datetime(effective_processed_at, field_name="processed_at")

        try:
            existing = await self._memory_episodes.list_items_by_ids_for_update(
                user_id=user_id,
                item_ids=unique_ids,
            )
            if len(existing) != len(unique_ids) and not skip_missing:
                raise MemoryEpisodeNotFoundError("Episode item not found")
            clean_run_id = self._normalize_optional_text(processed_by_run_id)
            pending_ids: list[str] = []
            for item in existing:
                if item.status == MEMORY_EPISODE_STATUS_PENDING:
                    pending_ids.append(item.id)
                    continue
                if status == MEMORY_EPISODE_STATUS_PROCESSED and (
                    clean_run_id is None or item.processed_by_run_id == clean_run_id
                ):
                    continue
                raise MemoryEpisodeConflictError("Episode item was already processed by another run")
            changed = await self._memory_episodes.update_items_status(
                user_id=user_id,
                item_ids=pending_ids,
                status=status,
                processed_at=effective_processed_at,
                processed_by_run_id=clean_run_id,
            )
            changed_by_id = {item.id: item for item in changed}
            updated = [changed_by_id.get(item.id, item) for item in existing]
            # Refresh every fixed-batch day, including an idempotently accepted
            # same-run row, so the generated projection is authoritative after
            # recovery from any externally repaired state.
            for day in sorted({item.local_date for item in updated}):
                await self.refresh_daily_episode_file(user_id=user_id, local_date=day)
            await self._commit_if_enabled()
        except Exception:
            await self._rollback_if_enabled()
            raise
        self._log.info(
            "MemoryEpisodeService.mark_items_status.updated",
            user_id=user_id,
            status=status,
            count=len(updated),
        )
        return updated

    @staticmethod
    def _require_aware_datetime(value: datetime, *, field_name: str) -> None:
        if not isinstance(value, datetime):
            raise MemoryEpisodeValidationError(f"{field_name} must be a datetime")
        if value.tzinfo is None or value.utcoffset() is None:
            raise MemoryEpisodeValidationError(f"{field_name} must include timezone information")

    @staticmethod
    def _require_local_date(value: date) -> None:
        if not isinstance(value, date) or isinstance(value, datetime):
            raise MemoryEpisodeValidationError("local_date must be a date")

    @staticmethod
    def _require_kind(kind: str) -> None:
        if kind != MEMORY_EPISODE_KIND_CHAT_TURN:
            raise MemoryEpisodeValidationError("Episode kind is not supported")

    @staticmethod
    def _require_status(status: str) -> None:
        if status not in MEMORY_EPISODE_STATUSES:
            raise MemoryEpisodeValidationError("Episode status is not supported")

    @staticmethod
    def _normalize_optional_text(value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    async def _commit_if_enabled(self) -> None:
        if self._commit_on_write:
            await self._uow.commit()

    async def _rollback_if_enabled(self) -> None:
        if self._commit_on_write:
            await self._uow.rollback()

    async def _raise_repository_conflict(self, exc: MemoryEpisodeRepositoryConflictError) -> NoReturn:
        await self._rollback_if_enabled()
        raise MemoryEpisodeConflictError("Episode item already exists") from exc


__all__ = [
    "MEMORY_EPISODE_TEXT_MAX_CHARS",
    "MemoryEpisodeConflictError",
    "MemoryEpisodeError",
    "MemoryEpisodeNotFoundError",
    "MemoryEpisodeService",
    "MemoryEpisodeValidationError",
    "normalize_memory_episode_text",
    "render_daily_episode_file",
]

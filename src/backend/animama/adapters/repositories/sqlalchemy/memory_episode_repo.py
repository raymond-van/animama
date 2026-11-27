"""SQLAlchemy repository for episodic memory items."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date, datetime
from typing import Any

from sqlalchemy import ColumnElement, RowMapping, SQLColumnExpression, and_, delete, func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from animama.app.ports.memory_episode_port import (
    MemoryEpisodeRepository,
    MemoryEpisodeRepositoryConflictError,
)
from animama.domain.memory_episode import MEMORY_EPISODE_STATUS_PENDING, MemoryEpisodeItem
from animama.orm.chats import ORMChat
from animama.orm.memory_episode import ORMMemoryEpisodeItem

_MEMORY_EPISODE_CONFLICT_CONSTRAINTS = frozenset({"uq_memory_episode_items_chat_turn_run"})


def _constraint_name_from_integrity_error(exc: IntegrityError) -> str | None:
    candidates: list[object | None] = [exc, exc.orig]
    seen: set[int] = set()
    text_parts = [str(exc)]

    while candidates:
        candidate = candidates.pop()
        if candidate is None or id(candidate) in seen:
            continue
        seen.add(id(candidate))
        text_parts.append(str(candidate))

        for attr in ("constraint_name", "constraint"):
            value = getattr(candidate, attr, None)
            if isinstance(value, str) and value:
                if value in _MEMORY_EPISODE_CONFLICT_CONSTRAINTS:
                    return value
                text_parts.append(value)

        diag = getattr(candidate, "diag", None)
        diag_constraint = getattr(diag, "constraint_name", None)
        if isinstance(diag_constraint, str) and diag_constraint:
            if diag_constraint in _MEMORY_EPISODE_CONFLICT_CONSTRAINTS:
                return diag_constraint
            text_parts.append(diag_constraint)

        candidates.extend(
            (
                getattr(candidate, "__cause__", None),
                getattr(candidate, "__context__", None),
            )
        )

    error_text = "\n".join(text_parts)
    for constraint_name in _MEMORY_EPISODE_CONFLICT_CONSTRAINTS:
        if constraint_name in error_text:
            return constraint_name
    return None


def _memory_episode_conflict_from_integrity_error(
    exc: IntegrityError,
) -> MemoryEpisodeRepositoryConflictError | None:
    constraint_name = _constraint_name_from_integrity_error(exc)
    if constraint_name not in _MEMORY_EPISODE_CONFLICT_CONSTRAINTS:
        return None
    return MemoryEpisodeRepositoryConflictError(constraint_name=constraint_name)


class SQLAlchemyMemoryEpisodeRepository(MemoryEpisodeRepository):
    """Persist source-of-truth episodic memory rows using SQLAlchemy."""

    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    @staticmethod
    def _orm_to_domain(obj: ORMMemoryEpisodeItem) -> MemoryEpisodeItem:
        return MemoryEpisodeItem(
            id=obj.id,
            user_id=obj.user_id,
            source_anima_id=obj.source_anima_id,
            source_chat_id=obj.source_chat_id,
            source_run_id=obj.source_run_id,
            source_message_id=obj.source_message_id,
            occurred_at=obj.occurred_at,
            local_date=obj.local_date,
            local_timezone=obj.local_timezone,
            episode_path=obj.episode_path,
            kind=obj.kind,
            text=obj.text,
            status=obj.status,
            processed_at=obj.processed_at,
            processed_by_run_id=obj.processed_by_run_id,
            metadata=dict(obj.metadata_ or {}),
            created_at=obj.created_at,
            updated_at=obj.updated_at,
        )

    @staticmethod
    def _row_to_domain(row: RowMapping) -> MemoryEpisodeItem:
        return MemoryEpisodeItem(
            id=row["id"],
            user_id=row["user_id"],
            source_anima_id=row["source_anima_id"],
            source_chat_id=row["source_chat_id"],
            source_run_id=row["source_run_id"],
            source_message_id=row["source_message_id"],
            occurred_at=row["occurred_at"],
            local_date=row["local_date"],
            local_timezone=row["local_timezone"],
            episode_path=row["episode_path"],
            kind=row["kind"],
            text=row["text"],
            status=row["status"],
            processed_at=row["processed_at"],
            processed_by_run_id=row["processed_by_run_id"],
            metadata=dict(row["metadata_"] or {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _item_columns() -> tuple[SQLColumnExpression[Any], ...]:
        return (
            ORMMemoryEpisodeItem.id,
            ORMMemoryEpisodeItem.user_id,
            ORMMemoryEpisodeItem.source_anima_id,
            ORMMemoryEpisodeItem.source_chat_id,
            ORMMemoryEpisodeItem.source_run_id,
            ORMMemoryEpisodeItem.source_message_id,
            ORMMemoryEpisodeItem.occurred_at,
            ORMMemoryEpisodeItem.local_date,
            ORMMemoryEpisodeItem.local_timezone,
            ORMMemoryEpisodeItem.episode_path,
            ORMMemoryEpisodeItem.kind,
            ORMMemoryEpisodeItem.text,
            ORMMemoryEpisodeItem.status,
            ORMMemoryEpisodeItem.processed_at,
            ORMMemoryEpisodeItem.processed_by_run_id,
            ORMMemoryEpisodeItem.metadata_.label("metadata_"),
            ORMMemoryEpisodeItem.created_at,
            ORMMemoryEpisodeItem.updated_at,
        )

    async def create_item(self, item: MemoryEpisodeItem) -> MemoryEpisodeItem:
        obj = ORMMemoryEpisodeItem(
            id=item.id,
            user_id=item.user_id,
            source_anima_id=item.source_anima_id,
            source_chat_id=item.source_chat_id,
            source_run_id=item.source_run_id,
            source_message_id=item.source_message_id,
            occurred_at=item.occurred_at,
            local_date=item.local_date,
            local_timezone=item.local_timezone,
            episode_path=item.episode_path,
            kind=item.kind,
            text=item.text,
            status=item.status,
            processed_at=item.processed_at,
            processed_by_run_id=item.processed_by_run_id,
            metadata_=dict(item.metadata or {}),
        )
        self._s.add(obj)
        try:
            await self._s.flush()
        except IntegrityError as exc:
            if conflict := _memory_episode_conflict_from_integrity_error(exc):
                raise conflict from exc
            raise
        await self._s.refresh(obj)
        return self._orm_to_domain(obj)

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
        stmt = select(*self._item_columns()).where(ORMMemoryEpisodeItem.user_id == user_id)
        if status is not None:
            stmt = stmt.where(ORMMemoryEpisodeItem.status == status)
        if local_date is not None:
            stmt = stmt.where(ORMMemoryEpisodeItem.local_date == local_date)
        if episode_path is not None:
            stmt = stmt.where(ORMMemoryEpisodeItem.episode_path == episode_path)
        if before is not None:
            stmt = stmt.where(ORMMemoryEpisodeItem.occurred_at < before)
        if item_ids is not None:
            unique_ids = tuple(dict.fromkeys(item_ids))
            if not unique_ids:
                return []
            stmt = stmt.where(ORMMemoryEpisodeItem.id.in_(unique_ids))
        stmt = stmt.order_by(ORMMemoryEpisodeItem.occurred_at.asc(), ORMMemoryEpisodeItem.id.asc())
        if limit is not None:
            stmt = stmt.limit(max(1, int(limit)))
        result = await self._s.execute(stmt)
        return [self._row_to_domain(row._mapping) for row in result]

    async def count_items(self, *, user_id: str, status: str) -> int:
        stmt = select(func.count()).where(
            ORMMemoryEpisodeItem.user_id == user_id,
            ORMMemoryEpisodeItem.status == status,
        )
        return int((await self._s.execute(stmt)).scalar_one())

    async def list_items_by_source_message_ids(
        self,
        *,
        user_id: str,
        source_message_ids: Iterable[str],
    ) -> list[MemoryEpisodeItem]:
        unique_ids = tuple(dict.fromkeys(source_message_ids))
        if not unique_ids:
            return []
        stmt = (
            select(*self._item_columns())
            .where(
                ORMMemoryEpisodeItem.user_id == user_id,
                ORMMemoryEpisodeItem.source_message_id.in_(unique_ids),
            )
            .order_by(ORMMemoryEpisodeItem.occurred_at.asc(), ORMMemoryEpisodeItem.id.asc())
        )
        result = await self._s.execute(stmt)
        return [self._row_to_domain(row._mapping) for row in result]

    async def list_recent_items_for_anima(
        self,
        *,
        user_id: str,
        source_anima_id: str,
        exclude_chat_id: str | None,
        since_local_date: date,
        limit: int,
    ) -> list[MemoryEpisodeItem]:
        stmt = select(*self._item_columns()).where(
            ORMMemoryEpisodeItem.user_id == user_id,
            ORMMemoryEpisodeItem.source_anima_id == source_anima_id,
            ORMMemoryEpisodeItem.local_date >= since_local_date,
        )
        if exclude_chat_id is not None:
            # A NULL source chat is never the current chat, so keep those items.
            stmt = stmt.where(ORMMemoryEpisodeItem.source_chat_id.is_distinct_from(exclude_chat_id))
        stmt = stmt.order_by(ORMMemoryEpisodeItem.occurred_at.desc(), ORMMemoryEpisodeItem.id.desc()).limit(
            max(1, int(limit))
        )
        result = await self._s.execute(stmt)
        return [self._row_to_domain(row._mapping) for row in result]

    async def update_items_status(
        self,
        *,
        user_id: str,
        item_ids: Iterable[str],
        status: str,
        processed_at: datetime | None,
        processed_by_run_id: str | None,
    ) -> list[MemoryEpisodeItem]:
        unique_ids = tuple(dict.fromkeys(item_ids))
        if not unique_ids:
            return []
        stmt = (
            select(ORMMemoryEpisodeItem)
            .where(
                ORMMemoryEpisodeItem.user_id == user_id,
                ORMMemoryEpisodeItem.id.in_(unique_ids),
            )
            .order_by(ORMMemoryEpisodeItem.occurred_at.asc(), ORMMemoryEpisodeItem.id.asc())
            .with_for_update()
        )
        result = await self._s.execute(stmt)
        rows = list(result.scalars())
        for obj in rows:
            obj.status = status
            obj.processed_at = processed_at
            obj.processed_by_run_id = processed_by_run_id
        if rows:
            await self._s.flush()
            for obj in rows:
                await self._s.refresh(obj)
        return [self._orm_to_domain(obj) for obj in rows]

    async def lock_batch_selection(self, *, user_id: str) -> None:
        await self._s.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"memory-episode-batch:{user_id}"},
        )

    async def list_pending_items_for_update(
        self,
        *,
        user_id: str,
        limit: int,
    ) -> list[MemoryEpisodeItem]:
        stmt = (
            select(ORMMemoryEpisodeItem)
            .where(
                ORMMemoryEpisodeItem.user_id == user_id,
                ORMMemoryEpisodeItem.status == MEMORY_EPISODE_STATUS_PENDING,
            )
            .order_by(ORMMemoryEpisodeItem.occurred_at.asc(), ORMMemoryEpisodeItem.id.asc())
            .limit(max(1, int(limit)))
            .with_for_update()
        )
        result = await self._s.execute(stmt)
        return [self._orm_to_domain(obj) for obj in result.scalars()]

    async def list_items_by_ids_for_update(
        self,
        *,
        user_id: str,
        item_ids: Iterable[str],
    ) -> list[MemoryEpisodeItem]:
        unique_ids = tuple(dict.fromkeys(item_ids))
        if not unique_ids:
            return []
        stmt = (
            select(ORMMemoryEpisodeItem)
            .where(
                ORMMemoryEpisodeItem.user_id == user_id,
                ORMMemoryEpisodeItem.id.in_(unique_ids),
            )
            .order_by(ORMMemoryEpisodeItem.occurred_at.asc(), ORMMemoryEpisodeItem.id.asc())
            .with_for_update()
        )
        result = await self._s.execute(stmt)
        return [self._orm_to_domain(obj) for obj in result.scalars()]

    async def list_pending_items_from_sources(
        self,
        *,
        user_id: str,
        source_chat_ids: Iterable[str] = (),
        source_anima_id: str | None = None,
    ) -> list[MemoryEpisodeItem]:
        predicate = self._pending_from_sources(
            user_id=user_id, source_chat_ids=source_chat_ids, source_anima_id=source_anima_id
        )
        if predicate is None:
            return []
        stmt = (
            select(*self._item_columns())
            .where(predicate)
            .order_by(ORMMemoryEpisodeItem.occurred_at.asc(), ORMMemoryEpisodeItem.id.asc())
        )
        result = await self._s.execute(stmt)
        return [self._row_to_domain(row._mapping) for row in result]

    async def delete_pending_items(
        self,
        *,
        user_id: str,
        source_chat_ids: Iterable[str] = (),
        source_anima_id: str | None = None,
    ) -> list[MemoryEpisodeItem]:
        predicate = self._pending_from_sources(
            user_id=user_id, source_chat_ids=source_chat_ids, source_anima_id=source_anima_id
        )
        if predicate is None:
            return []
        result = await self._s.execute(delete(ORMMemoryEpisodeItem).where(predicate).returning(*self._item_columns()))
        removed = [self._row_to_domain(row._mapping) for row in result]
        return sorted(removed, key=lambda item: (item.occurred_at, item.id))

    @staticmethod
    def _pending_from_sources(
        *, user_id: str, source_chat_ids: Iterable[str], source_anima_id: str | None
    ) -> ColumnElement[bool] | None:
        """The owner's pending items from these chats or this Anima, or ``None`` when no source is named."""

        sources: list[ColumnElement[bool]] = []
        chat_ids = tuple(dict.fromkeys(source_chat_ids))
        if chat_ids:
            sources.append(ORMMemoryEpisodeItem.source_chat_id.in_(chat_ids))
        if source_anima_id is not None:
            sources.append(ORMMemoryEpisodeItem.source_anima_id == source_anima_id)
            # An item from one of the Anima's chats belongs to it even without its Anima id.
            sources.append(
                ORMMemoryEpisodeItem.source_chat_id.in_(
                    select(ORMChat.id).where(ORMChat.user_id == user_id, ORMChat.anima_id == source_anima_id)
                )
            )
        if not sources:
            return None
        return and_(
            ORMMemoryEpisodeItem.user_id == user_id,
            ORMMemoryEpisodeItem.status == MEMORY_EPISODE_STATUS_PENDING,
            or_(*sources),
        )


__all__ = ["SQLAlchemyMemoryEpisodeRepository"]

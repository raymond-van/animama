"""SQLAlchemy AnimaRepository adapter."""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import noload, selectinload

from animama.adapters.mappers.anima_map import anima_domain_to_orm, anima_orm_to_domain
from animama.app.ports import AnimaRepository
from animama.domain import Anima
from animama.domain.anima_definition import ANIMA_IDENTITY_PATH, AnimaDefinitionError, normalize_display_name
from animama.domain.emotions import normalize_emotional_state
from animama.logging import get_logger
from animama.orm.anima import ORMAnima
from animama.orm.anima_definition import ORMAnimaDefinitionRevision
from animama.orm.memory_entry import ORMMemoryEntry, ORMMemoryEntryVersion
from animama.orm.settings import ORMUserSettings

from .anima_creation_repo import SQLAlchemyAnimaCreationRepository


class SQLAlchemyAnimaRepository(AnimaRepository):
    def __init__(self, session: AsyncSession) -> None:
        self._s = session
        self.log = get_logger("sqlalchemy.anima_repo")

    async def get(self, anima_id: str) -> Anima | None:
        orm = await self._s.get(ORMAnima, anima_id)
        return anima_orm_to_domain(orm) if orm is not None else None

    async def is_owned_by_user(self, *, user_id: str, anima_id: str) -> bool:
        res = await self._s.execute(
            select(ORMAnima.id).where(ORMAnima.id == anima_id, ORMAnima.user_id == user_id).limit(1)
        )
        return res.scalar_one_or_none() is not None

    async def list_owned(self, *, user_id: str) -> list[Anima]:
        res = await self._s.execute(
            select(ORMAnima)
            .where(ORMAnima.user_id == user_id)
            .order_by(ORMAnima.created_at.asc(), ORMAnima.id.asc())
            .options(
                selectinload(ORMAnima.avatar),
                noload(ORMAnima.archive),
                noload(ORMAnima.chats),
            )
        )
        return [anima_orm_to_domain(row) for row in res.scalars()]

    async def list(self, *, ids: Iterable[str] | None = None) -> list[Anima]:
        if ids is None:
            res = await self._s.execute(select(ORMAnima))
        else:
            res = await self._s.execute(select(ORMAnima).where(ORMAnima.id.in_(list(ids))))
        return [anima_orm_to_domain(row) for row in res.scalars()]

    async def create(self, anima: Anima) -> Anima:
        payload = anima_domain_to_orm(anima)
        self._s.add(payload)
        await self._s.flush()
        await self._s.refresh(payload)
        return anima_orm_to_domain(payload)

    async def update(self, anima: Anima) -> Anima:
        orm = await self._s.get(ORMAnima, anima.id)
        if orm is None:
            return await self.create(anima)

        # Definition fields are written only by guarded definition/loadout
        # commands. A chat's stale domain snapshot must not overwrite them.
        orm.emotional_state = anima.emotional_state

        metadata = dict(anima.metadata or {})
        metadata["tags"] = list(anima.tags)
        orm.metadata_ = metadata

        await self._s.flush()
        await self._s.refresh(orm)
        return anima_orm_to_domain(orm)

    async def set_pinned(self, *, user_id: str, anima_id: str, pinned: bool) -> Anima | None:
        result = await self._s.execute(
            update(ORMAnima)
            .where(ORMAnima.id == anima_id, ORMAnima.user_id == user_id)
            .values(
                pinned_at=func.coalesce(ORMAnima.pinned_at, func.now()) if pinned else None,
                # Setting updated_at to itself suppresses its onupdate: a pin is not an edit.
                updated_at=ORMAnima.updated_at,
            )
            .returning(ORMAnima.id)
            .execution_options(synchronize_session=False)
        )
        if result.scalar_one_or_none() is None:
            return None
        orm = await self._s.get(ORMAnima, anima_id)
        assert orm is not None
        # The bulk update bypassed the identity map; reload the one value it changed.
        await self._s.refresh(orm, attribute_names=["pinned_at"])
        return anima_orm_to_domain(orm)

    async def stored_emotional_state(self, anima_id: str) -> dict[str, int] | None:
        orm = await self._s.get(ORMAnima, anima_id)
        if orm is None or orm.emotional_state is None:
            return None
        return normalize_emotional_state(orm.emotional_state)

    async def record_emotional_state(self, *, user_id: str, anima_id: str, emotional_state: dict[str, int]) -> bool:
        orm = await self._s.get(ORMAnima, anima_id)
        if orm is None or orm.user_id != user_id or normalize_emotional_state(orm.emotional_state) == emotional_state:
            return False
        orm.emotional_state = emotional_state
        return True

    async def lock_definition(self, *, user_id: str, anima_id: str, expected_revision: int | None = None) -> Anima:
        row = (
            await self._s.execute(
                select(ORMAnima)
                .where(ORMAnima.id == anima_id, ORMAnima.user_id == user_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if row is None:
            raise AnimaDefinitionError("anima_not_found")
        if expected_revision is not None and row.aggregate_revision != expected_revision:
            raise AnimaDefinitionError("anima_revision_conflict", current_revision=row.aggregate_revision)
        return anima_orm_to_domain(row)

    async def record_definition_revision(
        self,
        *,
        user_id: str,
        anima_id: str,
        expected_revision: int,
        reason: str,
        display_name: str | None = None,
        initial: bool = False,
    ) -> Anima:
        """Snapshot identity's version pointer under the common aggregate lock."""

        await self.lock_definition(user_id=user_id, anima_id=anima_id, expected_revision=expected_revision)
        row = await self._s.get(ORMAnima, anima_id)
        assert row is not None
        if initial and (
            expected_revision != 1 or (await self._s.get(ORMAnimaDefinitionRevision, (anima_id, 1))) is not None
        ):
            raise AnimaDefinitionError("anima_definition_already_initialized")
        if display_name is not None:
            row.display_name = normalize_display_name(display_name)
        identity = (
            await self._s.execute(
                select(ORMMemoryEntry).where(
                    ORMMemoryEntry.user_id == user_id,
                    ORMMemoryEntry.anima_id == anima_id,
                    ORMMemoryEntry.normalized_path == ANIMA_IDENTITY_PATH.casefold(),
                    ORMMemoryEntry.type == "file",
                    ORMMemoryEntry.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        row.identity_status = (
            "ready" if identity is not None and (identity.content or "").strip() else "repair_required"
        )
        if not initial:
            row.aggregate_revision += 1
        row.last_updated_by_id = user_id
        self._s.add(
            ORMAnimaDefinitionRevision(
                anima_id=anima_id,
                aggregate_revision=row.aggregate_revision,
                display_name=row.display_name,
                identity_entry_id=identity.id if identity else None,
                identity_version=identity.version if identity else None,
                actor_id=user_id,
                reason=reason,
            )
        )
        await self._s.flush()
        return anima_orm_to_domain(row)

    async def delete(self, anima_id: str) -> bool:
        orm = await self._s.get(ORMAnima, anima_id, with_for_update=True, populate_existing=True)
        if orm is None:
            return False
        await SQLAlchemyAnimaCreationRepository(self._s).tombstone_anima(anima_id=anima_id)
        await self._purge_anima_memory(anima_id)
        # The last-active setting has no foreign key either; it must not name a deleted Anima.
        await self._s.execute(
            update(ORMUserSettings)
            .where(ORMUserSettings.user_id == orm.user_id, ORMUserSettings.last_active_anima_id == anima_id)
            .values(last_active_anima_id=None)
        )
        await self._s.delete(orm)
        await self._s.flush()
        return True

    async def _purge_anima_memory(self, anima_id: str) -> None:
        """Permanently remove the Anima's scoped memory, including its identity.

        Memory rows have no foreign key to the Anima, so deletion must remove them
        explicitly, like the chats and loadouts that cascade from the Anima row.
        Parent links are cleared first because the tree uses a RESTRICT key.
        """

        await self._s.execute(update(ORMMemoryEntry).where(ORMMemoryEntry.anima_id == anima_id).values(parent_id=None))
        await self._s.execute(delete(ORMMemoryEntryVersion).where(ORMMemoryEntryVersion.anima_id == anima_id))
        await self._s.execute(delete(ORMMemoryEntry).where(ORMMemoryEntry.anima_id == anima_id))

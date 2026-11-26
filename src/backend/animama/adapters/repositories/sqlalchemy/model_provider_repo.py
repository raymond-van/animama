from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from animama.adapters.mappers.model_connection_map import model_connection_orm_to_domain
from animama.adapters.mappers.model_provider_map import (
    apply_model_provider_to_orm,
    model_provider_domain_to_orm,
    model_provider_orm_to_domain,
)
from animama.app.ports import ModelProviderRepository
from animama.domain import ModelProvider
from animama.domain.model_connection import (
    BUILTIN_CHATGPT_PLAN_CONNECTION_ID,
    BUILTIN_OPENAI_CONNECTION_ID,
    MODEL_SOURCE_BUILTIN,
    MODEL_SOURCE_OWNER,
)
from animama.orm import ORMModelConnection, ORMModelProvider
from animama.utils.clock import naive_utc_now


class SQLAlchemyModelProviderRepository(ModelProviderRepository):
    """SQLAlchemy-backed model-provider catalog repository.

    Returned rows carry their loaded model connection so model clients can
    resolve the endpoint and credential without another lookup.
    """

    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    async def list_active(self) -> list[ModelProvider]:
        stmt = (
            select(ORMModelProvider)
            .where(ORMModelProvider.active.is_(True))
            .order_by(ORMModelProvider.provider_label, ORMModelProvider.model_label, ORMModelProvider.id)
        )
        res = await self._s.execute(stmt)
        return await self._with_connections([model_provider_orm_to_domain(row) for row in res.scalars()])

    async def get(self, model_provider_id: str, *, for_update: bool = False) -> ModelProvider | None:
        orm = await self._s.get(
            ORMModelProvider, model_provider_id, populate_existing=True, with_for_update=for_update or None
        )
        if orm is None:
            return None
        return (await self._with_connections([model_provider_orm_to_domain(orm)]))[0]

    async def get_by_provider_model(
        self,
        provider_type: str,
        model: str,
        *,
        connection_id: str = BUILTIN_OPENAI_CONNECTION_ID,
    ) -> ModelProvider | None:
        stmt = select(ORMModelProvider).where(
            ORMModelProvider.connection_id == connection_id,
            ORMModelProvider.provider_type == provider_type,
            ORMModelProvider.model == model,
            ORMModelProvider.source == MODEL_SOURCE_BUILTIN,
        )
        res = await self._s.execute(stmt)
        orm = res.scalar_one_or_none()
        if orm is None:
            return None
        return (await self._with_connections([model_provider_orm_to_domain(orm)]))[0]

    async def list_for_connection(self, connection_id: str, *, include_inactive: bool = False) -> list[ModelProvider]:
        stmt = select(ORMModelProvider).where(ORMModelProvider.connection_id == connection_id)
        if not include_inactive:
            stmt = stmt.where(ORMModelProvider.active.is_(True))
        stmt = stmt.order_by(ORMModelProvider.model_label, ORMModelProvider.id)
        res = await self._s.execute(stmt)
        return await self._with_connections([model_provider_orm_to_domain(row) for row in res.scalars()])

    async def get_owner_row(self, connection_id: str, provider_type: str, model: str) -> ModelProvider | None:
        stmt = select(ORMModelProvider).where(
            ORMModelProvider.connection_id == connection_id,
            ORMModelProvider.provider_type == provider_type,
            ORMModelProvider.model == model,
            ORMModelProvider.source == MODEL_SOURCE_OWNER,
        )
        orm = (await self._s.execute(stmt)).scalar_one_or_none()
        if orm is None:
            return None
        return (await self._with_connections([model_provider_orm_to_domain(orm)]))[0]

    async def set_hidden(self, model_provider_id: str, *, hidden: bool) -> ModelProvider | None:
        orm = await self._s.get(ORMModelProvider, model_provider_id)
        if orm is None:
            return None
        orm.hidden = hidden
        await self._s.flush()
        await self._s.refresh(orm)
        return (await self._with_connections([model_provider_orm_to_domain(orm)]))[0]

    async def set_early_compaction(self, model_provider_id: str, *, enabled: bool) -> ModelProvider | None:
        orm = await self._s.get(ORMModelProvider, model_provider_id)
        if orm is None:
            return None
        orm.early_compaction = enabled
        await self._s.flush()
        await self._s.refresh(orm)
        return (await self._with_connections([model_provider_orm_to_domain(orm)]))[0]

    async def _with_connections(self, rows: list[ModelProvider]) -> list[ModelProvider]:
        connection_ids = {row.connection_id for row in rows}
        if not connection_ids:
            return rows
        res = await self._s.execute(select(ORMModelConnection).where(ORMModelConnection.id.in_(connection_ids)))
        connections = {orm.id: model_connection_orm_to_domain(orm) for orm in res.scalars()}
        for row in rows:
            row.connection = connections.get(row.connection_id)
        return rows

    async def upsert_many(
        self,
        model_providers: Iterable[ModelProvider],
    ) -> list[ModelProvider]:
        stored: list[ModelProvider] = []
        for model_provider in model_providers:
            orm = await self._s.get(ORMModelProvider, model_provider.id)
            if orm is None:
                orm = model_provider_domain_to_orm(model_provider)
                self._s.add(orm)
            else:
                # Hiding a built-in row and its Compact early setting are the
                # owner's choices; catalog syncs keep them.
                hidden, early_compaction = orm.hidden, orm.early_compaction
                apply_model_provider_to_orm(orm, model_provider)
                if orm.source == MODEL_SOURCE_BUILTIN:
                    orm.hidden = hidden
                    orm.early_compaction = early_compaction
            await self._s.flush()
            await self._s.refresh(orm)
            stored.append(model_provider_orm_to_domain(orm))
        return await self._with_connections(stored)

    async def soft_retire_missing(self, active_ids: Iterable[str]) -> int:
        """Retire active built-in rows absent from ``active_ids``; owner rows are kept.

        The ChatGPT plan connection's rows come from the signed-in account, not
        the catalog, so they are never retired here.
        """

        active_id_set = set(active_ids)
        stmt = select(ORMModelProvider).where(
            ORMModelProvider.active.is_(True),
            ORMModelProvider.source == MODEL_SOURCE_BUILTIN,
            ORMModelProvider.connection_id != BUILTIN_CHATGPT_PLAN_CONNECTION_ID,
        )
        if active_id_set:
            stmt = stmt.where(ORMModelProvider.id.notin_(active_id_set))
        res = await self._s.execute(stmt)
        now = naive_utc_now()
        retired = 0
        for orm in res.scalars():
            orm.active = False
            orm.deprecated_at = orm.deprecated_at or now
            retired += 1
        if retired:
            await self._s.flush()
        return retired


__all__ = ["SQLAlchemyModelProviderRepository"]

"""SQLAlchemy repository for memory-manager runs, messages, and approvals."""

from __future__ import annotations

from typing import Any

from sqlalchemy import RowMapping, SQLColumnExpression, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from animama.app.ports.memory_manager_port import (
    MemoryManagerRepository,
    MemoryManagerRepositoryConflictError,
)
from animama.domain.memory_manager import (
    MEMORY_MANAGER_EPISODE_TASK_STATUS_PROCESSED,
    MEMORY_MANAGER_RUN_KIND_EPISODE_PROCESSING,
    MEMORY_MANAGER_RUN_ORIGIN_AUTOMATIC,
    MEMORY_MANAGER_RUN_ORIGIN_KEY,
    MEMORY_MANAGER_RUN_ORIGIN_OWNER,
    MEMORY_MANAGER_RUN_STATUS_ACTIVE,
    MEMORY_MANAGER_RUN_STATUS_WAITING_APPROVAL,
    MemoryManagerApproval,
    MemoryManagerMessage,
    MemoryManagerRun,
)
from animama.orm.memory_manager import (
    ORMMemoryManagerApproval,
    ORMMemoryManagerMessage,
    ORMMemoryManagerRun,
)
from animama.utils.clock import naive_utc_now

_MEMORY_MANAGER_CONFLICT_CONSTRAINTS = frozenset(
    {"uq_memory_manager_runs_user_open", "uq_memory_manager_runs_user_open_automatic"}
)


def _constraint_name_from_integrity_error(exc: IntegrityError) -> str | None:
    """Extract a known constraint name across psycopg/asyncpg wrappers."""

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
                if value in _MEMORY_MANAGER_CONFLICT_CONSTRAINTS:
                    return value
                text_parts.append(value)

        diag = getattr(candidate, "diag", None)
        diag_constraint = getattr(diag, "constraint_name", None)
        if isinstance(diag_constraint, str) and diag_constraint:
            if diag_constraint in _MEMORY_MANAGER_CONFLICT_CONSTRAINTS:
                return diag_constraint
            text_parts.append(diag_constraint)

        candidates.extend(
            (
                getattr(candidate, "__cause__", None),
                getattr(candidate, "__context__", None),
            )
        )

    error_text = "\n".join(text_parts)
    for constraint_name in _MEMORY_MANAGER_CONFLICT_CONSTRAINTS:
        if constraint_name in error_text:
            return constraint_name
    return None


def _memory_manager_conflict_from_integrity_error(
    exc: IntegrityError,
) -> MemoryManagerRepositoryConflictError | None:
    constraint_name = _constraint_name_from_integrity_error(exc)
    if constraint_name not in _MEMORY_MANAGER_CONFLICT_CONSTRAINTS:
        return None
    return MemoryManagerRepositoryConflictError(constraint_name=constraint_name)


class SQLAlchemyMemoryManagerRepository(MemoryManagerRepository):
    """Persist memory-manager workflow rows using SQLAlchemy."""

    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    @staticmethod
    def _run_to_domain(obj: ORMMemoryManagerRun) -> MemoryManagerRun:
        return MemoryManagerRun(
            id=obj.id,
            user_id=obj.user_id,
            status=obj.status,
            kind=obj.kind,
            task_state=dict(obj.task_state) if obj.task_state is not None else None,
            model_provider=obj.model_provider,
            model_name=obj.model_name,
            model_provider_id=obj.model_provider_id,
            openai_previous_response_id=obj.openai_previous_response_id,
            serialized_agent_state=obj.serialized_agent_state,
            summary=obj.summary,
            error=obj.error,
            usage_metadata=dict(obj.usage_metadata or {}),
            metadata=dict(obj.metadata_ or {}),
            created_at=obj.created_at,
            updated_at=obj.updated_at,
            completed_at=obj.completed_at,
        )

    @staticmethod
    def _message_to_domain(obj: ORMMemoryManagerMessage) -> MemoryManagerMessage:
        return MemoryManagerMessage(
            id=obj.id,
            run_id=obj.run_id,
            user_id=obj.user_id,
            role=obj.role,
            content=obj.content,
            metadata=dict(obj.metadata_ or {}),
            created_at=obj.created_at,
        )

    @staticmethod
    def _approval_to_domain(obj: ORMMemoryManagerApproval) -> MemoryManagerApproval:
        return MemoryManagerApproval(
            id=obj.id,
            run_id=obj.run_id,
            user_id=obj.user_id,
            status=obj.status,
            operation=obj.operation,
            target_path=obj.target_path,
            target_entry_id=obj.target_entry_id,
            expected_version=obj.expected_version,
            summary=obj.summary,
            old_content=obj.old_content,
            new_content=obj.new_content,
            old_description=obj.old_description,
            new_description=obj.new_description,
            unified_diff=obj.unified_diff,
            operation_metadata=dict(obj.operation_metadata or {}),
            decision_feedback=obj.decision_feedback,
            applied_version=obj.applied_version,
            undone_at=obj.undone_at,
            undo_version=obj.undo_version,
            created_at=obj.created_at,
            updated_at=obj.updated_at,
            decided_at=obj.decided_at,
        )

    @staticmethod
    def _message_row_to_domain(row: RowMapping) -> MemoryManagerMessage:
        return MemoryManagerMessage(
            id=row["id"],
            run_id=row["run_id"],
            user_id=row["user_id"],
            role=row["role"],
            content=row["content"],
            metadata=dict(row["metadata_"] or {}),
            created_at=row["created_at"],
        )

    @staticmethod
    def _approval_row_to_domain(row: RowMapping) -> MemoryManagerApproval:
        return MemoryManagerApproval(
            id=row["id"],
            run_id=row["run_id"],
            user_id=row["user_id"],
            status=row["status"],
            operation=row["operation"],
            target_path=row["target_path"],
            target_entry_id=row["target_entry_id"],
            expected_version=row["expected_version"],
            summary=row["summary"],
            old_content=row["old_content"],
            new_content=row["new_content"],
            old_description=row["old_description"],
            new_description=row["new_description"],
            unified_diff=row["unified_diff"],
            operation_metadata=dict(row["operation_metadata"] or {}),
            decision_feedback=row["decision_feedback"],
            applied_version=row["applied_version"],
            undone_at=row["undone_at"],
            undo_version=row["undo_version"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            decided_at=row["decided_at"],
        )

    @staticmethod
    def _message_columns() -> tuple[SQLColumnExpression[Any], ...]:
        return (
            ORMMemoryManagerMessage.id,
            ORMMemoryManagerMessage.run_id,
            ORMMemoryManagerMessage.user_id,
            ORMMemoryManagerMessage.role,
            ORMMemoryManagerMessage.content,
            ORMMemoryManagerMessage.metadata_.label("metadata_"),
            ORMMemoryManagerMessage.created_at,
        )

    @staticmethod
    def _approval_columns() -> tuple[SQLColumnExpression[Any], ...]:
        return (
            ORMMemoryManagerApproval.id,
            ORMMemoryManagerApproval.run_id,
            ORMMemoryManagerApproval.user_id,
            ORMMemoryManagerApproval.status,
            ORMMemoryManagerApproval.operation,
            ORMMemoryManagerApproval.target_path,
            ORMMemoryManagerApproval.target_entry_id,
            ORMMemoryManagerApproval.expected_version,
            ORMMemoryManagerApproval.summary,
            ORMMemoryManagerApproval.old_content,
            ORMMemoryManagerApproval.new_content,
            ORMMemoryManagerApproval.old_description,
            ORMMemoryManagerApproval.new_description,
            ORMMemoryManagerApproval.unified_diff,
            ORMMemoryManagerApproval.operation_metadata,
            ORMMemoryManagerApproval.decision_feedback,
            ORMMemoryManagerApproval.applied_version,
            ORMMemoryManagerApproval.undone_at,
            ORMMemoryManagerApproval.undo_version,
            ORMMemoryManagerApproval.created_at,
            ORMMemoryManagerApproval.updated_at,
            ORMMemoryManagerApproval.decided_at,
        )

    async def create_run(self, run: MemoryManagerRun) -> MemoryManagerRun:
        obj = ORMMemoryManagerRun(
            id=run.id,
            user_id=run.user_id,
            status=run.status,
            kind=run.kind,
            task_state=dict(run.task_state) if run.task_state is not None else None,
            model_provider=run.model_provider,
            model_name=run.model_name,
            model_provider_id=run.model_provider_id,
            openai_previous_response_id=run.openai_previous_response_id,
            serialized_agent_state=run.serialized_agent_state,
            summary=run.summary,
            error=run.error,
            usage_metadata=dict(run.usage_metadata or {}),
            metadata_=dict(run.metadata or {}),
            completed_at=run.completed_at,
        )
        self._s.add(obj)
        try:
            await self._s.flush()
        except IntegrityError as exc:
            if conflict := _memory_manager_conflict_from_integrity_error(exc):
                raise conflict from exc
            raise
        await self._s.refresh(obj)
        return self._run_to_domain(obj)

    async def get_run(self, *, user_id: str, run_id: str) -> MemoryManagerRun | None:
        stmt = select(ORMMemoryManagerRun).where(
            ORMMemoryManagerRun.user_id == user_id,
            ORMMemoryManagerRun.id == run_id,
        )
        result = await self._s.execute(stmt)
        obj = result.scalar_one_or_none()
        return self._run_to_domain(obj) if obj is not None else None

    async def get_run_for_update(self, *, user_id: str, run_id: str) -> MemoryManagerRun | None:
        # Read the locked row as it is now: another transaction (a chat delete, or
        # recovery) may have closed the run since this session last loaded it.
        stmt = (
            select(ORMMemoryManagerRun)
            .where(
                ORMMemoryManagerRun.user_id == user_id,
                ORMMemoryManagerRun.id == run_id,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        result = await self._s.execute(stmt)
        obj = result.scalar_one_or_none()
        return self._run_to_domain(obj) if obj is not None else None

    async def list_open_runs(self, *, user_id: str) -> list[MemoryManagerRun]:
        return await self._list_open_runs(user_id=user_id, for_update=False, automatic=False)

    async def list_open_runs_for_update(self, *, user_id: str) -> list[MemoryManagerRun]:
        return await self._list_open_runs(user_id=user_id, for_update=True, automatic=False)

    async def list_open_automatic_runs(self, *, user_id: str, for_update: bool = False) -> list[MemoryManagerRun]:
        return await self._list_open_runs(user_id=user_id, for_update=for_update, automatic=True)

    async def list_automatic_runs(self, *, user_id: str, limit: int) -> list[MemoryManagerRun]:
        stmt = (
            select(ORMMemoryManagerRun)
            .where(
                ORMMemoryManagerRun.user_id == user_id,
                ORMMemoryManagerRun.metadata_[MEMORY_MANAGER_RUN_ORIGIN_KEY].astext
                == MEMORY_MANAGER_RUN_ORIGIN_AUTOMATIC,
            )
            .order_by(ORMMemoryManagerRun.created_at.desc(), ORMMemoryManagerRun.id.desc())
            .limit(max(1, int(limit)))
        )
        result = await self._s.execute(stmt)
        return [self._run_to_domain(obj) for obj in result.scalars()]

    async def latest_processed_owner_episode_run(self, *, user_id: str) -> MemoryManagerRun | None:
        origin = ORMMemoryManagerRun.metadata_[MEMORY_MANAGER_RUN_ORIGIN_KEY].astext
        stmt = (
            select(ORMMemoryManagerRun)
            .where(
                ORMMemoryManagerRun.user_id == user_id,
                ORMMemoryManagerRun.kind == MEMORY_MANAGER_RUN_KIND_EPISODE_PROCESSING,
                func.coalesce(origin, MEMORY_MANAGER_RUN_ORIGIN_OWNER) == MEMORY_MANAGER_RUN_ORIGIN_OWNER,
                ORMMemoryManagerRun.task_state["status"].astext == MEMORY_MANAGER_EPISODE_TASK_STATUS_PROCESSED,
            )
            .order_by(ORMMemoryManagerRun.updated_at.desc(), ORMMemoryManagerRun.id.desc())
            .limit(1)
        )
        obj = (await self._s.execute(stmt)).scalars().first()
        return self._run_to_domain(obj) if obj is not None else None

    async def _list_open_runs(self, *, user_id: str, for_update: bool, automatic: bool) -> list[MemoryManagerRun]:
        origin = ORMMemoryManagerRun.metadata_[MEMORY_MANAGER_RUN_ORIGIN_KEY].astext
        stmt = (
            select(ORMMemoryManagerRun)
            .where(
                ORMMemoryManagerRun.user_id == user_id,
                ORMMemoryManagerRun.status.in_(
                    (MEMORY_MANAGER_RUN_STATUS_ACTIVE, MEMORY_MANAGER_RUN_STATUS_WAITING_APPROVAL)
                ),
                # The same predicates as the two open-run unique indexes.
                origin == MEMORY_MANAGER_RUN_ORIGIN_AUTOMATIC
                if automatic
                else func.coalesce(origin, MEMORY_MANAGER_RUN_ORIGIN_OWNER) == MEMORY_MANAGER_RUN_ORIGIN_OWNER,
            )
            .order_by(ORMMemoryManagerRun.created_at.asc(), ORMMemoryManagerRun.id.asc())
        )
        if for_update:
            stmt = stmt.with_for_update()
        result = await self._s.execute(stmt)
        return [self._run_to_domain(obj) for obj in result.scalars()]

    async def update_run(self, run: MemoryManagerRun) -> MemoryManagerRun:
        stmt = select(ORMMemoryManagerRun).where(
            ORMMemoryManagerRun.user_id == run.user_id,
            ORMMemoryManagerRun.id == run.id,
        )
        result = await self._s.execute(stmt)
        obj = result.scalar_one()
        obj.status = run.status
        obj.kind = run.kind
        obj.task_state = dict(run.task_state) if run.task_state is not None else None
        obj.model_provider = run.model_provider
        obj.model_name = run.model_name
        obj.model_provider_id = run.model_provider_id
        obj.openai_previous_response_id = run.openai_previous_response_id
        obj.serialized_agent_state = run.serialized_agent_state
        obj.summary = run.summary
        obj.error = run.error
        obj.usage_metadata = dict(run.usage_metadata or {})
        obj.metadata_ = dict(run.metadata or {})
        obj.completed_at = run.completed_at
        await self._s.flush()
        await self._s.refresh(obj)
        return self._run_to_domain(obj)

    async def create_message(self, message: MemoryManagerMessage) -> MemoryManagerMessage:
        obj = ORMMemoryManagerMessage(
            id=message.id,
            run_id=message.run_id,
            user_id=message.user_id,
            role=message.role,
            content=message.content,
            metadata_=dict(message.metadata or {}),
            created_at=message.created_at or naive_utc_now(),
        )
        self._s.add(obj)
        await self._s.flush()
        await self._s.refresh(obj)
        return self._message_to_domain(obj)

    async def list_messages(self, *, user_id: str, run_id: str) -> list[MemoryManagerMessage]:
        stmt = (
            select(*self._message_columns())
            .where(
                ORMMemoryManagerMessage.user_id == user_id,
                ORMMemoryManagerMessage.run_id == run_id,
            )
            .order_by(ORMMemoryManagerMessage.created_at.asc(), ORMMemoryManagerMessage.id.asc())
        )
        result = await self._s.execute(stmt)
        return [self._message_row_to_domain(row._mapping) for row in result]

    async def create_approval(self, approval: MemoryManagerApproval) -> MemoryManagerApproval:
        obj = ORMMemoryManagerApproval(
            id=approval.id,
            run_id=approval.run_id,
            user_id=approval.user_id,
            status=approval.status,
            operation=approval.operation,
            target_path=approval.target_path,
            target_entry_id=approval.target_entry_id,
            expected_version=approval.expected_version,
            summary=approval.summary,
            old_content=approval.old_content,
            new_content=approval.new_content,
            old_description=approval.old_description,
            new_description=approval.new_description,
            unified_diff=approval.unified_diff,
            operation_metadata=dict(approval.operation_metadata or {}),
            decision_feedback=approval.decision_feedback,
            applied_version=approval.applied_version,
            undone_at=approval.undone_at,
            undo_version=approval.undo_version,
            decided_at=approval.decided_at,
        )
        self._s.add(obj)
        await self._s.flush()
        await self._s.refresh(obj)
        return self._approval_to_domain(obj)

    async def get_approval(self, *, user_id: str, approval_id: str) -> MemoryManagerApproval | None:
        stmt = select(ORMMemoryManagerApproval).where(
            ORMMemoryManagerApproval.user_id == user_id,
            ORMMemoryManagerApproval.id == approval_id,
        )
        result = await self._s.execute(stmt)
        obj = result.scalar_one_or_none()
        return self._approval_to_domain(obj) if obj is not None else None

    async def get_approval_for_update(
        self,
        *,
        user_id: str,
        approval_id: str,
    ) -> MemoryManagerApproval | None:
        stmt = (
            select(ORMMemoryManagerApproval)
            .where(
                ORMMemoryManagerApproval.user_id == user_id,
                ORMMemoryManagerApproval.id == approval_id,
            )
            .with_for_update()
        )
        result = await self._s.execute(stmt)
        obj = result.scalar_one_or_none()
        return self._approval_to_domain(obj) if obj is not None else None

    async def update_approval(self, approval: MemoryManagerApproval) -> MemoryManagerApproval:
        stmt = select(ORMMemoryManagerApproval).where(
            ORMMemoryManagerApproval.user_id == approval.user_id,
            ORMMemoryManagerApproval.id == approval.id,
        )
        result = await self._s.execute(stmt)
        obj = result.scalar_one()
        obj.status = approval.status
        obj.operation = approval.operation
        obj.target_path = approval.target_path
        obj.target_entry_id = approval.target_entry_id
        obj.expected_version = approval.expected_version
        obj.summary = approval.summary
        obj.old_content = approval.old_content
        obj.new_content = approval.new_content
        obj.old_description = approval.old_description
        obj.new_description = approval.new_description
        obj.unified_diff = approval.unified_diff
        obj.operation_metadata = dict(approval.operation_metadata or {})
        obj.decision_feedback = approval.decision_feedback
        obj.applied_version = approval.applied_version
        obj.undone_at = approval.undone_at
        obj.undo_version = approval.undo_version
        obj.decided_at = approval.decided_at
        await self._s.flush()
        await self._s.refresh(obj)
        return self._approval_to_domain(obj)

    async def list_approvals(self, *, user_id: str, run_id: str) -> list[MemoryManagerApproval]:
        return await self._list_approvals(user_id=user_id, run_id=run_id, for_update=False)

    async def list_approvals_for_update(
        self,
        *,
        user_id: str,
        run_id: str,
    ) -> list[MemoryManagerApproval]:
        return await self._list_approvals(user_id=user_id, run_id=run_id, for_update=True)

    async def _list_approvals(
        self,
        *,
        user_id: str,
        run_id: str,
        for_update: bool,
    ) -> list[MemoryManagerApproval]:
        stmt = (
            select(*self._approval_columns())
            .where(
                ORMMemoryManagerApproval.user_id == user_id,
                ORMMemoryManagerApproval.run_id == run_id,
            )
            .order_by(ORMMemoryManagerApproval.created_at.asc(), ORMMemoryManagerApproval.id.asc())
        )
        if for_update:
            stmt = stmt.with_for_update()
        result = await self._s.execute(stmt)
        return [self._approval_row_to_domain(row._mapping) for row in result]

    async def get_latest_approved_approval_for_entry(
        self,
        *,
        user_id: str,
        target_entry_id: str,
        for_update: bool = False,
    ) -> MemoryManagerApproval | None:
        """Return the last applied approval for an owned target entry."""

        stmt = (
            select(ORMMemoryManagerApproval)
            .where(
                ORMMemoryManagerApproval.user_id == user_id,
                ORMMemoryManagerApproval.target_entry_id == target_entry_id,
                ORMMemoryManagerApproval.status == "approved",
                ORMMemoryManagerApproval.applied_version.is_not(None),
            )
            .order_by(
                ORMMemoryManagerApproval.applied_version.desc(),
                ORMMemoryManagerApproval.decided_at.desc().nullslast(),
                ORMMemoryManagerApproval.id.desc(),
            )
            .limit(1)
        )
        if for_update:
            stmt = stmt.with_for_update()
        result = await self._s.execute(stmt)
        obj = result.scalar_one_or_none()
        return self._approval_to_domain(obj) if obj is not None else None


__all__ = ["SQLAlchemyMemoryManagerRepository"]

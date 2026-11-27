"""SQLAlchemy storage for the content assistant's conversations, messages and drafts."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from sqlalchemy import case, delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from animama.adapters.mappers.generation_map import (
    generation_conversation_orm_to_domain,
    generation_draft_orm_to_domain,
    generation_message_orm_to_domain,
)
from animama.app.ports.generation_port import GenerationCheckState, GenerationRepository
from animama.domain.generation import GenerationConversation, GenerationDraft, GenerationMessage
from animama.orm.generation import ORMGenerationConversation, ORMGenerationDraft, ORMGenerationMessage


class SQLAlchemyGenerationRepository(GenerationRepository):
    """Always filters by the owner; the caller owns the transaction.

    Sessions are short: a request's, or one step of a run. A session may
    still read a row twice while other requests' sessions write it (a
    conversation read again after its drafts were settled), so every read
    refreshes rows this session already holds instead of returning what it
    read earlier.
    """

    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    async def _conversation(
        self, *, owner_user_id: str, conversation_id: str, for_update: bool = False
    ) -> ORMGenerationConversation | None:
        statement = select(ORMGenerationConversation).where(
            ORMGenerationConversation.id == conversation_id,
            ORMGenerationConversation.owner_user_id == owner_user_id,
        )
        if for_update:
            statement = statement.with_for_update()
        return (await self._s.execute(statement.execution_options(populate_existing=True))).scalar_one_or_none()

    async def _draft(self, *, owner_user_id: str, draft_id: str, for_update: bool = False) -> ORMGenerationDraft | None:
        statement = select(ORMGenerationDraft).where(
            ORMGenerationDraft.id == draft_id,
            ORMGenerationDraft.owner_user_id == owner_user_id,
        )
        if for_update:
            statement = statement.with_for_update()
        return (await self._s.execute(statement.execution_options(populate_existing=True))).scalar_one_or_none()

    async def add_conversation(
        self, *, conversation_id: str, owner_user_id: str, scope: Mapping[str, Any]
    ) -> GenerationConversation:
        orm = ORMGenerationConversation(id=conversation_id, owner_user_id=owner_user_id, scope=dict(scope))
        self._s.add(orm)
        await self._s.flush()
        await self._s.refresh(orm)
        return generation_conversation_orm_to_domain(orm)

    async def list_conversations(self, *, owner_user_id: str) -> list[GenerationConversation]:
        statement = (
            select(ORMGenerationConversation)
            .where(ORMGenerationConversation.owner_user_id == owner_user_id)
            .order_by(
                ORMGenerationConversation.updated_at.desc(),
                ORMGenerationConversation.created_at.desc(),
                ORMGenerationConversation.id.desc(),
            )
            .execution_options(populate_existing=True)
        )
        return [generation_conversation_orm_to_domain(orm) for orm in (await self._s.execute(statement)).scalars()]

    async def get_conversation(self, *, owner_user_id: str, conversation_id: str) -> GenerationConversation | None:
        orm = await self._conversation(owner_user_id=owner_user_id, conversation_id=conversation_id)
        return generation_conversation_orm_to_domain(orm) if orm is not None else None

    async def delete_conversation(self, *, owner_user_id: str, conversation_id: str) -> bool:
        # The foreign keys remove the conversation's messages and drafts.
        deleted = await self._s.execute(
            delete(ORMGenerationConversation)
            .where(
                ORMGenerationConversation.id == conversation_id,
                ORMGenerationConversation.owner_user_id == owner_user_id,
            )
            .returning(ORMGenerationConversation.id)
        )
        return deleted.scalar_one_or_none() is not None

    async def add_message(
        self,
        *,
        message_id: str,
        owner_user_id: str,
        conversation_id: str,
        role: str,
        text: str,
        data: Mapping[str, Any],
        title: str | None = None,
    ) -> GenerationMessage | None:
        # Holding the conversation's row makes its messages arrive one at a time.
        conversation = await self._conversation(
            owner_user_id=owner_user_id, conversation_id=conversation_id, for_update=True
        )
        if conversation is None:
            return None
        # CURRENT_TIMESTAMP is the transaction's start, the same for every row of one
        # transaction, and ids are random. The wall clock keeps the order rows were added in.
        now = func.clock_timestamp()
        changes: dict[str, Any] = {"updated_at": now}
        if title and not conversation.title:
            # The row is held, so two first messages cannot both name the conversation.
            changes["title"] = title
        await self._s.execute(
            update(ORMGenerationConversation)
            .where(ORMGenerationConversation.id == conversation.id)
            .values(**changes)
            .execution_options(synchronize_session=False)
        )
        orm = ORMGenerationMessage(
            id=message_id, conversation_id=conversation.id, role=role, text=text, data=dict(data), created_at=now
        )
        self._s.add(orm)
        await self._s.flush()
        await self._s.refresh(orm)
        return generation_message_orm_to_domain(orm)

    async def list_messages(self, *, owner_user_id: str, conversation_id: str) -> list[GenerationMessage]:
        statement = (
            select(ORMGenerationMessage)
            .join(ORMGenerationConversation, ORMGenerationConversation.id == ORMGenerationMessage.conversation_id)
            .where(
                ORMGenerationMessage.conversation_id == conversation_id,
                ORMGenerationConversation.owner_user_id == owner_user_id,
            )
            .order_by(ORMGenerationMessage.created_at, ORMGenerationMessage.id)
            .execution_options(populate_existing=True)
        )
        return [generation_message_orm_to_domain(orm) for orm in (await self._s.execute(statement)).scalars()]

    async def add_draft(
        self, *, draft_id: str, owner_user_id: str, conversation_id: str, intent: str, status: str
    ) -> GenerationDraft | None:
        # Holding the conversation's row keeps two new drafts from taking one position.
        conversation = await self._conversation(
            owner_user_id=owner_user_id, conversation_id=conversation_id, for_update=True
        )
        if conversation is None:
            return None
        position = (
            await self._s.execute(
                select(func.coalesce(func.max(ORMGenerationDraft.position), -1) + 1).where(
                    ORMGenerationDraft.conversation_id == conversation.id
                )
            )
        ).scalar_one()
        orm = ORMGenerationDraft(
            id=draft_id,
            conversation_id=conversation.id,
            owner_user_id=owner_user_id,
            intent=intent,
            position=position,
            status=status,
        )
        self._s.add(orm)
        await self._s.flush()
        await self._s.refresh(orm)
        return generation_draft_orm_to_domain(orm)

    async def list_drafts(self, *, owner_user_id: str, conversation_id: str) -> list[GenerationDraft]:
        statement = (
            select(ORMGenerationDraft)
            .where(
                ORMGenerationDraft.conversation_id == conversation_id,
                ORMGenerationDraft.owner_user_id == owner_user_id,
            )
            .order_by(ORMGenerationDraft.position, ORMGenerationDraft.id)
            .execution_options(populate_existing=True)
        )
        return [generation_draft_orm_to_domain(orm) for orm in (await self._s.execute(statement)).scalars()]

    async def get_draft(self, *, owner_user_id: str, draft_id: str, for_update: bool = False) -> GenerationDraft | None:
        orm = await self._draft(owner_user_id=owner_user_id, draft_id=draft_id, for_update=for_update)
        return generation_draft_orm_to_domain(orm) if orm is not None else None

    async def save_draft(self, draft: GenerationDraft) -> GenerationDraft | None:
        orm = await self._draft(owner_user_id=draft.owner_user_id, draft_id=draft.id, for_update=True)
        if orm is None:
            return None
        orm.status = draft.status
        orm.version = draft.version
        orm.project = draft.project
        orm.previous_project = draft.previous_project
        orm.check_report = draft.check_report
        orm.checked_version = draft.checked_version
        orm.repair_count = draft.repair_count
        orm.failure_reason = draft.failure_reason
        orm.saved_item_id = draft.saved_item_id
        await self._s.flush()
        await self._s.refresh(orm)
        return generation_draft_orm_to_domain(orm)

    async def delete_draft(self, *, owner_user_id: str, draft_id: str) -> bool:
        deleted = await self._s.execute(
            delete(ORMGenerationDraft)
            .where(ORMGenerationDraft.id == draft_id, ORMGenerationDraft.owner_user_id == owner_user_id)
            .returning(ORMGenerationDraft.id)
        )
        return deleted.scalar_one_or_none() is not None

    async def check_state(self, *, owner_user_id: str, draft_id: str, version: int) -> GenerationCheckState | None:
        # Plain columns, so a waiting run reads again and again without loading the draft's
        # project, and never sees a row this session read earlier.
        row = (
            await self._s.execute(
                select(
                    ORMGenerationDraft.checked_version,
                    case(
                        (ORMGenerationDraft.checked_version == version, ORMGenerationDraft.check_report),
                        else_=None,
                    ).label("report"),
                ).where(ORMGenerationDraft.id == draft_id, ORMGenerationDraft.owner_user_id == owner_user_id)
            )
        ).one_or_none()
        if row is None:
            return None
        return GenerationCheckState(checked_version=row.checked_version, report=row.report)


__all__ = ["SQLAlchemyGenerationRepository"]

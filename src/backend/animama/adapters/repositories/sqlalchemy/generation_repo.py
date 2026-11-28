"""SQLAlchemy storage for the content assistant's conversations, messages and drafts."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from sqlalchemy import case, cast, delete, func, select, text, update
from sqlalchemy.dialects.postgresql import JSONB, insert
from sqlalchemy.ext.asyncio import AsyncSession

from animama.adapters.mappers.generation_map import (
    generation_conversation_orm_to_domain,
    generation_draft_orm_to_domain,
    generation_message_orm_to_domain,
)
from animama.app.ports.generation_port import GenerationCheckState, GenerationRepository
from animama.domain.generation import GenerationConversation, GenerationDraft, GenerationMessage
from animama.domain.user_file import STATUS_DELETED
from animama.orm.generation import (
    ORMGenerationConversation,
    ORMGenerationDraft,
    ORMGenerationMessage,
    ORMGenerationReferenceImage,
)
from animama.orm.user_file import ORMUserFile


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
        # The foreign keys remove the conversation's messages, drafts and image links.
        deleted = await self._s.execute(
            delete(ORMGenerationConversation)
            .where(
                ORMGenerationConversation.id == conversation_id,
                ORMGenerationConversation.owner_user_id == owner_user_id,
            )
            .returning(ORMGenerationConversation.id)
        )
        return deleted.scalar_one_or_none() is not None

    async def set_style_preset(
        self, *, owner_user_id: str, conversation_id: str, style_preset: str | None
    ) -> GenerationConversation | None:
        await self._s.execute(
            update(ORMGenerationConversation)
            .where(
                ORMGenerationConversation.id == conversation_id,
                ORMGenerationConversation.owner_user_id == owner_user_id,
            )
            # Named so the column's own ``onupdate`` does not move the conversation up the list.
            .values(style_preset=style_preset, updated_at=ORMGenerationConversation.updated_at)
            .execution_options(synchronize_session=False)
        )
        return await self.get_conversation(owner_user_id=owner_user_id, conversation_id=conversation_id)

    async def link_reference_images(self, *, owner_user_id: str, conversation_id: str, file_ids: Sequence[str]) -> bool:
        conversation = await self._conversation(owner_user_id=owner_user_id, conversation_id=conversation_id)
        if conversation is None:
            return False
        named = list(dict.fromkeys(file_ids))
        if not named:
            return True
        # Only the owner's own image files, whatever ids the caller names. ``metadata`` is a JSON column.
        images = (
            select(ORMUserFile.id)
            .where(
                ORMUserFile.id.in_(named),
                ORMUserFile.user_id == owner_user_id,
                ORMUserFile.status != STATUS_DELETED,
                ORMUserFile.metadata_["kind"].as_string() == "image",
            )
            .order_by(ORMUserFile.id)
        )
        owned = list((await self._s.execute(images)).scalars())
        if owned:
            await self._s.execute(
                insert(ORMGenerationReferenceImage)
                .values(
                    [
                        {"conversation_id": conversation.id, "file_id": file_id, "owner_user_id": owner_user_id}
                        for file_id in owned
                    ]
                )
                .on_conflict_do_nothing(index_elements=["conversation_id", "file_id"])
            )
        return True

    async def image_file_ids_only_in_conversation(self, *, owner_user_id: str, conversation_id: str) -> list[str]:
        # The mirror of the chat rule (``image_file_ids_only_in_chat`` in the user file repository): saved
        # user messages list their images in message_data.images. Other uses are searched only for this
        # conversation's image ids.
        result = await self._s.execute(
            text(
                """
                SELECT reference.file_id AS file_id
                FROM generation_reference_images AS reference
                JOIN generation_conversations AS conversation ON conversation.id = reference.conversation_id
                WHERE reference.conversation_id = :conversation_id
                  AND conversation.owner_user_id = :owner_user_id
                  AND NOT EXISTS (
                      SELECT 1
                      FROM generation_reference_images AS other
                      WHERE other.file_id = reference.file_id
                        AND other.conversation_id <> :conversation_id
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM chat_messages AS message
                      JOIN chats AS chat ON chat.id = message.chat_id
                      WHERE message.role = 'user'
                        AND chat.user_id = :owner_user_id
                        AND message.message_data -> 'images'
                            @> jsonb_build_array(jsonb_build_object('file_id', reference.file_id))
                  )
                """
            ),
            {"conversation_id": conversation_id, "owner_user_id": owner_user_id},
        )
        return sorted(str(row.file_id) for row in result)

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

    async def mark_images_sent(self, *, owner_user_id: str, message_id: str) -> bool:
        owned = select(ORMGenerationConversation.id).where(ORMGenerationConversation.owner_user_id == owner_user_id)
        marked = await self._s.execute(
            update(ORMGenerationMessage)
            .where(
                ORMGenerationMessage.id == message_id,
                ORMGenerationMessage.role == "user",
                ORMGenerationMessage.conversation_id.in_(owned),
            )
            # One key of the turn's data; everything else it carried stays.
            .values(data=ORMGenerationMessage.data.concat(cast({"images_sent": True}, JSONB)))
            .returning(ORMGenerationMessage.id)
            .execution_options(synchronize_session=False)
        )
        return marked.scalar_one_or_none() is not None

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

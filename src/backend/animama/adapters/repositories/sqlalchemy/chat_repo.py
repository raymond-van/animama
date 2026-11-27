"""SQLAlchemy ChatRepository adapter."""

from __future__ import annotations

from typing import Any

from sqlalchemy import cast, func, or_, select, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from animama.adapters.mappers.chat_map import chat_domain_to_orm, chat_orm_to_domain
from animama.app.ports.chat_port import ChatRepository
from animama.domain.chat import Chat
from animama.domain.usage import Usage, UsageInputDetails, UsageOutputDetails
from animama.orm.chat_messages import ORMChatMessage
from animama.orm.chats import ORMChat


class SQLAlchemyChatRepository(ChatRepository):
    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    async def get(self, chat_id: str) -> Chat | None:
        orm = await self._s.get(ORMChat, chat_id)
        if orm is None:
            return None
        return chat_orm_to_domain(orm)

    async def list_for_user(self, *, user_id: str, offset: int = 0, limit: int = 50) -> list[Chat]:
        stmt = select(ORMChat).where(ORMChat.user_id == user_id).order_by(ORMChat.updated_at.desc())
        res = await self._s.execute(stmt.offset(offset).limit(limit))
        return [chat_orm_to_domain(chat) for chat in res.scalars()]

    async def create(self, chat: Chat) -> Chat:
        existing = await self._s.get(ORMChat, chat.id)
        if existing is not None:
            existing.title = chat.title
            existing.user_id = str(chat.user_id or "")
            existing.anima_id = chat.anima_id
            if chat.api_standard is not None:
                existing.api_standard = chat.api_standard
            if chat.last_model_client is not None:
                existing.last_model_client = chat.last_model_client
            if chat.last_model_id is not None:
                existing.last_model_id = chat.last_model_id
            if chat.last_model_provider_id is not None:
                existing.last_model_provider_id = chat.last_model_provider_id
            if chat.openai_previous_response_id is not None:
                existing.openai_previous_response_id = chat.openai_previous_response_id
            existing.metadata_ = dict(chat.metadata or {})
            await self._s.flush()
            await self._s.refresh(existing)
            return chat_orm_to_domain(existing)
        orm = chat_domain_to_orm(chat)
        self._s.add(orm)
        await self._s.flush()
        await self._s.refresh(orm)
        return chat_orm_to_domain(orm)

    async def update(self, chat: Chat) -> Chat:
        orm = await self._s.get(ORMChat, chat.id)
        if orm is None:
            return await self.create(chat)
        orm.title = chat.title
        orm.user_id = str(chat.user_id or "")
        orm.anima_id = chat.anima_id
        if chat.api_standard is not None:
            orm.api_standard = chat.api_standard
        if chat.last_model_client is not None:
            orm.last_model_client = chat.last_model_client
        if chat.last_model_id is not None:
            orm.last_model_id = chat.last_model_id
        if chat.last_model_provider_id is not None:
            orm.last_model_provider_id = chat.last_model_provider_id
        if chat.openai_previous_response_id is not None:
            orm.openai_previous_response_id = chat.openai_previous_response_id
        orm.metadata_ = dict(chat.metadata or {})
        await self._s.flush()
        await self._s.refresh(orm)
        return chat_orm_to_domain(orm)

    async def initialize_or_validate_api_standard(
        self,
        chat_id: str,
        *,
        api_standard: str,
    ) -> Chat | None:
        result = await self._s.execute(select(ORMChat).where(ORMChat.id == chat_id).with_for_update())
        orm = result.scalar_one_or_none()
        if orm is None:
            return None
        if orm.api_standard is None:
            message_result = await self._s.execute(
                select(ORMChatMessage.id).where(ORMChatMessage.chat_id == chat_id).limit(1)
            )
            has_messages = message_result.scalar_one_or_none() is not None
            if int(orm.next_turn or 1) <= 1 and not has_messages:
                orm.api_standard = api_standard
                await self._s.flush()
                await self._s.refresh(orm)
        return chat_orm_to_domain(orm)

    async def merge_metadata(self, chat_id: str, metadata_patch: dict[str, Any]) -> bool:
        if not metadata_patch:
            return True
        result = await self._s.execute(
            update(ORMChat)
            .where(ORMChat.id == chat_id)
            .values(metadata_=ORMChat.metadata_.op("||")(cast(metadata_patch, JSONB)))
            .returning(ORMChat.id)
            .execution_options(synchronize_session=False)
        )
        await self._s.flush()
        return result.scalar_one_or_none() is not None

    async def set_title_if_blank(
        self,
        *,
        chat_id: str,
        user_id: str,
        title: str,
        metadata_patch: dict[str, Any] | None = None,
    ) -> Chat | None:
        values: dict[str, Any] = {"title": title}
        if metadata_patch:
            values["metadata_"] = ORMChat.metadata_.op("||")(cast(metadata_patch, JSONB))
        result = await self._s.execute(
            update(ORMChat)
            .where(
                ORMChat.id == chat_id,
                ORMChat.user_id == user_id,
                or_(
                    ORMChat.title.is_(None),
                    func.length(func.btrim(ORMChat.title)) == 0,
                ),
            )
            .values(**values)
            .returning(ORMChat)
            .execution_options(synchronize_session=False)
        )
        await self._s.flush()
        orm = result.scalar_one_or_none()
        if orm is None:
            return None
        return chat_orm_to_domain(orm)

    async def set_pinned(self, *, chat_id: str, user_id: str, pinned: bool) -> Chat | None:
        result = await self._s.execute(
            update(ORMChat)
            .where(ORMChat.id == chat_id, ORMChat.user_id == user_id)
            .values(
                pinned_at=func.coalesce(ORMChat.pinned_at, func.now()) if pinned else None,
                # Setting updated_at to itself suppresses its onupdate: a pin is not an edit.
                updated_at=ORMChat.updated_at,
            )
            .returning(ORMChat.id)
            .execution_options(synchronize_session=False)
        )
        if result.scalar_one_or_none() is None:
            return None
        orm = await self._s.get(ORMChat, chat_id)
        assert orm is not None
        # The bulk update bypassed the identity map; reload the one value it changed.
        await self._s.refresh(orm, attribute_names=["pinned_at"])
        return chat_orm_to_domain(orm)

    async def delete(self, chat_id: str) -> bool:
        orm = await self._s.get(ORMChat, chat_id)
        if orm is None:
            return False
        await self._s.delete(orm)
        await self._s.flush()
        return True

    async def reserve_message_turns_and_add_usage(
        self,
        chat_id: str,
        *,
        message_count: int,
        usage: Usage | None = None,
        active_context_tokens: int | None = None,
        openai_previous_response_id: str | None = None,
        clear_openai_previous_response_id: bool = False,
        last_model_client: str | None = None,
        last_model_id: str | None = None,
        last_model_provider_id: str | None = None,
    ) -> tuple[int, Usage | None]:
        if (last_model_client is None) != (last_model_id is None):
            raise ValueError("last_model_client and last_model_id must be provided together")
        count = int(message_count or 0)
        if count < 1:
            raise ValueError("message_count must be at least 1")

        # `next_turn` is the per-chat allocator for chat_messages.turn. This
        # UPDATE reserves a contiguous range on the chat row, so concurrent
        # requests for the same chat cannot receive overlapping turn values.
        values: dict[str, object] = {"next_turn": ORMChat.next_turn + count}
        if clear_openai_previous_response_id:
            values["openai_previous_response_id"] = None
        elif openai_previous_response_id is not None:
            values["openai_previous_response_id"] = openai_previous_response_id
        if last_model_client is not None and last_model_id is not None:
            values["last_model_client"] = last_model_client
            values["last_model_id"] = last_model_id
        if last_model_provider_id is not None:
            values["last_model_provider_id"] = last_model_provider_id
        if usage is not None:
            cached_input_tokens = int(getattr(usage.input_tokens_details, "cached_tokens", 0) or 0)
            output_reasoning_tokens = int(getattr(usage.output_tokens_details, "reasoning_tokens", 0) or 0)
            # Prior reasoning output is billed in total_tokens, but it is not
            # replayed as visible chat context on the next request.
            active_context = int(
                active_context_tokens
                if active_context_tokens is not None
                else int(usage.total_tokens or 0) - output_reasoning_tokens
            )
            values.update(
                {
                    "cum_input_tokens": ORMChat.cum_input_tokens + int(usage.input_tokens or 0),
                    "cum_output_tokens": ORMChat.cum_output_tokens + int(usage.output_tokens or 0),
                    "cum_total_tokens": ORMChat.cum_total_tokens + int(usage.total_tokens or 0),
                    "cum_cached_input_tokens": ORMChat.cum_cached_input_tokens + cached_input_tokens,
                    "cum_output_reasoning_tokens": ORMChat.cum_output_reasoning_tokens + output_reasoning_tokens,
                    "active_context_tokens": max(0, active_context),
                }
            )

        # Async SQLAlchemy gotcha: this chat is often already present in the
        # identity map while recording a turn. An ORM bulk update can expire
        # onupdate-managed columns such as updated_at; mapping the ORM row after
        # that touches expired attributes synchronously and raises MissingGreenlet.
        # Fetch only scalar values through RETURNING.
        result = await self._s.execute(
            update(ORMChat)
            .where(ORMChat.id == chat_id)
            .values(**values)
            .returning(
                # RETURNING observes the post-update value, so subtract the
                # reserved count to get the first turn assigned to this batch.
                (ORMChat.next_turn - count).label("first_turn"),
                ORMChat.cum_input_tokens,
                ORMChat.cum_output_tokens,
                ORMChat.cum_total_tokens,
                ORMChat.cum_cached_input_tokens,
                ORMChat.cum_output_reasoning_tokens,
            )
            .execution_options(synchronize_session=False)
        )
        await self._s.flush()
        row = result.one_or_none()
        if row is None:
            return 0, None
        mapping = row._mapping
        first_turn = int(mapping["first_turn"] or 0)
        if usage is None:
            return first_turn, None
        return first_turn, Usage(
            input_tokens=int(row.cum_input_tokens or 0),
            output_tokens=int(row.cum_output_tokens or 0),
            total_tokens=int(row.cum_total_tokens or 0),
            input_tokens_details=UsageInputDetails(cached_tokens=int(row.cum_cached_input_tokens or 0)),
            output_tokens_details=UsageOutputDetails(reasoning_tokens=int(row.cum_output_reasoning_tokens or 0)),
        )


__all__ = ["SQLAlchemyChatRepository"]

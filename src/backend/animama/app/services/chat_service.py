"""Chat service over product chat persistence."""

from __future__ import annotations

import uuid
from typing import Any

from animama.app.ports import UnitOfWork
from animama.app.ports.chat_port import ChatRepository
from animama.domain.chat import Chat
from animama.logging import get_logger

from .pending_episode_removal import PendingEpisodeRemoval


class ChatService:
    """CRUD service for product chat rows.

    ``pending_episodes``, when given, removes a deleted chat's pending episodes in
    the same transaction.
    """

    def __init__(
        self,
        *,
        chats: ChatRepository,
        uow: UnitOfWork,
        pending_episodes: PendingEpisodeRemoval | None = None,
    ) -> None:
        self._chats = chats
        self._uow = uow
        self._pending_episodes = pending_episodes
        self._log = get_logger("app.services.chat")

    async def create(
        self,
        *,
        anima_id: str,
        user_id: str | None,
        title: str | None = None,
        metadata: dict[str, Any] | None = None,
        chat_id: str | None = None,
    ) -> Chat:
        cid = chat_id or f"chat-{uuid.uuid4()}"
        chat = Chat(
            id=cid,
            anima_id=anima_id,
            user_id=user_id,
            title=title,
            metadata=metadata or {},
        )
        stored = await self._chats.create(chat)
        await self._uow.commit()
        self._log.info("Chat Created", id=stored.id, anima_id=anima_id)
        return stored

    async def list_for_user(self, *, user_id: str) -> list[Chat]:
        return await self._chats.list_for_user(user_id=user_id)

    async def get(self, chat_id: str) -> Chat | None:
        return await self._chats.get(chat_id)

    async def update(
        self,
        *,
        chat_id: str,
        user_id: str,
        title: str | None = None,
        metadata: dict[str, Any] | None = None,
        pinned: bool | None = None,
    ) -> Chat | None:
        """Change the owner's chat; ``None`` leaves a field as it is.

        ``pinned`` pins or unpins the chat without counting as an edit (see
        ``ChatRepository.set_pinned``). Returns ``None`` when the chat is missing
        or another owner's.
        """

        current = await self._chats.get(chat_id)
        if current is None or current.user_id != user_id:
            return None
        saved: Chat | None = current
        if title is not None or metadata is not None:
            saved = await self._chats.update(
                Chat(
                    id=current.id,
                    anima_id=current.anima_id,
                    user_id=current.user_id,
                    title=title if title is not None else current.title,
                    api_standard=current.api_standard,
                    last_model_client=current.last_model_client,
                    last_model_id=current.last_model_id,
                    last_model_provider_id=current.last_model_provider_id,
                    openai_previous_response_id=current.openai_previous_response_id,
                    metadata=metadata if metadata is not None else current.metadata,
                    created_at=current.created_at,
                    updated_at=current.updated_at,
                    pinned_at=current.pinned_at,
                )
            )
        if pinned is not None:
            saved = await self._chats.set_pinned(chat_id=chat_id, user_id=user_id, pinned=pinned)
        if saved is None:
            return None
        await self._uow.commit()
        self._log.info("Chat Updated", id=saved.id)
        return saved

    async def delete(self, *, chat_id: str, user_id: str) -> bool:
        """Delete the owner's chat with its messages and pending episodes; processed episodes stay."""

        current = await self._chats.get(chat_id)
        if current is None or current.user_id != user_id:
            return False
        if self._pending_episodes is not None:
            await self._pending_episodes.remove(user_id=user_id, chat_ids=(chat_id,))
        ok = await self._chats.delete(chat_id)
        if ok:
            await self._uow.commit()
        self._log.info("Chat Deleted", id=chat_id, ok=ok)
        return ok


__all__ = ["ChatService"]

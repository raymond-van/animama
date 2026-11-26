"""Chat repository protocol."""

from __future__ import annotations

from typing import Any, Protocol

from animama.domain.chat import Chat
from animama.domain.usage import Usage


class ChatRepository(Protocol):
    """Repository operations for persisted product chats."""

    async def get(self, chat_id: str) -> Chat | None:
        raise NotImplementedError

    async def list_for_user(self, *, user_id: str, offset: int = 0, limit: int = 50) -> list[Chat]:
        raise NotImplementedError

    async def create(self, chat: Chat) -> Chat:
        raise NotImplementedError

    async def update(self, chat: Chat) -> Chat:
        raise NotImplementedError

    async def initialize_or_validate_api_standard(
        self,
        chat_id: str,
        *,
        api_standard: str,
    ) -> Chat | None:
        raise NotImplementedError

    async def merge_metadata(self, chat_id: str, metadata_patch: dict[str, Any]) -> bool:
        raise NotImplementedError

    async def set_title_if_blank(
        self,
        *,
        chat_id: str,
        user_id: str,
        title: str,
        metadata_patch: dict[str, Any] | None = None,
    ) -> Chat | None:
        raise NotImplementedError

    async def set_pinned(self, *, chat_id: str, user_id: str, pinned: bool) -> Chat | None:
        """Pin or unpin the owner's chat, without committing; ``None`` when no such chat.

        A pin is not an edit: ``updated_at``, which orders recent chats, stays
        unchanged. Pinning keeps an existing pin time.
        """

        raise NotImplementedError

    async def delete(self, chat_id: str) -> bool:
        raise NotImplementedError

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
        raise NotImplementedError


__all__ = ["ChatRepository"]

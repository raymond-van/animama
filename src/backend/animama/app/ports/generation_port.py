"""Owner-scoped storage for the content assistant's conversations, messages and drafts."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from animama.domain.generation import GenerationConversation, GenerationDraft, GenerationMessage


@dataclass(frozen=True, slots=True)
class GenerationCheckState:
    """Which version a draft's stored check report is for, read without the draft's project.

    ``report`` is set only when that version is the one asked for.
    """

    checked_version: int | None
    report: dict[str, Any] | None


class GenerationRepository(Protocol):
    """Every method is scoped to ``owner_user_id``; none commits.

    A row of another owner behaves exactly as a missing one: reads return
    ``None`` or nothing, and writes change nothing.
    """

    async def add_conversation(
        self, *, conversation_id: str, owner_user_id: str, scope: Mapping[str, Any]
    ) -> GenerationConversation:
        """Store a new, untitled conversation."""
        ...

    async def list_conversations(self, *, owner_user_id: str) -> list[GenerationConversation]:
        """Return the owner's conversations, the most recently written to first."""
        ...

    async def get_conversation(self, *, owner_user_id: str, conversation_id: str) -> GenerationConversation | None: ...

    async def delete_conversation(self, *, owner_user_id: str, conversation_id: str) -> bool:
        """Delete a conversation with its messages and drafts; ``False`` when there was none."""
        ...

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
        """Append a message and mark its conversation as just written to; ``None`` without the conversation.

        Messages of one conversation are stored one at a time with increasing
        times, so reading them back keeps the order they were added in. A
        non-empty ``title`` names the conversation in the same transaction
        when it has no title yet, and is ignored once it has one.
        """
        ...

    async def list_messages(self, *, owner_user_id: str, conversation_id: str) -> list[GenerationMessage]:
        """Return a conversation's messages in the order they were added."""
        ...

    async def add_draft(
        self, *, draft_id: str, owner_user_id: str, conversation_id: str, intent: str, status: str
    ) -> GenerationDraft | None:
        """Store an empty draft at the conversation's next position; ``None`` without the conversation.

        The next position is one after the highest in the conversation, so a
        gap left by a deleted draft is not filled, while deleting the last
        draft frees its position for the next one.
        """
        ...

    async def list_drafts(self, *, owner_user_id: str, conversation_id: str) -> list[GenerationDraft]:
        """Return a conversation's drafts in position order."""
        ...

    async def get_draft(self, *, owner_user_id: str, draft_id: str, for_update: bool = False) -> GenerationDraft | None:
        """Return a draft; ``for_update`` holds its row until the transaction ends, for a read then a write."""
        ...

    async def save_draft(self, draft: GenerationDraft) -> GenerationDraft | None:
        """Store the draft's changeable fields and return the stored row; ``None`` when it is gone.

        Identity, conversation, owner, intent and position never change.
        """
        ...

    async def delete_draft(self, *, owner_user_id: str, draft_id: str) -> bool: ...

    async def check_state(self, *, owner_user_id: str, draft_id: str, version: int) -> GenerationCheckState | None:
        """Return what the draft's stored check report covers, with the report when it is for ``version``.

        Always reads the database, never state an earlier read left in memory.
        """
        ...


__all__ = ["GenerationCheckState", "GenerationRepository"]

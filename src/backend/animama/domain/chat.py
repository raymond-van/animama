from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any

from .chat_compaction import ChatCompaction
from .usage import Usage


class MessageRole(Enum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    DEVELOPER = "developer"
    TOOL = "tool"


@dataclass(slots=True)
class Chat:
    """User-facing chat thread for one anima/avatar."""

    id: str
    anima_id: str
    user_id: str | None = None
    title: str | None = None
    api_standard: str | None = None
    last_model_client: str | None = None
    last_model_id: str | None = None
    # Catalog row id of the last model; two connections may share a model slug.
    last_model_provider_id: str | None = None
    openai_previous_response_id: str | None = None
    metadata: dict[str, Any] | None = field(default_factory=dict)
    usage: Usage = field(default_factory=Usage)
    active_context_tokens: int = 0
    next_turn: int = 1
    created_at: datetime | None = None
    updated_at: datetime | None = None
    # Sidebar pin time; None when unpinned. Changed only through ChatRepository.set_pinned.
    pinned_at: datetime | None = None


@dataclass(slots=True)
class ChatMessage:
    """Persisted message belonging directly to a chat."""

    id: int | None
    chat_id: str | None
    run_id: str | None
    message_type: str | None
    role: MessageRole | None
    content: str | None
    data: Mapping[str, Any] | None
    usage: Usage | None
    turn: int | None
    created_at: datetime | None
    model: str | None = None
    model_provider: str | None = None
    internal: bool = False
    raw_provider_message: Mapping[str, Any] | None = None


@dataclass(slots=True)
class ChatSearchResult:
    """Best visible message hit representing a user-owned chat search result."""

    message_id: int
    chat_id: str
    anima_id: str
    anima_name: str | None
    anima_profile_picture_url: str | None
    chat_title: str | None
    snippet: str
    score: float
    turn: int | None
    created_at: datetime | None


@dataclass(slots=True)
class ChatContext:
    """Prompt context built from visible chat history and active compaction."""

    messages: list[ChatMessage]
    active_compaction: ChatCompaction | None = None


@dataclass(frozen=True, order=True, slots=True)
class ChatHistoryPosition:
    """A point in an owner's history across chats, ordered by message time, then message ID.

    ``created_at`` is the stored naive UTC message timestamp. All rows of one
    persisted turn share it, and message IDs keep their insertion order.
    """

    created_at: datetime
    message_id: int


@dataclass(frozen=True, slots=True)
class AnimaHistoryTurn:
    """One persisted chat turn with an Anima: the owner's message and the Anima's visible reply.

    Either text is ``None`` when that side of the turn has no visible row.
    ``position`` is the turn's last visible message.
    """

    chat_id: str
    chat_title: str | None
    user_text: str | None
    anima_text: str | None
    position: ChatHistoryPosition


@dataclass(frozen=True, slots=True)
class AnimaHistoryTurnBatch:
    """The oldest uncovered turns selected for one Reflection.

    ``through`` is the last message of the batch's final turn, or ``None`` when
    no turn is uncovered; ``uncovered_turn_count`` counts every uncovered turn,
    including those beyond the batch.
    """

    turn_count: int
    uncovered_turn_count: int
    through: ChatHistoryPosition | None


__all__ = [
    "AnimaHistoryTurn",
    "AnimaHistoryTurnBatch",
    "Chat",
    "ChatContext",
    "ChatHistoryPosition",
    "ChatMessage",
    "ChatSearchResult",
    "MessageRole",
]

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from pydantic import BaseModel

from animama.app.chat.conversation_language import ConversationLanguage
from animama.app.chat.memory_context import DirectChatMemoryContext
from animama.app.chat.options import DirectChatOptions
from animama.app.model_clients import ModelClientError, ModelClientRequest
from animama.app.model_clients.image_parts import ModelClientImage
from animama.domain.chat import Chat
from animama.domain.user_file_processing import UserFileOutlineItem

from .constants import DIRECT_CHAT_NODE_ID


class ModelClientNotFoundError(LookupError):
    """Raised when no shared model client is registered for a provider type."""


class DirectChatTurnSetupError(RuntimeError):
    """Raised before a direct turn starts when required setup cannot be resolved."""


class DirectChatTurnImagesUnsupportedError(DirectChatTurnSetupError):
    """Raised when a turn carries images and the selected model does not accept them."""

    code = "model_does_not_accept_images"


@dataclass(frozen=True, slots=True)
class DirectChatAttachedImage:
    """One ready chat image attached to a turn, by reference; its bytes load per request."""

    file_id: str
    name: str
    width: int
    height: int


class ChatImageLoader(Protocol):
    """Loads the owner's stored chat images for one request."""

    async def load(self, file_ids: Sequence[str]) -> Mapping[str, ModelClientImage]:
        """Return the bytes of each ready image among ``file_ids``; others are left out."""
        ...


@dataclass(frozen=True, slots=True)
class DirectChatAttachmentContext:
    """Safe request-local navigation metadata for one validated upload."""

    filename: str
    chunk_count: int
    description: str | None = None
    outline: tuple[UserFileOutlineItem, ...] = ()
    outline_truncated: bool = False


@dataclass(frozen=True, slots=True)
class RuntimeGestureDescriptor:
    """User-facing meaning for one exact AI-selectable Gesture selector."""

    selector: str
    name: str
    description: str


@dataclass(frozen=True, slots=True)
class DirectChatTurnRequest:
    """Input for one app-layer direct chat model-client turn."""

    anima_id: str
    user_id: str
    chat_id: str
    run_id: str
    user_message: str
    model_provider_id: str | None = None
    attached_file_ids: tuple[str, ...] = ()
    attached_files: tuple[DirectChatAttachmentContext, ...] = ()
    attached_images: tuple[DirectChatAttachedImage, ...] = ()
    request_options: DirectChatOptions | Mapping[str, Any] = field(default_factory=DirectChatOptions)
    emotional_state: Mapping[str, Any] | None = None
    runtime_revision: str | None = None
    runtime_gesture_ids: tuple[str, ...] | None = None
    runtime_gesture_descriptors: tuple[RuntimeGestureDescriptor, ...] = ()
    node_id: str = DIRECT_CHAT_NODE_ID
    provider_moderation: bool = False
    """Request provider-side moderation scores where the provider supports them (spec R3)."""
    conversation_language: ConversationLanguage | None = None
    """Non-English language the Anima replies in; ``None`` keeps the default (ADR 0024)."""

    def __post_init__(self) -> None:
        object.__setattr__(self, "request_options", DirectChatOptions.from_value(self.request_options))

    @property
    def options(self) -> DirectChatOptions:
        """Return options normalized by construction, while accepting mapping inputs."""
        assert isinstance(self.request_options, DirectChatOptions)
        return self.request_options


@dataclass(frozen=True, slots=True)
class PreparedDirectChatTurn:
    """Validated direct chat turn state that is ready for model invocation."""

    request: DirectChatTurnRequest
    chat: Chat
    model_request: ModelClientRequest
    output_type: type[BaseModel]
    response_format: str
    memory_context: DirectChatMemoryContext
    memory_tool_specs: tuple[dict[str, Any], ...] = ()
    context_loaded: bool = True
    runtime_revision: str | None = None
    runtime_gesture_ids: tuple[str, ...] = ()
    # Compiled history the prompt was built from (compaction summary first).
    visible_history: tuple[Any, ...] = ()


@dataclass(frozen=True, slots=True)
class PreSendCompactionRequest:
    """Ask for a compaction before sending a turn that would not fit the model's window.

    ``keep_recent_tokens`` bounds the newest messages left uncompacted.
    """

    chat_id: str
    user_id: str
    anima_id: str
    run_id: str
    keep_recent_tokens: int


# Compacts the chat in its own session and returns the refreshed chat context,
# or ``None`` when nothing was compacted.
PreSendCompactor = Callable[[PreSendCompactionRequest], Awaitable[Any | None]]


class DirectChatTurnStreamError(RuntimeError):
    """Wraps a provider failure that occurred after direct-turn setup."""

    def __init__(self, *, request: DirectChatTurnRequest, error: ModelClientError) -> None:
        super().__init__(error.message)
        self.request = request
        self.error = error


__all__ = [
    "PreSendCompactionRequest",
    "PreSendCompactor",
    "ChatImageLoader",
    "DirectChatAttachedImage",
    "DirectChatAttachmentContext",
    "DirectChatTurnImagesUnsupportedError",
    "DirectChatTurnRequest",
    "DirectChatTurnSetupError",
    "DirectChatTurnStreamError",
    "ModelClientNotFoundError",
    "PreparedDirectChatTurn",
    "RuntimeGestureDescriptor",
]

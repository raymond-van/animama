"""Provider-neutral model-client contracts: requests, streamed deltas, finals, tool calls,
errors, continuation cursors and the client registry.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import TYPE_CHECKING, Any, Literal, Protocol, runtime_checkable

from animama.domain.events import RunStatusKind, RunStatusPhase
from animama.domain.model_provider import ModelProvider
from animama.domain.usage import Usage

from .event_types import MCEvent
from .frozen import frozen_mapping
from .image_parts import ModelClientImage
from .limits import ModelCallLimits

if TYPE_CHECKING:
    from .prompt import DirectChatPrompt

MODEL_CLIENT_TOOL_CALL_ITEM_TYPE = "model_client_tool_call"
MODEL_CLIENT_TOOL_RESULT_ITEM_TYPE = "model_client_tool_result"
ANTHROPIC_TOOL_USE_ITEM_TYPE = "anthropic_tool_use"
"""Prompt and history item for one Anthropic ``tool_use`` block (``id``, ``name``, ``input``)."""
ANTHROPIC_TOOL_RESULT_ITEM_TYPE = "anthropic_tool_result"
"""Prompt and history item for one Anthropic ``tool_result`` block (``tool_use_id``, ``content``)."""


def _string_tuple(value: object) -> tuple[str, ...]:
    if not isinstance(value, list | tuple | set | frozenset):
        return ()
    seen: set[str] = set()
    result: list[str] = []
    for item in value:
        if item is None:
            continue
        text = str(item).strip()
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return tuple(result)


@dataclass(frozen=True, slots=True)
class ModelClientToolCall:
    """Provider-neutral tool call requested by a model."""

    id: str
    name: str
    arguments: str
    tool_type: str = "function"

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", str(self.id or "").strip())
        object.__setattr__(self, "name", str(self.name or "").strip())
        object.__setattr__(self, "arguments", str(self.arguments or ""))
        object.__setattr__(self, "tool_type", str(self.tool_type or "function").strip() or "function")


@dataclass(frozen=True, slots=True)
class ModelClientToolResult:
    """Provider-neutral result for one model-requested tool call."""

    call_id: str
    tool_type: str
    status: str
    output: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "call_id", str(self.call_id or "").strip())
        object.__setattr__(self, "tool_type", str(self.tool_type or "function").strip() or "function")
        object.__setattr__(self, "status", str(self.status or "failed").strip() or "failed")
        object.__setattr__(self, "output", str(self.output or ""))


@dataclass(frozen=True, slots=True)
class ModelClientModeration:
    """Content-free provider moderation result for the request input.

    ``status`` is ``"error"`` when the provider could not moderate; otherwise the
    flagged category names and their scores are carried, never any text.
    """

    status: Literal["result", "error"]
    flagged_categories: tuple[str, ...] = ()
    category_scores: Mapping[str, float] = field(default_factory=lambda: MappingProxyType({}))

    def __post_init__(self) -> None:
        object.__setattr__(self, "category_scores", frozen_mapping(self.category_scores))


@dataclass(frozen=True, slots=True)
class ModelClientFinal:
    """Final assistant result for one direct chat turn.

    Provider adapters should emit this only after seeing the provider-specific
    terminal signal they trust. For OpenAI Chat Completions that is the streamed
    finish_reason path; for OpenAI Responses that is response.completed.

    ``continuation`` is request-local provider state for the turn's next round
    after tool calls (Anthropic carries the turn's assistant content blocks,
    including signed thinking, so they are resent unchanged). It is never
    persisted.

    ``replay_prefix`` holds provider content blocks that later turns must
    replay before the reply text, persisted with the assistant row: the
    turn's latest Anthropic compaction block, which carries the summary of
    everything before it.
    """

    text: str
    usage: Usage = field(default_factory=Usage)
    raw_provider_metadata: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))
    structured_payload: Mapping[str, Any] | None = None
    tool_calls: tuple[ModelClientToolCall, ...] = ()
    input_moderation: ModelClientModeration | None = None
    continuation: ModelClientContinuation | None = None
    replay_prefix: tuple[Mapping[str, Any], ...] = ()
    usage_reported: bool = False
    """True only for provider-reported usage, never estimates or default zero."""

    def __post_init__(self) -> None:
        object.__setattr__(self, "raw_provider_metadata", frozen_mapping(self.raw_provider_metadata))
        object.__setattr__(
            self,
            "replay_prefix",
            tuple(frozen_mapping(block) for block in self.replay_prefix if isinstance(block, Mapping)),
        )
        structured = None if self.structured_payload is None else frozen_mapping(self.structured_payload)
        object.__setattr__(self, "structured_payload", structured)
        object.__setattr__(
            self,
            "tool_calls",
            tuple(call for call in self.tool_calls if call.id and call.name),
        )


@dataclass(frozen=True, slots=True)
class ModelClientRunStatus:
    """Provider-side work shown while the reply is pending.

    ``searching_web`` covers a provider-hosted web search and
    ``summarizing_context`` a provider-side compaction. Each ``started`` is
    followed by ``finished``.
    """

    status: RunStatusKind
    phase: RunStatusPhase


@dataclass(frozen=True, slots=True)
class ModelClientDelta:
    """Streaming item emitted by a provider-neutral model client.

    `text_delta` carries public assistant text, `event` carries sanitized
    provider observations for logs/metadata, `run_status` carries provider-side
    work to show while the reply is pending, `final` carries the authoritative
    assistant output, and `error` carries stream-level provider failure.
    """

    kind: str
    text: str | None = None
    final: ModelClientFinal | None = None
    error: str | None = None
    stream_event: MCEvent | None = None
    run_status: ModelClientRunStatus | None = None
    raw_metadata: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))

    def __post_init__(self) -> None:
        object.__setattr__(self, "raw_metadata", frozen_mapping(self.raw_metadata))


def model_client_event_delta(event: MCEvent) -> ModelClientDelta:
    """Build a streaming delta for an ordered provider observation."""

    return ModelClientDelta(kind="event", stream_event=event)


def model_client_run_status_delta(status: RunStatusKind, phase: RunStatusPhase) -> ModelClientDelta:
    """Build a streaming delta reporting provider-side work (a hosted search or compaction)."""

    return ModelClientDelta(kind="run_status", run_status=ModelClientRunStatus(status=status, phase=phase))


class ModelClientError(Exception):
    """Base error raised by provider-neutral model clients."""

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        raw_metadata: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.raw_metadata = frozen_mapping(raw_metadata)


class ModelClientProviderError(ModelClientError):
    """Raised when an upstream provider rejects or fails a model-client request."""


class ModelClientTimeoutError(ModelClientError):
    """Raised when an upstream provider request times out."""


@dataclass(frozen=True, slots=True)
class ModelClientContinuation:
    """Provider-scoped continuation cursor for one request-local model turn.

    Responses adapters use this to pass `previous_response_id`; providers that
    rely on explicit chat history should leave it unset.
    """

    provider_type: str
    cursor: str
    metadata: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))

    def __post_init__(self) -> None:
        object.__setattr__(self, "provider_type", str(self.provider_type or "").strip())
        object.__setattr__(self, "cursor", str(self.cursor or "").strip())
        object.__setattr__(self, "metadata", frozen_mapping(self.metadata))


@dataclass(frozen=True, slots=True)
class ModelClientProviderOptions:
    """Provider-adapter options that are not part of prompt messages."""

    native_tools: tuple[str, ...] = ()
    store: bool | None = None
    memory_apply_patch_enabled: bool = False
    moderation_model: str | None = None
    """Request provider-side moderation scores with this model, when the adapter supports it."""
    utility_task: bool = False
    """A backend Utility prompt (a chat title or another chat's summary), not a chat turn.

    Adapters apply their provider's Utility defaults; Anthropic uses effort
    ``low`` and no server-side compaction of the prompt."""

    def __post_init__(self) -> None:
        object.__setattr__(self, "native_tools", _string_tuple(self.native_tools))
        object.__setattr__(self, "utility_task", self.utility_task is True)
        object.__setattr__(
            self,
            "moderation_model",
            self.moderation_model.strip() or None if isinstance(self.moderation_model, str) else None,
        )
        object.__setattr__(self, "store", self.store if isinstance(self.store, bool) else None)
        object.__setattr__(
            self,
            "memory_apply_patch_enabled",
            self.memory_apply_patch_enabled if isinstance(self.memory_apply_patch_enabled, bool) else False,
        )

    @classmethod
    def from_value(
        cls,
        value: ModelClientProviderOptions | Mapping[str, Any] | None,
    ) -> ModelClientProviderOptions:
        if isinstance(value, ModelClientProviderOptions):
            return value
        if not isinstance(value, Mapping):
            return cls()
        store = value.get("store")
        return cls(
            native_tools=_string_tuple(value.get("native_tools")),
            store=store if isinstance(store, bool) else None,
            memory_apply_patch_enabled=value.get("memory_apply_patch_enabled") is True,
            moderation_model=value.get("moderation_model") if isinstance(value.get("moderation_model"), str) else None,
            utility_task=value.get("utility_task") is True,
        )

    def get(self, key: str, default: object = None) -> object:
        if key == "moderation_model":
            return self.moderation_model
        if key == "native_tools":
            return self.native_tools
        if key == "store":
            return self.store
        if key == "memory_apply_patch_enabled":
            return self.memory_apply_patch_enabled
        if key == "utility_task":
            return self.utility_task
        return default

    def __getitem__(self, key: str) -> object:
        if key == "moderation_model":
            return self.moderation_model
        if key == "native_tools":
            return self.native_tools
        if key == "store":
            return self.store
        if key == "memory_apply_patch_enabled":
            return self.memory_apply_patch_enabled
        if key == "utility_task":
            return self.utility_task
        raise KeyError(key)


@dataclass(frozen=True, slots=True)
class ModelClientRequest:
    """Provider invocation request passed to a shared model client.

    The request is immutable enough to cross async boundaries safely: route and
    app-layer code build it once, then the adapter translates it into SDK-specific
    request parameters.
    """

    model_provider: ModelProvider
    prompt: DirectChatPrompt
    provider_options: ModelClientProviderOptions = field(default_factory=ModelClientProviderOptions)
    continuation: ModelClientContinuation | None = None
    limits: ModelCallLimits | None = None
    images: Mapping[str, ModelClientImage] = field(default_factory=dict)
    """Bytes of the chat images the prompt's image parts name, keyed by file id.

    Filled just before dispatch; an image part without bytes here is sent as its
    placeholder text.
    """

    def __post_init__(self) -> None:
        object.__setattr__(self, "provider_options", ModelClientProviderOptions.from_value(self.provider_options))


@runtime_checkable
class ModelClient(Protocol):
    """Concurrency-safe provider-family client.

    Implementations may hold reusable SDK or HTTP resources, but all anima,
    Provider, prompt, continuation, and provider-specific option state must come
    from ``ModelClientRequest``.
    """

    def stream(self, request: ModelClientRequest) -> AsyncIterator[ModelClientDelta]:
        raise NotImplementedError

    async def aclose(self) -> None:
        raise NotImplementedError


def uses_native_context_compaction(client: object) -> bool:
    """Return whether ``client`` asks its provider to compact long prompts itself.

    Such a client (OpenAI Responses with a compaction threshold) keeps prompts
    within the model's window on the provider side. For every other client the
    application fits prompts to the row's context window. Clients opt in with a
    ``native_context_compaction`` property that is ``True``; wrappers forward
    the wrapped client's value. The capability is optional, so it is not part
    of the runtime-checkable ``ModelClient`` protocol.
    """

    return getattr(client, "native_context_compaction", False) is True


class ModelClientRegistry(Protocol):
    """Resolve shared model clients by persisted provider type."""

    def get(self, provider_type: str) -> ModelClient | None:
        raise NotImplementedError


class StaticModelClientRegistry(ModelClientRegistry):
    """Small in-memory registry used by tests and future startup wiring."""

    def __init__(self, clients: Mapping[str, ModelClient] | None = None) -> None:
        self._clients: dict[str, ModelClient] = dict(clients or {})

    def register(self, provider_type: str, client: ModelClient) -> None:
        self._clients[provider_type] = client

    def get(self, provider_type: str) -> ModelClient | None:
        return self._clients.get(provider_type)

    async def aclose(self) -> None:
        """Close each unique registered client once."""

        seen: set[int] = set()
        for client in self._clients.values():
            identity = id(client)
            if identity in seen:
                continue
            seen.add(identity)
            await client.aclose()


__all__ = [
    "ANTHROPIC_TOOL_RESULT_ITEM_TYPE",
    "ANTHROPIC_TOOL_USE_ITEM_TYPE",
    "ModelClient",
    "MODEL_CLIENT_TOOL_CALL_ITEM_TYPE",
    "MODEL_CLIENT_TOOL_RESULT_ITEM_TYPE",
    "ModelClientContinuation",
    "ModelClientDelta",
    "ModelClientError",
    "ModelClientFinal",
    "ModelClientModeration",
    "ModelClientProviderError",
    "ModelClientProviderOptions",
    "ModelClientRequest",
    "ModelClientRegistry",
    "ModelClientRunStatus",
    "ModelClientTimeoutError",
    "ModelClientToolCall",
    "ModelClientToolResult",
    "StaticModelClientRegistry",
    "model_client_event_delta",
    "model_client_run_status_delta",
    "uses_native_context_compaction",
]

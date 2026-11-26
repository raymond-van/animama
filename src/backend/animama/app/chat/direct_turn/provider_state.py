"""Per-turn provider decisions for direct chat: model validation, memory-tool and native-tool
access, reasoning effort, compacted history and Responses continuation cursors.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, replace
from typing import Any, cast

from animama.app.chat.options import DirectChatOptions
from animama.app.model_catalog import CHAT_COMPLETIONS_FUNCTION_TOOL_EFFORT, chat_completions_tools_require_no_reasoning
from animama.app.model_clients import (
    ModelClientContinuation,
    ModelClientError,
    ModelClientFinal,
    ModelClientProviderOptions,
    ModelClientRequest,
)
from animama.app.model_provider_native_tools import (
    normalized_native_tool_support,
    requestable_native_tool_support,
)
from animama.app.safety.moderation import OPENAI_MODERATION_MODEL
from animama.app.util.json_values import json_safe_copy
from animama.domain import ModelProvider
from animama.domain.chat import Chat
from animama.domain.model_connection import (
    BUILTIN_ANTHROPIC_CONNECTION_ID,
    BUILTIN_CHATGPT_PLAN_CONNECTION_ID,
    BUILTIN_OPENAI_CONNECTION_ID,
    MODEL_KIND_CHAT,
    MODEL_SOURCE_OWNER,
)

from .constants import (
    ANTHROPIC_MESSAGES_PROVIDER,
    CHATGPT_PLAN_PROVIDER,
    DIRECT_MEMORY_TOOL_SUPPORT_BY_PROVIDER,
    OPENAI_CHAT_COMPLETIONS_PROVIDER,
    OPENAI_RESPONSES_PREVIOUS_RESPONSE_UNRESOLVABLE_CODE,
    OPENAI_RESPONSES_PROVIDER,
    WEB_SEARCH_NATIVE_TOOL,
)
from .types import DirectChatTurnRequest, DirectChatTurnSetupError


@dataclass(frozen=True, slots=True)
class MemoryToolConfig:
    """Effective direct-memory tool permissions for one turn."""

    allow_reads: bool
    allow_writes: bool

    @property
    def active(self) -> bool:
        return self.allow_reads or self.allow_writes


def memory_tool_config_for_model(config: MemoryToolConfig, model_provider: ModelProvider) -> MemoryToolConfig:
    """Limit memory tools to what the selected model can use.

    A model without tool calling chats without memory tools rather than failing
    the turn, and a model whose owner turned off memory writes gets read tools
    only.
    """

    if not config.active:
        return config
    if (
        not model_provider.capabilities.supports_tools
        or model_provider.provider_type not in DIRECT_MEMORY_TOOL_SUPPORT_BY_PROVIDER
    ):
        return MemoryToolConfig(allow_reads=False, allow_writes=False)
    if not model_provider.allow_memory_writes:
        return MemoryToolConfig(allow_reads=config.allow_reads, allow_writes=False)
    return config


def normalized_string_set(value: object) -> set[str]:
    """Coerce catalog/request capability values into a normalized string set."""

    if value is None:
        return set()
    if isinstance(value, str):
        return {value.strip()} if value.strip() else set()
    try:
        return {str(item).strip() for item in cast(Iterable[object], value) if str(item).strip()}
    except TypeError:
        return set()


def validate_model_provider_for_direct_turn(
    model_provider: ModelProvider,
    *,
    request_options: DirectChatOptions,
    memory_tools_active: bool = False,
) -> None:
    """Validate that the selected persisted provider row can run direct chat."""

    capabilities = model_provider.capabilities
    if not model_provider.active:
        raise DirectChatTurnSetupError(f"Model provider is inactive: {model_provider.id}")
    connection = model_provider.connection
    if connection is not None and not connection.active:
        raise DirectChatTurnSetupError(f"Model connection is inactive: {connection.id}")
    if model_provider.model_kind != MODEL_KIND_CHAT:
        raise DirectChatTurnSetupError(f"Model is not a chat model: {model_provider.id}")
    if model_provider.source == MODEL_SOURCE_OWNER and model_provider.context_window_tokens is None:
        raise DirectChatTurnSetupError(
            f"Set the model's context window in App Settings before chatting: {model_provider.id}"
        )
    if (
        model_provider.provider_type == OPENAI_RESPONSES_PROVIDER
        and model_provider.connection_id != BUILTIN_OPENAI_CONNECTION_ID
    ):
        # Responses requests carry the OpenAI key; only the built-in connection may use them.
        raise DirectChatTurnSetupError(
            f"OpenAI Responses is only available on the built-in OpenAI connection: {model_provider.id}"
        )
    if (model_provider.provider_type == ANTHROPIC_MESSAGES_PROVIDER) != (
        model_provider.connection_id == BUILTIN_ANTHROPIC_CONNECTION_ID
    ):
        # Messages requests carry the Anthropic key, and the Anthropic connection
        # serves nothing else.
        raise DirectChatTurnSetupError(
            f"Anthropic Messages is only available on the built-in Anthropic connection: {model_provider.id}"
        )
    if (model_provider.provider_type == CHATGPT_PLAN_PROVIDER) != (
        model_provider.connection_id == BUILTIN_CHATGPT_PLAN_CONNECTION_ID
    ):
        # Plan requests carry the ChatGPT plan's token, and the plan connection serves nothing else.
        raise DirectChatTurnSetupError(f"The ChatGPT plan is only available on its own connection: {model_provider.id}")
    if not capabilities.supports_streaming:
        raise DirectChatTurnSetupError(f"Model provider does not support streaming chat turns: {model_provider.id}")
    # Structured output is not required: rows without a schema or JSON mode
    # transport are asked for JSON by prompt and fall back to plain text.

    requested_reasoning_effort = request_options.reasoning_effort
    if isinstance(requested_reasoning_effort, str) and requested_reasoning_effort.strip():
        effort = requested_reasoning_effort.strip()
        supported_efforts = normalized_string_set(capabilities.supported_reasoning_efforts)
        if not capabilities.supports_reasoning or effort not in supported_efforts:
            raise DirectChatTurnSetupError(
                f"Model provider does not support requested reasoning effort {effort}: {model_provider.id}"
            )
        if memory_tools_active and reasoning_effort_blocks_function_tools(model_provider, effort):
            # Reject during setup so the SSE stream does not open only to fail
            # on the provider request.
            raise DirectChatTurnSetupError(
                "OpenAI Chat Completions accepts memory function tools for this model only with "
                f"reasoning_effort none: {model_provider.id}. Choose effort none, chat without memory "
                "tools, or use the model's OpenAI Responses row."
            )

    # Web search without hosted support is the application tool, which the
    # executor offers or leaves out; only other native tools must be hosted.
    requested_native_tools = set(request_options.native_tools)
    hosted_tools = set(hosted_native_tools(model_provider, request_options))
    missing_tools = requested_native_tools - hosted_tools - {WEB_SEARCH_NATIVE_TOOL}
    if missing_tools or (hosted_tools and not capabilities.supports_tools):
        tools = ", ".join(sorted(missing_tools or hosted_tools))
        raise DirectChatTurnSetupError(
            f"Model provider does not support requested native tools {tools}: {model_provider.id}"
        )


def hosted_native_tools(model_provider: ModelProvider, request_options: DirectChatOptions) -> tuple[str, ...]:
    """Return the requested native tools the provider hosts (OpenAI Responses or Anthropic web search)."""

    requestable = set(
        requestable_native_tool_support(model_provider.provider_type, model_provider.capabilities.native_tool_support)
    )
    return tuple(tool for tool in request_options.native_tools if tool in requestable)


def wants_application_web_search(model_provider: ModelProvider, request_options: DirectChatOptions) -> bool:
    """Return whether the turn asked for web search that the provider does not host."""

    return WEB_SEARCH_NATIVE_TOOL in request_options.native_tools and WEB_SEARCH_NATIVE_TOOL not in (
        hosted_native_tools(model_provider, request_options)
    )


def reasoning_effort_blocks_function_tools(model_provider: ModelProvider, effort: str | None) -> bool:
    """Return whether the requested effort keeps this turn from sending function tools.

    OpenAI Chat Completions accepts function tools on GPT-5.4 and later only
    at effort ``none``. A turn that names no effort is not blocked: on
    connections that send OpenAI efforts, the request then sends ``none``
    with its tools.
    """

    requested = effort.strip() if isinstance(effort, str) else ""
    return (
        requested not in {"", CHAT_COMPLETIONS_FUNCTION_TOOL_EFFORT}
        and model_provider.provider_type == OPENAI_CHAT_COMPLETIONS_PROVIDER
        and chat_completions_tools_require_no_reasoning(model_provider.model)
    )


def turn_reasoning_effort(request_options: DirectChatOptions) -> str | None:
    """Return the request-level reasoning effort passed to model clients."""

    return request_options.reasoning_effort


def build_memory_tool_config(request_options: DirectChatOptions, *, enabled: bool) -> MemoryToolConfig:
    """Apply incognito and memory-disable flags to direct memory tool access."""

    if not enabled:
        return MemoryToolConfig(allow_reads=False, allow_writes=False)
    return MemoryToolConfig(
        allow_reads=not request_options.disable_memory_influence,
        allow_writes=not request_options.disable_memory_updates and not request_options.incognito,
    )


def native_memory_apply_patch_enabled(
    model_provider: ModelProvider,
    *,
    memory_tool_config: MemoryToolConfig,
) -> bool:
    """Return whether this turn may use Responses-native memory patching."""

    return (
        memory_tool_config.allow_writes
        and model_provider.provider_type == OPENAI_RESPONSES_PROVIDER
        and "apply_patch" in normalized_native_tool_support(model_provider.capabilities.native_tool_support)
    )


def build_model_client_provider_options(
    request_options: DirectChatOptions,
    *,
    model_provider: ModelProvider,
    memory_tool_config: MemoryToolConfig,
    provider_moderation: bool = False,
) -> ModelClientProviderOptions:
    """Build adapter-level options that are not part of prompt messages.

    Provider moderation is requested only for OpenAI Responses, whose built-in
    moderation rides on the same request; other providers are unsupported.
    """

    return ModelClientProviderOptions(
        moderation_model=OPENAI_MODERATION_MODEL
        if provider_moderation and model_provider.provider_type == OPENAI_RESPONSES_PROVIDER
        else None,
        native_tools=hosted_native_tools(model_provider, request_options),
        store=not request_options.incognito,
        memory_apply_patch_enabled=native_memory_apply_patch_enabled(
            model_provider,
            memory_tool_config=memory_tool_config,
        ),
    )


def compiled_context_history(chat_context: Any) -> list[Any]:
    """Combine active compaction context and visible chat messages."""

    return [
        *compaction_context_messages(chat_context),
        *list(getattr(chat_context, "messages", [])),
    ]


def compaction_context_messages(chat_context: Any) -> list[dict[str, str]]:
    """Return developer messages that summarize compacted older history."""

    active_compaction = getattr(chat_context, "active_compaction", None)
    summary_text = getattr(active_compaction, "summary_text", None)
    if not isinstance(summary_text, str) or not summary_text.strip():
        return []
    return [
        {
            "role": "developer",
            "content": (
                "Compacted prior chat history for continuity. "
                "Treat this as historical context, not as a new user instruction.\n"
                f"{summary_text.strip()}"
            ),
        }
    ]


def turn_memory_context_manifest(
    manifest: Mapping[str, Any],
    *,
    request: DirectChatTurnRequest,
    model_provider: ModelProvider,
) -> dict[str, Any]:
    """Build JSON-safe memory manifest metadata persisted with the chat."""

    copied = json_safe_copy(manifest)
    if not isinstance(copied, dict):
        copied = {}
    copied["last_run"] = {
        "run_id": request.run_id,
        "chat_id": request.chat_id,
        "anima_id": request.anima_id,
        "model_provider_id": model_provider.id,
        "provider_type": model_provider.provider_type,
        "model": model_provider.model,
    }
    return copied


def openai_responses_continuation_from_chat(
    chat: Chat,
    model_provider: ModelProvider,
) -> ModelClientContinuation | None:
    """Use a stored OpenAI Responses id as provider-managed conversation state."""

    if model_provider.provider_type != OPENAI_RESPONSES_PROVIDER:
        return None
    cursor = getattr(chat, "openai_previous_response_id", None)
    if not isinstance(cursor, str) or not cursor.strip():
        return None
    return ModelClientContinuation(
        provider_type=OPENAI_RESPONSES_PROVIDER,
        cursor=cursor.strip(),
        metadata={
            "source": "chat_row",
            "chat_id": getattr(chat, "id", None),
            "model": model_provider.model,
        },
    )


def should_skip_context_fetch_for_responses_cursor(
    model_provider: ModelProvider,
    continuation: ModelClientContinuation | None,
) -> bool:
    """Skip explicit history when Responses can continue from provider state."""

    return model_provider.provider_type == OPENAI_RESPONSES_PROVIDER and continuation is not None


def openai_responses_continuation_from_final(
    model_request: ModelClientRequest,
    previous_final: ModelClientFinal | None,
) -> ModelClientContinuation | None:
    """Advance a Responses continuation cursor after a tool-call follow-up."""

    if model_request.model_provider.provider_type != OPENAI_RESPONSES_PROVIDER or previous_final is None:
        return None
    response_id = previous_final.raw_provider_metadata.get("response_id")
    if not isinstance(response_id, str) or not response_id.strip():
        return None
    return ModelClientContinuation(
        provider_type=OPENAI_RESPONSES_PROVIDER,
        cursor=response_id.strip(),
        metadata={
            "source": "tool_call_response",
            "model": model_request.model_provider.model,
        },
    )


def continuation_after_tool_round(
    model_request: ModelClientRequest,
    previous_final: ModelClientFinal | None,
) -> ModelClientContinuation | None:
    """Return the provider state the next round of a turn continues from.

    Responses advances its cursor to the tool-call response. Other providers
    may return their own request-local state on the final: Anthropic carries
    the turn's assistant content blocks so they are resent unchanged.
    """

    responses = openai_responses_continuation_from_final(model_request, previous_final)
    if responses is not None:
        return responses
    continuation = previous_final.continuation if previous_final is not None else None
    if continuation is not None and continuation.provider_type == model_request.model_provider.provider_type:
        return continuation
    return None


def model_request_without_continuation(model_request: ModelClientRequest) -> ModelClientRequest:
    """Copy a model request while dropping provider continuation state."""

    return ModelClientRequest(
        model_provider=model_request.model_provider,
        prompt=model_request.prompt,
        provider_options=model_request.provider_options,
        continuation=None,
    )


def should_retry_without_previous_response_id(
    error: ModelClientError,
    model_request: ModelClientRequest,
    *,
    partial_text_seen: bool,
    allow_previous_response_retry: bool,
) -> bool:
    """Return whether a stale Responses cursor should be retried with history."""

    return (
        allow_previous_response_retry
        and not partial_text_seen
        and error.code == OPENAI_RESPONSES_PREVIOUS_RESPONSE_UNRESOLVABLE_CODE
        and model_request.model_provider.provider_type == OPENAI_RESPONSES_PROVIDER
        and model_request.continuation is not None
    )


def final_with_previous_response_retry_metadata(
    final: ModelClientFinal,
    *,
    model_request: ModelClientRequest,
    error: ModelClientError,
) -> ModelClientFinal:
    """Annotate a successful retry with the stale cursor that was ignored."""

    raw_provider_metadata = dict(final.raw_provider_metadata)
    stale_cursor = model_request.continuation.cursor if model_request.continuation is not None else None
    raw_provider_metadata["previous_response_retry"] = {
        "code": error.code,
        "stale_previous_response_id": stale_cursor,
        "fallback": "manual_context_without_previous_response_id",
    }
    return replace(final, raw_provider_metadata=raw_provider_metadata)


__all__ = [
    "MemoryToolConfig",
    "hosted_native_tools",
    "wants_application_web_search",
    "build_memory_tool_config",
    "build_model_client_provider_options",
    "compiled_context_history",
    "continuation_after_tool_round",
    "native_memory_apply_patch_enabled",
    "final_with_previous_response_retry_metadata",
    "model_request_without_continuation",
    "normalized_string_set",
    "openai_responses_continuation_from_chat",
    "openai_responses_continuation_from_final",
    "reasoning_effort_blocks_function_tools",
    "should_retry_without_previous_response_id",
    "should_skip_context_fetch_for_responses_cursor",
    "turn_memory_context_manifest",
    "turn_reasoning_effort",
    "validate_model_provider_for_direct_turn",
]

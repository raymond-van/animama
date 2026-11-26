from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from hashlib import sha256
from types import MappingProxyType
from typing import Any, Final, cast

from openai.types.chat import (
    ChatCompletionMessageParam,
    ChatCompletionStreamOptionsParam,
    ChatCompletionToolChoiceOptionParam,
    ChatCompletionToolUnionParam,
    completion_create_params,
)
from openai.types.shared.reasoning_effort import ReasoningEffort as ChatCompletionReasoningEffort

from .frozen import frozen_mapping
from .image_parts import message_text

ChatCompletionResponseFormat = completion_create_params.ResponseFormat


def _copy_jsonish(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _copy_jsonish(item) for key, item in value.items()}
    if isinstance(value, tuple | list):
        return [_copy_jsonish(item) for item in value]
    if isinstance(value, set | frozenset):
        return sorted(_copy_jsonish(item) for item in value)
    return value


@dataclass(frozen=True, slots=True)
class DirectChatPrompt:
    """OpenAI Chat Completions-compatible prompt for one model-client turn."""

    messages: tuple[Mapping[str, object], ...]
    response_format: ChatCompletionResponseFormat | None = None
    tools: tuple[ChatCompletionToolUnionParam, ...] = ()
    tool_choice: ChatCompletionToolChoiceOptionParam | None = None
    parallel_tool_calls: bool | None = None
    stream_options: ChatCompletionStreamOptionsParam | None = None
    prompt_cache_key: str | None = None
    reasoning_effort: ChatCompletionReasoningEffort | None = None
    metadata: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "messages",
            tuple(cast(Mapping[str, object], _copy_jsonish(message)) for message in self.messages),
        )
        object.__setattr__(
            self,
            "tools",
            tuple(cast(ChatCompletionToolUnionParam, _copy_jsonish(tool)) for tool in self.tools),
        )
        object.__setattr__(self, "metadata", frozen_mapping(self.metadata))


def direct_model_prompt(
    *,
    prompt: str,
    instructions: str | None = None,
    metadata: Mapping[str, Any] | None = None,
    response_format: ChatCompletionResponseFormat | None = None,
    stream_options: ChatCompletionStreamOptionsParam | None = None,
    prompt_cache_key: str | None = None,
    reasoning_effort: str | None = None,
) -> DirectChatPrompt:
    """Build a prompt-only request for backend maintenance model calls."""

    messages: list[ChatCompletionMessageParam] = []
    instruction_text = instructions.strip() if isinstance(instructions, str) else ""
    if instruction_text:
        messages.append(cast(ChatCompletionMessageParam, {"role": "system", "content": instruction_text}))
    messages.append(cast(ChatCompletionMessageParam, {"role": "user", "content": prompt}))
    return DirectChatPrompt(
        messages=tuple(messages),
        response_format=response_format,
        stream_options=stream_options or {"include_usage": True},
        prompt_cache_key=prompt_cache_key,
        reasoning_effort=cast(ChatCompletionReasoningEffort | None, reasoning_effort.strip())
        if isinstance(reasoning_effort, str) and reasoning_effort.strip()
        else None,
        metadata=metadata or {},
    )


_UNSET: Final = object()


def copy_direct_chat_prompt(
    prompt: DirectChatPrompt,
    *,
    messages: Any = _UNSET,
    response_format: Any = _UNSET,
    tools: Any = _UNSET,
    tool_choice: Any = _UNSET,
    parallel_tool_calls: Any = _UNSET,
) -> DirectChatPrompt:
    """Copy a direct-chat prompt while replacing the fields used by stream retries."""

    return DirectChatPrompt(
        messages=prompt.messages if messages is _UNSET else tuple(messages),
        response_format=prompt.response_format if response_format is _UNSET else response_format,
        tools=prompt.tools if tools is _UNSET else tuple(tools),
        tool_choice=prompt.tool_choice if tool_choice is _UNSET else tool_choice,
        parallel_tool_calls=prompt.parallel_tool_calls if parallel_tool_calls is _UNSET else parallel_tool_calls,
        stream_options=prompt.stream_options,
        prompt_cache_key=prompt.prompt_cache_key,
        reasoning_effort=prompt.reasoning_effort,
        metadata=prompt.metadata,
    )


def scoped_prompt_cache_key(
    *,
    user_id: str,
    anima_id: str,
    provider_type: str,
    model: str,
) -> str | None:
    parts = [
        str(user_id or "").strip(),
        str(anima_id or "").strip(),
        str(provider_type or "").strip(),
        str(model or "").strip(),
    ]
    if not all(parts):
        return None
    return sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


def prompt_instruction_text(prompt: DirectChatPrompt) -> str | None:
    sections: list[str] = []
    for message in prompt.messages:
        if _message_role(message) not in {"system", "developer"}:
            continue
        content = _message_content_text(message)
        if content:
            sections.append(content)
    return "\n\n".join(sections) if sections else None


def prompt_messages(prompt: DirectChatPrompt) -> list[dict[str, Any]]:
    return cast(list[dict[str, Any]], _copy_jsonish(prompt.messages))


def prompt_tools(prompt: DirectChatPrompt) -> list[dict[str, Any]]:
    return cast(list[dict[str, Any]], _copy_jsonish(prompt.tools))


def prompt_last_user_message(prompt: DirectChatPrompt, *, fallback: str) -> str:
    for message in reversed(prompt.messages):
        if _message_role(message) != "user":
            continue
        content = _message_content_text(message)
        if content:
            return content
    return fallback


def _message_role(message: Mapping[str, Any]) -> str:
    return str(message.get("role") or "").strip().lower()


def _message_content_text(message: Mapping[str, Any]) -> str | None:
    return message_text(message.get("content")) or None


__all__ = [
    "ChatCompletionReasoningEffort",
    "ChatCompletionResponseFormat",
    "DirectChatPrompt",
    "copy_direct_chat_prompt",
    "direct_model_prompt",
    "prompt_instruction_text",
    "prompt_last_user_message",
    "prompt_messages",
    "prompt_tools",
    "scoped_prompt_cache_key",
]

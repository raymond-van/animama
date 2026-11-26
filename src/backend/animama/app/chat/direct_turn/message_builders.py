"""Builds the prompt, history and persisted chat messages of a direct turn, including
provider-shaped tool-call and tool-result items.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any, cast

from animama.app.chat.memory_cue import MESSAGE_DATA_MEMORY_KEY
from animama.app.model_clients import (
    ANTHROPIC_TOOL_RESULT_ITEM_TYPE,
    ANTHROPIC_TOOL_USE_ITEM_TYPE,
    MODEL_CLIENT_TOOL_CALL_ITEM_TYPE,
    MODEL_CLIENT_TOOL_RESULT_ITEM_TYPE,
    ModelClientFinal,
    ModelClientToolCall,
    ModelClientToolResult,
)
from animama.app.model_clients.event_summary import DEFAULT_STREAM_EVENT_SUMMARY_METADATA_KEY
from animama.app.model_clients.image_parts import image_part, image_placeholder
from animama.app.util.json_values import json_safe_copy, safe_json_loads
from animama.domain import ModelProvider
from animama.domain.chat import ChatMessage, MessageRole
from animama.domain.usage import Usage

from .constants import ANTHROPIC_MESSAGES_PROVIDER, OPENAI_RESPONSES_PROVIDER
from .types import DirectChatTurnRequest


def user_provider_message(content: str, *, images: Sequence[Mapping[str, Any]] = ()) -> dict[str, Any]:
    """Build the persisted provider-shaped user message.

    A message with images keeps their references before its text, as the prompt
    does, so later turns replay them.
    """

    if not images:
        return {"role": "user", "content": content}
    return {"role": "user", "content": [*images, {"type": "text", "text": content}]}


def attached_image_parts(request: DirectChatTurnRequest) -> list[dict[str, Any]]:
    """The image parts of the turn's own message, in the order they were attached."""

    return [
        image_part(file_id=image.file_id, name=image.name, width=image.width, height=image.height)
        for image in request.attached_images
    ]


def user_message_text(request: DirectChatTurnRequest) -> str:
    """The saved text of the user's message, with a placeholder line per image.

    Compaction, memory and search read this column, so each image
    is named there.
    """

    if not request.attached_images:
        return request.user_message
    placeholders = "\n".join(image_placeholder(image.name) for image in request.attached_images)
    return f"{request.user_message}\n\n{placeholders}"


def user_message_data(request: DirectChatTurnRequest) -> dict[str, Any] | None:
    """The saved data of the user's message: its attachments, and for images the person's own text."""

    data: dict[str, Any] = {}
    if request.attached_file_ids:
        data["attached_file_ids"] = list(request.attached_file_ids)
    if request.attached_images:
        data["images"] = [
            {key: value for key, value in part.items() if key != "type"} for part in attached_image_parts(request)
        ]
        # The chat shows this text beside the images instead of the placeholder lines.
        data["user_text"] = request.user_message
    return data or None


def assistant_tool_call_prompt_message(
    tool_calls: tuple[ModelClientToolCall, ...],
) -> dict[str, Any]:
    """Build an OpenAI-compatible assistant message containing function calls."""

    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": tool_call.id,
                "type": "function",
                "function": {
                    "name": tool_call.name,
                    "arguments": tool_call.arguments,
                },
            }
            for tool_call in tool_calls
        ],
    }


def tool_result_prompt_message(tool_call: ModelClientToolCall, tool_result: str) -> dict[str, Any]:
    """Build an OpenAI-compatible tool-result message for a function call."""

    return {
        "role": "tool",
        "tool_call_id": tool_call.id,
        "content": tool_result,
    }


def model_client_tool_call_prompt_item(tool_call: ModelClientToolCall) -> dict[str, Any]:
    """Build one provider-neutral tool-call history item for Responses."""

    return {
        "type": MODEL_CLIENT_TOOL_CALL_ITEM_TYPE,
        "call_id": tool_call.id,
        "tool_type": tool_call.tool_type,
        "name": tool_call.name,
        "arguments": tool_call.arguments,
    }


def model_client_tool_result_prompt_item(tool_result: ModelClientToolResult) -> dict[str, Any]:
    """Build one provider-neutral tool-result history item for Responses."""

    return {
        "type": MODEL_CLIENT_TOOL_RESULT_ITEM_TYPE,
        "call_id": tool_result.call_id,
        "tool_type": tool_result.tool_type,
        "status": tool_result.status,
        "output": tool_result.output,
    }


def anthropic_tool_use_item(tool_call: ModelClientToolCall) -> dict[str, Any]:
    """Build one Anthropic ``tool_use`` prompt/history item; the input is the parsed JSON object."""

    arguments = safe_json_loads(tool_call.arguments)
    return {
        "type": ANTHROPIC_TOOL_USE_ITEM_TYPE,
        "id": tool_call.id,
        "name": tool_call.name,
        "input": arguments if isinstance(arguments, Mapping) else {},
    }


def anthropic_tool_result_item(tool_call: ModelClientToolCall, output: str) -> dict[str, Any]:
    """Build one Anthropic ``tool_result`` prompt/history item for a tool call's output."""

    return {"type": ANTHROPIC_TOOL_RESULT_ITEM_TYPE, "tool_use_id": tool_call.id, "content": output}


def internal_tool_call_message(
    *,
    request: DirectChatTurnRequest,
    model_provider: ModelProvider,
    tool_calls: tuple[ModelClientToolCall, ...],
    raw_provider_message: dict[str, Any],
) -> ChatMessage:
    """Persist an internal assistant tool-call transcript entry."""

    payload = {
        "tool_calls": [
            {
                "id": tool_call.id,
                "name": tool_call.name,
                "arguments": safe_json_loads(tool_call.arguments),
                "tool_type": tool_call.tool_type,
            }
            for tool_call in tool_calls
        ]
    }
    return ChatMessage(
        id=None,
        chat_id=request.chat_id,
        run_id=request.run_id,
        message_type="tool_call",
        role=MessageRole.ASSISTANT,
        content=json.dumps(raw_provider_message, ensure_ascii=True, separators=(",", ":")),
        data={"memory_tools": payload},
        usage=None,
        turn=None,
        created_at=None,
        model=model_provider.model,
        model_provider=model_provider.provider_type,
        internal=True,
        raw_provider_message=raw_provider_message,
    )


def internal_tool_result_message(
    *,
    request: DirectChatTurnRequest,
    model_provider: ModelProvider,
    tool_call: ModelClientToolCall,
    tool_result: ModelClientToolResult,
    raw_provider_message: dict[str, Any],
) -> ChatMessage:
    """Persist an internal direct memory tool-result transcript entry."""

    data = {
        "memory_tool_result": {
            "tool_call_id": tool_call.id,
            "tool_name": tool_call.name,
            "tool_type": tool_call.tool_type,
            "status": tool_result.status,
            "ok": tool_result_ok(tool_result.output),
        }
    }
    return ChatMessage(
        id=None,
        chat_id=request.chat_id,
        run_id=request.run_id,
        message_type="tool_result",
        role=MessageRole.TOOL,
        content=tool_result.output,
        data=data,
        usage=None,
        turn=None,
        created_at=None,
        model=model_provider.model,
        model_provider=model_provider.provider_type,
        internal=True,
        raw_provider_message=raw_provider_message,
    )


def tool_result_ok(value: str) -> bool | None:
    """Extract the boolean success flag from a JSON tool result when present."""

    parsed = safe_json_loads(value)
    if isinstance(parsed, Mapping) and isinstance(parsed.get("ok"), bool):
        return bool(parsed["ok"])
    return None


def chat_metadata_patch_from_prompt(prompt: Any) -> dict[str, Any] | None:
    """Return chat metadata that should be refreshed after a successful turn."""

    metadata = getattr(prompt, "metadata", None)
    if not isinstance(metadata, Mapping):
        return None
    memory_context = metadata.get("memory_context")
    if not isinstance(memory_context, Mapping):
        return None
    return {"memory_context": json_safe_copy(memory_context)}


def assistant_messages_for_persistence(
    *,
    request: DirectChatTurnRequest,
    structured: Mapping[str, Any],
    final: ModelClientFinal,
    model_provider: ModelProvider,
    internal_tool_messages: list[ChatMessage] | None = None,
    memory: Mapping[str, Any] | None = None,
    structured_recovery: str | None = None,
    replay_text: str | None = None,
) -> ChatMessage | list[ChatMessage]:
    """Build final assistant history rows, including any internal tool rows.

    ``memory`` is the turn's memory block, stored on the final visible message.
    ``structured_recovery`` records how an invalid reply was recovered
    (``repaired``, ``salvaged`` or ``plain_text``). ``replay_text`` replaces the
    final text as the stored content and replayed provider message, so later
    turns see a valid structured reply.
    """

    content = final.text if replay_text is None else replay_text
    assistant_msg = assistant_message(
        request=request,
        content=content,
        structured=structured,
        final=final,
        model_provider=model_provider,
        usage=final.usage,
        raw_provider_message=assistant_replay_message(
            content, model_provider=model_provider, replay_prefix=final.replay_prefix
        ),
        memory=memory,
        structured_recovery=structured_recovery,
    )
    if internal_tool_messages:
        return [*internal_tool_messages, assistant_msg]
    return assistant_msg


def assistant_replay_message(
    content: str,
    *,
    model_provider: ModelProvider,
    replay_prefix: tuple[Mapping[str, Any], ...] = (),
) -> dict[str, Any]:
    """Return the provider-shaped assistant message replayed in later turns.

    Anthropic rows store the turn's latest compaction block, when the server
    compacted, then the reply's text content block. Thinking blocks and raw
    web-search blocks are never replayed across turns (D8), and the turn's
    context message is rebuilt each turn rather than stored.
    """

    if model_provider.provider_type == ANTHROPIC_MESSAGES_PROVIDER:
        prefix = [json_safe_copy(block) for block in replay_prefix]
        return {"role": "assistant", "content": [*prefix, {"type": "text", "text": content}]}
    return {"role": "assistant", "content": content}


def assistant_message(
    *,
    request: DirectChatTurnRequest,
    content: str,
    structured: Mapping[str, Any],
    final: ModelClientFinal,
    model_provider: ModelProvider,
    usage: Usage | None,
    raw_provider_message: dict[str, Any],
    memory: Mapping[str, Any] | None = None,
    structured_recovery: str | None = None,
) -> ChatMessage:
    """Build the public assistant message that will be written to chat history."""

    return ChatMessage(
        id=None,
        chat_id=request.chat_id,
        run_id=request.run_id,
        message_type="message",
        role=MessageRole.ASSISTANT,
        content=content,
        data=assistant_message_data(
            structured=structured,
            final=final,
            model_provider=model_provider,
            memory=memory,
            structured_recovery=structured_recovery,
        ),
        usage=usage,
        turn=None,
        created_at=None,
        model=model_provider.model,
        model_provider=model_provider.provider_type,
        raw_provider_message=raw_provider_message,
    )


def assistant_message_data(
    *,
    structured: Mapping[str, Any],
    final: ModelClientFinal,
    model_provider: ModelProvider,
    memory: Mapping[str, Any] | None = None,
    structured_recovery: str | None = None,
) -> dict[str, Any]:
    """Build JSONB-safe assistant `message_data` for durable chat history.

    ``memory`` becomes `message_data["memory"]`: whether memory updates were
    enabled for the turn and its successful `MEMORIES.md` change, if any.
    ``structured_recovery`` becomes `message_data["structured_recovery"]`.
    """

    raw_provider_metadata = json_safe_copy(final.raw_provider_metadata)
    data: dict[str, Any] = {
        "structured": json_safe_copy(structured),
        "model_client": {
            "provider_type": model_provider.provider_type,
            "model_provider_id": model_provider.id,
            "raw_provider_metadata": raw_provider_metadata,
        },
    }
    openai_metadata = openai_metadata_from_final(raw_provider_metadata, model_provider=model_provider)
    if openai_metadata is not None:
        data["openai"] = openai_metadata
    anthropic_metadata = raw_provider_metadata.get("anthropic") if isinstance(raw_provider_metadata, dict) else None
    if model_provider.provider_type == ANTHROPIC_MESSAGES_PROVIDER and isinstance(anthropic_metadata, dict):
        # Message id, stop reason and details, usage (with iterations) and block types.
        data["anthropic"] = anthropic_metadata
    if memory is not None:
        data[MESSAGE_DATA_MEMORY_KEY] = json_safe_copy(memory)
    if structured_recovery is not None:
        data["structured_recovery"] = structured_recovery
    return data


def openai_metadata_from_final(
    raw_provider_metadata: Mapping[str, Any],
    *,
    model_provider: ModelProvider,
) -> dict[str, Any] | None:
    """Extract Responses continuation/phase metadata for later prompt assembly."""

    if model_provider.provider_type != OPENAI_RESPONSES_PROVIDER:
        return None
    response_id = raw_provider_metadata.get("response_id")
    if not isinstance(response_id, str) or not response_id.strip():
        return None
    keys = {
        "provider",
        "api",
        "model",
        "response_id",
        "previous_response_id",
        "output_item_ids",
        "message_item_ids",
        "message_phases",
        "native_tool_summaries",
        "output_item_id",
        "output_index",
        "annotations",
        "phase",
        "phase_counts",
        "service_tier",
        DEFAULT_STREAM_EVENT_SUMMARY_METADATA_KEY,
        "unknown_output_item_types",
    }
    metadata = cast(
        dict[str, Any],
        json_safe_copy({key: raw_provider_metadata[key] for key in keys if key in raw_provider_metadata}),
    )
    metadata["provider"] = OPENAI_RESPONSES_PROVIDER
    metadata["api"] = "responses"
    metadata.setdefault("model", model_provider.model)
    metadata["response_id"] = response_id.strip()
    return metadata


__all__ = [
    "anthropic_tool_result_item",
    "anthropic_tool_use_item",
    "assistant_messages_for_persistence",
    "assistant_replay_message",
    "assistant_tool_call_prompt_message",
    "attached_image_parts",
    "chat_metadata_patch_from_prompt",
    "internal_tool_call_message",
    "internal_tool_result_message",
    "model_client_tool_call_prompt_item",
    "model_client_tool_result_prompt_item",
    "tool_result_prompt_message",
    "user_message_data",
    "user_message_text",
    "user_provider_message",
]

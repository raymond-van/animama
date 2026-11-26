"""Translates provider-neutral model-client requests into OpenAI Responses SDK arguments:
input items, tools, text format, continuation and server-side compaction.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Literal, cast

from openai.types.responses import (
    ApplyPatchToolParam,
    FunctionToolParam,
    NamespaceToolParam,
    ResponseFunctionToolCallParam,
    ResponseInputItemParam,
    ResponseTextConfigParam,
    ToolParam,
)
from openai.types.responses.response_create_params import (
    ContextManagement,
    ResponseCreateParamsStreaming,
)
from openai.types.responses.response_input_param import ApplyPatchCall, ApplyPatchCallOutput
from openai.types.shared.reasoning_effort import ReasoningEffort

from animama.adapters.model_clients._common import image_data_url, jsonable, openai_cache_breakpoint_text_part
from animama.app.model_clients import (
    MODEL_CLIENT_TOOL_CALL_ITEM_TYPE,
    MODEL_CLIENT_TOOL_RESULT_ITEM_TYPE,
    ModelClientRequest,
)
from animama.app.model_clients.image_parts import ModelClientImage, message_text, resolved_parts
from animama.app.model_clients.prompt import (
    prompt_last_user_message,
    prompt_messages,
    prompt_tools,
)
from animama.domain.model_connection import BUILTIN_OPENAI_CONNECTION_ID

from .reasoning import REASONING_INCLUDE, reasoning_entries, with_reasoning
from .routes import OPENAI_API_ROUTE, ResponsesRoute
from .support import (
    OPENAI_RESPONSES_ASSISTANT_PHASES,
    OPENAI_RESPONSES_ASSISTANT_PHASES_KEY,
    OPENAI_RESPONSES_HISTORY_METADATA_KEY,
    OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
    clean_str,
)

DEFAULT_WEB_SEARCH_CONTEXT_SIZE = "low"
_APPLY_PATCH_ITEM_TYPES = frozenset({"apply_patch_call", "apply_patch_call_output"})
# Native compaction runs once a stored chain reaches this many input tokens.
# ANIMAMA_OPENAI_RESPONSES_COMPACTION_THRESHOLD_TOKENS sets it for the server.
DEFAULT_RESPONSES_COMPACTION_THRESHOLD_TOKENS = 90_000


def create_response_kwargs(
    spec: ModelClientRequest,
    previous_response_id: str | None,
    *,
    timeout: float | None,
    compaction_threshold_tokens: int | None = DEFAULT_RESPONSES_COMPACTION_THRESHOLD_TOKENS,
    route: ResponsesRoute = OPENAI_API_ROUTE,
) -> dict[str, Any]:
    """Translate a provider-neutral request into Responses SDK kwargs for ``route``."""

    if not route.chain_stored_responses:
        previous_response_id = None
    store = spec.provider_options.store if route.chain_stored_responses else False
    payload: ResponseCreateParamsStreaming = {
        "model": spec.model_provider.model,
        "input": responses_input_items(spec, has_previous_response_id=previous_response_id is not None, route=route),
        "stream": True,
        "store": True if store is None else store,
    }
    if spec.limits is not None and route.output_limits:
        payload["max_output_tokens"] = spec.limits.max_output_tokens
        if spec.limits.max_native_tool_calls is not None:
            payload["max_tool_calls"] = spec.limits.max_native_tool_calls
    instructions = _stable_instructions(spec.prompt.messages)
    if instructions is not None:
        # Only the stable system message goes in `instructions`, which render
        # first and are resent on every request (previous_response_id does not
        # carry them forward). Per-turn text there would miss the whole cache,
        # so the turn context travels as a developer input item instead.
        payload["instructions"] = instructions
    moderation_model = spec.provider_options.moderation_model
    if moderation_model is not None and route.inline_moderation:
        # Built-in moderation scores ride on this request (report-only; no extra call).
        payload["moderation"] = {"model": moderation_model}
    cache_key = spec.prompt.prompt_cache_key
    if cache_key is not None:
        payload["prompt_cache_key"] = cache_key
    if previous_response_id is not None:
        payload["previous_response_id"] = previous_response_id
    text_format = responses_text_format(spec.prompt.response_format)
    if text_format is not None:
        payload["text"] = text_format
    reasoning_effort = spec.prompt.reasoning_effort
    if isinstance(reasoning_effort, str) and reasoning_effort.strip():
        payload["reasoning"] = {"effort": cast(ReasoningEffort, reasoning_effort.strip())}
    if route.replay_reasoning:
        payload["include"] = [REASONING_INCLUDE]
    context_management = responses_context_management(compaction_threshold_tokens) if route.native_compaction else []
    if context_management:
        payload["context_management"] = context_management
    requested_tools = {str(value).strip() for value in (spec.provider_options.native_tools or ())}
    tools = responses_tools(
        sorted(requested_tools & route.hosted_tools),
        prompt_tools(spec.prompt),
        memory_apply_patch_enabled=spec.provider_options.memory_apply_patch_enabled
        and "apply_patch" in route.hosted_tools,
        function_tool_namespace=route.function_tool_namespace,
    )
    if tools:
        payload["tools"] = tools
        if spec.prompt.tool_choice is not None:
            payload["tool_choice"] = cast(Any, jsonable(spec.prompt.tool_choice))
        if spec.prompt.parallel_tool_calls is not None:
            payload["parallel_tool_calls"] = bool(spec.prompt.parallel_tool_calls)
    kwargs = cast(dict[str, Any], payload)
    if timeout is not None:
        kwargs["timeout"] = timeout
    return kwargs


def responses_context_management(compaction_threshold_tokens: int | None) -> list[ContextManagement]:
    """Build server-side compaction config for Responses auto-compaction."""

    if not isinstance(compaction_threshold_tokens, int) or compaction_threshold_tokens <= 0:
        return []
    return [
        {
            "type": "compaction",
            "compact_threshold": compaction_threshold_tokens,
        }
    ]


def responses_input_items(
    spec: ModelClientRequest, *, has_previous_response_id: bool, route: ResponsesRoute = OPENAI_API_ROUTE
) -> list[ResponseInputItemParam]:
    """Build Responses input items from the prompt messages after the leading system message.

    With previous_response_id the stored response already holds earlier items,
    so only new ones are sent: on a turn's first request the turn-context
    developer item (when the turn has context) and the user message (plus any
    instruction after them), and
    on a tool continuation the trailing tool outputs (plus a forced-final or
    repair instruction after them). Without a cursor the whole history is
    replayed in the same order, with explicit cache breakpoints on the last two
    history user messages on the built-in OpenAI connection.
    """

    messages = prompt_messages(spec.prompt)
    first = 1 if messages and _message_role(messages[0]) == "system" else 0
    breakpoint_indexes: set[int] = set()
    if has_previous_response_id:
        indexes = _indexes_after_stored_response(messages, first=first)
    else:
        indexes = list(range(first, len(messages)))
        if spec.model_provider.connection_id == BUILTIN_OPENAI_CONNECTION_ID:
            breakpoint_indexes = _history_user_breakpoint_indexes(messages, first=first)
    assistant_phases_by_message_index = _assistant_phase_by_message_index(spec.prompt.metadata)
    items: list[ResponseInputItemParam] = []
    for index in indexes:
        items.extend(
            _input_items_from_message(
                messages[index],
                phase=assistant_phases_by_message_index.get(index),
                cache_breakpoint=index in breakpoint_indexes,
                images=spec.images,
            )
        )
    if "apply_patch" not in route.hosted_tools:
        # A chat that moved from a key model replays its native memory edits; this
        # route refuses that tool. The edits are applied and the replies stay.
        items = [item for item in items if cast(dict[str, Any], item).get("type") not in _APPLY_PATCH_ITEM_TYPES]
    items = items or [_easy_input_message("user", prompt_last_user_message(spec.prompt, fallback=""))]
    items = [_for_route(item, route) for item in items]
    if route.replay_reasoning:
        items = with_reasoning(items, reasoning_entries(spec.continuation, provider_type=route.provider_type))
    return items


def _for_route(item: ResponseInputItemParam, route: ResponsesRoute) -> ResponseInputItemParam:
    """Adjust one input item to what ``route`` accepts: no system role, and calls named in their namespace."""

    raw = cast(dict[str, Any], item)
    if route.developer_role_for_system_items and raw.get("role") == "system":
        return cast(ResponseInputItemParam, {**raw, "role": "developer"})
    if route.function_tool_namespace is not None and raw.get("type") == "function_call":
        return cast(ResponseInputItemParam, {**raw, "namespace": route.function_tool_namespace})
    return item


def _stable_instructions(messages: tuple[Mapping[str, object], ...]) -> str | None:
    """Return the leading system message text, which is the turn's stable instructions."""

    if not messages or _message_role(messages[0]) != "system":
        return None
    content = messages[0].get("content")
    return content if isinstance(content, str) and content else None


def _indexes_after_stored_response(messages: list[dict[str, Any]], *, first: int) -> list[int]:
    """Return the indexes of messages the stored response does not yet hold."""

    tail: list[int] = []
    index = len(messages) - 1
    while index >= first and (_is_instruction_message(messages[index]) or _is_call_output(messages[index])):
        tail.append(index)
        index -= 1
    tail.reverse()
    if any(_is_call_output(messages[index]) for index in tail):
        # A continuation after tool calls: their outputs, then any instruction added after them.
        return tail
    user_indexes = [index for index in range(first, len(messages)) if _message_role(messages[index]) == "user"]
    if not user_indexes:
        return []
    start = user_indexes[-1]
    # The turn context is the developer message directly before the user message.
    while start - 1 >= first and _message_role(messages[start - 1]) == "developer":
        start -= 1
    return list(range(start, len(messages)))


def _history_user_breakpoint_indexes(messages: list[dict[str, Any]], *, first: int) -> set[int]:
    """Return the last two user messages before the turn's own user message.

    Responses assistant ``output_text`` parts cannot carry a breakpoint, so the
    history cache is marked on user messages: the earlier one reads the entry
    the previous request wrote, and the later one writes the next.
    """

    user_indexes = [
        index
        for index in range(first, len(messages))
        if _message_role(messages[index]) == "user" and message_text(messages[index].get("content"))
    ]
    return set(user_indexes[:-1][-2:])


def _input_items_from_message(
    message: Mapping[str, Any],
    *,
    phase: str | None,
    cache_breakpoint: bool,
    images: Mapping[str, ModelClientImage] | None = None,
) -> list[ResponseInputItemParam]:
    """Convert one prompt message into Responses input items."""

    exchange_item = _model_client_exchange_input_item(message)
    if exchange_item is not None:
        return [exchange_item]
    role = _message_role(message)
    if role == "tool":
        tool_output = _function_call_output_from_tool_message(message)
        return [tool_output] if tool_output is not None else []
    if role == "assistant":
        tool_calls = _function_call_items_from_assistant_message(message)
        if tool_calls:
            return tool_calls
    content = message.get("content")
    if role == "user" and isinstance(content, list | tuple):
        parts = _user_content_parts(content, images or {}, cache_breakpoint=cache_breakpoint)
        return [cast(ResponseInputItemParam, {"role": "user", "content": parts})] if parts else []
    if not isinstance(content, str) or not content:
        return []
    if role not in {"user", "assistant", "developer", "system"}:
        role = "user"
    if cache_breakpoint and role == "user":
        part = openai_cache_breakpoint_text_part(content, part_type="input_text")
        return [cast(ResponseInputItemParam, {"role": "user", "content": [part]})]
    return [_easy_input_message(role, content, phase=phase if role == "assistant" else None)]


def _user_content_parts(
    content: list[Any] | tuple[Any, ...],
    images: Mapping[str, ModelClientImage],
    *,
    cache_breakpoint: bool,
) -> list[dict[str, Any]]:
    """Map a user message with images to ``input_image`` and ``input_text`` parts.

    An image whose bytes the request does not carry is sent as its placeholder
    text. A cache breakpoint goes on the message's last part, which either part
    type may carry.
    """

    parts: list[dict[str, Any]] = [
        {"type": "input_text", "text": part}
        if isinstance(part, str)
        # The SDK types ``detail`` as required; "auto" is the documented default.
        else {"type": "input_image", "image_url": image_data_url(part), "detail": "auto"}
        for part in resolved_parts(content, images)
    ]
    if cache_breakpoint and parts:
        parts[-1] = {**parts[-1], "prompt_cache_breakpoint": {"mode": "explicit"}}
    return parts


def _message_role(message: Mapping[str, Any]) -> str:
    return str(message.get("role") or "").strip().lower()


def _is_instruction_message(message: Mapping[str, Any]) -> bool:
    return message.get("type") is None and _message_role(message) in {"system", "developer"}


def _is_call_output(message: Mapping[str, Any]) -> bool:
    return _message_role(message) == "tool" or message.get("type") == MODEL_CLIENT_TOOL_RESULT_ITEM_TYPE


def previous_response_id(spec: ModelClientRequest) -> str | None:
    """Return a Responses continuation cursor from a model-client request."""

    continuation = spec.continuation
    if continuation is None:
        return None
    if continuation.provider_type != OPENAI_RESPONSES_HTTP_PROVIDER_TYPE:
        return None
    cursor = continuation.cursor.strip()
    return cursor or None


def _easy_input_message(role: str, content: str, *, phase: str | None = None) -> ResponseInputItemParam:
    """Build a Responses easy input item, preserving assistant phase if valid."""

    item: dict[str, Any] = {"role": role, "content": content}
    if role == "assistant" and phase in OPENAI_RESPONSES_ASSISTANT_PHASES:
        item["phase"] = phase
    return cast(ResponseInputItemParam, item)


def _assistant_phase_by_message_index(metadata: Mapping[str, Any]) -> dict[int, str]:
    """Read persisted assistant phases for explicit-history Responses prompts."""

    history = metadata.get(OPENAI_RESPONSES_HISTORY_METADATA_KEY)
    if not isinstance(history, Mapping):
        return {}
    raw_phases = history.get(OPENAI_RESPONSES_ASSISTANT_PHASES_KEY)
    if not isinstance(raw_phases, Mapping):
        return {}
    phases: dict[int, str] = {}
    for raw_index, raw_phase in raw_phases.items():
        try:
            index = int(raw_index)
        except (TypeError, ValueError):
            continue
        if not isinstance(raw_phase, str):
            continue
        phase = raw_phase.strip()
        if phase in OPENAI_RESPONSES_ASSISTANT_PHASES:
            phases[index] = phase
    return phases


def _model_client_exchange_input_item(message: Mapping[str, Any]) -> ResponseInputItemParam | None:
    item_type = message.get("type")
    if item_type == MODEL_CLIENT_TOOL_CALL_ITEM_TYPE:
        return _model_client_tool_call_input_item(message)
    if item_type == MODEL_CLIENT_TOOL_RESULT_ITEM_TYPE:
        return _model_client_tool_result_input_item(message)
    return None


def _model_client_tool_call_input_item(message: Mapping[str, Any]) -> ResponseInputItemParam | None:
    call_id = clean_str(message.get("call_id"))
    tool_type = clean_str(message.get("tool_type"))
    if call_id is None or tool_type is None:
        return None
    arguments = message.get("arguments")
    if tool_type == "function":
        name = clean_str(message.get("name"))
        if name is None:
            return None
        item: ResponseFunctionToolCallParam = {
            "type": "function_call",
            "call_id": call_id,
            "name": name,
            "arguments": arguments if isinstance(arguments, str) else "",
            "status": "completed",
        }
        return cast(ResponseInputItemParam, item)
    if tool_type != "apply_patch":
        return None
    operation = _operation_from_arguments(arguments)
    if operation is None:
        return None
    patch_item: ApplyPatchCall = {
        "type": "apply_patch_call",
        "call_id": call_id,
        "operation": cast(Any, operation),
        "status": "completed",
    }
    return cast(ResponseInputItemParam, patch_item)


def _model_client_tool_result_input_item(message: Mapping[str, Any]) -> ResponseInputItemParam | None:
    if message.get("type") != MODEL_CLIENT_TOOL_RESULT_ITEM_TYPE:
        return None
    call_id = clean_str(message.get("call_id"))
    tool_type = clean_str(message.get("tool_type"))
    output = message.get("output")
    if call_id is None or tool_type is None or not isinstance(output, str):
        return None
    if tool_type == "function":
        return cast(
            ResponseInputItemParam,
            {"type": "function_call_output", "call_id": call_id, "output": output},
        )
    if tool_type != "apply_patch":
        return None
    status: Literal["completed", "failed"] = "completed" if message.get("status") == "completed" else "failed"
    item: ApplyPatchCallOutput = {
        "type": "apply_patch_call_output",
        "call_id": call_id,
        "status": status,
        "output": output,
    }
    return cast(ResponseInputItemParam, item)


def _operation_from_arguments(value: object) -> dict[str, Any] | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    operation_type = parsed.get("type")
    path = parsed.get("path")
    if operation_type not in {"create_file", "update_file", "delete_file"} or not isinstance(path, str):
        return None
    if operation_type != "delete_file" and not isinstance(parsed.get("diff"), str):
        return None
    return parsed


def _function_call_items_from_assistant_message(message: Mapping[str, Any]) -> list[ResponseInputItemParam]:
    """Convert OpenAI-compatible assistant tool calls into Responses input items."""

    raw_tool_calls = message.get("tool_calls")
    if not isinstance(raw_tool_calls, list):
        return []
    items: list[ResponseInputItemParam] = []
    for raw_tool_call in raw_tool_calls:
        if not isinstance(raw_tool_call, Mapping):
            continue
        call_id = clean_str(raw_tool_call.get("id"))
        function = raw_tool_call.get("function")
        if not isinstance(function, Mapping) or call_id is None:
            continue
        name = clean_str(function.get("name"))
        if name is None:
            continue
        arguments = function.get("arguments")
        item: ResponseFunctionToolCallParam = {
            "type": "function_call",
            "call_id": call_id,
            "name": name,
            "arguments": arguments if isinstance(arguments, str) else "",
            "status": "completed",
        }
        items.append(cast(ResponseInputItemParam, item))
    return items


def _function_call_output_from_tool_message(message: Mapping[str, Any]) -> ResponseInputItemParam | None:
    """Convert an OpenAI-compatible tool message into Responses call output."""

    call_id = clean_str(message.get("tool_call_id"))
    content = message.get("content")
    if call_id is None or not isinstance(content, str):
        return None
    return cast(
        ResponseInputItemParam,
        {
            "type": "function_call_output",
            "call_id": call_id,
            "output": content,
        },
    )


def responses_text_format(response_format: Mapping[str, Any] | None) -> ResponseTextConfigParam | None:
    """Translate Chat Completions-style response_format to Responses text format."""

    if not isinstance(response_format, Mapping):
        return None
    raw = jsonable(response_format)
    if not isinstance(raw, dict):
        return None
    if raw.get("type") == "json_schema":
        schema_config = raw.get("json_schema")
        if not isinstance(schema_config, dict):
            return None
        return {
            "format": {
                "type": "json_schema",
                "name": str(schema_config.get("name") or "direct_chat_response"),
                "strict": bool(schema_config.get("strict", True)),
                "schema": schema_config.get("schema") or {},
            }
        }
    if raw.get("type") == "json_object":
        return {"format": {"type": "json_object"}}
    return None


def responses_tools(
    raw_tools: Any,
    prompt_function_tools: list[dict[str, Any]],
    *,
    memory_apply_patch_enabled: bool = False,
    function_tool_namespace: str | None = None,
) -> list[ToolParam]:
    """Build Responses hosted/native tools plus prompt function tools.

    With ``function_tool_namespace`` the function tools are grouped in one
    namespace tool; a call then comes back with its own name and the namespace
    beside it.
    """

    requested = {str(value).strip() for value in (raw_tools or ()) if str(value).strip()}
    tools: list[ToolParam] = []
    if "web_search" in requested:
        tools.append(cast(ToolParam, {"type": "web_search", "search_context_size": DEFAULT_WEB_SEARCH_CONTEXT_SIZE}))
    if memory_apply_patch_enabled:
        apply_patch_tool: ApplyPatchToolParam = {"type": "apply_patch"}
        tools.append(cast(ToolParam, apply_patch_tool))
    functions = [tool for tool in map(_responses_function_tool, prompt_function_tools) if tool is not None]
    if function_tool_namespace is None:
        tools.extend(cast(ToolParam, tool) for tool in functions)
    elif functions:
        namespace: NamespaceToolParam = {
            "type": "namespace",
            "name": function_tool_namespace,
            "description": "Animama's tools for this conversation.",
            "tools": cast(Any, functions),
        }
        tools.append(cast(ToolParam, namespace))
    return tools


def _responses_function_tool(raw_tool: Mapping[str, Any]) -> FunctionToolParam | None:
    """Translate an OpenAI-compatible function tool into Responses format."""

    if raw_tool.get("type") != "function":
        return None
    function = raw_tool.get("function")
    if not isinstance(function, Mapping):
        return None
    name = clean_str(function.get("name"))
    if name is None:
        return None
    parameters = jsonable(function.get("parameters") or {})
    if not isinstance(parameters, dict):
        parameters = {}
    tool: FunctionToolParam = {
        "type": "function",
        "name": name,
        "parameters": cast(dict[str, object], parameters),
        "strict": bool(function.get("strict", True)),
    }
    description = function.get("description")
    if isinstance(description, str) and description.strip():
        tool["description"] = description.strip()
    return tool


__all__ = [
    "DEFAULT_RESPONSES_COMPACTION_THRESHOLD_TOKENS",
    "create_response_kwargs",
    "previous_response_id",
    "responses_input_items",
]

"""Translate a provider-neutral direct-chat request into Messages API parameters.

The direct-chat assembler produces one OpenAI-compatible message list (see
``docs/backend/runtime/prompt-caching.md``)::

    system (stable instructions, ending with the Companion Guardrails)
    history ...
    [developer (turn context: memory map, attachments), when the turn has any]
    user (the user's new message)
    [this turn's tool exchanges, an invalid reply, forced-final or repair text]

This module maps it to Anthropic's positions (D20, D21):

- The stable instructions become one ``system`` text block with
  ``cache_control``.
- History is replayed in order with same-role neighbours merged, memory-tool
  exchanges as ``tool_use``/``tool_result`` blocks and never any thinking.
  History may start with the assistant row that holds the chat's latest
  compaction block (the API ignores whatever precedes it); that block carries
  a ``cache_control`` breakpoint, and so does the last history block.
- The user's new message is a user turn, followed by the turn context, when
  there is any, as a mid-conversation ``system`` message: Anthropic accepts a
  system message only after a user turn, so it follows the user's words. No
  tagged block is used; a turn without context ends on the user turn.
- Within a turn, each round's assistant content is resent exactly as Anthropic
  returned it (compaction, signed thinking, text, server web-search blocks,
  ``tool_use``), taken from the continuation cursor. Forced-final and repair
  instructions, which already end with the guardrails, are text in a user turn
  after the tool results or the invalid reply.

Chat requests use the beta Messages API with server-side compaction
(``compact_20260112``, D4). Utility prompts (``utility_task``) send no
``context_management``: their input is already bounded by the source chat,
and a summary of a server-compacted transcript would summarize a summary.
When the turn asked for web search and the row hosts it, Anthropic's
``web_search`` server tool is offered (D7).

Requests never carry sampling parameters or an assistant prefill.
"""

from __future__ import annotations

import base64
import copy
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from animama.adapters.model_clients._common import jsonable
from animama.app.model_catalog import DEFAULT_ANTHROPIC_CHAT_EFFORT, early_compaction_available, offered_effort
from animama.app.model_clients import (
    ANTHROPIC_TOOL_RESULT_ITEM_TYPE,
    ANTHROPIC_TOOL_USE_ITEM_TYPE,
    ModelClientContinuation,
    ModelClientRequest,
)
from animama.app.model_clients.image_parts import ModelClientImage, is_image_part, resolved_parts
from animama.app.model_clients.prompt import prompt_messages, prompt_tools
from animama.domain import ModelProvider

from .schema import anthropic_strict_schema
from .support import ANTHROPIC_MESSAGES_HTTP_PROVIDER_TYPE, clean_str

ANTHROPIC_MAX_TOKENS_PER_REQUEST = 64_000
"""Output cap for one request (thinking included); the row's own limit applies when lower."""
DEFAULT_ANTHROPIC_UTILITY_EFFORT = "low"
"""Effort for Utility prompts (titles, other chats' summaries) without a choice (D16)."""
DEFAULT_ANTHROPIC_MEMORY_MANAGER_EFFORT = "medium"
"""Effort for Memory Manager runs without a choice (D16)."""
EFFORT_NONE = "none"
CACHE_CONTROL: dict[str, str] = {"type": "ephemeral"}
_THINKING_BLOCK_TYPES = frozenset({"thinking", "redacted_thinking"})
COMPACTION_BLOCK_TYPE = "compaction"

COMPACTION_BETA = "compact-2026-01-12"
COMPACTION_EDIT_TYPE = "compact_20260112"
COMPACTION_MIN_TRIGGER_TOKENS = 50_000
"""Anthropic's minimum compaction trigger."""
COMPACTION_DEFAULT_TRIGGER_TOKENS = 150_000
"""Anthropic's default trigger, used unless **Compact early** applies (D4)."""
EARLY_COMPACTION_SHARE = 0.9
"""**Compact early** triggers at this share of the row's long-context price threshold (D4)."""

WEB_SEARCH_NATIVE_TOOL = "web_search"
WEB_SEARCH_MAX_USES = 5
WEB_SEARCH_SERVER_TOOL: dict[str, Any] = {
    "type": "web_search_20250305",
    "name": "web_search",
    "max_uses": WEB_SEARCH_MAX_USES,
    "allowed_callers": ["direct"],
}
"""Basic web search, called directly by the model (D7; chosen over dynamic filtering in Phase 1)."""


def messages_request_params(spec: ModelClientRequest) -> dict[str, Any]:
    """Return JSON-shaped keyword arguments for ``client.beta.messages.stream``, including ``betas``."""

    prompt = spec.prompt
    utility = spec.provider_options.utility_task
    layout = _prompt_layout(prompt_messages(prompt))
    params: dict[str, Any] = {
        "model": spec.model_provider.model,
        "max_tokens": request_max_tokens(spec.model_provider),
        "messages": _request_messages(layout, continuation_rounds(spec.continuation), spec.images),
    }
    limits = spec.limits
    if limits is not None:
        # Composition-selected limits bound this invocation (hosted calls).
        params["max_tokens"] = min(params["max_tokens"], limits.max_output_tokens)
    if not utility:
        # A Utility prompt is summarized as a whole, never compacted first (P6-R1-F4).
        params["betas"] = [COMPACTION_BETA]
        params["context_management"] = compaction_context_management(spec.model_provider)
    if layout.system_text:
        params["system"] = [{"type": "text", "text": layout.system_text, "cache_control": dict(CACHE_CONTROL)}]
    tools = anthropic_tools(prompt_tools(prompt))
    if WEB_SEARCH_NATIVE_TOOL in spec.provider_options.native_tools:
        # Executor setup passes web_search here only when the row hosts it.
        search_tool = copy.deepcopy(WEB_SEARCH_SERVER_TOOL)
        if limits is not None and limits.max_native_tool_calls is not None:
            search_tool["max_uses"] = min(WEB_SEARCH_MAX_USES, limits.max_native_tool_calls)
        tools.append(search_tool)
    if tools:
        params["tools"] = tools
        params["tool_choice"] = _tool_choice(prompt.tool_choice, prompt.parallel_tool_calls)
    output_config: dict[str, Any] = {}
    output_format = anthropic_output_format(prompt.response_format)
    if output_format is not None:
        output_config["format"] = output_format
    effort, thinking = effort_and_thinking(
        prompt.reasoning_effort,
        spec.model_provider,
        default=DEFAULT_ANTHROPIC_UTILITY_EFFORT if utility else DEFAULT_ANTHROPIC_CHAT_EFFORT,
    )
    if effort is not None:
        output_config["effort"] = effort
    if thinking is not None:
        params["thinking"] = thinking
    if output_config:
        params["output_config"] = output_config
    return params


def compaction_trigger_tokens(model_provider: ModelProvider) -> int:
    """Return the input-token count at which the server compacts this row's chats (D4).

    With **Compact early** on a row whose pricing has a long-context step, the
    trigger is 90% of that step, never below Anthropic's minimum. Otherwise it
    is Anthropic's default.
    """

    threshold = model_provider.pricing.long_context_token_threshold
    if model_provider.early_compaction and early_compaction_available(model_provider) and threshold:
        return max(COMPACTION_MIN_TRIGGER_TOKENS, int(threshold * EARLY_COMPACTION_SHARE))
    return COMPACTION_DEFAULT_TRIGGER_TOKENS


def compaction_context_management(model_provider: ModelProvider) -> dict[str, Any]:
    """Return ``context_management`` for threshold compaction that continues the turn."""

    return {
        "edits": [
            {
                "type": COMPACTION_EDIT_TYPE,
                "trigger": {"type": "input_tokens", "value": compaction_trigger_tokens(model_provider)},
                # The reply continues from the summary; turns are never re-inserted (D4).
                "pause_after_compaction": False,
            }
        ]
    }


def messages_with_paused_content(messages: list[dict[str, Any]], content: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return ``messages`` followed by a paused turn's assistant content, resent unchanged.

    After ``stop_reason: pause_turn`` the server resumes the turn when the
    assistant content it returned so far is sent back as the last message.
    """

    resent = copy.deepcopy(messages)
    if resent and resent[-1]["role"] == "assistant":
        resent[-1]["content"] = [*resent[-1]["content"], *copy.deepcopy(content)]
    else:
        resent.append({"role": "assistant", "content": copy.deepcopy(content)})
    return resent


def request_max_tokens(model_provider: ModelProvider) -> int:
    """Return the row's output limit, capped by the per-request limit."""

    limit = model_provider.max_output_tokens
    if isinstance(limit, int) and not isinstance(limit, bool) and limit > 0:
        return min(limit, ANTHROPIC_MAX_TOKENS_PER_REQUEST)
    return ANTHROPIC_MAX_TOKENS_PER_REQUEST


def effort_and_thinking(
    requested: str | None,
    model_provider: ModelProvider,
    *,
    default: str = DEFAULT_ANTHROPIC_CHAT_EFFORT,
) -> tuple[str | None, dict[str, str] | None]:
    """Map a request's reasoning effort to ``output_config.effort`` and ``thinking`` (D6, D16, D22).

    ``none`` disables thinking and sends no effort. Any other effort leaves
    thinking at the model's adaptive default and sets the effort. Without a
    choice, the role's ``default`` applies when the row offers it: ``medium``
    for chat turns and Memory Manager runs, ``low`` for Utility prompts.
    """

    effort = requested.strip() if isinstance(requested, str) and requested.strip() else None
    if effort is None:
        effort = offered_effort(default, model_provider.capabilities.supported_reasoning_efforts)
    if effort is None:
        return None, None
    if effort == EFFORT_NONE:
        return None, {"type": "disabled"}
    return effort, None


def anthropic_tools(function_tools: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Convert Chat Completions function tools into strict Anthropic tools (D3)."""

    tools: list[dict[str, Any]] = []
    for raw_tool in function_tools:
        function = raw_tool.get("function") if raw_tool.get("type") == "function" else None
        if not isinstance(function, Mapping):
            continue
        name = clean_str(function.get("name"))
        if name is None:
            continue
        parameters = jsonable(function.get("parameters") or {"type": "object", "properties": {}})
        tool: dict[str, Any] = {"name": name}
        description = clean_str(function.get("description"))
        if description is not None:
            tool["description"] = description
        tool["input_schema"] = anthropic_strict_schema(parameters if isinstance(parameters, dict) else {})
        tool["strict"] = True
        tools.append(tool)
    return tools


def anthropic_output_format(response_format: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Return ``output_config.format`` for a strict JSON-schema response format, else ``None``."""

    raw = jsonable(response_format) if isinstance(response_format, Mapping) else None
    if not isinstance(raw, dict) or raw.get("type") != "json_schema":
        return None
    schema_config = raw.get("json_schema")
    schema = schema_config.get("schema") if isinstance(schema_config, dict) else None
    if not isinstance(schema, dict):
        return None
    return {"type": "json_schema", "schema": anthropic_strict_schema(schema)}


def continuation_rounds(continuation: ModelClientContinuation | None) -> list[list[dict[str, Any]]]:
    """Return this turn's earlier assistant content arrays carried by the cursor."""

    if continuation is None or continuation.provider_type != ANTHROPIC_MESSAGES_HTTP_PROVIDER_TYPE:
        return []
    try:
        parsed = json.loads(continuation.cursor)
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [[block for block in content if isinstance(block, dict)] for content in parsed if isinstance(content, list)]


def continuation_with_round(
    continuation: ModelClientContinuation | None,
    content: list[dict[str, Any]],
    *,
    model: str,
) -> ModelClientContinuation:
    """Return a cursor carrying this turn's earlier rounds plus ``content``, unchanged."""

    rounds = [*continuation_rounds(continuation), content]
    return ModelClientContinuation(
        provider_type=ANTHROPIC_MESSAGES_HTTP_PROVIDER_TYPE,
        cursor=json.dumps(rounds, ensure_ascii=False, separators=(",", ":")),
        metadata={"source": "tool_call_response", "model": model, "round_count": len(rounds)},
    )


@dataclass(slots=True)
class _PromptLayout:
    """The assembler's prompt split into the parts Anthropic places differently."""

    system_text: str | None = None
    history: list[Mapping[str, Any]] = field(default_factory=list)
    turn_user: Mapping[str, Any] | None = None
    turn_context: str | None = None
    after_turn: list[Mapping[str, Any]] = field(default_factory=list)


def _prompt_layout(messages: list[dict[str, Any]]) -> _PromptLayout:
    layout = _PromptLayout()
    start = 0
    if messages and _is_instruction(messages[0], "system"):
        layout.system_text = _text(messages[0].get("content"))
        start = 1
    user_index = next(
        (index for index in range(len(messages) - 1, start - 1, -1) if _is_plain(messages[index], "user")),
        None,
    )
    if user_index is None:
        layout.history = list(messages[start:])
        return layout
    history_end = user_index
    if user_index - 1 >= start and _is_instruction(messages[user_index - 1], "developer"):
        # The turn context sits directly before the user's new message.
        layout.turn_context = _text(messages[user_index - 1].get("content"))
        history_end = user_index - 1
    # Anthropic chats never carry an app compaction summary: their server
    # compacts, and history replay ignores app compaction (other roles in
    # history are not replayed).
    layout.history = list(messages[start:history_end])
    layout.turn_user = messages[user_index]
    layout.after_turn = list(messages[user_index + 1 :])
    return layout


class _Conversation:
    """Messages under construction; adjacent user or assistant turns merge into one."""

    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []

    def add(self, role: str, blocks: list[dict[str, Any]]) -> None:
        if not blocks:
            return
        last = self.messages[-1] if self.messages else None
        if last is not None and last["role"] == role and role in {"user", "assistant"}:
            last["content"].extend(blocks)
        else:
            self.messages.append({"role": role, "content": list(blocks)})

    def add_instruction(self, text: str) -> None:
        """Add app instruction text where Anthropic reads it after the turn's latest content.

        After tool results or an assistant reply it is text in a user turn. A
        system message must be last or followed by an assistant turn, so text
        that directly follows the turn-context message joins that message.
        """

        last = self.messages[-1] if self.messages else None
        if last is not None and last["role"] == "system":
            last["content"] = f"{last['content']}\n\n{text}"
        else:
            self.add("user", [_text_block(text)])


def _request_messages(
    layout: _PromptLayout,
    rounds: list[list[dict[str, Any]]],
    images: Mapping[str, ModelClientImage] | None = None,
) -> list[dict[str, Any]]:
    images = images or {}
    conversation = _Conversation()
    for message in layout.history:
        mapped = _history_blocks(message, images)
        if mapped is not None:
            conversation.add(*mapped)
    _drop_orphan_prefix(conversation.messages)
    if conversation.messages:
        first_block = conversation.messages[0]["content"][0]
        if first_block.get("type") == COMPACTION_BLOCK_TYPE:
            # The summary heads every request until the next compaction.
            first_block["cache_control"] = dict(CACHE_CONTROL)
        # Cache the replayed history: the previous request wrote an entry at
        # its own last history block, which this request reads.
        conversation.messages[-1]["content"][-1]["cache_control"] = dict(CACHE_CONTROL)
    if layout.turn_user is not None:
        conversation.add("user", _content_blocks(layout.turn_user.get("content"), images))
    if layout.turn_context:
        conversation.messages.append({"role": "system", "content": layout.turn_context})
    pending: list[Mapping[str, Any]] = []
    for message in layout.after_turn:
        if message.get("type") == ANTHROPIC_TOOL_USE_ITEM_TYPE:
            pending.append(message)
            continue
        _flush_tool_uses(conversation, pending, rounds)
        pending = []
        if message.get("type") == ANTHROPIC_TOOL_RESULT_ITEM_TYPE:
            conversation.add("user", [_tool_result_block(message)])
        elif _is_plain(message, "assistant"):
            conversation.add("assistant", _content_blocks(message.get("content")))
        elif _is_instruction(message, "developer") or _is_instruction(message, "system"):
            text = _text(message.get("content"))
            if text:
                conversation.add_instruction(text)
        elif _is_plain(message, "user"):
            conversation.add("user", _content_blocks(message.get("content"), images))
    _flush_tool_uses(conversation, pending, rounds)
    return conversation.messages


def _flush_tool_uses(
    conversation: _Conversation,
    items: list[Mapping[str, Any]],
    rounds: list[list[dict[str, Any]]],
) -> None:
    """Add one round's tool calls as the assistant content Anthropic returned for them."""

    if not items:
        return
    ids = [str(item.get("id") or "") for item in items]
    for content in rounds:
        if [str(block.get("id") or "") for block in content if block.get("type") == "tool_use"] == ids:
            # Resent exactly as returned: signed thinking, text and tool_use blocks.
            conversation.add("assistant", copy.deepcopy(content))
            return
    conversation.add("assistant", [_tool_use_block(item) for item in items])


def _history_blocks(
    message: Mapping[str, Any], images: Mapping[str, ModelClientImage]
) -> tuple[str, list[dict[str, Any]]] | None:
    """Map one replayed history message; other providers' items never reach an Anthropic chat."""

    item_type = message.get("type")
    if item_type == ANTHROPIC_TOOL_USE_ITEM_TYPE:
        return "assistant", [_tool_use_block(message)]
    if item_type == ANTHROPIC_TOOL_RESULT_ITEM_TYPE:
        return "user", [_tool_result_block(message)]
    if item_type is not None:
        return None
    role = _role(message)
    if role not in {"user", "assistant"}:
        return None
    return role, _content_blocks(message.get("content"), images if role == "user" else {})


def _drop_orphan_prefix(messages: list[dict[str, Any]]) -> None:
    """Start history at a user turn without tool results whose calls fell outside the window.

    History that starts at a compaction block's assistant row is kept: the API
    reads the conversation from that block on.
    """

    while messages:
        first = messages[0]
        if first["role"] == "assistant" and first["content"][0].get("type") == COMPACTION_BLOCK_TYPE:
            return
        if first["role"] != "user":
            messages.pop(0)
            continue
        first["content"] = [block for block in first["content"] if block.get("type") != "tool_result"]
        if first["content"]:
            return
        messages.pop(0)


def _content_blocks(content: Any, images: Mapping[str, ModelClientImage] | None = None) -> list[dict[str, Any]]:
    """Return text or stored content blocks, never thinking (D8).

    A chat image becomes a base64 ``image`` block, or its placeholder text when
    the request does not carry its bytes.
    """

    if isinstance(content, str):
        return [_text_block(content)] if content else []
    if not isinstance(content, list | tuple):
        return []
    blocks: list[dict[str, Any]] = []
    for block in content:
        if is_image_part(block):
            for part in resolved_parts([block], images or {}):
                blocks.append(_text_block(part) if isinstance(part, str) else _image_block(part))
            continue
        if not isinstance(block, Mapping) or block.get("type") in _THINKING_BLOCK_TYPES:
            continue
        copied = jsonable(block)
        if isinstance(copied, dict):
            copied.pop("cache_control", None)
            blocks.append(copied)
    return blocks


def _image_block(image: ModelClientImage) -> dict[str, Any]:
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": image.media_type,
            "data": base64.b64encode(image.content).decode("ascii"),
        },
    }


def _tool_use_block(item: Mapping[str, Any]) -> dict[str, Any]:
    tool_input = jsonable(item.get("input"))
    return {
        "type": "tool_use",
        "id": str(item.get("id") or ""),
        "name": str(item.get("name") or ""),
        "input": tool_input if isinstance(tool_input, dict) else {},
    }


def _tool_result_block(item: Mapping[str, Any]) -> dict[str, Any]:
    content = item.get("content")
    return {
        "type": "tool_result",
        "tool_use_id": str(item.get("tool_use_id") or ""),
        "content": content if isinstance(content, str) else json.dumps(jsonable(content), ensure_ascii=False),
    }


def _tool_choice(tool_choice: Any, parallel_tool_calls: bool | None) -> dict[str, Any]:
    if tool_choice == "none":
        # Forced-final and repair rounds keep the tools so the cache and the
        # turn's thinking blocks stay valid, and ask for no further calls.
        return {"type": "none"}
    choice: dict[str, Any] = {"type": "auto"}
    if parallel_tool_calls is False:
        choice["disable_parallel_tool_use"] = True
    return choice


def _text_block(text: str) -> dict[str, Any]:
    return {"type": "text", "text": text}


def _role(message: Mapping[str, Any]) -> str:
    return str(message.get("role") or "").strip().lower()


def _is_plain(message: Mapping[str, Any], role: str) -> bool:
    return message.get("type") is None and _role(message) == role


def _is_instruction(message: Mapping[str, Any], role: str) -> bool:
    return _is_plain(message, role) and isinstance(message.get("content"), str)


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


__all__ = [
    "ANTHROPIC_MAX_TOKENS_PER_REQUEST",
    "CACHE_CONTROL",
    "COMPACTION_BETA",
    "COMPACTION_BLOCK_TYPE",
    "COMPACTION_DEFAULT_TRIGGER_TOKENS",
    "COMPACTION_MIN_TRIGGER_TOKENS",
    "DEFAULT_ANTHROPIC_CHAT_EFFORT",
    "DEFAULT_ANTHROPIC_MEMORY_MANAGER_EFFORT",
    "DEFAULT_ANTHROPIC_UTILITY_EFFORT",
    "WEB_SEARCH_SERVER_TOOL",
    "anthropic_output_format",
    "anthropic_tools",
    "compaction_context_management",
    "compaction_trigger_tokens",
    "continuation_rounds",
    "continuation_with_round",
    "effort_and_thinking",
    "messages_request_params",
    "messages_with_paused_content",
    "request_max_tokens",
]

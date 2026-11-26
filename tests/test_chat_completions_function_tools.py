"""Function tool definitions as an OpenAI-compatible server receives them.

Groq's strict validator rejects a zero-argument tool whose schema carries
``properties: {}`` beside ``required: []`` (#902).
"""

from __future__ import annotations

import copy
from typing import Any, cast

from animama.adapters.model_clients.openai_chat_completions.request import (
    create_chat_completion_kwargs,
    function_tools_for_connection,
)
from animama.app.chat.memory_tools import MEMORY_TOOL_LIST_FILES, memory_tool_specs
from animama.app.model_clients import ModelClientRequest
from animama.app.model_clients.prompt import DirectChatPrompt
from animama.domain import ModelConnection, ModelProvider
from animama.domain.model_connection import ModelConnectionCompatibility

_MEMORY_TOOLS = memory_tool_specs(allow_reads=True, allow_writes=True)


def _provider(compatibility: ModelConnectionCompatibility) -> ModelProvider:
    connection = ModelConnection(
        id="c_groq",
        name="Groq",
        preset="custom",
        base_url="https://api.groq.com/openai/v1",
        compatibility=compatibility,
    )
    return ModelProvider(
        id="OpenAIHTTPAgent:openai/gpt-oss-120b",
        provider_type="OpenAIHTTPAgent",
        model="openai/gpt-oss-120b",
        model_label="gpt-oss-120b",
        provider_label="Groq",
        connection_id=connection.id,
        connection=connection,
    )


def _sent_functions(compatibility: ModelConnectionCompatibility | None = None) -> dict[str, dict[str, Any]]:
    """Return each function definition a memory-tool request carries, by tool name."""

    request = ModelClientRequest(
        model_provider=_provider(compatibility or ModelConnectionCompatibility()),
        prompt=DirectChatPrompt(messages=({"role": "user", "content": "Hi"},), tools=cast(Any, _MEMORY_TOOLS)),
    )
    tools = create_chat_completion_kwargs(request, timeout=None)["tools"]
    return {tool["function"]["name"]: tool["function"] for tool in tools}


def test_a_zero_argument_tool_is_sent_without_an_empty_required_list() -> None:
    list_files = _sent_functions()[MEMORY_TOOL_LIST_FILES]

    assert list_files["parameters"] == {"type": "object", "properties": {}, "additionalProperties": False}
    assert list_files["strict"] is True


def test_tools_with_arguments_are_sent_as_defined() -> None:
    sent = _sent_functions()

    for spec in _MEMORY_TOOLS:
        function = spec["function"]
        if function["name"] != MEMORY_TOOL_LIST_FILES:
            assert sent[function["name"]] == function


def test_removing_strict_flags_still_omits_the_empty_required_list() -> None:
    list_files = _sent_functions(ModelConnectionCompatibility(strip_function_strict=True))[MEMORY_TOOL_LIST_FILES]

    assert "strict" not in list_files
    assert "required" not in list_files["parameters"]


def test_shaping_tools_leaves_the_callers_definitions_untouched() -> None:
    # A caller may keep using the definitions it passes in, as the Agents SDK's converter does.
    tools = [
        {
            "type": "function",
            "function": {
                "name": MEMORY_TOOL_LIST_FILES,
                "strict": True,
                "parameters": {
                    "type": "object",
                    "title": "memory_list_files_args",
                    "properties": {},
                    "required": [],
                    "additionalProperties": False,
                },
            },
        }
    ]
    original = copy.deepcopy(tools)

    shaped = function_tools_for_connection(tools, compatibility=ModelConnectionCompatibility())

    assert tools == original
    assert "required" not in shaped[0]["function"]["parameters"]


def test_a_call_without_a_tool_list_passes_through() -> None:
    # The Agents SDK sends a sentinel, not a list, when a call offers no tools.
    no_tools = object()

    assert function_tools_for_connection(no_tools, compatibility=ModelConnectionCompatibility()) is no_tools

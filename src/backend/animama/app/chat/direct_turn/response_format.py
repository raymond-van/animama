from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from pydantic import BaseModel

from animama.app.chat.anthropic_instructions import anthropic_main_structured_output_guidance
from animama.app.chat.api_standard import ANTHROPIC_MESSAGES_PROVIDER_TYPE
from animama.app.chat.memory_context import main_structured_output_guidance
from animama.app.chat.options import DirectChatOptions
from animama.app.main_structured_response import (
    MAIN_STRUCTURED_RESPONSE_FORMAT,
    MAIN_STRUCTURED_RESPONSE_KIND,
    MAIN_STRUCTURED_RESPONSE_PART_REMEMBER,
    build_main_structured_prompt,
    build_main_structured_response_json_schema,
)
from animama.app.model_catalog import STRUCTURED_OUTPUT_TRANSPORT_JSON_OBJECT, STRUCTURED_OUTPUT_TRANSPORT_JSON_SCHEMA
from animama.app.model_clients.context_budget import estimate_text_tokens
from animama.domain import ModelProvider

from .types import RuntimeGestureDescriptor


def build_main_structured_response_format(
    output_type: type[BaseModel],
    *,
    name: str,
) -> dict[str, Any]:
    """Build the OpenAI-compatible strict JSON schema response_format."""

    return {
        "type": "json_schema",
        "json_schema": {
            "name": name,
            "strict": True,
            "schema": build_main_structured_response_json_schema(output_type),
        },
    }


def supports_structured_reply(model_provider: ModelProvider) -> bool:
    """Return whether the row accepts a JSON schema or JSON mode for the reply.

    Rows saved with structured output "None" carry no structured kind.
    """

    return MAIN_STRUCTURED_RESPONSE_KIND in {
        kind.strip() for kind in model_provider.capabilities.structured_kinds if isinstance(kind, str)
    }


def main_structured_response_format_for_model(
    model_provider: ModelProvider,
    output_type: type[BaseModel],
    *,
    name: str,
) -> dict[str, Any] | None:
    """Return the ``response_format`` a model's structured-output support allows.

    Rows with a JSON schema or JSON mode transport get the strict schema format
    (the Chat Completions adapter sends JSON mode for ``json_object`` rows).
    Rows without either get none: the prompt asks for JSON and the reply is
    validated locally, repaired once or spoken as plain text.
    """

    if not supports_structured_reply(model_provider):
        return None
    return build_main_structured_response_format(output_type, name=name)


def main_structured_response_guidance(
    model_provider: ModelProvider,
    output_type: type[BaseModel],
) -> str:
    """Return prompt guidance matching the selected provider row's transport.

    A JSON schema constrains the reply shape; JSON mode and prompt-only rows
    also get the schema and an example in the prompt. Anthropic rows with
    strict structured output get the shared guidance plus a line that keeps
    tool calls ahead of the JSON answer. The guidance describes ``remember`` only
    when ``output_type`` has it (the model benchmark's arms, app/chat/memory_arm.py).
    """

    remember = MAIN_STRUCTURED_RESPONSE_PART_REMEMBER in output_type.model_fields
    if (
        model_provider.provider_type == ANTHROPIC_MESSAGES_PROVIDER_TYPE
        and model_provider.capabilities.structured_output_transport == STRUCTURED_OUTPUT_TRANSPORT_JSON_SCHEMA
        and supports_structured_reply(model_provider)
    ):
        return anthropic_main_structured_output_guidance(remember=remember).strip()
    guidance = main_structured_output_guidance(remember=remember).strip()
    if (
        model_provider.capabilities.structured_output_transport == STRUCTURED_OUTPUT_TRANSPORT_JSON_OBJECT
        or not supports_structured_reply(model_provider)
    ):
        return "\n\n".join((guidance, build_main_structured_prompt(output_type).strip()))
    return guidance


GESTURE_DESCRIPTIONS_MAX_WINDOW_PERCENT = 10
"""The largest share of a model's context window the described Gesture list may take."""

_GESTURE_LIST_HEADING = "Available Gestures for this Anima:"


def render_available_gestures(
    descriptors: Sequence[RuntimeGestureDescriptor],
    *,
    context_window_tokens: int | None = None,
) -> str:
    """Render the equipped Gesture list the model chooses from, or ``""`` when none are equipped.

    Each row pairs the exact selector allowed by the reply schema's ``gesture``
    enum with the Gesture's AI description, which falls back to its name when
    empty. Selectors are usually readable semantic keys, so the name is left out.

    When the described list's conservative token estimate is more than
    ``GESTURE_DESCRIPTIONS_MAX_WINDOW_PERCENT`` of the model's context window,
    the rows carry selectors only, leaving the window for history. A row
    without a recorded window keeps the descriptions, as context fitting leaves
    such rows unbounded.
    """

    if not descriptors:
        return ""
    described = "\n".join((_GESTURE_LIST_HEADING, *(f"- {row.selector}: {row.description}" for row in descriptors)))
    if (
        context_window_tokens is None
        or context_window_tokens <= 0
        or estimate_text_tokens(described) * 100 <= context_window_tokens * GESTURE_DESCRIPTIONS_MAX_WINDOW_PERCENT
    ):
        return described
    return "\n".join((_GESTURE_LIST_HEADING, *(f"- {row.selector}" for row in descriptors)))


def gesture_response_guidance(
    guidance: str,
    descriptors: Sequence[RuntimeGestureDescriptor],
    *,
    context_window_tokens: int | None,
) -> str:
    """Append the Anima's AI-selectable Gestures to the response guidance.

    Every request of a turn, including the context-fitting rebuild and a
    stale-cursor replay, passes the selected row's ``context_window_tokens``
    so the stable instructions stay byte-identical. The list form depends only
    on the row and the equipped Gestures, so it is stable within a chat.
    """

    gesture_list = render_available_gestures(descriptors, context_window_tokens=context_window_tokens)
    return f"{guidance}\n\n{gesture_list}" if gesture_list else guidance


def response_model_agent_id(node_id: str) -> str:
    return "".join(char if char.isalnum() else "_" for char in node_id).strip("_") or "direct_chat"


def turn_response_format(request_options: DirectChatOptions) -> str:
    _ = request_options
    return MAIN_STRUCTURED_RESPONSE_FORMAT


def turn_response_schema_name(request_options: DirectChatOptions) -> str:
    _ = request_options
    return "direct_chat_main_response"


__all__ = [
    "build_main_structured_response_format",
    "main_structured_response_format_for_model",
    "main_structured_response_guidance",
    "render_available_gestures",
    "response_model_agent_id",
    "supports_structured_reply",
    "turn_response_format",
    "turn_response_schema_name",
]

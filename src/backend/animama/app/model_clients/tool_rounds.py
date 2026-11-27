"""Provider-neutral steps of a tool loop on the model-client contract.

A round that ends in tool calls is followed by another request: the same
prompt, the calls and their results in the provider's own shape, and the
provider state the round continues from. The chat turn and every other tool
loop build that request here, so they send each provider the same exchange.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from typing import Any

from animama.app.model_provider_native_tools import ANTHROPIC_MESSAGES_PROVIDER_TYPE, OPENAI_RESPONSES_PROVIDER_TYPE
from animama.app.util.json_values import safe_json_loads

from .prompt import copy_direct_chat_prompt, prompt_messages
from .types import (
    ANTHROPIC_TOOL_RESULT_ITEM_TYPE,
    ANTHROPIC_TOOL_USE_ITEM_TYPE,
    MODEL_CLIENT_TOOL_CALL_ITEM_TYPE,
    MODEL_CLIENT_TOOL_RESULT_ITEM_TYPE,
    ModelClientContinuation,
    ModelClientFinal,
    ModelClientRequest,
    ModelClientToolCall,
    ModelClientToolResult,
)


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


def tool_exchange_prompt_items(
    *,
    model_request: ModelClientRequest,
    tool_calls: tuple[ModelClientToolCall, ...],
    tool_results: tuple[ModelClientToolResult, ...],
) -> list[dict[str, Any]]:
    """Build ordered prompt items for one provider-neutral tool exchange.

    ``tool_results`` holds one result per call, in the calls' order. Responses
    and Anthropic rows get their own item types; every other row, the ChatGPT
    plan's included, gets an assistant message holding the calls and one tool
    message per result.
    """

    if model_request.model_provider.provider_type == OPENAI_RESPONSES_PROVIDER_TYPE:
        return [
            *(model_client_tool_call_prompt_item(tool_call) for tool_call in tool_calls),
            *(model_client_tool_result_prompt_item(tool_result) for tool_result in tool_results),
        ]
    if model_request.model_provider.provider_type == ANTHROPIC_MESSAGES_PROVIDER_TYPE:
        return [
            *(anthropic_tool_use_item(tool_call) for tool_call in tool_calls),
            *(
                anthropic_tool_result_item(tool_call, tool_result.output)
                for tool_call, tool_result in zip(tool_calls, tool_results, strict=True)
            ),
        ]
    call_message = assistant_tool_call_prompt_message(tool_calls)
    result_messages = [
        tool_result_prompt_message(tool_call, tool_result.output)
        for tool_call, tool_result in zip(tool_calls, tool_results, strict=True)
    ]
    return [call_message, *result_messages]


def openai_responses_continuation_from_final(
    model_request: ModelClientRequest,
    previous_final: ModelClientFinal | None,
) -> ModelClientContinuation | None:
    """Advance a Responses continuation cursor after a tool-call follow-up."""

    if model_request.model_provider.provider_type != OPENAI_RESPONSES_PROVIDER_TYPE or previous_final is None:
        return None
    response_id = previous_final.raw_provider_metadata.get("response_id")
    if not isinstance(response_id, str) or not response_id.strip():
        return None
    return ModelClientContinuation(
        provider_type=OPENAI_RESPONSES_PROVIDER_TYPE,
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


def model_request_with_appended_messages(
    model_request: ModelClientRequest,
    messages: list[dict[str, Any]],
    *,
    previous_final: ModelClientFinal | None = None,
    keep_images: bool = False,
) -> ModelClientRequest:
    """Append tool exchange messages and advance provider continuation state.

    The result is the next round's request. It starts without image bytes
    unless ``keep_images`` is set: the chat turn fills them again just before
    each dispatch, while a caller that put the bytes on the request itself
    keeps them, so a provider that takes the whole input on every round still
    receives the images the prompt names.
    """

    prompt = model_request.prompt
    return ModelClientRequest(
        model_provider=model_request.model_provider,
        limits=model_request.limits,
        prompt=copy_direct_chat_prompt(prompt, messages=(*prompt_messages(prompt), *messages)),
        # Moderation is requested only on round 0, whose input is the user's message.
        provider_options=replace(model_request.provider_options, moderation_model=None),
        continuation=continuation_after_tool_round(model_request, previous_final),
        images=model_request.images if keep_images else {},
    )


__all__ = [
    "anthropic_tool_result_item",
    "anthropic_tool_use_item",
    "assistant_tool_call_prompt_message",
    "continuation_after_tool_round",
    "model_client_tool_call_prompt_item",
    "model_client_tool_result_prompt_item",
    "model_request_with_appended_messages",
    "openai_responses_continuation_from_final",
    "tool_exchange_prompt_items",
    "tool_result_prompt_message",
]

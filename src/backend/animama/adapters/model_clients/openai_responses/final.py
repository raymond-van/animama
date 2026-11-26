from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, cast

from openai.types.responses import (
    Response,
    ResponseApplyPatchToolCall,
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
    ResponseUsage,
)

from animama.adapters.model_clients._common import get_value, jsonable
from animama.app.model_clients import ModelClientModeration, ModelClientToolCall
from animama.app.safety.moderation import moderation_result
from animama.domain.usage import Usage, UsageInputDetails, UsageOutputDetails

from .support import (
    KNOWN_OUTPUT_ITEM_TYPES,
    OPENAI_API,
    OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
    PHASE_FINAL_ANSWER,
    append_once,
    clean_str,
    is_native_tool_item_type,
    native_tool_summary_from_response_item,
    optional_int,
    primary_phase,
    response_item_id,
    response_item_type,
    response_message_phase,
)


@dataclass(frozen=True, slots=True)
class ResponseFinalParts:
    """Provider-neutral final data extracted from a terminal Response object."""

    text: str | None
    metadata: dict[str, Any]
    usage: Usage
    tool_calls: tuple[ModelClientToolCall, ...]
    missing_final_answer_phase: bool = False
    input_moderation: ModelClientModeration | None = None


@dataclass(frozen=True, slots=True)
class ExtractedResponseParts:
    """Intermediate extraction result for terminal Response output items."""

    text: str | None
    output_item_ids: tuple[str, ...]
    message_item_ids: tuple[str, ...]
    annotations: tuple[Any, ...]
    tool_calls: tuple[ModelClientToolCall, ...]
    phase: str | None
    message_phases: tuple[str, ...]
    phase_counts: Mapping[str, int]
    native_tool_summaries: tuple[dict[str, Any], ...]
    unknown_output_item_types: tuple[str, ...]
    missing_final_answer_phase: bool = False


def response_final_parts(
    response: Response,
    *,
    previous_response_id: str | None,
    provider_type: str = OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
) -> ResponseFinalParts:
    """Extract text, metadata, usage, and tool calls from a completed Response."""

    metadata: dict[str, Any] = {
        "provider": provider_type,
        "api": OPENAI_API,
    }
    response_id = clean_str(response.id)
    if response_id is not None:
        metadata["response_id"] = response_id
    model = clean_str(response.model)
    if model is not None:
        metadata["model"] = model
    service_tier = clean_str(response.service_tier)
    if service_tier is not None:
        metadata["service_tier"] = service_tier
    if previous_response_id is not None:
        metadata["previous_response_id"] = previous_response_id

    extracted = extract_response_parts(response)
    if extracted.output_item_ids:
        metadata["output_item_ids"] = extracted.output_item_ids
    if extracted.message_item_ids:
        metadata["message_item_ids"] = extracted.message_item_ids
        metadata["output_item_id"] = extracted.message_item_ids[0]
    if extracted.annotations:
        metadata["annotations"] = extracted.annotations
    if extracted.phase is not None:
        metadata["phase"] = extracted.phase
    if extracted.message_phases:
        metadata["message_phases"] = extracted.message_phases
    if extracted.phase_counts:
        metadata["phase_counts"] = dict(extracted.phase_counts)
    if extracted.native_tool_summaries:
        metadata["native_tool_summaries"] = extracted.native_tool_summaries
    if extracted.unknown_output_item_types:
        metadata["unknown_output_item_types"] = extracted.unknown_output_item_types
    return ResponseFinalParts(
        text=extracted.text,
        metadata=metadata,
        usage=usage_from_openai_responses(response.usage),
        tool_calls=extracted.tool_calls,
        missing_final_answer_phase=extracted.missing_final_answer_phase,
        input_moderation=input_moderation_from_response(response),
    )


def input_moderation_from_response(response: Response) -> ModelClientModeration | None:
    """Return content-free input moderation when the request asked for it."""

    moderation = getattr(response, "moderation", None)
    result = getattr(moderation, "input", None)
    if result is None:
        return None
    if getattr(result, "type", None) != "moderation_result":
        return ModelClientModeration(status="error")
    return moderation_result(getattr(result, "categories", None) or {}, getattr(result, "category_scores", None) or {})


def extract_response_parts(response: Response) -> ExtractedResponseParts:
    """Walk Response output items and select the public final assistant text."""

    output_text = response.output_text
    output_items = response.output
    message_texts: list[str] = []
    final_answer_texts: list[str] = []
    output_item_ids: list[str] = []
    message_item_ids: list[str] = []
    annotations: list[Any] = []
    tool_calls: list[ModelClientToolCall] = []
    message_phases: list[str] = []
    phase_counts: dict[str, int] = {}
    native_tool_summaries: list[dict[str, Any]] = []
    unknown_output_item_types: list[str] = []

    for output_index, item in enumerate(output_items):
        item_id = response_item_id(item)
        if item_id is not None:
            output_item_ids.append(item_id)
        item_type = response_item_type(item)
        if item_type not in KNOWN_OUTPUT_ITEM_TYPES:
            append_once(unknown_output_item_types, item_type)
        if isinstance(item, ResponseApplyPatchToolCall) or item_type == "apply_patch_call":
            tool_call = apply_patch_tool_call_from_response_item(cast(ResponseApplyPatchToolCall, item))
            if tool_call is not None:
                tool_calls.append(tool_call)
            summary = native_tool_summary_from_response_item(item, output_index=output_index)
            if summary:
                native_tool_summaries.append(summary)
            continue
        if is_native_tool_item_type(item_type):
            # Hosted tools are not direct-chat function calls, but their
            # summaries are useful in persisted provider metadata.
            summary = native_tool_summary_from_response_item(item, output_index=output_index)
            if summary:
                native_tool_summaries.append(summary)
            continue
        if isinstance(item, ResponseFunctionToolCall) or item_type == "function_call":
            # Function calls are returned to the direct-turn tool loop, not
            # rendered as assistant text.
            tool_call = tool_call_from_response_item(cast(ResponseFunctionToolCall, item))
            if tool_call is not None:
                tool_calls.append(tool_call)
            continue
        if not isinstance(item, ResponseOutputMessage):
            continue
        if item_id is not None:
            message_item_ids.append(item_id)
        phase = response_message_phase(item)
        if phase is not None:
            message_phases.append(f"{item_id}:{phase}" if item_id is not None else phase)
            phase_counts[phase] = phase_counts.get(phase, 0) + 1
        part_texts: list[str] = []
        for part in item.content:
            if not isinstance(part, ResponseOutputText):
                continue
            text = part.text
            if isinstance(text, str):
                part_texts.append(text)
            annotations.extend(jsonable(part.annotations or []))
        if part_texts:
            text = "".join(part_texts)
            if phase == PHASE_FINAL_ANSWER:
                final_answer_texts.append(text)
            elif phase is None:
                message_texts.append(text)

    saw_phase = bool(phase_counts)
    text = "\n".join(item for item in final_answer_texts if item)
    if not text and not saw_phase:
        # Older/unphased models may expose final text only via output_text.
        text = "\n".join(item for item in message_texts if item)
    if not text and not saw_phase and isinstance(output_text, str):
        text = output_text
    return ExtractedResponseParts(
        text=text or None,
        output_item_ids=tuple(output_item_ids),
        message_item_ids=tuple(message_item_ids),
        annotations=tuple(annotations),
        tool_calls=tuple(tool_calls),
        phase=primary_phase(phase_counts),
        message_phases=tuple(message_phases),
        phase_counts=phase_counts,
        native_tool_summaries=tuple(native_tool_summaries),
        unknown_output_item_types=tuple(unknown_output_item_types),
        missing_final_answer_phase=saw_phase and not text,
    )


def tool_call_from_response_item(item: ResponseFunctionToolCall) -> ModelClientToolCall | None:
    """Convert a Responses function_call output item into a model-client call."""

    call_id = clean_str(item.call_id) or clean_str(item.id)
    name = clean_str(item.name)
    arguments = item.arguments
    if call_id is None or name is None:
        return None
    return ModelClientToolCall(
        id=call_id,
        name=name,
        arguments=arguments if isinstance(arguments, str) else "",
    )


def apply_patch_tool_call_from_response_item(item: ResponseApplyPatchToolCall) -> ModelClientToolCall | None:
    """Convert a Responses apply_patch_call item into a model-client call."""

    call_id = clean_str(get_value(item, "call_id")) or clean_str(get_value(item, "id"))
    operation_value = get_value(item, "operation")
    model_dump = getattr(operation_value, "model_dump", None)
    operation = model_dump(mode="json") if callable(model_dump) else jsonable(operation_value)
    if call_id is None or not isinstance(operation, dict):
        return None
    return ModelClientToolCall(
        id=call_id,
        name="apply_patch",
        arguments=json.dumps(operation, ensure_ascii=True, separators=(",", ":")),
        tool_type="apply_patch",
    )


def usage_from_openai_responses(value: ResponseUsage | None) -> Usage:
    """Convert OpenAI Responses usage into Animama usage accounting."""

    input_details = value.input_tokens_details if value is not None else None
    output_details = value.output_tokens_details if value is not None else None
    return Usage(
        requests=1 if value is not None else 0,
        input_tokens=optional_int(value.input_tokens if value is not None else None),
        output_tokens=optional_int(value.output_tokens if value is not None else None),
        total_tokens=optional_int(value.total_tokens if value is not None else None),
        input_tokens_details=UsageInputDetails(
            cached_tokens=optional_int(input_details.cached_tokens if input_details is not None else None),
            # Newer models report prompt-cache writes; the SDK keeps the extra field.
            cache_write_tokens=optional_int(getattr(input_details, "cache_write_tokens", None)),
        ),
        output_tokens_details=UsageOutputDetails(
            reasoning_tokens=optional_int(output_details.reasoning_tokens if output_details is not None else None)
        ),
    )


__all__ = ["ResponseFinalParts", "response_final_parts", "usage_from_openai_responses"]

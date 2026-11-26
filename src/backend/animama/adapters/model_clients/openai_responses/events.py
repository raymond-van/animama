"""Maps OpenAI Responses stream events to provider-neutral ``MC*`` observations and
deltas, and extracts the terminal response.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import fields
from typing import Any, cast

from openai.types.responses import (
    Response,
    ResponseCodeInterpreterCallCompletedEvent,
    ResponseCodeInterpreterCallInProgressEvent,
    ResponseCodeInterpreterCallInterpretingEvent,
    ResponseCompletedEvent,
    ResponseContentPartAddedEvent,
    ResponseContentPartDoneEvent,
    ResponseCreatedEvent,
    ResponseErrorEvent,
    ResponseFailedEvent,
    ResponseFileSearchCallCompletedEvent,
    ResponseFileSearchCallInProgressEvent,
    ResponseFileSearchCallSearchingEvent,
    ResponseFunctionCallArgumentsDeltaEvent,
    ResponseFunctionCallArgumentsDoneEvent,
    ResponseFunctionToolCall,
    ResponseImageGenCallCompletedEvent,
    ResponseImageGenCallGeneratingEvent,
    ResponseImageGenCallInProgressEvent,
    ResponseIncompleteEvent,
    ResponseInProgressEvent,
    ResponseOutputItem,
    ResponseOutputItemAddedEvent,
    ResponseOutputItemDoneEvent,
    ResponseOutputMessage,
    ResponseOutputTextAnnotationAddedEvent,
    ResponseQueuedEvent,
    ResponseRefusalDeltaEvent,
    ResponseRefusalDoneEvent,
    ResponseStreamEvent,
    ResponseTextDeltaEvent,
    ResponseTextDoneEvent,
    ResponseWebSearchCallCompletedEvent,
    ResponseWebSearchCallInProgressEvent,
    ResponseWebSearchCallSearchingEvent,
)

from animama.adapters.model_clients._common import get_value, jsonable
from animama.app.model_clients import (
    MCAssistantMessageDoneEvent,
    MCAssistantMessageStartedEvent,
    MCAssistantPhaseEvent,
    MCEvent,
    MCFunctionToolCallDeltaEvent,
    MCFunctionToolCallDoneEvent,
    MCResponseProgressEvent,
    MCResponseStartedEvent,
    MCTerminalCompletedEvent,
    MCTerminalFailedEvent,
    MCTerminalIncompleteEvent,
    MCTextDeltaEvent,
    MCTextDoneEvent,
    MCToolDoneEvent,
    MCToolProgressEvent,
    MCToolStartedEvent,
    MCUnknownProviderEvent,
    ModelClientDelta,
    model_client_event_delta,
)
from animama.domain.usage import Usage

from .final import usage_from_openai_responses
from .support import (
    KNOWN_OUTPUT_ITEM_TYPES,
    OPENAI_API,
    PHASE_COMMENTARY,
    PHASE_FINAL_ANSWER,
    clean_str,
    is_native_tool_item_type,
    native_tool_summary_from_response_item,
    optional_int,
    response_error_details,
    response_identity_details,
    response_incomplete_details,
    response_item_id,
    response_item_status,
    response_item_type,
    response_message_annotation_count,
    response_message_phase,
    response_message_text_length,
    unknown_field_names,
)


def events_from_response_stream_event(
    event: ResponseStreamEvent,
    *,
    provider_type: str,
    model: str,
    previous_response_id: str | None,
) -> tuple[ModelClientDelta, ...]:
    """Normalize one typed Responses stream event into MC observability events."""

    event_type = response_event_type(event)
    details = _event_base_details(event, previous_response_id=previous_response_id)
    if isinstance(event, ResponseCreatedEvent):
        response = event.response
        return (
            responses_stream_event_delta(
                event_cls=MCResponseStartedEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type=event.type,
                response_id=response.id,
                status=response.status,
                details={**details, **response_identity_details(response)},
            ),
        )
    if isinstance(event, ResponseQueuedEvent | ResponseInProgressEvent):
        response = event.response
        return (
            responses_stream_event_delta(
                event_cls=MCResponseProgressEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type=event.type,
                response_id=response.id,
                status=response.status,
                details={**details, **response_identity_details(response)},
            ),
        )
    if isinstance(event, ResponseOutputItemAddedEvent):
        return _response_output_item_event(
            event.item,
            provider_type=provider_type,
            model=model,
            provider_event_type=event.type,
            event_cls=MCAssistantMessageStartedEvent,
            output_index=event.output_index,
            details=details,
        )
    if isinstance(event, ResponseOutputItemDoneEvent):
        return _response_output_item_done_events(
            event.item,
            provider_type=provider_type,
            model=model,
            output_index=event.output_index,
            details=details,
        )
    if isinstance(event, ResponseContentPartAddedEvent | ResponseContentPartDoneEvent):
        part_type = response_item_type(event.part)
        return (
            responses_stream_event_delta(
                event_cls=MCResponseProgressEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type=event.type,
                item_id=event.item_id,
                output_index=event.output_index,
                content_index=event.content_index,
                item_type=part_type,
                details={**details, "output_item_type": part_type},
            ),
        )
    if isinstance(event, ResponseTextDeltaEvent):
        return (
            responses_stream_event_delta(
                event_cls=MCTextDeltaEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type=event.type,
                item_id=event.item_id,
                output_index=event.output_index,
                content_index=event.content_index,
                text_length=len(event.delta or ""),
                logprobs_present=bool(event.logprobs),
                details={**details},
            ),
        )
    if isinstance(event, ResponseTextDoneEvent):
        return (
            responses_stream_event_delta(
                event_cls=MCTextDoneEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type=event.type,
                item_id=event.item_id,
                output_index=event.output_index,
                content_index=event.content_index,
                text_length=len(event.text or ""),
                logprobs_present=bool(event.logprobs),
                details={**details},
            ),
        )
    if isinstance(event, ResponseOutputTextAnnotationAddedEvent):
        return (
            responses_stream_event_delta(
                event_cls=MCResponseProgressEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type=event.type,
                item_id=event.item_id,
                output_index=event.output_index,
                content_index=event.content_index,
                details={**details, "annotation_index": event.annotation_index, "annotation_count": 1},
            ),
        )
    if isinstance(event, ResponseRefusalDeltaEvent):
        return (
            responses_stream_event_delta(
                event_cls=MCResponseProgressEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type=event.type,
                item_id=event.item_id,
                output_index=event.output_index,
                content_index=event.content_index,
                details={**details, "refusal_length": len(event.delta or "")},
            ),
        )
    if isinstance(event, ResponseRefusalDoneEvent):
        return (
            responses_stream_event_delta(
                event_cls=MCTextDoneEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type=event.type,
                item_id=event.item_id,
                output_index=event.output_index,
                content_index=event.content_index,
                text_length=len(event.refusal or ""),
                details={**details, "refusal_length": len(event.refusal or "")},
            ),
        )
    if isinstance(event, ResponseFunctionCallArgumentsDeltaEvent):
        return (
            responses_stream_event_delta(
                event_cls=MCFunctionToolCallDeltaEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type=event.type,
                item_id=event.item_id,
                output_index=event.output_index,
                tool_type="function",
                arguments_fragment_length=len(event.delta or ""),
                details=details,
            ),
        )
    if isinstance(event, ResponseFunctionCallArgumentsDoneEvent):
        return (
            responses_stream_event_delta(
                event_cls=MCFunctionToolCallDoneEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type=event.type,
                item_id=event.item_id,
                output_index=event.output_index,
                tool_type="function",
                # The event carries no tool name; response.output_item.done reports it.
                arguments_length=len(event.arguments or ""),
                details=details,
            ),
        )
    native_tool_event = _native_tool_event_delta(
        event,
        provider_type=provider_type,
        model=model,
        details=details,
    )
    if native_tool_event is not None:
        return (native_tool_event,)
    if isinstance(event, ResponseCompletedEvent):
        response = event.response
        return (
            responses_stream_event_delta(
                event_cls=MCTerminalCompletedEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type=event.type,
                response_id=response.id,
                status=response.status or "completed",
                usage=usage_from_openai_responses(response.usage),
                details={**details, **response_identity_details(response)},
            ),
        )
    if isinstance(event, ResponseIncompleteEvent):
        response = event.response
        incomplete_details = response_incomplete_details(response)
        return (
            responses_stream_event_delta(
                event_cls=MCTerminalIncompleteEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type=event.type,
                response_id=response.id,
                status=response.status or "incomplete",
                incomplete_reason=incomplete_details.get("incomplete_reason"),
                details={
                    **details,
                    **response_identity_details(response),
                    **incomplete_details,
                },
            ),
        )
    if isinstance(event, ResponseFailedEvent):
        response = event.response
        error_details = response_error_details(response)
        return (
            responses_stream_event_delta(
                event_cls=MCTerminalFailedEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type=event.type,
                response_id=response.id,
                status=response.status or "failed",
                provider_error_code=error_details.get("provider_error_code"),
                details={
                    **details,
                    **response_identity_details(response),
                    **error_details,
                },
            ),
        )
    if isinstance(event, ResponseErrorEvent):
        return (
            responses_stream_event_delta(
                event_cls=MCTerminalFailedEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type=event.type,
                status="failed",
                provider_error_code=event.code,
                provider_error_param=event.param,
                details={
                    **details,
                    "provider_error_code": event.code,
                    "provider_error_param": event.param,
                },
            ),
        )
    if event_type == "response.done":
        response = get_value(event, "response")
        return (
            responses_stream_event_delta(
                event_cls=MCTerminalCompletedEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type=event_type,
                response_id=clean_str(get_value(response, "id")),
                status=clean_str(get_value(response, "status")) or "completed",
                details=details,
            ),
        )
    if event_type:
        return (
            responses_stream_event_delta(
                event_cls=MCUnknownProviderEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type=event_type,
                details={
                    **details,
                    "provider_event_type": event_type,
                    "unknown_field_names": unknown_field_names(event),
                },
            ),
        )
    return ()


def response_from_terminal_event(event: ResponseStreamEvent) -> Response:
    """Extract or build the terminal Response object from an SDK event.

    The SDK types ``response.completed`` but leaves the ``response.done`` payload
    from compatible servers as a mapping. Build it leniently, as the SDK builds
    typed events, because such servers omit fields that newer SDK releases mark
    required (for example ``usage.input_tokens_details.cache_write_tokens``).
    """

    response = get_value(event, "response")
    if isinstance(response, Response):
        return response
    payload = jsonable(response)
    if not isinstance(payload, dict):
        raise ValueError(f"{response_event_type(event)} event carried no response object")
    return Response.construct(**payload)


def response_event_type(event: object) -> str:
    """Return the provider event type for typed and duck-typed stream events."""

    return str(get_value(event, "type", "") or "")


def event_metadata(event: Any) -> dict[str, Any]:
    """Build compact error classification metadata from a Responses event."""

    metadata: dict[str, Any] = {"type": str(get_value(event, "type", "") or "")}
    if isinstance(event, ResponseErrorEvent):
        metadata["error"] = {"code": event.code, "message": event.message, "param": event.param}
    response = get_value(event, "response")
    if isinstance(response, Response):
        response_metadata: dict[str, Any] = {
            "id": response.id,
            "status": response.status,
            "error": None,
            "incomplete_details": None,
        }
        if response.error is not None:
            response_metadata["error"] = {
                "code": response.error.code,
                "type": get_value(response.error, "type"),
                "message": response.error.message,
            }
        if response.incomplete_details is not None:
            response_metadata["incomplete_details"] = {
                "reason": get_value(response.incomplete_details, "reason"),
            }
        metadata["response"] = response_metadata
    elif response is not None:
        metadata["response"] = jsonable(response)
    return metadata


def responses_stream_event_delta(
    *,
    event_cls: type[MCEvent],
    provider_type: str,
    model: str,
    provider_event_type: str,
    response_id: str | None = None,
    item_id: str | None = None,
    output_index: int | None = None,
    content_index: int | None = None,
    phase: str | None = None,
    finish_reason: str | None = None,
    tool_type: str | None = None,
    tool_name: str | None = None,
    tool_call_id: str | None = None,
    status: str | None = None,
    usage: Usage | None = None,
    text_length: int | None = None,
    logprobs_present: bool | None = None,
    item_type: str | None = None,
    content_length: int | None = None,
    annotation_count: int | None = None,
    arguments_fragment_length: int | None = None,
    arguments_length: int | None = None,
    incomplete_reason: str | None = None,
    provider_error_code: str | None = None,
    provider_error_param: str | None = None,
    action_type: str | None = None,
    query_count: int | None = None,
    result_count: int | None = None,
    source_count: int | None = None,
    path_length: int | None = None,
    details: dict[str, Any] | None = None,
) -> ModelClientDelta:
    """Build a provider-neutral event delta from Responses event fields."""

    event_kwargs = {
        "provider_type": provider_type,
        "api": OPENAI_API,
        "model": model,
        "provider_event_type": provider_event_type,
        "response_id": response_id,
        "item_id": item_id,
        "output_index": output_index,
        "content_index": content_index,
        "phase": phase,
        "finish_reason": finish_reason,
        "tool_type": tool_type,
        "tool_name": tool_name,
        "tool_call_id": tool_call_id,
        "status": status,
        "usage": usage,
        "text_length": text_length,
        "logprobs_present": logprobs_present,
        "item_type": item_type,
        "content_length": content_length,
        "annotation_count": annotation_count,
        "arguments_fragment_length": arguments_fragment_length,
        "arguments_length": arguments_length,
        "incomplete_reason": incomplete_reason,
        "provider_error_code": provider_error_code,
        "provider_error_param": provider_error_param,
        "action_type": action_type,
        "query_count": query_count,
        "result_count": result_count,
        "source_count": source_count,
        "path_length": path_length,
        "details": details or {},
    }
    init_fields = {event_field.name for event_field in fields(event_cls) if event_field.init}
    # Dataclass field filtering supplies exactly the selected event constructor
    # fields; the callable cast is confined to this reflective construction.
    constructor = cast(Callable[..., MCEvent], event_cls)
    return model_client_event_delta(
        constructor(**{key: value for key, value in event_kwargs.items() if key in init_fields})
    )


def _event_base_details(event: object, *, previous_response_id: str | None) -> dict[str, Any]:
    """Return details common to all normalized Responses stream events."""

    details: dict[str, Any] = {"provider_event_type": response_event_type(event)}
    sequence_number = optional_int(get_value(event, "sequence_number"))
    if sequence_number:
        details["sequence_number"] = sequence_number
    if previous_response_id is not None:
        details["previous_response_id"] = previous_response_id
    return details


def _response_output_item_event(
    item: ResponseOutputItem,
    *,
    provider_type: str,
    model: str,
    provider_event_type: str,
    event_cls: type[MCEvent],
    output_index: int,
    details: dict[str, Any],
) -> tuple[ModelClientDelta, ...]:
    """Normalize output-item start events, including phases and native tools."""

    item_id = response_item_id(item)
    item_type = response_item_type(item)
    status = response_item_status(item)
    phase = response_message_phase(item)
    native_summary = (
        native_tool_summary_from_response_item(
            item,
            output_index=output_index,
            include_output_index=False,
        )
        if is_native_tool_item_type(item_type)
        else {}
    )
    if phase is not None:
        event_cls = MCAssistantMessageStartedEvent
    elif is_native_tool_item_type(item_type):
        event_cls = MCToolStartedEvent
    elif item_type != "message":
        event_cls = MCResponseProgressEvent
    events = [
        responses_stream_event_delta(
            event_cls=event_cls,
            provider_type=provider_type,
            model=model,
            provider_event_type=provider_event_type,
            item_id=item_id,
            output_index=output_index,
            phase=phase,
            tool_type=item_type if is_native_tool_item_type(item_type) else None,
            tool_call_id=native_summary.get("tool_call_id"),
            status=status,
            item_type=item_type,
            action_type=native_summary.get("action_type"),
            query_count=native_summary.get("query_count"),
            result_count=native_summary.get("result_count"),
            source_count=native_summary.get("source_count"),
            path_length=native_summary.get("path_length"),
            details={
                **details,
                "item_type": item_type,
                "status": status,
                **native_summary,
            },
        )
    ]
    if phase is not None:
        events.append(
            responses_stream_event_delta(
                event_cls=MCAssistantPhaseEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type="response.output_item.phase",
                item_id=item_id,
                output_index=output_index,
                phase=phase,
                status=status,
                item_type=item_type,
                details={**details, "item_type": item_type, "phase": phase},
            )
        )
        if phase not in {PHASE_COMMENTARY, PHASE_FINAL_ANSWER}:
            events.append(
                responses_stream_event_delta(
                    event_cls=MCUnknownProviderEvent,
                    provider_type=provider_type,
                    model=model,
                    provider_event_type="response.output_item.unknown_phase",
                    item_id=item_id,
                    output_index=output_index,
                    status=status,
                    details={**details, "item_type": item_type, "phase": phase},
                )
            )
    return tuple(events)


def _response_output_item_done_events(
    item: ResponseOutputItem,
    *,
    provider_type: str,
    model: str,
    output_index: int,
    details: dict[str, Any],
) -> tuple[ModelClientDelta, ...]:
    """Normalize output-item completion events for messages, tools, and unknowns."""

    item_id = response_item_id(item)
    item_type = response_item_type(item)
    if isinstance(item, ResponseFunctionToolCall):
        return (
            responses_stream_event_delta(
                event_cls=MCFunctionToolCallDoneEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type="response.output_item.done",
                item_id=item_id,
                output_index=output_index,
                tool_type="function",
                tool_name=item.name,
                tool_call_id=item.call_id,
                status=item.status,
                arguments_length=len(item.arguments or ""),
                details={
                    **details,
                    "item_type": item_type,
                    "function_name": item.name,
                    "arguments_length": len(item.arguments or ""),
                },
            ),
        )
    if is_native_tool_item_type(item_type):
        summary = native_tool_summary_from_response_item(item, output_index=output_index, include_output_index=False)
        return (
            responses_stream_event_delta(
                event_cls=MCToolDoneEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type="response.output_item.done",
                item_id=item_id,
                output_index=output_index,
                tool_type=item_type,
                tool_call_id=summary.get("tool_call_id"),
                status=response_item_status(item),
                action_type=summary.get("action_type"),
                query_count=summary.get("query_count"),
                result_count=summary.get("result_count"),
                source_count=summary.get("source_count"),
                path_length=summary.get("path_length"),
                details={**details, "item_type": item_type, **summary},
            ),
        )
    if isinstance(item, ResponseOutputMessage):
        phase = response_message_phase(item)
        content_length = response_message_text_length(item)
        annotation_count = response_message_annotation_count(item)
        events = [
            responses_stream_event_delta(
                event_cls=MCAssistantMessageDoneEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type="response.output_item.done",
                item_id=item_id,
                output_index=output_index,
                phase=phase,
                status=item.status,
                item_type=item_type,
                content_length=content_length,
                annotation_count=annotation_count,
                details={
                    **details,
                    "item_type": item_type,
                    "phase": phase,
                    "content_length": content_length,
                    "annotations_count": annotation_count,
                },
            )
        ]
        if phase is not None:
            events.append(
                responses_stream_event_delta(
                    event_cls=MCAssistantPhaseEvent,
                    provider_type=provider_type,
                    model=model,
                    provider_event_type="response.output_item.phase",
                    item_id=item_id,
                    output_index=output_index,
                    phase=phase,
                    status=item.status,
                    item_type=item_type,
                    details={**details, "item_type": item_type, "phase": phase},
                )
            )
            if phase not in {PHASE_COMMENTARY, PHASE_FINAL_ANSWER}:
                events.append(
                    responses_stream_event_delta(
                        event_cls=MCUnknownProviderEvent,
                        provider_type=provider_type,
                        model=model,
                        provider_event_type="response.output_item.unknown_phase",
                        item_id=item_id,
                        output_index=output_index,
                        status=item.status,
                        details={**details, "item_type": item_type, "phase": phase},
                    )
                )
        return tuple(events)
    if item_type not in KNOWN_OUTPUT_ITEM_TYPES:
        return (
            responses_stream_event_delta(
                event_cls=MCUnknownProviderEvent,
                provider_type=provider_type,
                model=model,
                provider_event_type="response.output_item.done",
                item_id=item_id,
                output_index=output_index,
                status=response_item_status(item),
                details={**details, "item_type": item_type},
            ),
        )
    return (
        responses_stream_event_delta(
            event_cls=MCResponseProgressEvent,
            provider_type=provider_type,
            model=model,
            provider_event_type="response.output_item.done",
            item_id=item_id,
            output_index=output_index,
            status=response_item_status(item),
            item_type=item_type,
            details={**details, "item_type": item_type},
        ),
    )


def _native_tool_event_delta(
    event: ResponseStreamEvent,
    *,
    provider_type: str,
    model: str,
    details: dict[str, Any],
) -> ModelClientDelta | None:
    """Normalize hosted/native tool lifecycle events when the SDK exposes them."""

    if isinstance(event, ResponseWebSearchCallInProgressEvent):
        return _native_tool_stream_event(
            event,
            event_cls=MCToolStartedEvent,
            provider_type=provider_type,
            model=model,
            tool_type="web_search_call",
            details=details,
        )
    if isinstance(event, ResponseWebSearchCallSearchingEvent):
        return _native_tool_stream_event(
            event,
            event_cls=MCToolProgressEvent,
            provider_type=provider_type,
            model=model,
            tool_type="web_search_call",
            details=details,
            status="searching",
        )
    if isinstance(event, ResponseWebSearchCallCompletedEvent):
        return _native_tool_stream_event(
            event,
            event_cls=MCToolDoneEvent,
            provider_type=provider_type,
            model=model,
            tool_type="web_search_call",
            details=details,
            status="completed",
        )
    if isinstance(event, ResponseFileSearchCallInProgressEvent):
        return _native_tool_stream_event(
            event,
            event_cls=MCToolStartedEvent,
            provider_type=provider_type,
            model=model,
            tool_type="file_search_call",
            details=details,
        )
    if isinstance(event, ResponseFileSearchCallSearchingEvent):
        return _native_tool_stream_event(
            event,
            event_cls=MCToolProgressEvent,
            provider_type=provider_type,
            model=model,
            tool_type="file_search_call",
            details=details,
            status="searching",
        )
    if isinstance(event, ResponseFileSearchCallCompletedEvent):
        return _native_tool_stream_event(
            event,
            event_cls=MCToolDoneEvent,
            provider_type=provider_type,
            model=model,
            tool_type="file_search_call",
            details=details,
            status="completed",
        )
    if isinstance(event, ResponseCodeInterpreterCallInProgressEvent):
        return _native_tool_stream_event(
            event,
            event_cls=MCToolStartedEvent,
            provider_type=provider_type,
            model=model,
            tool_type="code_interpreter_call",
            details=details,
        )
    if isinstance(event, ResponseCodeInterpreterCallInterpretingEvent):
        return _native_tool_stream_event(
            event,
            event_cls=MCToolProgressEvent,
            provider_type=provider_type,
            model=model,
            tool_type="code_interpreter_call",
            details=details,
            status="interpreting",
        )
    if isinstance(event, ResponseCodeInterpreterCallCompletedEvent):
        return _native_tool_stream_event(
            event,
            event_cls=MCToolDoneEvent,
            provider_type=provider_type,
            model=model,
            tool_type="code_interpreter_call",
            details=details,
            status="completed",
        )
    if isinstance(event, ResponseImageGenCallInProgressEvent):
        return _native_tool_stream_event(
            event,
            event_cls=MCToolStartedEvent,
            provider_type=provider_type,
            model=model,
            tool_type="image_generation_call",
            details=details,
        )
    if isinstance(event, ResponseImageGenCallGeneratingEvent):
        return _native_tool_stream_event(
            event,
            event_cls=MCToolProgressEvent,
            provider_type=provider_type,
            model=model,
            tool_type="image_generation_call",
            details=details,
            status="generating",
        )
    if isinstance(event, ResponseImageGenCallCompletedEvent):
        return _native_tool_stream_event(
            event,
            event_cls=MCToolDoneEvent,
            provider_type=provider_type,
            model=model,
            tool_type="image_generation_call",
            details=details,
            status="completed",
        )
    return None


def _native_tool_stream_event(
    event: Any,
    *,
    event_cls: type[MCEvent],
    provider_type: str,
    model: str,
    tool_type: str,
    details: dict[str, Any],
    status: str | None = None,
) -> ModelClientDelta:
    """Build a native tool started/progress/done event from a Responses event."""

    return responses_stream_event_delta(
        event_cls=event_cls,
        provider_type=provider_type,
        model=model,
        provider_event_type=response_event_type(event),
        item_id=clean_str(get_value(event, "item_id")),
        output_index=optional_int(get_value(event, "output_index")),
        tool_type=tool_type,
        status=status,
        details={**details, "tool_type": tool_type},
    )


__all__ = [
    "event_metadata",
    "events_from_response_stream_event",
    "response_event_type",
    "response_from_terminal_event",
    "responses_stream_event_delta",
]

"""Collects provider-neutral model-client streams into one assistant final per turn,
aggregating usage across tool rounds and retrying stale Responses cursors.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import replace
from typing import Any, cast

from animama.app.chat.memory_cue import AnimaMemoriesTurn
from animama.app.chat.memory_tools import DirectChatMemoryToolService, MemoryToolExecutionContext
from animama.app.model_clients import (
    DirectChatPrompt,
    ModelClientDelta,
    ModelClientError,
    ModelClientFinal,
    ModelClientModeration,
    ModelClientRequest,
    ModelClientToolCall,
    ModelClientToolResult,
    elapsed_ms,
    model_client_preview_log_context,
    model_client_request_log_context,
)
from animama.app.model_clients.context_budget import (
    ContextBudget,
    estimate_prompt_tokens,
    estimate_text_tokens,
    estimate_value_tokens,
)
from animama.app.model_clients.error_categories import ERROR_CONTEXT_EXCEEDED, model_error_category
from animama.app.model_clients.event_summary import ModelClientStreamEventObserver
from animama.app.model_clients.prompt import copy_direct_chat_prompt, prompt_messages
from animama.app.model_clients.tool_rounds import model_request_with_appended_messages, tool_exchange_prompt_items
from animama.app.model_clients.usage_estimate import CONTEXT_TOKENS_METADATA_KEY, context_tokens_from_usage
from animama.app.safety.prompts import COMPANION_GUARDRAILS
from animama.app.web_search import WEB_SEARCH_TOOL_NAME, WebSearchToolService, persisted_web_search_output
from animama.domain.chat import ChatMessage
from animama.domain.events import RunStatusKind
from animama.domain.usage import Usage
from animama.logging import get_logger

from .constants import (
    ANTHROPIC_MESSAGES_PROVIDER,
    CONTEXT_LIMIT_FINAL_INSTRUCTION,
    MAX_MEMORY_TOOL_ROUNDS,
    MEMORY_TOOL_LIMIT_FINAL_INSTRUCTION,
    OPENAI_CHAT_COMPLETIONS_PROVIDER,
    OPENAI_RESPONSES_PROVIDER,
    STRUCTURED_REPAIR_METADATA_KEY,
    STRUCTURED_REPLY_REPAIR_INSTRUCTION,
    STRUCTURED_REPLY_REPAIR_ROUND_INDEX,
)
from .message_builders import (
    anthropic_tool_result_item,
    anthropic_tool_use_item,
    assistant_tool_call_prompt_message,
    internal_tool_call_message,
    internal_tool_result_message,
    model_client_tool_call_prompt_item,
    model_client_tool_result_prompt_item,
    tool_result_prompt_message,
)
from .provider_state import (
    compiled_context_history,
    final_with_previous_response_retry_metadata,
    model_request_without_continuation,
    should_retry_without_previous_response_id,
)
from .response_format import gesture_response_guidance, main_structured_response_guidance
from .types import DirectChatTurnRequest, DirectChatTurnStreamError, PreparedDirectChatTurn

_USAGE_REQUIRED_PROVIDER_TYPES = frozenset(
    {OPENAI_CHAT_COMPLETIONS_PROVIDER, OPENAI_RESPONSES_PROVIDER, ANTHROPIC_MESSAGES_PROVIDER}
)
_log = get_logger("app.chat.direct_turn.model_stream")
# Observers are app-layer callbacks, not provider APIs. They let the direct
# executor react to model-round boundaries and provider-neutral text deltas
# while this collector continues to own tool loops, retries, usage, and final
# signal validation.
ModelRoundObserver = Callable[[int], Awaitable[None]]
TextDeltaObserver = Callable[[int, str], Awaitable[None]]
# Decides whether a turn's final reply needs the one structured repair request.
FinalRepairCheck = Callable[[ModelClientFinal], bool]
# Reports backend work shown in the pending reply, such as a web search.
RunStatusObserver = Callable[[RunStatusKind, str], Awaitable[None]]
# Returns a smaller first request after the server reports an oversized prompt, or None.
RequestShrinker = Callable[[ModelClientRequest], Awaitable[ModelClientRequest | None]]


class DirectTurnModelStreamCollector:
    """Consume provider-neutral model streams until one assistant final is ready.

    The collector is the app-layer boundary that knows how to interpret
    `ModelClientDelta` values, aggregate usage across memory tool rounds, retry
    stale Responses cursors, and return any internal tool transcript messages for
    persistence. It does not know about HTTP/SSE formatting.
    """

    def __init__(
        self,
        *,
        stream: Callable[[ModelClientRequest], AsyncIterator[ModelClientDelta]],
        memory_tool_service: DirectChatMemoryToolService | None,
        load_chat_context: Callable[[str], Awaitable[Any]],
        build_prompt: Callable[..., DirectChatPrompt],
        anima_memories: AnimaMemoriesTurn | None = None,
        web_search_tool: WebSearchToolService | None = None,
        on_run_status: RunStatusObserver | None = None,
    ) -> None:
        self._stream = stream
        self._memory_tool_service = memory_tool_service
        self._load_chat_context = load_chat_context
        self._build_prompt = build_prompt
        # The turn's MEMORIES.md state, shared by every tool call; None keeps the
        # [self]/MEMORIES.md alias unavailable (memory influence is off).
        self._anima_memories = anima_memories
        self._web_search_tool = web_search_tool
        self._on_run_status = on_run_status

    async def collect(
        self,
        prepared: PreparedDirectChatTurn,
        *,
        on_model_round_start: ModelRoundObserver | None = None,
        on_text_delta: TextDeltaObserver | None = None,
        needs_repair: FinalRepairCheck | None = None,
        context_budget: ContextBudget | None = None,
        shrink_request: RequestShrinker | None = None,
    ) -> tuple[ModelClientFinal | None, list[ChatMessage]]:
        """Run the model rounds for one turn, then repair an invalid final reply once.

        ``needs_repair`` is the caller's local validation. When it rejects the
        final, one request without tools asks the model to reply again in the
        required format. The repaired final carries usage for every request;
        if the repair request itself fails, the original final is returned so
        the caller can fall back to its text.

        With a ``context_budget`` (models without native compaction), tool
        results that would push a follow-up round past the window are replaced
        by a tool error, and a server's oversized-prompt rejection of the first
        request is retried once with the request from ``shrink_request``.
        """

        final, internal_messages, final_request = await self._collect_rounds(
            prepared,
            on_model_round_start=on_model_round_start,
            on_text_delta=on_text_delta,
            context_budget=context_budget,
            shrink_request=shrink_request,
        )
        if final is None or final_request is None or needs_repair is None or not needs_repair(final):
            return final, internal_messages
        return await self._repair_final(
            prepared,
            final_request,
            final,
            on_model_round_start=on_model_round_start,
            on_text_delta=on_text_delta,
            context_budget=context_budget,
        ), internal_messages

    async def _repair_final(
        self,
        prepared: PreparedDirectChatTurn,
        final_request: ModelClientRequest,
        final: ModelClientFinal,
        *,
        on_model_round_start: ModelRoundObserver | None,
        on_text_delta: TextDeltaObserver | None,
        context_budget: ContextBudget | None = None,
    ) -> ModelClientFinal:
        _log.warning(
            "Direct chat structured reply repair requested",
            **_direct_turn_log_context(prepared, final_request),
            final_text_length=len(final.text),
        )
        if on_model_round_start is not None:
            await on_model_round_start(STRUCTURED_REPLY_REPAIR_ROUND_INDEX)
        try:
            if "previous_response_retry" in final.raw_provider_metadata:
                # The round succeeded only after dropping a stale Responses cursor.
                final_request = await self._retry_model_request_without_previous_response_id(prepared, final_request)
            repair_request = _structured_repair_request(final_request, final, context_budget)
            if (
                context_budget is not None
                and estimate_prompt_tokens(repair_request.prompt) > context_budget.available_tokens
            ):
                # A repair that would not fit is skipped; the reply falls back to plain text.
                _log.warning(
                    "Direct chat structured reply repair skipped at the context window",
                    **_direct_turn_log_context(prepared, final_request),
                )
                repair_final = None
            else:
                repair_final = await self._collect_model_final(
                    prepared,
                    repair_request,
                    round_index=STRUCTURED_REPLY_REPAIR_ROUND_INDEX,
                    on_text_delta=on_text_delta,
                    allow_previous_response_retry=False,
                )
        except Exception as exc:
            # A failed repair falls back to the original reply's text.
            _log.warning(
                "Direct chat structured reply repair request failed",
                **_direct_turn_log_context(prepared, final_request),
                exc_type=exc.__class__.__name__,
                code=exc.error.code if isinstance(exc, DirectChatTurnStreamError) else None,
            )
            repair_final = None
        if repair_final is None:
            return replace(
                final,
                raw_provider_metadata={
                    **dict(final.raw_provider_metadata),
                    STRUCTURED_REPAIR_METADATA_KEY: "request_failed",
                },
            )
        usage = Usage()
        usage.add(final.usage)
        usage.add(repair_final.usage)
        repaired = _final_with_usage(repair_final, usage, input_moderation=final.input_moderation)
        return replace(
            repaired,
            raw_provider_metadata={**dict(repaired.raw_provider_metadata), STRUCTURED_REPAIR_METADATA_KEY: "attempted"},
        )

    async def _collect_rounds(
        self,
        prepared: PreparedDirectChatTurn,
        *,
        on_model_round_start: ModelRoundObserver | None = None,
        on_text_delta: TextDeltaObserver | None = None,
        context_budget: ContextBudget | None = None,
        shrink_request: RequestShrinker | None = None,
    ) -> tuple[ModelClientFinal | None, list[ChatMessage], ModelClientRequest | None]:
        """Run the initial model request plus any memory tool follow-up rounds.

        A round is one request to the selected model provider. Tool-call finals
        do not complete the user-visible turn; they produce internal tool work
        and then another model round with appended tool results. Returns the
        final with the request that produced it.
        """

        started_at = time.monotonic()
        model_request = prepared.model_request
        # Servers that cannot combine function tools with a response format get
        # tool rounds without the format, then one structured round without
        # tools. Only that last round streams public text.
        structured_format = model_request.prompt.response_format
        # Only Chat Completions rows split: Responses continuation and
        # stale-cursor retries assume one request shape per round.
        split_structured_reply = (
            model_request.model_provider.provider_type == OPENAI_CHAT_COMPLETIONS_PROVIDER
            and bool(model_request.prompt.tools)
            and structured_format is not None
            and not model_request.model_provider.capabilities.tools_with_structured_output
        )
        tool_round_text_observer = on_text_delta
        if split_structured_reply:
            model_request = _model_request_with_response_format(model_request, None)
            tool_round_text_observer = None
        internal_messages: list[ChatMessage] = []
        usage_total = Usage()
        usage_seen = False
        tool_result_cache = _tool_result_cache_from_prompt(model_request.prompt)
        _log.info(
            "Direct chat model stream collection started",
            **_direct_turn_log_context(prepared, model_request),
            memory_tools_available=self._memory_tool_service is not None,
            max_tool_rounds=MAX_MEMORY_TOOL_ROUNDS,
        )

        round_zero_moderation: ModelClientModeration | None = None
        for round_index in range(MAX_MEMORY_TOOL_ROUNDS + 1):
            # Each round must consume the provider stream until the adapter emits
            # `final` or raises. Chat Completions reaches that point after a
            # finish_reason chunk; Responses reaches it after response.completed.
            _log.info(
                "Direct chat model round started",
                **_direct_turn_log_context(prepared, model_request),
                round_index=round_index,
            )
            if on_model_round_start is not None:
                await on_model_round_start(round_index)
            try:
                final = await self._collect_model_final(
                    prepared,
                    model_request,
                    round_index=round_index,
                    on_text_delta=tool_round_text_observer,
                )
            except DirectChatTurnStreamError as exc:
                smaller = (
                    await shrink_request(model_request)
                    if round_index == 0
                    and shrink_request is not None
                    and model_error_category(exc.error.code, exc.error.raw_metadata) == ERROR_CONTEXT_EXCEEDED
                    else None
                )
                if smaller is None:
                    raise
                # Nothing was sent to the client and no tool ran: retry once with less history.
                _log.warning(
                    "Direct chat retrying with less history after the server reported an oversized prompt",
                    **_direct_turn_log_context(prepared, model_request),
                )
                model_request = smaller
                final = await self._collect_model_final(
                    prepared,
                    model_request,
                    round_index=round_index,
                    on_text_delta=tool_round_text_observer,
                )
            if final is None:
                _log.warning(
                    "Direct chat model round ended without final",
                    **_direct_turn_log_context(prepared, model_request),
                    round_index=round_index,
                    elapsed_ms=elapsed_ms(started_at),
                )
                return None, internal_messages, None
            usage_total.add(final.usage)
            usage_seen = True
            if round_index == 0:
                round_zero_moderation = final.input_moderation
            tool_calls = tuple(final.tool_calls)
            _log.info(
                "Direct chat model round final received",
                **_direct_turn_log_context(prepared, model_request),
                round_index=round_index,
                final_text_length=len(final.text),
                tool_call_count=len(tool_calls),
                input_tokens=final.usage.input_tokens,
                output_tokens=final.usage.output_tokens,
                total_tokens=final.usage.total_tokens,
            )
            if not tool_calls and split_structured_reply:
                structured_round_index = round_index + 1
                if on_model_round_start is not None:
                    await on_model_round_start(structured_round_index)
                structured_request = _model_request_without_tools(model_request, response_format=structured_format)
                structured_final = await self._collect_model_final(
                    prepared,
                    structured_request,
                    round_index=structured_round_index,
                    on_text_delta=on_text_delta,
                )
                if structured_final is None:
                    return None, internal_messages, None
                usage_total.add(structured_final.usage)
                _log.info(
                    "Direct chat model stream collection completed",
                    **_direct_turn_log_context(prepared, model_request),
                    round_count=structured_round_index + 1,
                    elapsed_ms=elapsed_ms(started_at),
                    aggregated_usage=True,
                    split_structured_reply=True,
                )
                return (
                    _final_with_usage(structured_final, usage_total, input_moderation=round_zero_moderation),
                    internal_messages,
                    structured_request,
                )
            if not tool_calls:
                # No tool calls means the final model text is ready for parsing.
                # If earlier rounds called tools, usage is folded into this final.
                if round_index == 0:
                    _log.info(
                        "Direct chat model stream collection completed",
                        **_direct_turn_log_context(prepared, model_request),
                        round_count=round_index + 1,
                        elapsed_ms=elapsed_ms(started_at),
                    )
                    return final, internal_messages, model_request
                _log.info(
                    "Direct chat model stream collection completed",
                    **_direct_turn_log_context(prepared, model_request),
                    round_count=round_index + 1,
                    elapsed_ms=elapsed_ms(started_at),
                    aggregated_usage=True,
                )
                return (
                    _final_with_usage(
                        final,
                        usage_total if usage_seen else final.usage,
                        input_moderation=round_zero_moderation,
                    ),
                    internal_messages,
                    model_request,
                )

            if round_index >= MAX_MEMORY_TOOL_ROUNDS:
                # Ask the model for a final answer without tools instead of
                # silently truncating a loop. If it still asks for tools, surface
                # a provider-like error to the caller.
                _log.warning(
                    "Direct chat memory tool round limit reached; requesting forced final",
                    **_direct_turn_log_context(prepared, model_request),
                    round_index=round_index,
                    tool_call_count=len(tool_calls),
                    max_tool_rounds=MAX_MEMORY_TOOL_ROUNDS,
                )
                forced_round_index = round_index + 1
                limit_results = tuple(
                    ModelClientToolResult(
                        call_id=tool_call.id,
                        tool_type=tool_call.tool_type,
                        status="failed",
                        output=_tool_error_json(
                            "memory_tool_round_limit",
                            "Tool call was not executed because the memory tool round limit was reached",
                        ),
                    )
                    for tool_call in tool_calls
                )
                limit_messages = tool_exchange_prompt_items(
                    model_request=model_request,
                    tool_calls=tool_calls,
                    tool_results=limit_results,
                )
                internal_messages.extend(
                    _internal_tool_exchange_messages(
                        prepared=prepared,
                        model_request=model_request,
                        tool_calls=tool_calls,
                        tool_results=limit_results,
                    )
                )
                limit_request = model_request_with_appended_messages(
                    model_request,
                    limit_messages,
                    previous_final=final,
                )
                if on_model_round_start is not None:
                    await on_model_round_start(forced_round_index)
                forced_request = _model_request_without_tools(
                    limit_request,
                    response_format=structured_format,
                    final_instruction=MEMORY_TOOL_LIMIT_FINAL_INSTRUCTION,
                )
                forced_final = await self._collect_model_final(
                    prepared,
                    forced_request,
                    round_index=forced_round_index,
                    on_text_delta=on_text_delta,
                )
                if forced_final is None:
                    return None, internal_messages, None
                usage_total.add(forced_final.usage)
                usage_seen = True
                if not forced_final.tool_calls:
                    _log.info(
                        "Direct chat model stream collection completed",
                        **_direct_turn_log_context(prepared, model_request),
                        round_count=round_index + 2,
                        elapsed_ms=elapsed_ms(started_at),
                        aggregated_usage=True,
                        forced_final=True,
                    )
                    return (
                        _final_with_usage(
                            forced_final,
                            usage_total if usage_seen else forced_final.usage,
                            input_moderation=round_zero_moderation,
                        ),
                        internal_messages,
                        forced_request,
                    )
                raise DirectChatTurnStreamError(
                    request=prepared.request,
                    error=ModelClientError(
                        "Memory tool round limit reached",
                        code="memory_tool_round_limit",
                        raw_metadata={"max_tool_rounds": MAX_MEMORY_TOOL_ROUNDS},
                    ),
                )
            if self._memory_tool_service is None and self._web_search_tool is None:
                raise DirectChatTurnStreamError(
                    request=prepared.request,
                    error=ModelClientError(
                        "Memory tool service is not configured",
                        code="memory_tool_service_missing",
                    ),
                )

            available_tools = _available_tool_names(model_request)
            _log.info(
                "Direct chat memory tool calls requested",
                **_direct_turn_log_context(prepared, model_request),
                round_index=round_index,
                tool_call_count=len(tool_calls),
                tool_names=[tool_call.name for tool_call in tool_calls],
            )
            tool_results: list[ModelClientToolResult] = []
            for tool_call in tool_calls:
                tool_started_at = time.monotonic()
                _log.info(
                    "Direct chat memory tool call started",
                    **_direct_turn_log_context(prepared, model_request),
                    round_index=round_index,
                    tool_name=tool_call.name,
                    tool_call_id=tool_call.id,
                    **model_client_preview_log_context(tool_arguments_preview=tool_call.arguments),
                )
                tool_result = await self._execute_or_reuse_memory_tool_call(
                    tool_call,
                    request=prepared.request,
                    model_request=model_request,
                    available_tools=available_tools,
                    result_cache=tool_result_cache,
                )
                _log.info(
                    "Direct chat memory tool call completed",
                    **_direct_turn_log_context(prepared, model_request),
                    round_index=round_index,
                    tool_name=tool_call.name,
                    tool_call_id=tool_call.id,
                    result_length=len(tool_result.output),
                    elapsed_ms=elapsed_ms(tool_started_at),
                    **model_client_preview_log_context(tool_result_preview=tool_result.output),
                )
                tool_results.append(tool_result)
            result_tuple = tuple(tool_results)
            if context_budget is not None:
                bounded = _tool_results_within_budget(
                    model_request,
                    tool_calls,
                    result_tuple,
                    context_budget,
                    prepared=prepared,
                    structured_format=structured_format,
                )
                if bounded is None:
                    # Even tool errors do not fit: answer without this exchange,
                    # from a request that already fit, instead of failing the turn.
                    internal_messages.extend(
                        _internal_tool_exchange_messages(
                            prepared=prepared,
                            model_request=model_request,
                            tool_calls=tool_calls,
                            tool_results=_too_large_results(result_tuple),
                        )
                    )
                    final_request = _model_request_without_tools(
                        model_request,
                        response_format=structured_format,
                        final_instruction=CONTEXT_LIMIT_FINAL_INSTRUCTION,
                    )
                    if estimate_prompt_tokens(final_request.prompt) > context_budget.available_tokens:
                        raise DirectChatTurnStreamError(
                            request=prepared.request,
                            error=ModelClientError(
                                "The conversation exceeds the model's context window",
                                code="context_window_exceeded",
                                raw_metadata={"provider_error_code": "context_length_exceeded"},
                            ),
                        )
                    final_round_index = round_index + 1
                    if on_model_round_start is not None:
                        await on_model_round_start(final_round_index)
                    context_final = await self._collect_model_final(
                        prepared,
                        final_request,
                        round_index=final_round_index,
                        on_text_delta=on_text_delta,
                    )
                    if context_final is None:
                        return None, internal_messages, None
                    usage_total.add(context_final.usage)
                    return (
                        _final_with_usage(context_final, usage_total, input_moderation=round_zero_moderation),
                        internal_messages,
                        final_request,
                    )
                result_tuple = bounded
            tool_prompt_messages = tool_exchange_prompt_items(
                model_request=model_request,
                tool_calls=tool_calls,
                tool_results=result_tuple,
            )
            internal_messages.extend(
                _internal_tool_exchange_messages(
                    prepared=prepared,
                    model_request=model_request,
                    tool_calls=tool_calls,
                    tool_results=result_tuple,
                )
            )
            # The next model request includes the assistant tool-call item plus
            # tool outputs. Responses providers may carry this via
            # previous_response_id; Chat Completions gets explicit messages.
            model_request = model_request_with_appended_messages(
                model_request,
                tool_prompt_messages,
                previous_final=final,
            )

        return None, internal_messages, None

    async def _collect_model_final(
        self,
        prepared: PreparedDirectChatTurn,
        model_request: ModelClientRequest,
        *,
        round_index: int,
        on_text_delta: TextDeltaObserver | None = None,
        allow_previous_response_retry: bool = True,
    ) -> ModelClientFinal | None:
        """Consume one provider stream and return its final assistant result."""

        started_at = time.monotonic()
        parts: list[str] = []
        raw_metadata: dict[str, Any] = {}
        delta_count = 0
        event_delta_count = 0
        text_delta_count = 0
        first_delta_logged = False
        stream_events = ModelClientStreamEventObserver(
            require_finish_reason_provider_types=(OPENAI_CHAT_COMPLETIONS_PROVIDER,),
            require_usage_provider_types=_USAGE_REQUIRED_PROVIDER_TYPES,
        )
        _log.info(
            "Direct chat model client stream collection started",
            **_direct_turn_log_context(prepared, model_request),
            allow_previous_response_retry=allow_previous_response_retry,
        )
        try:
            async for delta in self._stream(model_request):
                delta_count += 1
                if not first_delta_logged:
                    first_delta_logged = True
                    _log.info(
                        "Direct chat model client first delta received",
                        **_direct_turn_log_context(prepared, model_request),
                        delta_kind=delta.kind,
                        elapsed_ms=elapsed_ms(started_at),
                    )
                if delta.kind == "text_delta" and isinstance(delta.text, str):
                    # Text deltas are a fallback accumulator. Normal adapters
                    # should still emit a `final` with authoritative text/usage.
                    text_delta_count += 1
                    parts.append(delta.text)
                    raw_metadata.update(dict(delta.raw_metadata))
                    if on_text_delta is not None:
                        await on_text_delta(round_index, delta.text)
                elif delta.kind == "event" and delta.stream_event is not None:
                    # Intermediate provider events are logged and summarized,
                    # but not exposed as public chat:sse frames.
                    event_delta_count += 1
                    stream_events.record(delta.stream_event)
                elif delta.kind == "run_status" and delta.run_status is not None:
                    # Provider-side work (a hosted web search or a compaction)
                    # is shown while the reply is pending, like the app search tool.
                    if self._on_run_status is not None:
                        await self._on_run_status(delta.run_status.status, delta.run_status.phase)
                elif delta.kind == "final" and delta.final is not None:
                    # This is the only successful end-of-stream signal accepted
                    # by direct chat. The adapter decides what provider signal is
                    # strong enough to produce this final.
                    final = stream_events.final_with_summary(delta.final, model_request=model_request)
                    _log.info(
                        "Direct chat model client final delta received",
                        **_direct_turn_log_context(prepared, model_request),
                        delta_count=delta_count,
                        event_delta_count=event_delta_count,
                        text_delta_count=text_delta_count,
                        final_text_length=len(final.text),
                        tool_call_count=len(final.tool_calls),
                        elapsed_ms=elapsed_ms(started_at),
                        **model_client_preview_log_context(final_text_preview=final.text),
                    )
                    return final
                elif delta.kind == "error":
                    _log.warning(
                        "Direct chat model client error delta received",
                        **_direct_turn_log_context(prepared, model_request),
                        code=delta.raw_metadata.get("code") if isinstance(delta.raw_metadata, Mapping) else None,
                        elapsed_ms=elapsed_ms(started_at),
                    )
                    raise ModelClientError(
                        delta.error or "Model client stream failed",
                        code="model_client_error",
                        raw_metadata=delta.raw_metadata,
                    )
        except asyncio.CancelledError:
            raise
        except ModelClientError as exc:
            if should_retry_without_previous_response_id(
                exc,
                model_request,
                partial_text_seen=bool(parts),
                allow_previous_response_retry=allow_previous_response_retry,
            ):
                # A Responses previous_response_id can go stale if provider-side
                # state expires. Retry once with explicit chat history, but only
                # before any public text has been seen.
                _log.warning(
                    "Direct chat model client retrying without previous_response_id",
                    **_direct_turn_log_context(prepared, model_request),
                    code=exc.code,
                    elapsed_ms=elapsed_ms(started_at),
                )
                retry_final = await self._collect_model_final(
                    prepared,
                    await self._retry_model_request_without_previous_response_id(prepared, model_request),
                    round_index=round_index,
                    on_text_delta=on_text_delta,
                    allow_previous_response_retry=False,
                )
                if retry_final is not None:
                    return final_with_previous_response_retry_metadata(
                        retry_final,
                        model_request=model_request,
                        error=exc,
                    )
                return None
            raise DirectChatTurnStreamError(request=prepared.request, error=exc) from exc
        if parts:
            # Kept for non-conforming adapters that yielded text but no final.
            # Observability marks this as missing-final so callers can alert.
            _log.warning(
                "Direct chat model client stream ended after text without final",
                **_direct_turn_log_context(prepared, model_request),
                delta_count=delta_count,
                event_delta_count=event_delta_count,
                text_delta_count=text_delta_count,
                elapsed_ms=elapsed_ms(started_at),
            )
            return stream_events.final_with_summary(
                ModelClientFinal(
                    text="".join(parts),
                    usage=Usage(),
                    raw_provider_metadata={**raw_metadata, "final_missing": True},
                ),
                model_request=model_request,
            )
        _log.warning(
            "Direct chat model client stream ended without output",
            **_direct_turn_log_context(prepared, model_request),
            delta_count=delta_count,
            event_delta_count=event_delta_count,
            text_delta_count=text_delta_count,
            elapsed_ms=elapsed_ms(started_at),
        )
        return None

    async def _execute_memory_tool_call(
        self,
        tool_call: ModelClientToolCall,
        *,
        request: DirectChatTurnRequest,
        model_request: ModelClientRequest,
        available_tools: set[str],
    ) -> str:
        """Run one model-requested direct tool (memory or web search) and return provider text output."""

        if tool_call.name not in available_tools:
            return _tool_error_json(
                "unsupported_tool",
                f"Tool {tool_call.name!r} was not available for this turn",
            )
        try:
            parsed = json.loads(tool_call.arguments or "{}")
        except json.JSONDecodeError as exc:
            return _tool_error_json(
                "invalid_arguments",
                "Tool arguments must be a JSON object",
                error=f"{exc.msg} at position {exc.pos}",
            )
        if not isinstance(parsed, Mapping):
            return _tool_error_json("invalid_arguments", "Tool arguments must be a JSON object")
        if tool_call.name == WEB_SEARCH_TOOL_NAME and self._web_search_tool is not None:
            return await self._search_web(parsed)

        # Memory tools are exposed only when the request has a service.
        assert self._memory_tool_service is not None

        context = MemoryToolExecutionContext(
            user_id=request.user_id,
            anima_id=request.anima_id,
            chat_id=request.chat_id,
            run_id=request.run_id,
            provider_type=model_request.model_provider.provider_type,
            model_provider_id=model_request.model_provider.id,
            model=model_request.model_provider.model,
            native_memory_patch_enabled=model_request.provider_options.memory_apply_patch_enabled,
            anima_memories=self._anima_memories,
        )
        if tool_call.tool_type == "apply_patch":
            if tool_call.name != "apply_patch":
                return _tool_error_json(
                    "unsupported_tool",
                    f"Unsupported native memory tool {tool_call.name!r}",
                )
            return await self._memory_tool_service.execute_native_patch(
                operation=parsed,
                context=context,
                tool_call_id=tool_call.id,
            )
        if tool_call.tool_type != "function":
            return _tool_error_json(
                "unsupported_tool_type",
                f"Unsupported memory tool type {tool_call.tool_type!r}",
            )
        return await self._memory_tool_service.execute(
            tool_name=tool_call.name,
            arguments=parsed,
            context=context,
            tool_call_id=tool_call.id,
        )

    async def _execute_or_reuse_memory_tool_call(
        self,
        tool_call: ModelClientToolCall,
        *,
        request: DirectChatTurnRequest,
        model_request: ModelClientRequest,
        available_tools: set[str],
        result_cache: dict[str, tuple[ModelClientToolCall, ModelClientToolResult]],
    ) -> ModelClientToolResult:
        """Execute a tool call once, reusing an identical prior call result."""

        existing = result_cache.get(tool_call.id)
        if existing is not None:
            prior_call, prior_result = existing
            if _same_tool_call(prior_call, tool_call):
                return prior_result
            return ModelClientToolResult(
                call_id=tool_call.id,
                tool_type=tool_call.tool_type,
                status="failed",
                output=_tool_error_json(
                    "tool_call_id_reused",
                    "Tool call id was reused with different arguments; the call was not executed",
                ),
            )
        output = await self._execute_memory_tool_call(
            tool_call,
            request=request,
            model_request=model_request,
            available_tools=available_tools,
        )
        result = ModelClientToolResult(
            call_id=tool_call.id,
            tool_type=tool_call.tool_type,
            status="completed" if _tool_output_ok(output) else "failed",
            output=output,
        )
        result_cache[tool_call.id] = (tool_call, result)
        return result

    async def _search_web(self, arguments: Mapping[str, Any]) -> str:
        """Run the application web search, showing its status while it runs."""

        assert self._web_search_tool is not None
        if self._on_run_status is not None:
            await self._on_run_status("searching_web", "started")
        try:
            return await self._web_search_tool.execute(arguments)
        finally:
            if self._on_run_status is not None:
                await self._on_run_status("searching_web", "finished")

    async def _retry_model_request_without_previous_response_id(
        self,
        prepared: PreparedDirectChatTurn,
        model_request: ModelClientRequest,
    ) -> ModelClientRequest:
        """Rebuild a Responses request without the provider continuation cursor."""

        if prepared.context_loaded:
            return model_request_without_continuation(model_request)

        chat_context = await self._load_chat_context(prepared.request.chat_id)
        response_format = cast(dict[str, Any] | None, prepared.model_request.prompt.response_format)
        prompt = self._build_prompt(
            request=prepared.request,
            model_provider=model_request.model_provider,
            memory_context=prepared.memory_context,
            memory_tool_specs=prepared.memory_tool_specs,
            visible_history=compiled_context_history(chat_context),
            response_format=response_format,
            response_format_guidance=gesture_response_guidance(
                main_structured_response_guidance(model_request.model_provider, prepared.output_type),
                prepared.request.runtime_gesture_descriptors,
            ),
            memory_tools_active=(
                bool(prepared.memory_tool_specs) or model_request.provider_options.memory_apply_patch_enabled
            ),
            native_memory_patch_enabled=model_request.provider_options.memory_apply_patch_enabled,
        )
        extra_messages = prompt_messages(model_request.prompt)[len(prepared.model_request.prompt.messages) :]
        if extra_messages:
            prompt = _prompt_with_appended_messages(prompt, extra_messages)
        return ModelClientRequest(
            model_provider=model_request.model_provider,
            limits=model_request.limits,
            prompt=prompt,
            provider_options=model_request.provider_options,
            continuation=None,
        )


def _direct_turn_log_context(
    prepared: PreparedDirectChatTurn,
    model_request: ModelClientRequest,
) -> dict[str, Any]:
    """Return safe request/model identifiers for direct-turn lifecycle logs."""

    context = model_client_request_log_context(model_request)
    context.update(
        {
            "anima_id": prepared.request.anima_id,
            "chat_id": prepared.request.chat_id,
            "run_id": prepared.request.run_id,
        }
    )
    return context


def _final_with_usage(
    final: ModelClientFinal, usage: Usage, *, input_moderation: ModelClientModeration | None
) -> ModelClientFinal:
    """Return the final model result with usage aggregated across tool rounds.

    ``input_moderation`` comes from round 0, the only round whose new input is the
    user's message; later rounds only add tool exchanges.
    """

    return replace(
        final,
        usage=usage,
        raw_provider_metadata={
            **dict(final.raw_provider_metadata),
            "tool_loop_usage_aggregated": True,
            # Summed usage is billed; only the last request's prompt and reply
            # remain in the next turn's context.
            CONTEXT_TOKENS_METADATA_KEY: _context_tokens(final),
        },
        input_moderation=input_moderation,
        continuation=None,
    )


def _context_tokens(final: ModelClientFinal) -> int:
    """Return the final request's footprint in the next turn's context.

    An adapter may record it itself: an Anthropic request that compacted bills
    the compaction step too, but only its last iteration remains in context.
    """

    recorded = final.raw_provider_metadata.get(CONTEXT_TOKENS_METADATA_KEY)
    if isinstance(recorded, int) and not isinstance(recorded, bool):
        return max(0, recorded)
    return context_tokens_from_usage(final.usage)


def _prompt_tool_names(prompt: DirectChatPrompt) -> set[str]:
    """Extract direct function-tool names available in the current prompt."""

    names: set[str] = set()
    for tool in getattr(prompt, "tools", ()):
        if not isinstance(tool, Mapping) or tool.get("type") != "function":
            continue
        function = tool.get("function")
        if not isinstance(function, Mapping):
            continue
        name = function.get("name")
        if isinstance(name, str) and name.strip():
            names.add(name.strip())
    return names


def _available_tool_names(model_request: ModelClientRequest) -> set[str]:
    """Return function and internal native tools available for one request."""

    names = _prompt_tool_names(model_request.prompt)
    if model_request.provider_options.memory_apply_patch_enabled:
        names.add("apply_patch")
    return names


def _internal_tool_exchange_messages(
    *,
    prepared: PreparedDirectChatTurn,
    model_request: ModelClientRequest,
    tool_calls: tuple[ModelClientToolCall, ...],
    tool_results: tuple[ModelClientToolResult, ...],
) -> list[ChatMessage]:
    """Build hidden audit rows that can reconstruct a future explicit replay."""

    messages: list[ChatMessage] = []
    provider_type = model_request.model_provider.provider_type
    if provider_type in {OPENAI_RESPONSES_PROVIDER, ANTHROPIC_MESSAGES_PROVIDER}:
        # One hidden row per call, holding the provider-shaped item replayed later.
        for tool_call in tool_calls:
            messages.append(
                internal_tool_call_message(
                    request=prepared.request,
                    model_provider=model_request.model_provider,
                    tool_calls=(tool_call,),
                    raw_provider_message=(
                        model_client_tool_call_prompt_item(tool_call)
                        if provider_type == OPENAI_RESPONSES_PROVIDER
                        else anthropic_tool_use_item(tool_call)
                    ),
                )
            )
    else:
        messages.append(
            internal_tool_call_message(
                request=prepared.request,
                model_provider=model_request.model_provider,
                tool_calls=tool_calls,
                raw_provider_message=assistant_tool_call_prompt_message(tool_calls),
            )
        )
    for tool_call, tool_result in zip(tool_calls, tool_results, strict=True):
        if tool_call.name == WEB_SEARCH_TOOL_NAME:
            # Search snippets are used within the turn only; history keeps the query, titles and URLs.
            tool_result = replace(tool_result, output=persisted_web_search_output(tool_result.output))
        if provider_type == OPENAI_RESPONSES_PROVIDER:
            raw_result = model_client_tool_result_prompt_item(tool_result)
        elif provider_type == ANTHROPIC_MESSAGES_PROVIDER:
            raw_result = anthropic_tool_result_item(tool_call, tool_result.output)
        else:
            raw_result = tool_result_prompt_message(tool_call, tool_result.output)
        messages.append(
            internal_tool_result_message(
                request=prepared.request,
                model_provider=model_request.model_provider,
                tool_call=tool_call,
                tool_result=tool_result,
                raw_provider_message=raw_result,
            )
        )
    return messages


def _tool_result_cache_from_prompt(
    prompt: DirectChatPrompt,
) -> dict[str, tuple[ModelClientToolCall, ModelClientToolResult]]:
    """Recover completed native exchanges from persisted provider-neutral history."""

    calls: dict[str, ModelClientToolCall] = {}
    results: dict[str, tuple[ModelClientToolCall, ModelClientToolResult]] = {}
    for item in prompt_messages(prompt):
        item_type = item.get("type")
        call_id = item.get("call_id")
        if item_type == "model_client_tool_call" and isinstance(call_id, str):
            calls[call_id] = ModelClientToolCall(
                id=call_id,
                name=str(item.get("name") or ""),
                arguments=str(item.get("arguments") or ""),
                tool_type=str(item.get("tool_type") or "function"),
            )
        elif item_type == "model_client_tool_result" and isinstance(call_id, str) and call_id in calls:
            result = ModelClientToolResult(
                call_id=call_id,
                tool_type=str(item.get("tool_type") or calls[call_id].tool_type),
                status=str(item.get("status") or "failed"),
                output=str(item.get("output") or ""),
            )
            results[call_id] = (calls[call_id], result)
    return results


def _same_tool_call(left: ModelClientToolCall, right: ModelClientToolCall) -> bool:
    return (
        left.id == right.id
        and left.name == right.name
        and left.arguments == right.arguments
        and left.tool_type == right.tool_type
    )


def _tool_output_ok(output: str) -> bool:
    try:
        parsed = json.loads(output)
    except json.JSONDecodeError:
        return False
    return isinstance(parsed, Mapping) and parsed.get("ok") is True


def _prompt_with_appended_messages(
    prompt: DirectChatPrompt,
    messages: list[dict[str, Any]],
) -> DirectChatPrompt:
    """Copy a prompt with additional OpenAI-compatible chat messages."""

    return copy_direct_chat_prompt(prompt, messages=(*prompt_messages(prompt), *messages))


def _model_request_with_response_format(
    model_request: ModelClientRequest,
    response_format: Any,
) -> ModelClientRequest:
    """Copy a request with ``response_format`` replaced (``None`` removes it)."""

    return replace(model_request, prompt=copy_direct_chat_prompt(model_request.prompt, response_format=response_format))


def _model_request_without_tools(
    model_request: ModelClientRequest,
    *,
    response_format: Any,
    final_instruction: str | None = None,
) -> ModelClientRequest:
    """Build a request for the final answer with tools removed.

    Used for the structured round of a split turn and for the forced final after
    the tool round limit. A ``final_instruction`` is a developer message after
    everything else, followed by the Companion Guardrails so they remain the
    final instruction text (ADR 0008). Responses sends it as a developer item
    after the tool outputs; rows without a developer role fold it into the
    end of the system message; Anthropic sends it as text in the user turn.
    Moderation is only requested on round 0.

    Anthropic keeps the turn's tools and sets ``tool_choice`` to ``none``: a
    changed tool list would invalidate the turn's signed thinking blocks and
    the whole prompt cache.
    """

    prompt = model_request.prompt
    keep_tools = model_request.model_provider.provider_type == ANTHROPIC_MESSAGES_PROVIDER and bool(prompt.tools)
    messages = prompt_messages(prompt)
    if final_instruction is not None:
        messages = [
            *messages,
            {"role": "developer", "content": f"{final_instruction}\n\n{COMPANION_GUARDRAILS.strip()}"},
        ]
    return ModelClientRequest(
        model_provider=model_request.model_provider,
        limits=model_request.limits,
        prompt=copy_direct_chat_prompt(
            prompt,
            messages=messages,
            response_format=response_format,
            tools=prompt.tools if keep_tools else (),
            tool_choice="none" if keep_tools else None,
            parallel_tool_calls=None,
        ),
        provider_options=replace(
            model_request.provider_options,
            memory_apply_patch_enabled=False,
            moderation_model=None,
        ),
        continuation=model_request.continuation,
    )


def _tool_results_within_budget(
    model_request: ModelClientRequest,
    tool_calls: tuple[ModelClientToolCall, ...],
    tool_results: tuple[ModelClientToolResult, ...],
    budget: ContextBudget,
    *,
    prepared: PreparedDirectChatTurn,
    structured_format: Any,
) -> tuple[ModelClientToolResult, ...] | None:
    """Replace results that would push the next round past the window with a tool error.

    The model can then narrow its request (for example read fewer files)
    instead of the turn sending an over-window prompt. Room is kept for what a
    later structured round or repair adds (the response format when tool
    rounds run without it, and the repair instruction with the guardrail).
    Returns ``None`` when even the errors do not fit.
    """

    limit = budget.available_tokens - _final_round_reserve_tokens(model_request, structured_format)

    def next_prompt_tokens(results: tuple[ModelClientToolResult, ...]) -> int:
        messages = tool_exchange_prompt_items(model_request=model_request, tool_calls=tool_calls, tool_results=results)
        return estimate_prompt_tokens(_prompt_with_appended_messages(model_request.prompt, messages))

    if next_prompt_tokens(tool_results) <= limit:
        return tool_results
    spare = max(0, limit - estimate_prompt_tokens(model_request.prompt))
    per_result = spare // (2 * max(1, len(tool_results)))
    bounded = tuple(
        result if estimate_text_tokens(result.output) <= per_result else _too_large_result(result)
        for result in tool_results
    )
    _log.warning(
        "Direct chat tool results replaced to fit the model context window",
        **_direct_turn_log_context(prepared, model_request),
        replaced_count=sum(1 for before, after in zip(tool_results, bounded, strict=True) if before is not after),
    )
    return bounded if next_prompt_tokens(bounded) <= limit else None


def _final_round_reserve_tokens(model_request: ModelClientRequest, structured_format: Any) -> int:
    """Return the tokens a later structured round or repair may add to a tool round's prompt."""

    added_format = (
        estimate_value_tokens(structured_format)
        if structured_format is not None and model_request.prompt.response_format is None
        else 0
    )
    repair_instruction = estimate_text_tokens(
        f"{STRUCTURED_REPLY_REPAIR_INSTRUCTION}\n\n{COMPANION_GUARDRAILS.strip()}"
    )
    return added_format + repair_instruction


def _structured_repair_request(
    final_request: ModelClientRequest,
    invalid_final: ModelClientFinal,
    budget: ContextBudget | None = None,
) -> ModelClientRequest:
    """Build the one repair request for a final reply that failed validation.

    It repeats the request that produced the invalid reply, without tools, and
    adds a repair instruction followed by the guardrail. Chat Completions rows
    with a developer role and Anthropic rows (which keep their tools with
    ``tool_choice`` none) see the invalid reply as the previous assistant
    message; Anthropic reads the instruction in the user turn after it. Rows
    that fold developer messages into the system message would end on that
    assistant message, which local servers continue as a prefill, so they get
    the instruction alone. Responses keeps the round's own
    continuation and also gets the instruction alone, as a developer item
    after the round's new input (the user message or tool outputs). Near a
    context window the invalid reply is also left out when it would not fit.
    """

    model_provider = final_request.model_provider

    def repair(request: ModelClientRequest) -> ModelClientRequest:
        return _model_request_without_tools(
            request,
            response_format=final_request.prompt.response_format,
            final_instruction=STRUCTURED_REPLY_REPAIR_INSTRUCTION,
        )

    if (
        model_provider.provider_type != OPENAI_RESPONSES_PROVIDER
        and model_provider.accepts_developer_role
        and invalid_final.text.strip()
    ):
        with_reply = repair(
            replace(
                final_request,
                prompt=_prompt_with_appended_messages(
                    final_request.prompt,
                    [{"role": "assistant", "content": invalid_final.text}],
                ),
            )
        )
        if budget is None or estimate_prompt_tokens(with_reply.prompt) <= budget.available_tokens:
            return with_reply
    return repair(final_request)


def _tool_error_json(code: str, message: str, **extra: Any) -> str:
    """Format direct memory tool failures as compact JSON tool output."""

    return json.dumps(
        {
            "ok": False,
            "code": code,
            "message": message,
            **extra,
        },
        ensure_ascii=True,
        separators=(",", ":"),
    )


_TOOL_RESULT_TOO_LARGE_OUTPUT = _tool_error_json(
    "tool_result_too_large",
    "The result is too large for the model's context window. Request less, for example fewer files or lines.",
)


def _too_large_result(result: ModelClientToolResult) -> ModelClientToolResult:
    return replace(result, status="failed", output=_TOOL_RESULT_TOO_LARGE_OUTPUT)


def _too_large_results(results: tuple[ModelClientToolResult, ...]) -> tuple[ModelClientToolResult, ...]:
    return tuple(_too_large_result(result) for result in results)


__all__ = ["DirectTurnModelStreamCollector", "RunStatusObserver"]

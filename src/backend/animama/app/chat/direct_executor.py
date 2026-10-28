from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import aclosing, suppress
from dataclasses import replace
from typing import Any, cast

from openai.types.chat import ChatCompletionToolUnionParam

from animama.app.main_structured_response import (
    MAIN_STRUCTURED_RESPONSE_FORMAT,
    MAIN_STRUCTURED_RESPONSE_PART_DISPLAY,
    MAIN_STRUCTURED_RESPONSE_PART_EMOTIONAL_TONE,
    MAIN_STRUCTURED_RESPONSE_PART_SPEECH,
    MainStructuredJsonStreamParser,
    MainStructuredResponse,
    MainStructuredStreamEvent,
    build_main_structured_response_model,
    main_structured_response_from_data,
    plain_text_main_structured_response,
    recover_main_structured_response,
    render_main_structured_json,
    validate_main_structured_gesture,
)
from animama.app.model_clients import (
    DirectChatPrompt,
    ModelClientDelta,
    ModelClientError,
    ModelClientRegistry,
    ModelClientRequest,
    model_client_preview_log_context,
    model_client_request_log_context,
    uses_native_context_compaction,
)
from animama.app.model_clients.context_budget import (
    ContextBudget,
    context_budget_for_model,
    estimate_prompt_tokens,
)
from animama.app.model_clients.prompt import ChatCompletionResponseFormat, copy_direct_chat_prompt
from animama.app.ports import ModelProviderRepository
from animama.app.primary_emotion_update import build_primary_emotion_update_event
from animama.app.safety.moderation import moderation_indicates_crisis
from animama.app.services import AnimaChatProfileService, ChatManager
from animama.app.web_search import WebSearchToolService, web_search_tool_spec
from animama.domain import ModelProvider
from animama.domain.chat import ChatMessage, MessageRole
from animama.domain.events import Event, EventType, RunStatusKind, RunStatusPayload
from animama.logging import get_logger

from .anthropic_instructions import INSTRUCTION_STYLE_ANTHROPIC, INSTRUCTION_STYLE_DEFAULT
from .api_standard import ANTHROPIC_MESSAGES_PROVIDER_TYPE, chat_api_standard_for_provider
from .direct_turn.constants import (
    DIRECT_MEMORY_TOOL_SUPPORT_BY_PROVIDER,
    STRUCTURED_REPAIR_METADATA_KEY,
)
from .direct_turn.context_fit import drop_oldest_history, fit_history
from .direct_turn.events import (
    avatar_gesture_event,
    crisis_support_event,
    error_event,
    memory_updated_event,
    model_error_details,
    user_response_event,
)
from .direct_turn.message_builders import (
    assistant_messages_for_persistence,
    chat_metadata_patch_from_prompt,
    user_provider_message,
)
from .direct_turn.model_stream import DirectTurnModelStreamCollector, RunStatusObserver
from .direct_turn.provider_state import (
    build_memory_tool_config,
    build_model_client_provider_options,
    chat_completions_disallows_reasoning_with_function_tools,
    compiled_context_history,
    memory_tool_config_for_model,
    native_memory_apply_patch_enabled,
    openai_responses_continuation_from_chat,
    should_skip_context_fetch_for_responses_cursor,
    turn_memory_context_manifest,
    turn_reasoning_effort,
    validate_model_provider_for_direct_turn,
    wants_application_web_search,
)
from .direct_turn.response_format import (
    build_main_structured_response_format,
    gesture_response_guidance,
    main_structured_response_format_for_model,
    main_structured_response_guidance,
    response_model_agent_id,
    turn_response_format,
    turn_response_schema_name,
)
from .direct_turn.types import (
    DirectChatAttachmentContext,
    DirectChatTurnRequest,
    DirectChatTurnSetupError,
    DirectChatTurnStreamError,
    ModelClientNotFoundError,
    PreparedDirectChatTurn,
    PreSendCompactionRequest,
    PreSendCompactor,
    RuntimeGestureDescriptor as RuntimeGestureDescriptor,
)
from .memory_arm import DEFAULT_EPISODIC_MEMORY_ARM, EpisodicMemoryArm
from .memory_context import DirectChatMemoryContext, DirectChatMemoryContextError, DirectChatMemoryContextService
from .memory_cue import AnimaMemoriesTurn, memory_cue_payload, turn_memory_message_data
from .memory_tools import MEMORY_TOOL_SEARCH_UPLOADED_FILES, MEMORY_TOOL_WRITE_NAMES
from .openai_prompt import DirectChatPromptAssembler, scoped_prompt_cache_key
from .speech_tags import speech_instruction

_log = get_logger("app.chat.direct_executor")


class _MainStructuredResponseStreamEmitter:
    """Convert streamed main-structured JSON text into direct chat events.

    A "round" is one model request inside a chat turn. Most turns have one
    round; memory tool calls can create follow-up rounds before the final answer.
    The model-stream collector invokes this emitter through simple observer
    callbacks as each round starts and as provider-neutral text deltas arrive.

    This emitter owns the public policy: only semantic main structured parts are
    emitted, never provider chunks or raw JSON. The final validated JSON remains
    authoritative, so this object also tracks streamed speech/display text and
    asks the executor to send full correction events if final parsing disagrees.
    """

    def __init__(self, request: DirectChatTurnRequest, *, response_format: str) -> None:
        self._request = request
        self._response_format = response_format
        self._round_index: int | None = None
        self._parser = MainStructuredJsonStreamParser()
        self._round_disabled = False
        self._round_speech_emitted = False
        self._emitted_emotional_tone: str | None = None
        self._speech_text_parts: list[str] = []
        self._display_text_parts: list[str] = []
        self._speech_event_count = 0
        self._display_event_count = 0

    def start_round(self, round_index: int) -> None:
        """Reset parser state for one provider model round."""

        if self._round_index == round_index:
            return
        self._round_index = round_index
        self._parser = MainStructuredJsonStreamParser()
        self._round_disabled = False
        self._round_speech_emitted = False

    def feed_text_delta(self, round_index: int, text: str) -> list[Event]:
        """Return public semantic events decoded from one provider text delta."""

        if self._round_index != round_index:
            self.start_round(round_index)
        if self._round_disabled:
            return []
        try:
            stream_events = self._parser.feed(text)
        except ValueError as exc:
            self._round_disabled = True
            _log.warning(
                "Direct chat main structured stream parser disabled",
                anima_id=self._request.anima_id,
                chat_id=self._request.chat_id,
                run_id=self._request.run_id,
                round_index=round_index,
                exc_type=exc.__class__.__name__,
            )
            return []

        events = [self._event_from_stream_event(stream_event) for stream_event in stream_events]
        if self._parser.streaming_unavailable:
            self._round_disabled = True
            _log.info(
                "Direct chat main structured stream prefix unavailable",
                anima_id=self._request.anima_id,
                chat_id=self._request.chat_id,
                run_id=self._request.run_id,
                round_index=round_index,
            )
        return events

    def salvaged_response(self) -> MainStructuredResponse | None:
        """Return the reply built from this round's streamed parts once speech reached the client."""

        if not self._round_speech_emitted:
            return None
        data = self._parser.salvaged_data()
        return main_structured_response_from_data(data) if data is not None else None

    def final_response_events(self, parsed: MainStructuredResponse) -> list[Event]:
        """Return final full/correction response events not already covered by deltas."""

        events: list[Event] = []
        if self._emitted_emotional_tone != parsed.emotional_tone:
            events.append(
                user_response_event(
                    self._request,
                    parsed.emotional_tone,
                    response_format=self._response_format,
                    response_part=MAIN_STRUCTURED_RESPONSE_PART_EMOTIONAL_TONE,
                    event_id_suffix="emotional-tone",
                    emotional_intensity=parsed.emotional_intensity,
                )
            )

        streamed_speech = "".join(self._speech_text_parts).strip()
        if not streamed_speech:
            events.append(
                self._full_response_event(
                    parsed.speech,
                    response_part=MAIN_STRUCTURED_RESPONSE_PART_SPEECH,
                    event_id_suffix="speech",
                    part_index=0,
                )
            )
        elif streamed_speech != parsed.speech:
            events.append(
                self._full_response_event(
                    parsed.speech,
                    response_part=MAIN_STRUCTURED_RESPONSE_PART_SPEECH,
                    event_id_suffix="speech-final",
                    part_index=self._speech_event_count,
                )
            )

        streamed_display = "".join(self._display_text_parts).strip()
        if parsed.display and not streamed_display:
            events.append(
                self._full_response_event(
                    parsed.display,
                    response_part=MAIN_STRUCTURED_RESPONSE_PART_DISPLAY,
                    event_id_suffix="display",
                    part_index=0,
                )
            )
        elif parsed.display and streamed_display != parsed.display:
            events.append(
                self._full_response_event(
                    parsed.display,
                    response_part=MAIN_STRUCTURED_RESPONSE_PART_DISPLAY,
                    event_id_suffix="display-final",
                    part_index=self._display_event_count,
                )
            )
        return events

    def _event_from_stream_event(self, stream_event: MainStructuredStreamEvent) -> Event:
        response_part = stream_event.response_part
        if response_part == MAIN_STRUCTURED_RESPONSE_PART_EMOTIONAL_TONE:
            self._emitted_emotional_tone = stream_event.text
            event_id_suffix = "stream-emotional-tone"
        elif response_part == MAIN_STRUCTURED_RESPONSE_PART_SPEECH:
            if stream_event.text:
                self._speech_text_parts.append(stream_event.text)
                self._round_speech_emitted = True
            self._speech_event_count += 1
            event_id_suffix = f"stream-speech-{stream_event.part_index or 0}"
        elif response_part == MAIN_STRUCTURED_RESPONSE_PART_DISPLAY:
            if stream_event.text:
                self._display_text_parts.append(stream_event.text)
            self._display_event_count += 1
            event_id_suffix = f"stream-display-{stream_event.part_index or 0}"
        else:
            event_id_suffix = f"stream-{response_part}"
        return user_response_event(
            self._request,
            stream_event.text,
            response_format=self._response_format,
            response_part=response_part,
            event_id_suffix=event_id_suffix,
            is_delta=stream_event.is_delta,
            part_index=stream_event.part_index,
            part_final=stream_event.part_final,
            emotional_intensity=stream_event.emotional_intensity,
        )

    def _full_response_event(
        self,
        text: str,
        *,
        response_part: str,
        event_id_suffix: str,
        part_index: int,
    ) -> Event:
        return user_response_event(
            self._request,
            text,
            response_format=self._response_format,
            response_part=response_part,
            event_id_suffix=event_id_suffix,
            is_delta=False,
            part_index=part_index,
            part_final=True,
        )


# Recoveries whose reply is not the final text itself; history replays a
# synthesized structured reply instead.
_SYNTHESIZED_RECOVERIES = frozenset({"salvaged", "plain_text"})


def _recover_final_reply(
    final: Any,
    output_type: Any,
    salvaged: list[MainStructuredResponse],
    invalid_text: str | None,
) -> tuple[MainStructuredResponse | None, str | None]:
    """Return the turn's reply and how it was recovered (``None`` when valid as sent).

    Order: the final text validates (``"repaired"`` if a repair request produced
    it), then the reply salvaged from already-streamed speech, then the
    model's text as a neutral plain-text reply: the repair's text, or the
    invalid original when the repair has nothing speakable. ``(None, None)``
    means there is nothing speakable.
    """

    try:
        parsed = recover_main_structured_response(final.text, output_type)
    except ValueError:
        parsed = None
    repaired = final.raw_provider_metadata.get(STRUCTURED_REPAIR_METADATA_KEY) == "attempted"
    if parsed is not None:
        return parsed, "repaired" if repaired else None
    if salvaged:
        return salvaged[-1], "salvaged"
    plain = plain_text_main_structured_response(final.text)
    if plain is None and invalid_text is not None:
        plain = plain_text_main_structured_response(invalid_text)
    return (plain, "plain_text") if plain is not None else (None, None)


class DirectChatTurnExecutor:
    """High-level app-layer orchestrator for one request-local direct chat turn.

    The detailed stream collection, persistence payload building, provider
    continuation state, and event construction live under ``direct_turn``. This
    class intentionally keeps the caller-facing flow in one place while those
    lower-level concerns are split into focused modules.
    """

    def __init__(
        self,
        *,
        registry: ModelClientRegistry,
        profile_service: AnimaChatProfileService | None = None,
        model_providers: ModelProviderRepository | None = None,
        chat_manager: ChatManager | None = None,
        turn_recorder: Any | None = None,
        memory_episode_recorder: Any | None = None,
        prompt_assembler: DirectChatPromptAssembler | None = None,
        memory_context_service: DirectChatMemoryContextService | None = None,
        memory_tool_service: Any | None = None,
        pre_send_compactor: PreSendCompactor | None = None,
        pre_send_compaction_timeout_seconds: float = 90.0,
        web_search_tool: WebSearchToolService | None = None,
        episodic_memory_arm: EpisodicMemoryArm = DEFAULT_EPISODIC_MEMORY_ARM,
    ) -> None:
        self._registry = registry
        self._profile_service = profile_service
        self._model_providers = model_providers
        self._chat_manager = chat_manager
        self._turn_recorder = turn_recorder
        self._memory_episode_recorder = memory_episode_recorder
        self._prompt_assembler = prompt_assembler or DirectChatPromptAssembler()
        self._memory_context_service = memory_context_service
        self._memory_tool_service = memory_tool_service
        self._pre_send_compactor = pre_send_compactor
        self._pre_send_compaction_timeout_seconds = pre_send_compaction_timeout_seconds
        self._web_search_tool = web_search_tool
        # Only the model benchmark chooses an arm (app/chat/memory_arm.py); production keeps the default.
        self._episodic_memory_arm = episodic_memory_arm

    async def stream(self, model_request: ModelClientRequest) -> AsyncIterator[ModelClientDelta]:
        """Proxy one provider-neutral request to the registered shared model client."""

        provider_type = model_request.model_provider.provider_type
        client = self._registry.get(provider_type)
        if client is None:
            raise ModelClientNotFoundError(f"No model client registered for provider type {provider_type!r}")
        _log.info(
            "Direct chat model client dispatch started",
            **model_client_request_log_context(model_request, include_prompt_preview=True),
        )
        async for delta in client.stream(model_request):
            yield delta

    async def stream_turn(self, request: DirectChatTurnRequest) -> AsyncIterator[Event]:
        """Run one direct chat turn through the model-client boundary."""

        prepared = await self.prepare_turn(request)
        async for event in self.stream_prepared_turn(prepared):
            yield event

    async def prepare_turn(self, request: DirectChatTurnRequest) -> PreparedDirectChatTurn:
        """Resolve app-layer context and provider request data before streaming.

        The prepared turn is intentionally provider-neutral. OpenAI-specific
        details, such as Chat Completions chunks or Responses events, are handled
        only after this point by the selected model-client adapter.
        """

        _, _, chat_manager, memory_context_service = self._required_services()
        _log.info(
            "Direct chat turn preparation started",
            anima_id=request.anima_id,
            chat_id=request.chat_id,
            run_id=request.run_id,
            requested_model_provider_id=request.model_provider_id,
            incognito=request.options.incognito,
            memory_influence_disabled=request.options.disable_memory_influence,
            memory_updates_disabled=request.options.disable_memory_updates,
            native_tools=list(request.options.native_tools),
            reasoning_effort=request.options.reasoning_effort,
        )
        # Memory tools are request-scoped. Incognito and memory-disable flags,
        # then the selected model's tool support and write opt-out, narrow them
        # before provider validation so the upstream request never offers tools
        # the model cannot use.
        memory_tool_config = build_memory_tool_config(
            request.options,
            enabled=self._memory_tool_service is not None,
        )
        model_provider = await self._resolve_model_provider(request)
        memory_tool_config = memory_tool_config_for_model(memory_tool_config, model_provider)
        api_standard_profile = chat_api_standard_for_provider(model_provider)
        if api_standard_profile is None:
            raise DirectChatTurnSetupError(f"chat_api_standard_unsupported: {model_provider.id}")
        web_search_active = self._application_web_search_active(request, model_provider)
        validate_model_provider_for_direct_turn(
            model_provider,
            request_options=request.options,
            memory_tools_active=memory_tool_config.active or web_search_active,
        )
        if self._registry.get(model_provider.provider_type) is None:
            raise ModelClientNotFoundError(
                f"No model client registered for provider type {model_provider.provider_type!r}"
            )

        # Chat ownership is checked by the ChatManager before the compiled
        # history or continuation cursor can be used in a model request.
        chat = await chat_manager.ensure_owned_chat(
            anima_id=request.anima_id,
            chat_id=request.chat_id,
            user_id=request.user_id,
            api_standard=api_standard_profile.api_standard,
            model_provider_id=model_provider.id,
        )
        try:
            memory_context = await memory_context_service.build_context(
                user_id=request.user_id,
                anima_id=request.anima_id,
                chat_metadata=getattr(chat, "metadata", {}),
                request_options=request.options,
            )
        except DirectChatMemoryContextError as exc:
            raise DirectChatTurnSetupError(str(exc)) from exc
        _log.info(
            "Direct chat memory context built",
            anima_id=request.anima_id,
            chat_id=request.chat_id,
            run_id=request.run_id,
            memory_tools_active=memory_tool_config.active,
            memory_tool_reads=memory_tool_config.allow_reads,
            memory_tool_writes=memory_tool_config.allow_writes,
            attached_file_count=len(request.attached_file_ids),
        )
        memory_tool_specs: tuple[dict[str, Any], ...] = ()
        native_memory_patch = native_memory_apply_patch_enabled(
            model_provider,
            memory_tool_config=memory_tool_config,
        )
        if memory_tool_config.active:
            assert self._memory_tool_service is not None
            memory_tool_specs = tuple(
                self._memory_tool_service.tool_specs(
                    allow_reads=memory_tool_config.allow_reads,
                    allow_writes=memory_tool_config.allow_writes and not native_memory_patch,
                    allow_uploaded_file_tools=memory_tool_config.allow_reads and bool(request.attached_file_ids),
                )
            )
        if web_search_active:
            memory_tool_specs = (*memory_tool_specs, web_search_tool_spec())
        # Responses providers can continue from the provider-managed response id
        # stored on the chat row. Chat Completions always receives explicit
        # compiled history.
        continuation = openai_responses_continuation_from_chat(chat, model_provider)
        skip_context_fetch = should_skip_context_fetch_for_responses_cursor(model_provider, continuation)
        chat_context = None
        compiled_history: list[Any] = []
        if not skip_context_fetch:
            # Anthropic chats replay from their newest server-side compaction
            # block instead of the application's compaction summary.
            chat_context = await chat_manager.get_chat_context(
                chat_id=request.chat_id,
                native_compaction=model_provider.provider_type == ANTHROPIC_MESSAGES_PROVIDER_TYPE,
            )
            compiled_history = compiled_context_history(chat_context)
        _log.info(
            "Direct chat history context prepared",
            anima_id=request.anima_id,
            chat_id=request.chat_id,
            run_id=request.run_id,
            context_loaded=not skip_context_fetch,
            previous_response_id_present=continuation is not None,
            compiled_history_count=len(compiled_history),
            visible_message_count=len(getattr(chat_context, "messages", ()) or ()),
        )
        # The public assistant payload still uses Animama's structured response
        # contract. Provider adapters only stream raw model text/events; parsing
        # and avatar state derivation happen after the final model result.
        runtime_gesture_ids = tuple(request.runtime_gesture_ids) if request.runtime_gesture_ids is not None else ()
        output_type = build_main_structured_response_model(
            agent_id=response_model_agent_id(request.node_id),
            gesture_ids=runtime_gesture_ids,
            remember=self._episodic_memory_arm.remember,
        )
        response_format = main_structured_response_format_for_model(
            model_provider,
            output_type,
            name=turn_response_schema_name(request.options),
        )
        response_event_format = turn_response_format(request.options)
        model_request = ModelClientRequest(
            model_provider=model_provider,
            prompt=self._build_prompt(
                request=request,
                model_provider=model_provider,
                memory_context=memory_context,
                memory_tool_specs=memory_tool_specs,
                visible_history=compiled_history,
                response_format=response_format,
                response_format_guidance=gesture_response_guidance(
                    main_structured_response_guidance(model_provider, output_type),
                    request.runtime_gesture_descriptors,
                ),
                memory_tools_active=memory_tool_config.active or web_search_active,
                native_memory_patch_enabled=native_memory_patch,
            ),
            provider_options=build_model_client_provider_options(
                request.options,
                model_provider=model_provider,
                memory_tool_config=memory_tool_config,
                provider_moderation=request.provider_moderation,
            ),
            continuation=continuation,
        )
        _log.info(
            "Direct chat turn prepared",
            **model_client_request_log_context(model_request),
        )
        return PreparedDirectChatTurn(
            request=request,
            chat=chat,
            model_request=model_request,
            output_type=output_type,
            response_format=response_event_format,
            memory_context=memory_context,
            memory_tool_specs=memory_tool_specs,
            context_loaded=not skip_context_fetch,
            runtime_revision=request.runtime_revision,
            runtime_gesture_ids=runtime_gesture_ids,
            visible_history=tuple(compiled_history),
        )

    async def stream_prepared_turn(self, prepared: PreparedDirectChatTurn) -> AsyncGenerator[Event, None]:
        """Invoke the model client and translate the final result into domain events.

        A caller that stops early closes the generator, which stops its provider stream.
        """

        # Each delegated stream is closed with this one, so its own cleanup (the
        # provider collector's cancellation) finishes before the caller moves on.
        fitted: PreparedDirectChatTurn | None = None
        async with aclosing(self._fit_to_context_window(prepared)) as fitting:
            async for item in fitting:
                if isinstance(item, Event):
                    yield item
                else:
                    fitted = item
        if fitted is None:
            return
        async with aclosing(self._stream_fitted_turn(fitted)) as events:
            async for event in events:
                yield event

    async def _stream_fitted_turn(self, prepared: PreparedDirectChatTurn) -> AsyncGenerator[Event, None]:
        """Stream a turn whose prompt fits the model's context window."""

        _log.info(
            "Direct chat prepared turn execution started",
            **model_client_request_log_context(prepared.model_request),
        )
        stream_emitter = (
            _MainStructuredResponseStreamEmitter(
                prepared.request,
                response_format=prepared.response_format,
            )
            if prepared.response_format == MAIN_STRUCTURED_RESPONSE_FORMAT
            else None
        )
        early_event_queue: asyncio.Queue[Event | None] = asyncio.Queue()
        # The Anima's MEMORIES.md is reachable only while memory influence is on.
        anima_memories = (
            None
            if prepared.request.options.disable_memory_influence
            else AnimaMemoriesTurn(
                seen_version=getattr(prepared.memory_context, "anima_memories_version", None),
                writable=self._episodic_memory_arm.anima_memories_writes,
            )
        )

        async def on_model_round_start(round_index: int) -> None:
            if stream_emitter is not None:
                stream_emitter.start_round(round_index)

        async def on_text_delta(round_index: int, text: str) -> None:
            if stream_emitter is None:
                return
            for event in stream_emitter.feed_text_delta(round_index, text):
                await early_event_queue.put(event)

        # Statuses still open when the turn's model work ends (a failed or
        # retried provider stream) are finished then, so each started status
        # is followed by finished.
        open_statuses: list[RunStatusKind] = []

        async def on_run_status(status: RunStatusKind, phase: str) -> None:
            if phase == "started":
                open_statuses.append(status)
            elif status in open_statuses:
                open_statuses.remove(status)
            await early_event_queue.put(self._run_status_event(prepared.request, status, phase))

        # The collector asks `needs_repair` about the turn's final reply before
        # any repair round. A reply whose speech already reached the client is
        # salvaged from the streamed parts instead, so no speech is repeated;
        # an invalid reply's text is kept as the plain-text fallback in case
        # the repair has nothing speakable.
        salvaged: list[MainStructuredResponse] = []
        invalid_texts: list[str] = []

        def needs_repair(final: Any) -> bool:
            try:
                recover_main_structured_response(final.text, prepared.output_type)
                return False
            except ValueError:
                pass
            salvaged_response = stream_emitter.salvaged_response() if stream_emitter is not None else None
            if salvaged_response is not None:
                salvaged.append(salvaged_response)
                return False
            invalid_texts.append(final.text)
            return True

        context_budget = self._context_budget(prepared)

        async def shrink_request(model_request: ModelClientRequest) -> ModelClientRequest | None:
            # A server that still reports an oversized prompt gets one retry
            # with about half of the remaining history left out.
            history = drop_oldest_history(prepared.visible_history, fraction=0.5)
            if len(history) == len(prepared.visible_history):
                return None
            # Keep the failed request's format: split rows send tool rounds without one.
            prompt = copy_direct_chat_prompt(
                self._prompt_for_history(prepared, history),
                response_format=model_request.prompt.response_format,
            )
            return replace(model_request, prompt=prompt)

        async def collect_model_stream() -> tuple[Any, list[ChatMessage]]:
            try:
                return await self._model_stream_collector(
                    anima_memories=anima_memories, on_run_status=on_run_status
                ).collect(
                    prepared,
                    on_model_round_start=on_model_round_start,
                    on_text_delta=on_text_delta,
                    needs_repair=needs_repair,
                    context_budget=context_budget,
                    shrink_request=shrink_request if context_budget is not None else None,
                )
            finally:
                while open_statuses:
                    await early_event_queue.put(
                        self._run_status_event(prepared.request, open_statuses.pop(), "finished")
                    )
                await early_event_queue.put(None)

        collector_task = asyncio.create_task(
            collect_model_stream(),
            name=f"direct-chat-model-stream-{prepared.request.run_id}",
        )
        try:
            # The collector owns provider stream consumption, final-signal
            # validation, and request-local memory tool loops.
            while True:
                event = await early_event_queue.get()
                if event is None:
                    break
                yield event
            final, internal_tool_messages = await collector_task
        except DirectChatTurnStreamError as exc:
            _log.warning(
                "Direct chat model stream failed",
                anima_id=prepared.request.anima_id,
                chat_id=prepared.request.chat_id,
                run_id=prepared.request.run_id,
                code=exc.error.code,
                error=exc.error.message,
                details=dict(exc.error.raw_metadata),
            )
            yield error_event(
                prepared.request,
                message=exc.error.message,
                code=exc.error.code or "model_client_error",
                details=model_error_details(exc.error, prepared.model_request.model_provider),
            )
            return
        finally:
            # A cancelled or closed stream (its reader stopped) must not leave the
            # collector's provider call running and billing in the background.
            if not collector_task.done():
                collector_task.cancel()
                with suppress(asyncio.CancelledError):
                    await collector_task
        if final is not None and prepared.model_request.provider_options.moderation_model is not None:
            # Provider moderation arrives with the completed response, after the
            # reply text. It can only add a crisis card; it never alters the turn.
            if moderation_indicates_crisis(final.input_moderation):
                yield crisis_support_event(prepared.request, source="moderation")
            elif final.input_moderation is None or final.input_moderation.status == "error":
                _log.warning(
                    "Direct chat provider moderation unavailable",
                    anima_id=prepared.request.anima_id,
                    run_id=prepared.request.run_id,
                    status=None if final.input_moderation is None else final.input_moderation.status,
                )
        if final is None:
            _log.warning(
                "Direct chat model stream returned no final",
                anima_id=prepared.request.anima_id,
                chat_id=prepared.request.chat_id,
                run_id=prepared.request.run_id,
            )
            yield error_event(
                prepared.request,
                message="Model client did not return a final response",
                code="model_client_missing_final",
            )
            return
        _log.info(
            "Direct chat model final received",
            anima_id=prepared.request.anima_id,
            chat_id=prepared.request.chat_id,
            run_id=prepared.request.run_id,
            final_text_length=len(final.text),
            tool_call_count=len(final.tool_calls),
            input_tokens=final.usage.input_tokens,
            output_tokens=final.usage.output_tokens,
            total_tokens=final.usage.total_tokens,
            **model_client_preview_log_context(final_text_preview=final.text),
        )

        # Only the final assistant text is parsed into Animama's structured
        # response. Intermediate provider events stay in model-client
        # observability metadata rather than becoming public chat SSE frames.
        parsed, recovery = _recover_final_reply(
            final, prepared.output_type, salvaged, invalid_texts[0] if invalid_texts else None
        )
        if parsed is None:
            _log.warning(
                "Direct chat structured response parse failed",
                anima_id=prepared.request.anima_id,
                chat_id=prepared.request.chat_id,
                run_id=prepared.request.run_id,
                final_text_length=len(final.text),
            )
            yield error_event(
                prepared.request,
                message="Model client returned an invalid main structured response",
                code="main_structured_response_parse_failed",
            )
            return
        if recovery is not None:
            _log.warning(
                "Direct chat structured reply recovered",
                anima_id=prepared.request.anima_id,
                chat_id=prepared.request.chat_id,
                run_id=prepared.request.run_id,
                recovery=recovery,
                model_provider_id=prepared.model_request.model_provider.id,
                structured_output_transport=(
                    prepared.model_request.model_provider.capabilities.structured_output_transport
                ),
                final_text_length=len(final.text),
                speech_length=len(parsed.speech),
            )
        _log.info(
            "Direct chat structured response parsed",
            anima_id=prepared.request.anima_id,
            chat_id=prepared.request.chat_id,
            run_id=prepared.request.run_id,
            emotional_tone=parsed.emotional_tone,
            emotional_intensity=parsed.emotional_intensity,
            speech_length=len(parsed.speech or ""),
            display_length=len(parsed.display or ""),
            gesture=parsed.gesture,
            **model_client_preview_log_context(
                speech_preview=parsed.speech,
                display_preview=parsed.display,
            ),
        )

        # Emit any structured response parts that were not already covered by
        # semantic stream chunks. The final parsed object remains authoritative.
        response_events = (
            stream_emitter.final_response_events(parsed)
            if stream_emitter is not None
            else [
                user_response_event(
                    prepared.request,
                    parsed.emotional_tone,
                    response_format=prepared.response_format,
                    response_part=MAIN_STRUCTURED_RESPONSE_PART_EMOTIONAL_TONE,
                    event_id_suffix="emotional-tone",
                    emotional_intensity=parsed.emotional_intensity,
                ),
                user_response_event(
                    prepared.request,
                    parsed.speech,
                    response_format=prepared.response_format,
                    response_part=MAIN_STRUCTURED_RESPONSE_PART_SPEECH,
                    event_id_suffix="speech",
                ),
                *(
                    [
                        user_response_event(
                            prepared.request,
                            parsed.display,
                            response_format=prepared.response_format,
                            response_part=MAIN_STRUCTURED_RESPONSE_PART_DISPLAY,
                            event_id_suffix="display",
                        )
                    ]
                    if parsed.display
                    else []
                ),
            ]
        )
        for event in response_events:
            yield event
        gesture = validate_main_structured_gesture(
            parsed.gesture,
            gesture_ids=prepared.runtime_gesture_ids,
        ).gesture
        if gesture:
            yield avatar_gesture_event(prepared.request, gesture)
        if not prepared.request.options.disable_emotion_updates:
            yield build_primary_emotion_update_event(
                anima_id=prepared.request.anima_id,
                chat_id=prepared.request.chat_id,
                user_id=prepared.request.user_id,
                run_id=prepared.request.run_id,
                node_id=prepared.request.node_id,
                emotional_state=prepared.request.emotional_state,
                emotional_tone=parsed.emotional_tone,
                emotional_intensity=parsed.emotional_intensity,
            )

        if not prepared.request.options.incognito:
            api_standard_profile = chat_api_standard_for_provider(prepared.model_request.model_provider)
            if api_standard_profile is None:
                raise DirectChatTurnSetupError(
                    f"chat_api_standard_unsupported: {prepared.model_request.model_provider.id}"
                )
            # Persist the user message, internal memory tool transcript, final
            # assistant message, usage, and provider metadata after successful
            # parsing. Incognito turns deliberately skip durable history. The
            # assistant row is append-only, so its memory block is built first.
            memory_data = turn_memory_message_data(
                updates_enabled=not prepared.request.options.disable_memory_updates,
                anima_memories=anima_memories,
            )
            _log.info(
                "Direct chat turn persistence started",
                anima_id=prepared.request.anima_id,
                chat_id=prepared.request.chat_id,
                run_id=prepared.request.run_id,
                internal_tool_message_count=len(internal_tool_messages),
            )
            record_result = await self._record_turn(
                anima_id=prepared.request.anima_id,
                chat_id=prepared.request.chat_id,
                user_msg=ChatMessage(
                    id=None,
                    chat_id=prepared.request.chat_id,
                    run_id=prepared.request.run_id,
                    message_type="message",
                    role=MessageRole.USER,
                    content=prepared.request.user_message,
                    data=(
                        {"attached_file_ids": list(prepared.request.attached_file_ids)}
                        if prepared.request.attached_file_ids
                        else None
                    ),
                    usage=None,
                    turn=None,
                    created_at=None,
                    raw_provider_message=user_provider_message(prepared.request.user_message),
                ),
                assistant_msg=assistant_messages_for_persistence(
                    request=prepared.request,
                    structured=parsed.structured,
                    final=final,
                    model_provider=prepared.model_request.model_provider,
                    internal_tool_messages=internal_tool_messages,
                    memory=memory_data,
                    structured_recovery=recovery,
                    replay_text=(
                        render_main_structured_json(parsed, remember=self._episodic_memory_arm.remember)
                        if recovery in _SYNTHESIZED_RECOVERIES
                        else None
                    ),
                ),
                chat_metadata_patch=chat_metadata_patch_from_prompt(prepared.model_request.prompt),
                last_model_client=api_standard_profile.model_client,
                last_model_id=prepared.model_request.model_provider.model,
                last_model_provider_id=prepared.model_request.model_provider.id,
            )
            _log.info(
                "Direct chat turn persistence completed",
                anima_id=prepared.request.anima_id,
                chat_id=prepared.request.chat_id,
                run_id=prepared.request.run_id,
                internal_tool_message_count=len(internal_tool_messages),
            )
            assistant_message = _assistant_message_from_record_result(record_result)
            episode_text = await self._record_episode_memory(
                prepared=prepared,
                parsed=parsed,
                source_message_id=(
                    str(assistant_message.id)
                    if assistant_message is not None and assistant_message.id is not None
                    else None
                ),
            )
            memory_cue = memory_cue_payload(episode_text=episode_text, memories=memory_data["memories"])
            if memory_cue is not None:
                # Sent after persistence so the chat can attach the cue to the saved reply.
                yield memory_updated_event(
                    prepared.request,
                    message_id=assistant_message.id if assistant_message is not None else None,
                    memory_cue=memory_cue,
                )
        else:
            _log.info(
                "Direct chat turn persistence skipped",
                anima_id=prepared.request.anima_id,
                chat_id=prepared.request.chat_id,
                run_id=prepared.request.run_id,
                reason="incognito",
            )

    def _application_web_search_active(self, request: DirectChatTurnRequest, model_provider: ModelProvider) -> bool:
        """Return whether this turn offers the application ``web_search`` tool.

        Requested web search that the provider does not host uses the
        configured backend on a model that calls tools, except on Anthropic
        rows, which use only Anthropic's server tool. Otherwise the turn runs
        without search and logs why, instead of failing.
        """

        if not wants_application_web_search(model_provider, request.options):
            return False
        reason = None
        if model_provider.provider_type == ANTHROPIC_MESSAGES_PROVIDER_TYPE:
            # Anthropic rows search only with Anthropic's own server tool (D7);
            # a row without it runs the turn without search.
            reason = "provider_without_native_web_search"
        elif self._web_search_tool is None:
            reason = "no_backend"
        elif not model_provider.capabilities.supports_tools:
            reason = "model_without_tools"
        elif model_provider.provider_type not in DIRECT_MEMORY_TOOL_SUPPORT_BY_PROVIDER:
            reason = "provider_without_function_tools"
        elif request.options.reasoning_effort and chat_completions_disallows_reasoning_with_function_tools(
            model_provider
        ):
            reason = "reasoning_with_function_tools"
        if reason is None:
            return True
        _log.warning(
            "Direct chat web search unavailable for this turn",
            anima_id=request.anima_id,
            chat_id=request.chat_id,
            run_id=request.run_id,
            model_provider_id=model_provider.id,
            reason=reason,
        )
        return False

    def _context_budget(self, prepared: PreparedDirectChatTurn) -> ContextBudget | None:
        """Return the window budget for models the application must keep within it.

        A turn continuing from a provider cursor sends no local history, and a
        client that asks its provider to compact (OpenAI Responses with a
        compaction threshold, and Anthropic Messages) keeps prompts within the
        window itself. Every other row with a window is fitted here, including
        Responses rows whose composition turns native compaction off. Rows
        without a window are not bounded.
        """

        model_provider = prepared.model_request.model_provider
        if not prepared.context_loaded or uses_native_context_compaction(
            self._registry.get(model_provider.provider_type)
        ):
            return None
        return context_budget_for_model(model_provider)

    def _prompt_for_history(self, prepared: PreparedDirectChatTurn, visible_history: list[Any]) -> DirectChatPrompt:
        """Rebuild the turn's prompt around a different history."""

        model_request = prepared.model_request
        return self._build_prompt(
            request=prepared.request,
            model_provider=model_request.model_provider,
            memory_context=prepared.memory_context,
            memory_tool_specs=prepared.memory_tool_specs,
            visible_history=visible_history,
            response_format=cast(dict[str, Any] | None, model_request.prompt.response_format),
            response_format_guidance=gesture_response_guidance(
                main_structured_response_guidance(model_request.model_provider, prepared.output_type),
                prepared.request.runtime_gesture_descriptors,
            ),
            memory_tools_active=bool(prepared.memory_tool_specs)
            or model_request.provider_options.memory_apply_patch_enabled,
            native_memory_patch_enabled=model_request.provider_options.memory_apply_patch_enabled,
        )

    async def _fit_to_context_window(
        self, prepared: PreparedDirectChatTurn
    ) -> AsyncGenerator[Event | PreparedDirectChatTurn, None]:
        """Yield status events, then the turn with a prompt that fits, or an error event instead.

        A prompt above the trigger is compacted first (when a compactor is
        configured and the turn is not incognito), then the oldest history is
        left out of the request. A turn whose fixed instructions and latest
        message alone exceed the window fails with ``context_exceeded``.
        """

        budget = self._context_budget(prepared)
        if budget is None or estimate_prompt_tokens(prepared.model_request.prompt) <= budget.pre_send_trigger_tokens:
            yield prepared
            return
        request = prepared.request

        def prompt_tokens_for(history: list[Any]) -> int:
            return estimate_prompt_tokens(self._prompt_for_history(prepared, history))

        fixed_tokens = prompt_tokens_for([])
        if fixed_tokens > budget.available_tokens:
            yield self._context_exceeded_event(prepared, budget, fixed_tokens)
            return

        history = list(prepared.visible_history)
        if self._pre_send_compactor is not None and not request.options.incognito:
            yield self._run_status_event(request, "summarizing_context", "started")
            try:
                chat_context = await asyncio.wait_for(
                    self._pre_send_compactor(
                        PreSendCompactionRequest(
                            chat_id=request.chat_id,
                            user_id=request.user_id,
                            anima_id=request.anima_id,
                            run_id=request.run_id,
                            keep_recent_tokens=max(0, (budget.available_tokens - fixed_tokens) // 2),
                        )
                    ),
                    timeout=self._pre_send_compaction_timeout_seconds,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # A failed or slow compaction must not block the turn; trimming follows.
                _log.warning(
                    "Direct chat pre-send compaction failed",
                    anima_id=request.anima_id,
                    chat_id=request.chat_id,
                    run_id=request.run_id,
                    exc_type=exc.__class__.__name__,
                )
                chat_context = None
            yield self._run_status_event(request, "summarizing_context", "finished")
            if chat_context is not None:
                history = compiled_context_history(chat_context)

        # Fit below the trigger so tool rounds and a repair have room; use the
        # whole budget only when the fixed prompt leaves no such headroom.
        fitted_history = fit_history(
            history,
            available_tokens=budget.pre_send_trigger_tokens,
            prompt_tokens_for=prompt_tokens_for,
        )
        if fitted_history is None:
            fitted_history = fit_history(
                history,
                available_tokens=budget.available_tokens,
                prompt_tokens_for=prompt_tokens_for,
            )
        if fitted_history is None:
            yield self._context_exceeded_event(prepared, budget, fixed_tokens)
            return
        if len(fitted_history) < len(history):
            _log.warning(
                "Direct chat history trimmed to the model context window",
                anima_id=request.anima_id,
                chat_id=request.chat_id,
                run_id=request.run_id,
                omitted_item_count=len(history) - len(fitted_history),
                context_window_tokens=budget.context_window_tokens,
            )
        yield replace(
            prepared,
            model_request=replace(prepared.model_request, prompt=self._prompt_for_history(prepared, fitted_history)),
            visible_history=tuple(fitted_history),
        )

    @staticmethod
    def _run_status_event(request: DirectChatTurnRequest, status: RunStatusKind, phase: str) -> Event:
        return Event(
            event_id=f"run-status-{request.run_id}-{status}-{phase}-{uuid.uuid4().hex[:8]}",
            anima_id=request.anima_id,
            chat_id=request.chat_id,
            user_id=request.user_id,
            type=EventType.RUN_STATUS,
            payload=RunStatusPayload(run_id=request.run_id, status=status, phase=cast(Any, phase)),
        )

    @staticmethod
    def _context_exceeded_event(prepared: PreparedDirectChatTurn, budget: ContextBudget, prompt_tokens: int) -> Event:
        _log.warning(
            "Direct chat turn exceeds the model context window",
            anima_id=prepared.request.anima_id,
            chat_id=prepared.request.chat_id,
            run_id=prepared.request.run_id,
            estimated_prompt_tokens=prompt_tokens,
            available_tokens=budget.available_tokens,
        )
        error = ModelClientError(
            "The instructions and latest message exceed the model's context window",
            code="context_window_exceeded",
            raw_metadata={
                "provider_error_code": "context_length_exceeded",
                "context_window_tokens": budget.context_window_tokens,
                "estimated_prompt_tokens": prompt_tokens,
            },
        )
        return error_event(
            prepared.request,
            message=error.message,
            code="context_window_exceeded",
            details=model_error_details(error, prepared.model_request.model_provider),
        )

    async def _resolve_model_provider(self, request: DirectChatTurnRequest) -> ModelProvider:
        """Select the explicit request provider or the anima profile default."""

        profile_service, model_providers, _, _ = self._required_services()
        if request.model_provider_id is not None:
            model_provider = await model_providers.get(request.model_provider_id)
            if model_provider is None:
                raise DirectChatTurnSetupError(f"Model provider not found: {request.model_provider_id}")
            return model_provider

        profile = await profile_service.resolve_for_anima(request.anima_id)
        if profile is None:
            raise DirectChatTurnSetupError(
                "Anima chat profile is required for direct chat; select a model provider before chatting."
            )

        model_provider = await model_providers.get(profile.default_model_provider_id)
        if model_provider is None:
            raise DirectChatTurnSetupError(
                f"Anima default model provider not found: {profile.default_model_provider_id}"
            )
        return model_provider

    def _build_prompt(
        self,
        *,
        request: DirectChatTurnRequest,
        model_provider: ModelProvider,
        memory_context: DirectChatMemoryContext,
        memory_tool_specs: tuple[dict[str, Any], ...],
        visible_history: list[Any],
        response_format: dict[str, Any] | None,
        response_format_guidance: str,
        memory_tools_active: bool = False,
        native_memory_patch_enabled: bool = False,
    ) -> DirectChatPrompt:
        """Assemble provider-neutral prompt state for the selected model client."""

        memory_writes_enabled = native_memory_patch_enabled or any(
            spec.get("function", {}).get("name") in MEMORY_TOOL_WRITE_NAMES for spec in memory_tool_specs
        )
        instruction_style = (
            INSTRUCTION_STYLE_ANTHROPIC
            if model_provider.provider_type == ANTHROPIC_MESSAGES_PROVIDER_TYPE
            else INSTRUCTION_STYLE_DEFAULT
        )
        return self._prompt_assembler.assemble(
            user_message=request.user_message,
            anima_identity=memory_context.anima_identity,
            anima_name=memory_context.anima_name,
            anima_memories=getattr(memory_context, "anima_memories", None),
            # An opened MEMORIES.md version means memory influence is on and the file exists.
            anima_memories_writable=memory_writes_enabled
            and self._episodic_memory_arm.anima_memories_writes
            and getattr(memory_context, "anima_memories_version", None) is not None,
            anima_memories_write_guidance=self._episodic_memory_arm.anima_memories_write_guidance,
            remember_field=self._episodic_memory_arm.remember,
            response_format_guidance=response_format_guidance,
            native_memory_patch_enabled=native_memory_patch_enabled,
            memory_map=getattr(memory_context, "memory_map", None),
            attached_files=(
                request.attached_files
                if any(
                    spec.get("function", {}).get("name") == MEMORY_TOOL_SEARCH_UPLOADED_FILES
                    for spec in memory_tool_specs
                )
                else ()
            ),
            supports_developer_role=model_provider.accepts_developer_role,
            visible_history=visible_history,
            # These dictionaries are produced by the local schema/tool builders.
            response_format=cast(ChatCompletionResponseFormat, response_format),
            tools=cast(tuple[ChatCompletionToolUnionParam, ...], memory_tool_specs),
            tool_choice="auto" if memory_tools_active else None,
            parallel_tool_calls=False if memory_tools_active else None,
            prompt_cache_key=scoped_prompt_cache_key(
                user_id=request.user_id,
                anima_id=request.anima_id,
                provider_type=model_provider.provider_type,
                model=model_provider.model,
            ),
            reasoning_effort=turn_reasoning_effort(request.options),
            instruction_style=instruction_style,
            conversation_language=request.conversation_language,
            speech_guidance=speech_instruction(request.options.tts, instruction_style=instruction_style),
            metadata={
                "anima_id": request.anima_id,
                "chat_id": request.chat_id,
                "run_id": request.run_id,
                "context_source": "direct_chat_model_client",
                "memory_context": turn_memory_context_manifest(
                    memory_context.manifest,
                    request=request,
                    model_provider=model_provider,
                ),
            },
        )

    def _model_stream_collector(
        self,
        *,
        anima_memories: AnimaMemoriesTurn | None,
        on_run_status: RunStatusObserver | None = None,
    ) -> DirectTurnModelStreamCollector:
        """Create the stream collector with executor-local callbacks and the turn's MEMORIES.md state."""

        _, _, chat_manager, _ = self._required_services()

        async def load_chat_context(chat_id: str) -> Any:
            return await chat_manager.get_chat_context(chat_id=chat_id)

        return DirectTurnModelStreamCollector(
            stream=self.stream,
            memory_tool_service=self._memory_tool_service,
            load_chat_context=load_chat_context,
            build_prompt=self._build_prompt,
            anima_memories=anima_memories,
            web_search_tool=self._web_search_tool,
            on_run_status=on_run_status,
        )

    def _required_services(
        self,
    ) -> tuple[AnimaChatProfileService, ModelProviderRepository, ChatManager, DirectChatMemoryContextService]:
        """Return configured collaborators or fail before any provider call starts."""

        if (
            self._profile_service is None
            or self._model_providers is None
            or self._chat_manager is None
            or self._memory_context_service is None
        ):
            raise DirectChatTurnSetupError("Direct chat turn executor dependencies are not configured")
        return self._profile_service, self._model_providers, self._chat_manager, self._memory_context_service

    async def _record_turn(self, **kwargs: Any) -> Any:
        """Persist a successful direct turn through the configured recorder."""

        recorder = self._turn_recorder or self._chat_manager
        if recorder is None:
            raise DirectChatTurnSetupError("Direct chat turn recorder dependency is not configured")
        return await recorder.record_turn(**kwargs)

    async def _record_episode_memory(
        self,
        *,
        prepared: PreparedDirectChatTurn,
        parsed: MainStructuredResponse,
        source_message_id: str | None,
    ) -> str | None:
        """Best-effort capture of the final turn's structured `remember` note.

        Returns the recorded episode text, or `None` when nothing was recorded.
        """

        remember = parsed.remember.strip() if isinstance(parsed.remember, str) else ""
        if not remember:
            return None
        if prepared.request.options.disable_memory_updates:
            _log.info(
                "Direct chat episodic memory skipped",
                anima_id=prepared.request.anima_id,
                chat_id=prepared.request.chat_id,
                run_id=prepared.request.run_id,
                reason="memory_updates_disabled",
            )
            return None
        recorder = self._memory_episode_recorder
        if recorder is None:
            _log.info(
                "Direct chat episodic memory skipped",
                anima_id=prepared.request.anima_id,
                chat_id=prepared.request.chat_id,
                run_id=prepared.request.run_id,
                reason="recorder_unavailable",
            )
            return None
        try:
            item = await recorder.record_episode_item(
                user_id=prepared.request.user_id,
                source_anima_id=prepared.request.anima_id,
                source_chat_id=prepared.request.chat_id,
                source_run_id=prepared.request.run_id,
                source_message_id=source_message_id,
                text=remember,
            )
        except Exception as exc:
            _log.warning(
                "Direct chat episodic memory capture failed",
                anima_id=prepared.request.anima_id,
                chat_id=prepared.request.chat_id,
                run_id=prepared.request.run_id,
                exc_type=exc.__class__.__name__,
            )
            return None
        _log.info(
            "Direct chat episodic memory captured",
            anima_id=prepared.request.anima_id,
            chat_id=prepared.request.chat_id,
            run_id=prepared.request.run_id,
        )
        # The stored item holds the normalized text; fall back to the same normalization.
        text = getattr(item, "text", None)
        return text if isinstance(text, str) and text.strip() else " ".join(remember.split())


def _assistant_message_from_record_result(record_result: Any) -> ChatMessage | None:
    """Return the persisted final visible assistant message when recorder output exposes it."""

    if not isinstance(record_result, tuple) or len(record_result) < 2:
        return None
    assistant_result = record_result[1]
    if isinstance(assistant_result, ChatMessage):
        candidates = [assistant_result]
    elif isinstance(assistant_result, list | tuple):
        candidates = [message for message in assistant_result if isinstance(message, ChatMessage)]
    else:
        return None
    for message in reversed(candidates):
        if message.role is not MessageRole.ASSISTANT:
            continue
        if message.internal:
            continue
        if message.message_type != "message":
            continue
        if message.id is not None:
            return message
    return None


__all__ = [
    "DirectChatAttachmentContext",
    "DirectChatTurnExecutor",
    "DirectChatTurnRequest",
    "DirectChatTurnSetupError",
    "DirectChatTurnStreamError",
    "ModelClientNotFoundError",
    "PreparedDirectChatTurn",
    "build_main_structured_response_format",
]

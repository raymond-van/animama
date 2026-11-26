"""Model client backed by OpenAI Responses streaming, emitting provider-neutral deltas and finals."""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, cast

from openai import AsyncOpenAI, OpenAIError
from openai.types.responses import (
    ResponseCompletedEvent,
    ResponseErrorEvent,
    ResponseFailedEvent,
    ResponseIncompleteEvent,
    ResponseOutputItemAddedEvent,
    ResponseOutputItemDoneEvent,
    ResponseStreamEvent,
    ResponseTextDeltaEvent,
)

from animama.adapters.model_clients._common import close_maybe_async
from animama.adapters.model_clients.openai_chat_completions.connection_sdk import KEY_FREE_PLACEHOLDER
from animama.adapters.model_clients.openai_chat_completions.support import resolve_openai_base_url
from animama.adapters.model_clients.openai_errors import (
    OpenAIErrorInfo,
    classify_openai_exception,
    classify_openai_response_event,
    model_client_error_from_openai_info,
    should_retry_openai_error,
)
from animama.app.model_clients import (
    MCTerminalIncompleteEvent,
    ModelClientContinuation,
    ModelClientDelta,
    ModelClientFinal,
    ModelClientProviderError,
    ModelClientRequest,
    elapsed_ms,
    model_client_preview_log_context,
    model_client_request_log_context,
)
from animama.app.model_clients.credential_store import OPENAI_CREDENTIAL_ENV
from animama.app.model_clients.credentials import (
    ModelCredential,
    ModelCredentialResolver,
    builtin_openai_connection,
    static_credential_resolver,
)
from animama.domain.model_connection import BUILTIN_OPENAI_CONNECTION_ID
from animama.logging import get_logger

from .events import (
    event_metadata,
    events_from_response_stream_event,
    response_event_type,
    response_from_terminal_event,
    responses_stream_event_delta,
)
from .final import response_final_parts
from .reasoning import reasoning_continuation
from .request import (
    DEFAULT_RESPONSES_COMPACTION_THRESHOLD_TOKENS,
    create_response_kwargs,
    previous_response_id,
    responses_context_management,
)
from .routes import OPENAI_API_ROUTE, ResponsesRoute
from .support import (
    OPENAI_API,
    OPENAI_MISSING_FINAL_ANSWER_PHASE_CODE,
    OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
    OPENAI_STREAM_INCOMPLETE_CODE,
    PHASE_FINAL_ANSWER,
    clean_str,
    response_item_id,
    response_message_phase,
)

_log = get_logger("adapters.model_clients.openai_responses.client")


@dataclass(slots=True)
class _ResponseStreamState:
    """Request-local state for filtering Responses text into public output."""

    public_text_parts: list[str] = field(default_factory=list)
    item_phases: dict[str, str] = field(default_factory=dict)
    done_items: dict[int, Any] = field(default_factory=dict)
    """Output items by ``output_index``, for a terminal event that does not list them."""
    stream_started: bool = False

    def record_output_item(self, item: object) -> None:
        """Remember item phase before later text deltas reference item_id."""

        item_id = response_item_id(item)
        phase = response_message_phase(item)
        if item_id is not None and phase is not None:
            self.item_phases[item_id] = phase

    def text_delta_for_public_stream(self, event: ResponseTextDeltaEvent) -> str | None:
        """Return text only for final-answer or unphased assistant messages."""

        delta = event.delta
        if not isinstance(delta, str) or not delta:
            return None
        self.stream_started = True
        phase = self.item_phases.get(event.item_id)
        if phase is None or phase == PHASE_FINAL_ANSWER:
            self.public_text_parts.append(delta)
            return delta
        return None


class OpenAIResponsesModelClient:
    """Provider-neutral model client backed by OpenAI Responses streaming.

    ``_route`` says what the endpoint accepts. Subclasses change where the
    credential comes from and how errors read through the hooks
    ``_credential_for``, ``_renewed_credential``, ``_classified`` and
    ``_on_success``; the streaming loop is shared.
    """

    _route: ResponsesRoute = OPENAI_API_ROUTE

    def __init__(
        self,
        *,
        api_key: str | None = None,
        credential_resolver: ModelCredentialResolver | None = None,
        base_url: str | None = None,
        client: AsyncOpenAI | None = None,
        timeout: float | None = 60.0,
        compaction_threshold_tokens: int | None = DEFAULT_RESPONSES_COMPACTION_THRESHOLD_TOKENS,
        close_client: bool | None = None,
    ) -> None:
        """``credential_resolver`` supplies the built-in OpenAI key per request;
        ``api_key`` is a fixed key used when no resolver is given. ``client`` is
        a test hook that replaces SDK client construction."""

        self._credentials = credential_resolver or static_credential_resolver(
            {OPENAI_CREDENTIAL_ENV: api_key.strip()} if api_key and api_key.strip() else None
        )
        self._base_url = resolve_openai_base_url(base_url)
        self._client = client
        # A test hook client is used as given; one this adapter builds holds no key.
        self._client_injected = client is not None
        self._timeout = timeout
        self._compaction_threshold_tokens = compaction_threshold_tokens
        self._close_client = (client is None) if close_client is None else close_client

    @property
    def native_context_compaction(self) -> bool:
        """Whether every request asks OpenAI to compact a prompt above the threshold.

        Read through ``uses_native_context_compaction``: without it, the
        direct-chat executor fits prompts to the row's context window itself.
        """

        return self._route.native_compaction and bool(responses_context_management(self._compaction_threshold_tokens))

    async def stream(self, spec: ModelClientRequest) -> AsyncIterator[ModelClientDelta]:
        """Stream typed Responses events as provider-neutral deltas.

        Responses streaming is event-type based. This adapter forwards every
        meaningful event as an MC observability event, streams public text only
        from final-answer/unphased assistant messages, and emits ModelClientFinal
        only after the terminal `response.completed` event is received.
        """

        # One credential for the whole stream, including retries and continuations.
        credential = await self._credential_for(spec)
        provider_type = self._route.provider_type
        metadata: dict[str, Any] = {
            "provider": provider_type,
            "api": "responses",
            "model": spec.model_provider.model,
        }
        state = _ResponseStreamState()
        previous_id = previous_response_id(spec) if self._route.chain_stored_responses else None
        if previous_id is not None:
            metadata["previous_response_id"] = previous_id

        request_started_at = time.monotonic()
        attempt = 0
        event_count = 0
        event_delta_count = 0
        text_delta_count = 0
        public_text_delta_count = 0
        first_event_logged = False
        renewed = False
        while True:
            try:
                attempt_started_at = time.monotonic()
                _log.info(
                    "OpenAI Responses stream request started",
                    **model_client_request_log_context(spec, include_prompt_preview=True),
                    attempt=attempt,
                )
                stream = await self._create_stream(spec, previous_response_id=previous_id, credential=credential)
                _log.info(
                    "OpenAI Responses stream opened",
                    **model_client_request_log_context(spec),
                    attempt=attempt,
                    elapsed_ms=elapsed_ms(attempt_started_at),
                )
                try:
                    async for raw_event in stream:
                        state.stream_started = True
                        event = cast(ResponseStreamEvent, raw_event)
                        event_count += 1
                        event_type = response_event_type(event)
                        if not first_event_logged:
                            first_event_logged = True
                            _log.info(
                                "OpenAI Responses first stream event received",
                                **model_client_request_log_context(spec),
                                attempt=attempt,
                                provider_event_type=event_type,
                                elapsed_ms=elapsed_ms(request_started_at),
                            )
                        # Preserve the complete typed event stream as normalized
                        # model-client events, including phases, native tools,
                        # function-call arguments, and unknown provider events.
                        event_deltas = events_from_response_stream_event(
                            event,
                            provider_type=provider_type,
                            model=spec.model_provider.model,
                            previous_response_id=previous_id,
                        )
                        event_delta_count += len(event_deltas)
                        for event_delta in event_deltas:
                            yield event_delta

                        if isinstance(event, ResponseOutputItemAddedEvent | ResponseOutputItemDoneEvent):
                            # Output item phase may arrive on item lifecycle
                            # events before the text delta that references it.
                            state.record_output_item(event.item)
                        if isinstance(event, ResponseOutputItemDoneEvent):
                            state.done_items[event.output_index] = event.item

                        if isinstance(event, ResponseTextDeltaEvent):
                            # Commentary text is observable but not public chat
                            # output. Only final_answer/unphased text becomes a
                            # direct chat text_delta.
                            text_delta_count += 1
                            delta = state.text_delta_for_public_stream(event)
                            if delta is not None:
                                public_text_delta_count += 1
                                yield ModelClientDelta(kind="text_delta", text=delta, raw_metadata=metadata)
                            continue

                        if isinstance(event, ResponseCompletedEvent) or event_type == "response.done":
                            # Terminal completion carries the authoritative
                            # Response object. Extract final text, usage, tool
                            # calls, phase metadata, and native tool summaries.
                            response = response_from_terminal_event(event)
                            if not response.output and state.done_items:
                                # The ChatGPT plan's route can end with an empty output list
                                # (Phase 0 trial); the items arrived as done events instead.
                                response = response.model_copy(
                                    update={"output": [state.done_items[index] for index in sorted(state.done_items)]}
                                )
                            final_parts = response_final_parts(
                                response,
                                previous_response_id=previous_id,
                                provider_type=provider_type,
                            )
                            metadata.update(final_parts.metadata)
                            state.stream_started = True
                            final_text = (
                                final_parts.text if final_parts.text is not None else "".join(state.public_text_parts)
                            )
                            _log.info(
                                "OpenAI Responses terminal completion received",
                                **model_client_request_log_context(spec),
                                attempt=attempt,
                                response_id=response.id,
                                status=response.status,
                                event_count=event_count,
                                event_delta_count=event_delta_count,
                                text_delta_count=text_delta_count,
                                public_text_delta_count=public_text_delta_count,
                                final_text_length=len(final_text),
                                tool_call_count=len(final_parts.tool_calls),
                                missing_final_answer_phase=final_parts.missing_final_answer_phase,
                                elapsed_ms=elapsed_ms(request_started_at),
                                **model_client_preview_log_context(final_text_preview=final_text),
                            )
                            if final_parts.missing_final_answer_phase:
                                # If the model used phased output but never
                                # produced final_answer, treat the turn as
                                # incomplete instead of persisting commentary.
                                metadata["missing_final_answer_phase"] = True
                                raise ModelClientProviderError(
                                    "OpenAI Responses stream completed without a final_answer phase",
                                    code=OPENAI_MISSING_FINAL_ANSWER_PHASE_CODE,
                                    raw_metadata=metadata,
                                )
                            await self._on_success()
                            yield ModelClientDelta(
                                kind="final",
                                final=ModelClientFinal(
                                    text=final_text,
                                    usage=final_parts.usage,
                                    usage_reported=response.usage is not None,
                                    raw_provider_metadata=metadata,
                                    tool_calls=final_parts.tool_calls,
                                    input_moderation=final_parts.input_moderation,
                                    continuation=self._next_round(spec, response, final_parts.tool_calls),
                                ),
                            )
                            yield ModelClientDelta(kind="done")
                            return
                        if isinstance(event, ResponseErrorEvent | ResponseFailedEvent | ResponseIncompleteEvent) or (
                            event_type in {"error", "response.failed", "response.incomplete"}
                        ):
                            # Error/incomplete typed events terminate the turn
                            # as provider errors; they are not converted to
                            # successful ModelClientFinal values.
                            info = await self._classified(
                                classify_openai_response_event(
                                    event_metadata(event),
                                    provider_type=provider_type,
                                    model=spec.model_provider.model,
                                    previous_response_id=previous_id,
                                ),
                                credential,
                            )
                            _log.warning(
                                "OpenAI Responses terminal error event received",
                                **model_client_request_log_context(spec),
                                attempt=attempt,
                                provider_event_type=event_type,
                                code=info.code,
                                response_id=info.metadata.get("response_id"),
                                status=info.metadata.get("status"),
                                elapsed_ms=elapsed_ms(request_started_at),
                            )
                            raise model_client_error_from_openai_info(info)
                finally:
                    await close_maybe_async(stream)
            except asyncio.CancelledError:
                raise
            except ModelClientProviderError:
                raise
            except OpenAIError as exc:
                info = classify_openai_exception(
                    exc,
                    api=OPENAI_API,
                    provider_type=provider_type,
                    model=spec.model_provider.model,
                    previous_response_id=previous_id,
                )
                if not renewed and not state.stream_started:
                    # A refused credential may be renewed once before any output.
                    renewed_credential = await self._renewed_credential(info, credential)
                    if renewed_credential is not None:
                        credential, renewed = renewed_credential, True
                        continue
                info = await self._classified(info, credential)
                # A bounded invocation never retries inside the adapter.
                delay = (
                    self._retry_delay(info, attempt=attempt, stream_started=state.stream_started)
                    if spec.limits is None
                    else None
                )
                if delay is not None:
                    _log.warning(
                        "OpenAI Responses stream retrying after provider error",
                        **model_client_request_log_context(spec),
                        attempt=attempt,
                        code=info.code,
                        status_code=info.metadata.get("status_code"),
                        delay_seconds=delay,
                        elapsed_ms=elapsed_ms(request_started_at),
                    )
                    attempt += 1
                    if delay > 0:
                        await asyncio.sleep(delay)
                    continue
                raise model_client_error_from_openai_info(info) from exc
            break

        metadata["completed_missing"] = True
        _log.warning(
            "OpenAI Responses stream ended without terminal event",
            **model_client_request_log_context(spec),
            attempt=attempt,
            event_count=event_count,
            event_delta_count=event_delta_count,
            text_delta_count=text_delta_count,
            public_text_delta_count=public_text_delta_count,
            elapsed_ms=elapsed_ms(request_started_at),
        )
        # Reaching EOF without a terminal Responses event means the provider
        # stream ended ambiguously. Surface this as a failure so direct chat does
        # not persist partial output as a valid assistant response.
        yield responses_stream_event_delta(
            event_cls=MCTerminalIncompleteEvent,
            provider_type=provider_type,
            model=spec.model_provider.model,
            provider_event_type="response.stream_eof",
            response_id=clean_str(metadata.get("response_id")),
            status="incomplete",
            details={"completed_missing": True},
        )
        raise ModelClientProviderError(
            "OpenAI Responses stream ended without a terminal event",
            code=OPENAI_STREAM_INCOMPLETE_CODE,
            raw_metadata=metadata,
        )

    async def _credential_for(self, spec: ModelClientRequest) -> ModelCredential:
        """The built-in OpenAI connection's key; Responses serves no other connection on a key."""

        if spec.model_provider.connection_id != BUILTIN_OPENAI_CONNECTION_ID:
            # Owner connections use Chat Completions and must never get the OpenAI key.
            raise ModelClientProviderError(
                "The OpenAI Responses API is only available on the built-in OpenAI connection",
                code="responses_connection_unsupported",
                raw_metadata={"connection_id": spec.model_provider.connection_id, "model": spec.model_provider.model},
            )
        credential = self._credentials.resolve(builtin_openai_connection())
        if not self._client_injected and not credential.usable:
            raise ModelClientProviderError("OpenAI API key is not configured", code="missing_api_key")
        return credential

    async def _renewed_credential(self, info: OpenAIErrorInfo, credential: ModelCredential) -> ModelCredential | None:
        """A credential to retry with once after ``info``; a key cannot be renewed."""

        return None

    async def _classified(self, info: OpenAIErrorInfo, credential: ModelCredential) -> OpenAIErrorInfo:
        """Reword a provider error for this route; ``credential`` is the one the failed request used."""

        return info

    async def _on_success(self) -> None:
        """Called once a response completed."""

    def _retry_delay(self, info: OpenAIErrorInfo, *, attempt: int, stream_started: bool) -> float | None:
        """Seconds to wait before trying ``info``'s request again, or None to report it.

        On a key the SDK has already retried with its own backoff; this adds one
        more try when OpenAI asks for at most a short wait.
        """

        if not should_retry_openai_error(info, attempt=attempt, stream_started=stream_started):
            return None
        return info.retry_after_seconds or 0.0

    def _next_round(
        self, spec: ModelClientRequest, response: Any, tool_calls: tuple[Any, ...]
    ) -> ModelClientContinuation | None:
        """Request-local state for the turn's next round: reasoning to replay, when the route does that."""

        if not self._route.replay_reasoning or not tool_calls:
            return None
        return reasoning_continuation(
            spec.continuation, response.output, provider_type=self._route.provider_type, model=spec.model_provider.model
        )

    async def aclose(self) -> None:
        client = self._client
        if client is not None and self._close_client:
            await client.close()
        self._client = None

    async def _create_stream(
        self, spec: ModelClientRequest, *, previous_response_id: str | None, credential: ModelCredential
    ) -> Any:
        """Create the OpenAI SDK Responses stream."""

        client = self._client_for_spec(spec, credential)
        if spec.limits is not None:
            client = client.with_options(max_retries=0)
        kwargs = create_response_kwargs(
            spec,
            previous_response_id,
            timeout=spec.limits.timeout_seconds if spec.limits is not None else self._timeout,
            compaction_threshold_tokens=self._compaction_threshold_tokens,
            route=self._route,
        )
        return await client.responses.create(**kwargs)

    def _client_for_spec(self, spec: ModelClientRequest, credential: ModelCredential) -> Any:
        """Return a view of the shared key-free client with this request's key, base URL and timeout."""

        if not self._client_injected:
            if self._client is None:
                self._client = AsyncOpenAI(api_key=KEY_FREE_PLACEHOLDER, base_url=self._base_url, timeout=self._timeout)
                self._close_client = True
            return self._client.with_options(
                api_key=credential.api_key, base_url=self._base_url_for_spec(spec), timeout=self._timeout
            )
        with_options = getattr(self._client, "with_options", None)
        if callable(with_options):
            return with_options(base_url=self._base_url_for_spec(spec), timeout=self._timeout)
        return self._client

    def _base_url_for_spec(self, spec: ModelClientRequest) -> str:
        connection = spec.model_provider.connection
        base_url = connection.base_url if connection is not None and connection.base_url else self._base_url
        return base_url.rstrip("/")


__all__ = ["OPENAI_RESPONSES_HTTP_PROVIDER_TYPE", "OpenAIResponsesModelClient"]

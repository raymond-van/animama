from __future__ import annotations

import asyncio
import json
from hashlib import sha256
from types import SimpleNamespace
from typing import Any

import httpx2
import pytest
from openai import APIError, APIStatusError
from openai._models import construct_type
from openai.types.chat import ChatCompletionChunk, ChatCompletionFunctionToolParam, ChatCompletionToolUnionParam
from openai.types.responses import (
    ResponseCompletedEvent,
    ResponseErrorEvent,
    ResponseFailedEvent,
    ResponseFunctionCallArgumentsDeltaEvent,
    ResponseFunctionCallArgumentsDoneEvent,
    ResponseIncompleteEvent,
    ResponseOutputItemAddedEvent,
    ResponseOutputItemDoneEvent,
    ResponseStreamEvent,
    ResponseTextDeltaEvent,
    ResponseTextDoneEvent,
    ResponseWebSearchCallCompletedEvent,
    ResponseWebSearchCallInProgressEvent,
    ResponseWebSearchCallSearchingEvent,
)

from animama.adapters.model_clients import (
    OPENAI_HTTP_PROVIDER_TYPE,
    OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
    MockModelClient,
    OpenAIChatCompletionsModelClient,
    OpenAIResponsesModelClient,
)
from animama.adapters.model_clients.openai_chat_completions.connection_sdk import connection_timeout
from animama.adapters.model_clients.openai_errors import (
    OPENAI_PREVIOUS_RESPONSE_UNRESOLVABLE_CODE,
    classify_openai_exception,
    classify_openai_response_event,
    is_previous_response_unresolvable,
)
from animama.app.model_catalog import (
    STRUCTURED_OUTPUT_TRANSPORT_JSON_OBJECT,
    STRUCTURED_OUTPUT_TRANSPORT_JSON_SCHEMA,
)
from animama.app.model_clients import (
    DirectChatPrompt,
    MCAssistantPhaseEvent,
    MCFinishReasonEvent,
    MCFunctionToolCallDeltaEvent,
    MCFunctionToolCallDoneEvent,
    MCToolDoneEvent,
    MCToolProgressEvent,
    MCToolStartedEvent,
    MCUnknownProviderEvent,
    MCUsageEvent,
    ModelClientContinuation,
    ModelClientProviderError,
    ModelClientProviderOptions,
    ModelClientRequest,
    StaticModelClientRegistry,
    uses_native_context_compaction,
)
from animama.app.model_clients.credentials import static_credential_resolver
from animama.app.model_connection_presets import MODEL_CONNECTION_PRESETS
from animama.domain import ModelConnection, ModelProvider, ModelProviderCapabilities
from animama.server.config import settings
from animama.server.model_clients import build_model_client_registry


class _ClosableClient:
    def __init__(self) -> None:
        self.close_calls = 0

    async def stream(self, _spec):
        if False:
            yield None

    async def aclose(self) -> None:
        self.close_calls += 1


class _FakeOpenAIStream:
    def __init__(self, chunks: list[Any]) -> None:
        self._chunks = list(chunks)
        self.close_calls = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        await asyncio.sleep(0)
        if not self._chunks:
            raise StopAsyncIteration
        item = self._chunks.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    async def close(self) -> None:
        self.close_calls += 1


class _FakeOpenAIClient:
    def __init__(
        self,
        chunks: list[Any],
        response_events: list[Any] | None = None,
        *,
        chat_failures: list[Exception] | None = None,
        response_failures: list[Exception] | None = None,
    ) -> None:
        self._chunks = chunks
        self._response_events = response_events or []
        self._chat_failures = list(chat_failures or [])
        self._response_failures = list(response_failures or [])
        self.create_calls: list[dict[str, Any]] = []
        self.response_create_calls: list[dict[str, Any]] = []
        self.with_options_calls: list[dict[str, Any]] = []
        self.close_calls = 0
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))
        self.responses = SimpleNamespace(create=self._responses_create)

    def with_options(self, **kwargs):
        self.with_options_calls.append(dict(kwargs))
        return self

    async def _create(self, **kwargs):
        self.create_calls.append(dict(kwargs))
        if self._chat_failures:
            raise self._chat_failures.pop(0)
        return _FakeOpenAIStream(self._chunks)

    async def _responses_create(self, **kwargs):
        self.response_create_calls.append(dict(kwargs))
        if self._response_failures:
            raise self._response_failures.pop(0)
        return _FakeOpenAIStream(self._response_events)

    async def close(self) -> None:
        self.close_calls += 1


class _FailingResponsesOpenAIClient(_FakeOpenAIClient):
    def __init__(self, exc: Exception) -> None:
        super().__init__([], [])
        self.exc = exc

    async def _responses_create(self, **kwargs):
        self.response_create_calls.append(dict(kwargs))
        raise self.exc


DEEPSEEK_BASE_URL = "https://api.deepseek.com"
HUGGINGFACE_ROUTER_BASE_URL = "https://router.huggingface.co/v1"


def _builtin_connection(base_url: str | None = "https://api.openai.example/v1") -> ModelConnection:
    return ModelConnection(id="openai", name="OpenAI", preset="openai", source="builtin", base_url=base_url)


def _owner_connection(
    preset: str,
    *,
    base_url: str | None = None,
    credential_env: str | None = None,
    connection_id: str | None = None,
) -> ModelConnection:
    defaults = MODEL_CONNECTION_PRESETS[preset]
    return ModelConnection(
        id=connection_id or f"conn-{preset}",
        name=defaults.label,
        preset=preset,
        base_url=base_url or defaults.base_url(local_host="127.0.0.1"),
        credential_env=credential_env,
        compatibility=defaults.compatibility,
    )


def _provider(
    provider_type: str = OPENAI_HTTP_PROVIDER_TYPE,
    model: str = "gpt-test",
    *,
    base_url: str | None = "https://api.openai.example/v1",
    connection: ModelConnection | None = None,
    structured_output_transport: str | None = STRUCTURED_OUTPUT_TRANSPORT_JSON_SCHEMA,
) -> ModelProvider:
    selected = connection or _builtin_connection(base_url)
    return ModelProvider(
        id=f"{provider_type}:{model}",
        provider_type=provider_type,
        model=model,
        model_label=model,
        provider_label=provider_type,
        connection_id=selected.id,
        source="builtin" if selected.is_builtin_openai else "owner",
        connection=selected,
        capabilities=ModelProviderCapabilities(
            structured_kinds=["main_structured_response"],
            structured_output_transport=structured_output_transport,
        ),
    )


def _spec(
    *,
    provider_type: str = OPENAI_HTTP_PROVIDER_TYPE,
    model: str = "gpt-test",
    base_url: str | None = "https://api.openai.example/v1",
    connection: ModelConnection | None = None,
    continuation: ModelClientContinuation | None = None,
    request_options: dict[str, Any] | None = None,
    messages: tuple[dict[str, Any], ...] | None = None,
    tools: tuple[ChatCompletionToolUnionParam, ...] = (),
    metadata: dict[str, Any] | None = None,
    structured_output_transport: str | None = STRUCTURED_OUTPUT_TRANSPORT_JSON_SCHEMA,
) -> ModelClientRequest:
    options = request_options if request_options is not None else {"reasoning_effort": "low"}
    provider_options: dict[str, Any] = {}
    if "native_tools" in options:
        provider_options["native_tools"] = options["native_tools"]
    if "store" in options:
        provider_options["store"] = options["store"]
    if "memory_apply_patch_enabled" in options:
        provider_options["memory_apply_patch_enabled"] = options["memory_apply_patch_enabled"]
    return ModelClientRequest(
        model_provider=_provider(
            provider_type=provider_type,
            model=model,
            base_url=base_url,
            connection=connection,
            structured_output_transport=structured_output_transport,
        ),
        prompt=DirectChatPrompt(
            messages=messages
            if messages is not None
            else (
                {"role": "assistant", "content": "previous"},
                {"role": "user", "content": "hello"},
            ),
            response_format={"type": "json_schema", "json_schema": {"name": "test", "schema": {}}},
            tools=tools,
            tool_choice="auto" if tools else None,
            parallel_tool_calls=False if tools else None,
            reasoning_effort=options.get("reasoning_effort"),
            prompt_cache_key=sha256(f"user-1\x1fanima-1\x1f{provider_type}\x1f{model}".encode()).hexdigest(),
            metadata=metadata or {},
        ),
        provider_options=ModelClientProviderOptions.from_value(provider_options),
        continuation=continuation,
    )


def _chunk(
    *,
    content: str | None = None,
    finish_reason: str | None = None,
    usage: Any = None,
    tool_calls: list[Any] | None = None,
):
    return SimpleNamespace(
        id="chatcmpl-test",
        object="chat.completion.chunk",
        created=1,
        model="gpt-test",
        system_fingerprint="fp-test",
        service_tier="default",
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(content=content, tool_calls=tool_calls),
                finish_reason=finish_reason,
            )
        ],
        usage=usage,
    )


def _sdk_chunk(
    *,
    content: str | None = None,
    finish_reason: str | None = None,
    usage: dict[str, Any] | None = None,
    tool_calls: list[dict[str, Any]] | None = None,
    choices: list[dict[str, Any]] | None = None,
    extra: dict[str, Any] | None = None,
) -> ChatCompletionChunk:
    payload: dict[str, Any] = {
        "id": "chatcmpl-test",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "gpt-test",
        "system_fingerprint": "fp-test",
        "service_tier": "default",
        "choices": choices
        if choices is not None
        else [
            {
                "index": 0,
                "delta": {"content": content, "tool_calls": tool_calls},
                "finish_reason": finish_reason,
            }
        ],
    }
    if usage is not None:
        payload["usage"] = usage
    if extra:
        payload.update(extra)
    return ChatCompletionChunk.model_validate(payload)


def _usage():
    return SimpleNamespace(
        prompt_tokens=2,
        completion_tokens=3,
        total_tokens=5,
        prompt_tokens_details=SimpleNamespace(cached_tokens=1),
        completion_tokens_details=SimpleNamespace(reasoning_tokens=1),
    )


def _sdk_usage() -> dict[str, Any]:
    return {
        "prompt_tokens": 2,
        "completion_tokens": 3,
        "total_tokens": 5,
        "prompt_tokens_details": {"cached_tokens": 1},
        "completion_tokens_details": {"reasoning_tokens": 1},
    }


def _responses_usage() -> dict[str, Any]:
    return {
        "input_tokens": 4,
        "output_tokens": 6,
        "total_tokens": 10,
        "input_tokens_details": {"cache_write_tokens": 0, "cached_tokens": 2},
        "output_tokens_details": {"reasoning_tokens": 3},
    }


def _api_status_error(
    *,
    status_code: int,
    body: dict[str, Any],
    url: str = "https://api.openai.example/v1/responses",
    headers: dict[str, str] | None = None,
) -> APIStatusError:
    request = httpx2.Request("POST", url)
    response = httpx2.Response(status_code, json=body, headers=headers, request=request)
    return APIStatusError("OpenAI Responses request failed", response=response, body=body)


def _stream_error(body: object, *, url: str = "https://api.openai.example/v1/responses") -> APIError:
    """The bare `APIError` the SDK raises for an `error` event inside a stream."""

    message = body.get("message") if isinstance(body, dict) else None
    return APIError(str(message or "An error occurred during streaming"), httpx2.Request("POST", url), body=body)


def _response_message_item(
    *,
    item_id: str = "msg_1",
    text: str = '{"speech":"Hello"}',
    phase: str | None = None,
    status: str = "completed",
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": item_id,
        "type": "message",
        "role": "assistant",
        "status": status,
        "content": [] if status == "in_progress" else [{"type": "output_text", "text": text, "annotations": []}],
    }
    if phase is not None:
        payload["phase"] = phase
    return payload


def _response_payload(
    *,
    response_id: str = "resp_2",
    output: list[dict[str, Any]] | None = None,
    status: str | None = "completed",
    usage: dict[str, Any] | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": response_id,
        "created_at": 1,
        "model": "gpt-test",
        "object": "response",
        "output": output if output is not None else [_response_message_item()],
        "parallel_tool_calls": False,
        "tool_choice": "none",
        "tools": [],
        "top_p": None,
        "service_tier": "default",
        "status": status,
        "usage": _responses_usage() if usage is None else usage,
    }
    if extra:
        payload.update(extra)
    return payload


def _responses_completed_event(
    *,
    response_id: str = "resp_2",
    previous_response_id: str | None = "resp_1",
    output: list[dict[str, Any]] | None = None,
    sequence_number: int = 10,
) -> ResponseCompletedEvent:
    _ = previous_response_id
    return ResponseCompletedEvent.model_validate(
        {
            "type": "response.completed",
            "sequence_number": sequence_number,
            "response": _response_payload(response_id=response_id, output=output),
        }
    )


def _responses_text_delta_event(
    delta: str,
    *,
    item_id: str = "msg_1",
    output_index: int = 0,
    content_index: int = 0,
    sequence_number: int = 1,
) -> ResponseTextDeltaEvent:
    return ResponseTextDeltaEvent.model_validate(
        {
            "type": "response.output_text.delta",
            "sequence_number": sequence_number,
            "output_index": output_index,
            "content_index": content_index,
            "item_id": item_id,
            "delta": delta,
            "logprobs": [],
        }
    )


def _responses_text_done_event(
    text: str,
    *,
    item_id: str = "msg_1",
    output_index: int = 0,
    content_index: int = 0,
    sequence_number: int = 1,
) -> ResponseTextDoneEvent:
    return ResponseTextDoneEvent.model_validate(
        {
            "type": "response.output_text.done",
            "sequence_number": sequence_number,
            "output_index": output_index,
            "content_index": content_index,
            "item_id": item_id,
            "text": text,
            "logprobs": [],
        }
    )


def _responses_output_item_added_event(
    item: dict[str, Any],
    *,
    output_index: int = 0,
    sequence_number: int = 1,
) -> ResponseOutputItemAddedEvent:
    return ResponseOutputItemAddedEvent.model_validate(
        {
            "type": "response.output_item.added",
            "sequence_number": sequence_number,
            "output_index": output_index,
            "item": item,
        }
    )


def _responses_output_item_done_event(
    item: dict[str, Any],
    *,
    output_index: int = 0,
    sequence_number: int = 1,
) -> ResponseOutputItemDoneEvent:
    return ResponseOutputItemDoneEvent.model_validate(
        {
            "type": "response.output_item.done",
            "sequence_number": sequence_number,
            "output_index": output_index,
            "item": item,
        }
    )


def _messages_with_instructions() -> tuple[dict[str, str], ...]:
    """Stable system text, history, then the turn context before the new user message."""

    return (
        {"role": "system", "content": "Core instruction"},
        {"role": "user", "content": "Compacted history"},
        {"role": "assistant", "content": "previous"},
        {"role": "developer", "content": _expected_memory_map_text()},
        {"role": "user", "content": "hello"},
    )


def _breakpoint_part(text: str, part_type: str = "text") -> dict[str, Any]:
    return {"type": part_type, "text": text, "prompt_cache_breakpoint": {"mode": "explicit"}}


def _memory_read_tool() -> ChatCompletionFunctionToolParam:
    return {
        "type": "function",
        "function": {
            "name": "memory_read_files",
            "description": "Read memory files.",
            "strict": True,
            "parameters": {
                "type": "object",
                "properties": {"paths": {"type": "string"}},
                "required": ["paths"],
                "additionalProperties": False,
            },
        },
    }


def _expected_instruction_text() -> str:
    return f"Core instruction\n\n{_expected_memory_map_text()}"


def _expected_memory_map_text() -> str:
    return "# List of memory files\n\nfiles: []"


async def _collect(stream):
    return [item async for item in stream]


def _public_deltas(deltas):
    return [delta for delta in deltas if delta.kind != "event"]


def _stream_event_summaries(deltas) -> list[tuple[str, str]]:
    return [
        (delta.stream_event.provider_event_type, delta.stream_event.kind)
        for delta in deltas
        if delta.kind == "event" and delta.stream_event is not None
    ]


@pytest.mark.asyncio
async def test_static_registry_closes_each_shared_client_once() -> None:
    client = _ClosableClient()
    registry = StaticModelClientRegistry({"One": client, "Two": client})

    await registry.aclose()

    assert client.close_calls == 1


def test_server_registry_registers_direct_provider_family_clients() -> None:
    fake_openai = _FakeOpenAIClient([])
    registry = build_model_client_registry(
        openai_client=fake_openai,  # type: ignore[arg-type]
    )

    assert registry.get(OPENAI_HTTP_PROVIDER_TYPE) is not None
    assert registry.get(OPENAI_RESPONSES_HTTP_PROVIDER_TYPE) is not None
    assert registry.get("GeminiAgent") is None
    assert registry.get("LiteLLMAgent") is None
    assert registry.get("UnknownProvider") is None


def test_server_registry_builds_without_an_openai_key() -> None:
    registry = build_model_client_registry(credential_resolver=static_credential_resolver())

    assert isinstance(registry.get(OPENAI_HTTP_PROVIDER_TYPE), OpenAIChatCompletionsModelClient)
    assert isinstance(registry.get(OPENAI_RESPONSES_HTTP_PROVIDER_TYPE), OpenAIResponsesModelClient)


def test_server_registry_uses_mock_clients_when_llm_skip_enabled(monkeypatch) -> None:
    monkeypatch.setenv("ANIMAMA_LLM_SKIP", "1")

    registry = build_model_client_registry()

    clients = [
        registry.get(OPENAI_HTTP_PROVIDER_TYPE),
        registry.get(OPENAI_RESPONSES_HTTP_PROVIDER_TYPE),
    ]
    assert all(isinstance(client, MockModelClient) for client in clients)
    assert len({id(client) for client in clients}) == 1
    assert registry.get("UnknownProvider") is None


def test_openai_error_classifier_maps_status_and_sanitizes_body() -> None:
    exc = _api_status_error(
        status_code=401,
        headers={"x-request-id": "req_test"},
        body={
            "error": {
                "code": "invalid_api_key",
                "type": "invalid_request_error",
                "message": "Incorrect API key provided: sk-secret.",
            }
        },
    )

    info = classify_openai_exception(
        exc,
        api="chat_completions",
        provider_type=OPENAI_HTTP_PROVIDER_TYPE,
        model="gpt-test",
    )

    assert info.code == "openai_authentication_error"
    assert info.retryable is False
    assert info.metadata["status_code"] == 401
    assert info.metadata["request_id"] == "req_test"
    assert info.metadata["provider_error_code"] == "invalid_api_key"
    assert info.metadata["provider_error_type"] == "invalid_request_error"
    assert info.metadata["provider_error_message"] == "Incorrect API key provided: [redacted]."
    assert "body" not in info.metadata
    assert "message" not in info.metadata


@pytest.mark.parametrize(
    ("body", "code"),
    [
        (
            {
                "message": "You have no credits remaining. Add credits at https://platform.openai.com/settings/organization/billing/.",
                "type": "insufficient_quota",
                "code": "credit_balance_exhausted",
            },
            "openai_quota_exceeded",
        ),
        (
            {"message": "Rate limit reached.", "type": "rate_limit_error", "code": "rate_limit_exceeded"},
            "openai_rate_limit",
        ),
        (
            {"message": "The server had an error.", "type": "server_error", "code": "server_error"},
            "openai_server_error",
        ),
        ({"message": "Invalid image.", "type": "invalid_request_error", "code": "invalid_image"}, "openai_bad_request"),
    ],
)
def test_openai_error_classifier_reads_a_mid_stream_error_event(body: dict[str, Any], code: str) -> None:
    info = classify_openai_exception(
        _stream_error(body),
        api="responses",
        provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
        model="gpt-test",
    )

    assert info.code == code
    # The provider's stream had begun, so its errors are never retried.
    assert info.retryable is False
    assert info.metadata["provider_error_type"] == body["type"]
    assert info.metadata["provider_error_code"] == body["code"]
    assert info.metadata["provider_error_message"] == body["message"]
    assert info.metadata["exception_type"] == "APIError"


def test_openai_error_classifier_reads_an_exhausted_credit_balance_from_its_code_alone() -> None:
    info = classify_openai_exception(
        _stream_error({"message": "Stopped.", "code": "credit_balance_exhausted"}),
        api="chat_completions",
        provider_type=OPENAI_HTTP_PROVIDER_TYPE,
        model="gpt-test",
    )

    assert info.code == "openai_quota_exceeded"


def _failed_event(**error: str) -> dict[str, Any]:
    """`event_metadata` for a Responses `response.failed` event, as the adapter builds it."""

    return {
        "type": "response.failed",
        "response": {"id": "resp_1", "status": "failed", "error": dict(error), "incomplete_details": None},
    }


@pytest.mark.parametrize(
    ("error", "code"),
    [
        ({"code": "insufficient_quota", "message": "x"}, "openai_quota_exceeded"),
        ({"code": "billing_hard_limit_reached", "message": "x"}, "openai_quota_exceeded"),
        ({"type": "insufficient_quota", "code": "unknown_code", "message": "x"}, "openai_quota_exceeded"),
        ({"code": "rate_limit_exceeded", "message": "slow down"}, "openai_rate_limit"),
        ({"code": "image_too_large", "message": "x"}, "openai_bad_request"),
        ({"code": "invalid_base64_image", "message": "x"}, "openai_bad_request"),
        ({"code": "vector_store_timeout", "message": "x"}, "openai_stream_error"),
    ],
)
def test_a_failed_responses_event_is_classified_by_its_nested_error(error: dict[str, str], code: str) -> None:
    info = classify_openai_response_event(
        _failed_event(**error),
        provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
        model="gpt-test",
    )

    assert info.code == code
    assert info.retryable is False


def test_a_responses_event_name_never_picks_the_error_class() -> None:
    info = classify_openai_response_event(
        {"type": "response.image_generation_call.failed", "response": {"error": None}},
        provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
        model="gpt-test",
    )

    assert info.code == "openai_stream_error"


def test_a_mid_stream_error_naming_an_unknown_previous_response_is_unresolvable() -> None:
    info = classify_openai_exception(
        _stream_error({"message": "Previous response not found.", "code": "previous_response_not_found"}),
        api="responses",
        provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
        model="gpt-test",
        previous_response_id="resp_old",
    )

    assert info.code == "openai_previous_response_unresolvable"


def test_openai_error_classifier_keeps_an_unreadable_mid_stream_error_generic() -> None:
    for body in (None, "connection reset", {"message": "Something went wrong."}):
        info = classify_openai_exception(
            _stream_error(body),
            api="chat_completions",
            provider_type=OPENAI_HTTP_PROVIDER_TYPE,
            model="gpt-test",
        )

        assert info.code == "openai_request_failed"
        assert info.retryable is False


def test_openai_error_classifier_redacts_secrets_in_a_mid_stream_error() -> None:
    info = classify_openai_exception(
        _stream_error({"message": "Bad key sk-secret123 used.", "type": "invalid_request_error"}),
        api="responses",
        provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
        model="gpt-test",
    )

    assert info.metadata["provider_error_message"] == "Bad key [redacted] used."
    assert "body" not in info.metadata


@pytest.mark.asyncio
async def test_openai_chat_completions_client_streams_sdk_chunks_and_usage() -> None:
    fake_openai = _FakeOpenAIClient(
        [
            _sdk_chunk(content="Hel"),
            _sdk_chunk(content="lo"),
            _sdk_chunk(finish_reason="stop", usage=_sdk_usage()),
        ]
    )
    client = OpenAIChatCompletionsModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
        timeout=12.0,
    )

    deltas = await _collect(client.stream(_spec(messages=_messages_with_instructions())))
    public_deltas = _public_deltas(deltas)

    assert [(delta.kind, delta.text) for delta in public_deltas] == [
        ("text_delta", "Hel"),
        ("text_delta", "lo"),
        ("final", None),
        ("done", None),
    ]
    assert _stream_event_summaries(deltas) == [
        ("chat.completion.chunk.content_delta", "text_delta"),
        ("chat.completion.chunk.content_delta", "text_delta"),
        ("chat.completion.chunk.finish_reason", "finish_reason"),
        ("chat.completion.chunk.usage", "usage"),
    ]
    first_event = deltas[0].stream_event
    assert first_event is not None
    assert first_event.text_length == 3
    assert dict(deltas[0].raw_metadata) == {}
    finish_event = next(
        delta.stream_event
        for delta in deltas
        if delta.kind == "event"
        and delta.stream_event is not None
        and isinstance(delta.stream_event, MCFinishReasonEvent)
    )
    assert finish_event.finish_reason == "stop"
    usage_event = next(
        delta.stream_event for delta in deltas if delta.kind == "event" and isinstance(delta.stream_event, MCUsageEvent)
    )
    assert usage_event.usage is not None
    assert usage_event.usage.total_tokens == 5
    assert fake_openai.with_options_calls == [
        {"base_url": "https://api.openai.example/v1", "timeout": connection_timeout(12.0)}
    ]
    payload = fake_openai.create_calls[0]
    assert payload["model"] == "gpt-test"
    # The built-in OpenAI connection marks the system message and the history replies.
    assert payload["messages"] == [
        {"role": "system", "content": [_breakpoint_part("Core instruction")]},
        {"role": "user", "content": "Compacted history"},
        {"role": "assistant", "content": [_breakpoint_part("previous")]},
        {"role": "developer", "content": _expected_memory_map_text()},
        {"role": "user", "content": "hello"},
    ]
    assert payload["stream"] is True
    assert payload["stream_options"] == {"include_usage": True}
    assert payload["response_format"]["type"] == "json_schema"
    assert payload["reasoning_effort"] == "low"
    assert payload["prompt_cache_key"] == sha256(b"user-1\x1fanima-1\x1fOpenAIHTTPAgent\x1fgpt-test").hexdigest()
    assert payload["timeout"] == connection_timeout(12.0)
    final = public_deltas[2].final
    assert final is not None
    assert final.text == "Hello"
    assert final.usage.input_tokens == 2
    assert final.usage.output_tokens == 3
    assert final.usage.total_tokens == 5
    assert final.usage.input_tokens_details.cached_tokens == 1
    assert final.usage.output_tokens_details.reasoning_tokens == 1
    assert dict(final.raw_provider_metadata)["finish_reason"] == "stop"


@pytest.mark.asyncio
async def test_openai_chat_completions_client_shapes_deepseek_request_payload() -> None:
    tool: ChatCompletionFunctionToolParam = {
        "type": "function",
        "function": {
            "name": "memory_read_files",
            "description": "Read memory",
            "strict": True,
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    }
    fake_openai = _FakeOpenAIClient(
        [
            _sdk_chunk(
                content='{"speech":"Hi","emotional_tone":"neutral","emotional_intensity":1,"gesture":"","display":null}'
            ),
            _sdk_chunk(finish_reason="stop", usage=_sdk_usage()),
        ]
    )
    client = OpenAIChatCompletionsModelClient(
        api_key="sk-openai",
        client=fake_openai,  # type: ignore[arg-type]
    )

    deltas = await _collect(
        client.stream(
            _spec(
                model="deepseek-v4-pro",
                connection=_owner_connection("deepseek"),
                request_options={"reasoning_effort": "max"},
                messages=_messages_with_instructions(),
                tools=(tool,),
                structured_output_transport=STRUCTURED_OUTPUT_TRANSPORT_JSON_OBJECT,
            )
        )
    )

    payload = fake_openai.create_calls[0]
    assert payload["model"] == "deepseek-v4-pro"
    assert payload["messages"] == [
        {"role": "system", "content": _expected_instruction_text()},
        {"role": "user", "content": "Compacted history"},
        {"role": "assistant", "content": "previous"},
        {"role": "user", "content": "hello"},
    ]
    assert payload["response_format"] == {"type": "json_object"}
    assert payload["reasoning_effort"] == "max"
    assert payload["extra_body"] == {"thinking": {"type": "enabled"}}
    assert payload["tools"] == [tool]
    assert payload["tool_choice"] == "auto"
    assert "prompt_cache_key" not in payload
    assert "parallel_tool_calls" not in payload
    assert payload["stream"] is True
    assert payload["stream_options"] == {"include_usage": True}
    final = _public_deltas(deltas)[-2].final
    assert final is not None
    assert final.text.startswith('{"speech":"Hi"')


@pytest.mark.asyncio
async def test_openai_chat_completions_client_shapes_huggingface_request_payload() -> None:
    tool = _memory_read_tool()
    fake_openai = _FakeOpenAIClient(
        [
            _sdk_chunk(
                content='{"speech":"Hi","emotional_tone":"neutral","emotional_intensity":1,"gesture":"","display":null}'
            ),
            _sdk_chunk(finish_reason="stop", usage=_sdk_usage()),
        ]
    )
    client = OpenAIChatCompletionsModelClient(
        api_key="sk-openai",
        client=fake_openai,  # type: ignore[arg-type]
        timeout=11.0,
    )
    model = "deepseek-ai/DeepSeek-V4-Pro:deepinfra"

    deltas = await _collect(
        client.stream(
            _spec(
                model=model,
                connection=_owner_connection("huggingface"),
                request_options={"reasoning_effort": "low"},
                messages=_messages_with_instructions(),
                tools=(tool,),
                structured_output_transport=STRUCTURED_OUTPUT_TRANSPORT_JSON_SCHEMA,
            )
        )
    )

    assert fake_openai.with_options_calls == [
        {"base_url": HUGGINGFACE_ROUTER_BASE_URL, "timeout": connection_timeout(11.0)}
    ]
    payload = fake_openai.create_calls[0]
    assert payload["model"] == model
    assert payload["messages"] == [
        {"role": "system", "content": _expected_instruction_text()},
        {"role": "user", "content": "Compacted history"},
        {"role": "assistant", "content": "previous"},
        {"role": "user", "content": "hello"},
    ]
    assert payload["response_format"] == {
        "type": "json_schema",
        "json_schema": {"name": "test", "schema": {}},
    }
    assert payload["tools"] == [
        {
            "type": "function",
            "function": {
                "name": "memory_read_files",
                "description": "Read memory files.",
                "parameters": {
                    "type": "object",
                    "properties": {"paths": {"type": "string"}},
                    "required": ["paths"],
                    "additionalProperties": False,
                },
            },
        }
    ]
    assert tool["function"]["strict"] is True
    assert payload["tool_choice"] == "auto"
    assert payload["stream"] is True
    assert "stream_options" not in payload
    assert "prompt_cache_key" not in payload
    assert "parallel_tool_calls" not in payload
    assert "reasoning_effort" not in payload
    final = _public_deltas(deltas)[-2].final
    assert final is not None
    assert final.text.startswith('{"speech":"Hi"')


@pytest.mark.asyncio
async def test_openai_chat_completions_client_handles_huggingface_choice_extras_without_warning() -> None:
    text = '{"speech":"Hi","emotional_tone":"neutral","emotional_intensity":1,"gesture":"","display":null}'
    fake_openai = _FakeOpenAIClient(
        [
            _sdk_chunk(
                choices=[
                    {
                        "index": 0,
                        "delta": {"reasoning_content": "private reasoning"},
                        "finish_reason": None,
                        "text": text,
                        "reasoning": "private reasoning",
                        "token_id": 123,
                    }
                ]
            ),
            _sdk_chunk(finish_reason="stop", usage=_sdk_usage()),
        ]
    )
    client = OpenAIChatCompletionsModelClient(
        api_key="sk-openai",
        client=fake_openai,  # type: ignore[arg-type]
    )

    deltas = await _collect(
        client.stream(
            _spec(
                model="zai-org/GLM-5.2:deepinfra",
                connection=_owner_connection("huggingface"),
                request_options={"reasoning_effort": None},
                messages=_messages_with_instructions(),
                structured_output_transport=STRUCTURED_OUTPUT_TRANSPORT_JSON_SCHEMA,
            )
        )
    )

    public_deltas = _public_deltas(deltas)
    assert [(delta.kind, delta.text) for delta in public_deltas] == [
        ("text_delta", text),
        ("final", None),
        ("done", None),
    ]
    unknown_events = [
        delta.stream_event
        for delta in deltas
        if delta.kind == "event"
        and delta.stream_event is not None
        and isinstance(delta.stream_event, MCUnknownProviderEvent)
    ]
    assert unknown_events == []
    assert public_deltas[1].final is not None
    assert public_deltas[1].final.text == text


@pytest.mark.asyncio
async def test_openai_chat_completions_client_disables_deepseek_thinking_for_none() -> None:
    fake_openai = _FakeOpenAIClient([_sdk_chunk(content="Hi"), _sdk_chunk(finish_reason="stop", usage=_sdk_usage())])
    client = OpenAIChatCompletionsModelClient(
        api_key="sk-openai",
        client=fake_openai,  # type: ignore[arg-type]
    )

    await _collect(
        client.stream(
            _spec(
                model="deepseek-v4-flash",
                connection=_owner_connection("deepseek"),
                request_options={"reasoning_effort": "none"},
                messages=_messages_with_instructions(),
                structured_output_transport=STRUCTURED_OUTPUT_TRANSPORT_JSON_OBJECT,
            )
        )
    )

    payload = fake_openai.create_calls[0]
    assert "reasoning_effort" not in payload
    assert payload["extra_body"] == {"thinking": {"type": "disabled"}}


@pytest.mark.asyncio
async def test_openai_chat_completions_client_rejects_unsupported_deepseek_reasoning_effort() -> None:
    fake_openai = _FakeOpenAIClient([_sdk_chunk(content="Hi")])
    client = OpenAIChatCompletionsModelClient(
        api_key="sk-openai",
        client=fake_openai,  # type: ignore[arg-type]
    )

    with pytest.raises(ModelClientProviderError) as exc_info:
        await _collect(
            client.stream(
                _spec(
                    model="deepseek-v4-flash",
                    connection=_owner_connection("deepseek"),
                    request_options={"reasoning_effort": "minimal"},
                    messages=_messages_with_instructions(),
                )
            )
        )

    assert exc_info.value.code == "unsupported_reasoning_effort"
    assert fake_openai.create_calls == []


@pytest.mark.asyncio
async def test_openai_chat_completions_client_keeps_reasoning_content_private() -> None:
    fake_openai = _FakeOpenAIClient(
        [
            _sdk_chunk(
                choices=[
                    {
                        "index": 0,
                        "delta": {"reasoning_content": "private reasoning"},
                        "finish_reason": None,
                    }
                ]
            ),
            _sdk_chunk(content="Visible"),
            _sdk_chunk(finish_reason="stop", usage=_sdk_usage()),
        ]
    )
    client = OpenAIChatCompletionsModelClient(
        api_key="sk-openai",
        client=fake_openai,  # type: ignore[arg-type]
    )

    deltas = await _collect(
        client.stream(
            _spec(
                model="deepseek-v4-pro",
                connection=_owner_connection("deepseek"),
                request_options={"reasoning_effort": "none"},
                messages=_messages_with_instructions(),
                structured_output_transport=STRUCTURED_OUTPUT_TRANSPORT_JSON_OBJECT,
            )
        )
    )

    public_deltas = _public_deltas(deltas)
    assert [(delta.kind, delta.text) for delta in public_deltas] == [
        ("text_delta", "Visible"),
        ("final", None),
        ("done", None),
    ]
    # Private reasoning is an expected extra: never text, never a warning.
    assert not any(delta.kind == "event" and isinstance(delta.stream_event, MCUnknownProviderEvent) for delta in deltas)
    final = public_deltas[1].final
    assert final is not None
    assert final.text == "Visible"


@pytest.mark.asyncio
async def test_openai_chat_completions_client_keeps_reading_after_finish_reason_for_usage() -> None:
    fake_openai = _FakeOpenAIClient(
        [
            _sdk_chunk(content="Hi"),
            _sdk_chunk(finish_reason="stop"),
            _sdk_chunk(choices=[], usage=_sdk_usage()),
        ]
    )
    client = OpenAIChatCompletionsModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    deltas = await _collect(client.stream(_spec(messages=_messages_with_instructions())))
    public_deltas = _public_deltas(deltas)

    assert [(delta.kind, delta.text) for delta in public_deltas] == [
        ("text_delta", "Hi"),
        ("final", None),
        ("done", None),
    ]
    assert _stream_event_summaries(deltas) == [
        ("chat.completion.chunk.content_delta", "text_delta"),
        ("chat.completion.chunk.finish_reason", "finish_reason"),
        ("chat.completion.chunk.usage", "usage"),
    ]
    final = public_deltas[1].final
    assert final is not None
    assert final.text == "Hi"
    assert final.usage.total_tokens == 5
    assert dict(final.raw_provider_metadata)["finish_reason"] == "stop"


@pytest.mark.asyncio
async def test_openai_chat_completions_client_aggregates_streamed_tool_calls_and_disables_parallel() -> None:
    tool: ChatCompletionFunctionToolParam = {
        "type": "function",
        "function": {
            "name": "memory_read_files",
            "description": "Read memory",
            "strict": True,
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    }
    fake_openai = _FakeOpenAIClient(
        [
            _sdk_chunk(
                tool_calls=[
                    {
                        "index": 0,
                        "id": "call-1",
                        "type": "function",
                        "function": {"name": "memory_read_files", "arguments": ""},
                    }
                ]
            ),
            _sdk_chunk(tool_calls=[{"index": 0, "type": "function", "function": {"arguments": '{"paths":"pro'}}]),
            _sdk_chunk(
                finish_reason="tool_calls",
                usage=_sdk_usage(),
                tool_calls=[{"index": 0, "type": "function", "function": {"arguments": 'file.md"}'}}],
            ),
        ]
    )
    client = OpenAIChatCompletionsModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    deltas = await _collect(client.stream(_spec(tools=(tool,))))

    tool_events = [
        delta.stream_event
        for delta in deltas
        if delta.kind == "event"
        and delta.stream_event is not None
        and isinstance(delta.stream_event, MCFunctionToolCallDeltaEvent)
    ]
    assert len(tool_events) == 3
    assert tool_events[0].tool_call_id == "call-1"
    assert tool_events[0].tool_name == "memory_read_files"
    assert tool_events[1].arguments_fragment_length == len('{"paths":"pro')
    assert "arguments" not in tool_events[1].details
    payload = fake_openai.create_calls[0]
    assert payload["tools"] == [tool]
    assert payload["tool_choice"] == "auto"
    assert payload["parallel_tool_calls"] is False
    final = deltas[-2].final
    assert final is not None
    assert [(call.id, call.name, call.arguments) for call in final.tool_calls] == [
        ("call-1", "memory_read_files", '{"paths":"profile.md"}')
    ]
    assert final.text == ""


@pytest.mark.asyncio
async def test_openai_chat_completions_client_emits_unknown_events_for_multi_choice_and_extra_fields() -> None:
    fake_openai = _FakeOpenAIClient(
        [
            _sdk_chunk(
                choices=[
                    {
                        "index": 0,
                        "delta": {"content": "A", "phase": "commentary"},
                        "finish_reason": None,
                        "provider_choice_field": "value",
                    },
                    {"index": 1, "delta": {"content": "B"}, "finish_reason": "stop"},
                ],
                extra={"provider_top_field": "value"},
            ),
            _sdk_chunk(choices=[], usage=_sdk_usage()),
        ]
    )
    client = OpenAIChatCompletionsModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    deltas = await _collect(client.stream(_spec(messages=_messages_with_instructions())))
    unknown_events = [
        delta.stream_event
        for delta in deltas
        if delta.kind == "event"
        and delta.stream_event is not None
        and isinstance(delta.stream_event, MCUnknownProviderEvent)
    ]

    assert [event.provider_event_type for event in unknown_events] == [
        "chat.completion.chunk.multi_choice",
        "chat.completion.chunk.unknown_fields",
        "chat.completion.chunk.choice_unknown_fields",
    ]
    assert unknown_events[0].details["choice_count"] == 2
    assert unknown_events[0].details["choice0_used"] is True
    assert unknown_events[0].details["choice_indexes"] == (0, 1)
    assert unknown_events[1].details["unknown_field_names"] == ("provider_top_field",)
    assert unknown_events[2].details["unknown_field_names"] == (
        "provider_choice_field",
        "phase",
    )
    final = _public_deltas(deltas)[-2].final
    assert final is not None
    assert final.text == "A"
    assert dict(final.raw_provider_metadata)["choice_finish_reasons"] == ("1:stop",)


@pytest.mark.asyncio
async def test_openai_chat_completions_client_rejects_missing_api_key_without_shared_client() -> None:
    client = OpenAIChatCompletionsModelClient(api_key="", client=None)

    with pytest.raises(ModelClientProviderError) as exc_info:
        await _collect(client.stream(_spec()))

    assert exc_info.value.code == "missing_api_key"


@pytest.mark.asyncio
async def test_openai_chat_completions_client_requires_the_connection_key_it_references() -> None:
    client = OpenAIChatCompletionsModelClient(
        credential_resolver=static_credential_resolver({"OPENAI_API_KEY": "sk-openai"}),
        client=None,
    )
    connection = _owner_connection("deepseek", credential_env="DEEPSEEK_API_KEY")

    with pytest.raises(ModelClientProviderError) as exc_info:
        await _collect(client.stream(_spec(model="deepseek-v4-flash", connection=connection)))

    assert exc_info.value.code == "missing_api_key"
    assert exc_info.value.raw_metadata["base_url"] == DEEPSEEK_BASE_URL
    assert exc_info.value.raw_metadata["model"] == "deepseek-v4-flash"
    assert exc_info.value.raw_metadata["connection_name"] == "DeepSeek"


@pytest.mark.asyncio
async def test_openai_chat_completions_client_rejects_disallowed_credential_references() -> None:
    client = OpenAIChatCompletionsModelClient(
        credential_resolver=static_credential_resolver(
            {"OPENAI_API_KEY": "sk-openai", "ANIMAMA_DATABASE_URL": "postgresql://secret"}
        ),
        client=None,
    )
    connection = _owner_connection("custom", base_url="http://example.test/v1", credential_env="ANIMAMA_DATABASE_URL")

    with pytest.raises(ModelClientProviderError) as exc_info:
        await _collect(client.stream(_spec(connection=connection)))

    assert exc_info.value.code == "missing_api_key"


@pytest.mark.asyncio
async def test_owner_row_without_its_loaded_connection_never_falls_back_to_openai() -> None:
    fake_openai = _FakeOpenAIClient([_sdk_chunk(content="Hi")])
    client = OpenAIChatCompletionsModelClient(api_key="sk-openai", client=fake_openai)  # type: ignore[arg-type]
    spec = _spec(connection=_owner_connection("ollama"))
    spec.model_provider.connection = None

    with pytest.raises(ModelClientProviderError) as exc_info:
        await _collect(client.stream(spec))

    assert exc_info.value.code == "connection_unavailable"
    assert fake_openai.create_calls == []


@pytest.mark.asyncio
async def test_responses_client_rejects_rows_outside_the_builtin_connection_before_any_request() -> None:
    fake_openai = _FakeOpenAIClient([])
    client = OpenAIResponsesModelClient(api_key="sk-openai", client=fake_openai)  # type: ignore[arg-type]

    with pytest.raises(ModelClientProviderError) as exc_info:
        await _collect(
            client.stream(
                _spec(provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE, connection=_owner_connection("vllm"))
            )
        )

    assert exc_info.value.code == "responses_connection_unsupported"
    assert fake_openai.response_create_calls == []


@pytest.mark.asyncio
async def test_openai_chat_completions_client_retries_transient_create_error_before_stream() -> None:
    fake_openai = _FakeOpenAIClient(
        [
            _sdk_chunk(content="Hi"),
            _sdk_chunk(finish_reason="stop", usage=_sdk_usage()),
        ],
        chat_failures=[
            _api_status_error(
                status_code=500,
                url="https://api.openai.example/v1/chat/completions",
                body={"error": {"code": "server_error", "message": "Internal server error."}},
            )
        ],
    )
    client = OpenAIChatCompletionsModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    deltas = await _collect(client.stream(_spec(messages=_messages_with_instructions())))
    public_deltas = _public_deltas(deltas)

    assert [delta.kind for delta in public_deltas] == ["text_delta", "final", "done"]
    assert len(fake_openai.create_calls) == 2
    assert fake_openai.create_calls[0]["messages"] == fake_openai.create_calls[1]["messages"]
    assert public_deltas[1].final is not None
    assert public_deltas[1].final.text == "Hi"


@pytest.mark.asyncio
async def test_openai_chat_completions_client_does_not_retry_after_text_delta() -> None:
    fake_openai = _FakeOpenAIClient(
        [
            _sdk_chunk(content="Hi"),
            _api_status_error(
                status_code=500,
                url="https://api.openai.example/v1/chat/completions",
                body={"error": {"code": "server_error", "message": "Internal server error."}},
            ),
        ]
    )
    client = OpenAIChatCompletionsModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    with pytest.raises(ModelClientProviderError) as exc_info:
        await _collect(client.stream(_spec(messages=_messages_with_instructions())))

    assert exc_info.value.code == "openai_server_error"
    assert exc_info.value.raw_metadata["status_code"] == 500
    assert "body" not in exc_info.value.raw_metadata
    assert len(fake_openai.create_calls) == 1


@pytest.mark.asyncio
async def test_openai_responses_client_uses_sdk_stream_and_scoped_cursor() -> None:
    fake_openai = _FakeOpenAIClient(
        [],
        response_events=[
            _responses_text_delta_event('{"speech":"Hel', sequence_number=1),
            _responses_text_delta_event('lo"}', sequence_number=2),
            _responses_text_done_event('{"speech":"Hello"}', sequence_number=3),
            _responses_completed_event(),
        ],
    )
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
        timeout=12.0,
    )
    continuation = ModelClientContinuation(
        provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
        cursor="resp_1",
        metadata={"model": "gpt-test"},
    )

    deltas = await _collect(
        client.stream(
            _spec(
                provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
                continuation=continuation,
                request_options={"reasoning_effort": "low", "native_tools": ["web_search"]},
                messages=_messages_with_instructions(),
            )
        )
    )

    public_deltas = _public_deltas(deltas)

    assert [(delta.kind, delta.text) for delta in public_deltas] == [
        ("text_delta", '{"speech":"Hel'),
        ("text_delta", 'lo"}'),
        ("final", None),
        ("done", None),
    ]
    assert _stream_event_summaries(deltas) == [
        ("response.output_text.delta", "text_delta"),
        ("response.output_text.delta", "text_delta"),
        ("response.output_text.done", "text_done"),
        ("response.completed", "terminal_completed"),
    ]
    assert fake_openai.with_options_calls == [{"base_url": "https://api.openai.example/v1", "timeout": 12.0}]
    payload = fake_openai.response_create_calls[0]
    assert payload["model"] == "gpt-test"
    # The stored response holds the history; the turn context and user message are new.
    assert payload["input"] == [
        {"role": "developer", "content": _expected_memory_map_text()},
        {"role": "user", "content": "hello"},
    ]
    assert payload["instructions"] == "Core instruction"
    assert payload["previous_response_id"] == "resp_1"
    assert (
        payload["prompt_cache_key"] == sha256(b"user-1\x1fanima-1\x1fOpenAIResponsesHTTPAgent\x1fgpt-test").hexdigest()
    )
    assert payload["stream"] is True
    assert payload["store"] is True
    assert payload["text"]["format"]["type"] == "json_schema"
    assert payload["reasoning"] == {"effort": "low"}
    assert payload["context_management"] == [{"type": "compaction", "compact_threshold": 90_000}]
    assert payload["tools"] == [{"type": "web_search", "search_context_size": "low"}]
    final = public_deltas[2].final
    assert final is not None
    assert final.text == '{"speech":"Hello"}'
    assert final.usage.input_tokens == 4
    assert final.usage.output_tokens == 6
    assert final.usage.input_tokens_details.cached_tokens == 2
    assert final.usage.output_tokens_details.reasoning_tokens == 3
    assert dict(final.raw_provider_metadata)["response_id"] == "resp_2"
    assert dict(final.raw_provider_metadata)["previous_response_id"] == "resp_1"


@pytest.mark.asyncio
async def test_openai_responses_client_accepts_response_done_without_newer_sdk_fields() -> None:
    """Compatible servers end with response.done and may omit fields newer SDKs require."""
    usage = _responses_usage()
    usage["input_tokens_details"] = {"cached_tokens": 2}
    # Built like the SDK stream parser, which leaves an untyped event's response as a dict.
    done_event = construct_type(
        type_=ResponseStreamEvent,
        value={"type": "response.done", "sequence_number": 3, "response": _response_payload(usage=usage)},
    )
    fake_openai = _FakeOpenAIClient(
        [],
        response_events=[
            _responses_text_delta_event('{"speech":"Hello"}', sequence_number=1),
            _responses_text_done_event('{"speech":"Hello"}', sequence_number=2),
            done_event,
        ],
    )
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
        timeout=12.0,
    )

    deltas = await _collect(
        client.stream(_spec(provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE, messages=_messages_with_instructions()))
    )

    public_deltas = _public_deltas(deltas)
    assert [delta.kind for delta in public_deltas] == ["text_delta", "final", "done"]
    final = public_deltas[1].final
    assert final is not None
    assert final.text == '{"speech":"Hello"}'
    assert final.usage.input_tokens == 4
    assert final.usage.input_tokens_details.cached_tokens == 2


@pytest.mark.asyncio
async def test_openai_responses_client_emits_typed_apply_patch_with_functions_and_structured_output() -> None:
    fake_openai = _FakeOpenAIClient([], response_events=[_responses_completed_event()])
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    await _collect(
        client.stream(
            _spec(
                provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
                request_options={"memory_apply_patch_enabled": True},
                messages=_messages_with_instructions(),
                tools=(_memory_read_tool(),),
            )
        )
    )

    payload = fake_openai.response_create_calls[0]
    assert payload["tools"][0] == {"type": "apply_patch"}
    assert payload["tools"][1]["type"] == "function"
    assert payload["tools"][1]["name"] == "memory_read_files"
    assert payload["tool_choice"] == "auto"
    assert payload["parallel_tool_calls"] is False
    assert payload["text"]["format"]["type"] == "json_schema"


@pytest.mark.asyncio
async def test_openai_responses_client_extracts_apply_patch_and_sanitizes_lifecycle_events() -> None:
    diff = "*** Begin Patch\n*** Update File: profile.md\n@@\n-old\n+new\n*** End Patch"
    patch_item = {
        "id": "ap_1",
        "call_id": "call_patch_1",
        "type": "apply_patch_call",
        "status": "completed",
        "operation": {"type": "update_file", "path": "private/profile.md", "diff": diff},
    }
    fake_openai = _FakeOpenAIClient(
        [],
        response_events=[
            _responses_output_item_added_event(patch_item, sequence_number=1),
            _responses_output_item_done_event(patch_item, sequence_number=2),
            _responses_completed_event(output=[patch_item], sequence_number=3),
        ],
    )
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    deltas = await _collect(
        client.stream(
            _spec(
                provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
                request_options={"memory_apply_patch_enabled": True},
                messages=_messages_with_instructions(),
            )
        )
    )

    native_events = [
        delta.stream_event
        for delta in deltas
        if delta.kind == "event" and isinstance(delta.stream_event, MCToolStartedEvent | MCToolDoneEvent)
    ]
    assert [(event.kind, event.tool_type, event.tool_call_id) for event in native_events] == [
        ("tool_started", "apply_patch_call", "call_patch_1"),
        ("tool_done", "apply_patch_call", "call_patch_1"),
    ]
    for event in native_events:
        assert event.action_type == "update_file"
        assert event.path_length == len("private/profile.md")
        serialized = json.dumps(dict(event.details))
        assert "private/profile.md" not in serialized
        assert diff not in serialized

    final = _public_deltas(deltas)[-2].final
    assert final is not None
    assert [(call.id, call.name, call.tool_type) for call in final.tool_calls] == [
        ("call_patch_1", "apply_patch", "apply_patch")
    ]
    assert json.loads(final.tool_calls[0].arguments) == patch_item["operation"]
    summaries = dict(final.raw_provider_metadata)["native_tool_summaries"]
    assert summaries == (
        {
            "item_id": "ap_1",
            "tool_type": "apply_patch_call",
            "status": "completed",
            "output_index": 0,
            "tool_call_id": "call_patch_1",
            "action_type": "update_file",
            "path_length": len("private/profile.md"),
        },
    )
    serialized_summaries = json.dumps([dict(summary) for summary in summaries])
    assert "private/profile.md" not in serialized_summaries
    assert diff not in serialized_summaries


@pytest.mark.asyncio
async def test_openai_responses_client_sends_only_native_patch_output_with_cursor() -> None:
    operation = {"type": "create_file", "path": "notes.md", "diff": "+hello"}
    messages = (
        {"role": "system", "content": "Core instruction"},
        {
            "type": "model_client_tool_call",
            "call_id": "call_patch_1",
            "tool_type": "apply_patch",
            "name": "apply_patch",
            "arguments": json.dumps(operation),
        },
        {
            "type": "model_client_tool_result",
            "call_id": "call_patch_1",
            "tool_type": "apply_patch",
            "status": "failed",
            "output": '{"ok":false,"code":"conflict"}',
        },
        {"role": "developer", "content": "Produce the final response without more tools."},
    )
    fake_openai = _FakeOpenAIClient([], response_events=[_responses_completed_event()])
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    await _collect(
        client.stream(
            _spec(
                provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
                continuation=ModelClientContinuation(
                    provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
                    cursor="resp_patch",
                ),
                request_options={"memory_apply_patch_enabled": True},
                messages=messages,
            )
        )
    )

    payload = fake_openai.response_create_calls[0]
    assert payload["previous_response_id"] == "resp_patch"
    # The forced-final instruction follows the tool output as a developer item, not in `instructions`.
    assert payload["instructions"] == "Core instruction"
    assert payload["input"] == [
        {
            "type": "apply_patch_call_output",
            "call_id": "call_patch_1",
            "status": "failed",
            "output": '{"ok":false,"code":"conflict"}',
        },
        {"role": "developer", "content": "Produce the final response without more tools."},
    ]


@pytest.mark.asyncio
async def test_openai_responses_client_explicitly_replays_native_patch_call_and_output() -> None:
    operation = {"type": "create_file", "path": "notes.md", "diff": "+hello"}
    messages = (
        {"role": "system", "content": "Core instruction"},
        {"role": "user", "content": "Remember this."},
        {
            "type": "model_client_tool_call",
            "call_id": "call_patch_1",
            "tool_type": "apply_patch",
            "name": "apply_patch",
            "arguments": json.dumps(operation),
        },
        {
            "type": "model_client_tool_result",
            "call_id": "call_patch_1",
            "tool_type": "apply_patch",
            "status": "completed",
            "output": '{"ok":true,"path":"notes.md"}',
        },
        {"role": "user", "content": "What did you remember?"},
    )
    fake_openai = _FakeOpenAIClient([], response_events=[_responses_completed_event()])
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    await _collect(
        client.stream(
            _spec(
                provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
                request_options={"memory_apply_patch_enabled": True},
                messages=messages,
            )
        )
    )

    assert fake_openai.response_create_calls[0]["input"] == [
        {"role": "user", "content": [_breakpoint_part("Remember this.", "input_text")]},
        {
            "type": "apply_patch_call",
            "call_id": "call_patch_1",
            "operation": operation,
            "status": "completed",
        },
        {
            "type": "apply_patch_call_output",
            "call_id": "call_patch_1",
            "status": "completed",
            "output": '{"ok":true,"path":"notes.md"}',
        },
        {"role": "user", "content": "What did you remember?"},
    ]


@pytest.mark.asyncio
async def test_openai_responses_client_replays_manual_assistant_phase_values() -> None:
    fake_openai = _FakeOpenAIClient(
        [],
        response_events=[
            _responses_completed_event(),
        ],
    )
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    await _collect(
        client.stream(
            _spec(
                provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
                messages=(
                    {"role": "assistant", "content": "Checking the logs."},
                    {"role": "assistant", "content": "Root cause identified."},
                    {"role": "user", "content": "Give me the fix."},
                ),
                metadata={
                    "openai_responses_history": {
                        "assistant_phases_by_message_index": {
                            "0": "commentary",
                            "1": "final_answer",
                            "2": "final_answer",
                        }
                    }
                },
            )
        )
    )

    payload = fake_openai.response_create_calls[0]
    assert payload["input"] == [
        {"role": "assistant", "content": "Checking the logs.", "phase": "commentary"},
        {"role": "assistant", "content": "Root cause identified.", "phase": "final_answer"},
        {"role": "user", "content": "Give me the fix."},
    ]


@pytest.mark.asyncio
async def test_openai_responses_client_handles_assistant_phase_and_final_answer_text() -> None:
    commentary_added = _response_message_item(item_id="msg_commentary", phase="commentary", status="in_progress")
    commentary_done = _response_message_item(
        item_id="msg_commentary",
        text='{"speech":"Checking memory."}',
        phase="commentary",
    )
    final_added = _response_message_item(item_id="msg_final", phase="final_answer", status="in_progress")
    final_done = _response_message_item(
        item_id="msg_final",
        text='{"speech":"Here is the answer."}',
        phase="final_answer",
    )
    fake_openai = _FakeOpenAIClient(
        [],
        response_events=[
            _responses_output_item_added_event(commentary_added, output_index=0, sequence_number=1),
            _responses_text_delta_event(
                '{"speech":"Checking',
                item_id="msg_commentary",
                output_index=0,
                sequence_number=2,
            ),
            _responses_text_delta_event(' memory."}', item_id="msg_commentary", output_index=0, sequence_number=3),
            _responses_output_item_done_event(commentary_done, output_index=0, sequence_number=4),
            _responses_output_item_added_event(final_added, output_index=1, sequence_number=5),
            _responses_text_delta_event('{"speech":"Here', item_id="msg_final", output_index=1, sequence_number=6),
            _responses_text_delta_event(' is the answer."}', item_id="msg_final", output_index=1, sequence_number=7),
            _responses_output_item_done_event(final_done, output_index=1, sequence_number=8),
            _responses_completed_event(output=[commentary_done, final_done], sequence_number=9),
        ],
    )
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    deltas = await _collect(
        client.stream(_spec(provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE, messages=_messages_with_instructions()))
    )

    public_deltas = _public_deltas(deltas)
    assert [(delta.kind, delta.text) for delta in public_deltas] == [
        ("text_delta", '{"speech":"Here'),
        ("text_delta", ' is the answer."}'),
        ("final", None),
        ("done", None),
    ]
    phase_events = [
        delta.stream_event
        for delta in deltas
        if delta.kind == "event"
        and delta.stream_event is not None
        and isinstance(delta.stream_event, MCAssistantPhaseEvent)
    ]
    assert [event.phase for event in phase_events] == [
        "commentary",
        "commentary",
        "final_answer",
        "final_answer",
    ]
    final = public_deltas[-2].final
    assert final is not None
    assert final.text == '{"speech":"Here is the answer."}'
    metadata = dict(final.raw_provider_metadata)
    assert metadata["phase"] == "final_answer"
    assert metadata["message_phases"] == ("msg_commentary:commentary", "msg_final:final_answer")
    assert metadata["phase_counts"] == {"commentary": 1, "final_answer": 1}


@pytest.mark.asyncio
async def test_openai_responses_client_rejects_phased_completion_without_final_answer() -> None:
    commentary = _response_message_item(
        item_id="msg_commentary",
        text='{"speech":"Still checking."}',
        phase="commentary",
    )
    fake_openai = _FakeOpenAIClient(
        [],
        response_events=[_responses_completed_event(output=[commentary], sequence_number=1)],
    )
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    with pytest.raises(ModelClientProviderError) as exc_info:
        await _collect(
            client.stream(
                _spec(provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE, messages=_messages_with_instructions())
            )
        )

    assert exc_info.value.code == "openai_missing_final_answer_phase"
    assert exc_info.value.raw_metadata["missing_final_answer_phase"] is True
    assert exc_info.value.raw_metadata["phase"] == "commentary"


@pytest.mark.asyncio
async def test_openai_responses_client_honors_store_provider_option() -> None:
    fake_openai = _FakeOpenAIClient([], response_events=[_responses_completed_event(previous_response_id=None)])
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    await _collect(
        client.stream(
            _spec(
                provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
                request_options={"store": False},
                messages=_messages_with_instructions(),
            )
        )
    )

    assert fake_openai.response_create_calls[0]["store"] is False


@pytest.mark.asyncio
async def test_openai_responses_client_can_disable_native_compaction_payload() -> None:
    fake_openai = _FakeOpenAIClient([], response_events=[_responses_completed_event(previous_response_id=None)])
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
        compaction_threshold_tokens=0,
    )

    await _collect(
        client.stream(
            _spec(
                provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
                messages=_messages_with_instructions(),
            )
        )
    )

    assert "context_management" not in fake_openai.response_create_calls[0]


@pytest.mark.parametrize(("threshold", "native"), [(10_000, True), (0, False), (-1, False), (None, False)])
def test_responses_client_reports_native_compaction_only_when_requests_carry_it(
    threshold: int | None, native: bool
) -> None:
    # Without native compaction the direct-chat executor fits prompts to the row's window.
    responses = OpenAIResponsesModelClient(api_key="sk-test", compaction_threshold_tokens=threshold)
    registry = build_model_client_registry(
        app_settings=settings.model_copy(
            update={"anima_openai_responses_compaction_threshold_tokens": threshold if threshold is not None else 0}
        ),
        credential_resolver=static_credential_resolver(),
    )

    assert uses_native_context_compaction(responses) is native
    assert uses_native_context_compaction(registry.get(OPENAI_RESPONSES_HTTP_PROVIDER_TYPE)) is native
    assert uses_native_context_compaction(registry.get(OPENAI_HTTP_PROVIDER_TYPE)) is False


@pytest.mark.asyncio
async def test_openai_responses_client_classifies_previous_response_cursor_error() -> None:
    fake_openai = _FailingResponsesOpenAIClient(
        _api_status_error(
            status_code=400,
            body={
                "error": {
                    "code": "previous_response_not_found",
                    "param": "previous_response_id",
                    "message": "The previous_response_id cannot be resolved from available state.",
                }
            },
        )
    )
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )
    continuation = ModelClientContinuation(
        provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
        cursor="resp_missing",
    )

    with pytest.raises(ModelClientProviderError) as exc_info:
        await _collect(
            client.stream(
                _spec(
                    provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
                    continuation=continuation,
                    messages=_messages_with_instructions(),
                )
            )
        )

    assert exc_info.value.code == OPENAI_PREVIOUS_RESPONSE_UNRESOLVABLE_CODE
    assert exc_info.value.raw_metadata["previous_response_id"] == "resp_missing"
    assert exc_info.value.raw_metadata["provider_error_code"] == "previous_response_not_found"
    assert exc_info.value.raw_metadata["provider_error_param"] == "previous_response_id"
    assert "body" not in exc_info.value.raw_metadata
    assert fake_openai.response_create_calls[0]["previous_response_id"] == "resp_missing"


def test_openai_responses_previous_response_error_detection_is_specific() -> None:
    assert is_previous_response_unresolvable(
        {
            "status_code": 400,
            "body": {
                "error": {
                    "param": "previous_response_id",
                    "message": "No response found for previous_response_id.",
                }
            },
        }
    )
    assert not is_previous_response_unresolvable(
        {
            "status_code": 401,
            "body": {
                "error": {
                    "code": "invalid_api_key",
                    "message": "Incorrect API key provided.",
                }
            },
        }
    )


@pytest.mark.asyncio
async def test_openai_responses_client_retries_transient_create_error_before_stream() -> None:
    fake_openai = _FakeOpenAIClient(
        [],
        response_events=[_responses_completed_event(previous_response_id=None)],
        response_failures=[
            _api_status_error(
                status_code=503,
                body={"error": {"code": "server_error", "message": "OpenAI is overloaded."}},
            )
        ],
    )
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    deltas = await _collect(
        client.stream(_spec(provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE, messages=_messages_with_instructions()))
    )
    public_deltas = _public_deltas(deltas)

    assert [delta.kind for delta in public_deltas] == ["final", "done"]
    assert len(fake_openai.response_create_calls) == 2
    assert fake_openai.response_create_calls[0]["input"] == fake_openai.response_create_calls[1]["input"]
    assert public_deltas[0].final is not None
    assert public_deltas[0].final.text == '{"speech":"Hello"}'


@pytest.mark.asyncio
async def test_openai_responses_client_does_not_retry_after_text_delta() -> None:
    fake_openai = _FakeOpenAIClient(
        [],
        response_events=[
            _responses_text_delta_event('{"speech":"Hi'),
            _api_status_error(
                status_code=503,
                body={"error": {"code": "server_error", "message": "OpenAI is overloaded."}},
            ),
        ],
    )
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    with pytest.raises(ModelClientProviderError) as exc_info:
        await _collect(
            client.stream(
                _spec(provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE, messages=_messages_with_instructions())
            )
        )

    assert exc_info.value.code == "openai_overloaded"
    assert exc_info.value.raw_metadata["status_code"] == 503
    assert "body" not in exc_info.value.raw_metadata
    assert len(fake_openai.response_create_calls) == 1


@pytest.mark.asyncio
async def test_openai_responses_client_replays_context_without_cursor() -> None:
    fake_openai = _FakeOpenAIClient([], response_events=[_responses_completed_event(previous_response_id=None)])
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    deltas = await _collect(
        client.stream(_spec(provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE, messages=_messages_with_instructions()))
    )

    payload = fake_openai.response_create_calls[0]
    assert "previous_response_id" not in payload
    assert payload["instructions"] == "Core instruction"
    # Full history in the same order, with the history user message marked as a cache breakpoint.
    assert payload["input"] == [
        {"role": "user", "content": [_breakpoint_part("Compacted history", "input_text")]},
        {"role": "assistant", "content": "previous"},
        {"role": "developer", "content": _expected_memory_map_text()},
        {"role": "user", "content": "hello"},
    ]
    assert deltas[-1].kind == "done"


@pytest.mark.asyncio
async def test_openai_responses_client_converts_memory_tools_and_parses_function_calls() -> None:
    fake_openai = _FakeOpenAIClient(
        [],
        response_events=[
            ResponseFunctionCallArgumentsDeltaEvent.model_validate(
                {
                    "type": "response.function_call_arguments.delta",
                    "sequence_number": 1,
                    "output_index": 0,
                    "item_id": "fc_1",
                    "delta": '{"paths":"profile',
                }
            ),
            ResponseFunctionCallArgumentsDoneEvent.model_validate(
                {
                    "type": "response.function_call_arguments.done",
                    "sequence_number": 2,
                    "output_index": 0,
                    "item_id": "fc_1",
                    "arguments": '{"paths":"profile.md"}',
                }
            ),
            _responses_completed_event(
                response_id="resp_tool",
                output=[
                    {
                        "id": "fc_1",
                        "type": "function_call",
                        "call_id": "call-1",
                        "name": "memory_read_files",
                        "arguments": '{"paths":"profile.md"}',
                        "status": "completed",
                    }
                ],
            ),
        ],
    )
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    deltas = await _collect(
        client.stream(_spec(provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE, tools=(_memory_read_tool(),)))
    )

    payload = fake_openai.response_create_calls[0]
    assert payload["tools"] == [
        {
            "type": "function",
            "name": "memory_read_files",
            "description": "Read memory files.",
            "parameters": {
                "type": "object",
                "properties": {"paths": {"type": "string"}},
                "required": ["paths"],
                "additionalProperties": False,
            },
            "strict": True,
        }
    ]
    assert payload["tool_choice"] == "auto"
    assert payload["parallel_tool_calls"] is False
    final = _public_deltas(deltas)[-2].final
    assert final is not None
    function_events = [
        delta.stream_event
        for delta in deltas
        if delta.kind == "event"
        and delta.stream_event is not None
        and isinstance(delta.stream_event, MCFunctionToolCallDeltaEvent | MCFunctionToolCallDoneEvent)
    ]
    assert [event.kind for event in function_events] == [
        "function_tool_call_delta",
        "function_tool_call_done",
    ]
    assert function_events[0].arguments_fragment_length == len('{"paths":"profile')
    assert function_events[1].arguments_length == len('{"paths":"profile.md"}')
    assert "arguments" not in function_events[1].details
    assert final.text == ""
    assert [(call.id, call.name, call.arguments) for call in final.tool_calls] == [
        ("call-1", "memory_read_files", '{"paths":"profile.md"}')
    ]
    assert dict(final.raw_provider_metadata)["response_id"] == "resp_tool"


@pytest.mark.asyncio
async def test_openai_responses_client_observes_native_web_search_without_raw_query() -> None:
    web_search_item = {
        "id": "ws_1",
        "type": "web_search_call",
        "status": "completed",
        "action": {"type": "search", "query": "private query"},
    }
    message = _response_message_item(text='{"speech":"Search complete."}')
    fake_openai = _FakeOpenAIClient(
        [],
        response_events=[
            ResponseWebSearchCallInProgressEvent.model_validate(
                {
                    "type": "response.web_search_call.in_progress",
                    "sequence_number": 1,
                    "output_index": 0,
                    "item_id": "ws_1",
                }
            ),
            ResponseWebSearchCallSearchingEvent.model_validate(
                {
                    "type": "response.web_search_call.searching",
                    "sequence_number": 2,
                    "output_index": 0,
                    "item_id": "ws_1",
                }
            ),
            ResponseWebSearchCallCompletedEvent.model_validate(
                {
                    "type": "response.web_search_call.completed",
                    "sequence_number": 3,
                    "output_index": 0,
                    "item_id": "ws_1",
                }
            ),
            _responses_output_item_done_event(web_search_item, output_index=0, sequence_number=4),
            _responses_completed_event(output=[web_search_item, message], sequence_number=5),
        ],
    )
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    deltas = await _collect(
        client.stream(_spec(provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE, messages=_messages_with_instructions()))
    )

    native_events = [
        delta.stream_event
        for delta in deltas
        if delta.kind == "event"
        and delta.stream_event is not None
        and isinstance(delta.stream_event, MCToolStartedEvent | MCToolProgressEvent | MCToolDoneEvent)
    ]
    assert [(event.provider_event_type, event.kind, event.tool_type) for event in native_events] == [
        ("response.web_search_call.in_progress", "tool_started", "web_search_call"),
        ("response.web_search_call.searching", "tool_progress", "web_search_call"),
        ("response.web_search_call.completed", "tool_done", "web_search_call"),
        ("response.output_item.done", "tool_done", "web_search_call"),
    ]
    output_item_event = native_events[-1]
    assert output_item_event.query_count == 1
    assert "query" not in output_item_event.details
    final = _public_deltas(deltas)[-2].final
    assert final is not None
    summaries = dict(final.raw_provider_metadata)["native_tool_summaries"]
    assert summaries[0]["tool_type"] == "web_search_call"
    assert summaries[0]["query_count"] == 1
    assert "query" not in summaries[0]


@pytest.mark.asyncio
async def test_openai_responses_client_maps_incomplete_event_to_provider_error() -> None:
    fake_openai = _FakeOpenAIClient(
        [],
        response_events=[
            ResponseIncompleteEvent.model_validate(
                {
                    "type": "response.incomplete",
                    "sequence_number": 1,
                    "response": _response_payload(
                        response_id="resp_incomplete",
                        output=[],
                        status="incomplete",
                        extra={"incomplete_details": {"reason": "max_output_tokens"}},
                    ),
                }
            )
        ],
    )
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    with pytest.raises(ModelClientProviderError) as exc_info:
        await _collect(
            client.stream(
                _spec(provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE, messages=_messages_with_instructions())
            )
        )

    assert exc_info.value.code == "openai_stream_error"
    assert exc_info.value.raw_metadata["event_type"] == "response.incomplete"


@pytest.mark.asyncio
async def test_openai_responses_client_maps_failed_and_error_events_to_provider_error() -> None:
    failed_client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=_FakeOpenAIClient(
            [],
            response_events=[
                ResponseFailedEvent.model_validate(
                    {
                        "type": "response.failed",
                        "sequence_number": 1,
                        "response": _response_payload(
                            response_id="resp_failed",
                            output=[],
                            status="failed",
                            extra={"error": {"code": "server_error", "type": "server_error", "message": "failed"}},
                        ),
                    }
                )
            ],
        ),  # type: ignore[arg-type]
    )
    error_client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=_FakeOpenAIClient(
            [],
            response_events=[
                ResponseErrorEvent.model_validate(
                    {
                        "type": "error",
                        "sequence_number": 1,
                        "code": "rate_limit_exceeded",
                        "message": "too many requests",
                        "param": None,
                    }
                )
            ],
        ),  # type: ignore[arg-type]
    )

    with pytest.raises(ModelClientProviderError) as failed_exc:
        await _collect(
            failed_client.stream(
                _spec(provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE, messages=_messages_with_instructions())
            )
        )
    with pytest.raises(ModelClientProviderError) as error_exc:
        await _collect(
            error_client.stream(
                _spec(provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE, messages=_messages_with_instructions())
            )
        )

    # Stream events keep the provider's classification, and are never retried.
    assert failed_exc.value.code == "openai_server_error"
    assert failed_exc.value.raw_metadata["provider_error_code"] == "server_error"
    assert failed_exc.value.raw_metadata["provider_error_type"] == "server_error"
    assert failed_exc.value.raw_metadata["retryable"] is False
    assert error_exc.value.code == "openai_rate_limit"
    assert error_exc.value.raw_metadata["provider_error_code"] == "rate_limit_exceeded"
    assert error_exc.value.raw_metadata["retryable"] is False
    assert "message" not in error_exc.value.raw_metadata


@pytest.mark.asyncio
async def test_openai_responses_client_fails_when_stream_closes_without_terminal_event() -> None:
    fake_openai = _FakeOpenAIClient(
        [],
        response_events=[_responses_text_delta_event('{"speech":"Partial')],
    )
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    with pytest.raises(ModelClientProviderError) as exc_info:
        await _collect(
            client.stream(
                _spec(provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE, messages=_messages_with_instructions())
            )
        )

    assert exc_info.value.code == "openai_stream_incomplete"
    assert exc_info.value.raw_metadata["completed_missing"] is True


@pytest.mark.asyncio
async def test_openai_responses_client_emits_unknown_provider_events() -> None:
    fake_openai = _FakeOpenAIClient(
        [],
        response_events=[
            SimpleNamespace(type="response.provider_future", sequence_number=1, provider_field="value"),
            _responses_completed_event(sequence_number=2),
        ],
    )
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )

    deltas = await _collect(
        client.stream(_spec(provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE, messages=_messages_with_instructions()))
    )

    unknown_events = [
        delta.stream_event
        for delta in deltas
        if delta.kind == "event"
        and delta.stream_event is not None
        and isinstance(delta.stream_event, MCUnknownProviderEvent)
    ]
    assert len(unknown_events) == 1
    assert unknown_events[0].provider_event_type == "response.provider_future"
    assert unknown_events[0].details["unknown_field_names"] == ("provider_field", "sequence_number", "type")
    assert _public_deltas(deltas)[-2].final is not None


@pytest.mark.asyncio
async def test_openai_responses_client_sends_function_call_outputs_with_cursor() -> None:
    fake_openai = _FakeOpenAIClient([], response_events=[_responses_completed_event(response_id="resp_final")])
    client = OpenAIResponsesModelClient(
        api_key="sk-test",
        client=fake_openai,  # type: ignore[arg-type]
    )
    continuation = ModelClientContinuation(
        provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
        cursor="resp_tool",
    )
    messages: tuple[dict[str, Any], ...] = (
        {"role": "user", "content": "hello"},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": "memory_read_files", "arguments": '{"paths":"profile.md"}'},
                }
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call-1",
            "content": '{"ok":true,"content":"Profile content"}',
        },
    )

    await _collect(
        client.stream(
            _spec(
                provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE,
                continuation=continuation,
                messages=messages,
                tools=(_memory_read_tool(),),
            )
        )
    )

    payload = fake_openai.response_create_calls[0]
    assert payload["previous_response_id"] == "resp_tool"
    assert payload["input"] == [
        {
            "type": "function_call_output",
            "call_id": "call-1",
            "output": '{"ok":true,"content":"Profile content"}',
        }
    ]


@pytest.mark.asyncio
async def test_missing_streamed_usage_is_estimated_and_marked() -> None:
    fake_openai = _FakeOpenAIClient([_sdk_chunk(content="Hello there"), _sdk_chunk(finish_reason="stop")])
    client = OpenAIChatCompletionsModelClient(api_key="sk-test", client=fake_openai)  # type: ignore[arg-type]

    deltas = await _collect(client.stream(_spec(connection=_owner_connection("huggingface"))))

    final = _public_deltas(deltas)[-2].final
    assert final is not None
    assert final.raw_provider_metadata["usage_missing"] is True
    assert final.raw_provider_metadata["usage_estimated"] is True
    assert final.usage.output_tokens == 3
    assert final.usage.input_tokens > 0
    assert final.usage.total_tokens == final.usage.input_tokens + final.usage.output_tokens

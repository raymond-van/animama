"""The ChatGPT plan model client: what a plan request carries, and how the route's answers are read (Phase 5).

These tests drive the real OpenAI SDK through a mock HTTP transport, so they
see the request exactly as it would leave the machine.
"""

from __future__ import annotations

import base64
import json
from dataclasses import replace
from typing import Any

import httpx2
import pytest

from animama.adapters.model_clients import MockModelClient
from animama.adapters.model_clients.openai_responses import ChatGPTPlanResponsesModelClient, OpenAIResponsesModelClient
from animama.adapters.model_clients.openai_responses.routes import CHATGPT_PLAN_ROUTE
from animama.app.chat.api_standard import CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE
from animama.app.chat.direct_turn.provider_state import hosted_native_tools
from animama.app.chat.options import DirectChatOptions
from animama.app.model_clients import (
    MODEL_CLIENT_TOOL_CALL_ITEM_TYPE,
    MODEL_CLIENT_TOOL_RESULT_ITEM_TYPE,
    DirectChatPrompt,
    ModelClientContinuation,
    ModelClientProviderError,
    ModelClientProviderOptions,
    ModelClientRequest,
    StaticModelClientRegistry,
    uses_native_context_compaction,
)
from animama.app.model_clients.credentials import builtin_chatgpt_plan_connection
from animama.app.model_clients.error_categories import model_error_category
from animama.app.model_clients.image_parts import ModelClientImage, image_part
from animama.app.model_clients.limits import ModelCallLimits
from animama.app.ports.chatgpt_plan_port import PlanModelListing
from animama.app.services.chatgpt_plan_models import plan_model_row
from animama.app.services.direct_model_prompt_runner import DirectModelPromptRequest, DirectModelPromptRunner
from animama.app.services.model_role_resolver import ModelRoleDefaults, ModelRoleResolver
from animama.domain import ModelProvider
from animama.domain.chatgpt_plan import ChatGPTPlanUnavailableError
from animama.server.model_clients import build_model_client_registry

FIRST_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmaXJzdCJ9.Zmlyc3Q"
SECOND_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzZWNvbmQifQ.c2Vjb25k"
RESPONSES_URL = "https://api.openai.com/v1/responses"


class _Session:
    """The session as the client sees it, steered by the test."""

    def __init__(self) -> None:
        self.tokens = [FIRST_TOKEN, SECOND_TOKEN]
        self.unavailable: str | None = None
        self.refused: list[str] = []
        self.purposes: list[str] = []
        self.paused = False
        self.successes = 0

    async def access_token(self, purpose: str) -> str:
        self.purposes.append(purpose)
        if self.unavailable is not None:
            raise ChatGPTPlanUnavailableError(self.unavailable)
        return self.tokens[0]

    async def refresh_rejected(self, stale_access_token: str, purpose: str) -> str:
        self.purposes.append(purpose)
        self.refused.append(stale_access_token)
        self.tokens.pop(0)
        return self.tokens[0]

    async def record_usage_limit(self) -> None:
        self.paused = True

    async def record_interactive_success(self) -> None:
        self.paused = False
        self.successes += 1


class _Route:
    """OpenAI's side: answers in order, and every request it saw."""

    def __init__(self, *answers: httpx2.Response) -> None:
        self.answers = list(answers)
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        return self.answers.pop(0)

    def body(self, index: int = 0) -> dict[str, Any]:
        body: dict[str, Any] = json.loads(self.requests[index].content)
        return body


def _sse(*events: dict[str, Any]) -> httpx2.Response:
    numbered = [{"sequence_number": index, **event} for index, event in enumerate(events)]
    text = "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in numbered)
    return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=text.encode())


def _message(text: str = "Hello") -> dict[str, Any]:
    return {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": text, "annotations": []}],
    }


def _function_call(call_id: str = "call_1", name: str = "memory_read") -> dict[str, Any]:
    return {
        "id": f"fc_{call_id}",
        "type": "function_call",
        "call_id": call_id,
        "name": name,
        "namespace": "animama",
        "arguments": "{}",
        "status": "completed",
    }


def _reasoning(item_id: str = "rs_1") -> dict[str, Any]:
    return {"id": item_id, "type": "reasoning", "summary": [], "encrypted_content": f"sealed-{item_id}"}


def _completed(output: list[dict[str, Any]], *, done_items: bool = True) -> httpx2.Response:
    """A stream that lists ``output`` as done events, then ends with a terminal event listing nothing.

    That is how the plan's route ended a hosted-search response in the Phase 0 trial.
    """

    events: list[dict[str, Any]] = [{"type": "response.metadata", "metadata": {"opaque": True}}]
    if done_items:
        events += [
            {"type": "response.output_item.done", "output_index": index, "item": item}
            for index, item in enumerate(output)
        ]
    events.append(
        {
            "type": "response.completed",
            "response": {
                "id": "resp_1",
                "object": "response",
                "created_at": 1,
                "model": "gpt-6-luna",
                "status": "completed",
                "output": [] if done_items else output,
                "parallel_tool_calls": False,
                "tool_choice": "auto",
                "tools": [],
                "usage": {
                    "input_tokens": 10,
                    "input_tokens_details": {"cached_tokens": 0},
                    "output_tokens": 2,
                    "output_tokens_details": {"reasoning_tokens": 0},
                    "total_tokens": 12,
                },
            },
        }
    )
    return _sse(*events)


def _error(status: int, body: dict[str, Any]) -> httpx2.Response:
    return httpx2.Response(status, json=body)


def _row(**listing: Any) -> ModelProvider:
    values: dict[str, Any] = {
        "slug": "gpt-6-luna",
        "display_name": "GPT-6 Luna",
        "listed": True,
        "context_window": 272_000,
        "input_modalities": ("text", "image"),
        "reasoning_efforts": ("low", "high"),
        "supports_search": True,
        **listing,
    }
    return replace(plan_model_row(PlanModelListing(**values)), connection=builtin_chatgpt_plan_connection())


def _memory_tool() -> dict[str, Any]:
    return {
        "type": "function",
        "function": {"name": "memory_read", "description": "Read a memory.", "parameters": {"type": "object"}},
    }


def _spec(
    *,
    row: ModelProvider | None = None,
    messages: tuple[dict[str, Any], ...] | None = None,
    continuation: ModelClientContinuation | None = None,
    native_tools: tuple[str, ...] = (),
) -> ModelClientRequest:
    return ModelClientRequest(
        model_provider=row or _row(),
        prompt=DirectChatPrompt(
            messages=messages
            or (
                {"role": "system", "content": "Be Lumi."},
                {"role": "user", "content": "Earlier question"},
                {"role": "assistant", "content": "Earlier answer"},
                {"role": "system", "content": "A later system note."},
                {"role": "user", "content": "hello"},
            ),
            tools=(_memory_tool(),),  # type: ignore[arg-type]
            tool_choice="auto",
            parallel_tool_calls=False,
            reasoning_effort="low",
            prompt_cache_key="cache-key",
        ),
        provider_options=ModelClientProviderOptions(
            native_tools=native_tools, store=True, memory_apply_patch_enabled=True, moderation_model="omni-moderation"
        ),
        continuation=continuation,
    )


def _client(route: _Route, session: _Session) -> ChatGPTPlanResponsesModelClient:
    return ChatGPTPlanResponsesModelClient(session=lambda: session, transport=httpx2.MockTransport(route))


async def _run(client: ChatGPTPlanResponsesModelClient, spec: ModelClientRequest) -> list[Any]:
    try:
        return [delta async for delta in client.stream(spec)]
    finally:
        await client.aclose()


def _final(deltas: list[Any]) -> Any:
    return next(delta.final for delta in deltas if delta.kind == "final")


async def test_a_plan_request_carries_only_what_the_route_takes(monkeypatch: pytest.MonkeyPatch) -> None:
    """The acceptance test for the plan's request (Phase 5 step 5): it is unstored and sends nothing refused."""

    # The SDK would add these to every client it builds; none may reach the plan's route.
    monkeypatch.setenv("OPENAI_ORG_ID", "org-env")
    monkeypatch.setenv("OPENAI_PROJECT_ID", "proj-env")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://proxy.example.test/v1")
    monkeypatch.setenv("OPENAI_CUSTOM_HEADERS", "Authorization: Bearer env-key\nX-Env-Header: leaked")
    route, session = _Route(_completed([_message()])), _Session()
    stale_cursor = ModelClientContinuation(provider_type="OpenAIResponsesHTTPAgent", cursor="resp_previous")
    spec = replace(
        _spec(
            native_tools=("web_search", "apply_patch"),
            continuation=stale_cursor,
            messages=(
                {"role": "system", "content": "Be Lumi."},
                {"role": "system", "content": "A later system note."},
                {"role": "user", "content": "hello"},
                {
                    "type": MODEL_CLIENT_TOOL_CALL_ITEM_TYPE,
                    "call_id": "call_1",
                    "tool_type": "function",
                    "name": "memory_read",
                    "arguments": "{}",
                },
                {
                    "type": MODEL_CLIENT_TOOL_RESULT_ITEM_TYPE,
                    "call_id": "call_1",
                    "tool_type": "function",
                    "status": "completed",
                    "output": "nothing saved",
                },
            ),
        ),
        limits=ModelCallLimits(max_output_tokens=500, timeout_seconds=30, max_native_tool_calls=2),
    )

    deltas = await _run(_client(route, session), spec)

    assert _final(deltas).text == "Hello"
    assert [str(request.url) for request in route.requests] == [RESPONSES_URL]
    headers = route.requests[0].headers
    assert headers["authorization"] == f"Bearer {FIRST_TOKEN}"
    assert not {"openai-organization", "openai-project", "x-env-header"} & {name.lower() for name in headers}
    body = route.body()
    assert body["store"] is False and body["stream"] is True
    for refused in (
        "previous_response_id",
        "max_output_tokens",
        "max_tool_calls",
        "moderation",
        "metadata",
        "context_management",
        "include",
    ):
        assert refused not in body, refused
    assert body["instructions"] == "Be Lumi."
    assert body["input"] == [
        {"role": "developer", "content": "A later system note."},
        {"role": "user", "content": "hello"},
        {
            "type": "function_call",
            "call_id": "call_1",
            "name": "memory_read",
            "arguments": "{}",
            "status": "completed",
            "namespace": "animama",
        },
        {"type": "function_call_output", "call_id": "call_1", "output": "nothing saved"},
    ]
    # Hosted search where the row supports it; never apply_patch; functions inside one namespace.
    assert [tool["type"] for tool in body["tools"]] == ["web_search", "namespace"]
    namespace = body["tools"][1]
    assert namespace["name"] == "animama"
    assert [tool["name"] for tool in namespace["tools"]] == ["memory_read"]
    assert body["reasoning"] == {"effort": "low"} and body["prompt_cache_key"] == "cache-key"
    assert session.purposes == ["interactive"]


async def test_a_key_model_s_native_memory_edit_is_not_replayed_to_the_plan() -> None:
    """R3.6: the route refuses `apply_patch`, so a chat moving from a key model leaves its edits out.

    The edit is already applied and the reply after it stays in the history.
    """

    patch = '{"type": "update_file", "path": "MEMORIES.md", "diff": "+likes tea"}'
    route = _Route(_completed([_message()]))
    spec = _spec(
        messages=(
            {"role": "system", "content": "Be Lumi."},
            {"role": "user", "content": "Remember that I like tea."},
            {
                "type": MODEL_CLIENT_TOOL_CALL_ITEM_TYPE,
                "call_id": "patch_1",
                "tool_type": "apply_patch",
                "name": "apply_patch",
                "arguments": patch,
            },
            {
                "type": MODEL_CLIENT_TOOL_RESULT_ITEM_TYPE,
                "call_id": "patch_1",
                "tool_type": "apply_patch",
                "status": "completed",
                "output": "Updated MEMORIES.md",
            },
            {"role": "assistant", "content": "I'll remember that."},
            {"role": "user", "content": "What do I like?"},
        )
    )

    await _run(_client(route, _Session()), spec)

    kinds = [item.get("type", item.get("role")) for item in route.body()["input"]]
    assert kinds == ["user", "assistant", "user"]


async def test_the_reply_comes_from_done_events_when_the_terminal_event_lists_none() -> None:
    route, session = _Route(_completed([_function_call(), _message("Let me look.")])), _Session()
    session.paused = True

    deltas = await _run(_client(route, session), _spec())

    final = _final(deltas)
    assert final.text == "Let me look."
    # The call's name comes back as declared; the namespace stays beside it.
    assert [(call.id, call.name) for call in final.tool_calls] == [("call_1", "memory_read")]
    assert final.raw_provider_metadata["provider"] == CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE
    assert final.continuation is None
    # A success clears a usage-limit pause.
    assert session.paused is False and session.successes == 1


async def test_a_terminal_event_with_items_is_used_as_it_is() -> None:
    route, session = _Route(_completed([_message("From the terminal event.")], done_items=False)), _Session()

    assert _final(await _run(_client(route, session), _spec())).text == "From the terminal event."


async def test_a_refused_token_is_renewed_once_before_any_output() -> None:
    route = _Route(
        _error(401, {"error": {"message": "expired", "type": "invalid_request_error"}}), _completed([_message()])
    )
    session = _Session()

    deltas = await _run(_client(route, session), _spec())

    assert _final(deltas).text == "Hello"
    assert [request.headers["authorization"] for request in route.requests] == [
        f"Bearer {FIRST_TOKEN}",
        f"Bearer {SECOND_TOKEN}",
    ]
    assert session.refused == [FIRST_TOKEN]


async def test_a_second_refusal_asks_for_sign_in_without_a_third_request() -> None:
    refused = {"error": {"message": "no", "code": "subscription_sharing_invalid_user"}}
    route, session = _Route(_error(401, refused), _error(401, refused)), _Session()

    with pytest.raises(ModelClientProviderError) as failed:
        await _run(_client(route, session), _spec())

    assert failed.value.code == "chatgpt_plan_sign_in_required"
    assert model_error_category(failed.value.code, failed.value.raw_metadata) == "sign_in_required"
    assert len(route.requests) == 2


@pytest.mark.parametrize(
    ("status", "body", "code", "category", "requests"),
    [
        (
            429,
            {"error": {"message": "limit", "code": "subscription_sharing_usage_limit_exceeded"}},
            "chatgpt_plan_usage_limit",
            "usage_limit",
            1,
        ),
        (
            403,
            {"error": {"message": "no", "code": "subscription_sharing_user_not_eligible"}},
            "chatgpt_plan_not_eligible",
            "not_eligible",
            1,
        ),
        (
            403,
            {"error": {"message": "no", "code": "subscription_sharing_route_not_supported"}},
            "chatgpt_plan_unsupported_request",
            "bad_request",
            1,
        ),
        (400, {"detail": "Unsupported tool type: apply_patch"}, "chatgpt_plan_unsupported_request", "bad_request", 1),
        # A temporary outage is retried twice with backoff (R5.3).
        (
            503,
            {"error": {"message": "busy", "code": "subscription_sharing_usage_unavailable"}},
            "chatgpt_plan_unavailable",
            "server_error",
            3,
        ),
        # An oversized prompt keeps the code the executor recognizes.
        (
            400,
            {"error": {"message": "too long", "code": "context_length_exceeded"}},
            "openai_bad_request",
            "context_exceeded",
            1,
        ),
    ],
)
async def test_plan_errors_become_codes_the_app_explains(
    status: int, body: dict[str, Any], code: str, category: str, requests: int, waits: list[float]
) -> None:
    route, session = _Route(*[_error(status, body) for _ in range(requests)]), _Session()

    with pytest.raises(ModelClientProviderError) as failed:
        await _run(_client(route, session), _spec())

    assert failed.value.code == code
    assert model_error_category(failed.value.code, failed.value.raw_metadata) == category
    assert len(route.requests) == requests
    assert session.paused is (code == "chatgpt_plan_usage_limit")


def _failed_stream(error: dict[str, Any], *, text_first: bool) -> httpx2.Response:
    """A plan stream that fails with ``error`` in ``response.failed``, after some text when ``text_first``."""

    response = {
        "id": "resp_1",
        "object": "response",
        "created_at": 1,
        "model": "gpt-6-luna",
        "output": [],
        "parallel_tool_calls": False,
        "tool_choice": "auto",
        "tools": [],
    }
    events: list[dict[str, Any]] = [{"type": "response.created", "response": {**response, "status": "in_progress"}}]
    if text_first:
        events.append(
            {
                "type": "response.output_text.delta",
                "item_id": "msg_1",
                "output_index": 0,
                "content_index": 0,
                "delta": "Hel",
                "logprobs": [],
            }
        )
    events.append({"type": "response.failed", "response": {**response, "status": "failed", "error": error}})
    return _sse(*events)


@pytest.mark.parametrize(
    "answer",
    [
        _failed_stream(
            {"code": "subscription_sharing_usage_limit_exceeded", "message": f"Limit for {FIRST_TOKEN}"},
            text_first=False,
        ),
        _failed_stream(
            {"code": "subscription_sharing_usage_limit_exceeded", "message": f"Limit for {FIRST_TOKEN}"},
            text_first=True,
        ),
        _sse(
            {
                "type": "error",
                "error": {
                    "code": "subscription_sharing_usage_limit_exceeded",
                    "type": "usage_limit",
                    "message": f"Limit for {FIRST_TOKEN}",
                },
            }
        ),
    ],
    ids=["failed-before-text", "failed-after-text", "error-event"],
)
async def test_a_usage_limit_inside_the_stream_pauses_background_use(
    answer: httpx2.Response, waits: list[float]
) -> None:
    """OpenAI can report a limit after the stream begins (MR-R1-F1): the plan's code still wins over #923's."""

    route, session = _Route(answer), _Session()

    with pytest.raises(ModelClientProviderError) as failed:
        await _run(_client(route, session), _spec())

    assert failed.value.code == "chatgpt_plan_usage_limit"
    assert session.paused is True
    assert len(route.requests) == 1
    assert FIRST_TOKEN not in json.dumps(failed.value.raw_metadata, default=str) + str(failed.value)


@pytest.fixture
def waits(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """The client's retry waits, recorded instead of slept."""

    import asyncio

    recorded: list[float] = []
    real_sleep = asyncio.sleep

    async def record(delay: float, *args: Any, **kwargs: Any) -> Any:
        if delay > 0:
            recorded.append(delay)
            delay = 0
        return await real_sleep(delay, *args, **kwargs)

    monkeypatch.setattr(asyncio, "sleep", record)
    return recorded


async def test_a_temporary_failure_is_retried_with_bounded_backoff(waits: list[float]) -> None:
    """R5.3: twice more, after one and then two seconds, and then the failure is reported."""

    busy = {"error": {"message": "busy", "code": "subscription_sharing_usage_unavailable"}}
    route, session = _Route(*[_error(503, busy) for _ in range(3)]), _Session()

    with pytest.raises(ModelClientProviderError) as failed:
        await _run(_client(route, session), _spec())

    assert failed.value.code == "chatgpt_plan_unavailable"
    assert len(route.requests) == 3 and waits == [1.0, 2.0]


async def test_a_temporary_failure_waits_as_long_as_openai_asks_within_a_bound(waits: list[float]) -> None:
    busy = {"error": {"message": "busy", "code": "subscription_sharing_user_unavailable"}}
    soon = httpx2.Response(503, json=busy, headers={"retry-after": "5"})
    later = httpx2.Response(503, json=busy, headers={"retry-after": "120"})

    recovered = _Route(soon, _completed([_message()]))
    assert _final(await _run(_client(recovered, _Session()), _spec())).text == "Hello"
    assert waits == [5.0]

    waits.clear()
    refused = _Route(later)
    with pytest.raises(ModelClientProviderError) as failed:
        await _run(_client(refused, _Session()), _spec())
    # A long wait is reported, not slept through.
    assert len(refused.requests) == 1 and waits == []
    assert failed.value.raw_metadata["retry_after_seconds"] == 120.0


async def test_an_unsupported_request_reports_the_route_s_detail_without_tokens() -> None:
    detail = f"Rejected {FIRST_TOKEN} and eyJraWQiOiJ4In0.eyJvdGhlciI6dHJ1ZX0.c2ln for System messages"
    route, session = _Route(_error(400, {"detail": detail})), _Session()

    with pytest.raises(ModelClientProviderError) as failed:
        await _run(_client(route, session), _spec())

    message = failed.value.raw_metadata["provider_error_message"]
    assert "System messages" in message
    assert "eyJ" not in message and FIRST_TOKEN not in repr(failed.value.raw_metadata)


async def test_no_failure_path_logs_a_token(caplog: pytest.LogCaptureFixture, waits: list[float]) -> None:
    caplog.set_level("DEBUG")
    refused = {"error": {"message": f"Bearer {FIRST_TOKEN} refused", "code": "subscription_sharing_invalid_user"}}
    answers = [
        _Route(_error(401, refused), _error(401, refused)),
        _Route(_error(400, {"detail": f"bad request for {FIRST_TOKEN}"})),
        _Route(*[_error(503, {"error": {"code": "subscription_sharing_usage_unavailable"}}) for _ in range(3)]),
        _Route(_error(429, {"error": {"code": "subscription_sharing_usage_limit_exceeded"}})),
    ]
    for route in answers:
        with pytest.raises(ModelClientProviderError) as failed:
            await _run(_client(route, _Session()), _spec())
        assert FIRST_TOKEN not in repr(failed.value.raw_metadata) and SECOND_TOKEN not in str(failed.value)

    assert caplog.records, "the failure paths log"
    assert FIRST_TOKEN not in caplog.text and SECOND_TOKEN not in caplog.text


@pytest.mark.parametrize(
    ("state", "code"),
    [
        ("not_signed_in", "chatgpt_plan_sign_in_required"),
        ("sign_in_required", "chatgpt_plan_sign_in_required"),
        ("plan_use_not_granted", "chatgpt_plan_use_not_granted"),
        ("temporarily_unavailable", "chatgpt_plan_unavailable"),
    ],
)
async def test_nothing_is_sent_without_a_usable_session(state: str, code: str) -> None:
    route, session = _Route(), _Session()
    session.unavailable = state

    with pytest.raises(ModelClientProviderError) as failed:
        await _run(_client(route, session), _spec())

    assert failed.value.code == code and route.requests == []


async def test_a_row_on_another_connection_gets_no_plan_token() -> None:
    route, session = _Route(), _Session()
    elsewhere = replace(_row(), connection_id="openai", connection=None)

    with pytest.raises(ModelClientProviderError) as failed:
        await _run(_client(route, session), _spec(row=elsewhere))

    assert failed.value.code == "responses_connection_unsupported"
    assert route.requests == [] and session.purposes == []


async def test_a_redirect_is_not_followed() -> None:
    route = _Route(httpx2.Response(307, headers={"location": "https://elsewhere.example.test/v1/responses"}))

    with pytest.raises(ModelClientProviderError):
        await _run(_client(route, _Session()), _spec())

    assert [request.url.host for request in route.requests] == ["api.openai.com"]


@pytest.mark.parametrize(("supports_search", "tools"), [(True, ["web_search", "namespace"]), (False, ["namespace"])])
async def test_hosted_search_follows_the_row_s_listing(supports_search: bool, tools: list[str]) -> None:
    """The turn asks for web search; the plan row's listing decides whether OpenAI's search is declared (D8)."""

    row = _row(supports_search=supports_search)
    hosted = hosted_native_tools(row, DirectChatOptions(native_tools=("web_search",)))
    route = _Route(_completed([_message()]))

    await _run(_client(route, _Session()), _spec(row=row, native_tools=hosted))

    assert [tool["type"] for tool in route.body()["tools"]] == tools


def _with_reasoning_replay(client: ChatGPTPlanResponsesModelClient) -> ChatGPTPlanResponsesModelClient:
    client._route = replace(CHATGPT_PLAN_ROUTE, replay_reasoning=True)  # noqa: SLF001
    return client


def _round_two(continuation: ModelClientContinuation | None) -> ModelClientRequest:
    return _spec(
        continuation=continuation,
        messages=(
            {"role": "system", "content": "Be Lumi."},
            {"role": "user", "content": "hello"},
            {
                "type": MODEL_CLIENT_TOOL_CALL_ITEM_TYPE,
                "call_id": "call_1",
                "tool_type": "function",
                "name": "memory_read",
                "arguments": "{}",
            },
            {
                "type": MODEL_CLIENT_TOOL_RESULT_ITEM_TYPE,
                "call_id": "call_1",
                "tool_type": "function",
                "status": "completed",
                "output": "nothing saved",
            },
        ),
    )


async def test_with_reasoning_replay_on_a_round_s_reasoning_goes_back_before_its_call() -> None:
    first = _Route(_completed([_reasoning(), _function_call()]))
    deltas = await _run(_with_reasoning_replay(_client(first, _Session())), _spec())
    continuation = _final(deltas).continuation
    assert first.body()["include"] == ["reasoning.encrypted_content"]
    assert continuation is not None and continuation.provider_type == CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE

    second = _Route(_completed([_message()]))
    await _run(_with_reasoning_replay(_client(second, _Session())), _round_two(continuation))

    types = [item.get("type", item.get("role")) for item in second.body()["input"]]
    assert types == ["user", "reasoning", "function_call", "function_call_output"]
    assert second.body()["input"][1] == {
        "type": "reasoning",
        "id": "rs_1",
        "summary": [],
        "encrypted_content": "sealed-rs_1",
    }


async def test_with_reasoning_replay_off_a_round_replays_calls_and_outputs_only() -> None:
    first = _Route(_completed([_reasoning(), _function_call()]))
    deltas = await _run(_client(first, _Session()), _spec())
    assert _final(deltas).continuation is None
    carried = ModelClientContinuation(
        provider_type=CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE,
        cursor=json.dumps([{"call_id": "call_1", "item": _reasoning()}]),
    )

    second = _Route(_completed([_message()]))
    await _run(_client(second, _Session()), _round_two(carried))

    assert "include" not in first.body()
    types = [item.get("type", item.get("role")) for item in second.body()["input"]]
    assert types == ["user", "function_call", "function_call_output"]


async def test_a_utility_prompt_completes_on_a_plan_model() -> None:
    """Phase 5 step 8: a feature that picks its own model can run on a plan row."""

    row = _row()
    route, session = _Route(_completed([_message("Garden Planning")])), _Session()
    registry = StaticModelClientRegistry()
    registry.register(CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE, _client(route, session))

    class _Rows:
        async def get(self, model_provider_id: str) -> ModelProvider | None:
            return row if model_provider_id == row.id else None

    class _NoPreferences:
        async def get(self, user_id: str) -> None:
            return None

    runner = DirectModelPromptRunner(
        registry=registry,
        role_resolver=ModelRoleResolver(
            model_providers=_Rows(),  # type: ignore[arg-type]
            user_settings=_NoPreferences(),  # type: ignore[arg-type]
            defaults=ModelRoleDefaults(chat=row.id),
            owner_roles_enabled=True,
        ),
    )
    try:
        result = await runner.run_prompt(
            DirectModelPromptRequest(
                anima_id="anima-1", user_id="owner", chat_id="chat-1", prompt="Name this chat.", task="chat_title"
            )
        )
    finally:
        await registry.aclose()

    assert result.text == "Garden Planning" and result.model_provider.id == row.id
    assert route.body()["store"] is False and session.purposes == ["interactive"]


async def test_a_plan_turn_s_stream_and_logs_carry_no_token(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Acceptance line 2 (FI-R1-F2): a plan turn through `chat:sse`, on success and on a refusal.

    Neither the stream, the logs nor the turn recorded for the chat's rows carries a token.
    """

    from animama.domain.request_principal import RequestPrincipal
    from tests import test_anima_chat_sse as chat_route

    caplog.set_level("DEBUG")
    provider = chat_route._model_provider(  # noqa: SLF001
        model_provider_id="ChatGPTPlanResponsesHTTPAgent:gpt-6-luna", provider_type=CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE
    )
    provider.connection_id = "chatgpt_plan"
    reply = chat_route._direct_structured_response()  # noqa: SLF001
    for answer, expected_event in (
        (_completed([_message(reply)]), "event: user.response"),
        (_error(400, {"detail": f"Refused for {FIRST_TOKEN}"}), "event: error"),
    ):
        session, plan_route = _Session(), _Route(answer)
        chats = chat_route._FakeChatManager()  # noqa: SLF001
        chat_route._install_route_mocks(  # noqa: SLF001
            monkeypatch,
            model_client=_client(plan_route, session),  # type: ignore[arg-type]
            model_provider=provider,
            chat_manager=chats,
        )
        response = await chat_route.chat_anima_direct_sse(
            "anima-1",
            chat_route._chat_request(message="hello", run_id="run-1", chat_id="chat-1"),  # noqa: SLF001
            request=chat_route._test_request(),  # noqa: SLF001
            user=RequestPrincipal(id="user-1"),
        )
        stream = "".join(await chat_route._collect_chunks(response))  # noqa: SLF001
        # The turn reached the plan route, with the token, and the stream still carries none.
        assert [request.headers["authorization"] for request in plan_route.requests] == [f"Bearer {FIRST_TOKEN}"]
        assert expected_event in stream
        assert FIRST_TOKEN not in stream and SECOND_TOKEN not in stream
        # What the chat's rows are written from, provider metadata included.
        if expected_event == "event: user.response":
            assert chats.record_turn_calls == 1
        recorded = repr(chats.record_turn_payloads)
        assert FIRST_TOKEN not in recorded and SECOND_TOKEN not in recorded
    assert FIRST_TOKEN not in caplog.text and SECOND_TOKEN not in caplog.text


async def test_a_plan_request_carries_chat_images_as_the_route_takes_them() -> None:
    """Chat images (#923) on the plan's route: data URL parts, replayed history, no cache breakpoints."""

    images = {
        "earlier": ModelClientImage(media_type="image/png", content=b"earlier png"),
        "now": ModelClientImage(media_type="image/jpeg", content=b"current jpeg"),
    }
    row = _row()
    assert row.accepts_images and not _row(input_modalities=("text",)).accepts_images

    def user(file_id: str, text: str) -> dict[str, Any]:
        part = image_part(file_id=file_id, name=f"{file_id}.png", width=40, height=20)
        return {"role": "user", "content": [part, {"type": "text", "text": text}]}

    def data_url(file_id: str) -> str:
        image = images[file_id]
        return f"data:{image.media_type};base64,{base64.b64encode(image.content).decode('ascii')}"

    spec = replace(
        _spec(
            row=row,
            messages=(
                {"role": "system", "content": "Be Lumi."},
                user("earlier", "What is this?"),
                {"role": "assistant", "content": "A cat."},
                user("now", "And this?"),
            ),
        ),
        images=images,
    )
    route, session = _Route(_completed([_message()])), _Session()

    await _run(_client(route, session), spec)

    body = route.body()
    assert body["store"] is False and body["stream"] is True and "previous_response_id" not in body
    # With no cursor the whole history goes again, the earlier image included.
    sent = [item["content"] for item in body["input"] if item.get("role") == "user"]
    assert sent == [
        [
            {"type": "input_image", "image_url": data_url("earlier"), "detail": "auto"},
            {"type": "input_text", "text": "What is this?"},
        ],
        [
            {"type": "input_image", "image_url": data_url("now"), "detail": "auto"},
            {"type": "input_text", "text": "And this?"},
        ],
    ]
    # Explicit cache breakpoints are sent only on the key route.
    assert "prompt_cache_breakpoint" not in json.dumps(body)


def test_a_plan_chat_fits_its_context_to_the_row_s_window() -> None:
    """The route takes no server compaction, so the executor fits the prompt itself (Phase 6 step 1)."""

    assert uses_native_context_compaction(ChatGPTPlanResponsesModelClient(session=_Session)) is False
    assert uses_native_context_compaction(OpenAIResponsesModelClient(api_key="sk-test")) is True


def test_the_registry_has_a_plan_client_only_where_the_composition_supplies_a_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    without = build_model_client_registry()
    with_session = build_model_client_registry(chatgpt_plan_session=_Session)
    monkeypatch.setenv("ANIMAMA_LLM_SKIP", "1")
    skipped = build_model_client_registry()

    assert without.get(CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE) is None
    assert isinstance(with_session.get(CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE), ChatGPTPlanResponsesModelClient)
    assert isinstance(skipped.get(CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE), MockModelClient)

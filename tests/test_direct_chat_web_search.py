"""Application web search in direct chat turns (configurable models Plan B, R11)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from animama.app.model_clients import ModelClientFinal, ModelClientToolCall
from animama.app.web_search import WebSearchError, WebSearchToolService
from animama.domain.events import EventType
from animama.domain.usage import Usage
from animama.domain.web_search import WebSearchResult
from tests.test_direct_chat_turn_executor import (
    _collect,
    _executor,
    _FakeChatManager,
    _FakeMemoryToolService,
    _provider,
    _request,
    _ScriptedModelClient,
    _structured_response,
)


class _Backend:
    def __init__(self, error: WebSearchError | None = None) -> None:
        self.error = error
        self.queries: list[str] = []

    async def search(self, query: str, *, count: int) -> list[WebSearchResult]:
        self.queries.append(query)
        if self.error is not None:
            raise self.error
        return [WebSearchResult(title="Forecast", url="https://weather.example", snippet="Sunny and 22 degrees.")]


def _search_call(query: str = "weather today") -> ModelClientFinal:
    return ModelClientFinal(
        text="",
        usage=Usage(requests=1, total_tokens=5),
        tool_calls=(ModelClientToolCall(id="call-1", name="web_search", arguments=json.dumps({"query": query})),),
    )


def _reply(speech: str = "It will be sunny.") -> ModelClientFinal:
    return ModelClientFinal(text=_structured_response(speech=speech), usage=Usage(requests=1, total_tokens=5))


def _tool_names(spec: Any) -> list[str]:
    return [tool["function"]["name"] for tool in spec.prompt.tools if tool.get("type") == "function"]


def _with_search(executor: Any, backend: _Backend) -> Any:
    executor._web_search_tool = WebSearchToolService(backend)
    return executor


def _statuses(events: list[Any]) -> list[tuple[str, str]]:
    return [(event.payload.status, event.payload.phase) for event in events if event.type == EventType.RUN_STATUS]


@pytest.mark.asyncio
async def test_a_chat_completions_model_searches_the_web_and_answers() -> None:
    backend = _Backend()
    client = _ScriptedModelClient([_search_call(), _reply()])
    executor, chats = _executor(client=client, memory_tool_service=_FakeMemoryToolService())
    _with_search(executor, backend)

    events = await _collect(executor.stream_turn(_request(request_options={"native_tools": ["web_search"]})))

    first, follow_up = client.seen_specs
    assert "web_search" in _tool_names(first)
    assert first.provider_options.native_tools == ()
    assert backend.queries == ["weather today"]
    tool_message = next(m for m in follow_up.prompt.messages if m.get("role") == "tool")
    assert json.loads(str(tool_message["content"]))["results"][0]["snippet"] == "Sunny and 22 degrees."
    assert _statuses(events) == [("searching_web", "started"), ("searching_web", "finished")]
    assert EventType.ERROR not in [event.type for event in events]
    # History keeps the query, titles and URLs, not the snippets.
    rows = chats.record_turn_calls[0]["assistant_msg"]
    persisted = json.loads(rows[1].raw_provider_message["content"])
    assert persisted["results"] == [{"title": "Forecast", "url": "https://weather.example"}]
    assert "Sunny" not in json.dumps(rows[1].raw_provider_message)


@pytest.mark.asyncio
async def test_a_backend_failure_is_a_tool_error_and_the_turn_completes() -> None:
    backend = _Backend(error=WebSearchError("down", category="unreachable"))
    client = _ScriptedModelClient([_search_call(), _reply("I could not look that up.")])
    executor, chats = _executor(client=client)
    _with_search(executor, backend)

    events = await _collect(executor.stream_turn(_request(request_options={"native_tools": ["web_search"]})))

    tool_message = next(m for m in client.seen_specs[1].prompt.messages if m.get("role") == "tool")
    assert json.loads(str(tool_message["content"]))["code"] == "web_search_unreachable"
    assert EventType.ERROR not in [event.type for event in events]
    assert len(chats.record_turn_calls) == 1


@pytest.mark.asyncio
async def test_turns_without_memory_tools_can_still_search() -> None:
    client = _ScriptedModelClient([_reply()])
    executor, _chats = _executor(client=client, memory_tool_service=_FakeMemoryToolService())
    _with_search(executor, _Backend())

    options = {"native_tools": ["web_search"], "incognito": True, "disable_memory_influence": True}
    await _collect(executor.stream_turn(_request(request_options=options)))

    assert _tool_names(client.seen_specs[0]) == ["web_search"]
    assert client.seen_specs[0].prompt.tool_choice == "auto"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("configured", "provider"),
    [(False, _provider()), (True, _provider(supports_tools=False))],
)
async def test_unavailable_search_runs_the_turn_without_it(configured: bool, provider: Any) -> None:
    client = _ScriptedModelClient([_reply()])
    executor, _chats = _executor(client=client, provider=provider)
    if configured:
        _with_search(executor, _Backend())

    events = await _collect(executor.stream_turn(_request(request_options={"native_tools": ["web_search"]})))

    assert "web_search" not in _tool_names(client.seen_specs[0])
    assert EventType.ERROR not in [event.type for event in events]


@pytest.mark.asyncio
async def test_search_is_offered_only_when_requested() -> None:
    client = _ScriptedModelClient([_reply()])
    executor, _chats = _executor(client=client)
    _with_search(executor, _Backend())

    await _collect(executor.stream_turn(_request()))

    assert "web_search" not in _tool_names(client.seen_specs[0])


@pytest.mark.asyncio
async def test_responses_rows_keep_hosted_web_search() -> None:
    provider = _provider(provider_type="OpenAIResponsesHTTPAgent", native_tool_support=["web_search"])
    client = _ScriptedModelClient([_reply()])
    executor, _chats = _executor(client=client, provider=provider)
    _with_search(executor, _Backend())

    await _collect(executor.stream_turn(_request(request_options={"native_tools": ["web_search"]})))

    spec = client.seen_specs[0]
    assert spec.provider_options.native_tools == ("web_search",)
    assert "web_search" not in _tool_names(spec)


@pytest.mark.asyncio
async def test_a_later_turn_replays_only_the_query_titles_and_urls() -> None:
    backend = _Backend()
    first_client = _ScriptedModelClient([_search_call(), _reply()])
    executor, chats = _executor(client=first_client)
    _with_search(executor, backend)
    await _collect(executor.stream_turn(_request(request_options={"native_tools": ["web_search"]})))
    persisted_rows = chats.record_turn_calls[0]["assistant_msg"]

    replay_client = _ScriptedModelClient([_reply("Anything else?")])
    replay_executor, _chats = _executor(client=replay_client, chat_manager=_FakeChatManager(history=[*persisted_rows]))
    await _collect(replay_executor.stream_turn(_request(user_message="Thanks")))

    replayed = json.dumps(replay_client.seen_specs[0].prompt.messages)
    assert "https://weather.example" in replayed
    assert "Sunny and 22 degrees" not in replayed


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("model", "effort", "offered"),
    [
        ("gpt-5.4-mini", "low", False),
        ("gpt-6-luna", "low", False),
        ("gpt-6-luna", "none", True),
        ("gpt-6-luna", None, True),
        ("gpt-5-nano", "low", True),
    ],
)
async def test_search_is_left_out_where_function_tools_cannot_carry_reasoning(
    model: str, effort: str | None, offered: bool
) -> None:
    provider = _provider(model=model, supported_reasoning_efforts=["none", "low", "medium", "high"])
    client = _ScriptedModelClient([_reply()])
    executor, _chats = _executor(client=client, provider=provider)
    _with_search(executor, _Backend())
    request_options: dict[str, Any] = {"native_tools": ["web_search"]}
    if effort is not None:
        request_options["reasoning_effort"] = effort

    events = await _collect(executor.stream_turn(_request(request_options=request_options)))

    assert ("web_search" in _tool_names(client.seen_specs[0])) is offered
    assert EventType.ERROR not in [event.type for event in events]

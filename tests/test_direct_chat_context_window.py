"""Pre-send context-window handling for direct chat turns (configurable models Plan B, R10).

Models without provider-native compaction never receive a prompt larger than
their context window: the turn compacts first, then omits the oldest history,
and fails with ``context_exceeded`` only when the instructions and latest
message alone do not fit.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace
from typing import Any, cast

import pytest

from animama.app.chat.direct_turn.context_fit import fit_history
from animama.app.chat.direct_turn.types import PreSendCompactionRequest
from animama.app.model_clients import ModelClientError, ModelClientFinal, ModelClientToolCall
from animama.app.model_clients.context_budget import context_budget_for_model, estimate_prompt_tokens
from animama.app.model_clients.image_parts import image_file_ids, image_part
from animama.app.model_clients.prompt import prompt_messages
from animama.domain import ModelProvider
from animama.domain.chat import ChatMessage, MessageRole
from animama.domain.events import EventType
from animama.domain.usage import Usage
from tests.test_direct_chat_turn_executor import (
    _collect,
    _executor,
    _FakeChatManager,
    _FakeImageLoader,
    _FakeMemoryToolService,
    _history_message,
    _provider,
    _request,
    _ScriptedModelClient,
    _structured_response,
    _vision_provider,
)

_MAX_OUTPUT = 500


def _final(text: str = "", **kwargs: Any) -> ModelClientFinal:
    return ModelClientFinal(text=text or _structured_response(), usage=Usage(requests=1, total_tokens=5), **kwargs)


def _long_history(count: int = 40) -> list[ChatMessage]:
    return [
        _history_message(
            f"message {index} " + "words " * 60,
            role=MessageRole.USER if index % 2 == 0 else MessageRole.ASSISTANT,
            turn=index + 1,
        )
        for index in range(count)
    ]


async def _fixed_prompt_tokens(provider: ModelProvider, *, user_message: str = "Hi") -> int:
    """Measure the prompt with no history, as the executor estimates it."""

    client = _ScriptedModelClient([_final()])
    executor, _chats = _executor(client=client, provider=provider)
    await _collect(executor.stream_turn(_request(user_message=user_message)))
    return estimate_prompt_tokens(client.seen_specs[0].prompt)


async def _small_window_row(room_tokens: int = 1200, **overrides: Any) -> ModelProvider:
    base = _provider(**overrides)
    fixed = await _fixed_prompt_tokens(base)
    return replace(base, context_window_tokens=fixed + room_tokens + _MAX_OUTPUT, max_output_tokens=_MAX_OUTPUT)


def _available(provider: ModelProvider) -> int:
    budget = context_budget_for_model(provider)
    assert budget is not None
    return budget.available_tokens


def _statuses(events: list[Any]) -> list[tuple[str, str]]:
    return [(event.payload.status, event.payload.phase) for event in events if event.type == EventType.RUN_STATUS]


class _NativeCompactionClient(_ScriptedModelClient):
    """Asks its provider to compact long prompts, like Responses with a compaction threshold."""

    native_context_compaction = True


class _Compactor:
    def __init__(self, result: Any = None, *, fail: Exception | None = None, delay: float = 0.0) -> None:
        self.result = result
        self.fail = fail
        self.delay = delay
        self.calls: list[PreSendCompactionRequest] = []

    async def __call__(self, request: PreSendCompactionRequest) -> Any:
        self.calls.append(request)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail is not None:
            raise self.fail
        return self.result


@pytest.mark.asyncio
async def test_long_chat_compacts_before_sending_and_shows_the_summarizing_status() -> None:
    provider = await _small_window_row()
    recent = _long_history(4)[2:]
    compacted_context = SimpleNamespace(
        messages=recent,
        active_compaction=SimpleNamespace(summary_text="They planned a picnic.", end_turn=38),
    )
    compactor = _Compactor(compacted_context)
    client = _ScriptedModelClient([_final()])
    executor, _chats = _executor(
        client=client,
        provider=provider,
        chat_manager=_FakeChatManager(history=_long_history()),
        pre_send_compactor=compactor,
    )

    events = await _collect(executor.stream_turn(_request()))

    assert len(compactor.calls) == 1
    assert 0 < compactor.calls[0].keep_recent_tokens < _available(provider)
    assert _statuses(events) == [("summarizing_context", "started"), ("summarizing_context", "finished")]
    first_reply = next(index for index, event in enumerate(events) if event.type == EventType.USER_RESPONSE)
    assert max(index for index, event in enumerate(events) if event.type == EventType.RUN_STATUS) < first_reply
    prompt = client.seen_specs[0].prompt
    assert estimate_prompt_tokens(prompt) <= _available(provider)
    contents = [str(message.get("content")) for message in prompt_messages(prompt)]
    assert any("They planned a picnic." in content for content in contents)
    assert not any(content.startswith("message 0 ") for content in contents)


@pytest.mark.asyncio
async def test_failed_compaction_trims_the_oldest_history_and_continues() -> None:
    provider = await _small_window_row()
    client = _ScriptedModelClient([_final()])
    executor, chats = _executor(
        client=client,
        provider=provider,
        chat_manager=_FakeChatManager(history=_long_history()),
        pre_send_compactor=_Compactor(fail=RuntimeError("utility unreachable")),
    )

    events = await _collect(executor.stream_turn(_request()))

    assert EventType.ERROR not in [event.type for event in events]
    prompt = client.seen_specs[0].prompt
    assert estimate_prompt_tokens(prompt) <= _available(provider)
    contents = [str(message.get("content")) for message in prompt_messages(prompt)]
    assert any(content.startswith("message 39 ") for content in contents)
    assert not any(content.startswith("message 0 ") for content in contents)
    assert len(chats.record_turn_calls) == 1


@pytest.mark.asyncio
async def test_slow_compaction_times_out_and_trims() -> None:
    provider = await _small_window_row()
    client = _ScriptedModelClient([_final()])
    executor, _chats = _executor(
        client=client,
        provider=provider,
        chat_manager=_FakeChatManager(history=_long_history()),
        pre_send_compactor=_Compactor(delay=5),
    )
    executor._pre_send_compaction_timeout_seconds = 0.05

    events = await _collect(executor.stream_turn(_request()))

    assert _statuses(events)[-1] == ("summarizing_context", "finished")
    assert estimate_prompt_tokens(client.seen_specs[0].prompt) <= _available(provider)


@pytest.mark.asyncio
async def test_incognito_turns_trim_without_compacting() -> None:
    provider = await _small_window_row()
    compactor = _Compactor()
    client = _ScriptedModelClient([_final()])
    executor, _chats = _executor(
        client=client,
        provider=provider,
        chat_manager=_FakeChatManager(history=_long_history()),
        pre_send_compactor=compactor,
    )

    events = await _collect(executor.stream_turn(_request(request_options={"incognito": True})))

    assert compactor.calls == []
    assert _statuses(events) == []
    assert estimate_prompt_tokens(client.seen_specs[0].prompt) <= _available(provider)


@pytest.mark.asyncio
async def test_a_message_larger_than_the_window_fails_with_context_exceeded() -> None:
    provider = await _small_window_row(room_tokens=200)
    client = _ScriptedModelClient([_final()])
    executor, chats = _executor(client=client, provider=provider, pre_send_compactor=_Compactor())

    events = await _collect(executor.stream_turn(_request(user_message="long " * 2000)))

    assert [event.type for event in events] == [EventType.ERROR]
    assert events[0].payload.code == "context_window_exceeded"
    assert events[0].payload.details["category"] == "context_exceeded"
    assert client.seen_specs == []
    assert chats.record_turn_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("provider_type", ["OpenAIHTTPAgent", "OpenAIResponsesHTTPAgent"])
async def test_a_server_context_error_is_retried_once_with_less_history(provider_type: str) -> None:
    # A Responses client without native compaction (the hosted composition) is bounded like Chat Completions.
    provider = await _small_window_row(room_tokens=20_000, provider_type=provider_type)
    rejection = ModelClientError(
        "context length exceeded",
        code="openai_bad_request",
        raw_metadata={"provider_error_message": "the request exceeds the available context size"},
    )
    client = _ScriptedModelClient([rejection, _final()])
    executor, _chats = _executor(
        client=client, provider=provider, chat_manager=_FakeChatManager(history=_long_history())
    )

    events = await _collect(executor.stream_turn(_request()))

    assert EventType.ERROR not in [event.type for event in events]
    first, retry = client.seen_specs
    assert len(prompt_messages(retry.prompt)) < len(prompt_messages(first.prompt))


@pytest.mark.asyncio
async def test_oversized_tool_results_are_replaced_with_a_tool_error() -> None:
    provider = await _small_window_row(room_tokens=1500)
    tool_final = ModelClientFinal(
        text="",
        usage=Usage(requests=1, total_tokens=5),
        tool_calls=(
            ModelClientToolCall(id="call-1", name="memory_read_files", arguments=json.dumps({"paths": "big.md"})),
        ),
    )
    client = _ScriptedModelClient([tool_final, _final()])
    tools = _FakeMemoryToolService(result={"ok": True, "content": "x " * 20_000})
    executor, _chats = _executor(client=client, provider=provider, memory_tool_service=tools)

    await _collect(executor.stream_turn(_request()))

    follow_up = client.seen_specs[1].prompt
    assert estimate_prompt_tokens(follow_up) <= _available(provider)
    tool_outputs = [m for m in prompt_messages(follow_up) if m.get("role") == "tool"]
    assert json.loads(str(tool_outputs[0]["content"]))["code"] == "tool_result_too_large"


@pytest.mark.asyncio
@pytest.mark.parametrize("row", ["responses-native-compaction", "no-window"])
async def test_native_compaction_and_windowless_rows_are_not_trimmed(row: str) -> None:
    if row == "no-window":
        provider = _provider()
        client = _ScriptedModelClient([_final()])
    else:
        provider = replace(
            _provider(provider_type="OpenAIResponsesHTTPAgent"),
            context_window_tokens=2000,
            max_output_tokens=_MAX_OUTPUT,
        )
        client = _NativeCompactionClient([_final()])
    compactor = _Compactor()
    executor, _chats = _executor(
        client=client,
        provider=provider,
        chat_manager=_FakeChatManager(history=_long_history()),
        pre_send_compactor=compactor,
    )

    await _collect(executor.stream_turn(_request()))

    assert compactor.calls == []
    contents = [str(message.get("content")) for message in prompt_messages(client.seen_specs[0].prompt)]
    assert any(content.startswith("message 0 ") for content in contents)


@pytest.mark.asyncio
async def test_responses_rows_without_native_compaction_are_fitted_to_the_window() -> None:
    # Hosted Responses clients send no compaction threshold, so their history must be bounded here.
    provider = await _small_window_row(provider_type="OpenAIResponsesHTTPAgent")
    compactor = _Compactor(fail=RuntimeError("utility unreachable"))
    client = _ScriptedModelClient([_final()])
    executor, chats = _executor(
        client=client,
        provider=provider,
        chat_manager=_FakeChatManager(history=_long_history()),
        pre_send_compactor=compactor,
    )

    events = await _collect(executor.stream_turn(_request()))

    assert EventType.ERROR not in [event.type for event in events]
    assert len(compactor.calls) == 1
    prompt = client.seen_specs[0].prompt
    assert estimate_prompt_tokens(prompt) <= _available(provider)
    contents = [str(message.get("content")) for message in prompt_messages(prompt)]
    assert any(content.startswith("message 39 ") for content in contents)
    assert not any(content.startswith("message 0 ") for content in contents)
    assert len(chats.record_turn_calls) == 1


def test_fit_history_keeps_whole_turns_that_start_with_a_user_message() -> None:
    older_user = _history_message("older question", role=MessageRole.USER, turn=1)
    older_reply = _history_message("older reply", turn=1)
    user = _history_message("question", role=MessageRole.USER, turn=2)
    call = _history_message("", message_type="tool_call", turn=2, internal=True)
    result = _history_message("tool output " * 40, message_type="tool_result", turn=2, internal=True)
    reply = _history_message("final reply", turn=2)
    summary = {"role": "developer", "content": "summary"}
    history = [summary, older_user, older_reply, user, call, result, reply]

    def prompt_tokens_for(items: list[Any]) -> int:
        return 10 + sum(100 if getattr(item, "message_type", "") == "tool_result" else 5 for item in items)

    # The newest turn (with its tool exchange) is too large, so it goes whole. Fitting keeps a
    # contiguous run of the newest turns, so the older turn goes too; no reply is cut from its question.
    fitted = fit_history(history, available_tokens=40, prompt_tokens_for=prompt_tokens_for)

    assert fitted == [summary]
    assert fit_history(history, available_tokens=5000, prompt_tokens_for=prompt_tokens_for) == history
    assert fit_history(history, available_tokens=5, prompt_tokens_for=prompt_tokens_for) is None


@pytest.mark.asyncio
async def test_a_tool_call_after_tight_trimming_still_completes_the_turn() -> None:
    # Review P2-R1-F1: history trimmed close to the window must still leave room for a tool round.
    provider = await _small_window_row(room_tokens=1000)
    tool_final = ModelClientFinal(
        text="",
        usage=Usage(requests=1, total_tokens=5),
        tool_calls=(
            ModelClientToolCall(id="call-1", name="memory_read_files", arguments=json.dumps({"paths": "a.md"})),
        ),
    )
    client = _ScriptedModelClient([tool_final, _final()])
    executor, chats = _executor(
        client=client,
        provider=provider,
        chat_manager=_FakeChatManager(history=_long_history()),
        memory_tool_service=_FakeMemoryToolService(result={"ok": True, "content": "short"}),
        pre_send_compactor=_Compactor(fail=RuntimeError("utility unreachable")),
    )

    events = await _collect(executor.stream_turn(_request()))

    assert EventType.ERROR not in [event.type for event in events]
    assert all(estimate_prompt_tokens(spec.prompt) <= _available(provider) for spec in client.seen_specs)
    assert len(chats.record_turn_calls) == 1


@pytest.mark.asyncio
async def test_tool_results_that_cannot_fit_lead_to_a_final_reply_without_them() -> None:
    # Room for the prompt and tool definitions, but not for forty tool exchanges, even as errors.
    provider = await _small_window_row(room_tokens=1500)
    many_calls = tuple(
        ModelClientToolCall(
            id=f"call-{index}", name="memory_read_files", arguments=json.dumps({"paths": f"{index}.md"})
        )
        for index in range(40)
    )
    client = _ScriptedModelClient(
        [ModelClientFinal(text="", usage=Usage(requests=1, total_tokens=5), tool_calls=many_calls), _final()]
    )
    tools = _FakeMemoryToolService(result={"ok": True, "content": "x " * 5_000})
    executor, chats = _executor(client=client, provider=provider, memory_tool_service=tools)

    events = await _collect(executor.stream_turn(_request()))

    assert EventType.ERROR not in [event.type for event in events]
    final_request = client.seen_specs[1].prompt
    assert final_request.tools == ()
    assert estimate_prompt_tokens(final_request) <= _available(provider)
    assert len(chats.record_turn_calls) == 1


@pytest.mark.asyncio
async def test_native_compaction_responses_rows_do_not_retry_a_server_context_error() -> None:
    provider = replace(
        _provider(provider_type="OpenAIResponsesHTTPAgent"), context_window_tokens=2000, max_output_tokens=_MAX_OUTPUT
    )
    rejection = ModelClientError(
        "context length exceeded",
        code="openai_bad_request",
        raw_metadata={"provider_error_code": "context_length_exceeded"},
    )
    client = _NativeCompactionClient([rejection, _final()])
    executor, _chats = _executor(
        client=client, provider=provider, chat_manager=_FakeChatManager(history=_long_history())
    )

    events = await _collect(executor.stream_turn(_request()))

    assert len(client.seen_specs) == 1
    assert [event.type for event in events] == [EventType.ERROR]


@pytest.mark.asyncio
async def test_pre_send_compactor_compacts_in_its_own_session_and_returns_fresh_context(
    async_session, async_session_factory, monkeypatch
) -> None:
    from animama.app.services.direct_model_prompt_runner import DirectModelPromptResult
    from animama.orm import ORMAnima
    from animama.product_http.chat import compaction as chat_compaction
    from tests.product_http_support import local_turn_sessions
    from tests.test_chat_compaction_service import _append_visible_messages, _create_chat

    await _create_chat(async_session, anima_id="anima-presend", chat_id="chat-presend")
    rows = await _append_visible_messages(async_session, chat_id="chat-presend", count=8, prefix="z" * 40)
    _ = ORMAnima

    class _Runner:
        async def model_provider_for_role(self, user_id: str, role: str = "utility") -> ModelProvider | None:
            return None

        async def run_prompt(self, request: Any) -> DirectModelPromptResult:
            return DirectModelPromptResult(text="Summary of earlier turns.", usage=None, model_provider=_provider())

    monkeypatch.setattr(chat_compaction, "direct_model_prompt_runner", lambda *_args: _Runner())
    sessions = local_turn_sessions(async_session_factory, "user-1")
    compactor = chat_compaction.pre_send_compactor(
        sessions=sessions,
        model_client_registry=cast(Any, SimpleNamespace()),
        settings=sessions.ports.chat_policy.compaction,
    )

    context = await compactor(
        PreSendCompactionRequest(
            chat_id="chat-presend", user_id="user-1", anima_id="anima-presend", run_id="run-1", keep_recent_tokens=25
        )
    )

    assert context is not None
    assert context.active_compaction.summary_text == "Summary of earlier turns."
    assert [message.content for message in context.messages] == [row.content for row in rows[6:]]


def test_run_status_events_become_type_keyed_sse_frames() -> None:
    from animama.domain.events import Event, RunStatusPayload
    from animama.product_http.chat.sse_events import format_run_status_event

    event = Event(
        event_id="run-status-run-1-summarizing_context-started",
        anima_id="anima-1",
        type=EventType.RUN_STATUS,
        payload=RunStatusPayload(run_id="run-1", status="summarizing_context", phase="started"),
    )

    frame = format_run_status_event(event, run_id="run-1")

    assert frame is not None
    assert "event: run.status" in frame
    data = json.loads(next(line for line in frame.splitlines() if line.startswith("data: ")).removeprefix("data: "))
    assert data == {"type": "run.status", "run_id": "run-1", "status": "summarizing_context", "phase": "started"}
    assert format_run_status_event(event, run_id="other-run") is None


@pytest.mark.asyncio
async def test_post_response_compaction_threshold_follows_the_model_window(monkeypatch) -> None:
    from animama.app.chat.options import DirectChatOptions
    from animama.product_http.chat import compaction as chat_compaction
    from tests.product_http_support import local_turn_sessions

    calls: list[dict[str, Any]] = []

    class _Service:
        async def maybe_compact_chat(self, **kwargs: Any) -> Any:
            calls.append(kwargs)
            return SimpleNamespace(
                compacted=False, reason="below_threshold", compaction=None, trigger_active_context_tokens=0
            )

    class _Session:
        def expire_all(self) -> None:
            return None

        async def __aenter__(self) -> _Session:
            return self

        async def __aexit__(self, *_exc_info: object) -> None:
            return None

    monkeypatch.setattr(chat_compaction, "chat_compaction_service", lambda *_args: _Service())
    small = replace(_provider(), context_window_tokens=8192, max_output_tokens=_MAX_OUTPUT)

    for provider in (small, _provider()):
        await chat_compaction.compact_chat_after_success(
            sessions=local_turn_sessions(_Session, "user-1"),
            model_client_registry=cast(Any, SimpleNamespace()),
            chat_id="chat-1",
            user_id="user-1",
            anima_id="anima-1",
            run_id="run-1",
            chat_options=DirectChatOptions(),
            settings=chat_compaction.ChatCompactionSettings(),
            model_provider=provider,
        )

    # The smaller of 70% of the window and 75% of the room left after the reply; the
    # cap (ANIMAMA_CHAT_COMPACTION_THRESHOLD_TOKENS) is applied by the service.
    assert [call["threshold_tokens"] for call in calls] == [
        min(int(8192 * 0.7), int((8192 - _MAX_OUTPUT) * 0.75)),
        None,
    ]


@pytest.mark.asyncio
async def test_the_retry_keeps_the_split_turn_shape() -> None:
    # Review FI-R1-F1: rows that cannot combine tools with a schema must not get both in the retry.
    provider = await _small_window_row(room_tokens=20_000)
    provider.capabilities.tools_with_structured_output = False
    rejection = ModelClientError(
        "context length exceeded",
        code="openai_bad_request",
        raw_metadata={"provider_error_message": "the request exceeds the available context size"},
    )
    client = _ScriptedModelClient([rejection, _final(), _final()])
    executor, _chats = _executor(
        client=client,
        provider=provider,
        chat_manager=_FakeChatManager(history=_long_history()),
        memory_tool_service=_FakeMemoryToolService(),
    )

    events = await _collect(executor.stream_turn(_request()))

    first, retry, structured = client.seen_specs
    assert first.prompt.tools and first.prompt.response_format is None
    assert retry.prompt.tools and retry.prompt.response_format is None
    assert structured.prompt.tools == () and structured.prompt.response_format is not None
    assert EventType.ERROR not in [event.type for event in events]


@pytest.mark.asyncio
@pytest.mark.parametrize("split", [False, True])
async def test_a_repair_after_large_tool_results_stays_within_the_window(split: bool) -> None:
    # Review FI-R1-F2: capped tool results leave room for the structured round and the repair.
    # Sweep result sizes so some land just under the tool-round limit.
    provider = await _small_window_row(room_tokens=1800)
    provider.capabilities.tools_with_structured_output = not split
    for words in range(100, 1500, 25):
        tool_final = ModelClientFinal(
            text="",
            usage=Usage(requests=1, total_tokens=5),
            tool_calls=(
                ModelClientToolCall(id="call-1", name="memory_read_files", arguments=json.dumps({"paths": "a.md"})),
            ),
        )
        finals = [tool_final, _final("not json"), _final("still not json")]
        if split:
            finals.insert(1, _final("unconstrained draft"))
        client = _ScriptedModelClient(finals)
        tools = _FakeMemoryToolService(result={"ok": True, "content": "word " * words})
        executor, _chats = _executor(client=client, provider=provider, memory_tool_service=tools)

        await _collect(executor.stream_turn(_request()))

        sizes = [estimate_prompt_tokens(spec.prompt) for spec in client.seen_specs]
        assert max(sizes) <= _available(provider), (words, sizes)


@pytest.mark.asyncio
@pytest.mark.parametrize("room_tokens", [700, 800, 900, 1200])
async def test_finals_and_repairs_after_unfittable_tool_results_never_exceed_the_window(room_tokens: int) -> None:
    # Review FI-R2-F1: the context-limit final and its repair are checked against the budget too.
    provider = await _small_window_row(room_tokens=room_tokens)
    provider.capabilities.tools_with_structured_output = False
    calls = tuple(
        ModelClientToolCall(
            id=f"call-{index}", name="memory_read_files", arguments=json.dumps({"paths": f"{index}.md"})
        )
        for index in range(20)
    )
    client = _ScriptedModelClient(
        [
            ModelClientFinal(text="", usage=Usage(requests=1, total_tokens=5), tool_calls=calls),
            _final("not json"),
            _final("still not json"),
        ]
    )
    tools = _FakeMemoryToolService(result={"ok": True, "content": "x " * 3_000})
    executor, _chats = _executor(client=client, provider=provider, memory_tool_service=tools)

    events = await _collect(executor.stream_turn(_request()))

    assert all(estimate_prompt_tokens(spec.prompt) <= _available(provider) for spec in client.seen_specs)
    assert len([event for event in events if event.type == EventType.ERROR]) <= 1


@pytest.mark.asyncio
async def test_a_trimmed_history_sends_only_the_kept_turns_images() -> None:
    base = _vision_provider()
    fixed = await _fixed_prompt_tokens(base)
    provider = replace(base, context_window_tokens=fixed + 1200 + _MAX_OUTPUT, max_output_tokens=_MAX_OUTPUT)
    history = []
    for turn in range(12):
        # 280 px square: 100 estimated tokens per image.
        part = image_part(file_id=f"file-{turn}", name=f"file-{turn}.png", width=280, height=280)
        history.append(
            _history_message(
                f"Look\n\n[Image: file-{turn}.png]",
                role=MessageRole.USER,
                turn=turn + 1,
                raw_provider_message={"role": "user", "content": [part, {"type": "text", "text": "Look"}]},
            )
        )
        history.append(_history_message("A picture.", turn=turn + 1))
    client = _ScriptedModelClient([_final()])
    loader = _FakeImageLoader([f"file-{turn}" for turn in range(12)])
    executor, _chats = _executor(
        client=client, provider=provider, chat_manager=_FakeChatManager(history=history), image_loader=loader
    )

    await _collect(executor.stream_turn(_request(user_message="Which was first?", request_options={"incognito": True})))

    spec = client.seen_specs[0]
    sent = image_file_ids(spec.prompt.messages)
    assert estimate_prompt_tokens(spec.prompt) <= _available(provider)
    assert 0 < len(sent) < 12
    assert sent == [f"file-{turn}" for turn in range(12 - len(sent), 12)]
    assert set(spec.images) == set(sent)
    assert loader.calls == [sent]

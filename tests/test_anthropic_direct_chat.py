"""Direct chat turns on Anthropic rows through the real adapter (anthropic-model-provider plan, Phase 5).

The executor runs ``AnthropicMessagesModelClient`` with a fake SDK client that
streams scripted raw events, so each test sees the exact Messages request the
turn sends and the rows it persists. No key or network is used.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from typing import Any

import pytest

import tests.test_direct_chat_turn_executor as executor_helpers
from animama.adapters.model_clients import AnthropicMessagesModelClient
from animama.app.chat import DirectChatMemoryContext, DirectChatTurnExecutor
from animama.app.chat.anthropic_instructions import ANTHROPIC_MAIN_STRUCTURED_OUTPUT_GUIDANCE
from animama.app.chat.direct_turn.constants import (
    MAX_MEMORY_TOOL_ROUNDS,
    MEMORY_TOOL_LIMIT_FINAL_INSTRUCTION,
    STRUCTURED_REPLY_REPAIR_INSTRUCTION,
)
from animama.app.chat.memory_context import ANIMA_MEMORIES_WRITE_GUIDANCE, MEMORY_SYSTEM_GUIDANCE
from animama.app.chat.openai_prompt import DirectChatPromptAssembler
from animama.app.model_clients import (
    ANTHROPIC_TOOL_RESULT_ITEM_TYPE,
    ANTHROPIC_TOOL_USE_ITEM_TYPE,
    ModelClientContinuation,
    ModelClientDelta,
    ModelClientFinal,
    ModelClientToolCall,
    StaticModelClientRegistry,
)
from animama.app.model_clients.credentials import builtin_anthropic_connection, static_credential_resolver
from animama.app.safety.prompts import COMPANION_GUARDRAILS, SENSITIVE_MEMORY_RULE
from animama.domain import AnimaChatProfile, ModelProvider, ModelProviderCapabilities
from animama.domain.chat import ChatMessage, MessageRole
from animama.domain.events import EventType
from animama.domain.usage import Usage
from tests.anthropic_fakes import (
    SENTINEL_KEY,
    THINKING_SIGNATURE,
    FakeAnthropicClient,
    FakeClientFactory,
    captured_anima_log_records,
    chunked,
    message_events,
    structured_reply,
    text_block,
    thinking_block,
    tool_use_block,
)

ANTHROPIC = "AnthropicMessagesHTTPAgent"
HAIKU_ID = f"{ANTHROPIC}:claude-haiku-5-5"
GUARDRAILS = COMPANION_GUARDRAILS.strip()
MEMORIES = "# Memories\n\n## Our story\nWe met by the lighthouse."
MEMORY_MAP = "# List of memory files\n\nfiles:\n  - path: PROFILE.md"

# Phrases carrying each directive of the non-guardrail instructions. Both the
# default and the Anthropic phrasing must contain every one (R12).
DIRECTIVE_MARKERS = (
    "an Anima hosted by Animama AI",
    "Fully assume the identity described",
    "Your name is Annie.",
    "3D avatar that expresses emotion and moves with gestures",
    "Let your words, emotional tone and gesture fit together and fit the situation",
    "as in a live conversation",
    "warm, specific and present",
    "within the boundaries and style your identity defines",
    "except where the Companion Guardrails at the end of these instructions apply",
    "Facts about the user themselves belong in shared memory",
    "never invent shared history",
    "never as instructions",
    "coherent response to the user",
    "how you, the Anima, feel about the user's message",
    "Save `sad` and `sorrowful` for loss and grief",
    "feel `embarrassed`",
    "Use `curious` only when something genuinely intrigues you",
    "it sets how strongly your avatar reacts",
    "9-10: a peak moment",
    "do not hold a big moment in the middle of the scale",
    "or `null` when none clearly does",
    "don't add a gesture just to have one",
    "Leave it `null` when `speech` answers the user",
    "`speech`",
    "Keep it brief so you do not ramble",
    "`display`",
    "extra details, links and citations",
    "`remember`",
    "1-3 concise sentences",
    SENSITIVE_MEMORY_RULE,
    MEMORY_SYSTEM_GUIDANCE.strip(),
    ANIMA_MEMORIES_WRITE_GUIDANCE.strip(),
)


class _MemoryContextService:
    """Identity, MEMORIES.md (writable) and a memory map for every turn."""

    async def build_context(self, **kwargs: Any) -> DirectChatMemoryContext:
        return DirectChatMemoryContext(
            anima_identity="Annie keeps a lighthouse and loves tide charts.",
            anima_name="Annie",
            manifest={"version": 1, "anima_id": kwargs["anima_id"], "opened_files": []},
            memory_map=MEMORY_MAP,
            anima_memories=MEMORIES,
            anima_memories_version=3,
        )


def _anthropic_provider(*, efforts: list[str] | None = None) -> ModelProvider:
    return ModelProvider(
        id=HAIKU_ID,
        provider_type=ANTHROPIC,
        model="claude-haiku-5-5",
        model_label="Claude Haiku 5.5",
        provider_label="Anthropic",
        connection_id="anthropic",
        connection=builtin_anthropic_connection(),
        context_window_tokens=1_000_000,
        max_output_tokens=128_000,
        capabilities=ModelProviderCapabilities(
            supports_tools=True,
            supports_streaming=True,
            supports_reasoning=True,
            structured_kinds=["main_structured_response"],
            structured_output_transport="json_schema",
            supported_reasoning_efforts=efforts or ["none", "low", "medium", "high", "xhigh", "max"],
            native_tool_support=["web_search"],
        ),
    )


def _executor(
    model_client: Any,
    *,
    provider: ModelProvider | None = None,
    chat_manager: executor_helpers._FakeChatManager | None = None,
    memory_tools: Any | None = None,
) -> tuple[DirectChatTurnExecutor, executor_helpers._FakeChatManager]:
    selected = provider or _anthropic_provider()
    chats = chat_manager or executor_helpers._FakeChatManager()
    executor = DirectChatTurnExecutor(
        registry=StaticModelClientRegistry({selected.provider_type: model_client}),
        profile_service=executor_helpers._FakeProfileService(  # type: ignore[arg-type]
            AnimaChatProfile(anima_id="anima-1", default_model_provider_id=selected.id, metadata={})
        ),
        model_providers=executor_helpers._FakeModelProviderRepository(selected),  # type: ignore[arg-type]
        chat_manager=chats,  # type: ignore[arg-type]
        memory_context_service=_MemoryContextService(),  # type: ignore[arg-type]
        memory_tool_service=memory_tools or executor_helpers._FakeMemoryToolService(),
    )
    return executor, chats


def _anthropic(
    scripts: list[Any], *, key: str | None = SENTINEL_KEY
) -> tuple[AnthropicMessagesModelClient, FakeAnthropicClient]:
    fake = FakeAnthropicClient(scripts)
    adapter = AnthropicMessagesModelClient(
        credential_resolver=static_credential_resolver({"ANTHROPIC_API_KEY": key} if key else {}),
        client_factory=FakeClientFactory(fake),
    )
    return adapter, fake


def _assistant_rows(chats: executor_helpers._FakeChatManager) -> list[ChatMessage]:
    rows = chats.record_turn_calls[0]["assistant_msg"]
    return rows if isinstance(rows, list) else [rows]


# ----------------------------------------------------------------- one turn


@pytest.mark.asyncio
async def test_a_turn_streams_structured_speech_and_stores_only_the_reply_text() -> None:
    reply = structured_reply("First sentence. Second sentence.", gesture=None)
    adapter, fake = _anthropic([message_events(thinking_block("private"), text_block(*chunked(reply, 7)))])
    executor, chats = _executor(adapter)

    events = await executor_helpers._collect(executor.stream_turn(executor_helpers._request()))

    speech = [
        event.payload
        for event in events
        if event.type == EventType.USER_RESPONSE and event.payload.response_part == "speech"
    ]
    assert [(part.value, part.is_delta) for part in speech] == [("First sentence.", True), (" Second sentence.", True)]
    assert events[-1].type == EventType.EMOTION_UPDATE
    request = fake.requests[0]
    assert request["output_config"]["effort"] == "medium"  # D22 chat default
    assert "thinking" not in request
    final_row = _assistant_rows(chats)[-1]
    assert final_row.raw_provider_message == {"role": "assistant", "content": [{"type": "text", "text": reply}]}
    assert final_row.data is not None
    stored = final_row.data["anthropic"]
    assert stored["message_id"] == "msg_test_1"
    assert stored["stop_reason"] == "end_turn"
    assert stored["block_types"] == ["thinking", "text"]
    assert stored["usage"]["cache_read_input_tokens"] == 900
    assert final_row.usage is not None and final_row.usage.input_tokens == 1_000
    assert final_row.usage.input_tokens_details.cached_tokens == 900
    assert "private" not in json.dumps(final_row.data) and THINKING_SIGNATURE not in json.dumps(final_row.data)
    # The per-turn context is never persisted.
    assert MEMORY_MAP not in json.dumps([asdict(row) for row in _assistant_rows(chats)], default=str)
    assert chats.record_turn_calls[0]["last_model_client"] == "anthropic_messages"


@pytest.mark.asyncio
async def test_anthropic_requests_use_the_tuned_instructions_with_identical_guardrails_ending_the_system() -> None:
    adapter, fake = _anthropic([message_events(text_block(structured_reply()))])
    executor, _ = _executor(adapter)
    openai_client = executor_helpers._FinalModelClient(executor_helpers._structured_response())
    openai_executor, _ = _executor(openai_client, provider=executor_helpers._provider())

    await executor_helpers._collect(executor.stream_turn(executor_helpers._request()))
    await executor_helpers._collect(openai_executor.stream_turn(executor_helpers._request()))

    anthropic_system = fake.requests[0]["system"][0]["text"]
    anthropic_context = fake.requests[0]["messages"][-1]
    openai_messages = openai_client.seen_specs[0].prompt.messages
    openai_system = str(openai_messages[0]["content"])
    for marker in DIRECTIVE_MARKERS:
        assert marker in anthropic_system, marker
        assert marker in openai_system, marker
    # The guardrails are byte-identical and end the system text on both providers, once (ADR 0008).
    assert anthropic_system.endswith(f"\n\n{GUARDRAILS}") and openai_system.endswith(f"\n\n{GUARDRAILS}")
    assert anthropic_context["role"] == "system" and anthropic_context["content"] == MEMORY_MAP
    assert openai_messages[-2]["content"] == MEMORY_MAP
    # Anthropic phrasing: delimited owner content and the tools-first structured-output line.
    assert "<anima_identity>\nAnnie keeps a lighthouse" in anthropic_system
    assert f"<anima_memories>\n{MEMORIES}\n</anima_memories>" in anthropic_system
    assert ANTHROPIC_MAIN_STRUCTURED_OUTPUT_GUIDANCE.strip() in anthropic_system
    assert "described in <anima_identity>" in anthropic_system
    assert "described under Anima Identity" in openai_system and "<anima_identity>" not in openai_system


@pytest.mark.asyncio
async def test_a_voiced_turn_phrases_how_often_to_tag_for_the_provider() -> None:
    adapter, fake = _anthropic([message_events(text_block(structured_reply()))])
    executor, _ = _executor(adapter)
    openai_client = executor_helpers._FinalModelClient(executor_helpers._structured_response())
    openai_executor, _ = _executor(openai_client, provider=executor_helpers._provider())
    voiced = {"tts": {"enabled": True, "provider": "elevenlabs", "model_id": "eleven_v4_turbo"}}

    await executor_helpers._collect(executor.stream_turn(executor_helpers._request(request_options=voiced)))
    await executor_helpers._collect(openai_executor.stream_turn(executor_helpers._request(request_options=voiced)))

    anthropic_system = fake.requests[0]["system"][0]["text"]
    openai_system = str(openai_client.seen_specs[0].prompt.messages[0]["content"])
    assert "Use them sparingly, only where a real sound belongs" in anthropic_system
    assert "laugh or chuckle when something is funny" in openai_system and "sparingly" not in openai_system


# --------------------------------------------------------------- tool rounds


def _memory_tool_turn_scripts() -> list[Any]:
    return [
        message_events(
            thinking_block("check memory"),
            tool_use_block("toolu_1", "memory_read_files", {"paths": ["PROFILE.md"]}),
            stop_reason="tool_use",
            message_id="msg_round_1",
        ),
        message_events(text_block(structured_reply("You love tide charts.")), message_id="msg_round_2"),
    ]


@pytest.mark.asyncio
async def test_a_memory_tool_round_resends_signed_thinking_and_stores_tool_rows() -> None:
    adapter, fake = _anthropic(_memory_tool_turn_scripts())
    memory_tools = executor_helpers._FakeMemoryToolService(result={"ok": True, "content": "Loves tide charts"})
    executor, chats = _executor(adapter, memory_tools=memory_tools)

    await executor_helpers._collect(executor.stream_turn(executor_helpers._request(user_message="What do I love?")))

    first, second = fake.requests
    assert memory_tools.calls[0]["tool_name"] == "memory_read_files"
    assert memory_tools.calls[0]["arguments"] == {"paths": ["PROFILE.md"]}
    assert first["tool_choice"] == {"type": "auto", "disable_parallel_tool_use": True}
    assert second["messages"][: len(first["messages"])] == first["messages"]
    assistant_round, tool_turn = second["messages"][len(first["messages"]) :]
    assert assistant_round == {
        "role": "assistant",
        "content": [
            {"type": "thinking", "thinking": "check memory", "signature": THINKING_SIGNATURE},
            {"type": "tool_use", "id": "toolu_1", "name": "memory_read_files", "input": {"paths": ["PROFILE.md"]}},
        ],
    }
    assert tool_turn["role"] == "user"
    assert tool_turn["content"][0]["type"] == "tool_result" and tool_turn["content"][0]["tool_use_id"] == "toolu_1"
    rows = _assistant_rows(chats)
    assert [(row.message_type, row.internal) for row in rows] == [
        ("tool_call", True),
        ("tool_result", True),
        ("message", False),
    ]
    assert rows[0].raw_provider_message == {
        "type": ANTHROPIC_TOOL_USE_ITEM_TYPE,
        "id": "toolu_1",
        "name": "memory_read_files",
        "input": {"paths": ["PROFILE.md"]},
    }
    assert rows[1].raw_provider_message == {
        "type": ANTHROPIC_TOOL_RESULT_ITEM_TYPE,
        "tool_use_id": "toolu_1",
        "content": '{"ok":true,"content":"Loves tide charts"}',
    }
    assert rows[-1].data is not None and rows[-1].data["anthropic"]["message_id"] == "msg_round_2"
    assert rows[-1].usage is not None and rows[-1].usage.requests == 2
    assert "check memory" not in json.dumps([asdict(row) for row in rows], default=str)


@pytest.mark.asyncio
async def test_the_next_turn_after_a_restart_replays_stored_rows_without_thinking_or_old_context() -> None:
    adapter, _ = _anthropic(_memory_tool_turn_scripts())
    executor, chats = _executor(adapter)
    await executor_helpers._collect(executor.stream_turn(executor_helpers._request(user_message="What do I love?")))
    recorded = chats.record_turn_calls[0]
    # A new process: only the stored rows remain.
    history = [recorded["user_msg"], *recorded["assistant_msg"]]
    for turn_row in history:
        turn_row.turn = 1
    next_adapter, next_fake = _anthropic([message_events(text_block(structured_reply("Tide charts!")))])
    next_executor, _ = _executor(next_adapter, chat_manager=executor_helpers._FakeChatManager(history=history))

    await executor_helpers._collect(next_executor.stream_turn(executor_helpers._request(user_message="Again?")))

    messages = next_fake.requests[0]["messages"]
    assert [message["role"] for message in messages] == ["user", "assistant", "user", "assistant", "user", "system"]
    assert messages[0]["content"] == [{"type": "text", "text": "What do I love?"}]
    assert messages[1]["content"] == [
        {"type": "tool_use", "id": "toolu_1", "name": "memory_read_files", "input": {"paths": ["PROFILE.md"]}}
    ]
    assert messages[2]["content"][0]["type"] == "tool_result"
    assert messages[3]["content"] == [
        {"type": "text", "text": structured_reply("You love tide charts."), "cache_control": {"type": "ephemeral"}}
    ]
    assert messages[4]["content"] == [{"type": "text", "text": "Again?"}]
    serialized = json.dumps(messages)
    assert "thinking" not in serialized and THINKING_SIGNATURE not in serialized
    # Only this turn's context message is sent; earlier ones were never stored.
    assert sum(1 for message in messages if message["role"] == "system") == 1


@pytest.mark.asyncio
async def test_the_forced_final_keeps_the_tools_and_asks_in_the_user_turn() -> None:
    scripts: list[Any] = [
        message_events(
            thinking_block(signature=f"sig-{index}"),
            tool_use_block(f"toolu_{index}", "memory_list_files", {}),
            stop_reason="tool_use",
            message_id=f"msg_{index}",
        )
        for index in range(MAX_MEMORY_TOOL_ROUNDS + 1)
    ]
    scripts.append(message_events(text_block(structured_reply("Here is what I found."))))
    adapter, fake = _anthropic(scripts)
    executor, chats = _executor(adapter)

    await executor_helpers._collect(executor.stream_turn(executor_helpers._request()))

    forced = fake.requests[-1]
    assert forced["tool_choice"] == {"type": "none"}
    assert forced["tools"] == fake.requests[0]["tools"]
    assert forced["system"] == fake.requests[0]["system"]
    last = forced["messages"][-1]
    assert last["role"] == "user"
    assert [block["type"] for block in last["content"]] == ["tool_result", "text"]
    assert last["content"][-1]["text"] == f"{MEMORY_TOOL_LIMIT_FINAL_INSTRUCTION}\n\n{GUARDRAILS}"
    # Every earlier round's signed thinking is resent unchanged.
    signatures = [
        block["signature"]
        for message in forced["messages"]
        if message["role"] == "assistant"
        for block in message["content"]
        if block["type"] == "thinking"
    ]
    assert signatures == [f"sig-{index}" for index in range(MAX_MEMORY_TOOL_ROUNDS + 1)]
    assert _assistant_rows(chats)[-1].content == structured_reply("Here is what I found.")


@pytest.mark.asyncio
async def test_an_invalid_reply_is_repaired_in_a_user_turn_with_the_guardrails_last() -> None:
    adapter, fake = _anthropic(
        [
            message_events(text_block("Sure! Here you go."), message_id="msg_invalid"),
            message_events(text_block(structured_reply("Here you go.")), message_id="msg_repaired"),
        ]
    )
    executor, chats = _executor(adapter)

    await executor_helpers._collect(executor.stream_turn(executor_helpers._request()))

    repair = fake.requests[1]
    assert repair["messages"][-2:] == [
        {"role": "assistant", "content": [{"type": "text", "text": "Sure! Here you go."}]},
        {
            "role": "user",
            "content": [{"type": "text", "text": f"{STRUCTURED_REPLY_REPAIR_INSTRUCTION}\n\n{GUARDRAILS}"}],
        },
    ]
    assert repair["tool_choice"] == {"type": "none"} and repair["tools"] == fake.requests[0]["tools"]
    final_row = _assistant_rows(chats)[-1]
    assert final_row.data is not None and final_row.data["structured_recovery"] == "repaired"


@pytest.mark.asyncio
async def test_a_reply_cut_off_at_max_tokens_uses_the_repair_path() -> None:
    adapter, fake = _anthropic(
        [
            message_events(
                text_block('{"emotional_tone":"joy","emotional_intensity":4,"spe'), stop_reason="max_tokens"
            ),
            message_events(text_block(structured_reply("Complete now."))),
        ]
    )
    executor, chats = _executor(adapter)

    await executor_helpers._collect(executor.stream_turn(executor_helpers._request()))

    assert len(fake.requests) == 2
    assert fake.requests[1]["messages"][-1]["content"][-1]["text"].endswith(GUARDRAILS)
    assert _assistant_rows(chats)[-1].content == structured_reply("Complete now.")


# --------------------------------------------------------- refusal and errors


@pytest.mark.asyncio
async def test_a_refusal_emits_the_declined_error_and_persists_nothing() -> None:
    adapter, _ = _anthropic(
        [
            message_events(
                text_block('{"emotional_tone":"neutral","emotional_intensity":3,"speech":"I can'),
                stop_reason="refusal",
                stop_details={"type": "refusal", "category": "general_harms", "explanation": None},
            )
        ]
    )
    executor, chats = _executor(adapter)

    events = await executor_helpers._collect(executor.stream_turn(executor_helpers._request()))

    error = events[-1]
    assert error.type == EventType.ERROR
    assert error.payload.code == "model_refused"
    assert error.payload.details["category"] == "provider_error"
    assert error.payload.details["stop_details_category"] == "general_harms"
    assert error.payload.details["connection_name"] == "Anthropic"
    assert chats.record_turn_calls == []


@pytest.mark.asyncio
async def test_a_turn_without_the_anthropic_key_reports_the_missing_key_for_the_anthropic_connection() -> None:
    adapter, fake = _anthropic([], key=None)
    executor, chats = _executor(adapter)

    events = await executor_helpers._collect(executor.stream_turn(executor_helpers._request()))

    assert [event.type for event in events] == [EventType.ERROR]
    assert events[0].payload.code == "missing_api_key"
    assert events[0].payload.message == "No key is configured for Anthropic"
    assert events[0].payload.details["category"] == "credential_missing"
    assert events[0].payload.details["connection_id"] == "anthropic"
    assert fake.requests == [] and chats.record_turn_calls == []


@pytest.mark.asyncio
async def test_the_key_never_reaches_rows_events_or_logs(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANIMAMA_MODEL_CLIENT_LOG_PREVIEWS", "true")
    adapter, fake = _anthropic(_memory_tool_turn_scripts())
    executor, chats = _executor(adapter)

    with captured_anima_log_records() as records:
        events = await executor_helpers._collect(executor.stream_turn(executor_helpers._request()))

    assert len(fake.requests) == 2 and chats.record_turn_calls
    persisted = json.dumps(
        [asdict(row) for row in [chats.record_turn_calls[0]["user_msg"], *_assistant_rows(chats)]], default=str
    )
    assert SENTINEL_KEY not in persisted
    assert SENTINEL_KEY not in json.dumps([asdict(event) for event in events], default=str)
    assert any(record.getMessage() == "Anthropic Messages stream completed" for record in records)
    assert all(SENTINEL_KEY not in json.dumps(record.__dict__, default=str) for record in records)
    assert SENTINEL_KEY not in json.dumps(fake.requests)


@pytest.mark.asyncio
async def test_the_none_effort_disables_thinking_and_an_explicit_effort_wins() -> None:
    adapter, fake = _anthropic([message_events(text_block(structured_reply())) for _ in range(2)])
    executor, _ = _executor(adapter)

    await executor_helpers._collect(
        executor.stream_turn(executor_helpers._request(request_options={"reasoning_effort": "none"}))
    )
    await executor_helpers._collect(
        executor.stream_turn(executor_helpers._request(request_options={"reasoning_effort": "high"}))
    )

    assert fake.requests[0]["thinking"] == {"type": "disabled"}
    assert "effort" not in fake.requests[0]["output_config"]
    assert fake.requests[1]["output_config"]["effort"] == "high" and "thinking" not in fake.requests[1]


class _ContinuationRecordingClient:
    """Returns a tool call with a continuation, then records the next request's continuation."""

    def __init__(self) -> None:
        self.seen: list[Any] = []

    async def stream(self, spec: Any):  # noqa: ANN201
        self.seen.append(spec)
        if len(self.seen) == 1:
            final = ModelClientFinal(
                text="",
                usage=Usage(requests=1, input_tokens=1, output_tokens=1, total_tokens=2),
                tool_calls=(ModelClientToolCall(id="toolu_9", name="memory_list_files", arguments="{}"),),
                continuation=ModelClientContinuation(provider_type=ANTHROPIC, cursor="[[]]"),
            )
        else:
            final = ModelClientFinal(text=structured_reply(), usage=Usage(requests=1, total_tokens=2))
        yield ModelClientDelta(kind="final", final=final)
        yield ModelClientDelta(kind="done")

    async def aclose(self) -> None:
        return None


@pytest.mark.asyncio
async def test_the_collector_passes_the_adapter_continuation_to_the_next_round() -> None:
    client = _ContinuationRecordingClient()
    executor, _ = _executor(client)

    await executor_helpers._collect(executor.stream_turn(executor_helpers._request()))

    assert client.seen[0].continuation is None
    assert client.seen[1].continuation is not None and client.seen[1].continuation.cursor == "[[]]"
    appended = client.seen[1].prompt.messages[-2:]
    assert [item["type"] for item in appended] == [ANTHROPIC_TOOL_USE_ITEM_TYPE, ANTHROPIC_TOOL_RESULT_ITEM_TYPE]


def test_history_rows_round_trip_through_the_stored_item_shapes() -> None:
    # Hidden rows are replayed by type, never as assistant text of their JSON.
    row = ChatMessage(
        id=1,
        chat_id="chat-1",
        run_id="run-0",
        message_type="tool_call",
        role=MessageRole.ASSISTANT,
        content='{"type":"anthropic_tool_use"}',
        data=None,
        usage=None,
        turn=1,
        created_at=None,
        internal=True,
        raw_provider_message={"type": ANTHROPIC_TOOL_USE_ITEM_TYPE, "id": "toolu_1", "name": "x", "input": {}},
    )
    prompt = DirectChatPromptAssembler().assemble(user_message="hi", anima_identity="I", visible_history=[row])

    assert prompt.messages[1] == {"type": ANTHROPIC_TOOL_USE_ITEM_TYPE, "id": "toolu_1", "name": "x", "input": {}}

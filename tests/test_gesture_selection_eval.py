"""Offline tests for the Gesture selection evaluation harness (scripts/evals/gesture_selection.py).

Every test uses a fake model client: the harness must never reach a provider here.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections.abc import AsyncIterator, Callable
from dataclasses import replace
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from animama.adapters.repositories.sqlalchemy.model_provider_repo import SQLAlchemyModelProviderRepository
from animama.app.chat import DirectChatPromptAssembler, RuntimeGestureDescriptor
from animama.app.chat.direct_turn.constants import DIRECT_CHAT_NODE_ID
from animama.app.chat.direct_turn.response_format import (
    gesture_response_guidance,
    main_structured_response_format_for_model,
    main_structured_response_guidance,
    render_available_gestures,
    response_model_agent_id,
    turn_response_schema_name,
)
from animama.app.chat.options import DirectChatOptions
from animama.app.chat.speech_tags import speech_instruction
from animama.app.main_structured_response import build_main_structured_response_model
from animama.app.model_catalog import STRUCTURED_OUTPUT_TRANSPORT_JSON_SCHEMA
from animama.app.model_clients import (
    ModelClientDelta,
    ModelClientFinal,
    ModelClientProviderError,
    ModelClientRequest,
    StaticModelClientRegistry,
)
from animama.domain import ModelProvider, ModelProviderCapabilities
from animama.domain.model_provider import ModelProviderPricing
from animama.domain.usage import Usage, UsageInputDetails, UsageOutputDetails
from scripts.evals import gesture_selection as harness

WAVE = RuntimeGestureDescriptor(selector="wave", name="Wave", description="Greet or say goodbye.")
THINK = RuntimeGestureDescriptor(selector="think", name="Think", description="Consider a hard question.")
CHEER = RuntimeGestureDescriptor(selector="cheer", name="Cheer", description="Celebrate good news.")
LOADOUT = harness.Loadout(name="starters", gestures=(WAVE, THINK))


def _reply(*, gesture: str | None, speech: str = "Sure thing.", tone: str = "neutral") -> str:
    return json.dumps(
        {
            "emotional_tone": tone,
            "emotional_intensity": 3,
            "gesture": gesture,
            "speech": speech,
            "display": None,
            "remember": None,
        }
    )


class _FakeClock:
    """A monotonic clock that only moves when a fake model client says time passed."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


class _ReplyClient:
    """Fake model client answering each request from a callback and recording every request.

    With ``stream_text`` it streams the reply as one text delta before the final, as real clients do.
    With ``clock``, ``timing`` gives each request's seconds before its first text delta and seconds
    from then to its final, and the client advances the clock by them, suspending before the
    final the way a real client awaits the network. ``usage`` gives each request's reported usage.
    """

    def __init__(
        self,
        reply: Callable[[ModelClientRequest], str | Exception],
        *,
        stream_text: bool = False,
        clock: _FakeClock | None = None,
        timing: Callable[[ModelClientRequest], tuple[float, float]] = lambda _request: (0.0, 0.0),
        usage: Callable[[ModelClientRequest], Usage] = lambda _request: Usage(
            requests=1, input_tokens=1000, output_tokens=100, total_tokens=1100
        ),
    ) -> None:
        self.reply = reply
        self.stream_text = stream_text
        self.clock = clock
        self.timing = timing
        self.usage = usage
        self.requests: list[ModelClientRequest] = []

    async def stream(self, request: ModelClientRequest) -> AsyncIterator[ModelClientDelta]:
        self.requests.append(request)
        outcome = self.reply(request)
        if isinstance(outcome, Exception):
            raise outcome
        to_first_text, to_final = self.timing(request)
        if self.clock is not None:
            self.clock.now += to_first_text
        if self.stream_text:
            yield ModelClientDelta(kind="text_delta", text=outcome)
        if self.clock is not None:
            # Wait for the network as a real client does, so chat can hand on what already streamed.
            await asyncio.sleep(0)
            self.clock.now += to_final
        yield ModelClientDelta(
            kind="final",
            final=ModelClientFinal(
                text=outcome,
                usage=self.usage(request),
                usage_reported=getattr(self, "usage_reported", True),
            ),
        )
        yield ModelClientDelta(kind="done")

    async def aclose(self) -> None:
        return None


def _user_text(request: ModelClientRequest) -> str:
    content = request.prompt.messages[-1]["content"]
    assert isinstance(content, str)
    return content


def _provider(*, priced: bool = False) -> ModelProvider:
    return ModelProvider(
        id="OpenAIHTTPAgent:gpt-eval",
        provider_type="OpenAIHTTPAgent",
        model="gpt-eval",
        model_label="GPT Eval",
        provider_label="OpenAI",
        capabilities=ModelProviderCapabilities(
            supports_streaming=True,
            structured_kinds=["main_structured_response"],
            structured_output_transport=STRUCTURED_OUTPUT_TRANSPORT_JSON_SCHEMA,
        ),
        pricing=(
            ModelProviderPricing(
                pricing_status="priced",
                currency="USD",
                billing_unit="1M_tokens",
                standard_input_price_per_million=Decimal("1.00"),
                standard_cached_input_price_per_million=Decimal("0.10"),
                standard_output_price_per_million=Decimal("4.00"),
            )
            if priced
            else ModelProviderPricing()
        ),
    )


def _registry(client: _ReplyClient, provider: ModelProvider) -> StaticModelClientRegistry:
    return StaticModelClientRegistry({provider.provider_type: client})


def _item(item_id: str, message: str, *acceptable: str | None, tags: tuple[str, ...] = ()) -> harness.PromptItem:
    return harness.PromptItem(id=item_id, message=message, acceptable=tuple(acceptable), tags=tags)


def _plan(
    *,
    items: tuple[harness.PromptItem, ...] = (),
    chats: tuple[harness.ScriptedChat, ...] = (),
    loadouts: tuple[harness.Loadout, ...] = (LOADOUT,),
    repeats: int = 1,
    scripted_repeats: int = 1,
) -> harness.EvalPlan:
    return harness.EvalPlan(
        loadouts=loadouts,
        prompt_set=harness.PromptSet(items=items, scripted_chats=chats),
        repeats=repeats,
        scripted_repeats=scripted_repeats,
    )


async def test_prompt_and_schema_match_the_chat_assembly_for_the_loadout() -> None:
    provider = _provider()
    client = _ReplyClient(lambda _request: _reply(gesture="wave"))
    item = _item("greet", "Hi there!", "wave")

    await harness.run_evaluation(
        _plan(items=(item,)), model_provider=provider, registry=_registry(client, provider), max_calls=1
    )

    [request] = client.requests
    output_type = build_main_structured_response_model(
        agent_id=response_model_agent_id(DIRECT_CHAT_NODE_ID),
        gesture_ids=("wave", "think"),
    )
    expected = DirectChatPromptAssembler().assemble(
        user_message="Hi there!",
        anima_identity=harness.ANIMA_IDENTITY,
        anima_name=harness.ANIMA_NAME,
        response_format_guidance=gesture_response_guidance(
            main_structured_response_guidance(provider, output_type),
            LOADOUT.gestures,
            context_window_tokens=provider.context_window_tokens,
        ),
        # The eval speaks no reply, so its turns get the no-tags rule, as chat does.
        speech_guidance=speech_instruction(None),
    )
    assert request.prompt.messages == expected.messages
    assert "- wave: Greet or say goodbye.\n- think: Consider a hard question." in str(
        request.prompt.messages[0]["content"]
    )
    assert request.prompt.response_format == main_structured_response_format_for_model(
        provider, output_type, name=turn_response_schema_name(DirectChatOptions())
    )
    response_format: Any = request.prompt.response_format
    assert response_format["json_schema"]["schema"]["properties"]["gesture"]["enum"] == [None, "wave", "think"]
    # No memory tools, memory map or MEMORIES.md: the Anima is neutral and memoryless.
    assert request.prompt.tools == ()
    assert request.model_provider is provider
    # The turn is incognito, so the provider is asked not to store it.
    assert request.provider_options.store is False


def test_fit_counts_null_only_when_the_item_accepts_null() -> None:
    assert harness.score_fit("wave", ("wave", "think"))
    assert not harness.score_fit("think", ("wave",))
    assert not harness.score_fit(None, ("wave",))
    assert harness.score_fit(None, ("wave", None))
    assert not harness.score_fit("wave", (None,))


def test_turns_without_a_gesture_end_runs_and_do_not_count_as_distinct() -> None:
    gestures = ["wave", "wave", None, "think", "think", "think", None, None, "wave"]

    assert harness.longest_run(gestures) == (3, "think")
    assert harness.longest_run([None, None]) == (0, None)
    assert harness.distinct_gestures(gestures) == 2


async def test_single_turn_scores_fit_null_and_errors_per_loadout() -> None:
    provider = _provider(priced=True)
    replies: dict[str, str | Exception] = {
        "Hello!": _reply(gesture="wave", speech="Hello to you too."),
        "What is 2 + 2?": _reply(gesture=None, speech="Four."),
        "I got the job!": _reply(gesture="think", speech="Congratulations!"),
        "Broken": ModelClientProviderError("provider failed", code="provider_failed"),
    }
    client = _ReplyClient(lambda request: replies[_user_text(request)])
    items = (
        _item("greet", "Hello!", "wave", tags=("greeting",)),
        _item("math", "What is 2 + 2?", None, "think", tags=("neutral",)),
        _item("news", "I got the job!", "cheer", tags=("joy",)),
        _item("broken", "Broken", "wave"),
    )

    results = await harness.run_evaluation(
        _plan(items=items), model_provider=provider, registry=_registry(client, provider), max_calls=4
    )

    [loadout] = results["loadouts"]
    single = loadout["single_turn"]
    assert (single["runs"], single["scored"], single["errors"]) == (4, 3, 1)
    assert (single["fits"], single["nulls"]) == (2, 1)
    assert single["fit_rate"] == pytest.approx(2 / 3)
    assert single["null_rate"] == pytest.approx(1 / 3)
    assert single["by_tag"]["joy"] == {"scored": 1, "fits": 0, "fit_rate": 0.0}
    # "news" accepts only an unequipped Gesture, so it cannot fit this loadout.
    assert loadout["coverable_items"] == 3
    assert loadout["gesture_count"] == 2
    assert loadout["gesture_list_bytes"] == len(render_available_gestures(LOADOUT.gestures).encode())
    assert loadout["instruction_bytes"] > loadout["gesture_list_bytes"]
    turns = {turn["conversation_id"]: turn for turn in results["turns"]}
    assert turns["greet"]["gesture"] == "wave" and turns["greet"]["fit"] is True
    assert turns["math"]["gesture"] is None and turns["math"]["fit"] is True
    assert turns["broken"]["error"] == "provider_failed" and turns["broken"]["fit"] is None
    assert results["calls"] == {"estimated": 4, "max": 4, "made": 4}
    assert results["usage"]["input_tokens"] == 3000
    assert results["usage"]["output_tokens"] == 300
    assert results["cost"]["priced"] is True
    assert results["cost"]["total"] == "0.004200"
    assert results["aborted"] is None


async def test_run_refuses_to_start_when_the_estimate_exceeds_the_budget() -> None:
    provider = _provider()
    client = _ReplyClient(lambda _request: _reply(gesture="wave"))
    plan = _plan(items=(_item("a", "One", "wave"), _item("b", "Two", "wave")), repeats=2)

    with pytest.raises(harness.CallBudgetExceeded, match="4 model calls"):
        await harness.run_evaluation(plan, model_provider=provider, registry=_registry(client, provider), max_calls=3)

    assert client.requests == []


async def test_run_stops_before_a_call_beyond_the_budget() -> None:
    provider = _provider()
    # The first reply is not JSON, so chat spends a second call on its structured repair.
    replies = iter(["not json at all", _reply(gesture="wave"), _reply(gesture="wave")])
    client = _ReplyClient(lambda _request: next(replies))
    plan = _plan(items=(_item("a", "One", "wave"), _item("b", "Two", "wave")))

    results = await harness.run_evaluation(
        plan, model_provider=provider, registry=_registry(client, provider), max_calls=2
    )

    assert len(client.requests) == 2
    assert results["aborted"] == "max_calls"
    assert results["calls"]["made"] == 2
    # The repaired first turn is kept; the refused second turn is left out rather than scored.
    assert [turn["conversation_id"] for turn in results["turns"]] == ["a"]
    assert results["turns"][0]["calls"] == 2
    assert results["turns"][0]["structured_recovery"] == "repaired"
    assert results["turns"][0]["gesture"] == "wave"


async def test_a_refused_structured_repair_drops_the_turn_instead_of_scoring_it() -> None:
    provider = _provider()
    client = _ReplyClient(lambda _request: "not json at all")

    results = await harness.run_evaluation(
        _plan(items=(_item("a", "One", "wave"),)),
        model_provider=provider,
        registry=_registry(client, provider),
        max_calls=1,
    )

    # Without the cap chat would speak the plain-text fallback and play no Gesture; that is not a selection.
    assert len(client.requests) == 1
    assert results["aborted"] == "max_calls"
    assert results["turns"] == []
    assert results["loadouts"][0]["single_turn"]["runs"] == 0


async def test_a_reply_salvaged_from_streamed_speech_is_replayed_as_chat_salvages_it() -> None:
    provider = _provider()
    truncated = '{"emotional_tone":"joy","emotional_intensity":4,"gesture":"wave","speech":"Hello there. Nice to'
    replies = {"Hi!": truncated, "Again?": _reply(gesture=None)}
    client = _ReplyClient(lambda request: replies[_user_text(request)], stream_text=True)
    chat = harness.ScriptedChat(id="c", turns=("Hi!", "Again?"))

    results = await harness.run_evaluation(
        _plan(chats=(chat,)), model_provider=provider, registry=_registry(client, provider), max_calls=2
    )

    first = results["turns"][0]
    # Speech already streamed, so chat keeps the streamed reply instead of requesting a repair.
    assert (first["structured_recovery"], first["calls"]) == ("salvaged", 1)
    assert (first["gesture"], first["replayed_gesture"], first["gesture_mismatch"]) == ("wave", "wave", False)
    replayed = json.loads(str(client.requests[1].prompt.messages[2]["content"]))
    assert replayed["gesture"] == "wave"
    assert replayed["emotional_tone"] == "joy"
    assert replayed["speech"].startswith("Hello there.")


async def test_a_gesture_outside_the_loadout_is_dropped_and_flagged() -> None:
    provider = _provider()
    client = _ReplyClient(lambda _request: _reply(gesture="cheer"))

    results = await harness.run_evaluation(
        _plan(items=(_item("a", "Yay!", "cheer", None),)),
        model_provider=provider,
        registry=_registry(client, provider),
        max_calls=1,
    )

    [turn] = results["turns"]
    assert (turn["gesture"], turn["replayed_gesture"], turn["gesture_mismatch"]) == (None, "cheer", True)
    assert turn["fit"] is True


async def test_scripted_chats_repeat_separately_and_loadouts_interleave_per_item() -> None:
    provider = _provider()
    client = _ReplyClient(lambda _request: _reply(gesture="wave"))
    client.native_context_compaction = True  # type: ignore[attr-defined]
    everything = harness.Loadout(name="all", gestures=(CHEER, THINK, WAVE))
    plan = _plan(
        items=(_item("a", "One", "wave"),),
        chats=(harness.ScriptedChat(id="c", turns=("Hi!", "Bye!")),),
        loadouts=(LOADOUT, everything),
        repeats=2,
        scripted_repeats=1,
    )

    results = await harness.run_evaluation(
        plan, model_provider=provider, registry=_registry(client, provider), max_calls=8
    )

    assert plan.estimated_calls == 2 * (2 * 1 + 1 * 2)
    assert [(turn["loadout"], turn["conversation_id"], turn["repeat"], turn["turn"]) for turn in results["turns"]] == [
        ("starters", "a", 1, 1),
        ("all", "a", 1, 1),
        ("starters", "a", 2, 1),
        ("all", "a", 2, 1),
        ("starters", "c", 1, 1),
        ("starters", "c", 1, 2),
        ("all", "c", 1, 1),
        ("all", "c", 1, 2),
    ]
    assert (results["repeats"], results["scripted_repeats"], results["incognito"]) == (2, 1, True)
    assert results["model"]["native_context_compaction"] is True


async def test_partial_results_are_handed_over_when_the_run_fails() -> None:
    provider = _provider()
    replies: dict[str, str | Exception] = {"One": _reply(gesture="wave"), "Two": RuntimeError("network down")}
    client = _ReplyClient(lambda request: replies[_user_text(request)])
    finished: list[dict[str, Any]] = []

    with pytest.raises(RuntimeError, match="network down"):
        await harness.run_evaluation(
            _plan(items=(_item("a", "One", "wave"), _item("b", "Two", "wave"))),
            model_provider=provider,
            registry=_registry(client, provider),
            max_calls=2,
            on_finish=finished.append,
        )

    [results] = finished
    assert results["aborted"] == "error: RuntimeError"
    assert [turn["conversation_id"] for turn in results["turns"]] == ["a"]


async def test_scripted_chat_carries_its_visible_history_turn_by_turn() -> None:
    provider = _provider()
    gestures = {"Hello?": "wave", "Hi!": "wave", "Tell me a riddle.": "think", "Bye!": "wave"}
    client = _ReplyClient(
        lambda request: _reply(gesture=gestures[_user_text(request)], speech=f"Reply to {_user_text(request)}")
    )
    chat = harness.ScriptedChat(id="long", turns=("Hi!", "Tell me a riddle.", "Bye!"))
    single = _item("solo", "Hello?", "wave")

    results = await harness.run_evaluation(
        _plan(items=(single,), chats=(chat,)),
        model_provider=provider,
        registry=_registry(client, provider),
        max_calls=4,
    )

    solo_request, first, second, third = client.requests
    # Incognito turns: the provider stores nothing and no Responses cursor replaces the replayed history.
    assert all(request.provider_options.store is False for request in client.requests)
    assert all(request.continuation is None for request in client.requests)
    # Incognito turns have no memory map, so no turn context precedes the user message.
    assert [message["role"] for message in solo_request.prompt.messages] == ["system", "user"]
    assert [message["role"] for message in first.prompt.messages] == ["system", "user"]
    first_reply = _reply(gesture="wave", speech="Reply to Hi!")
    second_reply = _reply(gesture="think", speech="Reply to Tell me a riddle.")
    assert [(message["role"], message["content"]) for message in second.prompt.messages[1:]] == [
        ("user", "Hi!"),
        ("assistant", first_reply),
        ("user", "Tell me a riddle."),
    ]
    assert [(message["role"], message["content"]) for message in third.prompt.messages[1:5]] == [
        ("user", "Hi!"),
        ("assistant", first_reply),
        ("user", "Tell me a riddle."),
        ("assistant", second_reply),
    ]
    [scripted] = results["loadouts"][0]["scripted"]
    assert scripted == {
        "chat": "long",
        "repeat": 1,
        "turns": 3,
        "scored": 3,
        "errors": 0,
        "nulls": 0,
        "distinct_gestures": 2,
        "longest_run": 1,
        "longest_run_gesture": "wave",
    }


async def test_each_turn_records_its_latency_and_first_speech_time() -> None:
    provider = _provider()
    clock = _FakeClock()
    client = _ReplyClient(
        lambda _request: _reply(gesture="wave", speech="Hello there."),
        stream_text=True,
        clock=clock,
        timing=lambda _request: (0.25, 0.5),
    )

    results = await harness.run_evaluation(
        _plan(items=(_item("a", "Hi!", "wave"),)),
        model_provider=provider,
        registry=_registry(client, provider),
        max_calls=1,
        clock=clock,
    )

    [turn] = results["turns"]
    # Sent at 0.0; speech streamed at 0.25; the final reply arrived at 0.75.
    assert turn["latency_seconds"] == pytest.approx(0.75)
    assert turn["first_output_seconds"] == pytest.approx(0.25)
    assert turn["call_latencies"] == [{"seconds": pytest.approx(0.75), "first_text_seconds": pytest.approx(0.25)}]


async def test_a_repaired_turn_times_every_call_and_its_latency_covers_them_all() -> None:
    provider = _provider()
    clock = _FakeClock()
    # The first reply is not JSON and streams no speech, so chat requests a structured repair, which streams.
    replies = iter(["not json at all", _reply(gesture="wave", speech="Fixed.")])
    timings = iter([(0.5, 1.0), (0.25, 0.25)])
    client = _ReplyClient(
        lambda _request: next(replies), stream_text=True, clock=clock, timing=lambda _request: next(timings)
    )

    results = await harness.run_evaluation(
        _plan(items=(_item("a", "Hi!", "wave"),)),
        model_provider=provider,
        registry=_registry(client, provider),
        max_calls=2,
        clock=clock,
    )

    [turn] = results["turns"]
    assert turn["structured_recovery"] == "repaired"
    assert turn["latency_seconds"] == pytest.approx(2.0)
    assert turn["call_latencies"] == [
        {"seconds": pytest.approx(1.5), "first_text_seconds": pytest.approx(0.5)},
        {"seconds": pytest.approx(0.5), "first_text_seconds": pytest.approx(0.25)},
    ]
    # Speech comes from the repair's first streamed sentence: the first call's 1.5 s plus 0.25 s.
    assert turn["first_output_seconds"] == pytest.approx(1.75)


async def test_a_turn_whose_reply_arrives_only_in_its_final_has_first_output_at_the_end() -> None:
    provider = _provider()
    clock = _FakeClock()
    client = _ReplyClient(lambda _request: _reply(gesture="wave"), clock=clock, timing=lambda _request: (0.5, 1.0))

    results = await harness.run_evaluation(
        _plan(items=(_item("a", "Hi!", "wave"),)),
        model_provider=provider,
        registry=_registry(client, provider),
        max_calls=1,
        clock=clock,
    )

    [turn] = results["turns"]
    assert turn["first_output_seconds"] == pytest.approx(1.5)
    assert turn["call_latencies"] == [{"seconds": pytest.approx(1.5), "first_text_seconds": None}]
    # No text streamed, so the provider's time to first token is unknown for this turn.
    first_token = results["loadouts"][0]["latency"]["single_turn"]["first_token_seconds"]
    assert first_token == {"turns": 0, "median": None, "p90": None, "mean": None}
    summary = harness.render_summary(results)
    assert "| starters | Single-turn | 1 | 1.50 | 1.50 | 1.50 | n/a (n=0) | n/a | n/a | 1.50 | 1.50 | 1.50 |" in summary


async def test_a_failed_turn_has_a_latency_but_no_first_output() -> None:
    provider = _provider()
    clock = _FakeClock()

    def reply(_request: ModelClientRequest) -> str | Exception:
        clock.now += 3.0
        return ModelClientProviderError("provider failed", code="provider_failed")

    client = _ReplyClient(reply, clock=clock)

    results = await harness.run_evaluation(
        _plan(items=(_item("a", "Hi!", "wave"),)),
        model_provider=provider,
        registry=_registry(client, provider),
        max_calls=1,
        clock=clock,
    )

    [turn] = results["turns"]
    assert turn["error"] == "provider_failed"
    assert turn["latency_seconds"] == pytest.approx(3.0)
    assert turn["first_output_seconds"] is None
    # Failed turns stay out of the latency statistics.
    assert results["loadouts"][0]["latency"]["single_turn"]["turns"] == 0


async def test_latency_statistics_cover_single_turn_items_and_scripted_turns_separately() -> None:
    provider = _provider()
    clock = _FakeClock()
    # Seconds to first speech and from then to the final reply, by user message.
    timings = {
        "One": (1.0, 1.0),
        "Two": (1.0, 2.0),
        "Three": (2.0, 2.0),
        "Four": (1.0, 9.0),
        "Hi!": (0.5, 0.5),
        "Bye!": (0.5, 1.5),
    }
    client = _ReplyClient(
        lambda _request: _reply(gesture="wave"),
        stream_text=True,
        clock=clock,
        timing=lambda request: timings[_user_text(request)],
    )
    items = tuple(_item(message.lower(), message, "wave") for message in ("One", "Two", "Three", "Four"))
    chat = harness.ScriptedChat(id="c", turns=("Hi!", "Bye!"))

    results = await harness.run_evaluation(
        _plan(items=items, chats=(chat,)),
        model_provider=provider,
        registry=_registry(client, provider),
        max_calls=6,
        clock=clock,
    )

    latency = results["loadouts"][0]["latency"]
    # Single-turn latencies 2, 3, 4 and 10 s; first text and speech at 1, 1, 2 and 1 s. p90 is the nearest rank.
    single_first = {"turns": 4, "median": pytest.approx(1.0), "p90": pytest.approx(2.0), "mean": pytest.approx(1.25)}
    assert latency["single_turn"] == {
        "turns": 4,
        "latency_seconds": {"median": pytest.approx(3.5), "p90": pytest.approx(10.0), "mean": pytest.approx(4.75)},
        "first_token_seconds": single_first,
        "first_output_seconds": single_first,
    }
    scripted_first = {"turns": 2, "median": pytest.approx(0.5), "p90": pytest.approx(0.5), "mean": pytest.approx(0.5)}
    assert latency["scripted"] == {
        "turns": 2,
        "latency_seconds": {"median": pytest.approx(1.5), "p90": pytest.approx(2.0), "mean": pytest.approx(1.5)},
        "first_token_seconds": scripted_first,
        "first_output_seconds": scripted_first,
    }
    summary = harness.render_summary(results)
    assert "## Latency" in summary
    assert "| Loadout | Kind | Turns | Median s |" in summary
    assert "| starters | Single-turn | 4 | 3.50 | 10.00 | 4.75 | 1.00 | 2.00 | 1.25 | 1.00 | 2.00 | 1.25 |" in summary
    assert "| starters | Scripted | 2 | 1.50 | 2.00 | 1.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 |" in summary


def _usage(*, input_tokens: int, cached: int, cache_write: int, output: int, reasoning: int) -> Usage:
    return Usage(
        requests=1,
        input_tokens=input_tokens,
        output_tokens=output,
        total_tokens=input_tokens + output,
        input_tokens_details=UsageInputDetails(cached_tokens=cached, cache_write_tokens=cache_write),
        output_tokens_details=UsageOutputDetails(reasoning_tokens=reasoning),
    )


async def test_token_and_cost_statistics_per_turn_cover_single_turn_items_and_scripted_turns_separately() -> None:
    provider = _provider()
    # Input, cached, cache-write, output and reasoning tokens by user message.
    usages = {
        "One": _usage(input_tokens=1000, cached=0, cache_write=1000, output=100, reasoning=0),
        "Two": _usage(input_tokens=1000, cached=1000, cache_write=0, output=200, reasoning=0),
        "Three": _usage(input_tokens=1000, cached=1000, cache_write=0, output=300, reasoning=0),
        "Four": _usage(input_tokens=1000, cached=500, cache_write=0, output=1000, reasoning=0),
        "Hi!": _usage(input_tokens=2000, cached=1000, cache_write=0, output=50, reasoning=20),
        "Bye!": _usage(input_tokens=3000, cached=2000, cache_write=0, output=70, reasoning=40),
    }
    client = _ReplyClient(lambda _request: _reply(gesture="wave"), usage=lambda request: usages[_user_text(request)])
    items = tuple(_item(message.lower(), message, "wave") for message in ("One", "Two", "Three", "Four"))
    prices = harness.parse_token_prices("input=1,cached_input=0.1,cache_write=1.25,output=4")

    results = await harness.run_evaluation(
        _plan(items=items, chats=(harness.ScriptedChat(id="c", turns=("Hi!", "Bye!")),)),
        model_provider=provider,
        registry=_registry(client, provider),
        max_calls=6,
        token_prices=prices,
    )

    turns = {turn["conversation_id"] + str(turn["turn"]): turn for turn in results["turns"]}
    # USD per 1M tokens: 1000 cache-write x 1.25 + 100 output x 4 = 0.00165.
    assert turns["one1"]["estimated_cost_usd"] == pytest.approx(0.00165)
    # 500 uncached x 1 + 500 cached x 0.1 + 1000 output x 4 = 0.00455.
    assert turns["four1"]["estimated_cost_usd"] == pytest.approx(0.00455)
    tokens = results["loadouts"][0]["tokens"]
    single, scripted = tokens["single_turn"], tokens["scripted"]
    assert single["turns"] == 4 and single["unreported_turns"] == 0
    assert single["output_tokens"] == {"total": 1600, "median": 250, "p90": 1000, "mean": 400}
    assert single["cached_input_tokens"] == {"total": 2500, "median": 750, "p90": 1000, "mean": 625}
    assert single["reasoning_tokens"]["total"] == 0
    # Single-turn costs 0.00165, 0.0009, 0.0013 and 0.00455 USD.
    assert single["estimated_cost_usd"]["total"] == pytest.approx(0.0084)
    assert single["estimated_cost_usd"]["median"] == pytest.approx(0.001475)
    assert single["estimated_cost_usd"]["p90"] == pytest.approx(0.00455)
    assert scripted["turns"] == 2
    assert scripted["reasoning_tokens"] == {"total": 60, "median": 30, "p90": 40, "mean": 30}
    assert scripted["input_tokens"]["total"] == 5000
    # Run total: the same rates over all calls' usage.
    assert results["price_estimate"]["total_usd"] == pytest.approx(0.0084 + 0.0013 + 0.00148)
    assert results["price_estimate"]["rates_per_million_usd"] == {
        "input": "1",
        "cached_input": "0.1",
        "cache_write": "1.25",
        "output": "4",
    }

    summary = harness.render_summary(results)
    assert "## Tokens and cost per turn" in summary
    assert "| Loadout | Kind | Turns | Measure |" in summary
    assert "| starters | Single-turn | 4 | Output tokens | 1,600 | 250 | 1,000 | 400 |" in summary
    # Nothing in the single-turn group reported reasoning: say so rather than print zeros.
    assert "| starters | Single-turn | 4 | Reasoning tokens | none reported | | | |" in summary
    assert "| starters | Scripted | 2 | Reasoning tokens | 60 | 30 | 40 | 30 |" in summary
    assert (
        "| starters | Single-turn | 4 | Estimated cost (USD) | 0.008400 | 0.001475 | 0.004550 | 0.002100 |" in summary
    )
    assert "estimated from the --price rates" in summary


def test_token_prices_parse_every_rate_and_reject_incomplete_or_unknown_ones() -> None:
    prices = harness.parse_token_prices("input=0.10, cached_input=0.01,cache_write=0.125,output=0.50")

    assert (prices.input, prices.cached_input, prices.cache_write, prices.output) == (
        Decimal("0.10"),
        Decimal("0.01"),
        Decimal("0.125"),
        Decimal("0.50"),
    )
    with pytest.raises(harness.EvalInputError, match="cache_write"):
        harness.parse_token_prices("input=0.10,cached_input=0.01,output=0.50")
    with pytest.raises(harness.EvalInputError, match="unknown"):
        harness.parse_token_prices("input=0.10,cached_input=0.01,cache_write=0.1,output=0.50,extra=1")
    with pytest.raises(harness.EvalInputError, match="output"):
        harness.parse_token_prices("input=0.10,cached_input=0.01,cache_write=0.1,output=-1")
    with pytest.raises(harness.EvalInputError, match="duplicate rate 'input'"):
        harness.parse_token_prices("input=0.10,cached_input=0.01,cache_write=0.1,output=0.5,input=0.2")
    for bad in ("nan", "NaN", "Infinity", "-inf", "abc", ""):
        with pytest.raises(harness.EvalInputError, match="output"):
            harness.parse_token_prices(f"input=0.10,cached_input=0.01,cache_write=0.1,output={bad}")


async def test_a_failed_call_inside_a_successful_turn_does_not_hide_the_turns_billed_usage() -> None:
    # A row with a context window: an oversized prompt gets one retry with less history.
    provider = replace(_provider(), context_window_tokens=1_000_000)
    calls: list[str] = []

    def reply(request: ModelClientRequest) -> str | Exception:
        calls.append(_user_text(request))
        if calls == ["Hi!", "Again?"]:
            return ModelClientProviderError(
                "The prompt is too long",
                code="provider_failed",
                raw_metadata={"provider_error_code": "context_length_exceeded"},
            )
        return _reply(gesture="wave")

    client = _ReplyClient(reply)
    prices = harness.parse_token_prices("input=1,cached_input=0.1,cache_write=1.25,output=4")

    results = await harness.run_evaluation(
        _plan(chats=(harness.ScriptedChat(id="c", turns=("Hi!", "Again?")),)),
        model_provider=provider,
        registry=_registry(client, provider),
        max_calls=3,
        token_prices=prices,
    )

    second = results["turns"][1]
    assert (second["error"], second["calls"]) == (None, 2)
    # The failed call reported nothing and billed nothing; the retry's usage is the turn's.
    assert second["usage"]["unreported_calls"] == 0
    assert second["usage"]["input_tokens"] == 1000
    assert second["estimated_cost_usd"] == pytest.approx(0.0014)
    scripted = results["loadouts"][0]["tokens"]["scripted"]
    assert (scripted["turns"], scripted["unreported_turns"]) == (2, 0)
    assert results["usage"]["unreported_calls"] == 0


async def test_summary_says_why_token_statistics_are_missing_when_no_turn_reported_usage() -> None:
    provider = _provider()
    client = _ReplyClient(lambda _request: _reply(gesture="wave"))
    client.usage_reported = False  # type: ignore[attr-defined]

    results = await harness.run_evaluation(
        _plan(items=(_item("a", "Hi!", "wave"),)),
        model_provider=provider,
        registry=_registry(client, provider),
        max_calls=1,
    )

    summary = harness.render_summary(results)
    assert "## Tokens and cost per turn" in summary
    assert "Omitted: no successful turn reported usage (1 turn(s) without usage)." in summary


def test_summary_renders_results_written_before_latency_was_recorded() -> None:
    provider = _provider()
    results = {
        "model": {"model_provider_id": provider.id, "reasoning_effort": None},
        "prompt_set": {"items": 1, "scripted_chats": 0, "scripted_turns": 0},
        "repeats": 1,
        "scripted_repeats": 1,
        "calls": {"made": 1, "estimated": 1, "max": 1},
        "usage": dict.fromkeys(
            (
                "input_tokens",
                "cached_input_tokens",
                "cache_write_tokens",
                "output_tokens",
                "reasoning_tokens",
                "total_tokens",
                "unreported_calls",
            ),
            0,
        ),
        "cost": {"priced": False, "unpriced_reason": "no pricing"},
        "aborted": None,
        "loadouts": [
            {
                "name": "starters",
                "gesture_count": 2,
                "gesture_list_bytes": 10,
                "instruction_bytes": 20,
                "coverable_items": 1,
                "single_turn": {
                    "runs": 1,
                    "scored": 1,
                    "errors": 0,
                    "fits": 1,
                    "fit_rate": 1.0,
                    "nulls": 0,
                    "null_rate": 0.0,
                    "by_tag": {},
                },
                "scripted": [],
            }
        ],
    }

    summary = harness.render_summary(results)

    assert "| starters | 2 |" in summary
    assert "## Latency" not in summary
    assert "## Tokens and cost per turn" not in summary


def test_inputs_load_and_reject_malformed_files(tmp_path: Path) -> None:
    loadout_path = tmp_path / "starters.json"
    loadout_path.write_text(json.dumps([{"selector": "wave", "name": "Wave", "description": "Greet."}]))
    prompts_path = tmp_path / "prompts.json"
    prompts_path.write_text(
        json.dumps(
            {
                "items": [{"id": "greet", "message": "Hi", "acceptable": ["wave", None], "tags": ["greeting"]}],
                "scripted_chats": [{"id": "long", "turns": ["Hi", "Bye"]}],
            }
        )
    )

    loadout = harness.load_loadout(loadout_path)
    prompt_set = harness.load_prompt_set(prompts_path)

    assert loadout == harness.Loadout(
        name="starters", gestures=(RuntimeGestureDescriptor(selector="wave", name="Wave", description="Greet."),)
    )
    assert prompt_set.items == (_item("greet", "Hi", "wave", None, tags=("greeting",)),)
    assert prompt_set.scripted_chats == (harness.ScriptedChat(id="long", turns=("Hi", "Bye")),)

    duplicate = tmp_path / "duplicate.json"
    duplicate.write_text(json.dumps([{"selector": "wave", "name": "A", "description": "a"}] * 2))
    with pytest.raises(harness.EvalInputError, match="duplicate selector 'wave'"):
        harness.load_loadout(duplicate)
    no_acceptable = tmp_path / "no-acceptable.json"
    no_acceptable.write_text(json.dumps({"items": [{"id": "x", "message": "Hi", "acceptable": []}]}))
    with pytest.raises(harness.EvalInputError, match="acceptable"):
        harness.load_prompt_set(no_acceptable)


def _write_inputs(tmp_path: Path) -> tuple[Path, Path]:
    loadout_path = tmp_path / "starters.json"
    loadout_path.write_text(
        json.dumps([{"selector": g.selector, "name": g.name, "description": g.description} for g in (WAVE, THINK)])
    )
    prompts_path = tmp_path / "prompts.json"
    prompts_path.write_text(
        json.dumps(
            {
                "items": [
                    {"id": "greet", "message": "Hello!", "acceptable": ["wave"]},
                    {"id": "news", "message": "I got the job!", "acceptable": ["cheer"]},
                ],
                "scripted_chats": [{"id": "long", "turns": ["Hi!", "Bye!"]}],
            }
        )
    )
    return loadout_path, prompts_path


def test_dry_run_prints_the_plan_without_resolving_a_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    loadout_path, prompts_path = _write_inputs(tmp_path)

    async def no_model(_model_provider_id: str) -> ModelProvider:
        raise AssertionError("a dry run must not resolve a model")

    monkeypatch.setattr(harness, "load_model_provider", no_model)
    output_dir = tmp_path / "out"

    exit_code = harness.main(
        [
            "--loadout",
            str(loadout_path),
            "--prompts",
            str(prompts_path),
            "--repeats",
            "3",
            "--scripted-repeats",
            "2",
            "--max-calls",
            "9",
            "--output-dir",
            str(output_dir),
            "--dry-run",
        ]
    )

    out = capsys.readouterr().out
    assert exit_code == 0
    # One loadout: 3 repeats x 2 single-turn items + 2 scripted repeats x 2 scripted turns.
    assert "Estimated model calls: 10" in out
    assert "exceeds --max-calls 9, so the run will not start" in out
    gesture_bytes = len(render_available_gestures((WAVE, THINK)).encode())
    assert f"starters: 2 Gestures, {gesture_bytes} gesture-list bytes, 1/2 items coverable" in out
    assert re.search(r"starters: ~\d+ input tokens per first turn", out)
    # Chat lists equipped Gestures sorted by selector; this file lists wave before think.
    assert "starters is not in production order" in out
    assert "Acceptable selectors in no loadout: cheer" in out
    assert not output_dir.exists()


def test_main_rejects_a_bad_price_before_reading_the_catalog(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    loadout_path, prompts_path = _write_inputs(tmp_path)

    async def no_catalog(_model_provider_id: str) -> ModelProvider:
        raise AssertionError("a bad --price must not read the model catalog")

    monkeypatch.setattr(harness, "load_model_provider", no_catalog)
    output_dir = tmp_path / "out"

    exit_code = harness.main(
        [
            "--loadout",
            str(loadout_path),
            "--prompts",
            str(prompts_path),
            "--model-provider-id",
            "OpenAIHTTPAgent:gpt-eval",
            "--max-calls",
            "10",
            "--price",
            "input=0.1,cached_input=0.01,output=0.5",
            "--output-dir",
            str(output_dir),
        ]
    )

    assert exit_code == 2
    assert "--price: missing cache_write" in capsys.readouterr().err
    assert not output_dir.exists()


def test_main_refuses_an_over_budget_plan_before_reading_the_catalog(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    loadout_path, prompts_path = _write_inputs(tmp_path)

    async def no_catalog(_model_provider_id: str) -> ModelProvider:
        raise AssertionError("an over-budget plan must not read the model catalog")

    def no_registry() -> StaticModelClientRegistry:
        raise AssertionError("an over-budget plan must not build model clients")

    monkeypatch.setattr(harness, "load_model_provider", no_catalog)
    monkeypatch.setattr(harness, "build_registry", no_registry)
    output_dir = tmp_path / "out"

    exit_code = harness.main(
        [
            "--loadout",
            str(loadout_path),
            "--prompts",
            str(prompts_path),
            "--model-provider-id",
            "OpenAIHTTPAgent:gpt-eval",
            "--max-calls",
            "3",
            "--output-dir",
            str(output_dir),
        ]
    )

    captured = capsys.readouterr()
    assert exit_code == 2
    assert "so the run will not start" in captured.out
    assert "The plan needs 4 model calls, more than --max-calls 3" in captured.err
    assert not output_dir.exists()


def test_real_run_writes_results_and_a_summary_without_raw_replies(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    loadout_path, prompts_path = _write_inputs(tmp_path)
    loaded_prompts_sha256 = hashlib.sha256(prompts_path.read_bytes()).hexdigest()
    provider = _provider()

    def reply(request: ModelClientRequest) -> str:
        # Editing an input mid-run must not change the recorded hash of what the run loaded.
        prompts_path.write_text("{}")
        return _reply(gesture="wave", speech=f"SECRET-SPEECH {_user_text(request)}")

    client = _ReplyClient(reply)

    async def load_model_provider(model_provider_id: str) -> ModelProvider:
        assert model_provider_id == provider.id
        return provider

    monkeypatch.setattr(harness, "load_model_provider", load_model_provider)
    monkeypatch.setattr(harness, "build_registry", lambda: _registry(client, provider))
    output_dir = tmp_path / "out"

    exit_code = harness.main(
        [
            "--loadout",
            str(loadout_path),
            "--prompts",
            str(prompts_path),
            "--model-provider-id",
            provider.id,
            "--max-calls",
            "4",
            "--price",
            "input=1,cached_input=0.1,cache_write=1.25,output=4",
            "--output-dir",
            str(output_dir),
        ]
    )

    assert exit_code == 0
    assert len(client.requests) == 4
    results = json.loads((output_dir / "results.json").read_text())
    assert results["model"]["model_provider_id"] == provider.id
    assert results["inputs"]["prompt_set"] == {"path": str(prompts_path), "sha256": loaded_prompts_sha256}
    assert [loadout["name"] for loadout in results["loadouts"]] == ["starters"]
    # Four calls of 1000 uncached input tokens at $1 and 100 output tokens at $4 per 1M.
    assert results["price_estimate"]["total_usd"] == pytest.approx(0.0056)
    summary = (output_dir / "summary.md").read_text()
    assert "| starters | 2 |" in summary
    assert "50.0% (1/2)" in summary
    assert "SECRET-SPEECH" not in summary
    assert harness.ANIMA_IDENTITY not in summary
    assert str(output_dir / "summary.md") in capsys.readouterr().out


def _write_long_description_loadout(loadout_path: Path) -> tuple[RuntimeGestureDescriptor, ...]:
    gestures = (THINK, replace(WAVE, description="Greet or say goodbye. " * 300))
    loadout_path.write_text(
        json.dumps([{"selector": g.selector, "name": g.name, "description": g.description} for g in gestures])
    )
    return gestures


def test_context_window_option_runs_the_model_as_if_its_row_recorded_that_window(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    loadout_path, prompts_path = _write_inputs(tmp_path)
    gestures = _write_long_description_loadout(loadout_path)
    provider = _provider()
    client = _ReplyClient(lambda _request: _reply(gesture="wave"))

    async def load_model_provider(_model_provider_id: str) -> ModelProvider:
        return provider

    monkeypatch.setattr(harness, "load_model_provider", load_model_provider)
    monkeypatch.setattr(harness, "build_registry", lambda: _registry(client, provider))
    output_dir = tmp_path / "out"

    exit_code = harness.main(
        [
            "--loadout",
            str(loadout_path),
            "--prompts",
            str(prompts_path),
            "--model-provider-id",
            provider.id,
            "--max-calls",
            "4",
            "--context-window",
            "12000",
            "--output-dir",
            str(output_dir),
        ]
    )

    assert exit_code == 0
    system_text = str(client.requests[0].prompt.messages[0]["content"])
    assert "Available Gestures for this Anima:\n- think\n- wave\n\n" in system_text
    results = json.loads((output_dir / "results.json").read_text())
    assert results["model"]["context_window_tokens"] == 12_000
    selectors_only = render_available_gestures(gestures, context_window_tokens=12_000)
    assert results["loadouts"][0]["gesture_list_bytes"] == len(selectors_only.encode())
    assert "context window 12,000 tokens" in (output_dir / "summary.md").read_text()


def test_dry_run_sizes_the_gesture_list_for_the_context_window_option(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    loadout_path, prompts_path = _write_inputs(tmp_path)
    gestures = _write_long_description_loadout(loadout_path)

    exit_code = harness.main(
        ["--loadout", str(loadout_path), "--prompts", str(prompts_path), "--context-window", "12000", "--dry-run"]
    )

    out = capsys.readouterr().out
    assert exit_code == 0
    assert "Context window: 12,000 tokens, as if the model row recorded it" in out
    selectors_only = render_available_gestures(gestures, context_window_tokens=12_000)
    assert f"starters: 2 Gestures, {len(selectors_only.encode())} gesture-list bytes" in out


async def test_model_provider_resolves_from_the_catalog_without_writing(async_session: AsyncSession) -> None:
    await SQLAlchemyModelProviderRepository(async_session).upsert_many([_provider()])
    await async_session.commit()

    loaded = await harness.load_model_provider("OpenAIHTTPAgent:gpt-eval")

    assert (loaded.id, loaded.model) == ("OpenAIHTTPAgent:gpt-eval", "gpt-eval")
    assert loaded.connection is not None and loaded.connection.id == "openai"
    with pytest.raises(harness.EvalInputError, match="Model provider not found"):
        await harness.load_model_provider("OpenAIHTTPAgent:missing")
    async with harness._read_only_model_providers() as model_providers:
        with pytest.raises(DBAPIError, match="read-only transaction"):
            await model_providers.set_hidden("OpenAIHTTPAgent:gpt-eval", hidden=True)


async def test_cli_composition_runs_against_the_mock_model_client(
    async_session: AsyncSession, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # ANIMAMA_LLM_SKIP makes chat's own registry serve the mock client: the smoke run the docs describe.
    monkeypatch.setenv("ANIMAMA_LLM_SKIP", "1")
    await SQLAlchemyModelProviderRepository(async_session).upsert_many([_provider()])
    await async_session.commit()
    loadout_path, prompts_path = _write_inputs(tmp_path)
    output_dir = tmp_path / "out"

    results = await harness._run(
        harness.EvalPlan(
            loadouts=(harness.load_loadout(loadout_path),), prompt_set=harness.load_prompt_set(prompts_path)
        ),
        model_provider_id="OpenAIHTTPAgent:gpt-eval",
        max_calls=4,
        reasoning_effort=None,
    )
    harness.write_outputs(results, output_dir)

    assert results["calls"]["made"] == 4
    assert results["aborted"] is None
    assert [turn["gesture"] for turn in results["turns"]] == [None, None, None, None]
    assert (output_dir / "summary.md").exists()


def test_real_run_requires_a_model_and_a_call_budget(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    loadout_path, prompts_path = _write_inputs(tmp_path)

    exit_code = harness.main(["--loadout", str(loadout_path), "--prompts", str(prompts_path)])

    assert exit_code == 2
    assert "--model-provider-id and --max-calls are required" in capsys.readouterr().err

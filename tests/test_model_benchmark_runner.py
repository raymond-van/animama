"""Offline tests for the model benchmark's prompt set, configurations, run loop, measures and dry run.

Every test uses a fake model client: the benchmark must never reach a provider here.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import AsyncIterator, Callable, Iterator, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from animama.adapters.repositories.sqlalchemy.model_provider_repo import SQLAlchemyModelProviderRepository
from animama.app.model_clients import (
    ModelClientDelta,
    ModelClientError,
    ModelClientFinal,
    ModelClientRequest,
    StaticModelClientRegistry,
)
from animama.app.services.anima_starter_service import STARTER_ANIMA_SPECS
from animama.domain import ModelProvider
from animama.domain.usage import Usage
from scripts.evals.benchmark import cli, configs, measures, options, planner, prompt_set, retry, runner
from scripts.evals.benchmark.speech_checks import check_speech
from scripts.evals.core import catalog
from scripts.evals.core.inputs import EvalInputError

FIXTURES = Path(__file__).parent / "fixtures" / "model_benchmark"
PROMPTS = FIXTURES / "prompts.json"


def _reply(gesture: str | None = "wave", speech: str = "Hello there. Nice to see you.", **extra: Any) -> str:
    return json.dumps(
        {
            "emotional_tone": extra.get("tone", "happy"),
            "emotional_intensity": extra.get("intensity", 4),
            "gesture": gesture,
            "speech": speech,
            "display": extra.get("display"),
            "remember": None,
        }
    )


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def _user_text(request: ModelClientRequest) -> str:
    return str(request.prompt.messages[-1]["content"])


class _Client:
    """Answers each request from ``reply``, streaming the text once before its final; records every request."""

    def __init__(self, reply: Callable[[ModelClientRequest], str], *, clock: _Clock | None = None) -> None:
        self.reply = reply
        self.clock = clock
        self.requests: list[ModelClientRequest] = []

    async def stream(self, request: ModelClientRequest) -> AsyncIterator[ModelClientDelta]:
        self.requests.append(request)
        text = self.reply(request)
        if self.clock is not None:
            self.clock.now += 1.0
        yield ModelClientDelta(kind="text_delta", text=text)
        yield ModelClientDelta(
            kind="final",
            final=ModelClientFinal(
                text=text,
                usage=Usage(requests=1, input_tokens=2000, output_tokens=100, total_tokens=2100),
                usage_reported=True,
                raw_provider_metadata={"model": "served-snapshot"},
            ),
        )
        yield ModelClientDelta(kind="done")

    async def aclose(self) -> None:
        return None


def _standard() -> list[configs.Configuration]:
    return configs.standard_configurations(configs.builtin_chat_rows())


def _registry(client: _Client, configurations: list[configs.Configuration]) -> StaticModelClientRegistry:
    return StaticModelClientRegistry({c.model_provider.provider_type: client for c in configurations})


async def _run(
    client: _Client,
    configurations: list[configs.Configuration],
    *,
    caps: runner.RunCaps | None = None,
    prices: dict[str, Any] | None = None,
    prompts: prompt_set.PromptSet | None = None,
) -> tuple[runner.RunOutcome, list[dict[str, Any]]]:
    turns: list[dict[str, Any]] = []
    outcome = await runner.run_benchmark(
        prompts or prompt_set.load_prompt_set(PROMPTS),
        configurations,
        registry=_registry(client, configurations),
        caps=caps or runner.RunCaps(max_calls=200),
        prices=prices or {},
        sink=turns.append,
        clock=client.clock or _Clock(),
    )
    return outcome, turns


# --- Prompt set ---------------------------------------------------------------


def test_the_fixture_prompt_set_loads_with_its_hashes_and_the_starter_persona() -> None:
    loaded = prompt_set.load_prompt_set(PROMPTS)

    annie = loaded.persona("annie")
    starter = next(spec for spec in STARTER_ANIMA_SPECS if spec.id == "starter:annie")
    assert (annie.name, annie.identity, annie.starter) == (starter.display_name, starter.identity_markdown, starter.id)
    assert loaded.loadout.selectors == ("think", "wave")
    assert set(loaded.hashes) == {"manifest", "loadout"} and loaded.hashes["loadout"] == loaded.loadout.sha256
    japanese = next(item for item in loaded.items if item.language == "ja")
    assert (japanese.pair_id, japanese.held_out) == ("greet", True)
    smoke = loaded.for_tier("smoke")
    assert [item.id for item in smoke.items] == ["greet", "greet-ja"] and len(smoke.scripted_chats) == 1


def _write_set(tmp_path: Path, mutate: Callable[[dict[str, Any]], None]) -> Path:
    data = json.loads(PROMPTS.read_text(encoding="utf-8"))
    mutate(data)
    (tmp_path / "loadout.json").write_bytes((FIXTURES / "loadout.json").read_bytes())
    path = tmp_path / "prompts.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda data: data["items"][0].update(acceptable=["jump"]), "not in the loadout"),
        (lambda data: data["items"][2].pop("pair_id"), "must name the English original"),
        (lambda data: data["items"][0].update(pair_id="choice"), "must not name a pair_id"),
        (lambda data: data["scripted_chats"][0].update(persona="nobody"), "unknown persona"),
        (lambda data: data["loadout"].update(sha256="0" * 64), "pinned sha256"),
        (lambda data: data["personas"][1].update(starter="starter:nobody"), "unknown starter"),
        (lambda data: data["items"][0].update(tier="huge"), "'tier' must be one of"),
        (lambda data: data["items"][0].update(intensity=[6, 4]), "'intensity' must be"),
        (lambda data: data["items"][0].update(intensity=[0, 4]), "'intensity' must be"),
        (lambda data: data["items"][0].update(intensity=[3]), "'intensity' must be"),
        (lambda data: data["items"][0].update(tones=["grumpy"]), "tones the reply schema does not allow"),
    ],
)
def test_the_prompt_set_rejects_invalid_entries(
    tmp_path: Path, mutate: Callable[[dict[str, Any]], None], message: str
) -> None:
    with pytest.raises(EvalInputError, match=message):
        prompt_set.load_prompt_set(_write_set(tmp_path, mutate))


# --- Configurations --------------------------------------------------------------


def test_the_standard_set_is_every_visible_builtin_chat_row_at_none_and_low() -> None:
    labels = [configuration.label for configuration in _standard()]

    assert labels == [
        "AnthropicMessagesHTTPAgent:claude-haiku-5-5@none",
        "AnthropicMessagesHTTPAgent:claude-haiku-5-5@low",
        "OpenAIResponsesHTTPAgent:gpt-6-luna@none",
        "OpenAIResponsesHTTPAgent:gpt-6-luna@low",
    ]
    assert {c.model_provider.provider_type for c in _standard()} == {
        "AnthropicMessagesHTTPAgent",
        "OpenAIResponsesHTTPAgent",
    }


def test_a_configuration_the_row_cannot_serve_reports_why() -> None:
    rows = configs.builtin_chat_rows()
    haiku = configs.parse_config("AnthropicMessagesHTTPAgent:claude-haiku-5-5@minimal", rows)

    assert configs.capability_problem(haiku) == "reasoning effort minimal not supported"
    no_stream = replace(
        haiku.model_provider, capabilities=replace(haiku.model_provider.capabilities, supports_streaming=False)
    )
    assert configs.capability_problem(configs.Configuration(no_stream, None)) == "no streaming"
    with pytest.raises(EvalInputError, match="no catalog row"):
        configs.parse_config("Nope:none", rows)


# --- Run loop -----------------------------------------------------------------------


async def test_configurations_warm_up_then_take_each_unit_in_turn() -> None:
    standard = _standard()[::2]  # Haiku and Luna at effort none.
    client = _Client(lambda request: _reply())

    outcome, turns = await _run(client, standard)

    order = [(turn["kind"], turn["unit_id"], turn["persona"], turn["configuration"]) for turn in turns]
    haiku, luna = (configuration.label for configuration in standard)
    assert order[:6] == [
        ("warmup", "warmup", "neutral", haiku),
        ("warmup", "warmup", "neutral", luna),
        ("single", "greet", "neutral", haiku),
        ("single", "greet", "neutral", luna),
        ("single", "greet", "annie", haiku),
        ("single", "greet", "annie", luna),
    ]
    assert order[-2:] == [("chat", "weekend", "annie", haiku), ("chat", "weekend", "annie", luna)]
    assert len(turns) == 2 * runner.planned_turns(prompt_set.load_prompt_set(PROMPTS), repeats=1, scripted_repeats=1)
    assert outcome.aborted is None and outcome.calls == len(turns) == outcome.turns
    assert outcome.served_models == {haiku: ["served-snapshot"], luna: ["served-snapshot"]}
    # A scripted chat replays its own history: the third turn sees the first two.
    third = [request for request in client.requests if _user_text(request) == "Thanks, that helps."][0]
    assert sum(1 for message in third.prompt.messages if message["role"] == "user") == 3


async def test_every_turn_has_the_elevenlabs_rules_and_japanese_turns_reply_in_japanese() -> None:
    client = _Client(lambda request: _reply())

    _, turns = await _run(client, _standard()[2:3])

    def system_text(request: ModelClientRequest) -> str:
        return "\n".join(str(m["content"]) for m in request.prompt.messages if m["role"] in {"system", "developer"})

    assert all("[excited]" in system_text(request) for request in client.requests)
    japanese = [request for request in client.requests if _user_text(request) == "こんにちは！"]
    assert len(japanese) == 2  # One per persona.
    assert all("Japanese" in system_text(request) for request in japanese)
    assert not any("Japanese" in system_text(r) for r in client.requests if _user_text(r) != "こんにちは！")
    # Hosted web search would travel as a native tool; the application tool would be a prompt tool.
    assert all(request.provider_options.native_tools == () for request in client.requests)
    assert all("web_search" not in json.dumps(request.prompt.tools or []) for request in client.requests)
    ja_turns = [turn for turn in turns if turn["language"] == "ja"]
    assert [turn["pair_id"] for turn in ja_turns] == ["greet", "greet"] and all(turn["held_out"] for turn in ja_turns)


def test_the_japanese_turns_carry_the_speech_language_code() -> None:
    english = options.core_turn_options("en", "none")
    japanese = options.core_turn_options("ja", "none")

    assert english.options.tts is not None and english.options.tts.provider == "elevenlabs"
    assert english.options.tts.language_code is None and english.conversation_language is None
    assert japanese.options.tts is not None and japanese.options.tts.language_code == "ja"
    assert japanese.conversation_language is not None and japanese.conversation_language.locale == "ja"
    assert english.options.native_tools == () and english.options.incognito is True
    memory = options.memory_turn_options("ja", "low")
    assert memory.options.incognito is False and memory.options.reasoning_effort == "low"
    assert memory.options.tts is not None and memory.options.tts.language_code == "ja"
    assert memory.conversation_language is not None and memory.conversation_language.locale == "ja"


async def test_annies_identity_reaches_her_turns() -> None:
    client = _Client(lambda request: _reply())
    starter = next(spec for spec in STARTER_ANIMA_SPECS if spec.id == "starter:annie")

    _, turns = await _run(client, _standard()[2:3])

    annie_requests = [
        request for request, turn in zip(client.requests, turns, strict=True) if turn["persona"] == "annie"
    ]
    first_line = starter.identity_markdown.strip().splitlines()[2]
    assert annie_requests and all(first_line in json.dumps(request.prompt.messages) for request in annie_requests)


async def test_the_call_cap_stops_the_run_and_keeps_the_finished_turns() -> None:
    client = _Client(lambda request: _reply())

    outcome, turns = await _run(client, _standard()[::2], caps=runner.RunCaps(max_calls=3))

    assert outcome.aborted == "max_calls" and outcome.calls == 3
    assert len(turns) == 3 and len(client.requests) == 3


async def test_the_usd_cap_refuses_a_call_that_could_pass_it() -> None:
    client = _Client(lambda request: _reply())
    standard = _standard()[2:3]

    outcome, turns = await _run(
        client,
        standard,
        caps=runner.RunCaps(max_calls=200, max_usd=Decimal("0.025")),
        prices={standard[0].label: lambda usage: Decimal("0.01")},
    )

    # 0.01 + 0.01 fits; a third call could reach 0.03, past the cap, so it is never sent.
    assert outcome.aborted == "max_usd" and outcome.calls == 2 and outcome.spent_usd == Decimal("0.02")
    assert [turn["estimated_cost_usd"] for turn in turns] == [0.01, 0.01]


async def test_a_usd_cap_needs_every_configuration_priced() -> None:
    with pytest.raises(ValueError, match="unpriced"):
        await _run(
            _Client(lambda request: _reply()), _standard()[:1], caps=runner.RunCaps(max_calls=5, max_usd=Decimal(1))
        )


@pytest.mark.parametrize(
    ("replies", "expected", "calls"),
    [
        ([_reply()], "strict", 1),
        (["```json\n" + _reply() + "\n```"], "lenient", 1),
        (["No JSON at all.", _reply()], "repaired", 2),
        (
            ['{"emotional_tone":"happy","emotional_intensity":3,"gesture":null,"speech":"Hello there. Nice to'],
            "salvaged",
            1,
        ),
        (["No JSON at all.", "Still no JSON."], "plain_text", 2),
    ],
)
async def test_each_recovery_path_is_recorded(replies: list[str], expected: str, calls: int) -> None:
    sent = iter(replies)
    client = _Client(lambda request: next(sent))
    one = prompt_set.PromptSet(
        version="one",
        loadout=prompt_set.load_prompt_set(PROMPTS).loadout,
        personas=prompt_set.load_prompt_set(PROMPTS).personas[:1],
    )

    _, turns = await _run(client, _standard()[2:3], prompts=one)

    [warmup] = turns
    assert (warmup["recovery"], warmup["calls"]) == (expected, calls)


# --- Measures ----------------------------------------------------------------------


def test_speech_checks_follow_the_elevenlabs_and_speech_rules() -> None:
    clean = check_speech("[laughs] That's great news. [short pause] Tell me more.", None)
    assert clean.tags == ("[laughs]", "[short pause]") and clean.sounds == 2 and not clean.over_sound_cap
    assert clean.style_violations == () and clean.angle_or_non_english_tags == 0

    busy = check_speech("[sighs] Oh. [laughs] Wow. [gasps] Really?", "[laughs] see below")
    assert busy.sounds == 3 and busy.over_sound_cap and busy.display_tags == 1

    delivery = check_speech("[excited] We did it!", None)
    assert delivery.sounds == 0 and delivery.tags == ("[excited]",)

    odd = check_speech("<sigh> [笑う] [British accent] Hello.", None)
    assert odd.angle_or_non_english_tags == 2 and odd.accent_requests == 1

    assert check_speech("[laughs]", None).tags_only_speech is True
    style = check_speech("See https://example.com, run `ls`, **bold** 😀\n- one\n| a | b |", None)
    assert style.style_violations == ("url", "code", "markdown", "list", "table", "emoji")


def _turn(**fields: Any) -> dict[str, Any]:
    base = {
        "kind": "single",
        "unit_id": "u",
        "repeat": 1,
        "turn": 1,
        "error": None,
        "fit": True,
        "gesture": "wave",
        "gesture_mismatch": False,
        "emotional_tone": "happy",
        "emotional_intensity": 3,
        "recovery": "strict",
        "speech_check": {
            "tags": [],
            "sounds": 0,
            "over_sound_cap": False,
            "angle_or_non_english_tags": 0,
            "display_tags": 0,
            "tags_only_speech": False,
            "accent_requests": 0,
            "style_violations": [],
        },
        "calls": 1,
        "usage": {
            "input_tokens": 10,
            "cached_input_tokens": 0,
            "cache_write_tokens": 0,
            "output_tokens": 2,
            "reasoning_tokens": 0,
            "total_tokens": 12,
            "unreported_calls": 0,
        },
        "estimated_cost_usd": 0.001,
        "latency_seconds": 1.0,
        "first_output_seconds": 0.5,
        "call_latencies": [{"seconds": 1.0, "first_text_seconds": 0.4}],
    }
    base.update(fields)
    return base


def test_distributions_and_chat_runs_are_summarised_side_by_side() -> None:
    turns = [
        _turn(kind="warmup", gesture="think"),
        _turn(gesture="wave"),
        _turn(gesture=None, fit=False, emotional_tone="neutral"),
        _turn(kind="chat", unit_id="c", turn=1, gesture="wave", fit=None),
        _turn(kind="chat", unit_id="c", turn=2, gesture="wave", fit=None),
        _turn(kind="chat", unit_id="c", turn=3, gesture="think", fit=None, emotional_intensity=5),
        _turn(error="provider_error", gesture=None, fit=None, recovery=None, speech_check=None),
    ]

    summary = measures.summarize_configuration(turns)

    gestures = summary["distributions"]["gesture"]
    assert (gestures["n"], gestures["distinct"], gestures["top"]) == (5, 2, [["wave", 3], ["think", 1]])
    assert gestures["null_rate"] == pytest.approx(0.2) and gestures["top_share"] == pytest.approx(0.8)
    assert summary["single_turn"] == {"scored": 2, "fits": 1, "fit_rate": 0.5, "null_rate": 0.5}
    [chat] = summary["chats"]
    assert chat["gesture"] == {"distinct": 2, "longest_run": 2, "longest_run_value": "wave"}
    assert chat["emotional_intensity"]["longest_run"] == 2
    assert summary["errors"] == 1 and summary["error_codes"] == {"provider_error": 1}
    assert summary["recovery"]["strict"] == 5 and summary["turns"] == 6


def test_expression_is_measured_against_each_items_intended_band_tones_and_audio_tag() -> None:
    def item(item_id: str, **fields: Any) -> prompt_set.Item:
        return prompt_set.Item(id=item_id, area="core", language="en", message="m", acceptable=(None,), **fields)

    items = {
        "loss": item("loss", intensity=(7, 8), tones=("sorrowful", "gentle")),
        "joke": item("joke", tags=("audio-tag:laughs",)),
        "plain": item("plain", tags=("audio-tag:none",)),
    }

    def tagged(*tags: str) -> dict[str, Any]:
        return {**_turn()["speech_check"], "tags": list(tags)}

    turns = [
        _turn(kind="warmup", emotional_intensity=10),
        _turn(unit_id="loss", emotional_intensity=8, emotional_tone="sorrowful"),
        _turn(unit_id="loss", emotional_intensity=5, emotional_tone="sad"),
        _turn(unit_id="loss", emotional_intensity=9, emotional_tone="gentle"),
        _turn(unit_id="joke", emotional_intensity=6, speech_check=tagged("[chuckles]")),
        _turn(unit_id="joke", emotional_intensity=2, speech_check=tagged("[whispering, playful]")),
        _turn(unit_id="plain", emotional_intensity=1),
        _turn(unit_id="plain", speech_check=tagged("[sighs]")),
        _turn(kind="chat", unit_id="loss", emotional_intensity=4),
        # An unusable intensity plays no Reaction and is not held against the band.
        _turn(unit_id="loss", emotional_intensity=None, emotional_tone="gentle"),
        _turn(unit_id="loss", error="provider_error"),
    ]

    targets = measures.expression_targets(turns, items)

    # Warm-ups and failed turns are left out; a chat turn counts for the Reaction intensities but not against an item.
    assert targets["reaction_intensity"] == {
        "n": 9,
        "counts": {"none": 3, "mild": 2, "moderate": 2, "strong": 1, "intense": 1},
    }
    assert targets["intensity_band"] == {"scored": 3, "in_band": 1, "below": 1, "above": 1}
    assert targets["tones"] == {"scored": 4, "in_family": 3}
    assert targets["audio_tags"] == {"laughs": {"replies": 2, "hits": 1}, "none": {"replies": 2, "hits": 1}}


# --- Dry run and CLI ------------------------------------------------------------------


def _plan(seconds_tier: str = "full") -> planner.BenchmarkPlan:
    return planner.BenchmarkPlan(
        prompt_set=prompt_set.load_prompt_set(PROMPTS).for_tier(seconds_tier),
        configurations=tuple(_standard()),
        tier=seconds_tier,
    )


async def test_the_dry_run_estimates_calls_cost_and_wall_time() -> None:
    plan = _plan()
    tokens = await planner.estimate_first_turn_tokens(plan)

    text = planner.render_plan(plan, first_turn_tokens=tokens, seconds_per_call=2.5, max_calls=30, prices={})

    assert plan.turns_per_configuration == 10 and plan.estimated_calls == 40
    assert set(tokens) == {configuration.label for configuration in _standard()}
    assert "Estimated model calls: 40; up to 80 if every reply needs" in text
    assert "the estimate exceeds --max-calls 30" in text
    assert "Estimated wall time: 0.03 h" in text and "over the bound" not in text


def test_the_dry_run_flags_a_plan_over_the_time_bound() -> None:
    plan = _plan()
    seconds_per_call = planner.TIME_BOUND_SECONDS / plan.estimated_calls + 1

    text = planner.render_plan(plan, first_turn_tokens={}, seconds_per_call=seconds_per_call, max_calls=None, prices={})

    assert planner.estimated_seconds(plan, seconds_per_call=seconds_per_call) > planner.TIME_BOUND_SECONDS
    assert "over the bound" in text and "--over-time-approved" in text


def test_plan_for_an_unknown_row_without_a_database_names_the_row(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    @asynccontextmanager
    async def no_database() -> AsyncIterator[Any]:
        raise OSError("connect call failed")
        yield

    monkeypatch.setattr(catalog, "read_only_model_providers", no_database)

    assert cli.main(["plan", "--prompts", str(PROMPTS), "--config", "Mistyped:row@low"]) == 2
    error = capsys.readouterr().err
    assert "Mistyped:row is not a built-in chat row" in error and "(OSError)" in error and "Traceback" not in error


@dataclass(slots=True)
class _FakeCatalog:
    """The catalog and registry the CLI sees: built-in rows, and one fake client for every provider type."""

    client: _Client
    rows: list[ModelProvider]


@pytest.fixture
def fake_catalog(monkeypatch: pytest.MonkeyPatch) -> Iterator[_FakeCatalog]:
    client = _Client(lambda request: _reply())
    rows = configs.builtin_chat_rows()

    @asynccontextmanager
    async def read_only() -> AsyncIterator[Any]:
        yield object()

    async def chat_rows(_: Any) -> list[ModelProvider]:
        return rows

    monkeypatch.setattr(catalog, "read_only_model_providers", read_only)
    monkeypatch.setattr(catalog, "chat_model_rows", chat_rows)
    monkeypatch.setattr(
        catalog,
        "build_model_client_registry",
        lambda: StaticModelClientRegistry({row.provider_type: client for row in rows}),
    )
    yield _FakeCatalog(client, rows)


_PRICE = "input=0.10,cached_input=0.01,cache_write=0.125,output=0.50"


def test_the_run_command_writes_turns_and_a_manifest(fake_catalog: _FakeCatalog, tmp_path: Path) -> None:
    out = tmp_path / "run"

    code = cli.main(
        [
            "run",
            "--prompts",
            str(PROMPTS),
            "--tier",
            "smoke",
            "--standard",
            "--max-calls",
            "100",
            "--max-usd",
            "1",
            "--price",
            _PRICE,
            "--output-dir",
            str(out),
        ]
    )

    assert code == 0
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    turns = [json.loads(line) for line in (out / "turns.jsonl").read_text(encoding="utf-8").splitlines()]
    # Per configuration: the warm-up, 2 items x 2 personas and 3 chat turns.
    assert manifest["aborted"] is None and manifest["calls_made"] == len(turns) == 4 * 8
    assert manifest["prompt_set"]["version"] == "fixture-1" and manifest["tier"] == "smoke"
    assert manifest["options"] == {
        "voice": "elevenlabs",
        "native_tools": [],
        "provider_moderation": True,
        "incognito": True,
        "memory": "off",
        "memory_arms": [],
    }
    assert [c["label"] for c in manifest["configurations"]] == [c.label for c in _standard()]
    assert Decimal(manifest["estimated_spend_usd"]) > 0
    assert (
        cli.main(
            [
                "run",
                "--prompts",
                str(PROMPTS),
                "--standard",
                "--max-calls",
                "100",
                "--max-usd",
                "1",
                "--price",
                _PRICE,
                "--output-dir",
                str(out),
            ]
        )
        == 2
    )


@pytest.mark.parametrize(
    ("extra", "message"),
    [
        (["--max-calls", "100", "--price", _PRICE], "needs --max-calls and --max-usd"),
        (["--max-calls", "100", "--max-usd", "1"], "needs --price or --row-price"),
        (["--max-calls", "100", "--max-usd", "1", "--price", _PRICE, "--seconds-per-call", "100000"], "4-hour bound"),
        (["--max-calls", "5", "--max-usd", "1", "--price", _PRICE], "more than --max-calls"),
        (["--max-calls", "100", "--max-usd", "0.001", "--price", _PRICE], "exceeds --max-usd"),
    ],
)
def test_the_run_command_refuses_without_its_caps(
    fake_catalog: _FakeCatalog, tmp_path: Path, capsys: pytest.CaptureFixture[str], extra: list[str], message: str
) -> None:
    code = cli.main(["run", "--prompts", str(PROMPTS), "--standard", "--output-dir", str(tmp_path / "x"), *extra])

    assert code == 2 and message in capsys.readouterr().err
    assert fake_catalog.client.requests == []


def test_an_over_time_run_starts_with_the_owners_exception(fake_catalog: _FakeCatalog, tmp_path: Path) -> None:
    code = cli.main(
        [
            "run",
            "--prompts",
            str(PROMPTS),
            "--tier",
            "smoke",
            "--config",
            "OpenAIResponsesHTTPAgent:gpt-6-luna@none",
            "--max-calls",
            "20",
            "--max-usd",
            "1",
            "--price",
            _PRICE,
            "--seconds-per-call",
            "100000",
            "--over-time-approved",
            "--output-dir",
            str(tmp_path / "run"),
        ]
    )

    manifest = json.loads((tmp_path / "run" / "manifest.json").read_text(encoding="utf-8"))
    assert code == 0 and manifest["over_time_approved"] is True and fake_catalog.client.requests


async def test_the_run_composition_reads_the_catalog_and_runs_chats_mock_client(
    async_session: AsyncSession, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # ANIMAMA_LLM_SKIP makes chat's own registry serve the mock client: the free smoke run the docs describe.
    monkeypatch.setenv("ANIMAMA_LLM_SKIP", "1")
    await SQLAlchemyModelProviderRepository(async_session).upsert_many(configs.builtin_chat_rows())
    await async_session.commit()
    out = tmp_path / "run"
    args = cli._parse_args(
        [
            "run",
            "--prompts",
            str(PROMPTS),
            "--tier",
            "smoke",
            "--standard",
            "--max-calls",
            "100",
            "--max-usd",
            "1",
            "--price",
            _PRICE,
            "--output-dir",
            str(out),
        ]
    )

    code = await cli._run(args)

    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    turns = [json.loads(line) for line in (out / "turns.jsonl").read_text(encoding="utf-8").splitlines()]
    assert code == 0 and manifest["aborted"] is None and manifest["conditions"]["llm_skip"] is True
    assert {turn["configuration"] for turn in turns} == {c.label for c in _standard()}
    assert all(turn["error"] is None and turn["speech"] for turn in turns)


def _run_args(out: Path, *extra: str, max_calls: int = 100) -> list[str]:
    return [
        "run", "--prompts", str(PROMPTS), "--tier", "smoke", "--standard", "--max-calls", str(max_calls),
        "--max-usd", "1", "--output-dir", str(out), *extra,
    ]  # fmt: skip


def _manifest_and_turns(out: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    path = out / "turns.jsonl"
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    return manifest, [json.loads(line) for line in lines]


def test_two_rows_of_one_model_are_separate_configurations(capsys: pytest.CaptureFixture[str]) -> None:
    code = cli.main(["plan", "--prompts", str(PROMPTS), "--standard", "--config", "OpenAIHTTPAgent:gpt-6-luna@none"])

    out = capsys.readouterr().out
    assert code == 0
    assert "OpenAIHTTPAgent:gpt-6-luna@none" in out and "OpenAIResponsesHTTPAgent:gpt-6-luna@none" in out


def test_one_price_cannot_cover_rows_with_different_catalog_rates(
    fake_catalog: _FakeCatalog, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    haiku = next(index for index, row in enumerate(fake_catalog.rows) if "haiku" in row.id)
    row = fake_catalog.rows[haiku]
    fake_catalog.rows[haiku] = replace(
        row, pricing=replace(row.pricing, standard_input_price_per_million=Decimal("1.00"))
    )

    refused = cli.main(_run_args(tmp_path / "a", "--price", _PRICE))
    allowed = cli.main(
        _run_args(
            tmp_path / "b", "--price", _PRICE, "--row-price", row.id, "input=1,cached_input=0.1,cache_write=1,output=5"
        )
    )

    assert refused == 2 and "different catalog rates" in capsys.readouterr().err
    manifest, _ = _manifest_and_turns(tmp_path / "b")
    assert allowed == 0
    assert manifest["price_source"][f"{row.id}@none"]["rates_per_million_usd"]["input"] == "1"


def test_a_cap_stop_is_recorded_in_the_manifest(fake_catalog: _FakeCatalog, tmp_path: Path) -> None:
    # Every first reply needs a repair, so the planned calls fit the cap but the real ones do not.
    replies = iter(["No JSON at all.", _reply()] * 100)
    fake_catalog.client.reply = lambda request: next(replies)
    planned = 4 * 8

    code = cli.main(_run_args(tmp_path / "capped", "--price", _PRICE, max_calls=planned))

    manifest, turns = _manifest_and_turns(tmp_path / "capped")
    assert code == 1 and manifest["aborted"] == "max_calls"
    assert manifest["calls_made"] == planned and len(turns) == planned // 2


class _Interrupt(KeyboardInterrupt):
    pass


@pytest.mark.parametrize(
    ("error", "code", "aborted"), [(_Interrupt, 130, "interrupted"), (RuntimeError, None, "error: RuntimeError")]
)
def test_an_interrupted_or_failed_run_keeps_its_turns_and_says_why(
    fake_catalog: _FakeCatalog, tmp_path: Path, error: type[BaseException], code: int | None, aborted: str
) -> None:
    calls = iter(range(1000))

    def reply(request: ModelClientRequest) -> str:
        if next(calls) == 3:
            raise error("stop")
        return _reply()

    fake_catalog.client.reply = reply
    out = tmp_path / "run"

    if code is None:
        with pytest.raises(error):
            cli.main(_run_args(out, "--price", _PRICE))
    else:
        assert cli.main(_run_args(out, "--price", _PRICE)) == code

    manifest, turns = _manifest_and_turns(out)
    assert manifest["aborted"] == aborted and len(turns) == 3 and manifest["turns_recorded"] == 3
    assert manifest["finished_at"] is not None


def test_a_registry_that_cannot_be_built_is_recorded_as_an_error(
    fake_catalog: _FakeCatalog, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken() -> StaticModelClientRegistry:
        raise RuntimeError("no registry")

    monkeypatch.setattr(catalog, "build_model_client_registry", broken)

    with pytest.raises(RuntimeError):
        cli.main(_run_args(tmp_path / "run", "--price", _PRICE))

    manifest, turns = _manifest_and_turns(tmp_path / "run")
    assert manifest["aborted"] == "error: RuntimeError" and turns == []


@pytest.mark.parametrize("value", ["0", "-1", "nan", "inf"])
def test_the_seconds_per_call_allowance_must_be_a_positive_number(value: str) -> None:
    with pytest.raises(SystemExit):
        cli.main(["plan", "--prompts", str(PROMPTS), "--standard", "--seconds-per-call", value])


def test_speech_checks_catch_punctuation_only_speech_single_emphasis_and_flags() -> None:
    for speech in ("[sighs]...", "[laughs]!", "[laughs] …"):
        assert check_speech(speech, None).tags_only_speech is True, speech
    assert check_speech("[sighs] 3", None).tags_only_speech is False
    for speech in ("It's *really* good", "_great_ news", "*smiles* hi"):
        assert "markdown" in check_speech(speech, None).style_violations, speech
    for speech in ("5 * 3 is 15", "my_file name", "a lone * star", "Yay (^_^) see you (^_^)"):
        assert "markdown" not in check_speech(speech, None).style_violations, speech
    assert "emoji" in check_speech("Go team 🇯🇵", None).style_violations


def test_the_prompt_set_rejects_unknown_keys_and_an_unsorted_loadout(tmp_path: Path) -> None:
    with pytest.raises(EvalInputError, match="unknown keys 'held-out'"):
        prompt_set.load_prompt_set(_write_set(tmp_path, lambda data: data["items"][0].update({"held-out": True})))
    unsorted = tmp_path / "unsorted"
    unsorted.mkdir()
    gestures = list(reversed(json.loads((FIXTURES / "loadout.json").read_text(encoding="utf-8"))))
    (unsorted / "loadout.json").write_text(json.dumps(gestures), encoding="utf-8")
    data = json.loads(PROMPTS.read_text(encoding="utf-8"))
    data["loadout"]["sha256"] = hashlib.sha256((unsorted / "loadout.json").read_bytes()).hexdigest()
    (unsorted / "prompts.json").write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(EvalInputError, match="sorted by selector"):
        prompt_set.load_prompt_set(unsorted / "prompts.json")


async def test_an_unregistered_provider_is_recorded_as_an_error() -> None:
    outcome = runner.RunOutcome()
    with pytest.raises(Exception, match="No model client registered"):
        await runner.run_benchmark(
            prompt_set.load_prompt_set(PROMPTS),
            _standard()[:1],
            registry=StaticModelClientRegistry({}),
            caps=runner.RunCaps(max_calls=5),
            prices={},
            sink=lambda turn: None,
            outcome=outcome,
        )
    assert outcome.aborted == "error: ModelClientNotFoundError" and outcome.calls == 0


# --- Retrying connection errors ---------------------------------------------------------------


def _record(kind: str, unit_id: str, *, configuration: str = "A@none", error: str | None = None,
            **fields: Any) -> dict[str, Any]:  # fmt: skip
    return {"configuration": configuration, "kind": kind, "unit_id": unit_id, "persona": "annie", "repeat": 1,
            "turn": 1, "arm": None, "error": error, **fields}  # fmt: skip


def test_a_retry_takes_every_unit_with_a_connection_error_whole() -> None:
    records = [
        # A warm-up is discarded, so its failure is never retried.
        _record("warmup", "warmup", error="openai_connection_error"),
        _record("single", "a", error="anthropic_connection_error"),
        _record("single", "a", configuration="B@none"),
        # Any other error is the model's own failure and stays counted.
        _record("single", "b", error="invalid_structured_response"),
        _record("chat", "c", turn=1),
        _record("chat", "c", turn=2, error="openai_connection_error"),
        _record("chat", "c", turn=3),
        _record("memory", "m", arm="both", error="openai_connection_error"),
        _record("capture", "m", arm="both", repeat=None, turn=None),
        _record("recall", "m", arm="both"),
        _record("memory", "m", arm="remember_only"),
        _record("memory_manager", "tidy", configuration="A", repeat=None, turn=None, error="APIConnectionError"),
    ]

    plan = retry.plan_retry(records)

    assert plan.units == {
        ("A@none", "single/a/annie/r1"),
        ("A@none", "chat/c/annie/r1"),
        ("A@none", "memory/both/m"),
        ("A", "memory_manager/tidy"),
    }
    assert plan.replaced == 8
    assert [(r["kind"], r["configuration"], r["arm"]) for r in plan.kept] == [
        ("warmup", "A@none", None),
        ("single", "B@none", None),
        ("single", "A@none", None),
        ("memory", "A@none", "remember_only"),
    ]
    assert plan.error_codes == {"APIConnectionError": 1, "anthropic_connection_error": 1, "openai_connection_error": 2}
    assert plan.selects("A@none", "chat/c/annie/r1") and not plan.selects("B@none", "single/a/annie/r1")


def _turn_key(turn: Mapping[str, Any]) -> tuple[Any, ...]:
    return turn["configuration"], turn["kind"], turn["unit_id"], turn["persona"], turn["repeat"], turn["turn"]


def test_a_retry_reruns_the_failed_units_into_a_new_run_under_the_same_caps(
    fake_catalog: _FakeCatalog, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    calls = iter(range(1000))

    def flaky(request: ModelClientRequest) -> str:
        if next(calls) in {6, 30}:
            raise ModelClientError("Connection error.", code="openai_connection_error")
        return _reply()

    fake_catalog.client.reply = flaky
    first = tmp_path / "first"
    assert cli.main(_run_args(first, "--price", _PRICE)) == 0
    first_manifest, first_turns = _manifest_and_turns(first)
    recorded = {name: (first / name).read_bytes() for name in ("manifest.json", "turns.jsonl")}
    assert sum(1 for turn in first_turns if turn["error"] == "openai_connection_error") == 2
    fake_catalog.client.reply = lambda request: _reply()
    capsys.readouterr()

    code = cli.main(_run_args(tmp_path / "retry", "--price", _PRICE, "--retry-from", str(first)))

    manifest, turns = _manifest_and_turns(tmp_path / "retry")
    retried = manifest["retries"][-1]
    assert code == 0 and manifest["aborted"] is None
    assert "Retry of first: 2 units" in capsys.readouterr().out
    assert {name: (first / name).read_bytes() for name in recorded} == recorded
    assert sorted(map(_turn_key, turns)) == sorted(map(_turn_key, first_turns))
    assert not any(turn["error"] for turn in turns)
    # The later failure is in the scripted chat, which runs again whole.
    assert retried["of"] == "first" and len(retried["units"]) == 2 and any(" chat/" in u for u in retried["units"])
    assert retried["replaced_turns"] > 2
    assert retried["error_codes"] == {"openai_connection_error": 2}
    assert manifest["calls_made"] == first_manifest["calls_made"] + retried["calls"]
    assert manifest["turns_recorded"] == len(turns) and manifest["caps"] == first_manifest["caps"]

    assert cli.main(["report", "--run-dir", str(tmp_path / "retry"), "--prompts", str(PROMPTS)]) == 0
    assert "Retried after connection errors: 2 units" in (tmp_path / "retry" / "report.md").read_text(encoding="utf-8")


def test_a_retry_needs_a_matching_run_with_connection_errors_and_the_caps_left(
    fake_catalog: _FakeCatalog, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # A cap of exactly the planned calls: the first run uses all of it.
    planned = 4 * 8
    first = tmp_path / "first"
    assert cli.main(_run_args(first, "--price", _PRICE, max_calls=planned)) == 0
    manifest, turns = _manifest_and_turns(first)
    assert manifest["calls_made"] == planned
    capsys.readouterr()

    clean = cli.main(_run_args(tmp_path / "a", "--price", _PRICE, "--retry-from", str(first), max_calls=planned))
    assert clean == 2 and "no unit of" in capsys.readouterr().err

    turns[5]["error"] = "anthropic_connection_error"
    (first / "turns.jsonl").write_text("".join(json.dumps(turn) + "\n" for turn in turns), encoding="utf-8")
    changed = cli.main(_run_args(tmp_path / "b", "--price", _PRICE, "--retry-from", str(first)))
    assert changed == 2 and "caps differ" in capsys.readouterr().err

    spent = cli.main(_run_args(tmp_path / "c", "--price", _PRICE, "--retry-from", str(first), max_calls=planned))
    assert spent == 2 and "nothing is left" in capsys.readouterr().err

    def refused(manifest_changes: dict[str, Any], message: str, *, mock: bool = False) -> None:
        (first / "manifest.json").write_text(json.dumps({**manifest, **manifest_changes}), encoding="utf-8")
        with pytest.MonkeyPatch.context() as patch:
            if mock:
                patch.setenv("ANIMAMA_LLM_SKIP", "1")
            code = cli.main(_run_args(tmp_path / "d", "--price", _PRICE, "--retry-from", str(first)))
        assert code == 2 and message in capsys.readouterr().err

    unlimited = {"caps": {"max_calls": 100, "max_usd": "1"}}
    # Mock replies must never be merged into a paid run's results.
    refused(unlimited, "mock model differ", mock=True)
    refused({**unlimited, "aborted": "max_usd"}, "stopped at its max_usd cap")
    refused({**unlimited, "retries": [{"of": "origin", "aborted": "interrupted"}]}, "retry origin instead")
    assert not any((tmp_path / name).exists() for name in ("a", "b", "c", "d"))

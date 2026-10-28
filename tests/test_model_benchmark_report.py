"""Scores, statistics, calibration and the report (scripts/evals/benchmark, issue #470 spec R13, R16-R18)."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import pytest

from scripts.evals.benchmark import calibrate, cli, prompt_set, report, rubrics
from scripts.evals.benchmark.intervals import Interval, agreement, bootstrap_mean, bootstrap_paired, distinguishable
from scripts.evals.benchmark.judge_items import JudgeItem
from scripts.evals.benchmark.memory_runner import ARM_BOTH, ARM_REMEMBER_ONLY
from scripts.evals.benchmark.results import read_turns
from scripts.evals.benchmark.scores import JudgedItem, JudgeResults, by_line
from scripts.evals.core.inputs import EvalInputError
from tests.test_model_benchmark_judge import FIXTURE_RUN, INPUTS, Stub

PROMPTS = INPUTS / "prompts.json"


@pytest.fixture(scope="module")
def tracked() -> prompt_set.PromptSet:
    return prompt_set.load_prompt_set(PROMPTS)


@pytest.fixture(scope="module")
def rubric_set() -> rubrics.RubricSet:
    return rubrics.load_rubrics(INPUTS / "rubrics.json")


@pytest.fixture
def run_dir(tmp_path: Path) -> Path:
    shutil.copytree(FIXTURE_RUN, tmp_path / "run")
    return tmp_path / "run"


@pytest.fixture
def stub(tmp_path: Path) -> Stub:
    (tmp_path / "stub").mkdir()
    return Stub(tmp_path / "stub")


# --- Statistics ----------------------------------------------------------------------------


def test_bootstrap_intervals_are_seeded_and_keep_groups_together() -> None:
    assert bootstrap_mean([[1.0], [2.0], [3.0], [4.0], [5.0]]) == Interval(3.0, 1.8, 4.2, n=5, groups=5)
    assert bootstrap_mean([[2.0, 2.0], [2.0]]) == Interval(2.0, 2.0, 2.0, n=3, groups=2)
    # Two groups: every resample takes whole groups, so the interval spans the two group means.
    grouped = bootstrap_mean([[1.0, 1.0], [5.0]])
    assert grouped is not None and (grouped.low, grouped.high, grouped.groups) == (1.0, 5.0, 2)
    assert bootstrap_mean([[]]) is None
    assert bootstrap_paired([(1, 2), (1, 3), (2, 2), (3, 5)]) == Interval(1.25, 0.5, 2.0, n=4, groups=4)
    assert bootstrap_paired([(1, 2), (2, 3)]) == Interval(1.0, 1.0, 1.0, n=2, groups=2)


def test_intervals_that_overlap_are_not_distinguishable() -> None:
    low, high = Interval(2.0, 1.5, 2.5, 10, 10), Interval(3.5, 3.0, 4.0, 10, 10)

    assert distinguishable(low, high) and distinguishable(high, low)
    assert not distinguishable(low, Interval(2.4, 2.4, 3.0, 10, 10))
    assert not distinguishable(low, None)


def test_weighted_kappa_matches_hand_computed_examples() -> None:
    # Opposite ends: each pair disagrees by the full scale and chance expects half that, so kappa is -1.
    opposite = agreement([(1, 5), (5, 1)])
    assert opposite is not None and (opposite.kappa, opposite.exact, opposite.within_one) == (-1.0, 0.0, 0.0)
    # One pair a step apart, against a chance disagreement of the same size: kappa 0.
    step = agreement([(1, 2), (2, 2)])
    assert step is not None and (step.kappa, step.exact, step.within_one) == (0.0, 0.5, 1.0)
    same = agreement([(1, 1), (2, 2), (3, 3)])
    assert same is not None and same.kappa == 1.0
    constant = agreement([(3, 3), (3, 3)])
    assert constant is not None and constant.kappa is None  # No spread, so no chance agreement to compare against.


# --- Report data ---------------------------------------------------------------------------


def _memory_records(tracked: prompt_set.PromptSet) -> list[dict[str, Any]]:
    chat = next(chat for chat in tracked.memory_chats if chat.id == "new-job")
    base = {"configuration": "c", "persona": "annie", "language": "en", "unit_id": chat.id, "area": "memory"}
    records: list[dict[str, Any]] = []
    for arm in (ARM_REMEMBER_ONLY, ARM_BOTH):
        records.append({**base, "kind": "memory", "arm": arm, "turn": 1, "error": None, "latency_seconds": 2.0,
                        "usage": {"input_tokens": 100}, "tool_calls": [{"ok": arm == ARM_BOTH}]})  # fmt: skip
        records.append({**base, "kind": "memory", "arm": arm, "turn": 2, "error": "timeout", "tool_calls": None})
        records.append({**base, "kind": "recall", "arm": arm, "turn": 1, "error": None, "expect": ["10th"],
                        "recall_match": arm == ARM_BOTH, "latency_seconds": 1.0, "tool_calls": []})  # fmt: skip
        records.append({**base, "kind": "capture", "arm": arm, "checklist": [],
                        "snapshot": {"files": [{"path": "MEMORIES.md", "anima": True, "content": "changed"}],
                                     "episodes": [{"text": "x"}] if arm == ARM_REMEMBER_ONLY else []}})  # fmt: skip
    return records


def test_capture_totals_compare_the_arms(tracked: prompt_set.PromptSet) -> None:
    records = _memory_records(tracked)
    chat = next(chat for chat in tracked.memory_chats if chat.id == "new-job")
    kinds = {entry.id: entry.kind for entry in chat.checklist}
    keep = [entry for entry, kind in kinds.items() if kind == "keep"]
    noise = [entry for entry, kind in kinds.items() if kind == "noise"]
    sensitive = [entry for entry, kind in kinds.items() if kind == "sensitive"]
    # Arm (a) kept the first two must-keep entries; arm (c) kept them all, one noise entry and the secret.
    entries = {
        ARM_REMEMBER_ONLY: {entry: entry in keep[:2] for entry in kinds},
        ARM_BOTH: {entry: entry in keep or entry in noise[:1] or entry in sensitive for entry in kinds},
    }
    judge = JudgeResults(effort="medium")
    for line, record in enumerate(records):
        if record["kind"] == "capture":
            judge.items.append(JudgedItem("capture", {"lines": [line]}, None, entries=entries[record["arm"]]))
    manifest = {"configurations": [{"label": "c"}]}

    data = report.build_report(manifest, records, tracked, {}, judge)

    arms = data["memory"]["c"]["arms"]
    assert arms[ARM_REMEMBER_ONLY]["capture"] == {
        "keep": len(keep),
        "kept": 2,
        "noise": len(noise),
        "noise_kept": 0,
        "sensitive": len(sensitive),
        "sensitive_breaks": 0,
        "episodes": 1,
        "changed_files": 1,
        "unjudged": 0,
    }
    assert arms[ARM_BOTH]["capture"]["kept"] == len(keep)
    assert (arms[ARM_BOTH]["capture"]["noise_kept"], arms[ARM_BOTH]["capture"]["sensitive_breaks"]) == (1, 1)
    assert arms[ARM_BOTH]["kept_rate"] == 1.0 and arms[ARM_REMEMBER_ONLY]["kept_rate"] == 2 / len(keep)
    difference = data["memory"]["c"]["kept_differences"][f"{ARM_BOTH}-{ARM_REMEMBER_ONLY}"]
    assert difference.n == len(keep) and difference.mean == pytest.approx((len(keep) - 2) / len(keep))
    # A failed memory turn's tool calls are unknown and counted apart; recall counts deterministic matches.
    assert arms[ARM_BOTH]["tools"] == {
        "turns": 2,
        "unknown_turns": 1,
        "calls": 1,
        "succeeded": 1,
        "calls_per_turn": 0.5,
        "success_rate": 1.0,
    }
    assert arms[ARM_REMEMBER_ONLY]["recall"] == {"probes": 1, "matched": 0, "failed_turns": 0, "rate": 0.0}


def test_held_out_items_are_reported_apart(run_dir: Path, tracked: prompt_set.PromptSet) -> None:
    records = list(read_turns(run_dir))
    judge = JudgeResults(effort="medium")
    for line, record in enumerate(records):
        score = 2 if record["held_out"] else 4
        judge.items.append(JudgedItem("reply", {"lines": [line]}, {"relevance": score, "warmth": score}))
    manifest = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))

    data = report.build_report(manifest, records, tracked, {"reply": ["relevance", "warmth"]}, judge)

    for label, core in data["core"].items():
        lines = [record for record in records if record["configuration"] == label]
        held = sum(1 for record in lines if record["held_out"])
        tuned, held_out = core["split"]["tuned"]["interval"], core["split"]["held_out"]["interval"]
        assert tuned.n == len(lines) - held and tuned.mean == 4.0
        assert (held_out.n, held_out.mean) == (held, 2.0) if held else held_out is None


# --- Commands ------------------------------------------------------------------------------


def _report_args(run_dir: Path, *extra: str) -> list[str]:
    return ["report", "--run-dir", str(run_dir), "--prompts", str(PROMPTS), *extra]


def test_a_judged_run_reports_publicly_and_rerenders_byte_for_byte(
    run_dir: Path, stub: Stub, tracked: prompt_set.PromptSet, capsys: pytest.CaptureFixture[str]
) -> None:
    judge_args = ["judge", "--run-dir", str(run_dir), "--prompts", str(PROMPTS), "--effort", "medium"]
    assert cli.main([*judge_args, "--claude", str(stub.path)]) == 0
    output = run_dir / "public" / "report.md"

    assert cli.main(_report_args(run_dir, "--effort", "medium", "--output", str(output))) == 0
    text = output.read_text(encoding="utf-8")
    assert "## Scorecard" in text and "3.00 [3.00, 3.00]" in text and report.family_caveat(None) in text
    assert "The judge, Claude Fable 5.1, shares a model family with Claude Haiku" in text
    assert "_to be written by the owner._" in text and "Not calibrated in this run." in text
    assert "### Emotional intensity by Reaction intensity" in text and "### Intended intensity and tones" in text
    assert cli.main(_report_args(run_dir, "--effort", "medium", "--output", str(output), "--rerender")) == 0

    output.write_text(text + "\n", encoding="utf-8")
    assert cli.main(_report_args(run_dir, "--effort", "medium", "--output", str(output), "--rerender")) == 1
    assert "differs from the re-rendered report" in capsys.readouterr().err

    records = list(read_turns(run_dir))
    reply = next(record["speech"] for record in records if len(record["speech"]) > 40)
    with pytest.raises(EvalInputError, match="it was not written"):
        report.check_public_safe(text + reply, report.forbidden_texts(records, tracked))
    with pytest.raises(EvalInputError, match="it was not written"):
        report.check_public_safe(text + tracked.personas[1].identity, report.forbidden_texts(records, tracked))


def test_calibration_samples_english_items_imports_ratings_and_pins_an_effort(
    run_dir: Path, stub: Stub, rubric_set: rubrics.RubricSet, capsys: pytest.CaptureFixture[str]
) -> None:
    args = ["--run-dir", str(run_dir), "--prompts", str(PROMPTS)]
    assert cli.main(["calibrate", "export", *args]) == 0
    folder = run_dir / calibrate.CALIBRATION_DIR
    mapping = json.loads((folder / "judge" / "mapping.json").read_text(encoding="utf-8"))
    template = json.loads((folder / "ratings.json").read_text(encoding="utf-8"))

    english = sum(1 for record in read_turns(run_dir) if record["language"] == "en")
    assert len(mapping) == 2 * min(english, calibrate.SAMPLE_PER_RUBRIC)
    assert {ref["language"] for ref in mapping.values()} == {"en"}
    assert {ref["rubric"] for ref in mapping.values()} == set(calibrate.CALIBRATED_RUBRICS)
    assert set(template["items"]) == set(mapping) and "Return exactly one result" in (folder / "sheet.md").read_text()
    assert cli.main(["calibrate", "export", *args]) == 2  # A sample is drawn once.

    ratings = folder / "filled.json"
    filled = {item: {key: 1 + (index + position) % 5 for position, key in enumerate(criteria)}
              for index, (item, criteria) in enumerate(sorted(template["items"].items()))}  # fmt: skip
    ratings.write_text(json.dumps({**template, "items": {**filled, next(iter(filled)): {}}}), encoding="utf-8")
    assert cli.main(["calibrate", "import", *args, "--ratings", str(ratings)]) == 2
    assert "rate exactly" in capsys.readouterr().err
    ratings.write_text(json.dumps({**template, "items": filled}), encoding="utf-8")
    assert cli.main(["calibrate", "import", *args, "--ratings", str(ratings)]) == 0

    assert cli.main(["calibrate", "pilot", *args, "--claude", str(stub.path)]) == 0
    result = json.loads((folder / "result.json").read_text(encoding="utf-8"))
    # The stub scores 3 at both efforts, so they agree equally with the owner and medium wins the tie.
    assert result["pinned"] == "medium" and result["mean_kappa"]["medium"] == result["mean_kappa"]["high"]
    reply_keys = {criterion.key for criterion in rubric_set.get("reply").criteria}
    assert {f"reply.{key}" for key in reply_keys} <= set(result["agreement"]["medium"])

    # The report then uses the pinned effort's main judging, and shows the agreement.
    assert cli.main(["judge", *args, "--effort", "medium", "--claude", str(stub.path)]) == 0
    assert cli.main(_report_args(run_dir)) == 0
    text = (run_dir / "report.md").read_text(encoding="utf-8")
    assert "Pinned effort: **medium**" in text and "reply.relevance" in text


# --- Repairs from review #1 ----------------------------------------------------------------


def test_weighted_kappa_uses_quadratic_weights() -> None:
    # Two one-step misses: quadratic 0.909, where linear weighting gives 0.762 and unweighted 0.5.
    result = agreement([(1, 1), (2, 3), (3, 3), (4, 5), (5, 5)])
    assert result is not None and result.kappa == pytest.approx(0.909, abs=1e-3)


def test_too_few_groups_give_no_verdict() -> None:
    few, other = bootstrap_mean([[4.0], [4.33]]), bootstrap_mean([[3.67], [3.33]])

    assert few is not None and other is not None and few.low > other.high
    assert not distinguishable(few, other)  # Two transcripts each: the intervals are apart, but say nothing.
    assert "too few to compare (1 of 5 groups)" in report._difference(bootstrap_paired([(0, 1)]))
    many = bootstrap_mean([[4.0]] * 6)
    assert distinguishable(many, bootstrap_mean([[2.0]] * 6))


def _single(line_id: str, language: str, **fields: Any) -> dict[str, Any]:
    return {"configuration": "c", "kind": "single", "error": None, "persona": "annie", "repeat": 1,
            "unit_id": line_id, "language": language, "speech_check": {"tags": []}, **fields}  # fmt: skip


def test_english_japanese_pairs_compare_judged_and_measured_values(tracked: prompt_set.PromptSet) -> None:
    records: list[dict[str, Any]] = []
    judge = JudgeResults(effort="medium")
    for index in range(6):
        en = _single(f"item-{index}", "en", fit=True, gesture="wave", emotional_tone="happy", emotional_intensity=4)
        ja = _single(f"item-{index}-ja", "ja", pair_id=f"item-{index}", fit=index % 2 == 0, gesture="wave",
                     emotional_tone="sad" if index < 3 else "happy", emotional_intensity=5,
                     speech_check={"tags": ["laughs"]})  # fmt: skip
        for record, score in ((en, 4), (ja, 3)):
            judge.items.append(JudgedItem("reply", {"lines": [len(records)]}, {"relevance": score}))
            records.append(record)

    pairs = report._pairs(records, "c", by_line(judge.items, "reply"), {})

    assert (pairs["pairs"], pairs["items"]) == (6, 6)
    differences = pairs["differences"]
    assert differences["reply"].mean == -1.0 and differences["emotional_intensity"].mean == 1.0
    assert differences["gesture_fit"].mean == -0.5 and differences["tagged"].mean == 1.0
    assert differences["expression"] is None
    assert (pairs["same_gesture"], pairs["same_tone"]) == (1.0, 0.5)


def test_long_chats_and_memory_manager_rows_join_their_records(tracked: prompt_set.PromptSet) -> None:
    # A recorded turn from the fixture run supplies every field the deterministic summary reads.
    template = next(iter(read_turns(FIXTURE_RUN)))
    chat = [{**template, "configuration": "c", "kind": "chat", "unit_id": "talk", "turn": turn}
            for turn in (1, 2, 3)]  # fmt: skip
    manager = [{"configuration": "row", "kind": "memory_manager", "unit_id": f"run-{index}", "effort": None,
                "error": None if index else "Timeout", "calls": 4,
                "result": {"approvals": [{"operation": "update"}] * index}} for index in range(3)]  # fmt: skip
    records = chat + manager
    judge = JudgeResults(effort="medium")
    judge.items.append(JudgedItem("long_chat", {"lines": [0, 1, 2]}, {"context_retention": 5, "repetition": 3}))
    for line in (4, 5):
        judge.items.append(JudgedItem("memory_manager", {"lines": [line]}, {"accuracy": 4}))
    criteria = {"long_chat": ["context_retention", "repetition"], "memory_manager": ["accuracy"]}

    data = report.build_report({"configurations": [{"label": "c"}]}, records, tracked, criteria, judge)

    long_chat = data["core"]["c"]["long_chat"]["interval"]
    assert (long_chat.mean, long_chat.n) == (4.0, 1)  # One transcript is one judged item, not three turns.
    row = data["manager"]["row"]
    assert (row["runs"], row["errors"], row["edits"], row["calls"], row["effort"]) == (3, 1, 3, 12, None)
    assert row["criteria"]["accuracy"]["interval"].n == 2
    assert "provider default" in report.render_report(data, title="t")


def test_the_pinned_effort_is_high_only_when_it_agrees_better() -> None:
    def table(**kappas: float | None) -> dict[str, dict[str, Any]]:
        return {measure: {"kappa": kappa} for measure, kappa in kappas.items()}

    assert calibrate.pin_effort({"medium": table(a=0.5), "high": table(a=0.7)})[1] == "high"
    assert calibrate.pin_effort({"medium": table(a=0.6), "high": table(a=0.6)})[1] == "medium"
    # A criterion only one effort could score is left out of both means.
    means, pinned = calibrate.pin_effort({"medium": table(a=0.6, b=None), "high": table(a=0.5, b=0.9)})
    assert means == {"medium": 0.6, "high": 0.5} and pinned == "medium"


def test_the_sample_gives_each_configuration_an_equal_share() -> None:
    items = [
        JudgeItem("reply", {}, {"configuration": f"cfg{c}", "area": area, "language": language})
        for c in range(8)
        for area in ("core", "long_chat")
        for language in ("en", "ja")
        for _ in range(3)
    ]

    chosen = calibrate.sample(items, seed=470)

    per = {f"cfg{c}": sum(1 for item in chosen if item.ref["configuration"] == f"cfg{c}") for c in range(8)}
    assert len(chosen) == calibrate.SAMPLE_PER_RUBRIC and max(per.values()) - min(per.values()) <= 1
    assert {item.ref["language"] for item in chosen} == {"en"}


def test_the_guard_ignores_dividers_and_names_the_source(tracked: prompt_set.PromptSet) -> None:
    records = [{"snapshot": {"files": [{"content": "| --- | --- | --- | --- |\n1234567890123456789012"}]},
                "speech": "A reply long enough to recognise anywhere."}]  # fmt: skip
    forbidden = report.forbidden_texts(records, tracked)

    report.check_public_safe("| --- | --- | --- | --- |\n1234567890123456789012", forbidden)
    with pytest.raises(EvalInputError, match="1 from a recorded speech"):
        report.check_public_safe("A reply long enough to recognise anywhere.", forbidden)


def test_tag_kinds_show_short_labels_as_code_and_only_count_long_ones(tracked: prompt_set.PromptSet) -> None:
    long_tag = "[whispering very softly now]"
    line = report._tag_kinds({"<sigh>": 2, "[laughs]": 1, long_tag: 1})

    assert line == "`<sigh>` 2, `[laughs]` 1, 1 longer, not shown"
    # A reply that is only that tag is a forbidden line, which the tag kinds must not repeat.
    report.check_public_safe(line, report.forbidden_texts([{"speech": long_tag}], tracked))
    assert report._tag_kinds({}) == "none"


def test_a_waived_calibration_is_recorded_and_reported_as_waived(
    run_dir: Path, stub: Stub, capsys: pytest.CaptureFixture[str]
) -> None:
    judge_args = ["judge", "--run-dir", str(run_dir), "--prompts", str(PROMPTS), "--effort", "medium"]
    assert cli.main([*judge_args, "--claude", str(stub.path)]) == 0
    waive = ["calibrate", "waive", "--run-dir", str(run_dir), "--prompts", str(PROMPTS), "--effort", "medium"]

    assert cli.main(waive) == 0
    assert cli.main(waive) == 2 and "already records a calibration or a waiver" in capsys.readouterr().err
    assert cli.main(_report_args(run_dir)) == 0

    result = report.load_calibration(run_dir)
    assert result is not None and result["waived"]["by"] == "owner" and result["pinned"] == "medium"
    text = (run_dir / "report.md").read_text(encoding="utf-8")
    assert "Waived by the owner on " in text and "Pinned effort" not in text
    assert "the owner waived calibration for this run, so nothing checks it here" in text


def test_report_finds_the_one_judged_effort_and_keeps_owner_text(
    run_dir: Path, stub: Stub, capsys: pytest.CaptureFixture[str]
) -> None:
    judge_args = ["judge", "--run-dir", str(run_dir), "--prompts", str(PROMPTS), "--claude", str(stub.path)]
    assert cli.main([*judge_args, "--effort", "high"]) == 0
    owner = run_dir / "recommendations.md"
    owner.write_text("- **Default model:** the owner's choice.\n", encoding="utf-8")

    assert cli.main(_report_args(run_dir, "--recommendations", str(owner))) == 0
    text = (run_dir / "report.md").read_text(encoding="utf-8")
    assert "- Effort: high;" in text and "the owner's choice." in text and "to be written" not in text
    assert cli.main(_report_args(run_dir, "--recommendations", str(owner), "--rerender")) == 0

    assert cli.main(_report_args(run_dir)) == 2  # Placeholders would replace the owner's text.
    assert "pass --overwrite" in capsys.readouterr().err
    assert cli.main([*judge_args, "--effort", "medium", "--rubric", "reply"]) == 0
    assert cli.main(_report_args(run_dir, "--recommendations", str(owner))) == 2
    assert "pass --effort" in capsys.readouterr().err

    other = run_dir / "rubrics.json"
    data = json.loads((INPUTS / "rubrics.json").read_text(encoding="utf-8"))
    other.write_text(json.dumps({**data, "version": "rubrics-x"}), encoding="utf-8")
    assert cli.main(_report_args(run_dir, "--effort", "high", "--rubrics", str(other))) == 2
    assert "planned from other inputs" in capsys.readouterr().err


def test_a_stopped_pilot_resumes_where_it_left_off(
    run_dir: Path, stub: Stub, capsys: pytest.CaptureFixture[str]
) -> None:
    args = ["--run-dir", str(run_dir), "--prompts", str(PROMPTS)]
    assert cli.main(["calibrate", "export", *args]) == 0
    folder = run_dir / calibrate.CALIBRATION_DIR
    template = json.loads((folder / "ratings.json").read_text(encoding="utf-8"))
    filled = {item: dict.fromkeys(criteria, 4) for item, criteria in template["items"].items()}
    (folder / "filled.json").write_text(json.dumps({**template, "items": filled}), encoding="utf-8")
    assert cli.main(["calibrate", "import", *args, "--ratings", str(folder / "filled.json")]) == 0

    stub.mode("limit-after-1")
    assert cli.main(["calibrate", "pilot", *args, "--claude", str(stub.path), "--concurrency", "1"]) == 3
    assert "1 batches judged" in capsys.readouterr().err and not (folder / "result.json").exists()
    stub.mode("ok")
    calls = len(stub.calls())
    assert cli.main(["calibrate", "pilot", *args, "--claude", str(stub.path)]) == 0
    batches = len(json.loads((folder / "judge" / "plan.json").read_text(encoding="utf-8"))["batches"])
    assert len(stub.calls()) - calls == 2 * batches - 1  # The batch judged before the stop is not judged again.
    assert json.loads((folder / "result.json").read_text(encoding="utf-8"))["prompt_set_version"]


def test_a_japanese_memory_pair_shows_only_when_both_chats_ran(tracked: prompt_set.PromptSet) -> None:
    japanese = next(chat for chat in tracked.memory_chats if chat.pair_id)
    original = str(japanese.pair_id)
    english: list[dict[str, Any]] = [
        {"configuration": "c", "kind": "recall", "unit_id": original, "arm": ARM_BOTH, "expect": []}
    ]
    both = [*english, {**english[0], "unit_id": japanese.id}]
    kept = {ARM_BOTH: {(original, "entry"): 1, (japanese.id, "entry"): 0}}

    assert report._memory_pairs(english, "c", tracked, kept) == {}
    [row] = report._memory_pairs(both, "c", tracked, kept).values()
    assert (row["english"]["kept"], row["japanese"]["kept"], row["japanese"]["keep"]) == (1, 0, 1)

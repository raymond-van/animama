"""The benchmark report (spec R16-R18): numbers from a run's records and judge results, rendered as Markdown.

``build_report`` computes everything from the recorded files alone, with a
fixed bootstrap seed and no clock, so rendering the same inputs again gives
the same bytes (``report --rerender`` checks that). The tracked report holds
ids, labels, counts and scores only: ``check_public_safe`` refuses any output
that contains a reply, saved memory or prompt text, which stay in the
git-ignored drafts folder.
"""

from __future__ import annotations

import json
import statistics
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

from ..core.inputs import EvalInputError
from ..core.stats import TOKEN_STAT_KEYS
from .calibrate import CALIBRATION_DIR
from .intervals import MIN_GROUPS, Interval, bootstrap_mean, bootstrap_paired, comparable, distinguishable
from .judge import JUDGE_NAME
from .measures import (
    AUDIO_TAG_KINDS,
    REACTION_INTENSITIES,
    STYLE_VIOLATIONS,
    expression_targets,
    summarize_configuration,
)
from .memory_runner import ARM_BOTH, ARM_MEMORIES_MD_ONLY, ARM_REMEMBER_ONLY
from .prompt_set import PromptSet
from .rubrics import RubricSet
from .scores import JudgedItem, JudgeResults, by_line, item_score

__all__ = [
    "build_report",
    "check_public_safe",
    "criteria_keys",
    "family_caveat",
    "forbidden_texts",
    "load_calibration",
    "render_report",
]

ARMS = (ARM_REMEMBER_ONLY, ARM_MEMORIES_MD_ONLY, ARM_BOTH)
ARM_NAMES = {
    ARM_REMEMBER_ONLY: "(a) remember only",
    ARM_MEMORIES_MD_ONLY: "(b) MEMORIES.md only",
    ARM_BOTH: "(c) both",
}
CORE_KINDS = frozenset({"single", "chat"})
LIMITATIONS = (
    "Memory turns and OpenAI Memory Manager runs keep the app's real provider storage (D5); the `run` command "
    "turns Agents SDK tracing off.",
    "Chat's memory search uses PostgreSQL's english text search, which does not split Japanese into words, so "
    "Japanese episode notes are found only by their exact text.",
    "Companion-safety crisis detection follows production: provider moderation runs on OpenAI Responses rows only.",
    "In arm (a), the memory tools' descriptions still offer MEMORIES.md edits, which the tool then refuses.",
    "The Memory Manager runs once per catalog row at its runtime's own effort (D16), not per configuration.",
    "Latency compares only within this run; quality compares across runs of the same prompt-set version and "
    "results series.",
)
_CAPTURE_COUNTS = (
    "keep", "kept", "noise", "noise_kept", "sensitive", "sensitive_breaks", "episodes", "changed_files", "unjudged",
)  # fmt: skip
_MIN_FORBIDDEN = 20
"""Texts this long or longer may not appear in a report; shorter ones collide with ordinary labels."""


# --- Computing ------------------------------------------------------------------------------


def _unit(record: Mapping[str, Any]) -> tuple[Any, ...]:
    """What a bootstrap resamples as one group (D9): a single-turn item with all its personas and repeats, or a
    whole conversation (a scripted, memory or recall chat in one arm) with all its turns."""

    return tuple(record.get(key) for key in ("kind", "unit_id", "arm"))


def _judged(
    turns: Sequence[Mapping[str, Any]],
    lines: Iterable[int],
    judged: Mapping[int, JudgedItem],
    score: Callable[[JudgedItem], float | None] = item_score,
) -> dict[str, Any]:
    """Judged scores of ``lines`` with their bootstrap interval, and how many judgements are missing."""

    groups: dict[tuple[Any, ...], list[float]] = defaultdict(list)
    missing = 0
    for line in lines:
        item = judged.get(line)
        if item is None:
            continue
        value = score(item) if not item.missing else None
        if value is None:
            missing += 1
            continue
        groups[_unit(turns[line])].append(value)
    return {"interval": bootstrap_mean(list(groups.values())), "missing": missing}


def _criteria(
    turns: Sequence[Mapping[str, Any]], lines: Sequence[int], judged: Mapping[int, JudgedItem], keys: Sequence[str]
) -> dict[str, Any]:
    return {key: _judged(turns, lines, judged, _criterion(key)) for key in keys}


def _criterion(key: str) -> Callable[[JudgedItem], float | None]:
    def score(item: JudgedItem) -> float | None:
        value = (item.scores or {}).get(key)
        return float(value) if value is not None else None

    return score


def _lines(turns: Sequence[Mapping[str, Any]], **match: Any) -> list[int]:
    def ok(record: Mapping[str, Any]) -> bool:
        for key, value in match.items():
            actual = record.get(key)
            if isinstance(value, set | frozenset):
                if actual not in value:
                    return False
            elif actual != value:
                return False
        return True

    return [line for line, record in enumerate(turns) if ok(record)]


def _median(values: Sequence[float]) -> float | None:
    return statistics.median(values) if values else None


def _mean(values: Sequence[float]) -> float | None:
    return statistics.fmean(values) if values else None


def build_report(
    manifest: Mapping[str, Any],
    turns: Sequence[Mapping[str, Any]],
    prompt_set: PromptSet,
    criteria: Mapping[str, Sequence[str]],
    judge: JudgeResults,
    calibration: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Every number the report shows. ``criteria`` lists each rubric's criterion keys in rubric order."""

    labels = [c["label"] for c in manifest.get("configurations") or () if not c.get("not_run")]
    judged = {rubric: by_line(judge.items, rubric) for rubric in criteria}
    reply, transcripts = judged.get("reply", {}), judged.get("long_chat", {})
    priced = {label: rates is not None for label, rates in (manifest.get("price_source") or {}).items()}
    items = {item.id: item for item in prompt_set.items}
    core: dict[str, Any] = {}
    for label in labels:
        lines = _lines(turns, configuration=label, kind=CORE_KINDS, error=None)
        chats = _lines(turns, configuration=label, kind="chat")
        records = [turn for turn in turns if turn.get("configuration") == label]
        summary = summarize_configuration(records)
        costs = [turn.get("estimated_cost_usd") for turn in records if turn.get("kind") in CORE_KINDS]
        core[label] = {
            "summary": summary,
            "targets": expression_targets(records, items),
            "priced": priced.get(label, False) and None not in costs,
            "gesture_fit": _fit(turns, label),
            "speech_length": _median([len(turns[ln].get("speech") or "") for ln in lines]),
            "reply": _judged(turns, lines, reply),
            "reply_criteria": _criteria(turns, lines, reply, criteria.get("reply", ())),
            "expression": _judged(turns, lines, judged.get("expression", {})),
            "expression_criteria": _criteria(
                turns, lines, judged.get("expression", {}), criteria.get("expression", ())
            ),
            "audio_tags": _judged(turns, lines, judged.get("audio_tags", {})),
            "long_chat": _judged(turns, chats, transcripts),
            "long_chat_criteria": _criteria(turns, chats, transcripts, criteria.get("long_chat", ())),
            "pairs": _pairs(turns, label, reply, judged.get("expression", {})),
            "split": {
                "tuned": _judged(turns, [ln for ln in lines if not turns[ln].get("held_out")], reply),
                "held_out": _judged(turns, [ln for ln in lines if turns[ln].get("held_out")], reply),
            },
        }
    return {
        "manifest": {
            key: manifest.get(key)
            for key in (
                "started_at",
                "finished_at",
                "aborted",
                "tier",
                "repeats",
                "scripted_repeats",
                "caps",
                "calls_made",
                "estimated_spend_usd",
                "turns_recorded",
                "retries",
            )
        },  # fmt: skip
        "conditions": manifest.get("conditions") or {},
        "inputs": {
            "prompt_set": {key: value for key, value in (manifest.get("prompt_set") or {}).items() if key != "path"},
            "rubrics": {"version": judge.rubrics_version, "sha256": judge.rubrics_sha256},
        },
        "price_source": manifest.get("price_source") or {},
        "configurations": [
            {
                key: c.get(key)
                for key in (
                    "label",
                    "provider_type",
                    "model",
                    "effort",
                    "not_run",
                    "native_context_compaction",
                    "served_models",
                )
            }  # fmt: skip
            for c in manifest.get("configurations") or ()
        ],
        "japanese_search_probe": (manifest.get("japanese_search_probe") or {}).get("matches"),
        "core": core,
        "rankings": _rankings(core),
        "memory": _memory(turns, labels, prompt_set, judge, criteria),
        "manager": _manager(turns, judge, criteria.get("memory_manager", ())),
        "judge": {
            "effort": judge.effort,
            "models": judge.models,
            "cli_versions": judge.cli_versions,
            "batches": judge.batches,
            "missing": dict(sorted(Counter(item.rubric for item in judge.items if item.missing).items())),
            "items": dict(sorted(Counter(item.rubric for item in judge.items).items())),
        },
        "calibration": calibration,
        "criteria": {rubric: list(keys) for rubric, keys in criteria.items()},
    }


def _fit(turns: Sequence[Mapping[str, Any]], label: str) -> dict[str, Any]:
    """Deterministic Gesture fit (#409): the share of single-turn replies whose Gesture is acceptable, with an
    interval grouped by item."""

    groups: dict[tuple[Any, ...], list[float]] = defaultdict(list)
    for line in _lines(turns, configuration=label, kind="single", error=None):
        fit = turns[line].get("fit")
        if fit is not None:
            groups[_unit(turns[line])].append(1.0 if fit else 0.0)
    return {"interval": bootstrap_mean(list(groups.values())), "missing": 0}


_PAIRED = ("reply", "expression", "gesture_fit", "emotional_intensity", "tagged")


def _pairs(
    turns: Sequence[Mapping[str, Any]],
    label: str,
    reply: Mapping[int, JudgedItem],
    expression: Mapping[int, JudgedItem],
) -> dict[str, Any]:
    """English-Japanese pairs (R9): each Japanese single-turn reply against its English original's, same persona
    and repeat. Differences are Japanese minus English, grouped by item for the interval."""

    def values(line: int) -> dict[str, float | None]:
        record = turns[line]
        check = record.get("speech_check") or {}
        reply_item, expression_item = reply.get(line), expression.get(line)
        fit = record.get("fit")
        intensity = record.get("emotional_intensity")
        return {
            "reply": item_score(reply_item) if reply_item is not None else None,
            "expression": item_score(expression_item) if expression_item is not None else None,
            "gesture_fit": None if fit is None else float(bool(fit)),
            "emotional_intensity": float(intensity) if isinstance(intensity, int | float) else None,
            "tagged": 1.0 if check.get("tags") else 0.0,
        }

    english: dict[tuple[Any, ...], int] = {}
    japanese: dict[tuple[Any, ...], int] = {}
    for line in _lines(turns, configuration=label, kind="single", error=None):
        record = turns[line]
        if record.get("language") == "ja" and record.get("pair_id"):
            japanese[(record["pair_id"], record.get("persona"), record.get("repeat"))] = line
        elif record.get("language") == "en":
            english[(record["unit_id"], record.get("persona"), record.get("repeat"))] = line
    matched = [(english[key], japanese[key]) for key in sorted(japanese, key=str) if key in english]
    differences: dict[str, dict[str, list[float]]] = {measure: defaultdict(list) for measure in _PAIRED}
    same = {"gesture": 0, "emotional_tone": 0}
    for en_line, ja_line in matched:
        en, ja = values(en_line), values(ja_line)
        for measure in _PAIRED:
            first, second = en[measure], ja[measure]
            if first is not None and second is not None:
                differences[measure][turns[en_line]["unit_id"]].append(second - first)
        for key in same:
            same[key] += turns[en_line].get(key) == turns[ja_line].get(key)
    return {
        "pairs": len(matched),
        "items": len({turns[en_line]["unit_id"] for en_line, _ in matched}),
        "differences": {measure: bootstrap_mean(list(groups.values())) for measure, groups in differences.items()},
        "same_gesture": same["gesture"] / len(matched) if matched else None,
        "same_tone": same["emotional_tone"] / len(matched) if matched else None,
    }


def _rankings(core: Mapping[str, Mapping[str, Any]]) -> dict[str, list[list[str]]]:
    """For each judged measure, the configuration pairs whose intervals are apart, higher first."""

    rankings: dict[str, list[list[str]]] = {}
    for measure in ("reply", "expression", "audio_tags", "long_chat"):
        apart = []
        labels = sorted(core)
        for index, first in enumerate(labels):
            for second in labels[index + 1 :]:
                a, b = core[first][measure]["interval"], core[second][measure]["interval"]
                if distinguishable(a, b):
                    apart.append([first, second] if a.mean > b.mean else [second, first])
        rankings[measure] = apart
    return rankings


def _memory(
    turns: Sequence[Mapping[str, Any]],
    labels: Sequence[str],
    prompt_set: PromptSet,
    judge: JudgeResults,
    criteria: Mapping[str, Sequence[str]],
) -> dict[str, Any]:
    """The memory-arm comparison per configuration (spec R6)."""

    kinds = {chat.id: {entry.id: entry.kind for entry in chat.checklist} for chat in prompt_set.memory_chats}
    capture_items = by_line(judge.items, "capture")
    memory_items = by_line(judge.items, "memory_turn")
    recall_items = by_line(judge.items, "recall")
    reply_items = by_line(judge.items, "reply")
    tag_items = by_line(judge.items, "audio_tags")
    result: dict[str, Any] = {}
    for label in labels:
        arms: dict[str, Any] = {}
        kept_by_arm: dict[str, dict[tuple[str, str], int]] = {}
        for arm in ARMS:
            capture = _lines(turns, configuration=label, kind="capture", arm=arm)
            if not capture and not _lines(turns, configuration=label, kind="memory", arm=arm):
                continue
            counts: Counter[str] = Counter(dict.fromkeys(_CAPTURE_COUNTS, 0))
            kept: dict[tuple[str, str], int] = {}
            for line in capture:
                record, item = turns[line], capture_items.get(line)
                saved = _saved_counts(record, prompt_set)
                counts["episodes"] += saved["episodes"]
                counts["changed_files"] += saved["changed_files"]
                if item is None or item.entries is None:
                    counts["unjudged"] += 1
                    continue
                for entry, present in item.entries.items():
                    kind = kinds.get(record["unit_id"], {}).get(entry)
                    if kind == "keep":
                        counts["keep"] += 1
                        counts["kept"] += present
                        kept[(record["unit_id"], entry)] = int(present)
                    elif kind == "noise":
                        counts["noise"] += 1
                        counts["noise_kept"] += present
                    elif kind == "sensitive":
                        counts["sensitive"] += 1
                        counts["sensitive_breaks"] += present
            kept_by_arm[arm] = kept
            memory_lines = _lines(turns, configuration=label, kind="memory", arm=arm)
            recall_lines = _lines(turns, configuration=label, kind="recall", arm=arm)
            arms[arm] = {
                "capture": dict(counts),
                "kept_rate": counts["kept"] / counts["keep"] if counts["keep"] else None,
                "recall": _recall(turns, recall_lines),
                "recall_judged": _judged(turns, recall_lines, recall_items),
                "reply": _judged(turns, memory_lines + recall_lines, reply_items),
                "audio_tags": _judged(turns, memory_lines + recall_lines, tag_items),
                "memory_turn": _criteria(turns, memory_lines, memory_items, criteria.get("memory_turn", ())),
                "tools": _tools(turns, memory_lines + recall_lines),
                "latency_median": _median(
                    [turns[ln]["latency_seconds"] for ln in memory_lines if turns[ln].get("error") is None]
                ),
                # Turns with a call that reported no usage are left out, as the core token summary does.
                "input_tokens_mean": _mean(
                    [
                        turns[ln]["usage"]["input_tokens"]
                        for ln in memory_lines
                        if turns[ln].get("error") is None and not (turns[ln].get("usage") or {}).get("unreported_calls")
                    ]
                ),
                "failed_turns": sum(1 for ln in memory_lines if turns[ln].get("error") is not None),
            }
        differences = {}
        for first, second in ((ARM_REMEMBER_ONLY, ARM_MEMORIES_MD_ONLY), (ARM_REMEMBER_ONLY, ARM_BOTH),
                              (ARM_MEMORIES_MD_ONLY, ARM_BOTH)):  # fmt: skip
            # Each must-keep entry is one pair: a run has only a few memory chats, too few to resample whole.
            a, b = kept_by_arm.get(first, {}), kept_by_arm.get(second, {})
            shared = sorted(set(a) & set(b))
            differences[f"{second}-{first}"] = bootstrap_paired([(a[key], b[key]) for key in shared])
        result[label] = {
            "arms": arms,
            "kept_differences": differences,
            "pairs": _memory_pairs(turns, label, prompt_set, kept_by_arm),
        }
    return result


def _memory_pairs(
    turns: Sequence[Mapping[str, Any]],
    label: str,
    prompt_set: PromptSet,
    kept_by_arm: Mapping[str, Mapping[tuple[str, str], int]],
) -> dict[str, Any]:
    """Each Japanese memory chat against its English original, per arm: entries kept and recall matched."""

    pairs: dict[str, Any] = {}
    ran = {(turn.get("unit_id"), turn.get("arm")) for turn in turns if turn.get("configuration") == label}
    for chat in prompt_set.memory_chats:
        if not chat.pair_id:
            continue
        for arm, kept in kept_by_arm.items():
            if (chat.id, arm) not in ran or (chat.pair_id, arm) not in ran:
                continue  # The tier ran only one of the pair.
            row = {}
            for language, chat_id in (("english", chat.pair_id), ("japanese", chat.id)):
                entries = [value for (unit, _entry), value in kept.items() if unit == chat_id]
                recall = _recall(turns, _lines(turns, configuration=label, kind="recall", arm=arm, unit_id=chat_id))
                row[language] = {"kept": sum(entries), "keep": len(entries), "recall": recall}
            pairs[f"{chat.id}/{arm}"] = {"chat": chat.id, "arm": arm, **row}
    return pairs


def _saved_counts(capture: Mapping[str, Any], prompt_set: PromptSet) -> dict[str, int]:
    """What a memory chat saved, measured against its fixture's seed: episode notes and changed files."""

    chat = next((chat for chat in prompt_set.memory_chats if chat.id == capture.get("unit_id")), None)
    seeds: dict[tuple[bool, str], str] = {}
    if chat is not None:
        fixture = prompt_set.fixture(chat.fixture)
        seeds[(True, "MEMORIES.md")] = fixture.anima_memories
        seeds.update({(False, f.path): f.content for f in fixture.user_files})
    snapshot = capture.get("snapshot") or {}
    changed = sum(
        1 for f in snapshot.get("files") or () if seeds.get((bool(f.get("anima")), f.get("path"))) != f.get("content")
    )
    return {"episodes": len(snapshot.get("episodes") or ()), "changed_files": changed}


def _recall(turns: Sequence[Mapping[str, Any]], lines: Sequence[int]) -> dict[str, Any]:
    matched = [turns[ln].get("recall_match") for ln in lines if turns[ln].get("expect")]
    checked = [value for value in matched if value is not None]
    return {
        "probes": len(matched),
        "matched": sum(1 for value in checked if value),
        "failed_turns": len(matched) - len(checked),
        "rate": sum(1 for value in checked if value) / len(checked) if checked else None,
    }


def _tools(turns: Sequence[Mapping[str, Any]], lines: Sequence[int]) -> dict[str, Any]:
    """Memory tool use per turn; a failed turn's calls are unknown, so it is counted apart."""

    known = [turns[ln]["tool_calls"] for ln in lines if turns[ln].get("tool_calls") is not None]
    calls = [call for turn_calls in known for call in turn_calls]
    succeeded = sum(1 for call in calls if call.get("ok"))
    return {
        "turns": len(known),
        "unknown_turns": len(lines) - len(known),
        "calls": len(calls),
        "succeeded": succeeded,
        "calls_per_turn": len(calls) / len(known) if known else None,
        "success_rate": succeeded / len(calls) if calls else None,
    }


def _manager(turns: Sequence[Mapping[str, Any]], judge: JudgeResults, keys: Sequence[str]) -> dict[str, Any]:
    items = by_line(judge.items, "memory_manager")
    rows: dict[str, Any] = {}
    for row in sorted({turn["configuration"] for turn in turns if turn.get("kind") == "memory_manager"}):
        lines = _lines(turns, configuration=row, kind="memory_manager")
        ok = [ln for ln in lines if turns[ln].get("error") is None]
        rows[row] = {
            "runs": len(lines),
            "errors": len(lines) - len(ok),
            "effort": turns[lines[0]].get("effort") if lines else None,
            "edits": sum(len((turns[ln].get("result") or {}).get("approvals") or ()) for ln in ok),
            "calls": sum(turns[ln].get("calls") or 0 for ln in lines),
            "overall": _judged(turns, ok, items),
            "criteria": _criteria(turns, ok, items, keys),
        }
    return rows


# --- Rendering ------------------------------------------------------------------------------


def _interval(value: Mapping[str, Any] | None) -> str:
    interval: Interval | None = (value or {}).get("interval") if isinstance(value, Mapping) else value
    missing = (value or {}).get("missing", 0) if isinstance(value, Mapping) else 0
    if interval is None:
        return "—" + (f" ({missing} missing)" if missing else "")
    text = f"{interval.mean:.2f} [{interval.low:.2f}, {interval.high:.2f}] n={interval.n}"
    return text + (f", {missing} missing" if missing else "")


def _difference(interval: Interval | None) -> str:
    if interval is None:
        return "—"
    if not comparable(interval):
        verdict = f"too few to compare ({interval.groups} of {MIN_GROUPS} groups)"
    else:
        verdict = "not distinguishable" if interval.low <= 0 <= interval.high else "apart"
    return f"{interval.mean:+.2f} [{interval.low:+.2f}, {interval.high:+.2f}] n={interval.n}, {verdict}"


def _number(value: float | int | None, digits: int = 2) -> str:
    if value is None:
        return "—"
    return f"{value:.{digits}f}" if isinstance(value, float) else str(value)


def _percent(value: float | None) -> str:
    return "—" if value is None else f"{value:.0%}"


def _spread(values: Mapping[str, Any]) -> str:
    return " / ".join(_number(values.get(key)) for key in ("median", "p90", "mean"))


def _share(count: int, total: int) -> str:
    """A rate with its sample size, as R16 asks for every score."""

    return f"{_percent(count / total) if total else '—'} ({count} of {total})"


def _tag_kinds(kinds: Mapping[str, int]) -> str:
    """One configuration's tag labels and counts, as code so angle-bracket tags survive Markdown.

    A label as long as the lines the safety check looks for (or holding a backtick) is model text rather than a
    tag name: it is counted, not shown, so a reply that is one long tag cannot stop the report being written.
    """

    def hidden(tag: str) -> bool:
        return len(tag) >= _MIN_FORBIDDEN or "`" in tag

    shown = [f"`{tag}` {count}" for tag, count in kinds.items() if not hidden(tag)]
    not_shown = sum(count for tag, count in kinds.items() if hidden(tag))
    if not_shown:
        shown.append(f"{not_shown} longer, not shown")
    return ", ".join(shown) or "none"


def _table(header: Sequence[str], rows: Iterable[Sequence[str]]) -> list[str]:
    lines = ["| " + " | ".join(header) + " |", "|" + " --- |" * len(header)]
    lines.extend("| " + " | ".join(row) + " |" for row in rows)
    return lines + [""]


def _cost(c: Mapping[str, Any]) -> str:
    return f"{c['summary']['estimated_cost_usd']:.4f}" if c["priced"] else "unpriced"


def render_report(data: Mapping[str, Any], *, title: str, recommendations: str | None = None) -> str:
    """The report as Markdown; the same data always renders the same bytes.

    ``recommendations`` is the owner's own text for the Recommendations section; without it the section holds
    placeholders.
    """

    manifest, core = data["manifest"], data["core"]
    out = [f"# {title}", ""]
    if manifest.get("aborted"):
        out += [f"**Partial run:** it stopped early ({manifest['aborted']}); every figure covers the turns it "
                "finished.", ""]  # fmt: skip
    out += ["## Scorecard", "",
            "Judged scores are means on the 1-5 scale with a 95% bootstrap interval and the number of judged "
            "replies; rates give their counts. Configurations are not ranked unless listed under Rankings: "
            f"overlapping intervals, or intervals from fewer than {MIN_GROUPS} items or chats, are not "
            "distinguishable.", ""]  # fmt: skip
    out += _table(
        ["Configuration", "Reply", "Expression", "Audio tags", "Long chat", "Gesture fit", "Strict parse",
         "Failed turns", "Latency median / p90 (s)", "Tokens in / out (mean)", "Cost (USD)"],
        (
            [
                label,
                _interval(c["reply"]),
                _interval(c["expression"]),
                _interval(c["audio_tags"]),
                _interval(c["long_chat"]),
                _interval(c["gesture_fit"]),
                _share(c["summary"]["recovery"]["strict"], c["summary"]["turns"] - c["summary"]["errors"]),
                f"{c['summary']['errors']} of {c['summary']['turns']}",
                f"{_number(c['summary']['latency']['single_turn']['latency_seconds']['median'])} / "
                f"{_number(c['summary']['latency']['single_turn']['latency_seconds']['p90'])}",
                f"{_number(c['summary']['tokens']['single_turn']['input_tokens']['mean'], 0)} / "
                f"{_number(c['summary']['tokens']['single_turn']['output_tokens']['mean'], 0)}",
                _cost(c),
            ]
            for label, c in core.items()
        ),
    )  # fmt: skip
    out += ["### Rankings", ""]
    for measure, apart in data["rankings"].items():
        text = "; ".join(f"{higher} above {lower}" for higher, lower in apart) or "no configurations are apart"
        out.append(f"- {measure}: {text}.")
    out.append("")

    out += ["## Core turns", ""]
    for rubric in ("reply", "expression"):
        keys = list(next(iter(core.values()))[f"{rubric}_criteria"]) if core else []
        out += [f"### {rubric.capitalize()} criteria", ""]
        extra = ["Speech length median (characters)"] if rubric == "reply" else []
        out += _table(["Configuration", *keys, *extra],
                      ([label, *(_interval(c[f"{rubric}_criteria"][key]) for key in keys),
                        *([_number(c["speech_length"], 0)] if extra else [])]
                       for label, c in core.items()))  # fmt: skip
    out += ["### Structured output", ""]
    out += _table(
        ["Configuration", "Strict", "Lenient", "Repaired", "Salvaged", "Plain text", "Dropped Gestures",
         "Errors by code"],
        (
            [
                label,
                *(str(c["summary"]["recovery"][path]) for path in ("strict", "lenient", "repaired", "salvaged",
                                                                     "plain_text")),
                str(c["summary"]["dropped_gestures"]),
                ", ".join(f"{code} {count}" for code, count in c["summary"]["error_codes"].items()) or "none",
            ]
            for label, c in core.items()
        ),
    )  # fmt: skip
    out += ["### Audio tags and spoken style", "",
            "Checked against chat's ElevenLabs and Speech rules, over replies that parsed.", ""]  # fmt: skip
    out += _table(
        ["Configuration", "Tagged replies", "Tags", "Sounds", "Over sound cap", "Not English brackets",
         "Tags in display", "Tags only", "Accent requests", *(f"Style: {name}" for name in STYLE_VIOLATIONS)],
        (
            [
                label,
                _share(c["summary"]["speech"]["with_tags"], c["summary"]["speech"]["replies"]),
                str(c["summary"]["speech"]["tags"]),
                str(c["summary"]["speech"]["sounds"]),
                str(c["summary"]["speech"]["over_sound_cap"]),
                str(c["summary"]["speech"]["angle_or_non_english_tags"]),
                str(c["summary"]["speech"]["display_tags"]),
                str(c["summary"]["speech"]["tags_only_speech"]),
                str(c["summary"]["speech"]["accent_requests"]),
                *(str(c["summary"]["speech"]["style_violations"][name]) for name in STYLE_VIOLATIONS),
            ]
            for label, c in core.items()
        ),
    )  # fmt: skip
    out += ["Tag kinds: " + "; ".join(
        f"{label} {_tag_kinds(c['summary']['speech']['tag_kinds'])}" for label, c in core.items()
    ) + ".", ""]  # fmt: skip
    out += _render_targets(core)
    out += ["### Operations", "",
            "Seconds are median / p90 / mean over successful turns; tokens are per-turn means over turns whose "
            "calls all reported usage.", ""]  # fmt: skip
    rows = []
    for label, c in core.items():
        for part, name in (("single_turn", "single"), ("chat", "chat")):
            latency, tokens = c["summary"]["latency"][part], c["summary"]["tokens"][part]
            rows.append([
                label, name, str(latency["turns"]), _spread(latency["latency_seconds"]),
                _spread(latency["first_token_seconds"]), _spread(latency["first_output_seconds"]),
                *(_number(tokens[key]["mean"], 0) for key in TOKEN_STAT_KEYS),
            ])  # fmt: skip
    out += _table(
        ["Configuration", "Part", "Turns", "Latency", "First token", "First speech", "Input", "Cached input",
         "Cache write", "Output", "Reasoning"],
        rows,
    )  # fmt: skip
    out += ["Calls: " + "; ".join(f"{label} {c['summary']['calls']}" for label, c in core.items()) + ".", ""]

    out += ["## Distributions", "",
            "Side by side, with no target distribution: the share of turns without a value, the number of "
            "distinct values, the share of the three most frequent, and the longest run of one value in a "
            "scripted chat.", ""]  # fmt: skip
    for key in ("gesture", "emotional_tone", "emotional_intensity"):
        out += [f"### {key.replace('_', ' ').capitalize()}", ""]
        out += _table(
            ["Configuration", "Turns", "None", "Distinct", "Top three", "Top-three share", "Longest run"],
            (
                [
                    label,
                    str(c["summary"]["distributions"][key]["n"]),
                    _percent(c["summary"]["distributions"][key]["null_rate"]),
                    str(c["summary"]["distributions"][key]["distinct"]),
                    ", ".join(f"{value} ({count})" for value, count in c["summary"]["distributions"][key]["top"]),
                    _percent(c["summary"]["distributions"][key]["top_share"]),
                    str(max((chat[key]["longest_run"] for chat in c["summary"]["chats"]), default=0)),
                ]
                for label, c in core.items()
            ),
        )
    out += ["### Emotional intensity by Reaction intensity", "",
            "Core turns by the Reaction intensity their intensity plays: none for 1-2, then Mild for 3-4, Moderate "
            "for 5-6, Strong for 7-8 and Intense for 9-10.", ""]  # fmt: skip
    reactions = {label: c["targets"]["reaction_intensity"] for label, c in core.items()}
    out += _table(
        ["Configuration", "Turns", *(_REACTION_LABELS[level] for level in REACTION_INTENSITIES)],
        (
            [
                label,
                str(reactions[label]["n"]),
                *(_share(reactions[label]["counts"][level], reactions[label]["n"]) for level in REACTION_INTENSITIES),
            ]
            for label, c in core.items()
        ),
    )

    out += ["## Long chats", ""]
    keys = list(next(iter(core.values()))["long_chat_criteria"]) if core else []
    out += _table(["Configuration", *keys],
                  ([label, *(_interval(c["long_chat_criteria"][key]) for key in keys)]
                   for label, c in core.items()))  # fmt: skip

    out += _render_memory(data["memory"], data["criteria"].get("memory_turn", ()))
    out += ["## English and Japanese pairs", "",
            "Each Japanese single-turn reply against its English original's, for the same persona and repeat: "
            "Japanese minus English, grouped by item for the interval. Gesture fit and Audio tags are shares, so "
            "their differences run from -1 to 1. Same Gesture counts no Gesture in both replies as the same "
            "choice.", ""]  # fmt: skip
    out += _table(
        ["Configuration", "Pairs (items)", "Reply", "Expression", "Gesture fit", "Same Gesture", "Same tone",
         "Intensity", "Tagged"],
        (
            [label, f"{c['pairs']['pairs']} ({c['pairs']['items']})",
             *(_difference(c["pairs"]["differences"][measure]) for measure in ("reply", "expression", "gesture_fit")),
             _percent(c["pairs"]["same_gesture"]), _percent(c["pairs"]["same_tone"]),
             _difference(c["pairs"]["differences"]["emotional_intensity"]),
             _difference(c["pairs"]["differences"]["tagged"])]
            for label, c in core.items()
        ),
    )  # fmt: skip
    out += ["## Tuned and held-out items", "",
            "Reply scores on the items used while building the prompt set and on the held-out slice nobody tuned "
            "against.", ""]  # fmt: skip
    out += _table(["Configuration", "Tuned", "Held out"],
                  ([label, _interval(c["split"]["tuned"]), _interval(c["split"]["held_out"])]
                   for label, c in core.items()))  # fmt: skip
    out += _render_manager(data["manager"])
    out += _render_judge(data["judge"], data["calibration"], data["configurations"])
    out += _render_conditions(data)
    out += ["## Limitations", "", *(f"- {text}" for text in LIMITATIONS)]
    probe = data.get("japanese_search_probe")
    if probe:
        matches = ", ".join(f"{query} {'matched' if hit else 'no match'}" for query, hit in sorted(probe.items()))
        out.append(f"- Japanese search probe: {matches}.")
    out += ["", "## Recommendations", ""]
    if recommendations is not None:
        out += [recommendations.strip(), ""]
    else:
        out += ["The owner writes these; the tooling does not produce them.", "",
                "- **Default model:** _to be written by the owner._",
                "- **Episodic-memory design:** _to be written by the owner._", ""]  # fmt: skip
    return "\n".join(out)


_REACTION_LABELS = {
    "none": "None (1-2)",
    "mild": "Mild (3-4)",
    "moderate": "Moderate (5-6)",
    "strong": "Strong (7-8)",
    "intense": "Intense (9-10)",
}


def _render_targets(core: Mapping[str, Mapping[str, Any]]) -> list[str]:
    """Single-turn replies against the items' intended intensity bands, tones and audio tags.

    Each table appears only when the prompt set gives what it measures.
    """

    targets = {label: c["targets"] for label, c in core.items()}
    out: list[str] = []
    if any(t["intensity_band"]["scored"] or t["tones"]["scored"] for t in targets.values()):
        out += ["### Intended intensity and tones", "",
                "Single-turn replies against each item's intended intensity band and the tones that fit it.",
                ""]  # fmt: skip
        out += _table(
            ["Configuration", "Intensity in band", "Below band", "Above band", "Tone fits"],
            (
                [
                    label,
                    *(_share(t["intensity_band"][key], t["intensity_band"]["scored"])
                      for key in ("in_band", "below", "above")),
                    _share(t["tones"]["in_family"], t["tones"]["scored"]),
                ]
                for label, t in targets.items()
            ),
        )  # fmt: skip
    kinds = [kind for kind in AUDIO_TAG_KINDS if any(kind in t["audio_tags"] for t in targets.values())]
    if kinds:
        out += ["### Audio-tag recall", "",
                "Replies to each `audio-tag:<kind>` item that carry the tag it invites: any laugh (laughs, chuckles "
                "or giggles), a sigh, a gasp or a whisper; for `none` items, replies without any tag.", ""]  # fmt: skip
        out += _table(
            ["Configuration", *(f"`{kind}`" for kind in kinds)],
            (
                [
                    label,
                    *(_share(t["audio_tags"][kind]["hits"], t["audio_tags"][kind]["replies"])
                      if kind in t["audio_tags"] else "—" for kind in kinds),
                ]
                for label, t in targets.items()
            ),
        )  # fmt: skip
    return out


def _render_memory(memory: Mapping[str, Any], memory_criteria: Sequence[str]) -> list[str]:
    out = ["## Memory arms", "",
           "Capture counts the memory chat's checklist against what the arm saved; recall asks a fresh chat. "
           "Tool use leaves out failed turns, whose tool calls are unknown, and counts them apart. Kept-rate "
           "differences pair the same must-keep entry across arms.", ""]  # fmt: skip
    for label, entry in memory.items():
        out += [f"### {label}", ""]
        out += _table(
            ["Arm", "Kept", "Noise kept", "Sensitive breaks", "Saved notes / changed files", "Unjudged captures",
             "Recall matched", "Open recall", *memory_criteria, "Reply", "Audio tags", "Tool calls per turn",
             "Tool success",
             "Failed turns", "Latency median (s)", "Input tokens mean"],
            (
                [
                    ARM_NAMES[arm],
                    f"{a['capture']['kept']} of {a['capture']['keep']} ({_percent(a['kept_rate'])})",
                    f"{a['capture']['noise_kept']} of {a['capture']['noise']}",
                    f"{a['capture']['sensitive_breaks']} of {a['capture']['sensitive']}",
                    f"{a['capture']['episodes']} / {a['capture']['changed_files']}",
                    str(a["capture"]["unjudged"]),
                    f"{a['recall']['matched']} of {a['recall']['probes'] - a['recall']['failed_turns']}"
                    + (f" ({a['recall']['failed_turns']} failed)" if a["recall"]["failed_turns"] else ""),
                    _interval(a["recall_judged"]),
                    *(_interval(a["memory_turn"].get(key)) for key in memory_criteria),
                    _interval(a["reply"]),
                    _interval(a["audio_tags"]),
                    f"{_number(a['tools']['calls_per_turn'])} over {a['tools']['turns']} turns",
                    _share(a["tools"]["succeeded"], a["tools"]["calls"]),
                    f"{a['failed_turns']} memory, {a['tools']['unknown_turns']} unknown tools",
                    _number(a["latency_median"]),
                    _number(a["input_tokens_mean"], 0),
                ]
                for arm, a in entry["arms"].items()
            ),
        )  # fmt: skip
        for pair, diff in entry["kept_differences"].items():
            second, first = pair.split("-")
            out.append(f"- Kept rate, {ARM_NAMES[second]} minus {ARM_NAMES[first]}: {_difference(diff)}")
        for row in entry["pairs"].values():
            english, japanese = row["english"], row["japanese"]
            out.append(
                f"- {row['chat']} against its English original, {ARM_NAMES[row['arm']]}: kept "
                f"{japanese['kept']} of {japanese['keep']} against {english['kept']} of {english['keep']}; recall "
                f"matched {japanese['recall']['matched']} of {japanese['recall']['probes']} against "
                f"{english['recall']['matched']} of {english['recall']['probes']}."
            )
        out.append("")
    return out


def _render_manager(manager: Mapping[str, Any]) -> list[str]:
    out = ["## Memory Manager", "", "Each catalog row runs once at its runtime's own effort (D16).", ""]
    keys = list(next(iter(manager.values()))["criteria"]) if manager else []
    out += _table(
        ["Row", "Effort", "Runs", "Errors", "Edits", "Calls", "Overall", *keys],
        (
            [row, m["effort"] or "provider default", str(m["runs"]), str(m["errors"]), str(m["edits"]),
             str(m["calls"]), _interval(m["overall"]), *(_interval(m["criteria"][key]) for key in keys)]
            for row, m in manager.items()
        ),
    )  # fmt: skip
    return out


def _render_judge(
    judge: Mapping[str, Any], calibration: Mapping[str, Any] | None, configurations: Sequence[Mapping[str, Any]]
) -> list[str]:
    batches = judge["batches"]
    # The caveat is about a contestant from the judge's own family; a run without one says so.
    family = any(str(c.get("model") or "").startswith("claude-") for c in configurations)
    caveat = (
        family_caveat(calibration) if family else "No configuration in this run shares a model family with the judge."
    )
    out = ["## Judge", "", f"- {caveat}",
           f"- Effort: {judge['effort'] or 'not judged'}; served models: {', '.join(judge['models']) or '—'}; "
           f"CLI: {', '.join(judge['cli_versions']) or '—'}.",
           f"- Batches: {batches.get('ok', 0)} scored, {batches.get('missing', 0)} missing after retries, "
           f"{batches.get('not_run', 0)} not run, of {batches.get('planned', 0)} planned.",
           "- Items missing a score, by rubric: " + (", ".join(f"{rubric} {count} of {judge['items'][rubric]}"
                                                            for rubric, count in judge["missing"].items())
                                                 or "none") + ".", ""]  # fmt: skip
    out += ["## Calibration", ""]
    if not calibration:
        out += ["Not calibrated in this run. Calibration runs once per prompt-set version and rubric version; a "
                "later run uses the effort pinned then, recorded in that run's report.", ""]  # fmt: skip
        return out
    if calibration.get("waived"):
        out += [f"Waived by the owner on {calibration['waived']['date']}: no calibration sample was rated, so the "
                f"judge's scores are not checked against the owner's ratings in this run. The owner chose effort "
                f"{calibration.get('pinned')}.", ""]  # fmt: skip
        return out
    out += [f"Pinned effort: **{calibration.get('pinned')}** (higher mean weighted kappa over the criteria both "
            f"efforts could score; medium on a tie). The owner rated the `reply` and `expression` rubrics; the "
            f"others are judged by {JUDGE_NAME} alone.", ""]  # fmt: skip
    rows = []
    for effort, measures in sorted((calibration.get("agreement") or {}).items()):
        for measure, value in sorted(measures.items()):
            kappa = value.get("kappa")
            rows.append([effort, measure, str(value.get("n")), "—" if kappa is None else f"{kappa:.2f}",
                         _percent(value.get("exact")), _percent(value.get("within_one"))])  # fmt: skip
    out += _table(["Effort", "Measure", "Items", "Weighted kappa", "Exact", "Within one"], rows)
    return out


def _render_conditions(data: Mapping[str, Any]) -> list[str]:
    manifest, conditions, inputs = data["manifest"], data["conditions"], data["inputs"]
    out = ["## Conditions and inputs", ""]
    out += [
        f"- Window: {manifest.get('started_at')} to {manifest.get('finished_at')}; tier {manifest.get('tier')}; "
        f"repeats {manifest.get('repeats')} single-turn, {manifest.get('scripted_repeats')} scripted.",
        f"- Machine {conditions.get('machine')}, platform {conditions.get('platform')}, network "
        f"{conditions.get('network')}, source {conditions.get('source_revision')}, mock model "
        f"{conditions.get('llm_skip')}.",
        f"- Calls made {manifest.get('calls_made')}, estimated spend {manifest.get('estimated_spend_usd')} USD, caps "
        f"{json.dumps(manifest.get('caps'), sort_keys=True)}; turns recorded {manifest.get('turns_recorded')}.",
        *(
            f"- Retried after connection errors: {len(retry['units'])} units ({retry['replaced_turns']} records; "
            + ", ".join(f"{code} {count}" for code, count in retry["error_codes"].items())
            + f") from run {retry['of']}, run again {retry['started_at']} to {retry['finished_at']} at source "
            f"{(retry.get('conditions') or {}).get('source_revision')} with {retry['calls']} calls."
            for retry in manifest.get("retries") or ()
        ),
        "- Prompt set: " + ", ".join(f"{k} {v}" for k, v in sorted(inputs["prompt_set"].items())) + ".",
        f"- Rubrics: version {inputs['rubrics']['version']}, sha256 {inputs['rubrics']['sha256']}.",
        "",
    ]
    prices = data["price_source"]
    out += _table(
        ["Configuration", "Protocol", "Model", "Effort", "Served", "Native compaction", "Price per 1M tokens (USD)",
         "Not run"],
        (
            [c["label"], str(c["provider_type"]), str(c["model"]), str(c["effort"]),
             ", ".join(c.get("served_models") or ()) or "—", str(c.get("native_context_compaction")),
             _rates(prices.get(c["label"])), c.get("not_run") or "—"]
            for c in data["configurations"]
        ),
    )  # fmt: skip
    return out


def _rates(source: Any) -> str:
    rates = (source or {}).get("rates_per_million_usd") if isinstance(source, Mapping) else None
    if not rates:
        return "unpriced"
    return ", ".join(f"{key} {value}" for key, value in sorted(rates.items()))


# --- Public safety --------------------------------------------------------------------------


def forbidden_texts(turns: Sequence[Mapping[str, Any]], prompt_set: PromptSet) -> dict[str, str]:
    """Every reply, saved-memory and prompt line long enough to recognize, with where it came from.

    A line must also hold a letter (in any script), so a Markdown divider or a row of digits in saved memory
    never blocks a report whose own tables share it.
    """

    texts: list[tuple[str, str]] = []
    for record in turns:
        texts += [(f"a recorded {key}", str(record.get(key) or "")) for key in ("speech", "display", "remember",
                                                                                 "message")]  # fmt: skip
        for snapshot_key in ("snapshot", "store"):
            snapshot = record.get(snapshot_key) or {}
            texts += [("saved memory", str(f.get("content") or "")) for f in snapshot.get("files") or ()]
            texts += [("saved memory", str(e.get("text") or "")) for e in snapshot.get("episodes") or ()]
        texts += [("a memory change", str(change.get("diff") or "")) for change in record.get("memory_changes") or ()]
        for call in record.get("tool_calls") or ():
            texts += [("a tool call", value) for value in _strings(call.get("arguments"))]
        texts += [("a checklist", str(entry.get("text") or "")) for entry in record.get("checklist") or ()
                  if isinstance(entry, dict)]  # fmt: skip
        result = record.get("result") or {}
        texts += [("a Memory Manager message", str(m.get("content") or "")) for m in result.get("messages") or ()]
        texts += [("a Memory Manager edit", str(a.get("unified_diff") or "")) for a in result.get("approvals") or ()]
    texts += [("a persona", persona.identity) for persona in prompt_set.personas]
    texts += [("a prompt", item.message) for item in prompt_set.items]
    texts += [("a prompt", turn) for chat in prompt_set.scripted_chats for turn in chat.turns]
    for chat in prompt_set.memory_chats:
        texts += [("a prompt", text) for text in (*chat.turns, *(probe.message for probe in chat.recall))]
        texts += [("a checklist", entry.text) for entry in chat.checklist]
    for fixture in prompt_set.memory_fixtures:
        texts += [
            ("a memory fixture", text) for text in (fixture.anima_memories, *(f.content for f in fixture.user_files))
        ]
    for run in prompt_set.manager_runs:
        texts += [
            ("a prompt", text) for text in (run.message or "", *run.episodes, *(t for turn in run.turns for t in turn))
        ]
    texts.append(("the candidate guidance", prompt_set.episodic_guidance or ""))
    forbidden: dict[str, str] = {}
    for source, text in texts:
        for line in text.splitlines():
            line = line.strip()
            if len(line) >= _MIN_FORBIDDEN and any(ch.isalpha() for ch in line):
                forbidden.setdefault(line, source)
    return forbidden


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, Mapping):
        return [text for inner in value.values() for text in _strings(inner)]
    if isinstance(value, list | tuple):
        return [text for inner in value for text in _strings(inner)]
    return []


def check_public_safe(report: str, forbidden: Mapping[str, str]) -> None:
    """Refuse a report that contains any reply, saved memory or prompt text; the error names sources, not content."""

    sources = Counter(source for text, source in forbidden.items() if text in report)
    if sources:
        found = ", ".join(f"{count} from {source}" for source, count in sorted(sources.items()))
        raise EvalInputError(f"The report contains lines of raw run text ({found}); it was not written")


def family_caveat(calibration: Mapping[str, Any] | None) -> str:
    """The note on a judge from a contestant's own model family, with what checks it in this run."""

    check = (
        "the owner waived calibration for this run, so nothing checks it here"
        if calibration and calibration.get("waived")
        else "calibration against the owner's own ratings is the check on it"
    )
    return (
        f"The judge, {JUDGE_NAME}, shares a model family with Claude Haiku, a contestant. The owner accepted a judge "
        f"from that family instead of a cross-family panel; {check}."
    )


def load_calibration(run_dir: Path) -> dict[str, Any] | None:
    """The calibration result: the pinned effort with its agreement, or the owner's waiver with the chosen effort."""

    path = run_dir / CALIBRATION_DIR / "result.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def criteria_keys(rubrics: RubricSet) -> dict[str, list[str]]:
    return {rubric.id: [criterion.key for criterion in rubric.criteria] for rubric in rubrics.rubrics}

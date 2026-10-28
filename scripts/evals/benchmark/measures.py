"""Deterministic measures of benchmark turns (spec R4): recovery, distributions and per-configuration summaries.

Judged measures come later from the judge; everything here is computed from
the recorded turns alone, so a report can be rebuilt without model calls.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Hashable, Iterable, Mapping, Sequence
from typing import Any

from animama.app.main_structured_response import parse_main_structured_response
from animama.app.primary_emotion_update import voice_intensity_to_reaction_intensity
from animama.domain.audio_tags import NEUTRAL_AUDIO_TAGS

from ..core.model_calls import reply_calls
from ..core.pricing import sum_usage_json
from ..core.stats import latency_summary, longest_run, rate, token_summary
from ..core.turns import TurnOutcome
from .prompt_set import Item

__all__ = [
    "AUDIO_TAG_KINDS",
    "REACTION_INTENSITIES",
    "RECOVERY_PATHS",
    "STYLE_VIOLATIONS",
    "expression_targets",
    "offered_tools",
    "recovery_path",
    "summarize_configuration",
    "value_distribution",
]

RECOVERY_PATHS = ("strict", "lenient", "repaired", "salvaged", "plain_text")
STYLE_VIOLATIONS = ("url", "email", "path", "code", "markdown", "list", "table", "emoji")
REACTION_INTENSITIES = ("none", "mild", "moderate", "strong", "intense")
"""The Reaction intensity each 1-10 intensity plays, in order (``voice_intensity_to_reaction_intensity``): 1-2 no
Reaction, then 3-4 Mild, 5-6 Moderate, 7-8 Strong and 9-10 Intense."""
_AUDIO_TAG_PREFIX = "audio-tag:"
AUDIO_TAG_KINDS: Mapping[str, frozenset[str]] = {
    "laughs": frozenset({"laugh", "chuckle", "giggle"}),
    "sighs": frozenset({"sigh"}),
    "gasps": frozenset({"gasp"}),
    "whispers": frozenset({"whisper"}),
    "none": frozenset(),
}
"""The neutral tags that answer each ``audio-tag:<kind>`` item; a ``none`` item is answered by a reply without tags."""
_NEUTRAL_TAG_IDS = {alias: tag.id for tag in NEUTRAL_AUDIO_TAGS for alias in tag.aliases}
_TOP = 3


def recovery_path(outcome: TurnOutcome) -> str | None:
    """Which of chat's recovery paths produced the reply, or ``None`` for a failed turn.

    Chat records ``repaired``, ``salvaged`` and ``plain_text``; a reply it took
    as it came is ``strict`` when the final text parses strictly and
    ``lenient`` when only chat's local recovery accepted it.
    """

    if outcome.error is not None or outcome.reply is None:
        return None
    if outcome.recovery is not None:
        return outcome.recovery
    finals = [call.final_text for call in reply_calls(outcome.calls) if call.final_text is not None]
    try:
        parse_main_structured_response(finals[-1], outcome.prepared.output_type)
    except ValueError:
        return "lenient"
    return "strict"


def offered_tools(outcome: TurnOutcome) -> list[str]:
    """The tools chat offered the model on the turn: its function tools, native tools and native ``apply_patch``."""

    request = outcome.prepared.model_request
    names: list[str] = []
    for tool in request.prompt.tools:
        kind = tool.get("type")
        spec = tool.get(kind) if isinstance(kind, str) else None
        name = spec.get("name") if isinstance(spec, Mapping) else None
        names.append(str(name or kind))
    names.extend(request.provider_options.native_tools)
    if request.provider_options.memory_apply_patch_enabled:
        names.append("apply_patch")
    return sorted(names)


def value_distribution(values: Sequence[Hashable | None]) -> dict[str, Any]:
    """How often each value occurs: the null rate, distinct values and the share of the top three."""

    counts = Counter(values)
    total = len(values)
    present = [(value, count) for value, count in counts.most_common() if value is not None]
    return {
        "n": total,
        "null_rate": rate(counts[None], total),
        "distinct": len(present),
        "top": [[value, count] for value, count in present[:_TOP]],
        "top_share": rate(sum(count for _, count in present[:_TOP]), total),
        "counts": {str(value): count for value, count in sorted(present, key=lambda pair: str(pair[0]))},
    }


def _tag_ids(labels: Iterable[str]) -> set[str]:
    """The neutral tags among a reply's tag labels; a direction such as ``[whispering, playful]`` names one."""

    ids: set[str] = set()
    for label in labels:
        words = label.strip("[]<>").lower().replace(",", " ").split()
        ids.update(_NEUTRAL_TAG_IDS[word] for word in words if word in _NEUTRAL_TAG_IDS)
    return ids


def expression_targets(turns: Iterable[Mapping[str, Any]], items: Mapping[str, Item]) -> dict[str, Any]:
    """One configuration's expression against the prompt set's intentions, from the recorded turns alone.

    - ``reaction_intensity``: core turns (single-turn items and scripted chats) by the Reaction intensity
      their intensity plays.
    - ``intensity_band``: single-turn replies to items with an intended band, inside it, below it or above it.
    - ``tones``: single-turn replies to items with listed tones, and how many chose one of them.
    - ``audio_tags``: per ``audio-tag:<kind>`` item kind, the replies and how many carry an answering tag
      (``none``: carry no tag at all).
    """

    ok = [turn for turn in turns if turn["kind"] in {"single", "chat"} and turn["error"] is None]
    reactions = Counter(
        REACTION_INTENSITIES[voice_intensity_to_reaction_intensity(turn["emotional_intensity"]) or 0] for turn in ok
    )
    band: Counter[str] = Counter()
    tones: Counter[str] = Counter()
    audio: dict[str, Counter[str]] = {}
    for turn in ok:
        item = items.get(turn["unit_id"]) if turn["kind"] == "single" else None
        if item is None:
            continue
        value = turn["emotional_intensity"]
        if item.intensity is not None and value is not None:
            low, high = item.intensity
            band["scored"] += 1
            band["below" if value < low else "above" if value > high else "in_band"] += 1
        if item.tones:
            tones["scored"] += 1
            tones["in_family"] += turn["emotional_tone"] in item.tones
        for tag in item.tags:
            kind = tag.removeprefix(_AUDIO_TAG_PREFIX)
            if tag.startswith(_AUDIO_TAG_PREFIX) and kind in AUDIO_TAG_KINDS:
                found = (turn["speech_check"] or {}).get("tags") or ()
                answered = not found if kind == "none" else bool(_tag_ids(found) & AUDIO_TAG_KINDS[kind])
                audio.setdefault(kind, Counter())["replies"] += 1
                audio[kind]["hits"] += answered
    return {
        "reaction_intensity": {
            "n": len(ok),
            "counts": {level: reactions.get(level, 0) for level in REACTION_INTENSITIES},
        },
        "intensity_band": {key: band.get(key, 0) for key in ("scored", "in_band", "below", "above")},
        "tones": {key: tones.get(key, 0) for key in ("scored", "in_family")},
        "audio_tags": {
            kind: {"replies": audio[kind]["replies"], "hits": audio[kind]["hits"]}
            for kind in AUDIO_TAG_KINDS
            if kind in audio
        },
    }


def _chat_runs(turns: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Per scripted chat: distinct values and the longest run of one value on consecutive turns."""

    chats: dict[tuple[str, int], list[Mapping[str, Any]]] = {}
    for turn in turns:
        if turn["kind"] == "chat":
            chats.setdefault((turn["unit_id"], turn["repeat"]), []).append(turn)
    rows: list[dict[str, Any]] = []
    for (chat_id, repeat), chat_turns in sorted(chats.items()):
        ordered = sorted(chat_turns, key=lambda turn: turn["turn"])
        row: dict[str, Any] = {"chat": chat_id, "repeat": repeat, "turns": len(ordered)}
        for key in ("gesture", "emotional_tone", "emotional_intensity"):
            # A failed turn has no value, so it also ends a run.
            values = [None if turn["error"] is not None or turn[key] is None else str(turn[key]) for turn in ordered]
            run_length, run_value = longest_run(values)
            row[key] = {"distinct": len({value for value in values if value is not None}), "longest_run": run_length}
            row[key]["longest_run_value"] = run_value
        rows.append(row)
    return rows


def _speech_summary(turns: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    checks = [turn["speech_check"] for turn in turns if turn["speech_check"] is not None]
    replies = len(checks)
    with_tags = sum(1 for check in checks if check["tags"])
    styles = Counter(name for check in checks for name in check["style_violations"])
    return {
        "replies": replies,
        "with_tags": with_tags,
        "with_tags_rate": rate(with_tags, replies),
        "tags": sum(len(check["tags"]) for check in checks),
        "sounds": sum(check["sounds"] for check in checks),
        "over_sound_cap": sum(1 for check in checks if check["over_sound_cap"]),
        "angle_or_non_english_tags": sum(check["angle_or_non_english_tags"] for check in checks),
        "display_tags": sum(check["display_tags"] for check in checks),
        "tags_only_speech": sum(1 for check in checks if check["tags_only_speech"]),
        "accent_requests": sum(check["accent_requests"] for check in checks),
        "tag_kinds": dict(sorted(Counter(tag.lower() for check in checks for tag in check["tags"]).items())),
        "style_violations": {name: styles.get(name, 0) for name in STYLE_VIOLATIONS},
    }


def summarize_configuration(turns: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Deterministic core-turn measures over one configuration's single-turn items and scripted chats.

    Warm-ups, memory chats, recall chats and captures are left out; memory has measures of its own.
    """

    measured = [turn for turn in turns if turn["kind"] in {"single", "chat"}]
    ok = [turn for turn in measured if turn["error"] is None]
    single = [turn for turn in ok if turn["kind"] == "single"]
    chats = [turn for turn in ok if turn["kind"] == "chat"]
    fits = sum(1 for turn in single if turn["fit"])
    recovery = Counter(turn["recovery"] for turn in ok)
    return {
        "turns": len(measured),
        "errors": len(measured) - len(ok),
        "error_codes": dict(sorted(Counter(turn["error"] for turn in measured if turn["error"]).items())),
        "single_turn": {
            "scored": len(single),
            "fits": fits,
            "fit_rate": rate(fits, len(single)),
            "null_rate": rate(sum(1 for turn in single if turn["gesture"] is None), len(single)),
        },
        "distributions": {
            "gesture": value_distribution([turn["gesture"] for turn in ok]),
            "emotional_tone": value_distribution([turn["emotional_tone"] for turn in ok]),
            "emotional_intensity": value_distribution([turn["emotional_intensity"] for turn in ok]),
        },
        "chats": _chat_runs(measured),
        "speech": _speech_summary(ok),
        "recovery": {path: recovery.get(path, 0) for path in RECOVERY_PATHS},
        "dropped_gestures": sum(1 for turn in ok if turn["gesture_mismatch"]),
        "latency": {"single_turn": latency_summary(single), "chat": latency_summary(chats)},
        "tokens": {"single_turn": token_summary(single), "chat": token_summary(chats)},
        "calls": sum(turn["calls"] for turn in measured),
        "usage": sum_usage_json(turn["usage"] for turn in measured),
        "estimated_cost_usd": round(sum(turn["estimated_cost_usd"] or 0.0 for turn in measured), 8),
    }

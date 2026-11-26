"""Reasoning replay for unstored Responses rounds.

A route that stores nothing cannot continue from ``previous_response_id``, so a
turn's next round sends its earlier items again. With ``replay_reasoning`` on,
the reasoning items a round returned travel to the next round inside the
request-local continuation, each keyed by the call it came before, and the
request builder puts them back in front of that call.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Sequence
from typing import Any, Final, cast

from openai.types.responses import ResponseInputItemParam

from animama.app.model_clients import ModelClientContinuation

from .support import clean_str

REASONING_INCLUDE: Final = "reasoning.encrypted_content"
_REPLAYED_FIELDS = ("type", "id", "summary", "encrypted_content")


def reasoning_continuation(
    earlier: ModelClientContinuation | None,
    output_items: Iterable[object],
    *,
    provider_type: str,
    model: str,
) -> ModelClientContinuation | None:
    """Return the turn's reasoning so far plus what this round's ``output_items`` hold.

    A reasoning item is kept only when a function call follows it; one before
    the reply text has nothing to lead into.
    """

    entries = reasoning_entries(earlier, provider_type=provider_type)
    pending: list[dict[str, Any]] = []
    for item in output_items:
        item_type = getattr(item, "type", None)
        if item_type == "reasoning":
            replayed = _replayable(item)
            if replayed is not None:
                pending.append(replayed)
        elif item_type == "function_call":
            call_id = clean_str(getattr(item, "call_id", None))
            if call_id is not None:
                entries.extend({"call_id": call_id, "item": reasoning} for reasoning in pending)
            pending = []
    if not entries:
        return None
    return ModelClientContinuation(
        provider_type=provider_type,
        cursor=json.dumps(entries, ensure_ascii=False, separators=(",", ":")),
        metadata={"source": "reasoning_replay", "model": model, "reasoning_item_count": len(entries)},
    )


def reasoning_entries(continuation: ModelClientContinuation | None, *, provider_type: str) -> list[dict[str, Any]]:
    """Read the ``{"call_id", "item"}`` entries a continuation of this provider type carries."""

    if continuation is None or continuation.provider_type != provider_type:
        return []
    try:
        parsed = json.loads(continuation.cursor)
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [
        entry
        for entry in parsed
        if isinstance(entry, dict) and isinstance(entry.get("call_id"), str) and isinstance(entry.get("item"), dict)
    ]


def with_reasoning(
    items: Sequence[ResponseInputItemParam], entries: Sequence[dict[str, Any]]
) -> list[ResponseInputItemParam]:
    """Put each carried reasoning item in front of the first call it led to."""

    by_call: dict[str, list[ResponseInputItemParam]] = {}
    for entry in entries:
        by_call.setdefault(entry["call_id"], []).append(cast(ResponseInputItemParam, entry["item"]))
    placed: list[ResponseInputItemParam] = []
    for item in items:
        raw = cast(dict[str, Any], item)
        if raw.get("type") == "function_call":
            placed.extend(by_call.pop(str(raw.get("call_id")), ()))
        placed.append(item)
    return placed


def _replayable(item: object) -> dict[str, Any] | None:
    """The fields a reasoning input item needs; one without encrypted content cannot be replayed unstored."""

    dump = getattr(item, "model_dump", None)
    raw = dump(exclude_none=True) if callable(dump) else None
    if not isinstance(raw, dict) or not raw.get("encrypted_content") or not raw.get("id"):
        return None
    replayed = {key: raw[key] for key in _REPLAYED_FIELDS if key in raw}
    replayed.setdefault("summary", [])
    return replayed


__all__ = ["REASONING_INCLUDE", "reasoning_continuation", "reasoning_entries", "with_reasoning"]

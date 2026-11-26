"""Fit a turn's history into a model's context window (configurable models Plan B, R10).

History items are the compiled chat context: compaction summaries (plain
``developer`` dicts) followed by persisted ``ChatMessage`` rows. Trimming keeps
the summary and the newest whole turns (a user message with everything after
it until the next user message, so a tool call stays with its results) and
omits the oldest turns from the request only. The kept history therefore starts
with a user message, which strict chat templates require.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from animama.app.model_clients.context_budget import estimate_value_tokens
from animama.domain.chat import ChatMessage, MessageRole


def history_groups(history: Sequence[Any]) -> tuple[list[Any], list[list[Any]]]:
    """Split history into leading summary items and turns that each start at a user message."""

    summaries: list[Any] = []
    groups: list[list[Any]] = []
    for item in history:
        if not groups and not isinstance(item, ChatMessage):
            summaries.append(item)
        elif not groups or (isinstance(item, ChatMessage) and item.role == MessageRole.USER):
            groups.append([item])
        else:
            groups[-1].append(item)
    return summaries, groups


def history_item_tokens(item: Any, *, count_images: bool = True) -> int:
    """Return a conservative estimate for one history item as it will be sent.

    ``count_images`` is false for a model without image input, which receives
    each earlier image as its short placeholder.
    """

    if isinstance(item, ChatMessage):
        raw = item.raw_provider_message
        value = raw if raw is not None else {"role": str(item.role), "content": item.content}
        return estimate_value_tokens(value, count_images=count_images)
    return estimate_value_tokens(item, count_images=count_images)


def newest_history_within(
    history: Sequence[Any],
    *,
    budget_tokens: int,
    keep_summaries: bool = True,
    count_images: bool = True,
) -> list[Any]:
    """Return the summaries (if kept) plus the newest whole groups whose estimate fits the budget."""

    summaries, groups = history_groups(history)
    kept_summaries = summaries if keep_summaries else []
    remaining = budget_tokens - sum(history_item_tokens(item, count_images=count_images) for item in kept_summaries)
    kept_groups: list[list[Any]] = []
    for group in reversed(groups):
        tokens = sum(history_item_tokens(item, count_images=count_images) for item in group)
        if tokens > remaining:
            break
        remaining -= tokens
        kept_groups.append(group)
    kept_groups.reverse()
    return [*kept_summaries, *(item for group in kept_groups for item in group)]


def drop_oldest_history(history: Sequence[Any], *, fraction: float) -> list[Any]:
    """Drop at least one and about ``fraction`` of the oldest groups, keeping summaries."""

    summaries, groups = history_groups(history)
    if not groups:
        return list(summaries)
    drop = max(1, int(len(groups) * fraction))
    return [*summaries, *(item for group in groups[drop:] for item in group)]


def fit_history(
    history: Sequence[Any],
    *,
    available_tokens: int,
    prompt_tokens_for: Callable[[list[Any]], int],
    count_images: bool = True,
) -> list[Any] | None:
    """Return the longest recent history whose whole prompt fits, or ``None`` when nothing fits.

    ``prompt_tokens_for`` estimates the complete prompt for a candidate history.
    The summary is dropped only when the fixed prompt plus the summary does not fit.
    """

    base_tokens = prompt_tokens_for([])
    if base_tokens > available_tokens:
        return None
    for keep_summaries in (True, False):
        summaries, _ = history_groups(history)
        if not keep_summaries and not summaries:
            break
        candidate = newest_history_within(
            history,
            budget_tokens=available_tokens - base_tokens,
            keep_summaries=keep_summaries,
            count_images=count_images,
        )
        # Per-item estimates omit the prompt's JSON framing; drop more until the whole prompt fits.
        while prompt_tokens_for(candidate) > available_tokens:
            _, groups = history_groups(candidate)
            if not groups:
                break
            candidate = drop_oldest_history(candidate, fraction=0.0)
        if prompt_tokens_for(candidate) <= available_tokens:
            return candidate
    return []


__all__ = [
    "drop_oldest_history",
    "fit_history",
    "history_groups",
    "history_item_tokens",
    "newest_history_within",
]

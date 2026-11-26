"""Context-window budgets for models without provider-native compaction.

Direct chat never sends a prompt larger than a model's context window. Local
servers do not expose their tokenizer, so prompts are measured with a
conservative offline estimate: ASCII text at four characters per token and
every other character as one token (CJK text is often a token per character).
The estimate overcounts English slightly, which only compacts a little early.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from animama.domain import ModelProvider

from .image_parts import image_tokens_in
from .prompt import DirectChatPrompt, prompt_messages

_ASCII_CHARACTERS_PER_TOKEN = 4
# Output reserve when a row records no maximum output: a quarter of the window,
# at most 4096 tokens (enough for a companion reply and its JSON wrapper).
_DEFAULT_OUTPUT_RESERVE_MAX = 4096
# Pre-send compaction starts before the estimate reaches the window, so a
# rough estimate still leaves room.
PRE_SEND_COMPACTION_TRIGGER_RATIO = 0.9
# Post-response compaction starts earlier, so small windows usually compact
# after a reply instead of delaying the next turn.
POST_RESPONSE_COMPACTION_TRIGGER_RATIO = 0.75
# App compaction rewrites the summary that heads the cached history, so it
# waits until 70% of the context window (ANIMAMA_CHAT_COMPACTION_THRESHOLD_TOKENS
# caps it, 90,000 by default).
POST_RESPONSE_COMPACTION_WINDOW_RATIO = 0.7


@dataclass(frozen=True, slots=True)
class ContextBudget:
    """Prompt tokens a model can accept once its reply is reserved."""

    context_window_tokens: int
    reserved_output_tokens: int

    @property
    def available_tokens(self) -> int:
        return max(0, self.context_window_tokens - self.reserved_output_tokens)

    @property
    def pre_send_trigger_tokens(self) -> int:
        return int(self.available_tokens * PRE_SEND_COMPACTION_TRIGGER_RATIO)

    @property
    def post_response_trigger_tokens(self) -> int:
        """Return the context size at which compaction runs after a reply.

        The trigger is 70% of the window. Where the reply reserve is large, 75%
        of what remains after it is lower and wins, so compaction still runs
        after a reply before the pre-send trigger would delay the next turn.
        """

        return min(
            int(self.context_window_tokens * POST_RESPONSE_COMPACTION_WINDOW_RATIO),
            int(self.available_tokens * POST_RESPONSE_COMPACTION_TRIGGER_RATIO),
        )


def context_budget_for_model(model_provider: ModelProvider) -> ContextBudget | None:
    """Return the row's budget, or ``None`` when it records no context window."""

    window = model_provider.context_window_tokens
    if not isinstance(window, int) or window <= 0:
        return None
    max_output = model_provider.max_output_tokens
    if isinstance(max_output, int) and 0 < max_output < window:
        reserve = max_output
    else:
        reserve = min(_DEFAULT_OUTPUT_RESERVE_MAX, window // 4)
    return ContextBudget(context_window_tokens=window, reserved_output_tokens=reserve)


def estimate_text_tokens(text: str) -> int:
    """Return a conservative token estimate for one text."""

    if not text:
        return 0
    ascii_count = sum(1 for character in text if character.isascii())
    return -(-ascii_count // _ASCII_CHARACTERS_PER_TOKEN) + (len(text) - ascii_count)


def estimate_prompt_tokens(prompt: DirectChatPrompt) -> int:
    """Return a conservative estimate of a request's prompt: messages, tools and response format.

    An image counts what a provider charges for it, not the few bytes of its reference.
    """

    messages = prompt_messages(prompt)
    return image_tokens_in(messages) + estimate_text_tokens(
        json.dumps(
            {
                "messages": messages,
                "tools": list(prompt.tools),
                "response_format": prompt.response_format,
            },
            default=_json_default,
            ensure_ascii=False,
        )
    )


def estimate_value_tokens(value: Any, *, count_images: bool = True) -> int:
    """Return a conservative estimate for one prompt message or item.

    Images count what a provider charges for them unless ``count_images`` is
    false, for a model that receives their placeholders instead.
    """

    text_tokens = estimate_text_tokens(json.dumps(value, default=_json_default, ensure_ascii=False))
    return text_tokens + (image_tokens_in(value) if count_images else 0)


def _json_default(value: Any) -> Any:
    return str(value)


__all__ = [
    "POST_RESPONSE_COMPACTION_TRIGGER_RATIO",
    "POST_RESPONSE_COMPACTION_WINDOW_RATIO",
    "PRE_SEND_COMPACTION_TRIGGER_RATIO",
    "ContextBudget",
    "context_budget_for_model",
    "estimate_prompt_tokens",
    "estimate_text_tokens",
    "estimate_value_tokens",
]

"""Classifier for chat transcript compatibility across model-client families."""

from __future__ import annotations

from dataclasses import dataclass

from animama.domain import ModelProvider
from animama.utils.type_helpers import coerce_provider_type

MODEL_CLIENT_OPENAI_CHAT_COMPLETIONS = "openai_chat_completions"
MODEL_CLIENT_OPENAI_RESPONSES = "openai_responses"
MODEL_CLIENT_ANTHROPIC_MESSAGES = "anthropic_messages"

CHAT_API_STANDARD_CHAT_COMPLETIONS = "chat_completions"
CHAT_API_STANDARD_RESPONSES = "responses"
CHAT_API_STANDARD_ANTHROPIC_MESSAGES = "anthropic_messages"

OPENAI_CHAT_COMPLETIONS_PROVIDER_TYPE = "OpenAIHTTPAgent"
OPENAI_RESPONSES_PROVIDER_TYPE = "OpenAIResponsesHTTPAgent"
ANTHROPIC_MESSAGES_PROVIDER_TYPE = "AnthropicMessagesHTTPAgent"
"""Anthropic's Messages API, served only by the built-in ``anthropic`` connection."""
CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE = "ChatGPTPlanResponsesHTTPAgent"
"""OpenAI's Responses API through a ChatGPT plan sign-in, served only by the ``chatgpt_plan`` connection.

It shares the Responses transcript standard, so a chat moves between key and plan models (spec R3.6).
"""


@dataclass(frozen=True, slots=True)
class ChatApiStandardProfile:
    """Model-client profile and transcript standard for one provider family."""

    model_client: str
    api_standard: str


def chat_api_standard_for_provider_type(provider_type: str) -> ChatApiStandardProfile | None:
    """Return the chat API standard profile for a normalized provider type."""

    normalized = coerce_provider_type(provider_type) or str(provider_type or "").strip()
    if normalized == OPENAI_CHAT_COMPLETIONS_PROVIDER_TYPE:
        return ChatApiStandardProfile(
            model_client=MODEL_CLIENT_OPENAI_CHAT_COMPLETIONS,
            api_standard=CHAT_API_STANDARD_CHAT_COMPLETIONS,
        )
    if normalized in (OPENAI_RESPONSES_PROVIDER_TYPE, CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE):
        return ChatApiStandardProfile(
            model_client=MODEL_CLIENT_OPENAI_RESPONSES,
            api_standard=CHAT_API_STANDARD_RESPONSES,
        )
    if normalized == ANTHROPIC_MESSAGES_PROVIDER_TYPE:
        return ChatApiStandardProfile(
            model_client=MODEL_CLIENT_ANTHROPIC_MESSAGES,
            api_standard=CHAT_API_STANDARD_ANTHROPIC_MESSAGES,
        )
    return None


def chat_api_standard_for_provider(model_provider: ModelProvider) -> ChatApiStandardProfile | None:
    """Return the chat API standard profile for a durable model-provider row."""

    return chat_api_standard_for_provider_type(model_provider.provider_type)


__all__ = [
    "ANTHROPIC_MESSAGES_PROVIDER_TYPE",
    "CHAT_API_STANDARD_ANTHROPIC_MESSAGES",
    "CHAT_API_STANDARD_CHAT_COMPLETIONS",
    "CHAT_API_STANDARD_RESPONSES",
    "MODEL_CLIENT_ANTHROPIC_MESSAGES",
    "MODEL_CLIENT_OPENAI_CHAT_COMPLETIONS",
    "MODEL_CLIENT_OPENAI_RESPONSES",
    "OPENAI_CHAT_COMPLETIONS_PROVIDER_TYPE",
    "OPENAI_RESPONSES_PROVIDER_TYPE",
    "ChatApiStandardProfile",
    "chat_api_standard_for_provider",
    "chat_api_standard_for_provider_type",
]

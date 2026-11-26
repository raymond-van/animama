"""Native-tool capability policy shared by catalog exposure and direct chat."""

from __future__ import annotations

from collections.abc import Iterable

OPENAI_RESPONSES_PROVIDER_TYPE = "OpenAIResponsesHTTPAgent"
ANTHROPIC_MESSAGES_PROVIDER_TYPE = "AnthropicMessagesHTTPAgent"
CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE = "ChatGPTPlanResponsesHTTPAgent"

# This allowlist describes tools callers may explicitly select through
# ``dispatch_options.native_tools``. Backend-owned tools such as apply_patch
# remain in the complete catalog capability set but are enabled by runtime
# policy instead of user request parameters.
REQUESTABLE_NATIVE_TOOL_SUPPORT_BY_PROVIDER: dict[str, frozenset[str]] = {
    OPENAI_RESPONSES_PROVIDER_TYPE: frozenset({"web_search"}),
    # Anthropic's ``web_search`` server tool; Anthropic bills searches to the owner.
    ANTHROPIC_MESSAGES_PROVIDER_TYPE: frozenset({"web_search"}),
    # OpenAI's hosted search, on plan models whose account listing supports it (D8).
    CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE: frozenset({"web_search"}),
}


def normalized_native_tool_support(values: object) -> set[str]:
    """Return normalized tool names from persisted or request capability data."""

    if values is None:
        return set()
    if isinstance(values, str):
        return {values.strip()} if values.strip() else set()
    if not isinstance(values, Iterable):
        return set()
    return {str(item).strip() for item in values if str(item).strip()}


def requestable_native_tool_support(provider_type: str, capabilities: object) -> list[str]:
    """Return provider capabilities that direct-chat callers may request."""

    supported = normalized_native_tool_support(capabilities)
    requestable = REQUESTABLE_NATIVE_TOOL_SUPPORT_BY_PROVIDER.get(provider_type, frozenset())
    return sorted(supported.intersection(requestable))


__all__ = [
    "ANTHROPIC_MESSAGES_PROVIDER_TYPE",
    "OPENAI_RESPONSES_PROVIDER_TYPE",
    "REQUESTABLE_NATIVE_TOOL_SUPPORT_BY_PROVIDER",
    "normalized_native_tool_support",
    "requestable_native_tool_support",
]

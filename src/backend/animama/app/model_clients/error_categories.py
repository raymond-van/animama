"""Provider-neutral categories for model-client failures.

Adapters report provider-specific codes (for example ``openai_timeout``). The
probe, chat errors and settings UI use these categories to explain a failure
and suggest a fix without exposing provider bodies or credentials.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

ERROR_UNREACHABLE = "unreachable"
ERROR_CREDENTIAL_MISSING = "credential_missing"
ERROR_CREDENTIAL_REJECTED = "credential_rejected"
ERROR_MODEL_NOT_FOUND = "model_not_found"
ERROR_TIMEOUT = "timeout"
ERROR_CONTEXT_EXCEEDED = "context_exceeded"
ERROR_RATE_LIMITED = "rate_limited"
ERROR_QUOTA_EXCEEDED = "quota_exceeded"
ERROR_SERVER_ERROR = "server_error"
ERROR_BAD_REQUEST = "bad_request"
ERROR_PROVIDER_ERROR = "provider_error"
ERROR_INVALID_BASE_URL = "invalid_base_url"
ERROR_UNEXPECTED_RESPONSE = "unexpected_response"
"""The endpoint answered, but not with an OpenAI-compatible response."""
ERROR_USAGE_LIMIT = "usage_limit"
"""A subscription's usage limit was reached (the ChatGPT plan); it resets on the provider's schedule."""
ERROR_NOT_ELIGIBLE = "not_eligible"
"""The signed-in account's plan does not include this use."""
ERROR_SIGN_IN_REQUIRED = "sign_in_required"
"""A connection whose credential is a sign-in needs the person to sign in again."""

_CATEGORY_BY_CODE = {
    "openai_connection_error": ERROR_UNREACHABLE,
    "connection_unavailable": ERROR_UNREACHABLE,
    "connection_base_url_missing": ERROR_UNREACHABLE,
    "openai_timeout": ERROR_TIMEOUT,
    "model_deadline_exceeded": ERROR_TIMEOUT,
    # Input above an admitted bound is too large for this call, like an oversized prompt.
    "model_input_limit_exceeded": ERROR_CONTEXT_EXCEEDED,
    "missing_api_key": ERROR_CREDENTIAL_MISSING,
    "openai_authentication_error": ERROR_CREDENTIAL_REJECTED,
    "openai_permission_denied": ERROR_CREDENTIAL_REJECTED,
    "openai_not_found": ERROR_MODEL_NOT_FOUND,
    "openai_rate_limit": ERROR_RATE_LIMITED,
    "openai_quota_exceeded": ERROR_QUOTA_EXCEEDED,
    "openai_server_error": ERROR_SERVER_ERROR,
    "openai_overloaded": ERROR_SERVER_ERROR,
    "openai_bad_request": ERROR_BAD_REQUEST,
    "openai_unprocessable_entity": ERROR_BAD_REQUEST,
    "anthropic_connection_error": ERROR_UNREACHABLE,
    "anthropic_timeout": ERROR_TIMEOUT,
    "anthropic_authentication_error": ERROR_CREDENTIAL_REJECTED,
    "anthropic_permission_denied": ERROR_CREDENTIAL_REJECTED,
    "anthropic_not_found": ERROR_MODEL_NOT_FOUND,
    "anthropic_rate_limit": ERROR_RATE_LIMITED,
    "anthropic_quota_exceeded": ERROR_QUOTA_EXCEEDED,
    "anthropic_overloaded": ERROR_SERVER_ERROR,
    "anthropic_server_error": ERROR_SERVER_ERROR,
    "anthropic_context_exceeded": ERROR_CONTEXT_EXCEEDED,
    "anthropic_bad_request": ERROR_BAD_REQUEST,
    "chatgpt_plan_usage_limit": ERROR_USAGE_LIMIT,
    "chatgpt_plan_not_eligible": ERROR_NOT_ELIGIBLE,
    "chatgpt_plan_unavailable": ERROR_SERVER_ERROR,
    "chatgpt_plan_unsupported_request": ERROR_BAD_REQUEST,
    "chatgpt_plan_sign_in_required": ERROR_SIGN_IN_REQUIRED,
    "chatgpt_plan_use_not_granted": ERROR_SIGN_IN_REQUIRED,
}


# Rejections for prompts larger than the served context window. OpenAI reports
# the code; llama.cpp, vLLM, LM Studio and others only describe it.
_CONTEXT_EXCEEDED_CODES = frozenset({"context_length_exceeded"})
_CONTEXT_EXCEEDED_MESSAGE = re.compile(
    r"context (length|window|size)|maximum context|exceeds? the (available )?context|"
    r"too many tokens|prompt is too long|n_ctx|input is too (long|large)",
    re.IGNORECASE,
)
# llama.cpp rejects an embedding input larger than its batch with HTTP 500.
_OVERSIZED_INPUT_MESSAGE = re.compile(r"input is too (long|large)", re.IGNORECASE)


def model_error_category(code: str | None, metadata: Mapping[str, Any] | None = None) -> str:
    """Return the neutral category for an adapter error code and its sanitized metadata."""

    category = _CATEGORY_BY_CODE.get(code or "", ERROR_PROVIDER_ERROR)
    # Only a rejected request can mean an oversized prompt; a server error that
    # mentions "context" (for example a failed model load) keeps its category.
    if category in {ERROR_BAD_REQUEST, ERROR_PROVIDER_ERROR} and _context_exceeded(metadata):
        return ERROR_CONTEXT_EXCEEDED
    if category == ERROR_SERVER_ERROR and _message_matches(metadata, _OVERSIZED_INPUT_MESSAGE):
        return ERROR_CONTEXT_EXCEEDED
    return category


def _context_exceeded(metadata: Mapping[str, Any] | None) -> bool:
    if not metadata:
        return False
    if metadata.get("provider_error_code") in _CONTEXT_EXCEEDED_CODES:
        return True
    return _message_matches(metadata, _CONTEXT_EXCEEDED_MESSAGE)


def _message_matches(metadata: Mapping[str, Any] | None, pattern: re.Pattern[str]) -> bool:
    message = metadata.get("provider_error_message") if metadata else None
    return isinstance(message, str) and bool(pattern.search(message))


__all__ = [
    "ERROR_BAD_REQUEST",
    "ERROR_CONTEXT_EXCEEDED",
    "ERROR_CREDENTIAL_MISSING",
    "ERROR_CREDENTIAL_REJECTED",
    "ERROR_INVALID_BASE_URL",
    "ERROR_MODEL_NOT_FOUND",
    "ERROR_NOT_ELIGIBLE",
    "ERROR_PROVIDER_ERROR",
    "ERROR_QUOTA_EXCEEDED",
    "ERROR_RATE_LIMITED",
    "ERROR_SERVER_ERROR",
    "ERROR_SIGN_IN_REQUIRED",
    "ERROR_TIMEOUT",
    "ERROR_UNEXPECTED_RESPONSE",
    "ERROR_UNREACHABLE",
    "ERROR_USAGE_LIMIT",
    "model_error_category",
]

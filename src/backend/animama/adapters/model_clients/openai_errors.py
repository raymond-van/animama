"""Classifies OpenAI SDK, HTTP and stream errors into sanitized model-client errors,
decides retries and redacts credentials from provider messages.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any

from openai import APIConnectionError, APIError, APIStatusError, APITimeoutError, OpenAIError

from animama.app.model_clients import ModelClientError, ModelClientProviderError, ModelClientTimeoutError

OPENAI_PREVIOUS_RESPONSE_UNRESOLVABLE_CODE = "openai_previous_response_unresolvable"
OPENAI_PROVIDER_PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found"

_MAX_APP_RETRIES = 1
_MAX_RETRY_AFTER_SECONDS = 2.0
_MAX_PROVIDER_ERROR_MESSAGE_LENGTH = 512
_BEARER_TOKEN_RE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+\-/=]+", re.IGNORECASE)
_SECRET_TOKEN_RE = re.compile(r"\b(?:sk-[A-Za-z0-9_~+\-/=]+|hf_[A-Za-z0-9_~+\-/=]+)\b")
# A JSON Web Token: the ChatGPT plan's access and ID tokens take this shape.
_JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*")


@dataclass(frozen=True, slots=True)
class OpenAIErrorInfo:
    """Sanitized OpenAI error details safe to expose through model-client errors."""

    message: str
    code: str
    metadata: Mapping[str, Any]
    retryable: bool = False
    retry_after_seconds: float | None = None
    timeout: bool = False


def classify_openai_exception(
    exc: OpenAIError,
    *,
    api: str,
    provider_type: str,
    model: str,
    previous_response_id: str | None = None,
) -> OpenAIErrorInfo:
    context = _base_metadata(api=api, provider_type=provider_type, model=model)
    if isinstance(previous_response_id, str) and previous_response_id.strip():
        context["previous_response_id"] = previous_response_id.strip()

    if isinstance(exc, APITimeoutError):
        return _info(
            "OpenAI request timed out",
            code="openai_timeout",
            metadata={**context, "exception_type": exc.__class__.__name__},
            retryable=True,
            timeout=True,
        )
    if isinstance(exc, APIConnectionError):
        return _info(
            "OpenAI connection failed",
            code="openai_connection_error",
            metadata={**context, "exception_type": exc.__class__.__name__},
            retryable=True,
        )
    if isinstance(exc, APIStatusError):
        return classify_openai_status_error(
            exc,
            api=api,
            provider_type=provider_type,
            model=model,
            previous_response_id=previous_response_id,
        )
    if isinstance(exc, APIError):
        # The SDK raises a bare APIError for an `error` event inside a stream and
        # keeps the provider's payload (type, code, message) in `body`.
        metadata = {**context, "exception_type": exc.__class__.__name__}
        _merge_provider_error_fields(metadata, exc.body)
        if previous_response_id is not None and is_previous_response_unresolvable({"body": exc.body}):
            return _info(
                "OpenAI Responses previous_response_id could not be resolved",
                code=OPENAI_PREVIOUS_RESPONSE_UNRESOLVABLE_CODE,
                metadata=metadata,
            )
        classified = _stream_error_classification(exc.body)
        if classified is not None:
            code, message = classified
            return _info(message, code=code, metadata=metadata)
        return _info("OpenAI request failed", code="openai_request_failed", metadata=metadata)
    return _info(
        "OpenAI request failed",
        code="openai_request_failed",
        metadata={**context, "exception_type": exc.__class__.__name__},
    )


def classify_openai_status_error(
    exc: APIStatusError,
    *,
    api: str,
    provider_type: str,
    model: str,
    previous_response_id: str | None = None,
) -> OpenAIErrorInfo:
    body = _response_body(exc)
    metadata = _base_metadata(api=api, provider_type=provider_type, model=model)
    metadata["status_code"] = exc.status_code
    request_id = _request_id(exc)
    if request_id is not None:
        metadata["request_id"] = request_id
    retry_after = _retry_after_seconds(exc)
    if retry_after is not None:
        metadata["retry_after_seconds"] = retry_after
    if isinstance(previous_response_id, str) and previous_response_id.strip():
        metadata["previous_response_id"] = previous_response_id.strip()
    _merge_provider_error_fields(metadata, body)

    if previous_response_id is not None and is_previous_response_unresolvable(
        {"status_code": exc.status_code, "body": body}
    ):
        return _info(
            "OpenAI Responses previous_response_id could not be resolved",
            code=OPENAI_PREVIOUS_RESPONSE_UNRESOLVABLE_CODE,
            metadata=metadata,
        )

    code, message, retryable = _status_classification(exc.status_code, body)
    return _info(
        message,
        code=code,
        metadata=metadata,
        retryable=retryable,
        retry_after_seconds=retry_after,
        timeout=code == "openai_timeout",
    )


def classify_openai_response_event(
    event_metadata: Mapping[str, Any],
    *,
    provider_type: str,
    model: str,
    previous_response_id: str | None = None,
) -> OpenAIErrorInfo:
    metadata = _base_metadata(api="responses", provider_type=provider_type, model=model)
    event_type = event_metadata.get("type")
    if isinstance(event_type, str) and event_type:
        metadata["event_type"] = event_type
    if isinstance(previous_response_id, str) and previous_response_id.strip():
        metadata["previous_response_id"] = previous_response_id.strip()
    # The event's own type is `event_type`; the provider fields and class come from its error.
    error_metadata = {key: value for key, value in event_metadata.items() if key != "type"}
    _merge_provider_error_fields(metadata, error_metadata)

    if previous_response_id is not None and is_previous_response_unresolvable(event_metadata):
        return _info(
            "OpenAI Responses previous_response_id could not be resolved",
            code=OPENAI_PREVIOUS_RESPONSE_UNRESOLVABLE_CODE,
            metadata=metadata,
        )
    classified = _stream_error_classification(error_metadata)
    if classified is not None:
        code, message = classified
        return _info(message, code=code, metadata=metadata)
    return _info(
        "OpenAI Responses stream failed",
        code="openai_stream_error",
        metadata=metadata,
    )


def model_client_error_from_openai_info(info: OpenAIErrorInfo) -> ModelClientError:
    if info.timeout:
        return ModelClientTimeoutError(info.message, code=info.code, raw_metadata=info.metadata)
    return ModelClientProviderError(info.message, code=info.code, raw_metadata=info.metadata)


def should_retry_openai_error(info: OpenAIErrorInfo, *, attempt: int, stream_started: bool) -> bool:
    if stream_started or attempt >= _MAX_APP_RETRIES or not info.retryable:
        return False
    retry_after = info.retry_after_seconds
    return retry_after is None or retry_after <= _MAX_RETRY_AFTER_SECONDS


async def sleep_before_openai_retry(info: OpenAIErrorInfo) -> None:
    retry_after = info.retry_after_seconds
    if retry_after is not None and retry_after > 0:
        await asyncio.sleep(min(retry_after, _MAX_RETRY_AFTER_SECONDS))


def is_previous_response_unresolvable(metadata: Mapping[str, Any]) -> bool:
    status_code = metadata.get("status_code")
    if isinstance(status_code, int) and status_code not in {400, 404}:
        return False

    values = [value.lower() for value in _error_field_values(metadata)]
    if OPENAI_PROVIDER_PREVIOUS_RESPONSE_NOT_FOUND_CODE in values:
        return True
    if "previous_response_id" in values:
        return True

    text = " ".join(values)
    return "previous_response_id" in text and any(
        phrase in text
        for phrase in (
            "cannot be resolved",
            "could not be resolved",
            "not found",
            "does not exist",
            "no response",
            "unknown response",
        )
    )


def _info(
    message: str,
    *,
    code: str,
    metadata: Mapping[str, Any],
    retryable: bool = False,
    retry_after_seconds: float | None = None,
    timeout: bool = False,
) -> OpenAIErrorInfo:
    safe_metadata = dict(metadata)
    safe_metadata["retryable"] = bool(retryable)
    if retry_after_seconds is not None:
        safe_metadata["retry_after_seconds"] = retry_after_seconds
    return OpenAIErrorInfo(
        message=message,
        code=code,
        metadata=safe_metadata,
        retryable=retryable,
        retry_after_seconds=retry_after_seconds,
        timeout=timeout,
    )


def _base_metadata(*, api: str, provider_type: str, model: str) -> dict[str, Any]:
    return {
        "provider": "openai",
        "api": api,
        "provider_type": provider_type,
        "model": model,
    }


# An HTTP 429 or stream error that names one of these is quota or billing, not a rate limit.
_QUOTA_TERMS = ("insufficient_quota", "quota", "billing", "credit", "monthly")


def _status_classification(status_code: int, body: Any) -> tuple[str, str, bool]:
    values = [value.lower() for value in _error_field_values({"body": body})]
    return _classification_for_status(status_code, " ".join(values))


def _classification_for_status(status_code: int, text: str) -> tuple[str, str, bool]:
    """The code, message and retryability for an HTTP status; `text` is the error's lower-cased fields."""

    if status_code == 400:
        return "openai_bad_request", "OpenAI rejected the request", False
    if status_code == 401:
        return "openai_authentication_error", "OpenAI authentication failed", False
    if status_code == 403:
        return "openai_permission_denied", "OpenAI permission denied", False
    if status_code == 404:
        return "openai_not_found", "OpenAI resource was not found", False
    if status_code == 408:
        return "openai_timeout", "OpenAI request timed out", True
    if status_code == 409:
        return "openai_conflict", "OpenAI request conflicted with another operation", True
    if status_code == 422:
        return "openai_unprocessable_entity", "OpenAI could not process the request", False
    if status_code == 429:
        if any(term in text for term in _QUOTA_TERMS):
            return "openai_quota_exceeded", "OpenAI quota or billing limit exceeded", False
        return "openai_rate_limit", "OpenAI rate limit exceeded", True
    if status_code == 503:
        return "openai_overloaded", "OpenAI service is overloaded", True
    if status_code in {500, 502, 504}:
        return "openai_server_error", "OpenAI server error", True
    return "openai_http_error", "OpenAI request failed", False


# A stream error event's type or code, as the HTTP status that reports the same failure.
_STREAM_ERROR_STATUSES: tuple[tuple[tuple[str, ...], int], ...] = (
    (_QUOTA_TERMS, 429),
    (("rate_limit",), 429),
    (("server_error", "internal_error"), 500),
    (("overloaded", "service_unavailable"), 503),
    (("invalid_api_key", "authentication"), 401),
    (("permission",), 403),
    # OpenAI's image errors (image_too_large, invalid_base64_image, ...) are bad requests.
    (("invalid_request", "invalid_prompt", "image"), 400),
)


def _stream_error_classification(payload: Any) -> tuple[str, str] | None:
    """The code and message for an error reported inside a stream, or None if unknown.

    The provider reports it with the same type and code as the HTTP error, so it
    gets that error's code and message. It is never retried: the stream began.
    """

    errors = [candidate for candidate in _error_payload_candidates(payload) if isinstance(candidate, Mapping)]
    # Only the error's type and code pick the class (callers drop an event's own type).
    identifiers = " ".join(_field_texts(errors, ("type", "code")))
    for terms, status_code in _STREAM_ERROR_STATUSES:
        if any(term in identifiers for term in terms):
            # The message also counts for quota versus rate limit, as for an HTTP 429.
            code, message, _retryable = _classification_for_status(
                status_code, " ".join(_field_texts(errors, ("type", "code", "message")))
            )
            return code, message
    return None


def _field_texts(errors: list[Mapping[str, Any]], keys: tuple[str, ...]) -> list[str]:
    return [
        value.strip().lower()
        for error in errors
        for key in keys
        if isinstance(value := error.get(key), str) and value.strip()
    ]


def _response_body(exc: APIStatusError) -> Any:
    response = getattr(exc, "response", None)
    if response is None:
        return None
    try:
        return response.json()
    except Exception:
        text = getattr(response, "text", None)
        if isinstance(text, str) and text:
            return text[:1000]
    return None


def _request_id(exc: APIStatusError) -> str | None:
    request_id = getattr(exc, "request_id", None)
    if isinstance(request_id, str) and request_id:
        return request_id
    headers = getattr(getattr(exc, "response", None), "headers", None)
    if headers is None:
        return None
    for key in ("x-request-id", "openai-request-id", "request-id"):
        value = headers.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _retry_after_seconds(exc: APIStatusError) -> float | None:
    headers = getattr(getattr(exc, "response", None), "headers", None)
    if headers is None:
        return None
    raw = headers.get("retry-after")
    if not isinstance(raw, str) or not raw.strip():
        return None
    text = raw.strip()
    try:
        return max(0.0, float(text))
    except ValueError:
        pass
    try:
        parsed = parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return max(0.0, (parsed - datetime.now(UTC)).total_seconds())


def _merge_provider_error_fields(metadata: dict[str, Any], payload: Any) -> None:
    for candidate in _error_payload_candidates(payload):
        if not isinstance(candidate, Mapping):
            continue
        for source_key, target_key in (
            ("code", "provider_error_code"),
            ("type", "provider_error_type"),
            ("param", "provider_error_param"),
            ("message", "provider_error_message"),
        ):
            value = candidate.get(source_key)
            if not isinstance(value, str) or not value.strip() or target_key in metadata:
                continue
            if target_key == "provider_error_message":
                metadata[target_key] = sanitize_provider_error_message(value)
            else:
                metadata[target_key] = value.strip()
        # Some routes refuse a request with only ``{"detail": "..."}`` (the ChatGPT plan's admission).
        detail = candidate.get("detail")
        if isinstance(detail, str) and detail.strip() and "provider_error_message" not in metadata:
            metadata["provider_error_message"] = sanitize_provider_error_message(detail)


def _error_field_values(metadata: Mapping[str, Any]) -> list[str]:
    values: list[str] = []
    for payload in _error_payload_candidates(metadata):
        if isinstance(payload, Mapping):
            for key in ("code", "type", "param", "message"):
                value = payload.get(key)
                if isinstance(value, str) and value.strip():
                    values.append(value.strip())
        elif isinstance(payload, str) and payload.strip():
            values.append(payload.strip())
    return values


def _error_payload_candidates(payload: Any) -> list[Any]:
    candidates: list[Any] = [payload]
    if isinstance(payload, Mapping):
        for key in ("body", "error", "response"):
            value = payload.get(key)
            if value is not None:
                candidates.append(value)
    for candidate in list(candidates):
        if isinstance(candidate, Mapping):
            error = candidate.get("error")
            if error is not None:
                candidates.append(error)
    return candidates


def sanitize_provider_error_message(value: str) -> str:
    """Trim a provider error message and redact bearer tokens, API-key shapes (OpenAI and Anthropic) and JWTs."""

    text = value.strip()
    text = _BEARER_TOKEN_RE.sub("Bearer [redacted]", text)
    text = _SECRET_TOKEN_RE.sub("[redacted]", text)
    text = _JWT_RE.sub("[redacted]", text)
    if len(text) > _MAX_PROVIDER_ERROR_MESSAGE_LENGTH:
        return f"{text[:_MAX_PROVIDER_ERROR_MESSAGE_LENGTH].rstrip()}..."
    return text


__all__ = [
    "OPENAI_PREVIOUS_RESPONSE_UNRESOLVABLE_CODE",
    "OPENAI_PROVIDER_PREVIOUS_RESPONSE_NOT_FOUND_CODE",
    "OpenAIErrorInfo",
    "classify_openai_exception",
    "classify_openai_response_event",
    "is_previous_response_unresolvable",
    "model_client_error_from_openai_info",
    "sanitize_provider_error_message",
    "should_retry_openai_error",
    "sleep_before_openai_retry",
]

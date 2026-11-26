"""Model client for ChatGPT plan models: the Responses client on the plan's route, with the session's token.

Every request this client serves is the person's own (a chat turn, its
compaction or its title), so it asks the session for ``interactive`` tokens.
Work that starts by itself uses the Memory Manager's own runtime instead.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import replace
from typing import Any

import httpx2
from openai import AsyncOpenAI, DefaultAsyncHttpxClient

from animama.adapters.chatgpt_plan.openai_identity import API_BASE
from animama.adapters.model_clients.openai_chat_completions.connection_sdk import KEY_FREE_PLACEHOLDER
from animama.adapters.model_clients.openai_errors import OpenAIErrorInfo
from animama.app.model_clients import ModelClientProviderError, ModelClientRequest
from animama.app.model_clients.credentials import CREDENTIAL_CONFIGURED, ModelCredential
from animama.app.ports.chatgpt_plan_port import ChatGPTPlanTokenSource
from animama.domain.chatgpt_plan import ChatGPTPlanUnavailableError
from animama.domain.model_connection import BUILTIN_CHATGPT_PLAN_CONNECTION_ID

from .client import OpenAIResponsesModelClient
from .routes import CHATGPT_PLAN_ROUTE

PLAN_API_BASE_URL = API_BASE
"""The plan's requests go only here; no setting or environment variable moves them."""

PLAN_ERROR_PREFIX = "subscription_sharing_"

PLAN_RETRY_DELAYS_SECONDS = (1.0, 2.0)
"""Waits before each retry of a temporary failure when OpenAI names none (R5.3).

The SDK retries nothing on this route, so a usage limit stops at once."""

PLAN_MAX_RETRY_AFTER_SECONDS = 10.0
"""The longest wait OpenAI may ask for that a request still waits out; a longer one is reported."""

_SENT_HEADERS = frozenset(
    {"accept", "accept-encoding", "authorization", "connection", "content-length", "content-type", "host", "user-agent"}
)
"""Headers a plan request may carry, besides the SDK's own ``x-stainless-*`` ones."""

# Plan error codes (OpenAI's Sign in with ChatGPT documentation) and the codes Animama reports.
_PLAN_CODES: Mapping[str, tuple[str, str, bool]] = {
    "usage_limit_exceeded": ("chatgpt_plan_usage_limit", "The ChatGPT plan's usage limit was reached", False),
    "user_not_eligible": ("chatgpt_plan_not_eligible", "The ChatGPT plan does not include this use", False),
    "usage_unavailable": ("chatgpt_plan_unavailable", "ChatGPT plan usage is temporarily unavailable", True),
    "user_unavailable": ("chatgpt_plan_unavailable", "ChatGPT plan usage is temporarily unavailable", True),
    "unsupported_capability": ("chatgpt_plan_unsupported_request", "The ChatGPT plan refused this request", False),
    "route_not_supported": ("chatgpt_plan_unsupported_request", "The ChatGPT plan refused this request", False),
    "invalid_user": ("chatgpt_plan_sign_in_required", "Sign in with ChatGPT again", False),
}
_SIGN_IN_REQUIRED = ("chatgpt_plan_sign_in_required", "Sign in with ChatGPT again", False)
_UNSUPPORTED = _PLAN_CODES["unsupported_capability"]

# Why the session could not give a token, as the codes the app explains.
_UNAVAILABLE_CODES: Mapping[str, str] = {
    "not_signed_in": "chatgpt_plan_sign_in_required",
    "sign_in_required": "chatgpt_plan_sign_in_required",
    "plan_use_not_granted": "chatgpt_plan_use_not_granted",
    "temporarily_unavailable": "chatgpt_plan_unavailable",
}


async def _only_plan_headers(request: httpx2.Request) -> None:
    """Request hook: drop every header the SDK took from its environment.

    The SDK adds ``OpenAI-Organization``, ``OpenAI-Project`` and
    ``OPENAI_CUSTOM_HEADERS`` to every client it builds, including per-request
    copies; none of them belongs on a plan request.
    """

    for name in list(request.headers.keys()):
        lowered = name.lower()
        if lowered not in _SENT_HEADERS and not lowered.startswith("x-stainless-"):
            del request.headers[name]


def _without_token(metadata: Mapping[str, Any], token: str | None) -> dict[str, Any]:
    """``metadata`` with the request's own token removed from every text value (T3)."""

    if not token:
        return dict(metadata)
    return {
        key: value.replace(token, "[redacted]") if isinstance(value, str) else value for key, value in metadata.items()
    }


def plan_sdk_client(*, timeout: float | None, transport: httpx2.AsyncBaseTransport | None = None) -> AsyncOpenAI:
    """One key-free SDK client at the plan's fixed address, with no retries, no redirects and allowlisted headers.

    ``transport`` is a test hook. Each request gets the token through :func:`with_plan_token`.
    """

    return AsyncOpenAI(
        api_key=KEY_FREE_PLACEHOLDER,
        base_url=PLAN_API_BASE_URL,
        timeout=timeout,
        max_retries=0,
        http_client=DefaultAsyncHttpxClient(
            follow_redirects=False,
            transport=transport,
            event_hooks={"request": [_only_plan_headers]},
        ),
    )


def with_plan_token(client: AsyncOpenAI, token: str, *, timeout: float | None) -> AsyncOpenAI:
    """A view of ``client`` that sends ``token``.

    An explicit ``Authorization`` also keeps the SDK from taking one from ``OPENAI_CUSTOM_HEADERS``.
    """

    return client.with_options(api_key=token, default_headers={"Authorization": f"Bearer {token}"}, timeout=timeout)


def plan_error_code(metadata: Mapping[str, Any]) -> str | None:
    """The plan's own error code in sanitized OpenAI error metadata, without its prefix."""

    return next(
        (
            value.removeprefix(PLAN_ERROR_PREFIX)
            for value in (metadata.get("provider_error_code"), metadata.get("provider_error_type"))
            if isinstance(value, str) and value.startswith(PLAN_ERROR_PREFIX)
        ),
        None,
    )


def plan_code_is_temporary(code: str | None) -> bool:
    """Whether a plan error code names a temporary outage worth retrying."""

    return code is not None and code in _PLAN_CODES and _PLAN_CODES[code][2]


def plan_retry_delay(*, retryable: bool, retry_after: float | None, attempt: int) -> float | None:
    """Seconds to wait before retrying a failed plan request, or None to report it (R5.3)."""

    if not retryable or attempt >= len(PLAN_RETRY_DELAYS_SECONDS):
        return None
    if retry_after is None:
        return PLAN_RETRY_DELAYS_SECONDS[attempt]
    return retry_after if retry_after <= PLAN_MAX_RETRY_AFTER_SECONDS else None


def plan_unavailable_error(error: ChatGPTPlanUnavailableError) -> ModelClientProviderError:
    """The model-client error for a session that cannot serve a request now."""

    code = _UNAVAILABLE_CODES.get(error.code, f"chatgpt_plan_{error.code}")
    return ModelClientProviderError(
        "The ChatGPT plan cannot serve this request", code=code, raw_metadata={"session_state": error.code}
    )


class ChatGPTPlanResponsesModelClient(OpenAIResponsesModelClient):
    """OpenAI Responses through the signed-in ChatGPT plan.

    ``session`` returns the installation's session when a request starts; the
    registry is built before the app has one. A refused access token is renewed
    once and the request sent again before any output, a usage limit pauses
    background use, and a success clears that pause. Nothing here moves a
    request to another connection.
    """

    _route = CHATGPT_PLAN_ROUTE

    def __init__(
        self,
        *,
        session: Callable[[], ChatGPTPlanTokenSource],
        timeout: float | None = 60.0,
        transport: httpx2.AsyncBaseTransport | None = None,
    ) -> None:
        """``transport`` is a test hook for the SDK client's HTTP transport."""

        super().__init__(base_url=PLAN_API_BASE_URL, timeout=timeout, compaction_threshold_tokens=None)
        self._session = session
        self._transport = transport

    async def _credential_for(self, spec: ModelClientRequest) -> ModelCredential:
        if spec.model_provider.connection_id != BUILTIN_CHATGPT_PLAN_CONNECTION_ID:
            raise ModelClientProviderError(
                "ChatGPT plan models are served only on the ChatGPT plan connection",
                code="responses_connection_unsupported",
                raw_metadata={"connection_id": spec.model_provider.connection_id, "model": spec.model_provider.model},
            )
        try:
            token = await self._session().access_token("interactive")
        except ChatGPTPlanUnavailableError as error:
            raise plan_unavailable_error(error) from None
        return ModelCredential(state=CREDENTIAL_CONFIGURED, api_key=token)

    async def _renewed_credential(self, info: OpenAIErrorInfo, credential: ModelCredential) -> ModelCredential | None:
        if info.metadata.get("status_code") != 401 or credential.api_key is None:
            return None
        try:
            token = await self._session().refresh_rejected(credential.api_key, "interactive")
        except ChatGPTPlanUnavailableError as error:
            raise plan_unavailable_error(error) from None
        return ModelCredential(state=CREDENTIAL_CONFIGURED, api_key=token)

    async def _classified(self, info: OpenAIErrorInfo, credential: ModelCredential) -> OpenAIErrorInfo:
        metadata = _without_token(info.metadata, credential.api_key)
        plan_code = plan_error_code(metadata)
        status = metadata.get("status_code")
        if plan_code is not None and plan_code in _PLAN_CODES:
            code, message, retryable = _PLAN_CODES[plan_code]
        elif status == 401:
            # Still refused after the renewed token: the session is not usable.
            code, message, retryable = _SIGN_IN_REQUIRED
        elif status == 400 and "provider_error_code" not in metadata:
            # Admission refuses what the route does not take with a bare ``detail`` body.
            code, message, retryable = _UNSUPPORTED
        else:
            return replace(info, metadata=metadata)
        if code == "chatgpt_plan_usage_limit":
            await self._session().record_usage_limit()
        return replace(
            info,
            code=code,
            message=message,
            retryable=retryable,
            metadata={**metadata, "retryable": retryable},
            retry_after_seconds=info.retry_after_seconds if retryable else None,
        )

    async def _on_success(self) -> None:
        await self._session().record_interactive_success()

    def _retry_delay(self, info: OpenAIErrorInfo, *, attempt: int, stream_started: bool) -> float | None:
        if stream_started:
            return None
        return plan_retry_delay(retryable=info.retryable, retry_after=info.retry_after_seconds, attempt=attempt)

    def _client_for_spec(self, spec: ModelClientRequest, credential: ModelCredential) -> Any:
        """A per-request view of one key-free SDK client at the fixed address, with no retries or redirects."""

        if self._client is None:
            self._client = plan_sdk_client(timeout=self._timeout, transport=self._transport)
            self._close_client = True
        assert credential.api_key is not None
        return with_plan_token(self._client, credential.api_key, timeout=self._timeout)


__all__ = [
    "ChatGPTPlanResponsesModelClient",
    "PLAN_API_BASE_URL",
    "plan_code_is_temporary",
    "plan_error_code",
    "plan_retry_delay",
    "plan_sdk_client",
    "plan_unavailable_error",
    "with_plan_token",
]

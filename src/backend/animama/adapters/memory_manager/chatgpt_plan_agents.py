"""The Memory Manager's Responses calls through a ChatGPT plan (spec #919, Phase 7).

The Agents SDK asks for unstreamed, stored responses, sends output limits and
replays a run's items with their ids. The plan's route takes only streamed,
unstored requests and refuses those fields, so :class:`ChatGPTPlanAgentsClient`
stands in for the SDK's OpenAI client: every ``responses.create`` goes out
streamed and unstored, with replayed items in the route's form, and the
streamed response is assembled into the ``Response`` the SDK expects. The
runtime declares its tools in :data:`PLAN_TOOL_NAMESPACE` with the SDK's own
``tool_namespace``, so the SDK matches each namespaced call to its tool.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from types import SimpleNamespace
from typing import Any, cast

from openai import AsyncOpenAI, NotGiven, Omit, OpenAIError
from openai.types.responses import Response, ResponseOutputItemDoneEvent

from animama.adapters.model_clients._common import close_maybe_async
from animama.adapters.model_clients.openai_errors import classify_openai_exception, classify_openai_response_event
from animama.adapters.model_clients.openai_responses.chatgpt_plan_client import (
    plan_code_is_temporary,
    plan_error_code,
    plan_retry_delay,
    with_plan_token,
)
from animama.adapters.model_clients.openai_responses.events import (
    event_metadata,
    response_event_type,
    response_from_terminal_event,
)
from animama.adapters.model_clients.openai_responses.routes import CHATGPT_PLAN_ROUTE
from animama.app.ports.chatgpt_plan_port import ChatGPTPlanTokenSource
from animama.domain.chatgpt_plan import ChatGPTPlanPurpose

_REFUSED_FIELDS = frozenset(
    {
        "background",
        "context_management",
        "conversation",
        "include",
        "max_output_tokens",
        "max_tool_calls",
        "metadata",
        "moderation",
        "previous_response_id",
        "prompt",
        "prompt_cache_options",
        "prompt_cache_retention",
        "safety_identifier",
        "temperature",
        "top_logprobs",
        "top_p",
        "truncation",
        "user",
    }
)
"""Request fields kept off the plan's route.

Most are documented as refused. ``context_management`` is left out because
server compaction was admitted in the trial but not shown to work,
``prompt_cache_options`` with the documented-refused cache retention, and
``include`` because no reasoning is replayed.
"""

_UNSTORED_ITEM_TYPES = frozenset({"reasoning", "item_reference"})
"""Items that point at stored state or need it; an unstored request cannot replay them.

Reasoning is dropped whatever ``CHATGPT_PLAN_ROUTE.replay_reasoning`` says; if a
live check turns that switch on for chat, this client needs the same change."""

PLAN_TOOL_NAMESPACE = CHATGPT_PLAN_ROUTE.function_tool_namespace or "animama"
PLAN_TOOL_NAMESPACE_DESCRIPTION = "Animama's tools for this conversation."


class ChatGPTPlanResponseFailedError(Exception):
    """The plan's stream ended in a failure event. ``code`` is the plan's own code, when it named one."""

    def __init__(self, code: str | None) -> None:
        super().__init__(f"The ChatGPT plan response failed ({code or 'no code'})")
        self.code = code


def plan_agents_request(kwargs: Mapping[str, Any]) -> dict[str, Any]:
    """The Agents SDK's ``responses.create`` arguments, as the plan's route takes them."""

    request = {
        key: value
        for key, value in kwargs.items()
        if key not in _REFUSED_FIELDS and not isinstance(value, Omit | NotGiven)
    }
    request["stream"] = True
    request["store"] = False
    raw_input = request.get("input")
    if isinstance(raw_input, list):
        request["input"] = [item for item in map(_plan_item, raw_input) if item is not None]
    return request


def _plan_item(item: Any) -> dict[str, Any] | Any | None:
    """One replayed item without its id, in the route's form; None for one an unstored request cannot carry."""

    dump = getattr(item, "model_dump", None)
    raw = dump(exclude_none=True) if callable(dump) else item
    if not isinstance(raw, Mapping):
        return item
    if raw.get("type") in _UNSTORED_ITEM_TYPES:
        return None
    replayed = {key: value for key, value in raw.items() if key != "id"}
    if replayed.get("role") == "system":
        replayed["role"] = "developer"
    return replayed


async def _collected_response(stream: Any) -> Response:
    """The completed ``Response`` from a stream, with its items from the done events when it lists none."""

    done: dict[int, Any] = {}
    try:
        async for event in stream:
            event_type = response_event_type(event)
            if isinstance(event, ResponseOutputItemDoneEvent):
                done[event.output_index] = event.item
            elif event_type in {"response.completed", "response.done"}:
                response = response_from_terminal_event(event)
                if not response.output and done:
                    response = response.model_copy(update={"output": [done[index] for index in sorted(done)]})
                return response
            elif event_type in {"error", "response.failed", "response.incomplete"}:
                info = classify_openai_response_event(
                    event_metadata(event), provider_type=CHATGPT_PLAN_ROUTE.provider_type, model=""
                )
                raise ChatGPTPlanResponseFailedError(plan_error_code(info.metadata))
    finally:
        await close_maybe_async(stream)
    raise ChatGPTPlanResponseFailedError("stream_ended")


class ChatGPTPlanAgentsClient:
    """What the Agents SDK's ``OpenAIResponsesModel`` uses as its OpenAI client on the plan.

    ``purpose`` is ``background`` for work that started by itself and
    ``interactive`` for the person's own runs. Each request asks the session
    for a token again, so a pause or a withdrawn agreement stops a run between
    its rounds. A refused token is renewed once per request; a temporary
    failure is retried with the plan's bounded backoff; a usage limit pauses
    background use; an interactive success clears that pause. Only the SDK's
    unstreamed call is served: it always gets a finished ``Response``.
    """

    def __init__(
        self,
        *,
        client: AsyncOpenAI,
        session: ChatGPTPlanTokenSource,
        purpose: ChatGPTPlanPurpose,
        timeout: float | None,
    ) -> None:
        self._client = client
        self._session = session
        self._purpose = purpose
        self._timeout = timeout
        self.responses = SimpleNamespace(create=self._create)

    async def _create(self, **kwargs: Any) -> Response:
        if kwargs.get("stream") is True:
            raise NotImplementedError("The ChatGPT plan's Memory Manager client serves only unstreamed calls")
        request = plan_agents_request(kwargs)
        # The background rule is checked on every request, not once per run (T7).
        token = await self._session.access_token(self._purpose)
        renewed = False
        attempt = 0
        while True:
            try:
                client = with_plan_token(self._client, token, timeout=self._timeout)
                response = await _collected_response(await client.responses.create(**request))
            except OpenAIError as exc:
                info = classify_openai_exception(
                    exc, api="responses", provider_type=CHATGPT_PLAN_ROUTE.provider_type, model=str(request["model"])
                )
                code = plan_error_code(info.metadata)
                if info.metadata.get("status_code") == 401 and not renewed:
                    token = await self._session.refresh_rejected(token, self._purpose)
                    renewed = True
                    continue
                if code == "usage_limit_exceeded":
                    await self._session.record_usage_limit()
                    raise
                retryable = plan_code_is_temporary(code) or (code is None and info.retryable)
                delay = plan_retry_delay(retryable=retryable, retry_after=info.retry_after_seconds, attempt=attempt)
                if delay is None:
                    raise
                attempt += 1
                await asyncio.sleep(delay)
                continue
            except ChatGPTPlanResponseFailedError as exc:
                if exc.code == "usage_limit_exceeded":
                    await self._session.record_usage_limit()
                raise
            if self._purpose == "interactive":
                await self._session.record_interactive_success()
            return response

    def with_options(self, **options: Any) -> ChatGPTPlanAgentsClient:
        """The SDK may ask for a copy with other options; the plan's client keeps its own."""

        return self

    async def close(self) -> None:
        await self._client.close()


def as_openai_client(client: ChatGPTPlanAgentsClient) -> AsyncOpenAI:
    """The client as the SDK's model takes it; only ``responses.create`` is ever called."""

    return cast(AsyncOpenAI, client)


__all__ = [
    "PLAN_TOOL_NAMESPACE",
    "PLAN_TOOL_NAMESPACE_DESCRIPTION",
    "ChatGPTPlanAgentsClient",
    "ChatGPTPlanResponseFailedError",
    "as_openai_client",
    "plan_agents_request",
]

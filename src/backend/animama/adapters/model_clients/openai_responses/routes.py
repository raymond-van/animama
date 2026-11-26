"""How one OpenAI Responses endpoint is used: the API on a key, or the API through a ChatGPT plan.

OpenAI documents the ChatGPT plan's route as taking only streamed, unstored
requests: no ``previous_response_id``, no inline moderation, no output limits
and no system-role input items, with function tools inside a namespace. The
Phase 0 trial (2026-11-24) also found the ``apply_patch`` tool refused, and
server compaction admitted but unproven, so plan requests send none and the
app compacts plan chats itself. A request builder reads a route instead of
asking which connection it serves.
"""

from __future__ import annotations

from dataclasses import dataclass

from animama.app.chat.api_standard import CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE

from .support import OPENAI_RESPONSES_HTTP_PROVIDER_TYPE


@dataclass(frozen=True, slots=True)
class ResponsesRoute:
    """What one Responses endpoint accepts.

    ``chain_stored_responses``: store responses and continue a turn with
    ``previous_response_id``; otherwise every request is unstored and carries
    its whole input. ``hosted_tools``: OpenAI tools this route may run.
    ``function_tool_namespace``: group function tools under this namespace,
    and name it on replayed calls. ``developer_role_for_system_items``: send
    a later system message as a developer item. ``replay_reasoning``: ask
    for encrypted reasoning and send each reasoning item back before the
    call it led to in the turn's next round; without it a round replays its
    calls and their outputs only.
    """

    provider_type: str
    chain_stored_responses: bool = True
    inline_moderation: bool = True
    output_limits: bool = True
    native_compaction: bool = True
    hosted_tools: frozenset[str] = frozenset({"web_search", "apply_patch"})
    function_tool_namespace: str | None = None
    developer_role_for_system_items: bool = False
    replay_reasoning: bool = False


OPENAI_API_ROUTE = ResponsesRoute(provider_type=OPENAI_RESPONSES_HTTP_PROVIDER_TYPE)

CHATGPT_PLAN_ROUTE = ResponsesRoute(
    provider_type=CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE,
    chain_stored_responses=False,
    inline_moderation=False,
    output_limits=False,
    native_compaction=False,
    hosted_tools=frozenset({"web_search"}),
    function_tool_namespace="animama",
    developer_role_for_system_items=True,
    # Off until a live check shows the route accepting a replayed reasoning item
    # (Decision Log, 2026-11-24); the Phase 0 trial never saw one beside a call.
    replay_reasoning=False,
)

__all__ = ["CHATGPT_PLAN_ROUTE", "OPENAI_API_ROUTE", "ResponsesRoute"]

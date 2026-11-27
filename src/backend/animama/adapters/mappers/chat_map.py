"""Mappers between chat ORM rows and domain dataclasses."""

from __future__ import annotations

from typing import Any

from animama.domain.chat import Chat
from animama.domain.usage import Usage, UsageInputDetails, UsageOutputDetails
from animama.orm.chats import ORMChat


def _usage_from_chat_orm(orm: ORMChat) -> Usage:
    return Usage(
        input_tokens=int(getattr(orm, "cum_input_tokens", 0) or 0),
        output_tokens=int(getattr(orm, "cum_output_tokens", 0) or 0),
        total_tokens=int(getattr(orm, "cum_total_tokens", 0) or 0),
        input_tokens_details=UsageInputDetails(cached_tokens=int(getattr(orm, "cum_cached_input_tokens", 0) or 0)),
        output_tokens_details=UsageOutputDetails(
            reasoning_tokens=int(getattr(orm, "cum_output_reasoning_tokens", 0) or 0)
        ),
    )


def chat_orm_to_domain(orm: ORMChat) -> Chat:
    return Chat(
        id=orm.id,
        anima_id=str(getattr(orm, "anima_id", "") or ""),
        user_id=getattr(orm, "user_id", None),
        title=getattr(orm, "title", None),
        api_standard=getattr(orm, "api_standard", None),
        last_model_client=getattr(orm, "last_model_client", None),
        last_model_id=getattr(orm, "last_model_id", None),
        last_model_provider_id=getattr(orm, "last_model_provider_id", None),
        openai_previous_response_id=getattr(orm, "openai_previous_response_id", None),
        metadata=dict(getattr(orm, "metadata_", {}) or {}),
        usage=_usage_from_chat_orm(orm),
        active_context_tokens=int(getattr(orm, "active_context_tokens", 0) or 0),
        next_turn=max(1, int(getattr(orm, "next_turn", 1) or 1)),
        created_at=getattr(orm, "created_at", None),
        updated_at=getattr(orm, "updated_at", None),
        pinned_at=getattr(orm, "pinned_at", None),
    )


def chat_domain_to_orm(chat: Chat) -> ORMChat:
    meta: dict[str, Any] = dict(chat.metadata or {})
    usage = chat.usage or Usage()
    return ORMChat(
        id=chat.id,
        user_id=str(chat.user_id or ""),
        anima_id=chat.anima_id,
        title=chat.title,
        api_standard=chat.api_standard,
        last_model_client=chat.last_model_client,
        last_model_id=chat.last_model_id,
        last_model_provider_id=chat.last_model_provider_id,
        openai_previous_response_id=chat.openai_previous_response_id,
        metadata_=meta,
        cum_input_tokens=int(usage.input_tokens or 0),
        cum_output_tokens=int(usage.output_tokens or 0),
        cum_total_tokens=int(usage.total_tokens or 0),
        cum_cached_input_tokens=int(getattr(usage.input_tokens_details, "cached_tokens", 0) or 0),
        cum_output_reasoning_tokens=int(getattr(usage.output_tokens_details, "reasoning_tokens", 0) or 0),
        active_context_tokens=int(chat.active_context_tokens or 0),
        next_turn=max(1, int(chat.next_turn or 1)),
        pinned_at=chat.pinned_at,
    )


__all__ = ["chat_domain_to_orm", "chat_orm_to_domain"]

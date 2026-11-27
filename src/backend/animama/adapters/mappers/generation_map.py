"""Mappers from the content assistant's ORM rows to domain dataclasses."""

from __future__ import annotations

from typing import cast

from animama.domain.generation import (
    GenerationConversation,
    GenerationDraft,
    GenerationDraftStatus,
    GenerationIntent,
    GenerationMessage,
    GenerationMessageRole,
)
from animama.orm.generation import ORMGenerationConversation, ORMGenerationDraft, ORMGenerationMessage


def generation_conversation_orm_to_domain(orm: ORMGenerationConversation) -> GenerationConversation:
    return GenerationConversation(
        id=orm.id,
        owner_user_id=orm.owner_user_id,
        title=orm.title,
        scope=dict(orm.scope),
        style_preset=orm.style_preset,
        created_at=orm.created_at,
        updated_at=orm.updated_at,
    )


def generation_message_orm_to_domain(orm: ORMGenerationMessage) -> GenerationMessage:
    return GenerationMessage(
        id=orm.id,
        conversation_id=orm.conversation_id,
        # The table's CHECK constraint admits no other role.
        role=cast(GenerationMessageRole, orm.role),
        text=orm.text,
        data=dict(orm.data),
        created_at=orm.created_at,
    )


def generation_draft_orm_to_domain(orm: ORMGenerationDraft) -> GenerationDraft:
    return GenerationDraft(
        id=orm.id,
        conversation_id=orm.conversation_id,
        owner_user_id=orm.owner_user_id,
        # The table's CHECK constraints admit no other intent or status.
        intent=cast(GenerationIntent, orm.intent),
        position=orm.position,
        status=cast(GenerationDraftStatus, orm.status),
        version=orm.version,
        project=None if orm.project is None else dict(orm.project),
        previous_project=None if orm.previous_project is None else dict(orm.previous_project),
        check_report=None if orm.check_report is None else dict(orm.check_report),
        checked_version=orm.checked_version,
        repair_count=orm.repair_count,
        failure_reason=orm.failure_reason,
        saved_item_id=orm.saved_item_id,
        created_at=orm.created_at,
        updated_at=orm.updated_at,
    )


__all__ = [
    "generation_conversation_orm_to_domain",
    "generation_draft_orm_to_domain",
    "generation_message_orm_to_domain",
]

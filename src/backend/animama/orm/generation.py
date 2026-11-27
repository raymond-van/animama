"""The content assistant's tables: conversations, their messages and their drafts (spec #942)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import text as sa_text

from .sqlalchemy_base import SqlalchemyBase


class ORMGenerationConversation(SqlalchemyBase):
    """One owner's conversation with the assistant.

    Not a Chat: it has no Anima and no row in ``chats`` or ``chat_messages``,
    so chat lists, chat search, memory and Reflection never read it.
    """

    __tablename__ = "generation_conversations"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    owner_user_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    title: Mapped[str] = mapped_column(Text, nullable=False, server_default=sa_text("''"))
    # {"kind": "page"} or {"kind": "creator", "intent": ..., "catalog_item_id": ... | null}
    scope: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    style_preset: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), nullable=False, server_default=sa_text("CURRENT_TIMESTAMP")
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=sa_text("CURRENT_TIMESTAMP"),
        onupdate=sa_text("CURRENT_TIMESTAMP"),
    )


class ORMGenerationMessage(SqlalchemyBase):
    """One text turn of a conversation, read in ``created_at`` then ``id`` order."""

    __tablename__ = "generation_messages"
    __table_args__ = (CheckConstraint("role IN ('user', 'assistant')", name="role_values"),)

    id: Mapped[str] = mapped_column(String, primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        String,
        ForeignKey(
            "generation_conversations.id",
            ondelete="CASCADE",
            name="fk_generation_messages_conversation_id",
        ),
        nullable=False,
        index=True,
    )
    role: Mapped[str] = mapped_column(String, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    # Questions asked, answers given, token use and the run's outcome.
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default=sa_text("'{}'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), nullable=False, server_default=sa_text("CURRENT_TIMESTAMP")
    )


class ORMGenerationDraft(SqlalchemyBase):
    """A Gesture or Reaction the assistant is writing in a conversation.

    ``version`` grows by one with every stored change to ``project``;
    ``check_report`` is the page's report for ``checked_version``. The nullable
    JSON columns store SQL NULL, never a JSON ``null``.
    """

    __tablename__ = "generation_drafts"
    __table_args__ = (
        CheckConstraint("intent IN ('gesture', 'reaction')", name="intent_values"),
        CheckConstraint(
            "status IN ('writing', 'checking', 'repairing', 'reviewing', 'ready', 'warnings', 'failed')",
            name="status_values",
        ),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        String,
        ForeignKey(
            "generation_conversations.id",
            ondelete="CASCADE",
            name="fk_generation_drafts_conversation_id",
        ),
        nullable=False,
        index=True,
    )
    owner_user_id: Mapped[str] = mapped_column(String, nullable=False)
    intent: Mapped[str] = mapped_column(String, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("1"))
    project: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True), nullable=True)
    previous_project: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True), nullable=True)
    check_report: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True), nullable=True)
    checked_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    repair_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("0"))
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    saved_item_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), nullable=False, server_default=sa_text("CURRENT_TIMESTAMP")
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=sa_text("CURRENT_TIMESTAMP"),
        onupdate=sa_text("CURRENT_TIMESTAMP"),
    )


__all__ = ["ORMGenerationConversation", "ORMGenerationDraft", "ORMGenerationMessage"]

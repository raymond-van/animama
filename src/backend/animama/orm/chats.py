from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import TIMESTAMP, CheckConstraint, ForeignKey, Integer, String, text as sa_text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .mixins import AuditMixin, TimestampMixin
from .sqlalchemy_base import SqlalchemyBase

if TYPE_CHECKING:
    from .anima import ORMAnima
    from .chat_messages import ORMChatMessage


class ORMChat(SqlalchemyBase, TimestampMixin, AuditMixin):
    """User-owned chat thread for one anima/avatar."""

    __tablename__ = "chats"
    __table_args__ = (
        CheckConstraint(
            "last_model_client IS NULL OR last_model_client IN "
            "('openai_chat_completions', 'openai_responses', 'anthropic_messages')",
            name="last_model_client_valid",
        ),
        CheckConstraint(
            "api_standard IS NULL OR api_standard IN ('chat_completions', 'responses', 'anthropic_messages')",
            name="api_standard_valid",
        ),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    anima_id: Mapped[str] = mapped_column(
        String, ForeignKey("anima.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str | None] = mapped_column(String, nullable=True)
    api_standard: Mapped[str | None] = mapped_column(String, nullable=True)
    last_model_client: Mapped[str | None] = mapped_column(String, nullable=True)
    last_model_id: Mapped[str | None] = mapped_column(String, nullable=True)
    last_model_provider_id: Mapped[str | None] = mapped_column(String, nullable=True)
    openai_previous_response_id: Mapped[str | None] = mapped_column(String, nullable=True)
    metadata_: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSONB, nullable=False, server_default=sa_text("'{}'::jsonb")
    )

    cum_input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("0"))
    cum_output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("0"))
    cum_total_tokens: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("0"))
    cum_cached_input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("0"))
    cum_output_reasoning_tokens: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("0"))
    active_context_tokens: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("0"))
    next_turn: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("1"))
    # When the owner pinned the chat in the sidebar; NULL when unpinned.
    pinned_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=False), nullable=True)

    anima: Mapped[ORMAnima] = relationship("ORMAnima", back_populates="chats")
    messages: Mapped[list[ORMChatMessage]] = relationship(
        "ORMChatMessage",
        back_populates="chat",
        lazy="selectin",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


Chat = ORMChat

__all__ = ["ORMChat", "Chat"]

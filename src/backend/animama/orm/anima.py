from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import TIMESTAMP, CheckConstraint, ForeignKey, Integer, String, Text, text as sa_text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .mixins import AuditMixin, OrganizationMixin, TimestampMixin
from .sqlalchemy_base import SqlalchemyBase

if TYPE_CHECKING:
    from .archive import ORMArchive
    from .avatar import ORMAvatar
    from .chats import ORMChat


class ORMAnima(SqlalchemyBase, TimestampMixin, AuditMixin, OrganizationMixin):
    __tablename__ = "anima"
    __table_args__ = (
        CheckConstraint("length(display_name) BETWEEN 1 AND 120", name="anima_display_name_length"),
        CheckConstraint("aggregate_revision >= 1", name="anima_aggregate_revision_positive"),
        CheckConstraint("identity_status IN ('ready', 'repair_required')", name="anima_identity_status_valid"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True)
    # Low-level bootstrap inserts get a stable ID snapshot, never an
    # Avatar-derived read fallback. Product creation supplies a validated name.
    display_name: Mapped[str] = mapped_column(
        String(120), nullable=False, default=lambda context: context.get_current_parameters()["id"][:120]
    )
    aggregate_revision: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("1"))
    identity_status: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=sa_text("'repair_required'")
    )
    metadata_: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSONB, nullable=False, server_default=sa_text("'{}'::jsonb")
    )
    # Optional creator/owner of anima (application-level FK to auth user id)
    user_id: Mapped[str | None] = mapped_column(String, nullable=True)
    archive_id: Mapped[str | None] = mapped_column(String, ForeignKey("archives.id", ondelete="CASCADE"), nullable=True)
    avatar_id: Mapped[str | None] = mapped_column(String, ForeignKey("avatar.id", ondelete="RESTRICT"), nullable=True)
    profile_picture_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    emotional_state: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    # When the owner pinned the Anima in the sidebar; NULL when unpinned. Runtime
    # state, not part of the definition: it never advances aggregate_revision.
    pinned_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=False), nullable=True)

    archive: Mapped[ORMArchive | None] = relationship(
        "ORMArchive",
        foreign_keys=[archive_id],
        lazy="selectin",
        cascade="all, delete-orphan",
        single_parent=True,
        uselist=False,
    )
    avatar: Mapped[ORMAvatar | None] = relationship(
        "ORMAvatar",
        back_populates="animas",
        lazy="selectin",
    )
    # 1->N relationship to product chats
    chats: Mapped[list[ORMChat]] = relationship(
        "ORMChat",
        back_populates="anima",
        cascade="all, delete-orphan",
        passive_deletes=True,
        lazy="selectin",
    )

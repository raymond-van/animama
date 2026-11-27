"""Store sidebar pins on chats and Animas.

Revision ID: sidebar_pins_20261126
Revises: reasoning_effort_20261112
Create Date: 2026-11-26

A pin is a nullable ``pinned_at`` timestamp on the pinned row, so deleting a
chat or an Anima deletes its pin with it. NULL means unpinned, which is how
every existing row starts. The column uses the same type as each table's
``created_at``. Adding it appends it, so an upgraded profile and a fresh
database end with the same schema; ``IF NOT EXISTS`` keeps a rerun harmless.
Keep this revision independent of live ORM imports.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "sidebar_pins_20261126"
down_revision: str | None = "reasoning_effort_20261112"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE chats ADD COLUMN IF NOT EXISTS pinned_at timestamp without time zone")
    op.execute("ALTER TABLE anima ADD COLUMN IF NOT EXISTS pinned_at timestamp without time zone")


def downgrade() -> None:
    op.execute("ALTER TABLE anima DROP COLUMN pinned_at")
    op.execute("ALTER TABLE chats DROP COLUMN pinned_at")

"""Link the content assistant's conversations to their reference images (spec #942, R8.2).

Revision ID: reference_images_20261127
Revises: content_generation_20261126
Create Date: 2026-11-27

A reference image is a user file, stored as a chat image is. A row here makes
it a conversation's: it goes with the conversation, and with the file's own
row. The revision only adds a table, so an upgraded profile and a fresh
database end with the same schema. Keep this revision independent of live ORM
imports.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "reference_images_20261127"
down_revision: str | None = "content_generation_20261126"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_STATEMENTS = (
    """
    CREATE TABLE generation_reference_images (
        conversation_id character varying NOT NULL,
        file_id character varying NOT NULL,
        owner_user_id character varying NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        CONSTRAINT pk_generation_reference_images PRIMARY KEY (conversation_id, file_id),
        CONSTRAINT fk_generation_reference_images_conversation_id FOREIGN KEY (conversation_id)
            REFERENCES generation_conversations (id) ON DELETE CASCADE,
        CONSTRAINT fk_generation_reference_images_file_id FOREIGN KEY (file_id)
            REFERENCES user_file (id) ON DELETE CASCADE
    )
    """,
    "CREATE INDEX ix_generation_reference_images_file_id ON generation_reference_images (file_id)",
)


def upgrade() -> None:
    for statement in _STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    """Drop the links. The image files stay in the Library, where the person can delete them."""

    op.execute("DROP TABLE generation_reference_images")

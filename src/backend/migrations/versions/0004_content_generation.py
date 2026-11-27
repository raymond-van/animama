"""Add the content assistant's conversations, messages and drafts (spec #942).

Revision ID: content_generation_20261126
Revises: sidebar_pins_20261126
Create Date: 2026-11-26

An assistant conversation is not a Chat: these tables reference neither
``chats`` nor ``anima``. Messages and drafts go with their conversation. The
revision only adds tables, so an upgraded profile and a fresh database end with
the same schema. Keep this revision independent of live ORM imports; its CHECK
constraints repeat the values of the generation ORM models and are compared
with them by hand.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "content_generation_20261126"
down_revision: str | None = "sidebar_pins_20261126"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_STATEMENTS = (
    """
    CREATE TABLE generation_conversations (
        id character varying NOT NULL,
        owner_user_id character varying NOT NULL,
        title text DEFAULT '' NOT NULL,
        scope jsonb NOT NULL,
        style_preset text,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        CONSTRAINT pk_generation_conversations PRIMARY KEY (id)
    )
    """,
    "CREATE INDEX ix_generation_conversations_owner_user_id ON generation_conversations (owner_user_id)",
    """
    CREATE TABLE generation_messages (
        id character varying NOT NULL,
        conversation_id character varying NOT NULL,
        role character varying NOT NULL,
        text text NOT NULL,
        data jsonb DEFAULT '{}'::jsonb NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        CONSTRAINT pk_generation_messages PRIMARY KEY (id),
        CONSTRAINT fk_generation_messages_conversation_id FOREIGN KEY (conversation_id)
            REFERENCES generation_conversations (id) ON DELETE CASCADE,
        CONSTRAINT ck_generation_messages_role_values CHECK (role IN ('user', 'assistant'))
    )
    """,
    "CREATE INDEX ix_generation_messages_conversation_id ON generation_messages (conversation_id)",
    """
    CREATE TABLE generation_drafts (
        id character varying NOT NULL,
        conversation_id character varying NOT NULL,
        owner_user_id character varying NOT NULL,
        intent character varying NOT NULL,
        position integer NOT NULL,
        status character varying NOT NULL,
        version integer DEFAULT 1 NOT NULL,
        project jsonb,
        previous_project jsonb,
        check_report jsonb,
        checked_version integer,
        repair_count integer DEFAULT 0 NOT NULL,
        failure_reason text,
        saved_item_id text,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        CONSTRAINT pk_generation_drafts PRIMARY KEY (id),
        CONSTRAINT fk_generation_drafts_conversation_id FOREIGN KEY (conversation_id)
            REFERENCES generation_conversations (id) ON DELETE CASCADE,
        CONSTRAINT ck_generation_drafts_intent_values CHECK (intent IN ('gesture', 'reaction')),
        CONSTRAINT ck_generation_drafts_status_values CHECK (
            status IN ('writing', 'checking', 'repairing', 'reviewing', 'ready', 'warnings', 'failed')
        )
    )
    """,
    "CREATE INDEX ix_generation_drafts_conversation_id ON generation_drafts (conversation_id)",
)


def upgrade() -> None:
    for statement in _STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    """Drop the assistant's tables with every conversation and draft in them."""

    for table_name in ("generation_drafts", "generation_messages", "generation_conversations"):
        op.execute(f"DROP TABLE {table_name}")

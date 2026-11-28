import hashlib
import json
import logging
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from alembic.util import CommandError
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from tests.migration_database_helpers import alembic_head

ROOT = Path(__file__).parents[1]
VERSIONS = ROOT / "src" / "backend" / "migrations" / "versions"
BASELINE_MIGRATION = VERSIONS / "0001_baseline.py"
BASELINE_SQL = VERSIONS / "0001_baseline.sql"
BASELINE_REVISION = "baseline_20260908"
REASONING_EFFORT_REVISION = "reasoning_effort_20261112"
# Desktop 0.1.2 shipped this exact baseline, and installed profiles carry its
# revision. Never update this hash: change the schema with a new revision.
BASELINE_SHA256 = "438446a4a68e40391786337c6f0acd68e7398cf32dc9b82416bc59c975af1ad6"
SCRIPTS = ScriptDirectory.from_config(Config(str(ROOT / "src/backend/alembic.ini")))


def test_revisions_do_not_import_live_metadata() -> None:
    """Migrations replay the schema of their time, not the current ORM."""

    for path in sorted(VERSIONS.glob("*.py")):
        migration = path.read_text(encoding="utf-8")
        assert "animama.orm" not in migration, path.name
        assert "Base.metadata" not in migration, path.name
        assert "create_all" not in migration, path.name
    assert "0001_baseline.sql" in BASELINE_MIGRATION.read_text(encoding="utf-8")


def test_baseline_artifact_is_frozen_at_the_released_schema() -> None:
    baseline = BASELINE_SQL.read_bytes()
    assert hashlib.sha256(baseline).hexdigest() == BASELINE_SHA256
    sql = baseline.decode("utf-8")
    assert "CREATE EXTENSION IF NOT EXISTS vector" in sql
    assert sql.count("CREATE TABLE ") == 47


def test_history_is_one_linear_chain_from_the_baseline() -> None:
    """Every installed revision must have exactly one path to the head."""

    assert SCRIPTS.get_heads() == [alembic_head()]
    revisions = list(SCRIPTS.walk_revisions())
    assert revisions[-1].revision == BASELINE_REVISION
    assert revisions[-1].down_revision is None
    for newer, older in zip(revisions, revisions[1:], strict=False):
        assert newer.down_revision == older.revision
    # alembic_version.version_num is varchar(32).
    assert all(len(revision.revision) <= 32 for revision in revisions)


def test_fresh_database_migrates_to_head(db_url: str, monkeypatch) -> None:
    """Create the current schema directly, with independent installation owners."""

    base_url = make_url(db_url.replace("+asyncpg", "+psycopg"))
    schema = f"migration_fresh_{uuid.uuid4().hex}"
    admin_engine = create_engine(base_url)
    with admin_engine.begin() as connection:
        connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')

    migration_url = base_url.update_query_dict({"options": f"-csearch_path={schema},public"})
    rendered_url = migration_url.render_as_string(hide_password=False)
    monkeypatch.setenv("ANIMAMA_DATABASE_URL", rendered_url)
    config = Config(str(ROOT / "src/backend/alembic.ini"))
    second_schema = f"migration_fresh_{uuid.uuid4().hex}"
    with admin_engine.begin() as connection:
        connection.exec_driver_sql(f'CREATE SCHEMA "{second_schema}"')
    # Alembic runs in-process with the backend, so it must not silence loggers that already exist.
    existing_logger = logging.getLogger("animama.tests.existing_before_migration")
    try:
        command.upgrade(config, "head")
        assert not existing_logger.disabled
        engine = create_engine(migration_url)
        try:
            tables = set(inspect(engine).get_table_names())
            assert "installation_settings" in tables
            assert "content_catalog_items" in tables
            assert "anima_content_bindings" in tables
            # Poses are catalog content; the frozen schema must not equip them.
            catalog_checks = inspect(engine).get_check_constraints("content_catalog_items")
            binding_checks = inspect(engine).get_check_constraints("anima_content_bindings")
            assert any("'pose'" in check["sqltext"] for check in catalog_checks)
            assert all("'pose'" not in check["sqltext"] for check in binding_checks)
            assert "anima_runtime_snapshots" in tables
            assert "runtime_worker_heartbeats" in tables
            assert "content_mutation_receipts" in tables
            assert "anima_definition_revisions" in tables
            assert "anima_loadout_diagnostics" in tables
            # Reflection coverage is removed with its Anima.
            assert {column["name"] for column in inspect(engine).get_columns("anima_memory_reflections")} == {
                "anima_id",
                "user_id",
                "covered_through_created_at",
                "covered_through_message_id",
                "run_id",
                "updated_at",
            }
            (reflection_fk,) = inspect(engine).get_foreign_keys("anima_memory_reflections")
            assert reflection_fk["referred_table"] == "anima"
            assert reflection_fk["options"]["ondelete"] == "CASCADE"
            run_checks = inspect(engine).get_check_constraints("memory_manager_runs")
            assert any("'reflection'" in check["sqltext"] for check in run_checks)
            anima_columns = {column["name"]: column for column in inspect(engine).get_columns("anima")}
            assert anima_columns["display_name"]["nullable"] is False
            assert anima_columns["aggregate_revision"]["nullable"] is False
            avatar_fk = next(
                fk for fk in inspect(engine).get_foreign_keys("anima") if fk["constrained_columns"] == ["avatar_id"]
            )
            assert avatar_fk["options"]["ondelete"] == "RESTRICT"
            # Avatar names are unique per owner; ownerless rows share one namespace.
            avatar_unique = {c["name"]: c for c in inspect(engine).get_unique_constraints("avatar")}
            assert "uq_avatar_name" not in avatar_unique
            assert avatar_unique["uq_avatar_owner_name"]["column_names"] == ["user_id", "name"]
            insert_avatar = text(
                "INSERT INTO avatar (id, name, file_path, user_id) VALUES (:id, 'Same', 'a.vrm', :user)"
            )
            with engine.connect() as connection:
                for avatar_id, user in (("owner-a", "a"), ("owner-b", "b"), ("ownerless", None)):
                    connection.execute(insert_avatar, {"id": avatar_id, "user": user})
                for avatar_id, user in (("dup-owner", "a"), ("dup-ownerless", None)):
                    with pytest.raises(IntegrityError, match="uq_avatar_owner_name"):
                        with connection.begin_nested():
                            connection.execute(insert_avatar, {"id": avatar_id, "user": user})
                connection.rollback()
            binding_indexes = {index["name"]: index for index in inspect(engine).get_indexes("anima_content_bindings")}
            for name in ("uq_anima_music_autoplay", "uq_anima_music_catalog_item"):
                assert binding_indexes[name]["unique"]
                assert binding_indexes[name]["dialect_options"]["postgresql_where"]
            assert {
                "user",
                "session",
                "account",
                "verification",
                "jwks",
                "apikey",
                "username_claims",
                "content_items",
                "content_releases",
                "content_blobs",
                "local_content_catalog_items",
                "anima_local_content_bindings",
                "anima_runtime_file_memberships",
            }.isdisjoint(tables)
            snapshot_columns = {column["name"] for column in inspect(engine).get_columns("anima_runtime_snapshots")}
            assert "admitted_item_revisions" in snapshot_columns
            assert {column["name"] for column in inspect(engine).get_columns("user_profiles")} == {
                "user_id",
                "display_name",
                "created_at",
                "updated_at",
            }
            principal_column = next(
                column
                for column in inspect(engine).get_columns("installation_settings")
                if column["name"] == "installation_principal_id"
            )
            assert principal_column["nullable"] is False
            assert all(
                foreign_key.get("referred_table") != "user"
                for table_name in tables
                for foreign_key in inspect(engine).get_foreign_keys(table_name)
            )
            with engine.connect() as connection:
                assert connection.execute(text("SELECT id FROM installation_settings")).scalar_one() == 1
                first_principal = connection.execute(
                    text("SELECT installation_principal_id FROM installation_settings")
                ).scalar_one()
                assert uuid.UUID(first_principal).version == 4
                assert connection.scalar(text("SELECT version_num FROM alembic_version")) == alembic_head()
            command.upgrade(config, "head")
            with engine.connect() as connection:
                assert connection.execute(
                    text("SELECT installation_principal_id FROM installation_settings")
                ).scalars().all() == [first_principal]
        finally:
            engine.dispose()

        second_url = base_url.update_query_dict({"options": f"-csearch_path={second_schema},public"})
        monkeypatch.setenv("ANIMAMA_DATABASE_URL", second_url.render_as_string(hide_password=False))
        command.upgrade(Config(str(ROOT / "src/backend/alembic.ini")), "head")
        second_engine = create_engine(second_url)
        try:
            with second_engine.connect() as connection:
                second_principal = connection.execute(
                    text("SELECT installation_principal_id FROM installation_settings")
                ).scalar_one()
            assert uuid.UUID(second_principal).version == 4
            assert second_principal != first_principal
        finally:
            second_engine.dispose()
    finally:
        with admin_engine.begin() as connection:
            connection.exec_driver_sql(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
            connection.exec_driver_sql(f'DROP SCHEMA IF EXISTS "{second_schema}" CASCADE')
        admin_engine.dispose()


@contextmanager
def migration_schema(db_url: str, monkeypatch: pytest.MonkeyPatch):
    """Keep baseline and failure probes in their own disposable schema."""

    base_url = make_url(db_url.replace("+asyncpg", "+psycopg"))
    schema = f"migration_constraint_{uuid.uuid4().hex}"
    admin = create_engine(base_url)
    with admin.begin() as connection:
        connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
    url = base_url.update_query_dict({"options": f"-csearch_path={schema},public"})
    monkeypatch.setenv("ANIMAMA_DATABASE_URL", url.render_as_string(hide_password=False))
    engine = create_engine(url)
    try:
        yield Config(str(ROOT / "src/backend/alembic.ini")), engine
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
        admin.dispose()


def test_released_baseline_profile_upgrades_to_head_with_its_rows(db_url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """A desktop 0.1.2 profile sits at the baseline; upgrading adds later columns and keeps its rows."""

    with migration_schema(db_url, monkeypatch) as (config, engine):
        command.upgrade(config, BASELINE_REVISION)
        assert "reasoning_effort" not in {
            column["name"] for column in inspect(engine).get_columns("anima_chat_profiles")
        }
        with engine.begin() as connection:
            principal = connection.scalar(text("SELECT installation_principal_id FROM installation_settings"))
            connection.execute(
                text(
                    "INSERT INTO model_connections (id, source, name, preset, compatibility, active) "
                    "VALUES ('openai', 'builtin', 'OpenAI', 'openai', '{}', true)"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO model_providers (id, model, provider_type, model_label, provider_label, "
                    "service_tiers_supported, active, accepts, produces, supports_developer_role, supports_tools, "
                    "supports_streaming, structured_kinds, pricing_status, pricing_notes, metadata) VALUES "
                    "('provider', 'model', 'openai', 'Model', 'Provider', '[]', true, '[]', '[]', true, true, true, "
                    "'[]', 'unknown', '[]', '{}')"
                )
            )
            connection.execute(text("INSERT INTO anima (id, display_name) VALUES ('anima', 'Annie')"))
            connection.execute(
                text(
                    "INSERT INTO anima_chat_profiles (anima_id, default_model_provider_id) VALUES ('anima', 'provider')"
                )
            )

        command.upgrade(config, "head")

        columns = [column["name"] for column in inspect(engine).get_columns("anima_chat_profiles")]
        # Appended, so the upgraded schema matches a fresh database's column order.
        assert columns[-1] == "reasoning_effort"
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == alembic_head()
            assert connection.scalar(text("SELECT installation_principal_id FROM installation_settings")) == principal
            assert tuple(
                connection.execute(
                    text("SELECT anima_id, default_model_provider_id, reasoning_effort FROM anima_chat_profiles")
                ).one()
            ) == ("anima", "provider", None)

        command.downgrade(config, BASELINE_REVISION)
        assert "reasoning_effort" not in {
            column["name"] for column in inspect(engine).get_columns("anima_chat_profiles")
        }
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT count(*) FROM anima_chat_profiles")) == 1


def test_profile_before_sidebar_pins_upgrades_with_its_rows_unpinned(
    db_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pins add a nullable pinned_at, typed like created_at, to chats and anima; existing rows start unpinned."""

    with migration_schema(db_url, monkeypatch) as (config, engine):
        command.upgrade(config, REASONING_EFFORT_REVISION)
        with engine.begin() as connection:
            connection.execute(text("INSERT INTO anima (id, display_name, user_id) VALUES ('anima', 'Annie', 'owner')"))
            connection.execute(text("INSERT INTO chats (id, user_id, anima_id) VALUES ('chat', 'owner', 'anima')"))

        command.upgrade(config, "head")

        for table, row_id in (("anima", "anima"), ("chats", "chat")):
            columns = inspect(engine).get_columns(table)
            by_name = {column["name"]: column for column in columns}
            # Appended, so the upgraded schema matches a fresh database's column order.
            assert columns[-1]["name"] == "pinned_at", table
            assert by_name["pinned_at"]["nullable"] is True
            assert str(by_name["pinned_at"]["type"]) == str(by_name["created_at"]["type"])
            with engine.connect() as connection:
                assert connection.execute(text(f"SELECT id, pinned_at FROM {table}")).all() == [(row_id, None)]

        command.downgrade(config, REASONING_EFFORT_REVISION)
        for table in ("anima", "chats"):
            assert "pinned_at" not in {column["name"] for column in inspect(engine).get_columns(table)}
            with engine.connect() as connection:
                assert connection.scalar(text(f"SELECT count(*) FROM {table}")) == 1


def test_database_from_the_edited_baseline_reaches_head(db_url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Development stacks and 0.1.3 preview profiles got reasoning_effort from an edited baseline."""

    with migration_schema(db_url, monkeypatch) as (config, engine):
        command.upgrade(config, BASELINE_REVISION)
        with engine.begin() as connection:
            connection.execute(
                text("ALTER TABLE anima_chat_profiles ADD COLUMN reasoning_effort character varying(16)")
            )
        command.upgrade(config, "head")
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == alembic_head()
        columns = [column["name"] for column in inspect(engine).get_columns("anima_chat_profiles")]
        assert columns.count("reasoning_effort") == 1


# (table, name in the frozen baseline, name in the ORM): the same objects under
# legacy names. Code matches some constraint names, so no other rename is ignored.
KNOWN_NAME_DIFFERENCES = {
    ("anima_content_bindings", "uq_anima_content_bindings_uq_anima_content_slot", "uq_anima_content_slot"),
    ("content_catalog_dependencies", "ix_content_dependencies_target", "ix_content_catalog_dependencies_target"),
    (
        "content_catalog_dependencies",
        "uq_content_catalog_dependencies_uq_content__d318",
        "uq_content_catalog_dependency_ref",
    ),
    ("content_catalog_files", "ix_content_files_item_ordinal", "ix_content_catalog_files_item_ordinal"),
    ("content_catalog_files", "uq_content_catalog_files_uq_content_file_path", "uq_content_catalog_file_path"),
    (
        "content_catalog_items",
        "uq_content_catalog_items_uq_content_source_locator",
        "uq_content_catalog_source_locator",
    ),
}


def _unexplained_differences(diffs: list[Any]) -> list[str]:
    """Report every difference except a known rename: both sides present, same columns and uniqueness."""

    def named(diff: Any) -> tuple[str, str, str] | None:
        # Column changes arrive as lists of tuples; only index and constraint tuples can be renames.
        if isinstance(diff, tuple) and diff[0] in {"add_index", "remove_index", "add_constraint", "remove_constraint"}:
            return (diff[0].split("_", 1)[0], diff[1].table.name, diff[1].name)
        return None

    def shape(item: Any) -> tuple[Any, ...]:
        return (type(item).__name__, tuple(column.name for column in item.columns), getattr(item, "unique", None))

    shapes = {named(diff): shape(diff[1]) for diff in diffs if named(diff) is not None}
    explained: set[tuple[str, str, str] | None] = set()
    for table, baseline_name, orm_name in KNOWN_NAME_DIFFERENCES:
        removed, added = ("remove", table, baseline_name), ("add", table, orm_name)
        if removed in shapes and added in shapes and shapes[removed] == shapes[added]:
            explained |= {removed, added}
    return [repr(diff) for diff in diffs if named(diff) is None or named(diff) not in explained]


def test_orm_matches_the_migrated_schema(db_url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """An ORM schema change without a revision fails here, before installed profiles miss it.

    Compared: tables, columns, types, nullability, server defaults, indexes, and
    unique and foreign-key constraints. Not compared: CHECK constraints and index predicates.
    """

    from animama.local import installation_model  # noqa: F401 - registers the installation tables
    from animama.orm import Base

    with migration_schema(db_url, monkeypatch) as (config, engine):
        command.upgrade(config, "head")
        with engine.connect() as connection:
            context = MigrationContext.configure(
                connection, opts={"compare_type": True, "compare_server_default": True}
            )
            diffs = compare_metadata(context, Base.metadata)
    assert _unexplained_differences(diffs) == []


@pytest.mark.parametrize("old_revision", ["0001", "0013_content_mutation_receipts"])
def test_old_revision_is_rejected_without_adopting_or_changing_data(
    db_url: str, monkeypatch: pytest.MonkeyPatch, old_revision: str
) -> None:
    with migration_schema(db_url, monkeypatch) as (config, engine):
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE alembic_version (version_num varchar(32) NOT NULL PRIMARY KEY)"))
            connection.execute(text("INSERT INTO alembic_version VALUES (:revision)"), {"revision": old_revision})
            connection.execute(text("CREATE TABLE sentinel (value text NOT NULL)"))
            connection.execute(text("INSERT INTO sentinel VALUES ('preserve me')"))
        with pytest.raises(CommandError, match="Can't locate revision"):
            command.upgrade(config, "head")
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == old_revision
            assert connection.scalar(text("SELECT value FROM sentinel")) == "preserve me"
            schema = connection.scalar(text("SELECT current_schema()"))
        assert set(inspect(engine).get_table_names(schema=schema)) == {"alembic_version", "sentinel"}


def test_fresh_creation_receipts_are_owner_scoped_and_survive_absent_animas(
    db_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The frozen SQL must enforce receipts without resurrecting account tables."""

    with migration_schema(db_url, monkeypatch) as (config, engine):
        command.upgrade(config, "head")
        insert = text(
            "INSERT INTO anima_creation_receipts "
            "(owner_user_id, operation, idempotency_key, spec_sha256, anima_id, result) "
            "VALUES (:owner, :operation, 'key', :sha, 'detached-result-id', CAST(:result AS jsonb))"
        )
        values = {"owner": "owner", "operation": "live_anima_create_v1", "sha": "a" * 64, "result": "{}"}
        with engine.begin() as connection:
            assert connection.scalar(text("SELECT count(*) FROM anima_starter_receipts")) == 0
            connection.execute(insert, values)
            connection.execute(insert, {**values, "owner": "other-owner"})
        # Operation identity and bounded object results are database invariants.
        for changes in (
            {},
            {"operation": "invalid"},
            {"owner": "third", "result": "[]"},
            {"owner": "oversized", "result": json.dumps({"payload": "x" * 65536})},
        ):
            with pytest.raises(IntegrityError), engine.begin() as connection:
                connection.execute(insert, {**values, **changes})
        with pytest.raises(IntegrityError), engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO anima_starter_receipts (owner_user_id, starter_id, spec_version, state) "
                    "VALUES ('owner', 'starter:annie', 1, 'ready')"
                )
            )
        command.upgrade(config, "head")
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT count(*) FROM anima_creation_receipts")) == 2
            assert connection.scalar(text("SELECT count(*) FROM anima_starter_receipts")) == 0


def test_fresh_avatar_setting_overrides_store_only_non_automatic_modes(
    db_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Owner settings are keyed by owner and Avatar item, hold valid modes only and go with the item."""

    with migration_schema(db_url, monkeypatch) as (config, engine):
        command.upgrade(config, "head")
        assert inspect(engine).get_pk_constraint("avatar_setting_overrides")["constrained_columns"] == [
            "owner_user_id",
            "avatar_item_id",
        ]
        (item_fk,) = inspect(engine).get_foreign_keys("avatar_setting_overrides")
        assert item_fk["referred_table"] == "content_catalog_items"
        assert item_fk["options"]["ondelete"] == "CASCADE"
        insert = text(
            "INSERT INTO avatar_setting_overrides (owner_user_id, avatar_item_id, spring_mode, material_mode) "
            "VALUES (:owner, 'avatar-item', :spring, :material)"
        )
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO content_catalog_items "
                    "(id, source, scope, kind, relative_locator, display_name, status) "
                    "VALUES ('avatar-item', 'included', 'included', 'avatar', 'avatars/a.vrm', 'A', 'valid')"
                )
            )
            connection.execute(insert, {"owner": "a", "spring": "springs_off", "material": None})
            connection.execute(insert, {"owner": "b", "spring": None, "material": "simple"})
        # Automatic is stored as NULL, never as a value.
        for spring, material in (("automatic", None), ("windy", None), (None, "automatic"), (None, "mtoon")):
            with pytest.raises(IntegrityError), engine.begin() as connection:
                connection.execute(insert, {"owner": "c", "spring": spring, "material": material})
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM content_catalog_items WHERE id = 'avatar-item'"))
            assert connection.scalar(text("SELECT count(*) FROM avatar_setting_overrides")) == 0


def test_previous_head_gains_the_content_assistant_tables(db_url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """A profile at the previous head keeps its rows; the new tables hold valid values and reference no Chat."""

    previous_head = "sidebar_pins_20261126"
    generation_tables = {"generation_conversations", "generation_messages", "generation_drafts"}
    with migration_schema(db_url, monkeypatch) as (config, engine):
        with engine.connect() as connection:
            schema = connection.scalar(text("SELECT current_schema()"))

        def migrated_tables() -> set[str]:
            # Named by schema: tables another test created in public are visible on the search path too.
            return set(inspect(engine).get_table_names(schema=schema))

        command.upgrade(config, previous_head)
        assert generation_tables.isdisjoint(migrated_tables())
        with engine.begin() as connection:
            principal = connection.scalar(text("SELECT installation_principal_id FROM installation_settings"))
            connection.execute(text("INSERT INTO anima (id, display_name) VALUES ('anima', 'Annie')"))

        command.upgrade(config, "head")

        assert generation_tables <= migrated_tables()
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == alembic_head()
            assert connection.scalar(text("SELECT installation_principal_id FROM installation_settings")) == principal
            assert connection.scalar(text("SELECT display_name FROM anima")) == "Annie"
        # Messages and drafts go with their conversation, and nothing references a Chat or an Anima.
        assert inspect(engine).get_foreign_keys("generation_conversations", schema=schema) == []
        for table in ("generation_messages", "generation_drafts"):
            (conversation_fk,) = inspect(engine).get_foreign_keys(table, schema=schema)
            assert conversation_fk["referred_table"] == "generation_conversations"
            assert conversation_fk["options"]["ondelete"] == "CASCADE"

        message = text(
            "INSERT INTO generation_messages (id, conversation_id, role, text) "
            "VALUES (:id, 'conversation', :role, 'Hi')"
        )
        draft = text(
            "INSERT INTO generation_drafts (id, conversation_id, owner_user_id, intent, position, status) "
            "VALUES (:id, 'conversation', 'owner', :intent, 0, :status)"
        )
        statuses = ("writing", "checking", "repairing", "reviewing", "ready", "warnings", "failed")
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO generation_conversations (id, owner_user_id, scope) "
                    "VALUES ('conversation', 'owner', CAST('{\"kind\": \"page\"}' AS jsonb))"
                )
            )
            for role in ("user", "assistant"):
                connection.execute(message, {"id": role, "role": role})
            for status in statuses:
                connection.execute(draft, {"id": status, "intent": "gesture", "status": status})
            connection.execute(draft, {"id": "reaction", "intent": "reaction", "status": "ready"})
            assert connection.scalar(text("SELECT title FROM generation_conversations")) == ""
            assert connection.scalar(text("SELECT data FROM generation_messages WHERE id = 'user'")) == {}
            assert tuple(
                connection.execute(
                    text("SELECT version, repair_count, project FROM generation_drafts WHERE id = 'ready'")
                ).one()
            ) == (1, 0, None)
        for role in ("system", "tool", "User", ""):
            with (
                pytest.raises(IntegrityError, match="ck_generation_messages_role_values"),
                engine.begin() as connection,
            ):
                connection.execute(message, {"id": "refused", "role": role})
        for intent in ("pose", "idle", "Gesture"):
            with (
                pytest.raises(IntegrityError, match="ck_generation_drafts_intent_values"),
                engine.begin() as connection,
            ):
                connection.execute(draft, {"id": "refused", "intent": intent, "status": "ready"})
        for status in ("done", "saved", "Ready"):
            with (
                pytest.raises(IntegrityError, match="ck_generation_drafts_status_values"),
                engine.begin() as connection,
            ):
                connection.execute(draft, {"id": "refused", "intent": "gesture", "status": status})
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM generation_conversations WHERE id = 'conversation'"))
            assert connection.scalar(text("SELECT count(*) FROM generation_messages")) == 0
            assert connection.scalar(text("SELECT count(*) FROM generation_drafts")) == 0

        command.downgrade(config, previous_head)
        assert generation_tables.isdisjoint(migrated_tables())
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == previous_head
            assert connection.scalar(text("SELECT display_name FROM anima")) == "Annie"


def test_previous_head_gains_the_reference_image_table(db_url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """A profile at the previous head keeps its conversations; a link goes with its conversation or its file."""

    previous_head = "content_generation_20261126"
    with migration_schema(db_url, monkeypatch) as (config, engine):
        with engine.connect() as connection:
            schema = connection.scalar(text("SELECT current_schema()"))

        def migrated_tables() -> set[str]:
            return set(inspect(engine).get_table_names(schema=schema))

        command.upgrade(config, previous_head)
        assert "generation_reference_images" not in migrated_tables()
        with engine.begin() as connection:
            for conversation in ("kept", "discarded"):
                connection.execute(
                    text(
                        "INSERT INTO generation_conversations (id, owner_user_id, scope) "
                        "VALUES (:id, 'owner', '{\"kind\": \"page\"}')"
                    ),
                    {"id": conversation},
                )
            for file_id in ("picture", "other"):
                connection.execute(
                    text(
                        "INSERT INTO user_file (id, user_id, storage_locator, original_filename, "
                        "normalized_extension, declared_size_bytes, status, upload_expires_at, metadata) "
                        "VALUES (:id, 'owner', :locator, 'a.png', '.png', 3, 'ready', CURRENT_TIMESTAMP, '{}')"
                    ),
                    {"id": file_id, "locator": f"user-files/owner/{file_id}/original"},
                )

        command.upgrade(config, "head")

        assert "generation_reference_images" in migrated_tables()
        link = text(
            "INSERT INTO generation_reference_images (conversation_id, file_id, owner_user_id) VALUES (:c, :f, 'owner')"
        )
        with engine.begin() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == alembic_head()
            # The conversations from before the upgrade are still there, and now take links.
            assert connection.scalar(text("SELECT count(*) FROM generation_conversations")) == 2
            for conversation, file_id in (("kept", "picture"), ("discarded", "picture"), ("discarded", "other")):
                connection.execute(link, {"c": conversation, "f": file_id})
        referred = {
            key["referred_table"]: key["options"].get("ondelete")
            for key in inspect(engine).get_foreign_keys("generation_reference_images", schema=schema)
        }
        assert referred == {"generation_conversations": "CASCADE", "user_file": "CASCADE"}
        with engine.begin() as connection:
            # One image is linked to a conversation once, and only to a conversation and a file that exist.
            for values in (
                {"c": "kept", "f": "picture"},
                {"c": "nobody", "f": "picture"},
                {"c": "kept", "f": "nothing"},
            ):
                with pytest.raises(IntegrityError), connection.begin_nested():
                    connection.execute(link, values)
            # A link goes with its conversation, and with its file's row; neither takes the other with it.
            connection.execute(text("DELETE FROM generation_conversations WHERE id = 'discarded'"))
            assert connection.scalar(text("SELECT count(*) FROM generation_reference_images")) == 1
            assert connection.scalar(text("SELECT count(*) FROM user_file")) == 2
            connection.execute(text("DELETE FROM user_file WHERE id = 'picture'"))
            assert connection.scalar(text("SELECT count(*) FROM generation_reference_images")) == 0
            assert connection.scalar(text("SELECT count(*) FROM generation_conversations")) == 1

        command.downgrade(config, previous_head)
        assert "generation_reference_images" not in migrated_tables()
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == previous_head
            # The conversations and the image files outlive the links.
            assert connection.scalar(text("SELECT count(*) FROM generation_conversations")) == 1
            assert connection.scalar(text("SELECT count(*) FROM user_file")) == 1

import hashlib
import json
import logging
import uuid
from contextlib import contextmanager
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from alembic.util import CommandError

ROOT = Path(__file__).parents[1]
BASELINE_MIGRATION = ROOT / "alembic" / "versions" / "0001_baseline.py"
BASELINE_SQL = ROOT / "alembic" / "versions" / "0001_baseline.sql"
BASELINE_SHA256 = "229c3825df93f36840f80f981f2a319203f14652204f2f791d94c4ae30c860e8"


def test_baseline_does_not_import_live_metadata() -> None:
    migration = BASELINE_MIGRATION.read_text(encoding="utf-8")
    assert "animama.orm" not in migration
    assert "Base.metadata" not in migration
    assert "create_all" not in migration
    assert "0001_baseline.sql" in migration


def test_baseline_artifact_has_the_reviewed_schema_fingerprint() -> None:
    baseline = BASELINE_SQL.read_bytes()
    assert hashlib.sha256(baseline).hexdigest() == BASELINE_SHA256
    sql = baseline.decode("utf-8")
    assert "CREATE EXTENSION IF NOT EXISTS vector" in sql
    assert sql.count("CREATE TABLE ") == 46


def test_current_schema_is_the_single_root_and_head() -> None:
    scripts = ScriptDirectory.from_config(Config(str(ROOT / "alembic.ini")))
    assert scripts.get_heads() == ["baseline_20260908"]
    revisions = list(scripts.walk_revisions())
    assert len(revisions) == 1
    assert revisions[0].down_revision is None


def test_fresh_database_migrates_to_head(db_url: str, monkeypatch) -> None:  # noqa: ANN001
    """Create the current schema directly, with independent installation owners."""

    base_url = make_url(db_url.replace("+asyncpg", "+psycopg"))
    schema = f"migration_fresh_{uuid.uuid4().hex}"
    admin_engine = create_engine(base_url)
    with admin_engine.begin() as connection:
        connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')

    migration_url = base_url.update_query_dict({"options": f"-csearch_path={schema},public"})
    rendered_url = migration_url.render_as_string(hide_password=False)
    monkeypatch.setenv("ANIMAMA_DATABASE_URL", rendered_url)
    config = Config(str(ROOT / "alembic.ini"))
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
                assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "baseline_20260908"
            command.upgrade(config, "head")
            with engine.connect() as connection:
                assert connection.execute(
                    text("SELECT installation_principal_id FROM installation_settings")
                ).scalars().all() == [first_principal]
        finally:
            engine.dispose()

        second_url = base_url.update_query_dict({"options": f"-csearch_path={second_schema},public"})
        monkeypatch.setenv("ANIMAMA_DATABASE_URL", second_url.render_as_string(hide_password=False))
        command.upgrade(Config(str(ROOT / "alembic.ini")), "head")
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
        yield Config(str(ROOT / "alembic.ini")), engine
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
        admin.dispose()


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

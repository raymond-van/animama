from __future__ import annotations

import hashlib
import json
import os
import runpy
import sys
import tarfile
from pathlib import Path

import pytest
from alembic.script import ScriptDirectory

from animama.runtime import cli, resources


def test_runtime_resource_audit_has_schema_and_starter_resources() -> None:
    evidence = resources.audit_resources()
    # Every revision file in the migrations folder is part of the packaged graph.
    assert evidence["migration_count"] == len(list((resources.runtime_resource("alembic") / "versions").glob("*.py")))
    assert evidence["sql_count"] == 2
    assert evidence["gesture_count"] == 45
    assert evidence["authoring_guidance_files"] == 9
    assert evidence["generation_example_beats"] == 4
    assert evidence["starter_policy"] == "builtin:starter-loadout"
    assert evidence["local_http_schema_version"] == 1


def test_resource_audit_rejects_missing_authoring_guidance(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A frozen build that left out the guidance Markdown fails its audit, naming the file."""

    from animama.resources import authoring_guidance

    monkeypatch.setattr(authoring_guidance, "files", lambda package: tmp_path)
    with pytest.raises(FileNotFoundError, match=r"authoring guidance is missing: gesture\.md"):
        resources.audit_resources()


def test_resource_audit_rejects_a_missing_generation_example(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A frozen build that left out the deterministic author's clip fails its audit, naming the file."""

    from animama.app.generation import deterministic_author

    deterministic_author._example_text.cache_clear()
    monkeypatch.setattr(deterministic_author, "files", lambda package: tmp_path)
    try:
        with pytest.raises(FileNotFoundError, match=r"example Gesture is missing: generation-example-gesture\.json"):
            resources.audit_resources()
    finally:
        deterministic_author._example_text.cache_clear()


def test_resource_audit_rejects_a_generation_example_that_is_no_draft(monkeypatch: pytest.MonkeyPatch) -> None:
    """The packaged clip must still pass the validation every draft passes."""

    from animama.app.generation import deterministic_author

    monkeypatch.setattr(deterministic_author, "_example_text", lambda: '{"schema": "animaPoseClip/2.0"}')
    with pytest.raises(ValueError, match="Packaged example Gesture is not a valid draft"):
        resources.audit_resources()


def test_resource_audit_rejects_embeddings_without_pgvector(monkeypatch: pytest.MonkeyPatch) -> None:
    """A frozen build that lost pgvector fails its audit instead of every embedding write."""

    from sqlalchemy.dialects.postgresql import JSONB

    from animama.orm.user_file_chunk import ORMUserFileChunk

    monkeypatch.setattr(ORMUserFileChunk.__table__.c.embedding, "type", JSONB())
    with pytest.raises(ValueError, match="pgvector"):
        resources.audit_resources()


def test_sql_runtime_resource_contains_product_seeds_directly() -> None:
    seed_root = resources.runtime_resource("sql")
    assert seed_root == Path(__file__).resolve().parents[1] / "src/backend/migrations/seeds"
    assert sorted(path.name for path in seed_root.iterdir()) == [
        "01-seed-model-providers.sql",
        "02-seed-avatars.sql",
    ]


def test_frozen_resource_does_not_fall_back_to_the_checkout(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    with pytest.raises(FileNotFoundError, match="Required packaged resource"):
        resources.runtime_resource("sql")


def test_resource_names_cannot_select_arbitrary_checkout_files() -> None:
    with pytest.raises(ValueError, match="Unknown runtime resource"):
        resources.runtime_resource("../../.env")


@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.2", "example.com"])
def test_cli_cannot_publish_private_fastapi(host: str) -> None:
    with pytest.raises(SystemExit) as error:
        cli.main(["serve", "--host", host, "--port", "12345"])
    assert error.value.code == 2


def test_cli_never_accepts_credentials_as_arguments() -> None:
    with pytest.raises(SystemExit):
        cli.parser().parse_args(["database", "bootstrap", "--password", "not-a-real-secret"])


def test_cli_runs_no_separate_document_worker() -> None:
    """The server processes uploads itself; the only worker left is avatar upload cleanup."""

    assert cli.parser().parse_args(["worker", "avatar-cleanup"]).operation == "avatar-cleanup"
    with pytest.raises(SystemExit) as error:
        cli.parser().parse_args(["worker", "user-files"])
    assert error.value.code == 2


def test_pack_writer_emits_deterministic_ustar_and_rechecks_input_custody(tmp_path):
    writer = runpy.run_path(
        str(Path(__file__).resolve().parents[1] / "src/backend/packaging/desktop/archive_feature_pack.py")
    )["archive"]
    source = tmp_path / "source"
    source.mkdir()
    file = source / "fixture.json"
    file.write_bytes(b"{}")
    inventory = [{"path": file.name, "size_bytes": 2, "sha256": hashlib.sha256(b"{}").hexdigest(), "mode": "0644"}]
    first, second = tmp_path / "first.tar", tmp_path / "second.tar"
    writer(source, inventory, first)
    writer(source, inventory, second)
    assert first.read_bytes() == second.read_bytes()
    with tarfile.open(first) as archive:
        entries = archive.getmembers()
        assert len(entries) == 1
        assert entries[0].isfile() and entries[0].name == "fixture.json"
        assert entries[0].pax_headers == {}
        assert entries[0].mode == 0o644
        extracted = archive.extractfile(entries[0])
        assert extracted is not None
        assert extracted.read() == b"{}"
    file.write_bytes(b"[]")
    with pytest.raises(ValueError, match="digest mismatch"):
        writer(source, inventory, second)
    file.unlink()
    file.symlink_to(first)
    with pytest.raises(ValueError, match="escapes its root"):
        writer(source, inventory, second)


def test_bootstrap_preserves_sql_comments_and_literal_semicolons() -> None:
    from unittest.mock import Mock

    from animama.server import db_bootstrap

    cursor = Mock()
    sql = "-- One seed; this comment is not another command\nSELECT 'a;b'; SELECT 2;"
    db_bootstrap._exec_sql_statements(cursor, sql)
    cursor.execute.assert_called_once_with(sql, prepare=False)


def test_desktop_json_schemas_are_valid() -> None:
    from jsonschema import Draft202012Validator

    root = Path(__file__).resolve().parents[1] / "src/frontend/desktop/runtime"
    for name in ("desktop-runtime.schema.json", "feature-pack.schema.json"):
        Draft202012Validator.check_schema(json.loads((root / name).read_text()))


async def test_desktop_readiness_is_private_bounded_and_absent_from_openapi(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from types import SimpleNamespace

    from httpx import ASGITransport, AsyncClient

    from animama.server.app import create_local_app
    from animama.server.config import Settings

    token = "a" * 64
    monkeypatch.setenv("ANIMAMA_DESKTOP_BUILD_ID", "b" * 64)
    # A released app version differs from the API schema version (0.1.0).
    monkeypatch.setenv("ANIMAMA_DESKTOP_APP_VERSION", "0.1.1")
    monkeypatch.setenv("ANIMAMA_PROCESS_START_TOKEN", "11111111-1111-4111-8111-111111111111")
    app = create_local_app(
        runtime_settings=Settings(
            animama_public_origin="http://localhost:8000",
            animama_content_root=tmp_path / "content",
            animama_data_root=tmp_path / "data",
            animama_desktop_control_token=token,
            animama_desktop_renderer_capability="r" * 64,
        )
    )
    assert "/_desktop/health" not in app.openapi()["paths"]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://localhost:8000") as client:
        for headers in ({}, {"X-Animama-Desktop-Control": "wrong"}, {"X-Animama-Internal-Token": token}):
            response = await client.get("/_desktop/health", headers=headers)
            assert response.status_code == 404
            assert token not in response.text
        starting = await client.get("/_desktop/health", headers={"X-Animama-Desktop-Control": token})
        assert (starting.status_code, starting.json()) == (503, {"detail": "runtime_starting"})
        # Failed startup reconciliation is terminal for this process, so the
        # supervisor receives a specific code instead of waiting for its deadline.
        app.state.local_bootstrap_state = SimpleNamespace(principal_id="desktop-owner", content_ready=False)
        failed = await client.get("/_desktop/health", headers={"X-Animama-Desktop-Control": token})
        assert (failed.status_code, failed.json()) == (503, {"detail": {"code": "content_startup_failed"}})
        app.state.local_bootstrap_state.content_ready = True
        app.state.local_http_lifecycle.mark_ready("desktop-owner")
        ready = await client.get("/_desktop/health", headers={"X-Animama-Desktop-Control": token})
        assert ready.status_code == 200
        assert ready.json() == {
            "schema_version": 1,
            "runtime_version": "0.1.1",
            "build_id": "b" * 64,
            "alembic_head": ScriptDirectory.from_config(resources.alembic_config()).get_current_head(),
            "installation_principal_id": "desktop-owner",
            "local_http_schema_version": 1,
            "process_id": os.getpid(),
            "process_start_token": "11111111-1111-4111-8111-111111111111",
        }


async def test_avatar_cleanup_shutdown_wakes_an_idle_owned_worker() -> None:
    import asyncio

    from animama.workers.avatar_upload_cleanup import AvatarUploadCleanupWorker

    worker = AvatarUploadCleanupWorker(database_url="unused", interval_seconds=3600, batch_size=1)
    waiting = asyncio.create_task(worker._wait_for_next_cleanup())
    await worker.stop()
    await asyncio.wait_for(waiting, timeout=1)


def test_python_licence_notices_carry_every_declared_licence_file() -> None:
    """The upload parsers' notices reach the packaged inventory, including PDFium's bundled components.

    pypdfium2 declares PDFium's component licences as PEP 639 licence files
    under names such as ``freetype.txt``, openpyxl spells its file ``LICENCE``,
    and FreeType's notice is Latin-1 text.
    """

    licenses = runpy.run_path(
        str(Path(__file__).resolve().parents[1] / "src/backend/packaging/desktop/python_licenses.py")
    )["dependency_licenses"]()
    records = {str(record["name"]).lower().replace("_", "-"): record for record in licenses}

    for name in (
        "python-docx",
        "python-pptx",
        "openpyxl",
        "pypdfium2",
        "defusedxml",
        "lxml",
        "et-xmlfile",
        "xlsxwriter",
    ):
        assert records[name]["notices"], f"{name} has no packaged licence notice"
    pdfium = {Path(notice["path"]).name: notice["text"] for notice in records["pypdfium2"]["notices"]}
    assert {"Apache-2.0.txt", "BSD-3-Clause.txt", "pdfium.txt", "freetype.txt", "libpng.txt", "zlib.txt"} <= set(pdfium)
    assert "Portions of this software are copyright ©" in pdfium["freetype.txt"]
    assert {Path(notice["path"]).name for notice in records["openpyxl"]["notices"]} == {"LICENCE.rst"}

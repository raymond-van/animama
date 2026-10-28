"""Pose content exposes durable owner-scoped APIs, independent of browser state."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from sqlalchemy import delete

from animama.app.services.content_kind_registry import handler_for_kind
from animama.domain.content_catalog import ContentKind, ContentSource
from animama.domain.request_principal import RequestPrincipal
from animama.orm.content_catalog import ORMContentCatalogItem
from animama.product_http.routes import content, typed_content
from animama.server.app import app
from animama.server.deps import get_current_principal
from tests.content_package_helpers import package_services, reviewed_export, reviewed_import
from tests.local_http_client import local_client
from tests.product_http_support import install_local_ports


def test_poses_expose_the_normal_content_family_without_equipment_routes() -> None:
    paths = app.openapi()["paths"]
    assert "/v1/poses" in paths
    assert "get" in paths["/v1/poses"]
    assert "put" in paths["/v1/poses/{entry_name}"]
    assert "post" in paths["/v1/poses/{item_id}:preview"]
    response = paths["/v1/poses/{item_id}"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
    assert response["$ref"].endswith("/PyPose")
    assert not any(path.startswith("/v1/animas/") and "/poses" in path for path in paths)


def pose_document(*, weight: float = 0.5) -> dict[str, Any]:
    """A complete portable pose with independent body and expression values."""
    return {
        "schema_version": 1,
        "content_type": "pose",
        "content_id": "local:pose:salute",
        "name": "Salute",
        "pose": {
            "schema": "animaPose/1.0",
            "id": "local:pose:salute",
            "name": "Salute",
            "humanoid": {"hips": {"rotation": [0, 0, 0, 1], "position": [0, 0.1, 0]}},
            "expressions": {"happy": weight},
        },
    }


@pytest.fixture
async def pose_api(async_session, tmp_path: Path) -> AsyncIterator[tuple[Any, Any, dict[str, str]]]:  # noqa: ANN001
    paths, catalog, service, saves, packages = package_services(async_session, tmp_path)
    application = FastAPI()
    application.include_router(content.router)
    application.include_router(typed_content.router)
    application.state.local_runtime_paths = paths
    principal = {"id": "package-owner"}

    async def owner() -> RequestPrincipal:
        return RequestPrincipal(id=principal["id"])

    application.dependency_overrides[get_current_principal] = owner
    install_local_ports(application, async_session)
    try:
        async with local_client(application) as client:
            yield client, (paths, catalog, service, saves, packages), principal
    finally:
        await async_session.execute(delete(ORMContentCatalogItem))
        await async_session.commit()


async def test_pose_http_save_preview_reopen_and_owner_boundary(pose_api) -> None:  # noqa: ANN001
    client, (paths, _catalog, _service, _saves, _packages), principal = pose_api
    form = {"operation_id": "create-salute", "descriptor_json": json.dumps(pose_document())}
    saved = await client.put("/v1/poses/Salute", data=form)
    assert saved.status_code == 200, saved.text
    item = saved.json()
    assert item["kind"] == "pose" and item["editable"] is True
    assert item["dependencies"] == []
    item_id = item["item_id"]
    listed = await client.get("/v1/poses")
    assert any(row["item_id"] == item_id for row in listed.json()["items"])
    reopened = await client.get(f"/v1/poses/{item_id}")
    assert reopened.json() == item
    files = list((paths.local_root / "poses").rglob("*.json"))
    assert len(files) == 1
    stored = json.loads(files[0].read_text())
    assert stored["pose"]["expressions"] == {"happy": 0.5}

    prepared = await client.post(f"/v1/poses/{item_id}:preview")
    assert prepared.status_code == 200, prepared.text
    preview = prepared.json()
    assert preview["item"]["kind"] == "pose"
    registered = await client.get(preview["files"][0]["url"])
    assert registered.status_code == 200
    assert registered.json()["pose"] == stored["pose"]

    principal["id"] = "other-owner"
    assert (await client.get(f"/v1/poses/{item_id}")).status_code == 404
    assert (await client.get(preview["files"][0]["url"])).status_code == 404


async def test_pose_save_conflict_retry_and_invalid_update_preserve_saved_values(pose_api) -> None:  # noqa: ANN001
    client, (paths, _catalog, _service, _saves, _packages), _principal = pose_api
    initial_form = {"operation_id": "create", "descriptor_json": json.dumps(pose_document())}
    first = await client.put("/v1/poses/Salute", data=initial_form)
    assert first.status_code == 200, first.text
    item = first.json()
    edit_form = {
        "operation_id": "edit",
        "catalog_item_id": item["item_id"],
        "expected_revision": item["revision_sha256"],
        "descriptor_json": json.dumps(pose_document(weight=0.8)),
    }
    edited = await client.put("/v1/poses/Salute", data=edit_form)
    assert edited.status_code == 200, edited.text
    current = edited.json()
    assert current["item_id"] == item["item_id"]
    assert current["revision_sha256"] != item["revision_sha256"]
    replay = await client.put("/v1/poses/Salute", data=edit_form)
    assert replay.status_code == 200 and replay.json() == current
    stale = await client.put("/v1/poses/Salute", data={**edit_form, "operation_id": "stale"})
    assert stale.status_code == 409, stale.text
    invalid = await client.put(
        "/v1/poses/Salute",
        data={
            **edit_form,
            "operation_id": "invalid",
            "expected_revision": current["revision_sha256"],
            "descriptor_json": json.dumps(pose_document(weight=2)),
        },
    )
    assert invalid.status_code == 422, invalid.text
    assert (await client.get(f"/v1/poses/{item['item_id']}")).json() == current
    assert json.loads(next((paths.local_root / "poses").rglob("*.json")).read_text())["pose"]["expressions"] == {
        "happy": 0.8
    }
    # A response-lost create still replays its original receipt after a later edit.
    original_replay = await client.put("/v1/poses/Salute", data=initial_form)
    assert original_replay.status_code == 200 and original_replay.json() == item


async def test_pose_package_copy_rewrites_identity_and_remains_independent(pose_api) -> None:  # noqa: ANN001
    _client, (paths, catalog, service, saves, packages), _principal = pose_api
    saved = await saves.save_descriptor(
        user_id="package-owner",
        kind=ContentKind("pose"),
        entry_name="Salute",
        descriptor=json.dumps(pose_document()).encode(),
        companion_files={},
        operation_id="save-for-export",
        catalog_item_id=None,
        expected_revision=None,
    )
    exported = await reviewed_export(
        packages,
        user_id="package-owner",
        root_item_id=saved.item.id,
    )
    command = await reviewed_import(
        packages, user_id="package-owner", archive_path=exported.path, operation_id="import-copy"
    )
    imported = await packages.imports.commit(**command)
    assert len(imported.items) == 1
    copy = await catalog.get_visible_item(item_id=imported.items[0].item_id, user_id="package-owner")
    assert copy is not None
    assert copy.id != saved.item.id and copy.logical_key != saved.item.logical_key
    copied_file = next((paths.local_root / copy.relative_locator).glob("*.json"))
    document = json.loads(copied_file.read_text())
    assert document["content_id"] == document["pose"]["id"] == copy.logical_key
    assert document["name"] == document["pose"]["name"]
    assert document["pose"]["humanoid"] == pose_document()["pose"]["humanoid"]
    assert document["pose"]["expressions"] == {"happy": 0.5}
    assert not copy.dependencies
    await service.delete_item(
        item_id=saved.item.id,
        user_id="package-owner",
        expected_revision=saved.item.revision_sha256,
    )
    rescanned = await service.rescan(user_id="package-owner", include_included=False)
    assert any(row.id == copy.id and row.source is ContentSource.LOCAL for row in rescanned.items)
    assert copied_file.exists()


async def test_included_pose_is_read_only_and_manual_local_edits_report_health(pose_api) -> None:  # noqa: ANN001
    client, (paths, _catalog, service, _saves, _packages), _principal = pose_api
    root = paths.included_root / "poses" / "salute"
    root.mkdir(parents=True)
    document = pose_document()
    document["content_id"] = document["pose"]["id"] = "included-salute"
    (root / "salute.json").write_text(json.dumps(document))
    (paths.included_licenses_root / "inventory.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "rules": [
                    {
                        "glob": "poses/**",
                        "creator": "Test suite",
                        "provenance": "Original test data",
                        "license_id": "fixture-only",
                    }
                ],
            }
        )
    )
    scan = await service.rescan(user_id="package-owner")
    starter = next(row for row in scan.items if row.source is ContentSource.INCLUDED)
    assert starter.status.value == "valid", starter.diagnostics
    response = await client.get(f"/v1/poses/{starter.id}")
    assert response.status_code == 200 and response.json()["editable"] is False
    denied = await client.put(
        "/v1/poses/Salute",
        data={
            "operation_id": "overwrite-starter",
            "catalog_item_id": starter.id,
            "expected_revision": starter.revision_sha256,
            "descriptor_json": json.dumps(document),
        },
    )
    assert denied.status_code == 404, denied.text
    assert json.loads((root / "salute.json").read_text()) == document

    local = paths.local_root / "poses" / "manual"
    local.mkdir(parents=True)
    source = local / "manual.json"
    source.write_text(json.dumps(pose_document()))
    scan = await service.rescan(user_id="package-owner", include_included=False)
    item = next(row for row in scan.items if row.source is ContentSource.LOCAL)
    assert item.status.value == "valid", item.diagnostics
    source.write_text('{"broken": true}')
    scan = await service.rescan(user_id="package-owner", include_included=False)
    invalid = next(row for row in scan.items if row.id == item.id)
    assert invalid.status.value == "invalid" and invalid.diagnostics
    assert (await client.post(f"/v1/poses/{item.id}:preview")).status_code == 404
    source.unlink()
    scan = await service.rescan(user_id="package-owner", include_included=False)
    missing = next(row for row in scan.items if row.id == item.id)
    assert missing.status.value == "missing"


def test_resolved_pose_fixture_matches_frontend_values() -> None:
    """Both language boundaries consume exactly this portable resolved payload."""
    fixture = (
        Path(__file__).resolve().parents[1]
        / "src/frontend/web/src/lib/avatar/poses/fixtures/content-compatibility-valid.json"
    )
    document = json.loads(fixture.read_text())
    admitted = handler_for_kind(ContentKind.POSE).parse_document(
        document,
        fallback_path=Path("poses/relaxed-rest"),
        descriptor_backed=True,
    )
    assert admitted.metadata["pose"] == document["pose"]


async def test_rescan_retires_removed_included_pose_starters_from_typed_listing(pose_api) -> None:  # noqa: ANN001
    """An existing 27-item index narrows to five usable starters without stale Library rows."""
    import shutil

    client, (paths, _catalog, service, _saves, _packages), _principal = pose_api
    fixture = (
        Path(__file__).parents[1]
        / "src/frontend/web/src/lib/avatar/poses/fixtures/starter-inventory-before-content.json"
    )
    original = json.loads(fixture.read_text())["poses"]
    kept = {
        "relaxedRest",
        "shy-finger-poke-1",
        "shy-finger-poke-2",
        "thinking-head-scratch-1",
        "thinking-head-scratch-2",
    }
    (paths.included_licenses_root / "inventory.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "rules": [
                    {
                        "glob": "poses/**",
                        "creator": "Test suite",
                        "provenance": "Original test data",
                        "license_id": "fixture-only",
                    }
                ],
            }
        )
    )
    for entry in original:
        pose_id = entry["id"]
        root = paths.included_root / "poses" / pose_id
        root.mkdir(parents=True)
        document = pose_document()
        document["content_id"] = document["pose"]["id"] = pose_id
        document["name"] = document["pose"]["name"] = entry["name"]
        (root / f"{pose_id}.json").write_text(json.dumps(document))
    await service.rescan(user_id="package-owner")
    before = (await client.get("/v1/poses")).json()["items"]
    assert len(before) == 27
    retired_ids = {entry["item_id"] for entry in before if entry["pose_id"] not in kept}
    for entry in original:
        if entry["id"] not in kept:
            shutil.rmtree(paths.included_root / "poses" / entry["id"])
    scan = await service.rescan(user_id="package-owner")
    assert not retired_ids.intersection(entry.id for entry in scan.items if entry.status.value == "valid")
    after = (await client.get("/v1/poses")).json()["items"]
    assert {entry["pose_id"] for entry in after} == kept
    assert all(entry["source"] == "included" for entry in after)
    assert (await client.get(f"/v1/poses/{sorted(retired_ids)[0]}")).status_code == 404


async def test_catalog_responses_report_non_portable_included_content(pose_api) -> None:  # noqa: ANN001
    client, (paths, _catalog, service, _saves, _packages), _principal = pose_api
    root = paths.included_root / "poses" / "salute"
    root.mkdir(parents=True)
    document = pose_document()
    document["content_id"] = document["pose"]["id"] = "included-salute"
    # A descriptor cannot lift the restriction that its Included rule sets.
    document["provenance"] = {"distribution": "portable"}
    (root / "salute.json").write_text(json.dumps(document))
    (paths.included_licenses_root / "inventory.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "rules": [
                    {
                        "glob": "poses/**",
                        "creator": "Test suite",
                        "provenance": "Original test data",
                        "license_id": "fixture-only",
                        "distribution": "non-portable",
                    }
                ],
            }
        )
    )
    saved = await client.put(
        "/v1/poses/Owned", data={"operation_id": "create-owned", "descriptor_json": json.dumps(pose_document())}
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["portability"] == "portable"
    await service.rescan(user_id="package-owner")

    typed_items = (await client.get("/v1/poses")).json()["items"]
    typed = {row["source"]: row["portability"] for row in typed_items}
    assert typed == {"included": "non-portable", "local": "portable"}
    # Typed lists name an Included file by its digest URL and an owner's file by its registration.
    for row in typed_items:
        for file in row["files"]:
            digest = f"/sha256/{file['sha256']}" if row["source"] == "included" else ""
            assert file["url"] == f"/v1/content/files/{file['file_ref']}{digest}"
    listed = (await client.get("/v1/content/catalog")).json()["items"]
    assert {row["source"]: row["portability"] for row in listed if row["kind"] == "pose"} == typed
    # Playback bytes stay readable but are never offered as a download (R6).
    included = next(row for row in listed if row["kind"] == "pose" and row["source"] == "included")
    served = await client.get(included["files"][0]["url"])
    assert served.status_code == 200
    assert served.headers["cache-control"] == "private, max-age=31536000, immutable"
    assert "content-disposition" not in served.headers

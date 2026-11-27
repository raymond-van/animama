from __future__ import annotations

import json
import struct
from pathlib import Path

import pytest
from fastapi import FastAPI
from sqlalchemy import delete

from animama.adapters.content_store import FilesystemContentStore
from animama.adapters.repositories.sqlalchemy.content_catalog_repo import SQLAlchemyContentCatalog
from animama.app.services.content_catalog_service import ContentCatalogService
from animama.app.services.content_save_service import ContentSaveService
from animama.app.services.typed_content_service import TypedContentService
from animama.domain.content_catalog import ContentConflictError, ContentKind
from animama.domain.request_principal import RequestPrincipal
from animama.orm.content_catalog import ORMAnimaContentBinding, ORMContentCatalogItem
from animama.product_http.routes.content import router
from animama.product_http.routes.typed_content import router as typed_content_router
from animama.server.config import Settings
from animama.server.deps import get_current_principal
from animama.server.local_runtime import initialize_local_runtime
from animama.server.schemas.typed_content import PyReaction, typed_content_response
from tests.local_http_client import local_client
from tests.product_http_support import install_local_ports
from tests.typed_loadout_support import cleanup_loadout_fixture, create_loadout_fixture


def _glb(label: str) -> bytes:
    document = json.dumps(
        {
            "asset": {"version": "2.0"},
            "extensions": {"VRMC_vrm_animation": {"specVersion": "1.0"}},
            "extras": {"label": label},
        },
        separators=(",", ":"),
    ).encode()
    document += b" " * (-len(document) % 4)
    return (
        struct.pack("<4sII", b"glTF", 2, 20 + len(document)) + struct.pack("<II", len(document), 0x4E4F534A) + document
    )


def _services(async_session, tmp_path: Path):
    paths = initialize_local_runtime(
        Settings(
            animama_content_root=tmp_path / "content",
            animama_data_root=tmp_path / "data",
        )
    )
    store = FilesystemContentStore(
        included_root=paths.included_root,
        local_root=paths.local_root,
        operations_root=paths.operations_root,
    )
    catalog = SQLAlchemyContentCatalog(async_session)
    content = ContentCatalogService(
        store=store,
        catalog=catalog,
    )
    return ContentSaveService(content=content), paths


async def test_direct_standalone_save_edits_one_readable_file_under_a_revision_fence(
    async_session, tmp_path: Path
) -> None:
    service, paths = _services(async_session, tmp_path)
    try:
        created = await service.save_standalone(
            user_id="owner-a",
            kind=ContentKind.GESTURE,
            entry_name="Friendly Wave",
            filename="source.vrma",
            payload=_glb("first"),
            metadata_sidecar=None,
            operation_id="save-wave-1",
            catalog_item_id=None,
            expected_revision=None,
        )
        destination = paths.local_root / "gestures/friendly-wave.vrma"
        assert destination.read_bytes() == _glb("first")
        assert created.item.owner_user_id == "owner-a"

        updated = await service.save_standalone(
            user_id="owner-a",
            kind=ContentKind.GESTURE,
            entry_name="ignored-on-edit",
            filename="replacement.vrma",
            payload=_glb("second"),
            metadata_sidecar=None,
            operation_id="save-wave-2",
            catalog_item_id=created.item.id,
            expected_revision=created.item.revision_sha256,
        )
        assert updated.item.id == created.item.id
        assert updated.item.revision_sha256 != created.item.revision_sha256
        assert destination.read_bytes() == _glb("second")

        with pytest.raises(ContentConflictError, match="catalog_revision_conflict"):
            await service.save_standalone(
                user_id="owner-a",
                kind=ContentKind.GESTURE,
                entry_name="ignored-on-edit",
                filename="replacement.vrma",
                payload=_glb("stale"),
                metadata_sidecar=None,
                operation_id="save-wave-stale",
                catalog_item_id=created.item.id,
                expected_revision=created.item.revision_sha256,
            )
        assert destination.read_bytes() == _glb("second")
    finally:
        await async_session.execute(delete(ORMContentCatalogItem))
        await async_session.commit()


@pytest.mark.parametrize("with_hint", [False, True])
async def test_direct_descriptor_save_uses_entry_name_and_removes_stale_companions(
    async_session, tmp_path: Path, with_hint: bool
) -> None:
    service, paths = _services(async_session, tmp_path)
    first_descriptor = json.dumps(
        {
            "schema_version": 1,
            "content_type": "reaction",
            "id": "local:reaction:happy",
            "name": "Happy",
            **({"placement_hint": {"emotion": "joy", "intensity": 2}} if with_hint else {}),
            "implementation": {"kind": "vrma", "file_role": "animation"},
            "files": [
                {"path": "smile.vrma", "role": "animation"},
                {"path": "sparkle.json", "role": "sequence"},
            ],
            "dependencies": [],
        }
    ).encode()
    second_descriptor = json.dumps(
        {
            "schema_version": 1,
            "content_type": "reaction",
            "id": "local:reaction:happy",
            "name": "Happy",
            **({"placement_hint": {"emotion": "joy", "intensity": 2}} if with_hint else {}),
            "implementation": {"kind": "vrma", "file_role": "animation"},
            "files": [{"path": "smile.vrma", "role": "animation"}],
            "dependencies": [],
        }
    ).encode()
    try:
        created = await service.save_descriptor(
            user_id="owner-a",
            kind=ContentKind.REACTION,
            entry_name="Happy",
            descriptor=first_descriptor,
            companion_files={"smile.vrma": _glb("smile"), "sparkle.json": b'{"schema_version":1}'},
            operation_id="save-happy-1",
            catalog_item_id=None,
            expected_revision=None,
        )
        response = typed_content_response(TypedContentService.parse(created.item))
        assert isinstance(response, PyReaction)
        assert response.emotion == ("joy" if with_hint else None)
        assert response.intensity == (2 if with_hint else None)
        root = paths.local_root / "reactions/happy"
        assert (root / "happy.meta.json").is_file()
        assert (root / "sparkle.json").is_file()

        updated = await service.save_descriptor(
            user_id="owner-a",
            kind=ContentKind.REACTION,
            entry_name="ignored-on-edit",
            descriptor=second_descriptor,
            companion_files={"smile.vrma": _glb("new-smile")},
            operation_id="save-happy-2",
            catalog_item_id=created.item.id,
            expected_revision=created.item.revision_sha256,
        )
        assert updated.item.id == created.item.id
        assert not (root / "sparkle.json").exists()
        assert (root / "smile.vrma").read_bytes() == _glb("new-smile")
    finally:
        await async_session.execute(delete(ORMContentCatalogItem))
        await async_session.commit()


async def test_direct_save_http_route_streams_into_the_readable_local_library(async_session, tmp_path: Path) -> None:
    paths = initialize_local_runtime(
        Settings(
            animama_content_root=tmp_path / "content",
            animama_data_root=tmp_path / "data",
        )
    )
    app = FastAPI()
    app.include_router(router)
    app.include_router(typed_content_router)
    app.state.local_runtime_paths = paths

    async def override_user() -> RequestPrincipal:
        return RequestPrincipal(id="owner-http")

    app.dependency_overrides[get_current_principal] = override_user
    install_local_ports(app, async_session)
    client = local_client(app)
    try:
        created = await client.put(
            "/v1/gestures/Friendly%20Wave",
            data={"operation_id": "http-save-wave-1"},
            files={"files": ("wave.vrma", _glb("http"), "model/gltf-binary")},
        )
        assert created.status_code == 200, created.text
        body = created.json()
        assert body["kind"] == "gesture"
        assert body["semantic_key"] == "friendly-wave"
        assert (paths.local_root / "gestures/friendly-wave.vrma").read_bytes() == _glb("http")

        duplicate = await client.put(
            "/v1/gestures/Friendly%20Wave",
            data={"operation_id": "http-save-wave-duplicate"},
            files={"files": ("wave.vrma", _glb("duplicate"), "model/gltf-binary")},
        )
        assert duplicate.status_code == 409, duplicate.text
        assert duplicate.json()["detail"] == {
            "code": "content_path_exists",
            "field": "name",
        }

        empty = await client.put(
            "/v1/gestures/Empty%20Wave",
            data={"operation_id": "http-save-wave-empty"},
            files={"files": ("wave.vrma", b"", "model/gltf-binary")},
        )
        assert empty.status_code == 422, empty.text
        assert empty.json()["detail"] == {
            "code": "content_file_empty",
            "field": "files",
        }

        updated = await client.put(
            "/v1/gestures/ignored-on-edit",
            data={
                "operation_id": "http-save-wave-2",
                "catalog_item_id": body["item_id"],
                "expected_revision": body["revision_sha256"],
            },
            files={"files": ("wave.vrma", _glb("http-edit"), "model/gltf-binary")},
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["item_id"] == body["item_id"]
        assert (paths.local_root / "gestures/friendly-wave.vrma").read_bytes() == _glb("http-edit")

        removed = await client.delete(
            f"/v1/content/items/{body['item_id']}",
            params={"expected_revision": updated.json()["revision_sha256"]},
        )
        assert removed.status_code == 204, removed.text
        assert not (paths.local_root / "gestures/friendly-wave.vrma").exists()
        assert (await client.get(f"/v1/content/items/{body['item_id']}")).status_code == 404
        catalog = await client.get("/v1/content/catalog")
        assert catalog.status_code == 200, catalog.text
        assert body["item_id"] not in {item["item_id"] for item in catalog.json()["items"]}
    finally:
        await client.aclose()
        await async_session.execute(delete(ORMContentCatalogItem))
        await async_session.commit()


async def test_explicit_delete_rejects_a_loadout_binding_before_touching_files(async_session, tmp_path: Path) -> None:
    """An exact revision does not authorize breaking another persisted reference."""

    fixture = await create_loadout_fixture(async_session)
    saves, paths = _services(async_session, tmp_path)
    catalog = SQLAlchemyContentCatalog(async_session)
    content = ContentCatalogService(
        store=FilesystemContentStore(
            included_root=paths.included_root,
            local_root=paths.local_root,
            operations_root=paths.operations_root,
        ),
        catalog=catalog,
    )
    try:
        saved = await saves.save_standalone(
            user_id=fixture.user_id,
            kind=ContentKind.GESTURE,
            entry_name="Bound Wave",
            filename="wave.vrma",
            payload=_glb("bound"),
            metadata_sidecar=None,
            operation_id="save-bound-wave",
            catalog_item_id=None,
            expected_revision=None,
        )
        assert await catalog.item_usage(item_id=saved.item.id) == ()
        async_session.add(
            ORMAnimaContentBinding(
                id=f"binding-{fixture.suffix}",
                anima_id=fixture.anima_id,
                slot_key="gesture:bound-wave",
                catalog_item_id=saved.item.id,
                kind="gesture",
                config={},
            )
        )
        await async_session.commit()

        assert saved.item.revision_sha256 is not None
        with pytest.raises(ContentConflictError, match="catalog_item_in_use"):
            await content.delete_item(
                item_id=saved.item.id,
                user_id=fixture.user_id,
                expected_revision=saved.item.revision_sha256,
            )
        assert (paths.local_root / "gestures/bound-wave.vrma").read_bytes() == _glb("bound")
        assert await catalog.get_visible_item(item_id=saved.item.id, user_id=fixture.user_id) is not None
    finally:
        await cleanup_loadout_fixture(async_session, fixture)

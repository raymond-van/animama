from __future__ import annotations

import json
import struct
from pathlib import Path

from fastapi import FastAPI
from sqlalchemy import delete

from animama.adapters.content_store import FilesystemContentStore
from animama.adapters.repositories.sqlalchemy.content_catalog_repo import SQLAlchemyContentCatalog
from animama.app.services.content_catalog_service import ContentCatalogService
from animama.domain.request_principal import RequestPrincipal
from animama.orm.content_catalog import ORMContentCatalogItem
from animama.product_http.routes.content import router
from animama.server.config import Settings
from animama.server.deps import get_current_principal
from animama.server.local_runtime import initialize_local_runtime
from tests.local_http_client import local_client
from tests.product_http_support import install_local_ports


def _glb() -> bytes:
    document = json.dumps(
        {
            "asset": {"version": "2.0"},
            "extensions": {"VRMC_vrm_animation": {"specVersion": "1.0"}},
        },
        separators=(",", ":"),
    ).encode()
    document += b" " * (-len(document) % 4)
    return (
        struct.pack("<4sII", b"glTF", 2, 20 + len(document)) + struct.pack("<II", len(document), 0x4E4F534A) + document
    )


async def test_registered_delivery_authorizes_then_verifies_etag_and_bytes(async_session, tmp_path: Path) -> None:  # noqa: ANN001
    paths = initialize_local_runtime(
        Settings(animama_content_root=tmp_path / "content", animama_data_root=tmp_path / "data")
    )
    wave = paths.local_root / "gestures/wave.vrma"
    wave.write_bytes(_glb())
    service = ContentCatalogService(
        store=FilesystemContentStore(
            included_root=paths.included_root,
            local_root=paths.local_root,
            operations_root=paths.operations_root,
        ),
        catalog=SQLAlchemyContentCatalog(async_session),
    )
    result = await service.rescan(user_id="owner-a", include_included=False)
    item = next(entry for entry in result.items if entry.relative_locator == "gestures/wave.vrma")
    file_ref = item.files[0].file_ref

    app = FastAPI()
    app.include_router(router)
    app.state.local_runtime_paths = paths
    current_user = {"id": "owner-a"}

    async def override_user() -> RequestPrincipal:
        return RequestPrincipal(id=current_user["id"])

    app.dependency_overrides[get_current_principal] = override_user
    install_local_ports(app, async_session)
    client = local_client(app)
    try:
        response = await client.get(f"/v1/content/files/{file_ref}")
        assert response.status_code == 200
        assert response.content == _glb()
        assert response.headers["etag"] == f'"{item.files[0].sha256}"'
        # A file named by its registration alone is revalidated; only an Included digest URL is kept (ADR 0033).
        assert response.headers["cache-control"] == "private, no-cache"

        conditional = await client.get(
            f"/v1/content/files/{file_ref}", headers={"If-None-Match": response.headers["etag"]}
        )
        assert conditional.status_code == 304
        assert conditional.content == b""

        guessed = await client.get("/v1/content/files/00000000-0000-0000-0000-000000000000")
        assert guessed.status_code == 404

        current_user["id"] = "owner-b"
        hidden = await client.get(
            f"/v1/content/files/{file_ref}",
            headers={"If-None-Match": response.headers["etag"]},
        )
        assert hidden.status_code == 404

        current_user["id"] = "owner-a"
        wave.write_bytes(b"glTFchanged")
        changed = await client.get(f"/v1/content/files/{file_ref}")
        assert changed.status_code == 409
        assert changed.json()["detail"]["code"] == "content_file_changed_rescan_required"
    finally:
        await client.aclose()
        await async_session.execute(delete(ORMContentCatalogItem).where(ORMContentCatalogItem.id == item.id))
        await async_session.commit()

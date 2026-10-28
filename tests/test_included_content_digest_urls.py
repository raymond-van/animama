"""Included content files are named by digest URLs that a browser keeps as immutable (#763, ADR 0033)."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from animama.adapters.repositories.sqlalchemy.content_catalog_repo import SQLAlchemyContentCatalog
from animama.app.services.content_catalog_service import ContentCatalogService
from animama.domain.request_principal import RequestPrincipal
from animama.orm.content_catalog import ORMContentCatalogItem
from animama.product_http.routes.content import router
from animama.server.config import Settings
from animama.server.deps import get_current_principal
from animama.server.local_runtime import LocalRuntimePaths, initialize_local_runtime, local_content_store
from tests.local_http_client import local_client
from tests.product_http_support import install_local_ports

IMMUTABLE = "private, max-age=31536000, immutable"
OWNER = "owner-a"


def _png(color: tuple[int, int, int, int]) -> bytes:
    output = BytesIO()
    Image.new("RGBA", (900, 600), color).save(output, format="PNG")
    return output.getvalue()


@asynccontextmanager
async def _library(
    async_session: AsyncSession, tmp_path: Path
) -> AsyncIterator[tuple[LocalRuntimePaths, AsyncClient, ContentCatalogService]]:
    """A runtime with an Included and a Local image, served by the shared content routes."""

    paths = initialize_local_runtime(
        Settings(animama_content_root=tmp_path / "content", animama_data_root=tmp_path / "data")
    )
    for root in (paths.included_root, paths.local_root):
        (root / "appearances").mkdir(parents=True, exist_ok=True)
    (paths.included_root / "appearances/shipped.png").write_bytes(_png((200, 40, 90, 255)))
    (paths.local_root / "appearances/mine.png").write_bytes(_png((10, 120, 30, 255)))
    # Included entries are admitted only with a license inventory record.
    (paths.included_licenses_root / "inventory.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "rules": [
                    {
                        "glob": "appearances/**",
                        "creator": "Test suite",
                        "provenance": "Original test data",
                        "license_id": "fixture-only",
                    }
                ],
            }
        )
    )
    service = ContentCatalogService(store=local_content_store(paths), catalog=SQLAlchemyContentCatalog(async_session))
    scanned = await service.rescan(user_id=OWNER)

    app = FastAPI()
    app.include_router(router)
    app.state.local_runtime_paths = paths

    async def override_user() -> RequestPrincipal:
        return RequestPrincipal(id=OWNER)

    app.dependency_overrides[get_current_principal] = override_user
    install_local_ports(app, async_session)
    client = local_client(app)
    try:
        yield paths, client, service
    finally:
        await client.aclose()
        item_ids = {item.id for item in scanned.items}
        await async_session.execute(delete(ORMContentCatalogItem).where(ORMContentCatalogItem.id.in_(item_ids)))
        await async_session.commit()


async def _catalog_file(client: AsyncClient, locator: str) -> dict[str, Any]:
    catalog = await client.get("/v1/content/catalog")
    assert catalog.status_code == 200, catalog.text
    (item,) = [item for item in catalog.json()["items"] if item["relative_locator"] == locator]
    files: list[dict[str, Any]] = item["files"]
    (file,) = files
    return file


async def test_a_release_that_changes_an_included_files_bytes_changes_its_url(
    async_session: AsyncSession, tmp_path: Path
) -> None:
    async with _library(async_session, tmp_path) as (paths, client, service):
        first = await _catalog_file(client, "appearances/shipped.png")
        assert first["url"] == f"/v1/content/files/{first['file_ref']}/sha256/{first['sha256']}"

        kept = await client.get(first["url"])
        assert kept.status_code == 200
        assert kept.content == (paths.included_root / "appearances/shipped.png").read_bytes()
        assert kept.headers["cache-control"] == IMMUTABLE
        assert kept.headers["etag"] == f'"{first["sha256"]}"'
        # A Library thumbnail of the exact source digest is kept as immutable too.
        thumbnail = await client.get(first["url"], params={"variant": "thumbnail"})
        assert thumbnail.status_code == 200
        assert thumbnail.headers["content-type"] == "image/webp"
        assert thumbnail.headers["cache-control"] == IMMUTABLE

        # A release ships other bytes at the same path; reconciliation keeps the file_ref.
        (paths.included_root / "appearances/shipped.png").write_bytes(_png((0, 0, 255, 255)))
        await service.rescan(user_id=OWNER)
        second = await _catalog_file(client, "appearances/shipped.png")
        assert second["file_ref"] == first["file_ref"]
        assert second["sha256"] != first["sha256"]
        assert second["url"] == f"/v1/content/files/{second['file_ref']}/sha256/{second['sha256']}"

        # The old URL never answers with the new bytes, as a file or as a thumbnail.
        for params in ({}, {"variant": "thumbnail"}):
            stale = await client.get(first["url"], params=params)
            assert stale.status_code == 404
            assert stale.json()["detail"]["code"] == "content_file_not_found"
            assert "etag" not in stale.headers
            assert stale.headers.get("cache-control") != IMMUTABLE

        fresh = await client.get(second["url"])
        assert fresh.status_code == 200
        assert fresh.content == (paths.included_root / "appearances/shipped.png").read_bytes()
        assert fresh.headers["cache-control"] == IMMUTABLE


async def test_an_owners_file_keeps_its_url_and_policy(async_session: AsyncSession, tmp_path: Path) -> None:
    async with _library(async_session, tmp_path) as (_paths, client, _service):
        mine = await _catalog_file(client, "appearances/mine.png")
        assert mine["url"] == f"/v1/content/files/{mine['file_ref']}"

        served = await client.get(mine["url"])
        assert served.status_code == 200
        assert served.headers["cache-control"] == "private, no-cache"
        revalidated = await client.get(mine["url"], headers={"If-None-Match": served.headers["etag"]})
        assert revalidated.status_code == 304

        # Only Included files have a digest URL, even when the digest is right.
        digest_path = await client.get(f"/v1/content/files/{mine['file_ref']}/sha256/{mine['sha256']}")
        assert digest_path.status_code == 404
        assert digest_path.json()["detail"]["code"] == "content_file_not_found"


async def test_an_included_file_keeps_its_revalidated_url_and_rejects_a_malformed_digest(
    async_session: AsyncSession, tmp_path: Path
) -> None:
    async with _library(async_session, tmp_path) as (_paths, client, _service):
        shipped = await _catalog_file(client, "appearances/shipped.png")

        # Clients that still name the file_ref alone keep today's revalidated reply.
        plain = await client.get(f"/v1/content/files/{shipped['file_ref']}")
        assert plain.status_code == 200
        assert plain.headers["cache-control"] == "private, no-cache"

        guessed = await client.get(f"/v1/content/files/{shipped['file_ref']}/sha256/{'0' * 64}")
        assert guessed.status_code == 404
        malformed = await client.get(f"/v1/content/files/{shipped['file_ref']}/sha256/not-a-digest")
        assert malformed.status_code == 422

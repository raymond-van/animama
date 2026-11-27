"""Shared content routes isolate owners and commit through the composition (ADR 0021)."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from animama.domain.content_catalog import ContentKind, SavedContent
from animama.domain.request_principal import RequestPrincipal
from animama.orm.content_catalog import ORMContentCatalogItem
from animama.product_http.routes import content
from tests.content_package_helpers import vrma
from tests.product_http_support import DeferredCommitPorts, TwoOwnerComposition, product_app


async def save_gesture(ports: DeferredCommitPorts, owner: str, name: str) -> SavedContent:
    """Save one Gesture through ``owner``'s own content services, outside HTTP."""

    async with ports.session_factory() as session:
        async with ports.content(session, RequestPrincipal(id=owner)) as owned:
            saved = await owned.saves.save_standalone(
                user_id=owner,
                kind=ContentKind.GESTURE,
                entry_name=name,
                filename="wave.vrma",
                payload=vrma(name),
                metadata_sidecar=json.dumps({"schema_version": 1, "name": name}).encode(),
                operation_id=f"save-{uuid4().hex}",
                catalog_item_id=None,
                expected_revision=None,
            )
        await session.commit()
    return saved


async def test_an_owner_never_reaches_another_owners_content(
    async_session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    ports = DeferredCommitPorts(async_session_factory, content_root=tmp_path)
    owner_a, owner_b = f"owner-a-{uuid4().hex[:8]}", f"owner-b-{uuid4().hex[:8]}"
    composition = TwoOwnerComposition(product_app(content.router, ports=ports), tmp_path, owners=(owner_a, owner_b))
    try:
        saved = await save_gesture(ports, owner_a, "Wave A")
        item = saved.item
        # The Gesture's payload, not its metadata sidecar.
        file_ref = next(file.file_ref for file in item.files if file.relative_path.endswith(".vrma"))
        async with ports.session_factory() as session:
            async with ports.content(session, RequestPrincipal(id=owner_a)) as owned:
                preview = await owned.catalog.issue_preview_bundle(anchor=item, entries=(item,), user_id=owner_a)
            await session.commit()
        preview_ref = next(file.file_ref for file in preview.files if file.relative_path.endswith(".vrma"))
        preview_file = f"/v1/content/previews/{preview.id}/revisions/{preview.revision_sha256}/files/{preview_ref}"
        commits_before = ports.commits

        async with composition.client(owner_b) as b:
            assert item.id not in {entry["item_id"] for entry in (await b.get("/v1/content/catalog")).json()["items"]}
            assert (await b.get(f"/v1/content/items/{item.id}")).status_code == 404
            assert (await b.get(f"/v1/content/items/{item.id}/usage")).status_code == 404
            refused = await b.delete(f"/v1/content/items/{item.id}", params={"expected_revision": item.revision_sha256})
            assert refused.status_code == 404
            file = await b.get(f"/v1/content/files/{file_ref}")
            assert (file.status_code, file.json()) == (404, {"detail": {"code": "content_file_not_found"}})
            denied = await b.get(preview_file)
            assert (denied.status_code, denied.json()) == (404, {"detail": {"code": "content_preview_not_found"}})
        assert ports.commits == commits_before

        async with composition.client(owner_a) as a:
            assert item.id in {entry["item_id"] for entry in (await a.get("/v1/content/catalog")).json()["items"]}
            assert (await a.get(f"/v1/content/items/{item.id}")).json()["item_id"] == item.id
            usage = await a.get(f"/v1/content/items/{item.id}/usage")
            assert usage.json() == {"item_id": item.id, "used_by": []}
            delivered = await a.get(f"/v1/content/files/{file_ref}")
            # The composition's own byte policy, not the local one.
            assert (delivered.content, delivered.headers["cache-control"]) == (vrma("Wave A"), "private, no-store")
            assert (await a.get(preview_file)).content == vrma("Wave A")
            deleted = await a.delete(f"/v1/content/items/{item.id}", params={"expected_revision": item.revision_sha256})
            assert deleted.status_code == 204
            assert (await a.get(f"/v1/content/items/{item.id}")).status_code == 404
        # The delete's requested commits completed once, when its write session ended.
        assert ports.commits == commits_before + 1 and ports.commits_requested > 0
    finally:
        async with async_session_factory() as session:
            await session.execute(delete(ORMContentCatalogItem).where(ORMContentCatalogItem.owner_user_id == owner_a))
            await session.commit()

"""Deleting owned Local content: what uses it, an Avatar's portrait, and files changed on disk."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from uuid import uuid4

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import delete, update
from sqlalchemy.ext.asyncio import AsyncSession

from animama.adapters.repositories.sqlalchemy.content_catalog_repo import SQLAlchemyContentCatalog
from animama.app.services.content_save_service import AvatarPortraitSource, ContentSaveService
from animama.domain.content_catalog import (
    CatalogContentEntry,
    ContentConflictError,
    ContentKind,
    ContentNotFoundError,
    ContentUsage,
)
from animama.domain.request_principal import RequestPrincipal
from animama.orm.anima import ORMAnima
from animama.orm.anima_loadout import ORMAnimaLoadout
from animama.orm.avatar import ORMAvatar
from animama.orm.content_catalog import ORMAnimaContentBinding, ORMContentCatalogDependency, ORMContentCatalogItem
from animama.orm.content_mutation import ORMContentMutationReceipt
from animama.product_http.routes import content
from animama.server.deps import get_current_principal
from animama.server.local_runtime import LocalRuntimePaths
from tests.anima_creation_service_support import image_bytes, vrm
from tests.content_package_helpers import package_services, vrma
from tests.local_http_client import local_client
from tests.product_http_support import install_local_ports
from tests.typed_loadout_support import (
    LoadoutFixture,
    add_typed_item,
    cleanup_loadout_fixture,
    create_loadout_fixture,
)


async def _anima(session: AsyncSession, fixture: LoadoutFixture, name: str, *, avatar_id: str | None = None) -> str:
    """Another Anima of the fixture's owner, with its own loadout."""

    anima_id = f"{fixture.anima_id}-{name.lower()}"
    session.add(ORMAnima(id=anima_id, user_id=fixture.user_id, display_name=name, avatar_id=avatar_id))
    await session.flush()
    session.add(
        ORMAnimaLoadout(anima_id=anima_id, owner_user_id=fixture.user_id, revision=1, starter_catalog_version=1)
    )
    await session.commit()
    return anima_id


def _bind(anima_id: str, item: ORMContentCatalogItem, slot_key: str, kind: str | None = None) -> ORMAnimaContentBinding:
    return ORMAnimaContentBinding(
        id=str(uuid4()),
        anima_id=anima_id,
        slot_key=slot_key,
        catalog_item_id=item.id,
        kind=kind or item.kind,
        config={},
    )


async def _cleanup_animas(session: AsyncSession, fixture: LoadoutFixture) -> None:
    await session.rollback()
    await session.execute(delete(ORMAnima).where(ORMAnima.user_id == fixture.user_id, ORMAnima.id != fixture.anima_id))
    await session.execute(delete(ORMAvatar).where(ORMAvatar.user_id == fixture.user_id))
    await session.commit()


async def test_usage_names_each_anima_use_and_each_dependent_item(async_session: AsyncSession) -> None:
    fixture = await create_loadout_fixture(async_session)
    try:
        await async_session.execute(
            update(ORMAnima).where(ORMAnima.id == fixture.anima_id).values(display_name="Annie")
        )
        avatar = await add_typed_item(async_session, fixture, kind="avatar", name="Local Avatar", metadata={})
        mapping_id = f"avatar-{uuid4().hex}"
        async_session.add(
            ORMAvatar(
                id=mapping_id,
                name="Local Avatar",
                file_path=avatar.relative_locator,
                user_id=fixture.user_id,
                private=True,
                catalog_item_id=avatar.id,
            )
        )
        await async_session.commit()
        bea = await _anima(async_session, fixture, "Bea", avatar_id=mapping_id)
        cleo = await _anima(async_session, fixture, "Cleo")
        appearance = await add_typed_item(async_session, fixture, kind="appearance", name="Portrait", metadata={})
        voice = await add_typed_item(async_session, fixture, kind="voice", name="Narrator", metadata={})
        gesture = await add_typed_item(async_session, fixture, kind="gesture", name="Wave", metadata={})
        reaction = await add_typed_item(async_session, fixture, kind="reaction", name="Cheer", metadata={})
        sound = await add_typed_item(async_session, fixture, kind="sound_effect", name="Chime", metadata={})
        unused = await add_typed_item(async_session, fixture, kind="gesture", name="Unused", metadata={})
        async_session.add_all(
            [
                # Bea selects the Avatar through its mapping and its loadout row; it is named once.
                _bind(bea, avatar, "avatar"),
                _bind(fixture.anima_id, appearance, "appearance:profile"),
                _bind(fixture.anima_id, appearance, "appearance:background"),
                _bind(fixture.anima_id, voice, "voice"),
                _bind(fixture.anima_id, gesture, "gesture:wave"),
                _bind(fixture.anima_id, gesture, f"idle:default:{gesture.id}"),
                _bind(fixture.anima_id, gesture, f"idle:joy-1:{gesture.id}"),
                _bind(cleo, reaction, f"reaction:joy-1:{reaction.id}"),
                _bind(fixture.anima_id, reaction, f"reaction:joy-2:{reaction.id}"),
                _bind(fixture.anima_id, reaction, f"reaction:sadness-4:{reaction.id}"),
                ORMContentCatalogDependency(
                    item_id=gesture.id, ordinal=1, declared_ref=str(sound.logical_key), target_item_id=sound.id
                ),
            ]
        )
        await async_session.commit()
        catalog = SQLAlchemyContentCatalog(async_session)

        assert await catalog.item_usage(item_id=avatar.id) == (ContentUsage("anima_avatar", bea, "Bea"),)
        assert await catalog.item_usage(item_id=appearance.id) == (
            ContentUsage("anima_appearance", fixture.anima_id, "Annie"),
        )
        assert await catalog.item_usage(item_id=voice.id) == (ContentUsage("anima_voice", fixture.anima_id, "Annie"),)
        assert await catalog.item_usage(item_id=gesture.id) == (
            ContentUsage("anima_gesture", fixture.anima_id, "Annie"),
            ContentUsage("anima_idle", fixture.anima_id, "Annie"),
        )
        assert await catalog.item_usage(item_id=reaction.id) == (
            ContentUsage("anima_reaction", fixture.anima_id, "Annie"),
            ContentUsage("anima_reaction", cleo, "Cleo"),
        )
        assert await catalog.item_usage(item_id=sound.id) == (ContentUsage("content", gesture.id, "Wave"),)
        assert await catalog.item_usage(item_id=unused.id) == ()
    finally:
        await _cleanup_animas(async_session, fixture)
        await cleanup_loadout_fixture(async_session, fixture)


async def test_usage_names_at_most_ten_uses_in_name_order(async_session: AsyncSession) -> None:
    fixture = await create_loadout_fixture(async_session)
    try:
        sound = await add_typed_item(async_session, fixture, kind="sound_effect", name="Chime", metadata={})
        dependents = [
            await add_typed_item(async_session, fixture, kind="gesture", name=f"Wave {index:02d}", metadata={})
            for index in reversed(range(11))
        ]
        async_session.add_all(
            ORMContentCatalogDependency(
                item_id=item.id, ordinal=1, declared_ref=str(sound.logical_key), target_item_id=sound.id
            )
            for item in dependents
        )
        await async_session.commit()

        used_by = await SQLAlchemyContentCatalog(async_session).item_usage(item_id=sound.id)

        assert [use.name for use in used_by] == [f"Wave {index:02d}" for index in range(10)]
    finally:
        await cleanup_loadout_fixture(async_session, fixture)


async def test_in_use_refusal_carries_its_uses_and_usage_is_read_only_for_owned_items(
    async_session: AsyncSession, tmp_path: Path
) -> None:
    fixture = await create_loadout_fixture(async_session)
    paths, catalog, service, saves, _ = package_services(async_session, tmp_path)
    try:
        saved = await saves.save_standalone(
            user_id=fixture.user_id,
            kind=ContentKind.GESTURE,
            entry_name="Bound Wave",
            filename="wave.vrma",
            payload=vrma("bound"),
            metadata_sidecar=None,
            operation_id="save-bound-wave",
            catalog_item_id=None,
            expected_revision=None,
        )
        item = saved.item
        assert item.revision_sha256 is not None
        assert await service.item_usage(item_id=item.id, user_id=fixture.user_id) == ()
        async_session.add(
            ORMAnimaContentBinding(
                id=str(uuid4()),
                anima_id=fixture.anima_id,
                slot_key="gesture:bound-wave",
                catalog_item_id=item.id,
                kind="gesture",
                config={},
            )
        )
        await async_session.commit()
        expected = (ContentUsage("anima_gesture", fixture.anima_id, fixture.anima_id),)

        assert await service.item_usage(item_id=item.id, user_id=fixture.user_id) == expected
        with pytest.raises(ContentConflictError, match="catalog_item_in_use") as refused:
            await service.delete_item(item_id=item.id, user_id=fixture.user_id, expected_revision=item.revision_sha256)
        assert refused.value.used_by == expected
        assert (paths.local_root / item.relative_locator).read_bytes() == vrma("bound")

        # Usage answers only for items Delete accepts.
        with pytest.raises(ContentNotFoundError):
            await service.item_usage(item_id=item.id, user_id="another-owner")
        included = await add_typed_item(async_session, fixture, kind="gesture", name="Included Wave", metadata={})
        await async_session.execute(
            update(ORMContentCatalogItem)
            .where(ORMContentCatalogItem.id == included.id)
            .values(source="included", scope="included", owner_user_id=None)
        )
        await async_session.commit()
        try:
            with pytest.raises(ContentNotFoundError):
                await service.item_usage(item_id=included.id, user_id=fixture.user_id)
        finally:
            await async_session.execute(delete(ORMContentCatalogItem).where(ORMContentCatalogItem.id == included.id))
            await async_session.commit()
    finally:
        await cleanup_loadout_fixture(async_session, fixture)
        await async_session.execute(
            delete(ORMContentMutationReceipt).where(ORMContentMutationReceipt.owner_user_id == fixture.user_id)
        )
        await async_session.commit()


async def _save_avatar_with_portrait(
    saves: ContentSaveService, owner: str
) -> tuple[CatalogContentEntry, CatalogContentEntry]:
    avatar = (
        await saves.save_standalone(
            user_id=owner,
            kind=ContentKind.AVATAR,
            entry_name="Portrayed Avatar",
            filename="avatar.vrm",
            payload=vrm("Portrayed Avatar"),
            metadata_sidecar=json.dumps({"name": "Portrayed Avatar"}).encode(),
            operation_id="save-portrayed-avatar",
            catalog_item_id=None,
            expected_revision=None,
        )
    ).item
    assert avatar.revision_sha256 is not None
    capture = image_bytes(portrait=True, format="WEBP")
    portrait = (
        await saves.save_standalone_stream(
            user_id=owner,
            kind=ContentKind.APPEARANCE,
            entry_name=f"avatar-portrait-{avatar.id}",
            filename="portrait.webp",
            payload_stream=BytesIO(capture),
            payload_size_bytes=len(capture),
            metadata_sidecar=None,
            operation_id="capture-portrait",
            catalog_item_id=None,
            expected_revision=None,
            declared_content_type="image/webp",
            portrait_source=AvatarPortraitSource(
                avatar_id=avatar.id,
                avatar_revision_sha256=avatar.revision_sha256,
                renderer_version=2,
                capture_preset_version=3,
            ),
        )
    ).item
    assert portrait.metadata["presentation"]["avatar_item_id"] == avatar.id
    return avatar, portrait


@pytest.mark.parametrize("portrait_in_use", [False, True])
async def test_deleting_an_avatar_deletes_its_portrait_unless_something_uses_it(
    async_session: AsyncSession, tmp_path: Path, portrait_in_use: bool
) -> None:
    fixture = await create_loadout_fixture(async_session)
    paths, catalog, service, saves, _ = package_services(async_session, tmp_path)
    try:
        avatar, portrait = await _save_avatar_with_portrait(saves, fixture.user_id)
        portrait_files = [paths.local_root / file.relative_path for file in portrait.files]
        assert portrait_files and all(path.is_file() for path in portrait_files)
        if portrait_in_use:
            async_session.add(
                ORMAnimaContentBinding(
                    id=str(uuid4()),
                    anima_id=fixture.anima_id,
                    slot_key="appearance:profile",
                    catalog_item_id=portrait.id,
                    kind="appearance",
                    config={},
                )
            )
            await async_session.commit()
        assert avatar.revision_sha256 is not None

        await service.delete_item(item_id=avatar.id, user_id=fixture.user_id, expected_revision=avatar.revision_sha256)

        assert await catalog.get_visible_item(item_id=avatar.id, user_id=fixture.user_id) is None
        assert not (paths.local_root / avatar.relative_locator).exists()
        kept = await catalog.get_visible_item(item_id=portrait.id, user_id=fixture.user_id)
        if portrait_in_use:
            assert kept is not None and kept.revision_sha256 == portrait.revision_sha256
            assert all(path.is_file() for path in portrait_files)
        else:
            assert kept is None
            assert not any(path.exists() for path in portrait_files)
    finally:
        await cleanup_loadout_fixture(async_session, fixture)
        await async_session.execute(
            delete(ORMContentMutationReceipt).where(ORMContentMutationReceipt.owner_user_id == fixture.user_id)
        )
        await async_session.commit()


async def test_a_changed_portrait_refuses_the_avatar_delete_and_restores_its_files(
    async_session: AsyncSession, tmp_path: Path
) -> None:
    fixture = await create_loadout_fixture(async_session)
    paths, catalog, service, saves, _ = package_services(async_session, tmp_path)
    try:
        avatar, portrait = await _save_avatar_with_portrait(saves, fixture.user_id)
        assert avatar.revision_sha256 is not None
        image = paths.local_root / portrait.relative_locator
        image.write_bytes(image_bytes(portrait=True, format="WEBP", portrait_size=512))

        with pytest.raises(ContentConflictError, match="catalog_item_changed") as refused:
            await service.delete_item(
                item_id=avatar.id, user_id=fixture.user_id, expected_revision=avatar.revision_sha256
            )

        # Nothing was deleted, and the rescan recorded the portrait's new bytes.
        assert refused.value.current_revision == avatar.revision_sha256
        assert (paths.local_root / avatar.relative_locator).read_bytes() == vrm("Portrayed Avatar")
        rescanned = await catalog.get_visible_item(item_id=portrait.id, user_id=fixture.user_id)
        assert rescanned is not None and rescanned.revision_sha256 != portrait.revision_sha256

        await service.delete_item(item_id=avatar.id, user_id=fixture.user_id, expected_revision=avatar.revision_sha256)
        assert await catalog.get_visible_item(item_id=portrait.id, user_id=fixture.user_id) is None
        assert not image.exists()
    finally:
        await cleanup_loadout_fixture(async_session, fixture)
        await async_session.execute(
            delete(ORMContentMutationReceipt).where(ORMContentMutationReceipt.owner_user_id == fixture.user_id)
        )
        await async_session.commit()


@dataclass
class DeleteRoute:
    owner: str
    paths: LocalRuntimePaths
    saves: ContentSaveService
    client: AsyncClient

    async def save_wave(self) -> CatalogContentEntry:
        saved = await self.saves.save_standalone(
            user_id=self.owner,
            kind=ContentKind.GESTURE,
            entry_name="Wave",
            filename="wave.vrma",
            payload=vrma("original"),
            metadata_sidecar=json.dumps({"schema_version": 1, "name": "Wave"}).encode(),
            operation_id=f"save-{uuid4().hex}",
            catalog_item_id=None,
            expected_revision=None,
        )
        return saved.item


@pytest_asyncio.fixture
async def delete_route(async_session: AsyncSession, tmp_path: Path) -> AsyncIterator[DeleteRoute]:
    """The shared content routes served by the local composition, which commits the rescan."""

    paths, _, _, saves, _ = package_services(async_session, tmp_path)
    owner = f"delete-route-{uuid4().hex}"
    app = FastAPI()
    app.state.local_runtime_paths = paths
    app.include_router(content.router)

    async def principal() -> RequestPrincipal:
        return RequestPrincipal(id=owner)

    app.dependency_overrides[get_current_principal] = principal
    install_local_ports(app, async_session)
    try:
        async with local_client(app) as client:
            yield DeleteRoute(owner, paths, saves, client)
    finally:
        await async_session.rollback()
        await async_session.execute(delete(ORMContentCatalogItem).where(ORMContentCatalogItem.owner_user_id == owner))
        await async_session.execute(
            delete(ORMContentMutationReceipt).where(ORMContentMutationReceipt.owner_user_id == owner)
        )
        await async_session.commit()


async def test_usage_route_reads_what_uses_an_owned_item(delete_route: DeleteRoute) -> None:
    item = await delete_route.save_wave()

    usage = await delete_route.client.get(f"/v1/content/items/{item.id}/usage")

    assert usage.status_code == 200, usage.text
    assert usage.json() == {"item_id": item.id, "used_by": []}
    missing = await delete_route.client.get(f"/v1/content/items/{uuid4().hex}/usage")
    assert (missing.status_code, missing.json()) == (404, {"detail": {"code": "content_not_found"}})


@pytest.mark.parametrize("change", ["edited", "removed"])
async def test_a_file_changed_on_disk_refuses_delete_until_the_retry_names_the_current_revision(
    delete_route: DeleteRoute, change: str
) -> None:
    item = await delete_route.save_wave()
    target = delete_route.paths.local_root / item.relative_locator
    if change == "edited":
        target.write_bytes(vrma("edited by hand"))
    else:
        target.unlink()

    refused = await delete_route.client.delete(
        f"/v1/content/items/{item.id}", params={"expected_revision": item.revision_sha256}
    )

    assert refused.status_code == 409, refused.text
    detail = refused.json()["detail"]
    assert detail["code"] == "catalog_item_changed"
    # The refusal rescanned Local, so a fresh read and the refusal agree on the current revision.
    current = (await delete_route.client.get(f"/v1/content/items/{item.id}")).json()
    assert current["revision_sha256"] == detail["current_revision"]
    if change == "edited":
        assert current["status"] == "valid" and current["revision_sha256"] != item.revision_sha256
        assert target.read_bytes() == vrma("edited by hand")
    else:
        # A removed entry stays listed as missing, under its last revision.
        assert current["status"] == "missing" and current["revision_sha256"] == item.revision_sha256

    retried = await delete_route.client.delete(
        f"/v1/content/items/{item.id}", params={"expected_revision": detail["current_revision"]}
    )
    assert retried.status_code == 204, retried.text
    assert (await delete_route.client.get(f"/v1/content/items/{item.id}")).status_code == 404
    assert not target.exists()


async def test_an_in_use_refusal_names_its_uses_over_http(
    async_session: AsyncSession, delete_route: DeleteRoute
) -> None:
    item = await delete_route.save_wave()
    sound_id = f"sound-{uuid4().hex}"
    async_session.add(
        ORMContentCatalogItem(
            id=sound_id,
            source="local",
            scope="owner",
            owner_user_id=delete_route.owner,
            kind="sound_effect",
            relative_locator=f"sfx/{sound_id}",
            display_name="Chime",
            status="valid",
            revision_sha256="a" * 64,
            content_metadata={},
            diagnostics=[],
            provenance={},
        )
    )
    await async_session.flush()
    # The sound is support content the saved Gesture depends on.
    async_session.add(
        ORMContentCatalogDependency(
            item_id=item.id, ordinal=1, declared_ref="local:sound:chime", target_item_id=sound_id
        )
    )
    await async_session.commit()
    used_by = [{"kind": "content", "id": item.id, "name": "Wave"}]

    refused = await delete_route.client.delete(f"/v1/content/items/{sound_id}", params={"expected_revision": "a" * 64})

    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"] == {"code": "catalog_item_in_use", "used_by": used_by}
    usage = await delete_route.client.get(f"/v1/content/items/{sound_id}/usage")
    assert usage.json() == {"item_id": sound_id, "used_by": used_by}

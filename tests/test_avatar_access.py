from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from animama.adapters.repositories.sqlalchemy.product_repositories import SQLAlchemyProductRepositories
from animama.domain.avatar import Avatar
from animama.domain.request_principal import RequestPrincipal
from animama.orm.avatar import ORMAvatar
from animama.orm.content_catalog import ORMContentCatalogItem
from animama.product_http.routes import avatars as avatar_router
from animama.server import avatar_access as avatar_access_module


class _StubAvatarRepository:
    def __init__(self, avatar_by_id: dict[str, Avatar | None]) -> None:
        self.avatar_by_id = avatar_by_id

    async def get(self, avatar_id: str) -> Avatar | None:
        return self.avatar_by_id.get(avatar_id)

    async def list(self, **_kwargs) -> list[Avatar]:
        return [avatar for avatar in self.avatar_by_id.values() if avatar is not None]


@pytest.mark.asyncio
async def test_validate_avatar_access_allows_public_avatar(monkeypatch) -> None:
    avatar = Avatar(
        id="avt_sample_a1n",
        name="Annie",
        file_path="/shared/avatars/AvatarSample_A_1_New.vrm",
        private=False,
    )

    monkeypatch.setattr(
        avatar_access_module,
        "SQLAlchemyAvatarRepository",
        lambda session: _StubAvatarRepository({avatar.id: avatar}),
    )

    await avatar_access_module.validate_avatar_access(
        "avt_sample_a1n",
        session=AsyncSession(),
        user=RequestPrincipal(id="user-1"),
    )


@pytest.mark.asyncio
async def test_validate_avatar_access_rejects_unknown_avatar(monkeypatch) -> None:
    monkeypatch.setattr(
        avatar_access_module,
        "SQLAlchemyAvatarRepository",
        lambda session: _StubAvatarRepository({}),
    )

    with pytest.raises(HTTPException) as exc_info:
        await avatar_access_module.validate_avatar_access(
            "missing-avatar",
            session=AsyncSession(),
            user=RequestPrincipal(id="user-1"),
        )

    assert exc_info.value.status_code == 404
    assert exc_info.value.detail == "Avatar not found: missing-avatar"


@pytest.mark.asyncio
async def test_validate_avatar_access_rejects_other_users_private_avatar(monkeypatch) -> None:
    avatar = Avatar(
        id="avt_private",
        name="Private Avatar",
        file_path="/vrm/private.vrm",
        user_id="user-2",
        private=True,
    )

    monkeypatch.setattr(
        avatar_access_module,
        "SQLAlchemyAvatarRepository",
        lambda session: _StubAvatarRepository({avatar.id: avatar}),
    )

    with pytest.raises(HTTPException) as exc_info:
        await avatar_access_module.validate_avatar_access(
            "avt_private",
            session=AsyncSession(),
            user=RequestPrincipal(id="user-1"),
        )

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "Access denied"


@pytest.mark.asyncio
async def test_validate_avatar_access_allows_clearing_avatar(monkeypatch) -> None:
    def _unexpected_repo(_session: object) -> _StubAvatarRepository:
        raise AssertionError("repository lookup should not run when avatar_id is empty")

    monkeypatch.setattr(
        avatar_access_module,
        "SQLAlchemyAvatarRepository",
        _unexpected_repo,
    )

    await avatar_access_module.validate_avatar_access(
        None,
        session=AsyncSession(),
        user=RequestPrincipal(id="user-1"),
    )


@pytest.mark.asyncio
async def test_avatar_catalog_projects_product_rows_and_filters_origin(async_session) -> None:
    suffix = uuid4().hex
    user_id = f"user-{suffix}"
    catalog_item_id = f"content-{suffix}"
    public_id = f"public-{suffix}"
    owned_id = f"owned-{suffix}"
    async_session.add(
        ORMContentCatalogItem(
            id=catalog_item_id,
            source="local",
            scope="owner",
            owner_user_id=user_id,
            kind="avatar",
            relative_locator=f"avatars/{suffix}.vrm",
            display_name="My Avatar",
            status="valid",
            revision_sha256="a" * 64,
        )
    )
    await async_session.flush()
    async_session.add_all(
        [
            ORMAvatar(
                id=public_id,
                name=f"Starter {suffix}",
                file_path="avatars/starter.vrm",
                identity="",
                private=False,
            ),
            ORMAvatar(
                id=owned_id,
                name=f"My Avatar {suffix}",
                file_path=f"avatars/{suffix}.vrm",
                identity="",
                user_id=user_id,
                private=True,
                catalog_item_id=catalog_item_id,
            ),
        ]
    )
    await async_session.commit()

    try:
        page = await avatar_router.list_avatar_catalog(
            repositories=SQLAlchemyProductRepositories(async_session),
            user=RequestPrincipal(id=user_id),
            q=None,
            origin="local",
            sort="name",
            limit=50,
        )

        assert [(row.avatar_id, row.origin) for row in page.items] == [(owned_id, "local")]
        assert page.items[0].source.model_dump() == {
            "type": "catalog",
            "avatar_id": owned_id,
            "catalog_item_id": catalog_item_id,
        }
        assert page.next_cursor is None
    finally:
        await async_session.delete(await async_session.get(ORMAvatar, public_id))
        await async_session.delete(await async_session.get(ORMAvatar, owned_id))
        await async_session.flush()
        await async_session.delete(await async_session.get(ORMContentCatalogItem, catalog_item_id))
        await async_session.commit()


@pytest.mark.asyncio
async def test_catalog_hides_retired_defaults_and_uses_model_portraits(async_session) -> None:
    """A model portrait is independent of any Anima's selected profile image."""
    from animama.orm.content_catalog import ORMContentCatalogFile

    suffix = uuid4().hex
    portrait_id = f"portrait-{suffix}"
    file_ref = f"portrait-file-{suffix}"
    avatar_id = f"avatar-{suffix}"
    model_id = f"model-{suffix}"
    async_session.add(
        ORMContentCatalogItem(
            id=model_id,
            source="included",
            scope="included",
            kind="avatar",
            relative_locator=f"avatars/{suffix}.vrm",
            display_name="Model",
            status="valid",
        )
    )
    await async_session.flush()
    async_session.add_all(
        [
            ORMAvatar(id="avt_chibi_4", name=f"Retired {suffix}", file_path="/shared/avatars/AvatarChibi_4.vrm"),
            ORMAvatar(
                id=avatar_id, name=f"Valid {suffix}", file_path=f"avatars/{suffix}.vrm", catalog_item_id=model_id
            ),
            ORMContentCatalogItem(
                id=portrait_id,
                source="included",
                scope="included",
                kind="appearance",
                relative_locator=f"appearances/{suffix}.webp",
                display_name="Portrait",
                status="valid",
                content_metadata={"avatar_model": suffix},
            ),
        ]
    )
    await async_session.flush()
    async_session.add(
        ORMContentCatalogFile(
            file_ref=file_ref,
            item_id=portrait_id,
            relative_path=f"appearances/{suffix}.webp",
            role="image",
            media_type="image/webp",
            size_bytes=1,
            sha256="a" * 64,
            ordinal=1,
        )
    )
    await async_session.flush()
    try:
        page = await avatar_router.list_avatar_catalog(
            repositories=SQLAlchemyProductRepositories(async_session),
            user=RequestPrincipal(id="owner"),
            q=suffix,
            origin="all",
            sort="name",
            limit=50,
        )
        assert [item.avatar_id for item in page.items] == [avatar_id]
        # An Included portrait is named by its digest (ADR 0033); a Local one below is not.
        assert page.items[0].preview_url == f"/v1/content/files/{file_ref}/sha256/{'a' * 64}"
        portrait = await async_session.get(ORMContentCatalogItem, portrait_id)
        model = await async_session.get(ORMContentCatalogItem, model_id)
        model.source = "local"
        model.scope = "owner"
        model.owner_user_id = "owner"
        await async_session.flush()
        page = await avatar_router.list_avatar_catalog(
            repositories=SQLAlchemyProductRepositories(async_session),
            user=RequestPrincipal(id="owner"),
            q=suffix,
            origin="all",
            sort="name",
            limit=50,
        )
        assert page.items[0].preview_url is None  # A Local basename collision cannot adopt Included art.
        portrait.source = "local"
        portrait.scope = "owner"
        portrait.owner_user_id = "owner"
        portrait.content_metadata = {"avatar_model": suffix, "presentation": {"avatar_item_id": model_id}}
        await async_session.flush()
        page = await avatar_router.list_avatar_catalog(
            repositories=SQLAlchemyProductRepositories(async_session),
            user=RequestPrincipal(id="owner"),
            q=suffix,
            origin="all",
            sort="name",
            limit=50,
        )
        assert page.items[0].preview_url == f"/v1/content/files/{file_ref}"
        portrait.owner_user_id = "someone-else"
        await async_session.flush()
        page = await avatar_router.list_avatar_catalog(
            repositories=SQLAlchemyProductRepositories(async_session),
            user=RequestPrincipal(id="owner"),
            q=suffix,
            origin="all",
            sort="name",
            limit=50,
        )
        assert page.items[0].preview_url is None
        portrait.owner_user_id = "owner"
        portrait.status = "invalid"
        await async_session.flush()
        page = await avatar_router.list_avatar_catalog(
            repositories=SQLAlchemyProductRepositories(async_session),
            user=RequestPrincipal(id="owner"),
            q=suffix,
            origin="all",
            sort="name",
            limit=50,
        )
        assert page.items[0].preview_url is None
    finally:
        await async_session.rollback()

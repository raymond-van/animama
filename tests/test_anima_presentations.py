from __future__ import annotations

from dataclasses import asdict, replace
from typing import TypeVar
from uuid import uuid4

import pytest
from sqlalchemy import delete

from animama.adapters.repositories.sqlalchemy.anima_presentation_repo import (
    SQLAlchemyAnimaPresentationRepository,
)
from animama.app.contracts.anima import PyRuntimeImageReference
from animama.app.services.anima_presentation_service import AnimaPresentationService
from animama.domain.anima_presentation import (
    AnimaPresentationImageCandidate,
    AnimaPresentationRecord,
)
from animama.domain.content_catalog import ContentSource
from animama.orm.anima import ORMAnima
from animama.orm.anima_loadout import ORMAnimaLoadout
from animama.orm.avatar import ORMAvatar
from animama.orm.content_catalog import ORMContentCatalogFile, ORMContentCatalogItem

_T = TypeVar("_T")


def _required(value: _T | None) -> _T:
    """Assert the fixture lookup succeeded before inspecting its typed value."""
    assert value is not None
    return value


@pytest.mark.asyncio
async def test_builtin_avatar_presentation_resolves_on_the_clean_typed_schema(
    async_session,
) -> None:
    """The list projection must bind JSON values with PostgreSQL JSONB types."""

    suffix = uuid4().hex
    user_id = f"user-{suffix}"
    avatar_id = f"avatar-{suffix}"
    anima_id = f"anima-{suffix}"
    portrait_item_id = f"portrait-{suffix}"
    try:
        async_session.add(
            ORMAvatar(
                id=avatar_id,
                name=f"Avatar {suffix}",
                file_path="/shared/avatars/Andrew.vrm",
                identity="A typed-schema test Avatar.",
                private=False,
            )
        )
        await async_session.flush()
        async_session.add(
            ORMAnima(
                id=anima_id,
                display_name=f"Live {suffix}",
                user_id=user_id,
                avatar_id=avatar_id,
            )
        )
        await async_session.flush()
        async_session.add(
            ORMAnimaLoadout(
                anima_id=anima_id,
                owner_user_id=user_id,
                revision=1,
                starter_catalog_version=1,
            )
        )
        async_session.add(
            ORMContentCatalogItem(
                id=portrait_item_id,
                source="included",
                scope="included",
                kind="appearance",
                relative_locator=f"appearances/avatar-portraits/{suffix}.webp",
                logical_key="builtin:avatar-portrait:Andrew",
                display_name="Andrew Portrait",
                status="valid",
                revision_sha256="a" * 64,
                content_metadata={"avatar_model": "Andrew", "width": 256, "height": 256},
            )
        )
        # The file model intentionally has no ORM relationship; make the catalog
        # parent durable in this flush before inserting its foreign-key member.
        await async_session.flush()
        async_session.add(
            ORMContentCatalogFile(
                file_ref=f"portrait-file-{suffix}",
                item_id=portrait_item_id,
                relative_path=f"appearances/avatar-portraits/{suffix}.webp",
                role="image",
                media_type="image/webp",
                size_bytes=8192,
                sha256="b" * 64,
                ordinal=1,
            )
        )
        await async_session.commit()

        records = await SQLAlchemyAnimaPresentationRepository(async_session).list_owned_presentation_records(
            user_id=user_id, anima_ids=(anima_id,)
        )

        assert records[anima_id].display_name == f"Live {suffix}"
        assert records[anima_id].profile_image is None
        assert records[anima_id].primary_model is not None
        assert _required(records[anima_id].primary_model).source_type == "builtin"
        assert _required(records[anima_id].primary_model).builtin_id == "app:avatar_model:Andrew"
        assert records[anima_id].avatar_portrait is not None
        assert _required(records[anima_id].avatar_portrait).catalog_item_id == portrait_item_id
        assert _required(records[anima_id].avatar_portrait).source is ContentSource.INCLUDED
    finally:
        # Included content is visible across this session-scoped test database.
        # A later real scan preserves logical identity, so this synthetic global
        # portrait must not survive the test that owns it, even on assertion failure.
        await async_session.rollback()
        await async_session.execute(delete(ORMAnima).where(ORMAnima.id == anima_id))
        await async_session.execute(delete(ORMAvatar).where(ORMAvatar.id == avatar_id))
        await async_session.execute(delete(ORMContentCatalogItem).where(ORMContentCatalogItem.id == portrait_item_id))
        await async_session.commit()


@pytest.mark.asyncio
async def test_included_avatar_portrait_uses_registered_catalog_delivery() -> None:
    record = AnimaPresentationRecord(
        anima_id="anima-builtin",
        display_name="Bundled Avatar",
        avatar_portrait=AnimaPresentationImageCandidate(
            slot="profile_image",
            source_type="catalog",
            catalog_item_id="portrait-r1",
            file_ref="portrait-r1-file",
            content_type="image/webp",
            size_bytes=8192,
            sha256="9" * 64,
            width=256,
            height=256,
            source=ContentSource.INCLUDED,
        ),
    )
    service = AnimaPresentationService(presentations=_PresentationRepository(record))

    projected = (
        await service.list_owned_presentations(
            user_id="owner",
            anima_ids=(record.anima_id,),
        )
    )[record.anima_id]

    assert projected.profile_thumbnail is not None
    assert projected.profile_thumbnail.source_type == "catalog"
    # The Included image is named by its digest, so the browser keeps it as immutable (ADR 0033).
    assert projected.profile_thumbnail.url == f"/v1/content/files/portrait-r1-file/sha256/{'9' * 64}"
    assert projected.profile_thumbnail.content_revision == "9" * 64


class _PresentationRepository:
    """Small service fixture for direct presentation persistence."""

    def __init__(self, *records: AnimaPresentationRecord) -> None:
        self.records = {record.anima_id: record for record in records}

    async def list_owned_presentation_records(
        self,
        *,
        user_id: str,
        anima_ids: tuple[str, ...],
    ) -> dict[str, AnimaPresentationRecord]:
        del user_id
        return {anima_id: self.records[anima_id] for anima_id in anima_ids if anima_id in self.records}

    async def get_owned_presentation_record(
        self,
        *,
        user_id: str,
        anima_id: str,
    ) -> AnimaPresentationRecord | None:
        del user_id
        return self.records.get(anima_id)


def _catalog_image_candidate(
    *,
    slot: str,
    item_id: str,
    sha256: str,
) -> AnimaPresentationImageCandidate:
    return AnimaPresentationImageCandidate(
        slot=slot,
        source_type="catalog",
        catalog_item_id=item_id,
        config=({"fit": "contain", "focal_x": 0.4, "focal_y": 0.3, "zoom": 1.5} if slot == "profile_image" else {}),
        file_ref=f"file-{item_id}",
        content_type="image/webp",
        size_bytes=8192,
        sha256=sha256,
        width=256,
        height=256,
    )


@pytest.mark.asyncio
async def test_profile_image_overrides_primary_avatar_model() -> None:
    avatar_model = AnimaPresentationImageCandidate(
        slot="primary_model",
        source_type="catalog",
        catalog_item_id="avatar-1",
        file_ref="avatar-file-1",
        content_type="model/gltf-binary",
        size_bytes=8192,
        sha256="c" * 64,
    )
    profile = _catalog_image_candidate(
        slot="profile_image",
        item_id="appearance-1",
        sha256="a" * 64,
    )
    generated_only = AnimaPresentationRecord(
        anima_id="anima-generated",
        display_name="Generated",
        primary_model=avatar_model,
    )
    explicit_profile = replace(
        generated_only,
        anima_id="anima-profile",
        display_name="Custom profile",
        profile_image=profile,
    )
    service = AnimaPresentationService(presentations=_PresentationRepository(generated_only, explicit_profile))

    projected = await service.list_owned_presentations(
        user_id="owner",
        anima_ids=(generated_only.anima_id, explicit_profile.anima_id),
    )

    assert projected[generated_only.anima_id].profile_thumbnail is None
    selected = projected[explicit_profile.anima_id].profile_thumbnail
    assert selected is not None
    assert selected.content_revision == "a" * 64
    assert selected.presentation.fit == "contain"
    assert selected.presentation.zoom == 1.5

    assert selected.url == "/v1/content/files/file-appearance-1"


@pytest.mark.asyncio
async def test_catalog_profile_revision_tracks_exact_file_digest() -> None:
    first = _catalog_image_candidate(
        slot="profile_image",
        item_id="appearance-1",
        sha256="a" * 64,
    )
    record = AnimaPresentationRecord(
        anima_id="anima-avatar",
        display_name="Avatar",
        profile_image=first,
    )
    repository = _PresentationRepository(record)
    service = AnimaPresentationService(presentations=repository)
    initial = (await service.list_owned_presentations(user_id="owner", anima_ids=(record.anima_id,)))[record.anima_id]

    repository.records[record.anima_id] = replace(
        record,
        profile_image=replace(
            first,
            sha256="c" * 64,
            file_ref="file-appearance-2",
        ),
    )
    updated = (await service.list_owned_presentations(user_id="owner", anima_ids=(record.anima_id,)))[record.anima_id]
    assert updated.presentation_revision != initial.presentation_revision
    assert updated.profile_thumbnail is not None
    assert updated.profile_thumbnail.content_revision == "c" * 64

    repository.records[record.anima_id] = replace(record, profile_image=replace(first, sha256="invalid"))
    invalid = (await service.list_owned_presentations(user_id="owner", anima_ids=(record.anima_id,)))[record.anima_id]
    assert invalid.profile_thumbnail is None


@pytest.mark.asyncio
async def test_local_avatar_presentation_uses_its_exact_owner_portrait(async_session) -> None:
    """The exact Local portrait wins over an Included stem match; other owners' portraits never apply."""

    suffix = uuid4().hex
    user_id = f"user-{suffix}"
    avatar_item_id = f"avatar-item-{suffix}"
    avatar_id = f"avatar-{suffix}"
    anima_id = f"anima-{suffix}"
    # The other owner's portrait sorts first, so only the owner filter excludes it.
    theirs, mine, by_stem = (f"{name}-{suffix}" for name in ("a-theirs", "b-mine", "c-stem"))

    def catalog_item(item_id: str, **fields: object) -> ORMContentCatalogItem:
        return ORMContentCatalogItem(
            id=item_id,
            kind="appearance",
            display_name=item_id,
            status="valid",
            revision_sha256="a" * 64,
            logical_key=f"local:appearance:{item_id}",
            **fields,
        )

    def image_file(item_id: str) -> ORMContentCatalogFile:
        return ORMContentCatalogFile(
            file_ref=f"{item_id}-file",
            item_id=item_id,
            relative_path=f"appearances/{item_id}.webp",
            role="image",
            media_type="image/webp",
            size_bytes=4096,
            sha256="b" * 64,
            ordinal=1,
        )

    exact = {"avatar_item_id": avatar_item_id, "avatar_revision_sha256": "c" * 64}
    items = [
        catalog_item(
            avatar_item_id,
            source="local",
            scope="owner",
            owner_user_id=user_id,
            relative_locator=f"avatars/{suffix}.vrm",
        ),
        catalog_item(
            mine,
            source="local",
            scope="owner",
            owner_user_id=user_id,
            relative_locator=f"appearances/{mine}.webp",
            content_metadata={"avatar_model": suffix, "width": 512, "height": 512, "presentation": exact},
        ),
        catalog_item(
            theirs,
            source="local",
            scope="owner",
            owner_user_id=f"other-{suffix}",
            relative_locator=f"appearances/{theirs}.webp",
            content_metadata={"avatar_model": suffix, "width": 512, "height": 512, "presentation": exact},
        ),
        catalog_item(
            by_stem,
            source="included",
            scope="included",
            relative_locator=f"appearances/avatar-portraits/{by_stem}.webp",
            content_metadata={"avatar_model": suffix, "width": 256, "height": 256},
        ),
    ]
    items[0].kind = "avatar"
    try:
        async_session.add_all(items)
        await async_session.flush()
        async_session.add_all([image_file(item_id) for item_id in (mine, theirs, by_stem)])
        async_session.add(
            ORMAvatar(
                id=avatar_id,
                name=f"Avatar {suffix}",
                file_path=f"/local/avatars/{suffix}.vrm",
                identity="A Local Avatar.",
                private=True,
                user_id=user_id,
                catalog_item_id=avatar_item_id,
            )
        )
        await async_session.flush()
        async_session.add(ORMAnima(id=anima_id, display_name=f"Live {suffix}", user_id=user_id, avatar_id=avatar_id))
        await async_session.flush()
        async_session.add(
            ORMAnimaLoadout(anima_id=anima_id, owner_user_id=user_id, revision=1, starter_catalog_version=1)
        )
        await async_session.commit()

        records = await SQLAlchemyAnimaPresentationRepository(async_session).list_owned_presentation_records(
            user_id=user_id, anima_ids=(anima_id,)
        )

        portrait = _required(records[anima_id].avatar_portrait)
        assert portrait.catalog_item_id == mine
        assert portrait.source is ContentSource.LOCAL
        assert (portrait.width, portrait.height) == (512, 512)
        service = AnimaPresentationService(presentations=_PresentationRepository(records[anima_id]))
        thumbnail = _required(service._project(records[anima_id]).profile_thumbnail)
        assert thumbnail.url == f"/v1/content/files/{mine}-file"
        assert (
            PyRuntimeImageReference.model_validate(
                {**asdict(thumbnail), "presentation": asdict(thumbnail.presentation)}
            ).width
            == 512
        )
    finally:
        await async_session.rollback()
        await async_session.execute(delete(ORMAnima).where(ORMAnima.id == anima_id))
        await async_session.execute(delete(ORMAvatar).where(ORMAvatar.id == avatar_id))
        await async_session.execute(
            delete(ORMContentCatalogItem).where(ORMContentCatalogItem.id.in_([avatar_item_id, mine, theirs, by_stem]))
        )
        await async_session.commit()

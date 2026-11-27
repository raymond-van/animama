"""Anima mappers for the profile-first direct chat runtime."""

from __future__ import annotations

from typing import Any

from animama.app.contracts.anima import PyAnimaResponse, PyAnimaUpdateRequest
from animama.domain.anima import Anima
from animama.domain.emotions import normalize_emotional_state
from animama.orm.anima import ORMAnima
from animama.orm.archive import ORMArchive


def anima_domain_to_schema(
    anima: Anima,
) -> PyAnimaResponse:
    s_avatar = None
    if anima.avatar is not None:
        from .avatar_map import avatar_domain_to_schema

        s_avatar = avatar_domain_to_schema(anima.avatar)

    return PyAnimaResponse.model_validate(
        {
            "id": anima.id,
            "display_name": anima.display_name,
            "aggregate_revision": anima.aggregate_revision,
            "identity_status": anima.identity_status,
            "metadata": {
                **dict(anima.metadata or {}),
                "tags": list(anima.tags),
            },
            "archive_id": anima.archive_id,
            "avatar_id": anima.avatar.id if anima.avatar else None,
            "avatar_catalog_item_id": anima.avatar.catalog_item_id if anima.avatar else None,
            "profile_picture_url": anima.profile_picture_url,
            "emotional_state": normalize_emotional_state(anima.emotional_state),
            "avatar": s_avatar.model_dump(mode="json") if s_avatar else None,
            "pinned_at": anima.pinned_at,
        }
    )


def anima_domain_to_orm(anima: Anima) -> ORMAnima:
    metadata: dict[str, Any] = dict(anima.metadata or {})
    metadata["tags"] = list(anima.tags)
    orm = ORMAnima(
        id=anima.id,
        display_name=anima.display_name or anima.id[:120],
        aggregate_revision=anima.aggregate_revision,
        identity_status=anima.identity_status,
        user_id=anima.user_id,
        created_by_id=anima.user_id,
        last_updated_by_id=anima.user_id,
        metadata_=metadata,
        archive_id=anima.archive_id,
        avatar_id=anima.avatar.id if anima.avatar else None,
        profile_picture_url=anima.profile_picture_url,
        emotional_state=normalize_emotional_state(anima.emotional_state),
        pinned_at=anima.pinned_at,
    )
    if anima.archive_id is not None:
        orm.archive = ORMArchive(
            id=anima.archive_id,
            name=f"{anima.id} Archive",
            description=f"Archive for anima {anima.id}",
        )
    return orm


def anima_orm_to_domain(orm: ORMAnima) -> Anima:
    from animama.domain.avatar import Avatar

    meta = dict(orm.metadata_ or {})
    tags = meta.get("tags")

    avatar: Avatar | None = None
    if orm.avatar is not None:
        from .avatar_map import avatar_orm_to_domain

        avatar = avatar_orm_to_domain(orm.avatar)

    return Anima(
        id=orm.id,
        display_name=orm.display_name,
        aggregate_revision=orm.aggregate_revision,
        identity_status=orm.identity_status,
        user_id=orm.user_id,
        tags=list(tags) if isinstance(tags, list) else [],
        metadata=meta,
        archive_id=orm.archive_id,
        avatar=avatar,
        profile_picture_url=orm.profile_picture_url,
        emotional_state=normalize_emotional_state(orm.emotional_state),
        pinned_at=orm.pinned_at,
    )


def anima_update_request_to_domain(req: PyAnimaUpdateRequest, existing: Anima) -> Anima:
    if req.anima is None:
        return existing

    if req.anima.metadata is not None:
        existing.metadata = dict(req.anima.metadata)
        tags = existing.metadata.get("tags")
        existing.tags = list(tags) if isinstance(tags, list) else []

    avatar_id_present = "avatar_id" in getattr(req.anima, "model_fields_set", set())
    avatar_id = getattr(req.anima, "avatar_id", None)
    if isinstance(avatar_id, str):
        avatar_id = avatar_id.strip() or None
    if avatar_id_present:
        if avatar_id:
            from animama.domain.avatar import Avatar

            existing.avatar = Avatar(id=avatar_id, name="", file_path="")
        else:
            existing.avatar = None

    if req.anima.profile_picture_url is not None:
        existing.profile_picture_url = req.anima.profile_picture_url
    if req.anima.emotional_state is not None:
        existing.emotional_state = normalize_emotional_state(req.anima.emotional_state)

    return existing

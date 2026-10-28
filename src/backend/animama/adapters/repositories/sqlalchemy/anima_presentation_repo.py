"""Set-based SQLAlchemy projection for lightweight Anima presentations."""

from __future__ import annotations

from pathlib import PurePosixPath
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from ....app.ports.anima_presentation_port import AnimaPresentationRepository
from ....domain.anima_presentation import AnimaPresentationImageCandidate, AnimaPresentationRecord
from ....domain.content_catalog import ContentSource
from ....orm.anima import ORMAnima
from ....orm.anima_loadout import ORMAnimaLoadout
from ....orm.avatar import ORMAvatar
from ....orm.content_catalog import ORMAnimaContentBinding, ORMContentCatalogFile, ORMContentCatalogItem


class SQLAlchemyAnimaPresentationRepository(AnimaPresentationRepository):
    """Resolve profile images through the same neutral catalog as runtime mounts."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def list_owned_presentation_records(
        self,
        *,
        user_id: str,
        anima_ids: tuple[str, ...],
    ) -> dict[str, AnimaPresentationRecord]:
        if not anima_ids:
            return {}
        rows = (await self._session.execute(self._statement(user_id=user_id).where(ORMAnima.id.in_(anima_ids)))).all()
        return {row.anima_id: self._record(row) for row in rows}

    async def get_owned_presentation_record(
        self,
        *,
        user_id: str,
        anima_id: str,
    ) -> AnimaPresentationRecord | None:
        row = (
            await self._session.execute(self._statement(user_id=user_id).where(ORMAnima.id == anima_id))
        ).one_or_none()
        return self._record(row) if row else None

    @staticmethod
    def _statement(*, user_id: str):
        profile_binding = aliased(ORMAnimaContentBinding, name="profile_binding")
        profile_item = aliased(ORMContentCatalogItem, name="profile_item")
        portrait_item = aliased(ORMContentCatalogItem, name="portrait_item")
        portrait_file = aliased(ORMContentCatalogFile, name="portrait_file")
        ranked_files = (
            select(
                ORMContentCatalogFile.item_id.label("item_id"),
                ORMContentCatalogFile.file_ref.label("file_ref"),
                ORMContentCatalogFile.media_type.label("media_type"),
                ORMContentCatalogFile.size_bytes.label("size_bytes"),
                ORMContentCatalogFile.sha256.label("sha256"),
                func.row_number()
                .over(
                    partition_by=ORMContentCatalogFile.item_id,
                    order_by=ORMContentCatalogFile.ordinal,
                )
                .label("file_rank"),
            )
            .where(ORMContentCatalogFile.role.notin_({"descriptor", "metadata"}))
            .subquery("profile_files")
        )
        # Portraits naming their Avatar's exact catalog item (captured or
        # imported), one per Avatar, visible to this owner.
        exact_item = aliased(ORMContentCatalogItem, name="exact_portrait_item")
        exact_file = aliased(ORMContentCatalogFile, name="exact_portrait_file")
        exact_avatar_item_id = exact_item.content_metadata["presentation"]["avatar_item_id"].astext
        exact_portraits = (
            select(
                exact_avatar_item_id.label("avatar_item_id"),
                exact_item.id.label("catalog_item_id"),
                exact_item.content_metadata.label("metadata"),
                exact_item.source.label("source"),
                exact_file.file_ref.label("file_ref"),
                exact_file.media_type.label("media_type"),
                exact_file.size_bytes.label("size_bytes"),
                exact_file.sha256.label("sha256"),
                func.row_number()
                .over(partition_by=exact_avatar_item_id, order_by=exact_item.id)
                .label("portrait_rank"),
            )
            .join(exact_file, and_(exact_file.item_id == exact_item.id, exact_file.role == "image"))
            .where(
                exact_item.kind == "appearance",
                exact_item.status == "valid",
                exact_avatar_item_id.is_not(None),
                or_(
                    exact_item.scope.in_({"included", "installation_shared"}),
                    exact_item.owner_user_id == user_id,
                ),
            )
            .subquery("exact_portraits")
        )
        return (
            select(
                ORMAnima.id.label("anima_id"),
                ORMAnima.display_name,
                ORMAvatar.file_path.label("avatar_file_path"),
                ORMAvatar.catalog_item_id.label("avatar_catalog_item_id"),
                ORMAnimaLoadout.starter_catalog_version,
                profile_binding.catalog_item_id.label("profile_catalog_item_id"),
                profile_binding.config.label("profile_config"),
                profile_item.content_metadata.label("profile_metadata"),
                profile_item.source.label("profile_source"),
                ranked_files.c.file_ref.label("profile_file_ref"),
                ranked_files.c.media_type.label("profile_content_type"),
                ranked_files.c.size_bytes.label("profile_size_bytes"),
                ranked_files.c.sha256.label("profile_sha256"),
                portrait_item.id.label("portrait_catalog_item_id"),
                portrait_item.content_metadata.label("portrait_metadata"),
                portrait_item.source.label("portrait_source"),
                portrait_file.file_ref.label("portrait_file_ref"),
                portrait_file.media_type.label("portrait_content_type"),
                portrait_file.size_bytes.label("portrait_size_bytes"),
                portrait_file.sha256.label("portrait_sha256"),
                exact_portraits.c.catalog_item_id.label("exact_portrait_catalog_item_id"),
                exact_portraits.c.metadata.label("exact_portrait_metadata"),
                exact_portraits.c.source.label("exact_portrait_source"),
                exact_portraits.c.file_ref.label("exact_portrait_file_ref"),
                exact_portraits.c.media_type.label("exact_portrait_content_type"),
                exact_portraits.c.size_bytes.label("exact_portrait_size_bytes"),
                exact_portraits.c.sha256.label("exact_portrait_sha256"),
            )
            .select_from(ORMAnima)
            .outerjoin(ORMAvatar, ORMAvatar.id == ORMAnima.avatar_id)
            .outerjoin(
                ORMAnimaLoadout,
                and_(
                    ORMAnimaLoadout.anima_id == ORMAnima.id,
                    ORMAnimaLoadout.owner_user_id == user_id,
                ),
            )
            .outerjoin(
                profile_binding,
                and_(
                    profile_binding.anima_id == ORMAnimaLoadout.anima_id,
                    profile_binding.slot_key == "appearance:profile",
                    profile_binding.kind == "appearance",
                ),
            )
            .outerjoin(
                profile_item,
                and_(
                    profile_item.id == profile_binding.catalog_item_id,
                    profile_item.status == "valid",
                    or_(
                        profile_item.scope.in_({"included", "installation_shared"}),
                        profile_item.owner_user_id == user_id,
                    ),
                ),
            )
            .outerjoin(
                ranked_files,
                and_(
                    ranked_files.c.item_id == profile_item.id,
                    ranked_files.c.file_rank == 1,
                ),
            )
            .outerjoin(
                portrait_item,
                and_(
                    portrait_item.source == "included",
                    portrait_item.scope == "included",
                    portrait_item.kind == "appearance",
                    portrait_item.status == "valid",
                    portrait_item.content_metadata["avatar_model"].astext
                    == func.regexp_replace(
                        func.regexp_replace(ORMAvatar.file_path, r"^.*/", ""),
                        r"\.[^.]+$",
                        "",
                    ),
                ),
            )
            .outerjoin(
                portrait_file,
                and_(
                    portrait_file.item_id == portrait_item.id,
                    portrait_file.role == "image",
                ),
            )
            .outerjoin(
                exact_portraits,
                and_(
                    exact_portraits.c.avatar_item_id == ORMAvatar.catalog_item_id,
                    exact_portraits.c.portrait_rank == 1,
                ),
            )
            .where(ORMAnima.user_id == user_id)
        )

    @staticmethod
    def _record(row: Any) -> AnimaPresentationRecord:
        profile: AnimaPresentationImageCandidate | None = None
        if row.profile_file_ref:
            metadata = dict(row.profile_metadata) if isinstance(row.profile_metadata, dict) else {}
            width = metadata.get("width")
            height = metadata.get("height")
            profile = AnimaPresentationImageCandidate(
                slot="profile_image",
                source_type="catalog",
                catalog_item_id=row.profile_catalog_item_id,
                config=dict(row.profile_config) if isinstance(row.profile_config, dict) else {},
                file_ref=row.profile_file_ref,
                content_type=row.profile_content_type,
                size_bytes=row.profile_size_bytes,
                sha256=row.profile_sha256,
                width=width if type(width) is int else 1,
                height=height if type(height) is int else 1,
                source=ContentSource(row.profile_source),
            )

        primary_model: AnimaPresentationImageCandidate | None = None
        if row.avatar_catalog_item_id is None and row.avatar_file_path:
            source_path = urlsplit(str(row.avatar_file_path)).path
            source_stem = PurePosixPath(source_path).stem
            primary_model = AnimaPresentationImageCandidate(
                slot="primary_model",
                source_type="builtin",
                builtin_id=f"app:avatar_model:{source_stem}",
                builtin_version=1,
            )

        # The exact portrait wins over the Included model-stem match.
        prefix = "exact_portrait" if row.exact_portrait_file_ref else "portrait"
        avatar_portrait: AnimaPresentationImageCandidate | None = None
        if getattr(row, f"{prefix}_file_ref"):
            raw_metadata = getattr(row, f"{prefix}_metadata")
            metadata = dict(raw_metadata) if isinstance(raw_metadata, dict) else {}
            width = metadata.get("width")
            height = metadata.get("height")
            avatar_portrait = AnimaPresentationImageCandidate(
                slot="profile_image",
                source_type="catalog",
                catalog_item_id=getattr(row, f"{prefix}_catalog_item_id"),
                file_ref=getattr(row, f"{prefix}_file_ref"),
                content_type=getattr(row, f"{prefix}_content_type"),
                size_bytes=getattr(row, f"{prefix}_size_bytes"),
                sha256=getattr(row, f"{prefix}_sha256"),
                width=width if type(width) is int else 1,
                height=height if type(height) is int else 1,
                source=ContentSource(getattr(row, f"{prefix}_source")),
            )

        return AnimaPresentationRecord(
            anima_id=row.anima_id,
            display_name=row.display_name,
            starter_catalog_version=row.starter_catalog_version,
            profile_image=profile,
            avatar_portrait=avatar_portrait,
            primary_model=primary_model,
        )


__all__ = ["SQLAlchemyAnimaPresentationRepository"]

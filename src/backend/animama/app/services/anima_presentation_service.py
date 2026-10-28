"""Build lightweight, revisioned Anima presentation projections."""

from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
from dataclasses import dataclass

from ...domain.anima_presentation import (
    AnimaPresentation,
    AnimaPresentationImageCandidate,
    AnimaPresentationRecord,
    RuntimeImagePresentation,
    RuntimeImageReference,
)
from ..ports.anima_presentation_port import AnimaPresentationRepository
from .content_file_urls import content_file_url

PRESENTATION_REVISION_VERSION = 6
_WHITESPACE = re.compile(r"\s+")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def normalize_runtime_image_presentation(config: dict[str, object]) -> RuntimeImagePresentation:
    """Resolve the bounded crop fields used by current presentation bindings."""

    def bounded_number(key: str, fallback: float, minimum: float, maximum: float) -> float:
        raw = config.get(key)
        value = float(raw) if isinstance(raw, int | float) and not isinstance(raw, bool) else fallback
        if not math.isfinite(value):
            value = fallback
        return max(minimum, min(maximum, value))

    return RuntimeImagePresentation(
        fit="contain" if config.get("fit") == "contain" else "cover",
        focal_x=bounded_number("focal_x", 0.5, 0, 1),
        focal_y=bounded_number("focal_y", 0.5, 0, 1),
        zoom=bounded_number("zoom", 1, 1, 4),
    )


@dataclass(frozen=True, slots=True)
class _SelectedPresentationImage:
    source_type: str
    source_identity: dict[str, object]
    content_type: str
    width: int
    height: int
    content_revision: str
    presentation: RuntimeImagePresentation
    url: str


def normalize_anima_display_name(value: str, *, fallback: str) -> str:
    """Return a bounded, stable display name suitable for revision hashing."""

    normalized = _WHITESPACE.sub(" ", unicodedata.normalize("NFKC", value).strip())
    return (normalized or fallback)[:120]


class AnimaPresentationService:
    """Project safe navigation metadata from catalog file identities."""

    def __init__(self, *, presentations: AnimaPresentationRepository) -> None:
        self._presentations = presentations

    async def list_owned_presentations(
        self,
        *,
        user_id: str,
        anima_ids: tuple[str, ...],
    ) -> dict[str, AnimaPresentation]:
        records = await self._presentations.list_owned_presentation_records(
            user_id=user_id,
            anima_ids=anima_ids,
        )
        return {anima_id: self._project(record) for anima_id, record in records.items()}

    def _project(self, record: AnimaPresentationRecord) -> AnimaPresentation:
        display_name = record.display_name
        selected = self._select_image(record)
        revision = self._revision(selected=selected, display_name=display_name)
        thumbnail = (
            RuntimeImageReference(
                source_type=selected.source_type,
                url=selected.url,
                content_type=selected.content_type,
                width=selected.width,
                height=selected.height,
                content_revision=selected.content_revision,
                presentation=selected.presentation,
            )
            if selected
            else None
        )
        return AnimaPresentation(
            anima_id=record.anima_id,
            presentation_revision=revision,
            display_name=display_name,
            profile_thumbnail=thumbnail,
        )

    @staticmethod
    def _valid_catalog_image(candidate: AnimaPresentationImageCandidate) -> bool:
        return (
            candidate.source_type == "catalog"
            and bool(candidate.catalog_item_id)
            and bool(candidate.file_ref)
            and bool(candidate.content_type and candidate.content_type.startswith("image/"))
            and isinstance(candidate.size_bytes, int)
            and 0 < candidate.size_bytes <= 16 * 1024 * 1024
            and bool(candidate.sha256 and _SHA256.fullmatch(candidate.sha256))
            and isinstance(candidate.width, int)
            and 0 < candidate.width <= 8192
            and isinstance(candidate.height, int)
            and 0 < candidate.height <= 8192
        )

    def _select_image(self, record: AnimaPresentationRecord) -> _SelectedPresentationImage | None:
        profile = record.profile_image
        if profile and self._valid_catalog_image(profile):
            return _SelectedPresentationImage(
                source_type="catalog",
                source_identity={
                    "catalog_item_id": profile.catalog_item_id or "",
                    "file_ref": profile.file_ref or "",
                    "config": profile.config,
                },
                content_type=profile.content_type or "image/webp",
                width=profile.width or 1,
                height=profile.height or 1,
                content_revision=profile.sha256 or "",
                presentation=normalize_runtime_image_presentation(profile.config),
                url=content_file_url(
                    file_ref=profile.file_ref or "", sha256=profile.sha256 or "", source=profile.source
                ),
            )

        portrait = record.avatar_portrait
        if portrait and self._valid_catalog_image(portrait):
            return _SelectedPresentationImage(
                source_type="catalog",
                source_identity={
                    "catalog_item_id": portrait.catalog_item_id or "",
                    "file_ref": portrait.file_ref or "",
                },
                content_type=portrait.content_type or "image/webp",
                width=portrait.width or 1,
                height=portrait.height or 1,
                content_revision=portrait.sha256 or "",
                presentation=normalize_runtime_image_presentation({}),
                url=content_file_url(
                    file_ref=portrait.file_ref or "", sha256=portrait.sha256 or "", source=portrait.source
                ),
            )
        return None

    @staticmethod
    def _revision(*, selected: _SelectedPresentationImage | None, display_name: str) -> str:
        source = (
            {
                "source_type": selected.source_type,
                "source_identity": selected.source_identity,
                "content_revision": selected.content_revision,
                "content_type": selected.content_type,
                "width": selected.width,
                "height": selected.height,
                "presentation": {
                    "fit": selected.presentation.fit,
                    "focal_x": selected.presentation.focal_x,
                    "focal_y": selected.presentation.focal_y,
                    "zoom": selected.presentation.zoom,
                },
            }
            if selected
            else None
        )
        canonical = json.dumps(
            {
                "v": PRESENTATION_REVISION_VERSION,
                "display_name": display_name,
                "profile_thumbnail": source,
            },
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode()
        return f"presentation-v{PRESENTATION_REVISION_VERSION}-{hashlib.sha256(canonical).hexdigest()}"


__all__ = [
    "AnimaPresentationService",
    "normalize_runtime_image_presentation",
    "normalize_anima_display_name",
]

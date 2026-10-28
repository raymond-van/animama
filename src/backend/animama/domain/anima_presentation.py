"""Safe, lightweight presentation data for Anima navigation surfaces."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from animama.domain.content_catalog import ContentSource


@dataclass(frozen=True, slots=True)
class RuntimeImagePresentation:
    """Normalized crop data shared by lightweight image consumers."""

    fit: str
    focal_x: float
    focal_y: float
    zoom: float


@dataclass(frozen=True, slots=True)
class RuntimeImageReference:
    """A bounded image reference safe to expose to browser navigation UI."""

    source_type: str
    url: str
    content_type: str
    width: int
    height: int
    content_revision: str
    presentation: RuntimeImagePresentation


@dataclass(frozen=True, slots=True)
class AnimaPresentation:
    """Presentation-only projection that avoids resolving a full runtime catalog."""

    anima_id: str
    presentation_revision: str
    display_name: str
    profile_thumbnail: RuntimeImageReference | None


@dataclass(frozen=True, slots=True)
class AnimaPresentationImageCandidate:
    """One Included or Local catalog image candidate."""

    slot: str
    source_type: str
    builtin_id: str | None = None
    builtin_version: int | None = None
    catalog_item_id: str | None = None
    config: dict[str, Any] = field(default_factory=dict)
    file_ref: str | None = None
    content_type: str | None = None
    size_bytes: int | None = None
    sha256: str | None = None
    width: int | None = None
    height: int | None = None
    # The catalog source decides whether the image's URL names its digest.
    source: ContentSource | None = None


@dataclass(frozen=True, slots=True)
class AnimaPresentationRecord:
    """Both image candidates needed to apply presentation precedence."""

    anima_id: str
    display_name: str
    starter_catalog_version: int | None = None
    profile_image: AnimaPresentationImageCandidate | None = None
    avatar_portrait: AnimaPresentationImageCandidate | None = None
    primary_model: AnimaPresentationImageCandidate | None = None


__all__ = [
    "AnimaPresentation",
    "AnimaPresentationImageCandidate",
    "AnimaPresentationRecord",
    "RuntimeImagePresentation",
    "RuntimeImageReference",
]

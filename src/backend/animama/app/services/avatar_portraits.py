"""Which Appearance is an Avatar's portrait.

A portrait records its Avatar's exact catalog item in
``presentation.avatar_item_id`` (captured Local portraits and imported ones).
An Included Avatar without one falls back to the Included portrait whose
``avatar_model`` names its model file stem.
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import PurePosixPath

from animama.app.services.content_file_urls import content_file_url
from animama.domain.content_catalog import CatalogContentEntry, ContentKind, ContentSource


def portrait_matches(
    avatar: CatalogContentEntry, appearances: Iterable[CatalogContentEntry]
) -> list[CatalogContentEntry]:
    """Return the Avatar's portrait candidates, ordered by catalog item id.

    ``appearances`` are the caller's visible valid catalog items; other kinds
    are ignored. Exact associations win over the Included stem fallback.
    """

    candidates = [item for item in appearances if item.kind is ContentKind.APPEARANCE]
    exact = [
        item
        for item in candidates
        if isinstance(item.metadata.get("presentation"), dict)
        and item.metadata["presentation"].get("avatar_item_id") == avatar.id
    ]
    if exact or avatar.source is not ContentSource.INCLUDED:
        return sorted(exact, key=lambda item: item.id)
    stem = PurePosixPath(avatar.relative_locator).stem
    return sorted(
        (
            item
            for item in candidates
            if item.source is ContentSource.INCLUDED and item.metadata.get("avatar_model") == stem
        ),
        key=lambda item: item.id,
    )


def portrait_image_url(portrait: CatalogContentEntry) -> str | None:
    """The protected delivery URL of a portrait's image file, digest-keyed when Included."""

    image = next((file for file in portrait.files if file.role == "image"), None)
    if image is None:
        return None
    return content_file_url(file_ref=image.file_ref, sha256=image.sha256, source=image.source)

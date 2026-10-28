"""Which Appearance the catalog, typed routes and exports treat as an Avatar's portrait."""

from __future__ import annotations

from animama.app.services.avatar_portraits import portrait_image_url, portrait_matches
from animama.domain.content_catalog import (
    CatalogContentEntry,
    CatalogContentFile,
    ContentKind,
    ContentScope,
    ContentSource,
    ContentStatus,
)


def _item(
    item_id: str,
    *,
    kind: ContentKind = ContentKind.APPEARANCE,
    source: ContentSource = ContentSource.LOCAL,
    locator: str | None = None,
    metadata: dict[str, object] | None = None,
) -> CatalogContentEntry:
    locator = locator or f"appearances/{item_id}.webp"
    return CatalogContentEntry(
        id=item_id,
        source=source,
        scope=ContentScope.INCLUDED if source is ContentSource.INCLUDED else ContentScope.OWNER,
        owner_user_id=None if source is ContentSource.INCLUDED else "owner",
        kind=kind,
        relative_locator=locator,
        display_name=item_id,
        status=ContentStatus.VALID,
        revision_sha256="a" * 64,
        files=(
            CatalogContentFile(
                file_ref=f"{item_id}-file",
                item_id=item_id,
                source=source,
                relative_path=locator,
                role="image" if kind is ContentKind.APPEARANCE else "model",
                media_type="image/webp",
                size_bytes=1,
                sha256="b" * 64,
            ),
        ),
        metadata=metadata or {},
    )


def _exact(item_id: str, avatar_id: str, **kwargs: object) -> CatalogContentEntry:
    return _item(item_id, metadata={"presentation": {"avatar_item_id": avatar_id}}, **kwargs)  # type: ignore[arg-type]


def test_a_local_avatar_has_only_its_exact_portrait() -> None:
    avatar = _item("avatar", kind=ContentKind.AVATAR, locator="avatars/Andrew.vrm")
    included_by_stem = _item("included", source=ContentSource.INCLUDED, metadata={"avatar_model": "Andrew"})
    other = _exact("other", "another-avatar")

    assert portrait_matches(avatar, [included_by_stem, other]) == []
    assert portrait_matches(avatar, [included_by_stem, other, _exact("mine", "avatar")]) == [_exact("mine", "avatar")]


def test_an_included_avatar_prefers_an_exact_portrait_over_its_stem() -> None:
    avatar = _item("avatar", kind=ContentKind.AVATAR, source=ContentSource.INCLUDED, locator="avatars/Andrew.vrm")
    by_stem = _item("included", source=ContentSource.INCLUDED, metadata={"avatar_model": "Andrew"})
    local_named_like_it = _item("local", metadata={"avatar_model": "Andrew"})

    assert portrait_matches(avatar, [local_named_like_it, by_stem]) == [by_stem]
    assert portrait_matches(avatar, [by_stem, _exact("exact", "avatar")]) == [_exact("exact", "avatar")]
    # An Included portrait's URL names its digest; a Local one keeps its registration URL.
    assert portrait_image_url(by_stem) == f"/v1/content/files/included-file/sha256/{'b' * 64}"
    assert portrait_image_url(local_named_like_it) == "/v1/content/files/local-file"


def test_matches_are_ordered_and_ignore_other_kinds() -> None:
    avatar = _item("avatar", kind=ContentKind.AVATAR, locator="avatars/A.vrm")
    not_an_image = _item("z", kind=ContentKind.GESTURE, metadata={"presentation": {"avatar_item_id": "avatar"}})

    matches = portrait_matches(avatar, [_exact("b", "avatar"), not_an_image, _exact("a", "avatar")])

    assert [item.id for item in matches] == ["a", "b"]
    assert portrait_image_url(matches[0]) == "/v1/content/files/a-file"

"""The delivery URL that descriptors name for one registered content file (ADR 0033)."""

from __future__ import annotations

from urllib.parse import quote

from animama.domain.content_catalog import ContentSource


def content_file_url(*, file_ref: str, sha256: str, source: ContentSource | None) -> str:
    """Name an Included file by its digest and any other file by its registration alone.

    An Included file's ``file_ref`` survives a release that changes its bytes, so only
    a URL that also names the digest changes with them; a client may keep that reply
    as immutable. Owner and installation-shared files keep the revalidated URL.
    """

    ref = quote(file_ref, safe="")
    if source is ContentSource.INCLUDED:
        return f"/v1/content/files/{ref}/sha256/{sha256}"
    return f"/v1/content/files/{ref}"


__all__ = ["content_file_url"]

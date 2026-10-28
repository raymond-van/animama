"""Library-sized previews of registered content images.

Effect art is often a large flipbook sheet or texture, while the Library shows it
in a 40-pixel tile. ``thumbnail_file`` re-encodes a raster image as WebP no larger
than ``THUMBNAIL_EDGE`` on either side, so a Library page downloads kilobytes per
card instead of the full art. Decoding uses the bounded image reader shared with
saved images, so an over-budget canvas is refused from its header. A source is
shrunk before it is oriented, a JPEG decodes at a reduced scale, and a source that
would decode to more than ``THUMBNAIL_MAX_DECODED_PIXELS`` (a PNG or WebP larger
than any canonical image) is refused, so one preview holds a bounded amount of
memory; the Library then shows the item's icon. At most ``THUMBNAIL_DECODE_SLOTS``
sources decode at once in a process. Thumbnails are cached in process by
the source's SHA-256, so the cache is content-addressed and is consulted only after
the caller has authorized and verified the source file.
"""

from __future__ import annotations

import hashlib
import threading
from collections import OrderedDict
from io import BytesIO

from animama.app.services.content_file_validation import ContentFileInvalidError
from animama.app.services.content_image import derive_image_thumbnail
from animama.domain.content_catalog import VerifiedContentFile

# Twice the largest tile the Library draws, for high-density displays. Browsers keep
# an Included image's thumbnail for a year under its digest URL (ADR 0033), so a
# change to the size or encoding that must reach them needs a new variant name.
THUMBNAIL_EDGE = 128
THUMBNAIL_MEDIA_TYPE = "image/webp"
_RASTER_EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
# Vector art is already small and scales without loss.
_PASSTHROUGH_TYPES = frozenset({"image/svg+xml"})
# Roughly 1,500 thumbnails.
_CACHE_MAX_BYTES = 8 * 1024 * 1024
# Every canonical image (at most 4096 px a side) previews; a larger PNG or WebP (an
# Appearance image up to 40 megapixels, or a pack or Scene Effect raster that saving
# never canonicalized) would hold several hundred MiB to decode.
THUMBNAIL_MAX_DECODED_PIXELS = 4096 * 4096
# Decodes at once per process. A cold Library page holds this many decoded sources
# rather than one per tile, and cache hits never wait; more decodes than a couple of
# cores gain little.
THUMBNAIL_DECODE_SLOTS = 2
_DECODE_SLOTS = threading.BoundedSemaphore(THUMBNAIL_DECODE_SLOTS)


class ContentThumbnailError(ValueError):
    """The registered file is not an image Animama can preview at thumbnail size."""


class _ThumbnailCache:
    """Least-recently-used thumbnails bounded by their total encoded size."""

    def __init__(self, max_bytes: int) -> None:
        self._max_bytes = max_bytes
        self._entries: OrderedDict[str, bytes] = OrderedDict()
        self._size = 0
        self._lock = threading.Lock()

    def get(self, sha256: str) -> bytes | None:
        with self._lock:
            data = self._entries.get(sha256)
            if data is not None:
                self._entries.move_to_end(sha256)
            return data

    def put(self, sha256: str, data: bytes) -> None:
        with self._lock:
            if sha256 in self._entries:
                return
            self._entries[sha256] = data
            self._size += len(data)
            while self._size > self._max_bytes:
                _, evicted = self._entries.popitem(last=False)
                self._size -= len(evicted)


_cache = _ThumbnailCache(_CACHE_MAX_BYTES)


def thumbnail_file(file: VerifiedContentFile) -> VerifiedContentFile:
    """Return ``file`` as a Library-sized image, taking ownership of its handle.

    Vector images and rasters already within ``THUMBNAIL_EDGE`` come back unchanged;
    larger rasters come back as an in-memory WebP (first frame, EXIF orientation
    applied) whose digest is its ETag. Blocks on image decoding, so callers run it
    in a worker thread.
    """

    if file.media_type in _PASSTHROUGH_TYPES:
        return file
    extension = _RASTER_EXTENSIONS.get(file.media_type)
    if extension is None:
        file.handle.close()
        raise ContentThumbnailError(f"{file.media_type} has no thumbnail")
    data = _cache.get(file.sha256)
    if data is None:
        with _DECODE_SLOTS:
            # Another request may have decoded the same source while this one waited.
            data = _cache.get(file.sha256)
            if data is None:
                try:
                    derived = derive_image_thumbnail(
                        extension=extension,
                        content=file.handle,
                        max_dimension=THUMBNAIL_EDGE,
                        first_frame=True,
                        max_decoded_pixels=THUMBNAIL_MAX_DECODED_PIXELS,
                    )
                except ContentFileInvalidError as exc:
                    file.handle.close()
                    raise ContentThumbnailError("registered image cannot be previewed") from exc
                if derived.source_width <= THUMBNAIL_EDGE and derived.source_height <= THUMBNAIL_EDGE:
                    # Small sources are cheap to re-check and are not worth a cache entry.
                    file.handle.seek(0)
                    return file
                data = derived.content
                _cache.put(file.sha256, data)
    file.handle.close()
    return VerifiedContentFile(
        handle=BytesIO(data),
        size_bytes=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        media_type=THUMBNAIL_MEDIA_TYPE,
    )


__all__ = ["THUMBNAIL_EDGE", "THUMBNAIL_MAX_DECODED_PIXELS", "ContentThumbnailError", "thumbnail_file"]

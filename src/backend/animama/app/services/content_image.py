"""Bounded image-content validation, canonicalization, and thumbnail derivation."""

from __future__ import annotations

import hashlib
import warnings
from dataclasses import dataclass
from io import BytesIO
from typing import BinaryIO, cast

from PIL import Image, ImageOps, ImageStat

from .content_file_validation import ContentFileInvalidError, ContentFileValidation

MAX_IMAGE_PIXELS = 40_000_000
MAX_APPEARANCE_SOURCE_BYTES = 16 * 1024 * 1024
MAX_APPEARANCE_DIMENSION = 8192
MAX_IMAGE_DIMENSION = 16_384
CANONICAL_IMAGE_MAX_DIMENSION = 4096
# The canonicalizer serves several product families. Family-specific ready
# policies apply their lower budgets (for example Avatar Effects at 16 MiB).
CANONICAL_IMAGE_MAX_BYTES = 32 * 1024 * 1024
THUMBNAIL_MAX_DIMENSION = 256
THUMBNAIL_MAX_BYTES = 256 * 1024
AVATAR_PORTRAIT_SOURCE_DIMENSION = 1024
AVATAR_PORTRAIT_DIMENSION = 512
AVATAR_PORTRAIT_MAX_BYTES = 256 * 1024
CHAT_IMAGE_MAX_DIMENSION = 2000
# 3.5 MiB stays under 5 MB once base64-encoded, the strictest per-image limit
# among the model providers a chat image is sent to.
CHAT_IMAGE_MAX_BYTES = 3_670_016
_CHAT_IMAGE_JPEG_QUALITIES = (90, 82, 74, 66, 58, 50)
_CHAT_IMAGE_FORMATS = frozenset({"PNG", "JPEG", "MPO", "WEBP", "GIF"})
# Screenshots and drawings arrive in these formats; they stay lossless when they fit.
_LOSSLESS_CHAT_IMAGE_FORMATS = frozenset({"PNG", "GIF"})
_EXIF_ORIENTATION_TAG = 0x0112
_EXIF_TRANSPOSITIONS = {
    2: Image.Transpose.FLIP_LEFT_RIGHT,
    3: Image.Transpose.ROTATE_180,
    4: Image.Transpose.FLIP_TOP_BOTTOM,
    5: Image.Transpose.TRANSPOSE,
    6: Image.Transpose.ROTATE_270,
    7: Image.Transpose.TRANSVERSE,
    8: Image.Transpose.ROTATE_90,
}
_FORMATS_BY_EXTENSION = {
    "png": frozenset({"PNG"}),
    "jpg": frozenset({"JPEG", "MPO"}),
    "jpeg": frozenset({"JPEG", "MPO"}),
    "webp": frozenset({"WEBP"}),
}
_CONTENT_TYPE_BY_FORMAT = {
    "PNG": "image/png",
    "JPEG": "image/jpeg",
    "MPO": "image/jpeg",
    "WEBP": "image/webp",
}
_SOURCE_CONTAINER_BY_FORMAT = {
    "PNG": "png",
    "JPEG": "jpeg",
    "MPO": "mpo",
    "WEBP": "webp",
}


@dataclass(frozen=True, slots=True)
class CanonicalImage:
    """Metadata and stripped static WebP bytes for one accepted source image."""

    content: bytes
    width: int
    height: int
    source_width: int
    source_height: int
    source_container: str
    source_frame_count: int
    has_alpha: bool
    warnings: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class DerivedImageThumbnail:
    """Metadata and stripped WebP bytes for one system-owned derivative."""

    content: bytes
    width: int
    height: int
    source_width: int
    source_height: int
    sha256: str


@dataclass(frozen=True, slots=True)
class CanonicalAvatarPortrait:
    """Opaque bounded WebP derived from a browser-generated model portrait."""

    content: bytes
    width: int
    height: int
    source_width: int
    source_height: int
    sha256: str


@dataclass(frozen=True, slots=True)
class CanonicalChatImage:
    """Stripped PNG or JPEG bytes of one chat image, ready to store and send to a model."""

    content: bytes
    media_type: str
    width: int
    height: int
    sha256: str


class _BorrowedImageStream:
    """Expose a seekable stream to Pillow without transferring close ownership."""

    def __init__(self, stream: BinaryIO) -> None:
        self._stream = stream

    def read(self, size: int = -1) -> bytes:
        return self._stream.read(size)

    def readline(self, size: int = -1) -> bytes:
        return self._stream.readline(size)

    def seek(self, offset: int, whence: int = 0) -> int:
        return self._stream.seek(offset, whence)

    def tell(self) -> int:
        return self._stream.tell()

    def close(self) -> None:
        """Let Pillow close its view while preserving the caller-owned stream."""


def validate_appearance_image_stream(
    *,
    extension: str,
    content: BinaryIO,
    size_bytes: int,
    declared_content_type: str | None = None,
) -> ContentFileValidation:
    """Decode a bounded still Appearance image; never trust a MIME declaration."""

    if not 0 < size_bytes <= MAX_APPEARANCE_SOURCE_BYTES:
        raise ContentFileInvalidError(field="file", reason="appearance_image_size_limit")
    image, source_format, width, height, frames = _open_bounded_image(extension=extension, content=content)
    try:
        if frames != 1 or source_format == "MPO":
            raise ContentFileInvalidError(field="file", reason="animated_image_unsupported")
        if max(width, height) > MAX_APPEARANCE_DIMENSION:
            raise ContentFileInvalidError(field="file", reason="image_pixel_budget")
        detected = _CONTENT_TYPE_BY_FORMAT[source_format]
        if declared_content_type is not None and declared_content_type.split(";", 1)[0].strip().lower() != detected:
            raise ContentFileInvalidError(field="file", reason="image_media_type_mismatch")
        image.load()
    except ContentFileInvalidError:
        raise
    except (EOFError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise ContentFileInvalidError(field="file", reason="invalid_image") from exc
    finally:
        image.close()
    return ContentFileValidation(detected, {"width": width, "height": height, "frame_count": frames})


def canonicalize_image_stream(
    *,
    extension: str,
    content: BinaryIO,
) -> CanonicalImage:
    """Decode an allowed static source and produce one bounded metadata-free WebP."""

    image, source_format, source_width, source_height, frame_count = _open_bounded_image(
        extension=extension,
        content=content,
    )
    stripped: Image.Image | None = None
    oriented: Image.Image | None = None
    try:
        _require_supported_frame_policy(source_format, frame_count)
        image.seek(0)
        image.load()
        has_alpha = "A" in image.getbands() or "transparency" in image.info
        oriented = ImageOps.exif_transpose(image)
        oriented_size = oriented.size
        oriented.thumbnail(
            (CANONICAL_IMAGE_MAX_DIMENSION, CANONICAL_IMAGE_MAX_DIMENSION),
            Image.Resampling.LANCZOS,
        )
        mode = "RGBA" if has_alpha else "RGB"
        stripped = Image.new(mode, oriented.size)
        stripped.paste(oriented.convert(mode))
        encoded = _encode_bounded_webp(
            stripped,
            maximum_bytes=CANONICAL_IMAGE_MAX_BYTES,
        )
        width, height = stripped.size
    except ContentFileInvalidError:
        raise
    except (EOFError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise ContentFileInvalidError(field="file", reason="invalid_image") from exc
    finally:
        if stripped is not None:
            stripped.close()
        if oriented is not None:
            oriented.close()
        image.close()

    result_warnings: list[str] = []
    if source_format == "MPO" and frame_count > 1:
        result_warnings.append("multi_picture_primary_frame_selected")
    if (width, height) != oriented_size:
        result_warnings.append("image_resized_to_runtime_limit")
    return CanonicalImage(
        content=encoded,
        width=width,
        height=height,
        source_width=source_width,
        source_height=source_height,
        source_container=_SOURCE_CONTAINER_BY_FORMAT[source_format],
        source_frame_count=frame_count,
        has_alpha=has_alpha,
        warnings=tuple(result_warnings),
    )


def derive_image_thumbnail(
    *,
    extension: str,
    content: BinaryIO,
    max_dimension: int = THUMBNAIL_MAX_DIMENSION,
    first_frame: bool = False,
    max_decoded_pixels: int | None = None,
) -> DerivedImageThumbnail:
    """Resize a bounded image without upscaling and encode it as WebP.

    By default the source must be a canonical static image; ``first_frame``
    instead accepts an animated source and keeps its first frame. The image is
    shrunk before EXIF orientation, so no full-size oriented copy is made (resampling an
    image with alpha still holds one premultiplied working copy); a JPEG decodes at a
    reduced scale. A decoded size above ``max_decoded_pixels`` is refused from the
    header (``image_pixel_budget``).
    """

    image, source_format, source_width, source_height, frame_count = _open_bounded_image(
        extension=extension,
        content=content,
    )
    stripped: Image.Image | None = None
    try:
        if not first_frame:
            _require_supported_frame_policy(source_format, frame_count)
        image.seek(0)
        # A JPEG decodes at the smallest scale that still leaves the resampling headroom
        # ``thumbnail`` keeps (its default reducing gap of 2); other formats decode whole.
        image.draft(None, (max_dimension * 2, max_dimension * 2))
        if max_decoded_pixels is not None and image.width * image.height > max_decoded_pixels:
            raise ContentFileInvalidError(field="file", reason="image_pixel_budget")
        image.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)
        oriented = ImageOps.exif_transpose(image)
        has_alpha = "A" in oriented.getbands() or "transparency" in oriented.info
        mode = "RGBA" if has_alpha else "RGB"
        stripped = Image.new(mode, oriented.size)
        stripped.paste(oriented.convert(mode))
        encoded = _encode_bounded_webp(
            stripped,
            maximum_bytes=THUMBNAIL_MAX_BYTES,
        )
        width, height = stripped.size
        oriented.close()
    except ContentFileInvalidError:
        raise
    except (EOFError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise ContentFileInvalidError(field="file", reason="invalid_image") from exc
    finally:
        if stripped is not None:
            stripped.close()
        image.close()
    return DerivedImageThumbnail(
        content=encoded,
        width=width,
        height=height,
        source_width=source_width,
        source_height=source_height,
        sha256=hashlib.sha256(encoded).hexdigest(),
    )


def canonicalize_avatar_portrait(*, content: BinaryIO) -> CanonicalAvatarPortrait:
    """Validate one 1024-square static WebP and downscale it to the 512-square portrait."""

    image, source_format, source_width, source_height, frame_count = _open_bounded_image(
        extension="webp",
        content=content,
    )
    oriented: Image.Image | None = None
    rgba: Image.Image | None = None
    resized: Image.Image | None = None
    try:
        _require_supported_frame_policy(source_format, frame_count)
        if (source_width, source_height) != (
            AVATAR_PORTRAIT_SOURCE_DIMENSION,
            AVATAR_PORTRAIT_SOURCE_DIMENSION,
        ):
            raise ContentFileInvalidError(field="file", reason="avatar_portrait_dimensions")
        image.seek(0)
        image.load()
        oriented = ImageOps.exif_transpose(image)
        rgba = oriented.convert("RGBA")
        alpha_histogram = rgba.getchannel("A").histogram()
        visible_pixels = sum(alpha_histogram[16:])
        if visible_pixels < max(64, source_width * source_height // 100):
            raise ContentFileInvalidError(field="file", reason="avatar_portrait_transparent")

        if max(ImageStat.Stat(rgba).var) < 4:
            raise ContentFileInvalidError(field="file", reason="avatar_portrait_blank")
        transparent_pixels = sum(alpha_histogram[:240])
        if transparent_pixels < max(64, source_width * source_height // 100):
            raise ContentFileInvalidError(
                field="file",
                reason="avatar_portrait_background_opaque",
            )

        resized = rgba.resize(
            (AVATAR_PORTRAIT_DIMENSION, AVATAR_PORTRAIT_DIMENSION),
            Image.Resampling.LANCZOS,
        )
        encoded = _encode_bounded_webp(
            resized,
            maximum_bytes=AVATAR_PORTRAIT_MAX_BYTES,
        )
    except ContentFileInvalidError:
        raise
    except (EOFError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise ContentFileInvalidError(field="file", reason="invalid_image") from exc
    finally:
        if resized is not None:
            resized.close()
        if rgba is not None:
            rgba.close()
        if oriented is not None:
            oriented.close()
        image.close()

    return CanonicalAvatarPortrait(
        content=encoded,
        width=AVATAR_PORTRAIT_DIMENSION,
        height=AVATAR_PORTRAIT_DIMENSION,
        source_width=source_width,
        source_height=source_height,
        sha256=hashlib.sha256(encoded).hexdigest(),
    )


def canonicalize_chat_image_stream(
    *,
    content: BinaryIO,
    maximum_bytes: int = CHAT_IMAGE_MAX_BYTES,
    maximum_dimension: int = CHAT_IMAGE_MAX_DIMENSION,
) -> CanonicalChatImage:
    """Turn an uploaded chat image into the one copy that is stored and sent to models.

    The image is recognised by its bytes, whatever the upload was called: PNG, JPEG,
    WebP or GIF. An animation contributes its first frame. The result has its EXIF
    orientation applied, a long edge of at most ``maximum_dimension`` (a chat image's
    ``CHAT_IMAGE_MAX_DIMENSION`` unless the caller has a bound of its own) and no
    metadata (EXIF, GPS location, text chunks or colour profile). It is PNG for a
    lossless source that fits ``maximum_bytes``, otherwise JPEG with transparency
    flattened onto white. WebP is never produced: OpenAI-compatible local servers
    do not all accept it.
    """

    image, source_format, _width, _height, _frames = _open_bounded_formats(
        allowed_formats=_CHAT_IMAGE_FORMATS,
        content=content,
    )
    working: list[Image.Image] = []
    try:
        try:
            image.seek(0)
            image.load()
            mode = "RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB"
            # Convert before scaling: Pillow scales palette and 1-bit images with
            # nearest-neighbour, which destroys small text in a GIF or palette PNG.
            pixels = _eight_bit(image).convert(mode)
            working.append(pixels)
            pixels.thumbnail((maximum_dimension, maximum_dimension), Image.Resampling.LANCZOS)
            transposition = _EXIF_TRANSPOSITIONS.get(_exif_orientation(image) or 0)
            if transposition is not None:
                pixels = pixels.transpose(transposition)
                working.append(pixels)
            # Pasting into a new image leaves every kind of source metadata behind.
            stripped = Image.new(mode, pixels.size)
            working.append(stripped)
            stripped.paste(pixels)
        except MemoryError:
            raise
        except Exception as exc:
            # Pillow's decoders raise many types on damaged input (SyntaxError,
            # IndexError, struct.error and more). All of them mean the same thing here.
            raise ContentFileInvalidError(field="file", reason="invalid_image") from exc
        # Nothing below reads the uploaded bytes. A failure from here on, other
        # than the size limit, is a server fault and not a bad image: it
        # propagates, so the caller keeps the upload instead of refusing it.
        encoded, media_type = _encode_chat_image(
            stripped,
            lossless_source=source_format in _LOSSLESS_CHAT_IMAGE_FORMATS,
            maximum_bytes=maximum_bytes,
        )
        width, height = stripped.size
    finally:
        for temporary in working:
            temporary.close()
        image.close()
    return CanonicalChatImage(
        content=encoded,
        media_type=media_type,
        width=width,
        height=height,
        sha256=hashlib.sha256(encoded).hexdigest(),
    )


def _eight_bit(image: Image.Image) -> Image.Image:
    """Scale a 16-bit greyscale image to 8 bits; converting it directly clips to white."""

    if not image.mode.startswith("I;16"):
        return image
    return image.convert("I").point(lambda value: value * (1 / 256)).convert("L")


def _exif_orientation(image: Image.Image) -> int | None:
    """Return the EXIF orientation, or None when there is none or the EXIF is damaged.

    ``ImageOps.exif_transpose`` is not used for chat images: it rewrites the EXIF
    block it reads, which fails on a photo with one malformed tag, and that block
    is discarded here anyway.
    """

    try:
        orientation = image.getexif().get(_EXIF_ORIENTATION_TAG)
    except Exception:
        return None
    return orientation if isinstance(orientation, int) else None


def _open_bounded_image(
    *,
    extension: str,
    content: BinaryIO,
) -> tuple[Image.Image, str, int, int, int]:
    """Open a source whose allowed decoders follow from its file extension."""

    allowed_formats = _FORMATS_BY_EXTENSION.get(extension.lower().lstrip("."))
    if allowed_formats is None:
        raise ContentFileInvalidError(field="file", reason="unsupported_image_format")
    return _open_bounded_formats(allowed_formats=allowed_formats, content=content)


def _open_bounded_formats(
    *,
    allowed_formats: frozenset[str],
    content: BinaryIO,
) -> tuple[Image.Image, str, int, int, int]:
    """Open untrusted bytes with only the allowed decoders, within the pixel limits."""

    content.seek(0)
    # MPO has no decoder of its own; the JPEG decoder recognises it.
    decoders = sorted(allowed_formats - {"MPO"})
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            # Pillow reads the seek/read/tell interface; it never owns this stream.
            # ``formats`` keeps every other decoder away from the bytes.
            image = Image.open(cast(BinaryIO, _BorrowedImageStream(content)), formats=decoders)
            source_format = image.format or ""
            width, height = image.size
            frame_count = int(getattr(image, "n_frames", 1))
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ContentFileInvalidError(field="file", reason="image_pixel_budget") from exc
    except MemoryError:
        raise
    except Exception as exc:
        # Unrecognised bytes, or a header damaged in a way a decoder reports with
        # its own exception type (counting GIF frames can raise IndexError).
        raise ContentFileInvalidError(field="file", reason="unsupported_image_format") from exc
    if source_format not in allowed_formats:
        image.close()
        raise ContentFileInvalidError(field="file", reason="unsupported_image_format")
    if (
        width < 1
        or height < 1
        or width > MAX_IMAGE_DIMENSION
        or height > MAX_IMAGE_DIMENSION
        or width * height > MAX_IMAGE_PIXELS
    ):
        image.close()
        raise ContentFileInvalidError(field="file", reason="image_pixel_budget")
    if frame_count < 1:
        image.close()
        raise ContentFileInvalidError(field="file", reason="invalid_image")
    return image, source_format, width, height, frame_count


def _require_supported_frame_policy(source_format: str, frame_count: int) -> None:
    if source_format in {"PNG", "WEBP"} and frame_count != 1:
        raise ContentFileInvalidError(field="file", reason="animated_image_unsupported")


def _encode_bounded_webp(
    image: Image.Image,
    *,
    maximum_bytes: int,
) -> bytes:
    """Use one explicit encoder ladder so the pinned Pillow build is repeatable.

    ``method=5`` rather than the maximum 6: with lossless alpha, 6 takes
    seconds for a 512-square image for files under 2% smaller.
    """

    for quality in (90, 82, 74, 66, 58, 50, 42, 34):
        output = BytesIO()
        image.save(
            output,
            format="WEBP",
            quality=quality,
            alpha_quality=100,
            method=5,
            exact=True,
            lossless=False,
            exif=b"",
            icc_profile=None,
            xmp=b"",
        )
        encoded = output.getvalue()
        if 0 < len(encoded) <= maximum_bytes:
            return encoded
    raise ContentFileInvalidError(field="file", reason="canonical_image_size_limit")


def _encode_chat_image(
    image: Image.Image,
    *,
    lossless_source: bool,
    maximum_bytes: int,
) -> tuple[bytes, str]:
    """Return the encoded chat image and its media type."""

    if lossless_source:
        output = BytesIO()
        image.save(output, format="PNG")
        encoded = output.getvalue()
        if 0 < len(encoded) <= maximum_bytes:
            return encoded, "image/png"
    opaque = _flattened_onto_white(image)
    try:
        return _encode_chat_jpeg(opaque, maximum_bytes=maximum_bytes), "image/jpeg"
    finally:
        if opaque is not image:
            opaque.close()


def _flattened_onto_white(image: Image.Image) -> Image.Image:
    """Return an opaque image; JPEG has no transparency, and white suits screenshots."""

    if image.mode != "RGBA":
        return image
    opaque = Image.new("RGB", image.size, (255, 255, 255))
    opaque.paste(image, mask=image.getchannel("A"))
    return opaque


def _jpeg_bytes(image: Image.Image, *, quality: int) -> bytes:
    """Encode one JPEG attempt.

    Colour is kept at full resolution (``subsampling=0``) so small coloured text in
    a screenshot stays readable to a model. ``optimize`` stays off: Pillow then
    needs the whole file in one buffer sized from the pixel count, which a noisy
    photo at this quality overflows ("broken data stream").
    """

    output = BytesIO()
    image.save(output, format="JPEG", quality=quality, subsampling=0)
    return output.getvalue()


def _encode_chat_jpeg(image: Image.Image, *, maximum_bytes: int) -> bytes:
    """Encode an opaque image as JPEG within ``maximum_bytes``, or refuse it.

    Nearly every image fits at the first quality. A very detailed one steps down;
    below the last step text in the image stops being reliably readable, so the
    image is refused instead.
    """

    for quality in _CHAT_IMAGE_JPEG_QUALITIES:
        encoded = _jpeg_bytes(image, quality=quality)
        if 0 < len(encoded) <= maximum_bytes:
            return encoded
    raise ContentFileInvalidError(field="file", reason="canonical_image_size_limit")


__all__ = [
    "AVATAR_PORTRAIT_DIMENSION",
    "AVATAR_PORTRAIT_MAX_BYTES",
    "AVATAR_PORTRAIT_SOURCE_DIMENSION",
    "CANONICAL_IMAGE_MAX_BYTES",
    "CANONICAL_IMAGE_MAX_DIMENSION",
    "CHAT_IMAGE_MAX_BYTES",
    "CHAT_IMAGE_MAX_DIMENSION",
    "CanonicalAvatarPortrait",
    "CanonicalChatImage",
    "CanonicalImage",
    "DerivedImageThumbnail",
    "MAX_IMAGE_DIMENSION",
    "MAX_IMAGE_PIXELS",
    "THUMBNAIL_MAX_BYTES",
    "THUMBNAIL_MAX_DIMENSION",
    "canonicalize_avatar_portrait",
    "canonicalize_chat_image_stream",
    "canonicalize_image_stream",
    "derive_image_thumbnail",
]

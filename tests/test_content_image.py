from __future__ import annotations

import hashlib
import random
import struct
from io import BytesIO

import pytest
from PIL import Image, ImageDraw, ImageSequence
from PIL.PngImagePlugin import PngInfo

from animama.app.services import content_image
from animama.app.services.content_file_validation import ContentFileInvalidError as ContentFileInvalidError
from animama.app.services.content_image import (
    CANONICAL_IMAGE_MAX_DIMENSION,
    CHAT_IMAGE_MAX_DIMENSION,
    canonicalize_avatar_portrait,
    canonicalize_chat_image_stream,
    canonicalize_image_stream,
)


def _encoded(
    image: Image.Image,
    format_name: str,
    **options: object,
) -> bytes:
    output = BytesIO()
    image.save(output, format=format_name, **options)
    return output.getvalue()


def _pixel(image: Image.Image, xy: tuple[int, int]) -> tuple[int, ...]:
    """Return a multi-band pixel; Pillow types getpixel() for every image mode."""
    pixel = image.getpixel(xy)
    assert isinstance(pixel, tuple)
    return pixel


@pytest.mark.parametrize(
    ("format_name", "extension", "mode"),
    [
        ("JPEG", "jpg", "RGB"),
        ("JPEG", "jpeg", "CMYK"),
        ("PNG", "png", "P"),
        ("WEBP", "webp", "RGBA"),
    ],
)
def test_static_sources_become_stripped_bounded_webp(
    format_name: str,
    extension: str,
    mode: str,
) -> None:
    if mode == "P":
        source = Image.new("P", (12, 8))
        source.putpalette([255, 0, 0, 0, 0, 0] + [0] * 762)
        source.info["transparency"] = 1
        source.putpixel((11, 7), 1)
    elif mode == "CMYK":
        source = Image.new(mode, (12, 8), (0, 255, 255, 0))
    else:
        source = Image.new(mode, (12, 8), (255, 0, 0, 128) if mode == "RGBA" else (255, 0, 0))
    content = _encoded(source, format_name, comment=b"private metadata")

    result = canonicalize_image_stream(
        extension=extension,
        content=BytesIO(content),
    )

    assert result.width == 12
    assert result.height == 8
    assert result.source_frame_count == 1
    assert result.has_alpha is (mode in {"P", "RGBA"})
    with Image.open(BytesIO(result.content)) as canonical:
        assert canonical.format == "WEBP"
        assert canonical.size == (12, 8)
        assert not canonical.getexif()
        assert "icc_profile" not in canonical.info
        assert "comment" not in canonical.info
        red, green, blue, alpha = _pixel(canonical.convert("RGBA"), (0, 0))
        assert abs(red - 255) <= 12
        assert green <= 12
        assert blue <= 12
        expected_alpha = 128 if mode == "RGBA" else 255
        assert abs(alpha - expected_alpha) <= 3
        if mode == "P":
            assert _pixel(canonical.convert("RGBA"), (11, 7))[3] <= 3


def test_large_image_resizes_without_upscaling() -> None:
    source = Image.new("RGB", (5000, 2500), (30, 60, 90))
    result = canonicalize_image_stream(
        extension="png",
        content=BytesIO(_encoded(source, "PNG")),
    )

    assert result.width == CANONICAL_IMAGE_MAX_DIMENSION
    assert result.height == 2048
    assert result.warnings == ("image_resized_to_runtime_limit",)


def test_exif_orientation_is_applied_before_metadata_is_removed() -> None:
    source = Image.new("RGB", (10, 20), "red")
    exif = source.getexif()
    exif[274] = 6

    result = canonicalize_image_stream(
        extension="jpg",
        content=BytesIO(_encoded(source, "JPEG", exif=exif)),
    )

    assert (result.source_width, result.source_height) == (10, 20)
    assert (result.width, result.height) == (20, 10)
    with Image.open(BytesIO(result.content)) as canonical:
        assert not canonical.getexif()


def test_mpo_selects_primary_picture_and_warns() -> None:
    primary = Image.new("RGB", (8, 6), "red")
    secondary = Image.new("RGB", (8, 6), "blue")
    source = _encoded(
        primary,
        "MPO",
        save_all=True,
        append_images=[secondary],
    )

    result = canonicalize_image_stream(
        extension="jpg",
        content=BytesIO(source),
    )

    assert result.source_container == "mpo"
    assert result.source_frame_count == 2
    assert result.warnings == ("multi_picture_primary_frame_selected",)
    with Image.open(BytesIO(result.content)) as canonical:
        red, green, blue = _pixel(canonical.convert("RGB"), (0, 0))
        assert red > 200
        assert green < 50
        assert blue < 50


@pytest.mark.parametrize("format_name,extension", [("PNG", "png"), ("WEBP", "webp")])
def test_animated_png_and_webp_are_rejected(
    format_name: str,
    extension: str,
) -> None:
    frames = [Image.new("RGBA", (4, 4), color) for color in ("red", "blue")]
    source = _encoded(
        frames[0],
        format_name,
        save_all=True,
        append_images=frames[1:],
        duration=100,
        loop=0,
    )
    assert len(list(ImageSequence.Iterator(Image.open(BytesIO(source))))) == 2

    with pytest.raises(ContentFileInvalidError) as caught:
        canonicalize_image_stream(
            extension=extension,
            content=BytesIO(source),
        )

    assert caught.value.reason == "animated_image_unsupported"


def test_renamed_decoder_format_is_rejected() -> None:
    source = _encoded(Image.new("RGB", (4, 4), "red"), "GIF")

    with pytest.raises(ContentFileInvalidError) as caught:
        canonicalize_image_stream(
            extension="png",
            content=BytesIO(source),
        )

    assert caught.value.reason == "unsupported_image_format"


def test_avatar_portrait_preserves_transparency_and_is_metadata_free() -> None:
    source = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    ImageDraw.Draw(source).rectangle((300, 180, 723, 859), fill=(80, 120, 210, 220))
    exif = source.getexif()
    exif[270] = "private"
    content = _encoded(source, "WEBP", lossless=True, exif=exif)

    result = canonicalize_avatar_portrait(content=BytesIO(content))

    assert (result.source_width, result.source_height) == (1024, 1024)
    assert (result.width, result.height) == (512, 512)
    assert len(result.content) <= 256 * 1024
    with Image.open(BytesIO(result.content)) as canonical:
        assert canonical.format == "WEBP"
        assert canonical.mode == "RGBA"
        assert canonical.size == (512, 512)
        assert not canonical.getexif()
        assert _pixel(canonical, (0, 0))[3] <= 3
        assert abs(_pixel(canonical, (512 // 2, 512 // 2))[3] - 220) <= 8


@pytest.mark.parametrize(
    ("source", "reason"),
    [
        (Image.new("RGBA", (1024, 1024), (0, 0, 0, 0)), "avatar_portrait_transparent"),
        (Image.new("RGB", (1024, 1024), "white"), "avatar_portrait_blank"),
        (
            Image.effect_noise((1024, 1024), 100).convert("RGB"),
            "avatar_portrait_background_opaque",
        ),
        # The renderer-version-1 capture size is no longer admitted.
        (Image.new("RGB", (512, 512), "red"), "avatar_portrait_dimensions"),
    ],
)
def test_avatar_portrait_rejects_unusable_sources(source: Image.Image, reason: str) -> None:
    with pytest.raises(ContentFileInvalidError) as caught:
        canonicalize_avatar_portrait(
            content=BytesIO(_encoded(source, "WEBP", lossless=True)),
        )

    assert caught.value.reason == reason


def _noise(size: tuple[int, int] = (256, 256)) -> Image.Image:
    """Return a repeatable incompressible image, the worst case for every encoder."""
    return Image.frombytes("RGB", size, random.Random(7).randbytes(size[0] * size[1] * 3))


def _palette_gif() -> bytes:
    source = Image.new("P", (12, 8))
    source.putpalette([0, 128, 255] + [0] * 765)
    return _encoded(source, "GIF")


@pytest.mark.parametrize(
    ("content", "media_type"),
    [
        (_encoded(Image.new("RGB", (12, 8), (0, 128, 255)), "PNG"), "image/png"),
        (_palette_gif(), "image/png"),
        (_encoded(Image.new("RGB", (12, 8), (0, 128, 255)), "JPEG"), "image/jpeg"),
        (_encoded(Image.new("RGB", (12, 8), (0, 128, 255)), "WEBP", lossless=True), "image/jpeg"),
    ],
    ids=["png", "gif", "jpeg", "webp"],
)
def test_chat_image_keeps_lossless_sources_as_png_and_others_as_jpeg(content: bytes, media_type: str) -> None:
    result = canonicalize_chat_image_stream(content=BytesIO(content))

    assert result.media_type == media_type
    assert (result.width, result.height) == (12, 8)
    assert result.sha256 == hashlib.sha256(result.content).hexdigest()
    with Image.open(BytesIO(result.content)) as canonical:
        assert canonical.format == ("PNG" if media_type == "image/png" else "JPEG")
        assert canonical.size == (12, 8)
        _red, green, blue = _pixel(canonical.convert("RGB"), (6, 4))
        assert blue > 200
        assert 100 < green < 160


@pytest.mark.parametrize("format_name", ["GIF", "WEBP", "PNG"])
def test_chat_image_takes_the_first_frame_of_an_animation(format_name: str) -> None:
    frames = [Image.new("RGB", (6, 6), color) for color in ("red", "blue")]
    source = _encoded(frames[0], format_name, save_all=True, append_images=frames[1:], duration=100, loop=0)
    assert len(list(ImageSequence.Iterator(Image.open(BytesIO(source))))) == 2

    result = canonicalize_chat_image_stream(content=BytesIO(source))

    with Image.open(BytesIO(result.content)) as canonical:
        assert getattr(canonical, "n_frames", 1) == 1
        red, _green, blue = _pixel(canonical.convert("RGB"), (3, 3))
        assert red > 200
        assert blue < 50


def test_chat_image_scales_the_long_edge_without_upscaling() -> None:
    wide = canonicalize_chat_image_stream(content=BytesIO(_encoded(Image.new("RGB", (5000, 1250), "red"), "PNG")))
    small = canonicalize_chat_image_stream(content=BytesIO(_encoded(Image.new("RGB", (40, 30), "red"), "PNG")))

    assert (wide.width, wide.height) == (CHAT_IMAGE_MAX_DIMENSION, 500)
    assert (small.width, small.height) == (40, 30)


def test_chat_image_applies_orientation_and_removes_location_metadata() -> None:
    source = Image.new("RGB", (10, 20), "red")
    exif = source.getexif()
    exif[274] = 6
    exif.get_ifd(0x8825)[2] = (40.0, 26.0, 46.0)  # GPSLatitude
    content = _encoded(source, "JPEG", exif=exif)
    with Image.open(BytesIO(content)) as uploaded:
        assert uploaded.getexif().get_ifd(0x8825)

    result = canonicalize_chat_image_stream(content=BytesIO(content))

    assert (result.width, result.height) == (20, 10)
    with Image.open(BytesIO(result.content)) as canonical:
        assert not canonical.getexif()
        assert not canonical.getexif().get_ifd(0x8825)


def test_chat_image_png_drops_text_chunks() -> None:
    private = PngInfo()
    private.add_text("Comment", "taken at home")
    content = _encoded(Image.new("RGB", (8, 8), "red"), "PNG", pnginfo=private)

    result = canonicalize_chat_image_stream(content=BytesIO(content))

    assert b"taken at home" not in result.content
    with Image.open(BytesIO(result.content)) as canonical:
        assert "Comment" not in canonical.info


def test_chat_image_flattens_transparency_onto_white_for_jpeg() -> None:
    source = Image.new("RGBA", (8, 8), (255, 0, 0, 0))

    result = canonicalize_chat_image_stream(content=BytesIO(_encoded(source, "WEBP", lossless=True)))

    assert result.media_type == "image/jpeg"
    with Image.open(BytesIO(result.content)) as canonical:
        assert min(_pixel(canonical.convert("RGB"), (4, 4))) > 240


@pytest.mark.parametrize(
    ("content", "reason"),
    [
        (b"plain text, whatever the file is called", "unsupported_image_format"),
        (_encoded(Image.new("RGB", (8, 8), "red"), "BMP"), "unsupported_image_format"),
        (_encoded(Image.new("L", (16_385, 1)), "PNG"), "image_pixel_budget"),
        (_encoded(Image.new("RGB", (64, 64), "red"), "PNG")[:120], "invalid_image"),
    ],
    ids=["text", "bmp", "too-wide", "truncated"],
)
def test_chat_image_rejects_what_it_cannot_store(content: bytes, reason: str) -> None:
    with pytest.raises(ContentFileInvalidError) as caught:
        canonicalize_chat_image_stream(content=BytesIO(content))

    assert caught.value.reason == reason


def test_chat_image_lossless_source_over_the_budget_becomes_jpeg() -> None:
    content = _encoded(_noise(), "PNG")

    result = canonicalize_chat_image_stream(content=BytesIO(content), maximum_bytes=len(content) * 3 // 4)

    assert result.media_type == "image/jpeg"
    assert len(result.content) <= len(content) * 3 // 4


def test_chat_image_jpeg_over_the_budget_is_reduced_to_fit() -> None:
    noise = _noise()
    # A budget that quality 60 meets and the first attempt at quality 90 does not.
    budget = len(_encoded(noise, "JPEG", quality=60, subsampling=0))
    assert len(_encoded(noise, "JPEG", quality=90, subsampling=0)) > budget

    result = canonicalize_chat_image_stream(content=BytesIO(_encoded(noise, "JPEG", quality=95)), maximum_bytes=budget)

    assert result.media_type == "image/jpeg"
    assert 0 < len(result.content) <= budget
    with Image.open(BytesIO(result.content)) as canonical:
        canonical.load()


def test_chat_image_that_cannot_fit_the_budget_is_rejected() -> None:
    with pytest.raises(ContentFileInvalidError) as caught:
        canonicalize_chat_image_stream(content=BytesIO(_encoded(_noise(), "JPEG")), maximum_bytes=64)

    assert caught.value.reason == "canonical_image_size_limit"


def test_chat_image_keeps_a_photo_whose_exif_has_a_malformed_tag() -> None:
    source = Image.new("RGB", (40, 20), "red")
    exif = Image.Exif()
    exif[0x0112] = 6
    exif[0x011A] = (72, 1)  # XResolution, a rational
    content = _encoded(source, "JPEG", exif=exif)
    order = ">" if b"MM\x00*" in content else "<"
    # Retype XResolution as ASCII: Pillow can read the orientation but cannot rewrite the block.
    damaged = content.replace(struct.pack(order + "HH", 0x011A, 5), struct.pack(order + "HH", 0x011A, 2))
    assert damaged != content

    result = canonicalize_chat_image_stream(content=BytesIO(damaged))

    assert (result.width, result.height) == (20, 40)


def test_chat_image_rejects_damage_that_a_decoder_reports_in_its_own_way() -> None:
    content = _encoded(_noise(), "PNG")
    assert content.count(b"IDAT") > 1
    first = content.index(b"IDAT")
    second = content.index(b"IDAT", first + 4)
    # A chunk name that is not letters makes Pillow raise SyntaxError, not OSError.
    damaged = content[:second] + bytes([0, 1, 2, 3]) + content[second + 4 :]
    with pytest.raises(SyntaxError), Image.open(BytesIO(damaged)) as broken:
        broken.load()

    with pytest.raises(ContentFileInvalidError) as caught:
        canonicalize_chat_image_stream(content=BytesIO(damaged))

    assert caught.value.reason == "invalid_image"


def test_chat_image_does_not_blame_the_image_for_a_server_fault(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken_encoder(*_args: object, **_kwargs: object) -> tuple[bytes, str]:
        raise RuntimeError("encoder bug")

    monkeypatch.setattr(content_image, "_encode_chat_image", broken_encoder)

    with pytest.raises(RuntimeError, match="encoder bug"):
        canonicalize_chat_image_stream(content=BytesIO(_encoded(Image.new("RGB", (8, 8), "red"), "PNG")))


@pytest.mark.parametrize("size", [(7_000, 6_000), (12_000, 9_000)], ids=["over-the-budget", "decompression-bomb"])
def test_chat_image_over_the_pixel_budget_says_so(size: tuple[int, int]) -> None:
    with pytest.raises(ContentFileInvalidError) as caught:
        canonicalize_chat_image_stream(content=BytesIO(_encoded(Image.new("1", size), "PNG")))

    assert caught.value.reason == "image_pixel_budget"


def test_chat_image_scales_sixteen_bit_greyscale_instead_of_clipping_it() -> None:
    source = Image.new("I;16", (256, 1))
    source.putdata([value * 257 for value in range(256)])

    result = canonicalize_chat_image_stream(content=BytesIO(_encoded(source, "PNG")))

    with Image.open(BytesIO(result.content)) as canonical:
        levels = [_pixel(canonical.convert("RGB"), (x, 0))[0] for x in (0, 64, 128, 255)]
    assert levels == [0, 64, 128, 255]


@pytest.mark.parametrize("format_name", ["GIF", "PNG"])
def test_chat_image_smooths_a_palette_image_when_it_scales_it(format_name: str) -> None:
    stripes = Image.new("P", (4_000, 8))
    stripes.putpalette([0, 0, 0, 255, 255, 255] + [0] * 762)
    stripes.putdata([x % 2 for _y in range(8) for x in range(4_000)])

    result = canonicalize_chat_image_stream(content=BytesIO(_encoded(stripes, format_name)))

    assert result.width == CHAT_IMAGE_MAX_DIMENSION
    with Image.open(BytesIO(result.content)) as canonical:
        # Nearest-neighbour would keep every other column: solid black or solid white.
        assert 64 < _pixel(canonical.convert("RGB"), (1_000, 2))[0] < 192


def test_chat_image_takes_the_primary_picture_of_a_multi_picture_jpeg() -> None:
    source = _encoded(
        Image.new("RGB", (8, 6), "red"), "MPO", save_all=True, append_images=[Image.new("RGB", (8, 6), "blue")]
    )

    result = canonicalize_chat_image_stream(content=BytesIO(source))

    assert result.media_type == "image/jpeg"
    with Image.open(BytesIO(result.content)) as canonical:
        red, _green, blue = _pixel(canonical.convert("RGB"), (4, 3))
        assert red > 200
        assert blue < 50


def test_chat_image_refuses_a_gif_whose_frames_cannot_be_counted() -> None:
    frames = [Image.new("P", (16, 16), index) for index in range(3)]
    for frame in frames:
        frame.putpalette([0, 0, 0, 255, 0, 0, 0, 0, 255] + [0] * 759)
    damaged = _encoded(frames[0], "GIF", save_all=True, append_images=frames[1:], duration=50)[:167]
    # Counting the frames of this truncated GIF raises IndexError, not OSError.
    with pytest.raises(IndexError), Image.open(BytesIO(damaged), formats=["GIF"]) as broken:
        _ = getattr(broken, "n_frames")  # noqa: B009 - typeshed omits the GIF plugin's attribute

    with pytest.raises(ContentFileInvalidError) as caught:
        canonicalize_chat_image_stream(content=BytesIO(damaged))

    assert caught.value.reason == "unsupported_image_format"

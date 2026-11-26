"""Chat images in provider-neutral prompts: references, selection and size estimates.

A prompt never holds image bytes. A user message with images has a list of
content parts: one ``model_client_image`` part per image, naming the stored
file, followed by a ``text`` part. Saved messages keep the same shape, so a
later turn replays the reference. Just before a request is sent, the executor
loads the referenced bytes into ``ModelClientRequest.images`` and each adapter
writes them in its provider's format.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from math import ceil
from typing import Any

MODEL_CLIENT_IMAGE_PART_TYPE = "model_client_image"
# More images than this make Anthropic apply a stricter size rule to every image
# in the request, so older images become placeholders instead.
MAX_REQUEST_IMAGES = 20
# Anthropic counts 28-pixel patches and OpenAI 32-pixel patches (times 1.2); the
# 28-pixel count is the larger, and 4,784 is the most either charges for an image
# within the stored 2,000-pixel bound.
_IMAGE_PATCH_PIXELS = 28
_MAX_IMAGE_TOKENS = 4784


@dataclass(frozen=True, slots=True)
class ModelClientImage:
    """The bytes of one stored chat image, loaded for a single request."""

    media_type: str
    content: bytes = field(repr=False)


def image_part(*, file_id: str, name: str, width: int, height: int) -> dict[str, Any]:
    """Return the prompt part that stands for one stored chat image."""

    return {"type": MODEL_CLIENT_IMAGE_PART_TYPE, "file_id": file_id, "name": name, "width": width, "height": height}


def is_image_part(value: object) -> bool:
    """Return whether a content part refers to a stored chat image."""

    return isinstance(value, Mapping) and value.get("type") == MODEL_CLIENT_IMAGE_PART_TYPE


def image_placeholder(name: str) -> str:
    """The text that stands for an image a request does not carry, and in saved message text.

    The name is the uploaded file's name, so ``<`` is escaped: it cannot open a
    tag such as the turn-context block in a prompt.
    """

    return "[Image: {}]".format(name.replace("<", "&lt;"))


def placeholder_part(part: Mapping[str, Any]) -> dict[str, Any]:
    """Return a text part naming the image ``part`` refers to."""

    return {"type": "text", "text": image_placeholder(str(part.get("name") or "image"))}


def estimate_image_tokens(width: int, height: int) -> int:
    """Return an upper bound on what any supported provider charges for one stored image."""

    patches = ceil(max(1, width) / _IMAGE_PATCH_PIXELS) * ceil(max(1, height) / _IMAGE_PATCH_PIXELS)
    return min(patches, _MAX_IMAGE_TOKENS)


def image_tokens_in(value: object) -> int:
    """Return the image estimate for every image part inside a JSON-like value."""

    if is_image_part(value):
        assert isinstance(value, Mapping)
        return estimate_image_tokens(_int(value.get("width")), _int(value.get("height")))
    if isinstance(value, Mapping):
        return sum(image_tokens_in(item) for item in value.values())
    if isinstance(value, list | tuple):
        return sum(image_tokens_in(item) for item in value)
    return 0


def message_text(content: object) -> str:
    """Return a message's text: the string itself, or its text parts joined."""

    if isinstance(content, str):
        return content
    if isinstance(content, list | tuple):
        return "\n".join(
            str(part.get("text"))
            for part in content
            if isinstance(part, Mapping) and part.get("type") == "text" and part.get("text")
        )
    return ""


def image_file_ids(messages: Iterable[Mapping[str, Any]]) -> list[str]:
    """Return the file ids of every image part in ``messages``, in order."""

    return [
        str(part["file_id"])
        for message in messages
        for part in _content_parts(message)
        if is_image_part(part) and isinstance(part.get("file_id"), str)
    ]


def select_images(
    messages: Sequence[Mapping[str, Any]],
    *,
    accepts_images: bool,
    limit: int = MAX_REQUEST_IMAGES,
) -> tuple[Mapping[str, Any], ...]:
    """Keep the newest ``limit`` images and turn every other image into a placeholder.

    Images are counted from the last message back, so the current turn's images
    come first, and the kept set changes only when history is trimmed or the
    limit is passed (which keeps provider prompt caching effective). A model that
    does not accept images gets placeholders for all of them.
    """

    remaining = limit if accepts_images else 0
    selected: list[Mapping[str, Any]] = []
    for message in reversed(messages):
        parts = _content_parts(message)
        if not any(is_image_part(part) for part in parts):
            selected.append(message)
            continue
        kept: list[Any] = []
        for part in parts:
            if is_image_part(part) and remaining > 0:
                remaining -= 1
                kept.append(part)
            elif is_image_part(part):
                kept.append(placeholder_part(part))
            else:
                kept.append(part)
        selected.append({**message, "content": kept})
    selected.reverse()
    return tuple(selected)


def resolved_parts(content: Iterable[Any], images: Mapping[str, ModelClientImage]) -> Iterator[ModelClientImage | str]:
    """Yield a message's images (with their bytes) and non-empty texts, in order.

    An image whose bytes ``images`` lacks yields its placeholder text instead,
    so an adapter never writes a reference the provider cannot read.
    """

    for part in content:
        if is_image_part(part):
            image = images.get(str(part.get("file_id")))
            if image is not None:
                yield image
                continue
            part = placeholder_part(part)
        if isinstance(part, Mapping) and part.get("type") == "text" and part.get("text"):
            yield str(part["text"])


def _content_parts(message: Mapping[str, Any]) -> list[Any]:
    content = message.get("content")
    return list(content) if isinstance(content, list | tuple) else []


def _int(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


__all__ = [
    "MAX_REQUEST_IMAGES",
    "MODEL_CLIENT_IMAGE_PART_TYPE",
    "ModelClientImage",
    "estimate_image_tokens",
    "image_file_ids",
    "image_part",
    "image_placeholder",
    "image_tokens_in",
    "is_image_part",
    "message_text",
    "placeholder_part",
    "resolved_parts",
    "select_images",
]

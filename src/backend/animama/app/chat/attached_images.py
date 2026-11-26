"""The chat images attached to a turn: which ids are images, and whether they can be sent.

Documents keep their own rule (a file that is not searchable is left out of the
turn). An attached image the person can still see in the composer but that is
deleted, failed or not ready refuses the turn instead, so the person is not
answered about an image the model never received. Bytes that go missing after
this check (rare) are sent as the image's placeholder and logged.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from animama.app.ports.user_file_processing_port import UserFileProcessingRepository
from animama.app.services.user_file_service import is_image_user_file
from animama.domain.user_file import STATUS_READY, UserFile

from .direct_turn.types import DirectChatAttachedImage

MAX_TURN_IMAGES = 4
TOO_MANY_IMAGES = "too_many_images"
ATTACHED_IMAGE_UNAVAILABLE = "attached_image_unavailable"


class AttachedImageError(ValueError):
    """An attached image refuses the turn; ``code`` names the reason for the client."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class AttachedImages:
    """A turn's attached ids, split into ready images and everything else."""

    images: tuple[DirectChatAttachedImage, ...]
    other_file_ids: tuple[str, ...]


async def validate_attached_images(
    *,
    user_file_processing: UserFileProcessingRepository,
    user_id: str,
    file_ids: Sequence[str] | None,
) -> AttachedImages:
    """Return the turn's ready images and its other attached ids.

    Raises ``AttachedImageError`` for more than ``MAX_TURN_IMAGES`` images or for
    an image that is deleted, failed or not yet ready. An id that names no file
    of this owner is passed on with the documents, which ignore it.
    """

    images: list[DirectChatAttachedImage] = []
    other: list[str] = []
    for file_id in dict.fromkeys(value.strip() for value in file_ids or () if isinstance(value, str)):
        if not file_id:
            continue
        user_file = await user_file_processing.get_user_file(user_id=user_id, file_id=file_id, include_deleted=True)
        if user_file is None or not is_image_user_file(user_file):
            other.append(file_id)
            continue
        if user_file.status != STATUS_READY:
            raise AttachedImageError(
                ATTACHED_IMAGE_UNAVAILABLE,
                f"The attached image {user_file.original_filename!r} is no longer available.",
            )
        images.append(_attached_image(user_file))
    if len(images) > MAX_TURN_IMAGES:
        raise AttachedImageError(TOO_MANY_IMAGES, f"A message can carry at most {MAX_TURN_IMAGES} images.")
    return AttachedImages(images=tuple(images), other_file_ids=tuple(other))


def _attached_image(user_file: UserFile) -> DirectChatAttachedImage:
    facts = (user_file.metadata or {}).get("image")
    facts = facts if isinstance(facts, dict) else {}
    return DirectChatAttachedImage(
        file_id=user_file.id,
        name=user_file.original_filename,
        width=_positive_int(facts.get("width")),
        height=_positive_int(facts.get("height")),
    )


def _positive_int(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 1


__all__ = [
    "ATTACHED_IMAGE_UNAVAILABLE",
    "MAX_TURN_IMAGES",
    "TOO_MANY_IMAGES",
    "AttachedImageError",
    "AttachedImages",
    "validate_attached_images",
]

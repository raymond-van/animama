"""What the person gives a request besides its words: Library Gestures and their own images (spec R8).

A request may name one Library Gesture as its **starting point** (the new
draft begins as that Gesture's clip, and the assistant revises it), up to
``MAX_EXAMPLE_GESTURES`` Gestures as **examples of the feel** (their clips
are shown to the model as data and never become the draft), and up to
``MAX_REFERENCE_IMAGES`` of the person's own images.

Nothing here reads the Library or a file. The local composition does that
(``server/generation.py``), refuses what may not be read (a non-portable item,
threat T4) and hands what it read to these functions, which bound it and
validate it as any other input a pass starts from. A Gesture's name and
description are text other people may have written; they reach a model only
inside a tagged data block (``prompts.py``).
"""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final, Literal

from animama.app.chat.attached_images import MAX_TURN_IMAGES
from animama.app.services.idle_clip_validation import V2_CLIP_FIELDS
from animama.domain.generation import GenerationError

from .draft_validation import (
    MAX_AI_DESCRIPTION_LENGTH,
    MAX_NAME_LENGTH,
    MAX_SELECTOR_ID_LENGTH,
    JsonObject,
    SelectorInUse,
    build_project,
    is_library_name,
    is_storable_text,
    timeline_problems,
)

MAX_EXAMPLE_GESTURES: Final = 3
"""Library Gestures one request may give as examples of the feel."""
MAX_EXAMPLE_CLIP_BYTES: Final = 32 * 1024
"""The largest clip one example may show a model, as compact JSON. The largest Included Gesture is 24 KB."""
MAX_EXAMPLES_BYTES: Final = 64 * 1024
"""The most the examples of one request may show a model together: about 18,000 tokens, on top of a pass's own."""
MAX_REFERENCE_IMAGES: Final = MAX_TURN_IMAGES
"""Reference images one request may carry: as many as a chat message's images."""
MAX_REFERENCE_TEXT_LENGTH: Final = 1000
"""Characters kept of an example's name or description."""

ReferenceRefusal = Literal[
    "not_found", "non_portable", "not_a_clip", "invalid", "too_large", "not_allowed", "unavailable"
]
"""Why a reference is refused.

``not_found``: no usable Gesture of the owner has that id. ``non_portable``:
the item may not leave the machine. ``not_a_clip``: the Gesture is not an
``animaPoseClip/2.0`` clip (an imported motion file). ``invalid``: its clip
cannot be what a draft starts from. ``too_large``: the examples are more than
a request may show. ``not_allowed``: this request may not take that reference
(a starting point for a revision, or in a creator). ``unavailable``: the
Library cannot be read now.
"""

ImageKind = Literal["image", "video_frames"]
"""What a reference image is: a picture, or one strip of frames the page sampled from a short video."""

_HIDDEN_CLIP_FIELDS: Final = frozenset({"events", "playback", "role"})
"""Clip fields a draft may not take from a Library Gesture: its effects and sounds (whose dependencies the
draft does not hold), and the playback lifetime and role that are an item's own. ``read_example`` hides the
same fields."""
_NOT_NAME_CHARACTERS: Final = re.compile(r"[^A-Za-z0-9._ -]+")
_NOT_SELECTOR_CHARACTERS: Final = re.compile(r"[^a-z0-9]+")
_FALLBACK_NAME: Final = "Gesture"
_FALLBACK_SELECTOR_ID: Final = "gesture"
_MAX_COPY_NUMBER: Final = 1000


class GenerationReferenceError(GenerationError):
    """A reference named with a run cannot be used; ``reason`` says why (``ReferenceRefusal``)."""

    code = "generation_reference_refused"

    def __init__(self, reason: ReferenceRefusal) -> None:
        super().__init__()
        self.reason = reason


@dataclass(frozen=True)
class GestureSource:
    """One portable Library Gesture as the composition read it: its identity, and its clip as parsed JSON."""

    item_id: str
    name: str
    description: str
    selector_id: str
    clip: Any = field(repr=False)


@dataclass(frozen=True)
class StartingPoint:
    """The Library Gesture a new draft starts as: its clip, already validated as a draft's."""

    item_id: str
    name: str
    description: str
    selector_id: str
    clip: JsonObject = field(repr=False)


@dataclass(frozen=True)
class ExampleGesture:
    """A Library Gesture shown to the model as an example of the feel: bounded text, and its clip."""

    item_id: str
    name: str
    description: str
    clip: Mapping[str, Any] = field(repr=False)


@dataclass(frozen=True)
class ReferenceImage:
    """One of the person's own images for a request, with the stored copy's bytes when it is sent to a model.

    ``content`` is ``None`` when the run's model takes no images: the image
    is then kept with the conversation and shown in the turn, and sent
    nowhere.
    """

    file_id: str
    name: str
    width: int
    height: int
    kind: ImageKind = "image"
    media_type: str = ""
    content: bytes | None = field(default=None, repr=False)


@dataclass(frozen=True)
class RunReferences:
    """Everything one request carries besides its words, read and bounded before the run is planned."""

    starting_point: StartingPoint | None = None
    examples: tuple[ExampleGesture, ...] = ()
    images: tuple[ReferenceImage, ...] = ()

    @property
    def sent_images(self) -> tuple[ReferenceImage, ...]:
        """The images whose bytes go to the model: none on a model that takes no images."""

        return tuple(image for image in self.images if image.content is not None)

    def stored(self) -> dict[str, Any]:
        """What the person's turn records of its Gesture references, for the page to show; empty without any."""

        stored: dict[str, Any] = {}
        if self.starting_point is not None:
            stored["starting_point"] = {"item_id": self.starting_point.item_id, "name": self.starting_point.name}
        if self.examples:
            stored["examples"] = [{"item_id": example.item_id, "name": example.name} for example in self.examples]
        return stored

    def stored_images(self) -> list[dict[str, Any]]:
        """What the person's turn records of its images, in the shape a chat message records its own."""

        return [
            {
                "file_id": image.file_id,
                "name": image.name,
                "width": image.width,
                "height": image.height,
                "kind": image.kind,
            }
            for image in self.images
        ]


def _shown_clip(clip: Any) -> JsonObject:
    """The format's own fields of a Library clip, without those a draft may not take; a copy."""

    if not isinstance(clip, dict):
        raise GenerationReferenceError("not_a_clip")
    # A shallow selection first: nothing outside the format's own fields is walked, sized or kept.
    return {name: clip[name] for name in V2_CLIP_FIELDS if name in clip and name not in _HIDDEN_CLIP_FIELDS}


def starting_point(source: GestureSource) -> StartingPoint:
    """A Library Gesture as what a new draft starts from, or ``GenerationReferenceError``.

    The clip is validated like any other input a pass starts from (threat
    T1): only the fields the 2.0 format defines, and then exactly the
    validation a model's clip passes. Its effects and sounds are not carried:
    a draft's events name dependencies this backend derives, and the
    assistant may place effects again.
    """

    clip = _shown_clip(source.clip)
    if timeline_problems("gesture", clip):
        raise GenerationReferenceError("invalid")
    return StartingPoint(
        item_id=source.item_id,
        name=source.name,
        description=source.description,
        selector_id=source.selector_id,
        clip=copy.deepcopy(clip),
    )


def _copy_name(name: str) -> str:
    """A name the Library would save for a copy of an item called ``name``: that name, then `` 2``.

    A name the save rule refuses (seven Included names hold punctuation, for
    example an apostrophe) keeps only its plain characters.
    """

    suffix = " 2"
    room = MAX_NAME_LENGTH - len(suffix)
    whole = " ".join(name.split())
    plain = " ".join(_NOT_NAME_CHARACTERS.sub("", name).split()).lstrip("._- ")
    for base in (whole[:room].rstrip(), plain[:room].rstrip(), _FALLBACK_NAME):
        if base and is_library_name(f"{base}{suffix}") and is_storable_text(base):
            return f"{base}{suffix}"
    return f"{_FALLBACK_NAME}{suffix}"


def _copy_selector_id(selector_id: str, selector_in_use: SelectorInUse | None) -> str:
    """A Selector ID no other Gesture uses, from the source's: ``wave_hello_2``, then ``_3`` and so on."""

    base = _NOT_SELECTOR_CHARACTERS.sub("_", selector_id.lower()).strip("_") or _FALLBACK_SELECTOR_ID
    for number in range(2, _MAX_COPY_NUMBER):
        suffix = f"_{number}"
        candidate = f"{base[: MAX_SELECTOR_ID_LENGTH - len(suffix)].rstrip('_')}{suffix}"
        if selector_in_use is None or not selector_in_use(candidate):
            return candidate
    return f"{base[: MAX_SELECTOR_ID_LENGTH - 5].rstrip('_')}_{_MAX_COPY_NUMBER}"


def starting_project(start: StartingPoint, selector_in_use: SelectorInUse | None) -> JsonObject:
    """The draft a starting point begins as: the Gesture's clip, with details of its own that could be saved.

    The new draft is a new item, so it does not take the Gesture's name or
    Selector ID: it gets the name with `` 2`` and a Selector ID no other
    Gesture uses. The assistant then renames and describes it for what it
    becomes. The Gesture's description is kept, cut to a draft's limit.
    """

    details = {
        "name": _copy_name(start.name),
        "ai_description": start.description.strip()[:MAX_AI_DESCRIPTION_LENGTH] or start.name.strip() or _FALLBACK_NAME,
        "selector_id": _copy_selector_id(start.selector_id, selector_in_use),
    }
    return build_project("gesture", start.clip, details)


def example_gesture(source: GestureSource) -> ExampleGesture:
    """A Library Gesture as an example of the feel: its clip without the fields a draft may not copy, bounded.

    Raises ``GenerationReferenceError`` for a clip larger than
    ``MAX_EXAMPLE_CLIP_BYTES``. An example is read, never loaded or saved, so
    it is not validated as a draft's clip is.
    """

    clip = _shown_clip(source.clip)
    try:
        size = _clip_bytes(clip)
    except (TypeError, ValueError, RecursionError) as error:
        raise GenerationReferenceError("not_a_clip") from error
    if size > MAX_EXAMPLE_CLIP_BYTES:
        raise GenerationReferenceError("too_large")
    return ExampleGesture(
        item_id=source.item_id,
        name=source.name.strip()[:MAX_REFERENCE_TEXT_LENGTH],
        description=source.description.strip()[:MAX_REFERENCE_TEXT_LENGTH],
        clip=clip,
    )


def _clip_bytes(clip: Mapping[str, Any]) -> int:
    return len(json.dumps(clip, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8", "replace"))


def bounded_examples(examples: Sequence[ExampleGesture]) -> tuple[ExampleGesture, ...]:
    """The examples of one request, or ``GenerationReferenceError`` when they are more than it may show.

    At most ``MAX_EXAMPLE_GESTURES``, and at most ``MAX_EXAMPLES_BYTES`` of
    clips together.
    """

    if len(examples) > MAX_EXAMPLE_GESTURES or sum(_clip_bytes(example.clip) for example in examples) > (
        MAX_EXAMPLES_BYTES
    ):
        raise GenerationReferenceError("too_large")
    return tuple(examples)


__all__ = [
    "MAX_EXAMPLES_BYTES",
    "MAX_EXAMPLE_CLIP_BYTES",
    "MAX_EXAMPLE_GESTURES",
    "MAX_REFERENCE_IMAGES",
    "MAX_REFERENCE_TEXT_LENGTH",
    "ExampleGesture",
    "GenerationReferenceError",
    "GestureSource",
    "ImageKind",
    "ReferenceImage",
    "ReferenceRefusal",
    "RunReferences",
    "StartingPoint",
    "bounded_examples",
    "example_gesture",
    "starting_point",
    "starting_project",
]

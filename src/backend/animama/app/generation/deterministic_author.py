"""The author that stands in for a model when ``ANIMAMA_LLM_SKIP`` is set (decision D13).

Journeys and tests run the whole pipeline without a provider. Each method
returns the tool call a model would have made in that kind of pass, so the
same tool code validates it: a write submits a packaged example Gesture or
Reaction with details taken from the request, a revision or repair makes one
fixed valid change, and a review accepts.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Mapping
from functools import cache
from importlib.resources import files
from typing import Any, Final

from animama.app.model_clients import ModelClientToolCall

from .draft_validation import MAX_DRAFT_SECONDS, Intent, JsonObject, SelectorInUse

EXAMPLE_GESTURE_RESOURCE: Final = "generation-example-gesture.json"
"""A short nod that passes validation and the motion checks, shipped in ``animama.resources``."""
EXAMPLE_REACTION_RESOURCE: Final = "generation-example-reaction.json"
"""A surprised flash that settles into a smile, as an Included Reaction shapes one: two beats and face parts only."""
EXAMPLE_REACTION_EMOTION: Final = "excitement"
EXAMPLE_REACTION_INTENSITY: Final = 2
"""Where the example Reaction fits; its fades are those of this intensity."""

MAX_DERIVED_NAME_LENGTH: Final = 60
MAX_DERIVED_SELECTOR_LENGTH: Final = 40
MAX_QUOTED_REQUEST_LENGTH: Final = 300
LENGTHEN_SECONDS: Final = 0.2
"""How much a revision or repair adds to the clip's duration and to its last beat's time."""

_FALLBACK_NAME: Final = "Example Gesture"
_FALLBACK_REACTION_NAME: Final = "Example Reaction"
_FALLBACK_SELECTOR_ID: Final = "example_gesture"
_NOT_SELECTOR_CHARACTERS = re.compile(r"[^a-z0-9]+")
# Far more than a journey makes; it only keeps the search for a free Selector ID finite.
_MAX_SELECTOR_SUFFIX: Final = 1000


@cache
def _example_text() -> str:
    resource = files("animama.resources").joinpath(EXAMPLE_GESTURE_RESOURCE)
    if not resource.is_file():
        raise FileNotFoundError(f"Required packaged example Gesture is missing: {EXAMPLE_GESTURE_RESOURCE}")
    return resource.read_text(encoding="utf-8")


@cache
def _example_reaction_text() -> str:
    resource = files("animama.resources").joinpath(EXAMPLE_REACTION_RESOURCE)
    if not resource.is_file():
        raise FileNotFoundError(f"Required packaged example Reaction is missing: {EXAMPLE_REACTION_RESOURCE}")
    return resource.read_text(encoding="utf-8")


def example_gesture_clip() -> JsonObject:
    """The packaged example Gesture clip, parsed anew for each caller."""

    clip: JsonObject = json.loads(_example_text())
    return clip


def example_reaction_clip() -> JsonObject:
    """The packaged example Reaction clip, parsed anew for each caller."""

    clip: JsonObject = json.loads(_example_reaction_text())
    return clip


def _call(kind: str, tool: str, arguments: Mapping[str, Any]) -> ModelClientToolCall:
    return ModelClientToolCall(
        id=f"deterministic-{kind}", name=tool, arguments=json.dumps(arguments, ensure_ascii=False)
    )


def _request_text(request: str) -> str:
    """The request on one line, without characters that cannot be shown or stored."""

    return " ".join("".join(character for character in " ".join(request.split()) if character.isprintable()).split())


def _name(text: str, fallback: str = _FALLBACK_NAME) -> str:
    """A display name from the request: its first words, with a capital first letter."""

    if len(text) > MAX_DERIVED_NAME_LENGTH:
        cut = text[: MAX_DERIVED_NAME_LENGTH + 1]
        # Cut at a word boundary when there is one.
        text = (cut.rsplit(" ", 1)[0] if " " in cut else cut)[:MAX_DERIVED_NAME_LENGTH].strip()
    return text[:1].upper() + text[1:] if text else fallback


def _selector_id(name: str, selector_in_use: SelectorInUse | None) -> str:
    """A snake_case Selector ID from the name that no other Gesture uses, numbered when the plain one is taken."""

    decomposed = unicodedata.normalize("NFKD", name)
    folded = "".join(character for character in decomposed if not unicodedata.combining(character)).lower()
    stem = _NOT_SELECTOR_CHARACTERS.sub("_", folded).strip("_")[:MAX_DERIVED_SELECTOR_LENGTH].strip("_")
    stem = stem or _FALLBACK_SELECTOR_ID
    if selector_in_use is None or not selector_in_use(stem):
        return stem
    return next(
        (
            candidate
            for candidate in (f"{stem}_{number}" for number in range(2, _MAX_SELECTOR_SUFFIX))
            if not selector_in_use(candidate)
        ),
        stem,
    )


class DeterministicAuthor:
    """Makes the tool call of each pass kind without a model, the same call for the same input."""

    def write(
        self, request: str, *, intent: Intent = "gesture", selector_in_use: SelectorInUse | None = None
    ) -> ModelClientToolCall:
        """Submit the packaged example clip of ``intent``, named after ``request``.

        A Gesture gets a Selector ID not in use; a Reaction gets the example's
        own emotion and intensity.
        """

        text = _request_text(request)
        if intent == "reaction":
            return _call(
                "write",
                "submit_draft",
                {
                    "clip": example_reaction_clip(),
                    "name": _name(text, _FALLBACK_REACTION_NAME),
                    "emotion": EXAMPLE_REACTION_EMOTION,
                    "intensity": EXAMPLE_REACTION_INTENSITY,
                    "note": "This is the packaged example Reaction: no model was asked.",
                },
            )
        name = _name(text)
        quoted = text[:MAX_QUOTED_REQUEST_LENGTH]
        return _call(
            "write",
            "submit_draft",
            {
                "clip": example_gesture_clip(),
                "name": name,
                "ai_description": f"Example draft written without a model for the request: {quoted}"
                if quoted
                else "Example draft written without a model.",
                "selector_id": _selector_id(name, selector_in_use),
                "note": "This is the packaged example Gesture: no model was asked.",
            },
        )

    def revise(self, project: Mapping[str, Any]) -> ModelClientToolCall:
        """Make the fixed change to the draft: see ``_fixed_change``."""

        return self._fixed_change("revise", project)

    def repair(self, project: Mapping[str, Any]) -> ModelClientToolCall:
        """Make the same fixed change a revision makes; it repairs nothing, so a failed check stays failed."""

        return self._fixed_change("repair", project)

    def review(self) -> ModelClientToolCall:
        """Accept the draft as it is."""

        return _call("review", "accept_draft", {"note": "Accepted without a model."})

    def _fixed_change(self, kind: str, project: Mapping[str, Any]) -> ModelClientToolCall:
        """Lengthen the clip's ending: ``LENGTHEN_SECONDS`` more duration, and the last beat that much later.

        Every key stays where it was relative to its beat, so a valid clip
        stays valid. A clip already at a draft's longest instead switches
        between looping and playing once.
        """

        clip = project["sequence"]
        duration, beats = clip["duration"], clip.get("beats") or []
        if duration + LENGTHEN_SECONDS > MAX_DRAFT_SECONDS:
            operations = [{"op": "set", "path": "/loop", "value": not clip.get("loop", False)}]
            note = "Switched between looping and playing once."
        else:
            operations = [{"op": "set", "path": "/duration", "value": round(duration + LENGTHEN_SECONDS, 4)}]
            if beats:
                later = round(beats[-1]["time"] + LENGTHEN_SECONDS, 4)
                operations.append({"op": "set", "path": f"/beats/{len(beats) - 1}/time", "value": later})
            note = f"Lengthened the ending by {LENGTHEN_SECONDS} seconds."
        return _call(kind, "edit_draft", {"operations": operations, "note": note})


__all__ = [
    "EXAMPLE_GESTURE_RESOURCE",
    "EXAMPLE_REACTION_EMOTION",
    "EXAMPLE_REACTION_INTENSITY",
    "EXAMPLE_REACTION_RESOURCE",
    "LENGTHEN_SECONDS",
    "DeterministicAuthor",
    "example_gesture_clip",
    "example_reaction_clip",
]

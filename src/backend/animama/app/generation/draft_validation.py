"""Whether a clip and its details can be a draft, and the project a draft is stored as.

A draft is a model's output, so everything here treats it as untrusted: a clip
is a JSON object of bounded size that passes the server's structural
validation, its details are bounded text and known values, and each problem is
a short sentence for the model, bounded in length and number. The page runs
the fuller validation (anatomical limits) and the motion checks afterwards.

The details are named as the tools name them: ``name``, and for a Gesture
``ai_description`` and ``selector_id``, for a Reaction ``emotion`` and
``intensity``. ``build_project`` turns a clip and its details into the
``animamaActionProject/1.0`` shape the creator imports.
"""

from __future__ import annotations

import copy
import json
import re
import unicodedata
from collections.abc import Callable, Collection, Iterable, Iterator, Mapping
from typing import Any, Final, Literal

from animama.app.services.clip_format import ANIMA_POSE_CLIP_SCHEMA
from animama.app.services.content_kind_registry import SEMANTIC_KEY_PATTERN
from animama.app.services.idle_clip_validation import validate_clip_v2_timeline
from animama.domain.anima_loadout import REACTION_INTENSITIES
from animama.domain.content_documents import ContentDocumentError
from animama.domain.emotions import TRACKED_EMOTION_SET, TRACKED_EMOTIONS

JsonObject = dict[str, Any]
Intent = Literal["gesture", "reaction"]
"""The kind of content a draft becomes when saved."""
SelectorInUse = Callable[[str], bool]
"""Whether another Gesture of the owner already uses a Selector ID. The caller leaves out the draft's own saved item."""

ACTION_PROJECT_SCHEMA: Final = "animamaActionProject/1.0"
MAX_CLIP_BYTES: Final = 2 * 1024 * 1024
MAX_DRAFT_SECONDS: Final = 60
"""The longest clip a draft may hold: the page's checks take longer the longer a clip is."""
MAX_CLIP_DEPTH: Final = 24
"""The deepest a draft's clip may nest objects and arrays, counting the clip itself as the first level.

A real clip nests under ten. Far deeper, a clip can no longer be serialized
for the page or copied, so one that validates in every known field must still
not be stored.
"""
MAX_PROBLEMS: Final = 20
MAX_PROBLEM_LENGTH: Final = 300
MAX_NAME_LENGTH: Final = 80
MAX_AI_DESCRIPTION_LENGTH: Final = 1000
MAX_SELECTOR_ID_LENGTH: Final = 64
"""The length the creator gives a Selector ID it proposes (``gestureSemanticKey``)."""
MAX_CLIP_ID_LENGTH: Final = 120

# Clip fields that move the body or belong to the Gesture lane. The creator strips them from a Reaction
# (``sanitizeReactionSequence`` in the frontend's ``actionDocument.ts``); a draft is refused instead, so the
# model learns that a Reaction has no body.
REACTION_BODY_FIELDS: Final = (
    "joints",
    "rotations",
    "hipsPosition",
    "hands",
    "contacts",
    "plantFeet",
    "basePose",
    "mutedProceduralLayers",
)

DETAIL_FIELDS: Final[Mapping[Intent, tuple[str, ...]]] = {
    "gesture": ("name", "ai_description", "selector_id"),
    "reaction": ("name", "emotion", "intensity"),
}
"""The details each kind of draft has, in the order the tools take them."""

_UNSTORABLE = "clip holds a character that cannot be stored (NUL or an unpaired surrogate)"
# A NUL as JSON text writes it: ``\u0000`` after an even number of backslashes.
_NUL_ESCAPE = re.compile(r"(?<!\\)(?:\\\\)*\\u0000")
_CUT = " … "
# Lower-case snake_case, as the Gesture guidance asks. It is narrower than the content kind registry's
# ``SEMANTIC_KEY_PATTERN``, which also admits dots and hyphens and is checked as well.
_SNAKE_CASE = re.compile(r"[a-z0-9]+(?:_[a-z0-9]+)*")
_COMBINING_MARKS = re.compile("[\u0300-\u036f]")
_NOT_ID_CHARACTERS = re.compile(r"[^a-z0-9]+")


def bounded_problems(problems: Iterable[str]) -> list[str]:
    """At most ``MAX_PROBLEMS`` problems of at most ``MAX_PROBLEM_LENGTH`` characters each."""

    return [
        bounded_text(problem, MAX_PROBLEM_LENGTH) for _, problem in zip(range(MAX_PROBLEMS), problems, strict=False)
    ]


def bounded_text(text: str, limit: int) -> str:
    """``text`` in at most ``limit`` characters.

    A long text loses its middle, not its end: in a problem the middle is a
    name the model wrote, and the end says what is wrong with it.
    """

    if len(text) <= limit:
        return text
    kept = limit - len(_CUT)
    head = kept * 2 // 3
    return text[:head] + _CUT + text[len(text) - (kept - head) :]


def is_storable_text(value: str) -> bool:
    """Whether PostgreSQL can store ``value`` in text and JSONB: no NUL and no unpaired surrogate."""

    if "\x00" in value:
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


# --- The clip ---------------------------------------------------------------------


def nests_deeper_than(value: object, limit: int) -> bool:
    """Whether ``value`` nests objects and arrays more than ``limit`` levels deep; the value itself is the first.

    The value is a model's output, so the walk is made without recursion (it
    may nest deeper than the interpreter would follow) and keeps only the
    containers it is inside: at most ``limit + 1`` of them, however wide the
    value is. A value that is not a container is looked at where it sits and
    never set aside.
    """

    if not isinstance(value, dict | list | tuple):
        return False
    inside = [_children(value)]
    while inside:
        if len(inside) > limit:
            return True
        for child in inside[-1]:
            if isinstance(child, dict | list | tuple):
                inside.append(_children(child))
                break
        else:
            inside.pop()
    return False


def _children(container: dict[Any, Any] | list[Any] | tuple[Any, ...]) -> Iterator[object]:
    return iter(container.values() if isinstance(container, dict) else container)


def clip_problems(clip: object) -> list[str]:
    """Why ``clip`` cannot be a draft's clip, as sentences for the model; empty when it can.

    A draft's clip is a JSON object of at most 2 MiB with the 2.0 schema,
    nested at most ``MAX_CLIP_DEPTH`` levels, at most ``MAX_DRAFT_SECONDS``
    long, that passes the server's structural validation. That validation
    stops at its first problem and names the JSON path in its message.
    """

    if not isinstance(clip, dict):
        return ["clip must be a JSON object"]
    # Before anything that walks the clip by recursion: serializing it (which is how its size is known),
    # validating it or copying it.
    if nests_deeper_than(clip, MAX_CLIP_DEPTH):
        return [f"clip is nested deeper than {MAX_CLIP_DEPTH} levels"]
    try:
        text = json.dumps(clip, ensure_ascii=False, allow_nan=False)
    except TypeError:
        return ["clip must hold only JSON values"]
    except ValueError:
        return ["clip holds a number JSON cannot represent (NaN or Infinity)"]
    try:
        size = len(text.encode("utf-8"))
    except UnicodeEncodeError:
        return [_UNSTORABLE]
    if size > MAX_CLIP_BYTES:
        return [f"clip is {size} bytes; the limit is {MAX_CLIP_BYTES}"]
    if _NUL_ESCAPE.search(text):
        return [_UNSTORABLE]
    problems: list[str] = []
    if clip.get("schema") != ANIMA_POSE_CLIP_SCHEMA:
        problems.append(f'schema must be "{ANIMA_POSE_CLIP_SCHEMA}"')
    if not isinstance(clip.get("loop", False), bool):
        problems.append("loop must be true or false")
    try:
        duration = validate_clip_v2_timeline(clip)
    except ContentDocumentError as error:
        problems.append(f"{error.field}: {error}" if error.field else str(error))
    else:
        if duration > MAX_DRAFT_SECONDS:
            problems.append(f"duration must be at most {MAX_DRAFT_SECONDS} seconds for a draft")
    return bounded_problems(problems)


def reaction_body_problems(clip: Mapping[str, Any]) -> list[str]:
    """One problem for each body field a Reaction's clip holds, whatever its value."""

    return [
        f"{field}: a Reaction has no body motion; remove this field" for field in REACTION_BODY_FIELDS if field in clip
    ]


def _event_problems(clip: Mapping[str, Any]) -> list[str]:
    """Refuse timeline events while a draft's project carries no dependencies.

    An event names an effect or a sound by the alias of a dependency, so an
    event in a draft would name one the project does not hold.
    """

    return ["events: a draft cannot use effects or sounds yet; remove this field"] if clip.get("events") else []


# --- The details ------------------------------------------------------------------


def _is_text(value: object, maximum: int) -> bool:
    return isinstance(value, str) and 0 < len(value.strip()) <= maximum and is_storable_text(value)


def _is_selector_id(value: str) -> bool:
    return (
        len(value) <= MAX_SELECTOR_ID_LENGTH
        and _SNAKE_CASE.fullmatch(value) is not None
        and SEMANTIC_KEY_PATTERN.fullmatch(value) is not None
    )


def detail_problems(
    intent: Intent,
    details: Mapping[str, Any],
    *,
    selector_in_use: SelectorInUse | None = None,
    held: Collection[str] = (),
) -> list[str]:
    """Why ``details`` cannot be a draft's details; empty when they can.

    Every draft needs a name. A Gesture also needs an AI description and a
    snake_case Selector ID that no other Gesture of the owner uses;
    ``selector_in_use`` is asked only about a well-formed id. A Reaction
    needs a tracked emotion and an intensity from 1 to 4, and has no Selector
    ID. Details of the other kind are ignored.

    ``held`` names the details an item open in a creator already has. They
    are the person's, already checked by the catalog's own rules
    (``held_detail_problems``), and no pass may change them, so a draft's
    stricter rules are not applied to them.
    """

    problems: list[str] = []
    if "name" not in held and not _is_text(details.get("name"), MAX_NAME_LENGTH):
        problems.append(f"name must be a non-empty string of at most {MAX_NAME_LENGTH} characters")
    if intent == "gesture":
        if "ai_description" not in held and not _is_text(details.get("ai_description"), MAX_AI_DESCRIPTION_LENGTH):
            problems.append(
                f"ai_description must be a non-empty string of at most {MAX_AI_DESCRIPTION_LENGTH} characters"
            )
        selector_id = details.get("selector_id")
        if "selector_id" in held:
            return problems
        if not isinstance(selector_id, str) or not _is_selector_id(selector_id):
            problems.append(
                "selector_id must be lower-case snake_case (letters, digits and single underscores) of at most "
                f"{MAX_SELECTOR_ID_LENGTH} characters"
            )
        elif selector_in_use is not None and selector_in_use(selector_id):
            problems.append(f"selector_id {selector_id} is already used by another Gesture; choose a different one")
        return problems
    emotion, intensity = details.get("emotion"), details.get("intensity")
    if "emotion" not in held and (not isinstance(emotion, str) or emotion not in TRACKED_EMOTION_SET):
        problems.append(f"emotion must be one of: {', '.join(TRACKED_EMOTIONS)}")
    if "intensity" not in held and (type(intensity) is not int or intensity not in REACTION_INTENSITIES):
        problems.append(f"intensity must be {_one_of(REACTION_INTENSITIES)}")
    return problems


CATALOG_NAME_LENGTH: Final = 120
"""The longest name the content catalog reads for a saved item (``content_kind_registry``)."""
CATALOG_DESCRIPTION_LENGTH: Final = 4096
"""The longest AI description the content catalog reads for a saved item."""
CATALOG_STRING_LENGTH: Final = 512
"""The longest any other string of a saved item's document may be, by the catalog's default."""


def held_details(intent: Intent, details: Mapping[str, Any]) -> frozenset[str]:
    """The details an item open in a creator already has: the ones that are not blank.

    A Reaction's intensity goes with its emotion: without an emotion the
    item has no placement yet, whatever number its document carries.
    """

    names = ("name", "ai_description", "selector_id") if intent == "gesture" else ("name", "emotion")
    held = {name for name in names if isinstance(details.get(name), str) and details[name].strip()}
    if "emotion" in held:
        held.add("intensity")
    return frozenset(held)


def held_detail_problems(intent: Intent, details: Mapping[str, Any]) -> list[str]:
    """Why an item's own details cannot be a saved item's, by the catalog's rules; empty when they can.

    These are the rules the content catalog itself applies when it reads a
    saved Gesture or Reaction: a name of at most 120 characters, a
    description of at most 4,096, a Selector ID matching the catalog's
    pattern (dots and hyphens included), a tracked emotion and an intensity
    from 1 to 4. A blank detail is not the item's yet and is not judged here.
    Every detail must be storable text of bounded length, or a whole number.
    """

    limits = {"name": CATALOG_NAME_LENGTH, "ai_description": CATALOG_DESCRIPTION_LENGTH}
    problems: list[str] = []
    for name in DETAIL_FIELDS[intent]:
        value = details.get(name)
        if name == "intensity":
            if type(value) is not int or value not in REACTION_INTENSITIES:
                problems.append(f"intensity must be {_one_of(REACTION_INTENSITIES)}")
            continue
        if not isinstance(value, str) or not is_storable_text(value):
            problems.append(f"{name} must be text")
            continue
        text = value.strip()
        if len(text) > limits.get(name, CATALOG_STRING_LENGTH):
            problems.append(f"{name} is longer than a saved item's may be")
        elif text and name == "selector_id" and SEMANTIC_KEY_PATTERN.fullmatch(text) is None:
            problems.append("selector_id is not a Selector ID the Library accepts")
        elif text and name == "emotion" and text not in TRACKED_EMOTION_SET:
            problems.append(f"emotion must be one of: {', '.join(TRACKED_EMOTIONS)}")
    return problems


def _one_of(values: tuple[int, ...]) -> str:
    """``1, 2, 3 or 4`` for ``(1, 2, 3, 4)``."""

    *first, last = (str(value) for value in values)
    return f"{', '.join(first)} or {last}"


def timeline_problems(intent: Intent, clip: object) -> list[str]:
    """Why ``clip`` cannot be the clip of a draft of ``intent``, whatever its details; empty when it can.

    Beyond ``clip_problems``, a Reaction's clip may hold no body field, and no
    draft may hold timeline events yet.
    """

    problems = clip_problems(clip)
    if isinstance(clip, dict):
        if intent == "reaction":
            problems += reaction_body_problems(clip)
        problems += _event_problems(clip)
    return problems


def draft_problems(
    intent: Intent,
    clip: object,
    details: Mapping[str, Any],
    *,
    selector_in_use: SelectorInUse | None = None,
    held: Collection[str] = (),
) -> list[str]:
    """Why ``clip`` with ``details`` cannot be a draft of ``intent``: the clip's problems, then the details'.

    ``held`` names the details that are an open item's own, which a draft's
    rules do not judge (``detail_problems``). The list is bounded.
    """

    problems = timeline_problems(intent, clip)
    problems += detail_problems(intent, details, selector_in_use=selector_in_use, held=held)
    return bounded_problems(problems)


# --- The project ------------------------------------------------------------------


def clip_id(name: str, intent: Intent) -> str:
    """The clip id for an item's name: lower-case ASCII kebab-case, as the creator derives it.

    Mirrors ``actionClipId`` in the frontend's ``actionDocument.ts``, which
    reapplies it when the project is opened. A name with no ASCII letter or
    digit gets ``new-gesture`` or ``new-reaction``.
    """

    folded = _COMBINING_MARKS.sub("", unicodedata.normalize("NFKD", name)).lower()
    slug = _NOT_ID_CHARACTERS.sub("-", folded).strip("-")[:MAX_CLIP_ID_LENGTH].rstrip("-")
    return slug or f"new-{intent}"


def build_project(intent: Intent, clip: Mapping[str, Any], details: Mapping[str, Any]) -> JsonObject:
    """The ``animamaActionProject/1.0`` project of a draft; call it for a clip and details without problems.

    The item's name is the clip's name, and the clip's id is that name in
    kebab-case, as the creator keeps them (``normalizeActionDocument``). The
    project owns a copy of the clip. A draft has no notes or dependencies.
    """

    gesture = intent == "gesture"
    name = str(details["name"]).strip()
    sequence = copy.deepcopy(dict(clip))
    sequence["id"] = clip_id(name, intent)
    sequence["name"] = name
    return {
        "schema": ACTION_PROJECT_SCHEMA,
        "intent": intent,
        "name": name,
        "aiDescription": str(details["ai_description"]).strip() if gesture else "",
        "semanticKey": details["selector_id"] if gesture else "",
        "suggestedEmotion": "" if gesture else details["emotion"],
        "suggestedIntensity": 1 if gesture else details["intensity"],
        "notes": "",
        "sequence": sequence,
        "dependencies": [],
    }


def clip_and_details(project: Mapping[str, Any]) -> tuple[JsonObject, JsonObject]:
    """A stored project's clip, as a copy, and its details as the tools name them: ``build_project`` undone."""

    details: JsonObject = {"name": project.get("name", "")}
    if project.get("intent") == "reaction":
        details["emotion"] = project.get("suggestedEmotion", "")
        details["intensity"] = project.get("suggestedIntensity", 1)
    else:
        details["ai_description"] = project.get("aiDescription", "")
        details["selector_id"] = project.get("semanticKey", "")
    return copy.deepcopy(dict(project["sequence"])), details


__all__ = [
    "ACTION_PROJECT_SCHEMA",
    "CATALOG_DESCRIPTION_LENGTH",
    "CATALOG_NAME_LENGTH",
    "CATALOG_STRING_LENGTH",
    "DETAIL_FIELDS",
    "MAX_AI_DESCRIPTION_LENGTH",
    "MAX_CLIP_BYTES",
    "MAX_CLIP_DEPTH",
    "MAX_CLIP_ID_LENGTH",
    "MAX_DRAFT_SECONDS",
    "MAX_NAME_LENGTH",
    "MAX_PROBLEMS",
    "MAX_PROBLEM_LENGTH",
    "MAX_SELECTOR_ID_LENGTH",
    "REACTION_BODY_FIELDS",
    "Intent",
    "JsonObject",
    "SelectorInUse",
    "bounded_problems",
    "bounded_text",
    "build_project",
    "clip_and_details",
    "clip_id",
    "clip_problems",
    "detail_problems",
    "draft_problems",
    "held_detail_problems",
    "held_details",
    "is_storable_text",
    "nests_deeper_than",
    "reaction_body_problems",
    "timeline_problems",
]

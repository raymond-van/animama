"""The content assistant's authoring layer: clip edits, draft validation, the tools and the deterministic author.

Everything here runs on plain dictionaries with no model, database or route.
"""

from __future__ import annotations

import copy
import json
import logging
import re
import tracemalloc
from importlib.resources import files
from pathlib import Path
from typing import Any, get_args

import pytest

from animama.app.generation import clip_edits, draft_validation as validation, prompts, tools
from animama.app.generation.deterministic_author import (
    EXAMPLE_REACTION_EMOTION,
    EXAMPLE_REACTION_INTENSITY,
    DeterministicAuthor,
    example_gesture_clip,
    example_reaction_clip,
)
from animama.app.model_clients import ModelClientToolCall
from animama.app.services.content_kind_registry import SEMANTIC_KEY_PATTERN
from animama.domain.emotions import TRACKED_EMOTIONS
from animama.domain.generation import GENERATION_INTENTS
from animama.logging import failure_site

REPOSITORY = Path(__file__).parents[1]
VALID_CLIP: dict[str, Any] = json.loads(
    (
        REPOSITORY / "src/frontend/web/src/lib/avatar/poses/animaPoseClip/fixtures/compatibility-valid-v2.json"
    ).read_text()
)
INCLUDED_GESTURES = REPOSITORY / "content/included/gestures"
# A Reaction is a face only: beats and expression tracks.
REACTION_CLIP: dict[str, Any] = {
    "schema": "animaPoseClip/2.0",
    "id": "soft-joy",
    "name": "Soft Joy",
    "duration": 1.2,
    "beats": [
        {"id": "start", "label": "Start", "time": 0},
        {"id": "peak", "label": "Peak", "time": 0.4},
        {"id": "end", "label": "End", "time": 1.1},
    ],
    "expressions": {"happy": [{"beat": "start", "v": 0}, {"beat": "peak", "v": 0.6}, {"beat": "end", "v": 0}]},
}
GESTURE_DETAILS = {
    "name": "Shy Wave",
    "ai_description": "Use for a bashful hello. A small wave with a small smile.",
    "selector_id": "shy_wave",
}
REACTION_DETAILS = {"name": "Soft Joy", "emotion": "joy", "intensity": 2}
NOTE = "A low, short wave."


def _included(name: str) -> dict[str, Any]:
    clip: dict[str, Any] = json.loads((INCLUDED_GESTURES / name / f"{name}.json").read_text(encoding="utf-8"))
    return clip


def _call(tool: str, arguments: Any, call_id: str = "call_1") -> ModelClientToolCall:
    text = arguments if isinstance(arguments, str) else json.dumps(arguments)
    return ModelClientToolCall(id=call_id, name=tool, arguments=text)


def _submit(clip: Any = None, **overrides: Any) -> ModelClientToolCall:
    arguments = {"clip": VALID_CLIP if clip is None else clip, **GESTURE_DETAILS, "note": NOTE, **overrides}
    return _call("submit_draft", arguments)


def _nested(levels: int) -> list[Any]:
    """``levels`` arrays, each inside the one before, built without recursion."""

    value: list[Any] = []
    for _ in range(levels - 1):
        value = [value]
    return value


def _nested_json(levels: int) -> str:
    return "[" * levels + "]" * levels


TOO_DEEP = f"clip is nested deeper than {validation.MAX_CLIP_DEPTH} levels"


def _drafted(intent: validation.Intent = "gesture") -> tools.WorkingDraft:
    """A working draft that already holds a valid clip and details, as a revise, repair or review pass starts."""

    if intent == "gesture":
        return tools.WorkingDraft(intent="gesture", clip=copy.deepcopy(VALID_CLIP), details=dict(GESTURE_DETAILS))
    return tools.WorkingDraft(intent="reaction", clip=copy.deepcopy(REACTION_CLIP), details=dict(REACTION_DETAILS))


# --- Where a failure happened, for a log that may not quote it ---------------------


def test_a_failure_is_located_by_module_and_line_and_never_by_its_message() -> None:
    def deepest() -> None:
        raise OSError("MODEL-TEXT-SENTINEL")

    def outer() -> None:
        deepest()

    try:
        outer()
    except OSError as error:
        site = failure_site(error)

    assert site is not None
    module, line = site.rsplit(":", 1)
    # With none of the package's own code in the way, the innermost frame: where it was raised, not caught.
    assert module == __name__ and int(line) == deepest.__code__.co_firstlineno + 1
    assert "SENTINEL" not in site
    # A failure that was never raised happened nowhere.
    assert failure_site(OSError("never raised")) is None


class _Unmeasurable(str):
    def __len__(self) -> int:
        raise OSError("MODEL-TEXT-SENTINEL /private/path")


def _lines_of(function: Any) -> set[int]:
    return {line for _, _, line in function.__code__.co_lines() if line is not None}


def test_a_failure_beneath_the_packages_code_is_located_at_the_packages_own_line() -> None:
    """A line deep inside a library says little; the package's line that led there says which call failed."""

    def site_of(action: Any) -> str:
        try:
            action()
        except (OSError, TypeError) as error:
            return failure_site(error) or ""
        raise AssertionError("nothing failed")

    # Raised in a library the package called (the standard library's JSON encoder, on a value it cannot write).
    in_library = site_of(lambda: prompts.data_json({"clip": object()}))
    # Raised in code the package was handed, here this module's.
    in_callback = site_of(lambda: validation.bounded_text(_Unmeasurable("text"), 10))

    module, line = in_library.rsplit(":", 1)
    assert module == "animama.app.generation.prompts" and int(line) in _lines_of(prompts.data_json)
    module, line = in_callback.rsplit(":", 1)
    assert module == "animama.app.generation.draft_validation" and int(line) in _lines_of(validation.bounded_text)
    # Still a module and a line, and nothing of the failure's wording or of any path.
    assert "SENTINEL" not in in_library + in_callback and "/" not in in_library + in_callback


# --- JSON Pointer edits ---------------------------------------------------------


def test_set_creates_and_replaces_values() -> None:
    document: dict[str, Any] = {"joints": {"head": {"flexion": [{"v": 0}, {"v": -4}]}}, "a/b": {"~": 1}}

    clip_edits.pointer_set(document, "/joints/head/flexion/1/v", -8)
    clip_edits.pointer_set(document, "/joints/head/rotation", [{"v": 5}])
    clip_edits.pointer_set(document, "/a~1b/~0", 2)

    assert document == {
        "joints": {"head": {"flexion": [{"v": 0}, {"v": -8}], "rotation": [{"v": 5}]}},
        "a/b": {"~": 2},
    }


def test_set_appends_to_an_array_with_a_dash() -> None:
    document = {"beats": [{"id": "start"}]}

    clip_edits.pointer_set(document, "/beats/-", {"id": "end"})

    assert document == {"beats": [{"id": "start"}, {"id": "end"}]}


def test_remove_deletes_a_member_or_an_item() -> None:
    document = {"expressions": {"happy": [1, 2, 3], "sad": [0]}}

    clip_edits.pointer_remove(document, "/expressions/happy/1")
    clip_edits.pointer_remove(document, "/expressions/sad")

    assert document == {"expressions": {"happy": [1, 3]}}


@pytest.mark.parametrize(
    ("pointer", "reason"),
    [
        ("/joints/neck/flexion", "'neck' does not exist"),
        ("/joints/head/flexion/2/v", "index 2 is past the end of an array of 2"),
        ("/joints/head/flexion/first/v", "'first' is not an array index"),
        ("/duration/seconds", "'duration' is not an object or array"),
        ("/duration/seconds/unit", "'duration' is not an object or array"),
        ("joints/head", "a path must start with '/'"),
        ("/joints/he~2ad", "'~' must be written as ~0 and '/' as ~1"),
        ("", "the path must name a value inside the clip, not the whole clip"),
    ],
)
def test_a_path_that_cannot_be_followed_is_an_error(pointer: str, reason: str) -> None:
    document = {"duration": 2, "joints": {"head": {"flexion": [{"v": 0}, {"v": -4}]}}}
    before = copy.deepcopy(document)

    with pytest.raises(clip_edits.PointerError, match=re.escape(reason)):
        clip_edits.pointer_set(document, pointer, 1)

    assert document == before


def test_remove_needs_an_existing_value() -> None:
    document = {"joints": {"head": {"flexion": [1]}}}

    with pytest.raises(clip_edits.PointerError, match="'yaw' does not exist"):
        clip_edits.pointer_remove(document, "/joints/head/yaw")
    with pytest.raises(clip_edits.PointerError, match="past the end"):
        clip_edits.pointer_remove(document, "/joints/head/flexion/1")
    with pytest.raises(clip_edits.PointerError, match="is not an array index"):
        clip_edits.pointer_remove(document, "/joints/head/flexion/-")


def test_operations_apply_in_order_to_a_copy_and_stop_at_the_first_failure() -> None:
    clip = {"beats": [{"id": "start"}], "joints": {}}

    edited, problems = clip_edits.apply_operations(
        clip,
        [
            {"op": "set", "path": "/joints/head", "value": {}},
            {"op": "set", "path": "/joints/head/flexion", "value": [{"v": 0}]},
            {"op": "remove", "path": "/beats/0"},
        ],
    )
    assert problems == [] and edited == {"beats": [], "joints": {"head": {"flexion": [{"v": 0}]}}}
    assert clip == {"beats": [{"id": "start"}], "joints": {}}

    unchanged, problems = clip_edits.apply_operations(
        clip, [{"op": "remove", "path": "/beats/0"}, {"op": "remove", "path": "/beats/0"}]
    )
    assert unchanged is clip and problems == [
        "operations[1] (remove /beats/0): index 0 is past the end of an array of 0"
    ]
    for operations, problem in (
        ([], "operations must be a non-empty array"),
        ("set", "operations must be a non-empty array"),
        (["set"], "operations[0] must be an object"),
        ([{"op": "move", "path": "/a"}], 'operations[0] needs "op" ("set" or "remove") and a string "path"'),
        (
            [{"op": ["set"], "path": "/a", "value": 1}],
            'operations[0] needs "op" ("set" or "remove") and a string "path"',
        ),
        ([{"op": {"set": 1}, "path": "/a"}], 'operations[0] needs "op" ("set" or "remove") and a string "path"'),
        (
            [{"op": "set", "path": ["a"], "value": 1}],
            'operations[0] needs "op" ("set" or "remove") and a string "path"',
        ),
        ([{"op": "set", "path": "/a"}], 'operations[0] is a "set" without a "value"'),
    ):
        assert clip_edits.apply_operations(clip, operations) == (clip, [problem])


def test_an_index_of_thousands_of_digits_is_refused_like_any_other_bad_index() -> None:
    document = {"beats": [{"id": "start"}]}
    digits = "9" * 5000

    for pointer in (f"/beats/{digits}", f"/beats/{digits}/id", "/beats/1234567890"):
        with pytest.raises(clip_edits.PointerError, match="is not an array index") as refused:
            clip_edits.pointer_set(document, pointer, 1)
        assert len(str(refused.value)) < 60
        with pytest.raises(clip_edits.PointerError, match="is not an array index"):
            clip_edits.pointer_remove(document, pointer)
    with pytest.raises(clip_edits.PointerError, match="index 123456789 is past the end"):
        clip_edits.pointer_set(document, "/beats/123456789", 1)


def test_a_failed_operation_quotes_only_the_start_of_a_long_path() -> None:
    path = "/beats/" + "9" * 5000

    _, [problem] = clip_edits.apply_operations({"beats": []}, [{"op": "remove", "path": path}])

    assert problem.endswith("'9999999999999999' is not an array index")
    assert len(problem) < clip_edits.MAX_QUOTED_PATH + 80


# --- Clip validation ------------------------------------------------------------


def test_the_shared_valid_clip_and_the_example_gestures_are_drafts() -> None:
    assert validation.clip_problems(VALID_CLIP) == []
    for name in tools.EXAMPLE_NAMES:
        assert validation.clip_problems(_included(name)) == [], name


def test_a_clip_that_cannot_be_a_draft_says_why() -> None:
    assert validation.clip_problems([VALID_CLIP]) == ["clip must be a JSON object"]
    assert validation.clip_problems({**VALID_CLIP, "schema": "animaPoseClip/1.0"}) == [
        'schema must be "animaPoseClip/2.0"'
    ]
    assert validation.clip_problems({**VALID_CLIP, "loop": "yes"}) == ["loop must be true or false"]
    assert validation.clip_problems({**VALID_CLIP, "joints": {"tail": {"wag": []}}}) == [
        "Gesture clip joints.tail is not a known joint"
    ]
    oversized = {**VALID_CLIP, "generator": "x" * validation.MAX_CLIP_BYTES}
    [problem] = validation.clip_problems(oversized)
    assert problem.endswith(f"the limit is {validation.MAX_CLIP_BYTES}")
    for number in (float("nan"), float("inf")):
        assert validation.clip_problems({**VALID_CLIP, "generator": number}) == [
            "clip holds a number JSON cannot represent (NaN or Infinity)"
        ]


def test_a_clip_nested_deeper_than_any_real_one_is_refused() -> None:
    # A real clip nests under ten levels; the clip itself is the first.
    assert validation.MAX_CLIP_DEPTH == 24
    for name in tools.EXAMPLE_NAMES:
        assert validation.clip_problems(_included(name)) == []
    assert validation.clip_problems({**VALID_CLIP, "x": _nested(validation.MAX_CLIP_DEPTH - 1)}) == []

    for levels in (validation.MAX_CLIP_DEPTH, 260, 600):
        assert validation.clip_problems({**VALID_CLIP, "x": _nested(levels)}) == [TOO_DEEP]
    # Objects nest as arrays do, and nesting under a known field counts like any other.
    objects: dict[str, Any] = {}
    for _ in range(40):
        objects = {"x": objects}
    assert validation.clip_problems({**VALID_CLIP, "joints": objects}) == [TOO_DEEP]


def test_the_depth_of_a_clip_is_found_without_recursion() -> None:
    # Far deeper than the interpreter would follow: still a plain refusal, never a RecursionError.
    assert validation.clip_problems({**VALID_CLIP, "x": _nested(200_000)}) == [TOO_DEEP]
    assert validation.draft_problems("gesture", {**VALID_CLIP, "x": _nested(200_000)}, GESTURE_DETAILS) == [TOO_DEEP]


def test_depth_is_measured_through_every_branch_with_the_value_itself_as_the_first_level() -> None:
    # dict (1) > list (2) > [2, [3]] (3) > [3] (4); the tuple's branch ends at the same level.
    branches = {"a": [[1], [2, [3]]], "b": ({"c": ()},), "n": 1.5, "s": "text"}
    assert validation.nests_deeper_than(branches, 3) and not validation.nests_deeper_than(branches, 4)
    # A deep branch is found behind any number of wide, shallow ones.
    assert validation.nests_deeper_than({"wide": [0.5] * 1000, "lists": [[]] * 1000, "deep": _nested(30)}, 24)
    # What does not nest is no level at all.
    for scalar in (None, 1, "text", 0.5, True):
        assert not validation.nests_deeper_than(scalar, 0)
    assert validation.nests_deeper_than([], 0) and not validation.nests_deeper_than([], 1)


def test_the_depth_walk_keeps_only_the_containers_it_is_inside() -> None:
    """A clip may be wide where it may not be deep, so width must cost the walk nothing to keep."""

    wide = {"numbers": [0.5] * 400_000, "lists": [[] for _ in range(100_000)], "pairs": [[1, 2]] * 100_000}
    was_tracing = tracemalloc.is_tracing()
    if not was_tracing:
        tracemalloc.start()
    try:
        before = tracemalloc.get_traced_memory()[0]
        tracemalloc.reset_peak()
        assert not validation.nests_deeper_than(wide, validation.MAX_CLIP_DEPTH)
        kept = tracemalloc.get_traced_memory()[1] - before
    finally:
        if not was_tracing:
            tracemalloc.stop()

    # A few iterators, in fact. Queueing every value before looking at it kept 25 MB for this clip.
    assert kept < 1024 * 1024


def test_several_problems_are_listed_together() -> None:
    clip = {**VALID_CLIP, "schema": "animaPoseClip/1.0", "loop": 1, "beats": "none"}

    assert validation.clip_problems(clip) == [
        'schema must be "animaPoseClip/2.0"',
        "loop must be true or false",
        "Gesture clip beats must be an array",
    ]


def test_a_draft_is_at_most_a_minute_long() -> None:
    assert validation.MAX_DRAFT_SECONDS == 60
    assert validation.clip_problems({**VALID_CLIP, "duration": 60}) == []
    assert validation.clip_problems({**VALID_CLIP, "duration": 60.5}) == [
        "duration must be at most 60 seconds for a draft"
    ]


@pytest.mark.parametrize("text", ["nul\x00inside", "lone\ud800surrogate"])
def test_text_the_database_cannot_store_is_a_problem(text: str) -> None:
    """PostgreSQL's JSONB refuses a NUL and an unpaired surrogate, so neither may reach a stored project."""

    problem = "clip holds a character that cannot be stored (NUL or an unpaired surrogate)"

    assert validation.clip_problems({**VALID_CLIP, "generator": text}) == [problem]
    assert validation.clip_problems({**VALID_CLIP, text: 1}) == [problem]
    # The six characters of a written-out escape are ordinary text.
    assert validation.clip_problems({**VALID_CLIP, "generator": "\\u0000 as text"}) == []


def test_a_problem_that_quotes_a_long_name_keeps_its_reason() -> None:
    clip = {**VALID_CLIP, "joints": {"t" * 5000: {"wag": []}}}

    [problem] = validation.clip_problems(clip)

    assert len(problem) <= validation.MAX_PROBLEM_LENGTH
    assert problem.startswith("Gesture clip joints.tttt") and problem.endswith("is not a known joint")


def test_problems_are_capped_in_number_and_length() -> None:
    bounded = validation.bounded_problems([f"{number}: " + "x" * 1000 for number in range(50)])

    assert len(bounded) == validation.MAX_PROBLEMS == 20
    assert all(len(problem) == validation.MAX_PROBLEM_LENGTH == 300 for problem in bounded)
    assert bounded[0].startswith("0: xxx")
    assert validation.bounded_problems(["short"]) == ["short"]


# --- The Reaction rule and the detail rules ---------------------------------------


def test_a_reaction_clip_may_hold_no_body_field() -> None:
    assert validation.REACTION_BODY_FIELDS == (
        "joints",
        "rotations",
        "hipsPosition",
        "hands",
        "contacts",
        "plantFeet",
        "basePose",
        "mutedProceduralLayers",
    )
    assert validation.draft_problems("reaction", REACTION_CLIP, REACTION_DETAILS) == []

    # The shared clip is a Gesture: it holds every body field.
    assert validation.draft_problems("reaction", VALID_CLIP, REACTION_DETAILS) == [
        f"{field}: a Reaction has no body motion; remove this field" for field in validation.REACTION_BODY_FIELDS
    ]
    # An empty or false body field is still one the creator would strip.
    assert validation.draft_problems("reaction", {**REACTION_CLIP, "plantFeet": False}, REACTION_DETAILS) == [
        "plantFeet: a Reaction has no body motion; remove this field"
    ]
    assert validation.draft_problems("gesture", VALID_CLIP, GESTURE_DETAILS) == []


def test_a_gesture_needs_a_name_an_ai_description_and_a_selector_id() -> None:
    assert validation.detail_problems("gesture", GESTURE_DETAILS) == []
    assert validation.detail_problems("gesture", {}) == [
        "name must be a non-empty string of at most 80 characters",
        "ai_description must be a non-empty string of at most 1000 characters",
        "selector_id must be lower-case snake_case (letters, digits and single underscores) of at most 64 characters",
    ]
    for name in ("", "   ", "x" * 81, 7, None, ["Shy Wave"], "nul\x00", "lone\ud800"):
        assert validation.detail_problems("gesture", {**GESTURE_DETAILS, "name": name}) == [
            "name must be a non-empty string of at most 80 characters"
        ], name
    assert validation.detail_problems("gesture", {**GESTURE_DETAILS, "name": "x" * 80}) == []
    for description in ("", " \n ", "x" * 1001, 3, None, "nul\x00"):
        assert validation.detail_problems("gesture", {**GESTURE_DETAILS, "ai_description": description}) == [
            "ai_description must be a non-empty string of at most 1000 characters"
        ], description


@pytest.mark.parametrize("selector", ["shy_wave", "wave", "wave_2", "laugh_mild", "2_thumbs_up", "x" * 64])
def test_a_snake_case_selector_id_is_accepted_and_the_registry_accepts_it_too(selector: str) -> None:
    assert validation.detail_problems("gesture", {**GESTURE_DETAILS, "selector_id": selector}) == []
    assert SEMANTIC_KEY_PATTERN.fullmatch(selector)


@pytest.mark.parametrize(
    "selector",
    ["Shy_Wave", "shy-wave", "shy.wave", "shy wave", "_shy", "shy_", "shy__wave", "", "x" * 65, "手を振る", 7, None]
    + ["../../escaped", "shy_wave\n", ["shy_wave"]],
)
def test_a_selector_id_that_is_not_snake_case_is_a_problem(selector: Any) -> None:
    in_use: list[str] = []

    def never_asked(selector_id: str) -> bool:
        in_use.append(selector_id)
        return False

    problems = validation.detail_problems(
        "gesture", {**GESTURE_DETAILS, "selector_id": selector}, selector_in_use=never_asked
    )

    assert problems == [
        "selector_id must be lower-case snake_case (letters, digits and single underscores) of at most 64 characters"
    ]
    # Only a well-formed id is ever looked up.
    assert in_use == []


def test_a_selector_id_another_gesture_uses_is_a_problem() -> None:
    asked: list[str] = []

    def in_use(selector_id: str) -> bool:
        asked.append(selector_id)
        return selector_id == "wave_hello"

    assert validation.detail_problems("gesture", GESTURE_DETAILS, selector_in_use=in_use) == []
    assert validation.detail_problems(
        "gesture", {**GESTURE_DETAILS, "selector_id": "wave_hello"}, selector_in_use=in_use
    ) == ["selector_id wave_hello is already used by another Gesture; choose a different one"]
    assert asked == ["shy_wave", "wave_hello"]


def test_a_reaction_needs_a_name_a_tracked_emotion_and_an_intensity() -> None:
    def never(selector_id: str) -> bool:
        raise AssertionError("a Reaction has no Selector ID to look up")

    assert validation.detail_problems("reaction", REACTION_DETAILS, selector_in_use=never) == []
    emotion_problem = f"emotion must be one of: {', '.join(TRACKED_EMOTIONS)}"
    # The whole list fits in one problem.
    assert len(emotion_problem) <= validation.MAX_PROBLEM_LENGTH
    assert validation.detail_problems("reaction", {}) == [
        "name must be a non-empty string of at most 80 characters",
        emotion_problem,
        "intensity must be 1, 2, 3 or 4",
    ]
    for emotion in ("happy", "Joy", "", None, 3, ["joy"]):
        assert validation.detail_problems("reaction", {**REACTION_DETAILS, "emotion": emotion}) == [emotion_problem]
    for emotion in TRACKED_EMOTIONS:
        assert validation.detail_problems("reaction", {**REACTION_DETAILS, "emotion": emotion}) == []
    for intensity in (0, 5, 2.0, "2", True, None):
        assert validation.detail_problems("reaction", {**REACTION_DETAILS, "intensity": intensity}) == [
            "intensity must be 1, 2, 3 or 4"
        ], intensity
    for intensity in (1, 2, 3, 4):
        assert validation.detail_problems("reaction", {**REACTION_DETAILS, "intensity": intensity}) == []
    # A Selector ID or an AI description given for a Reaction is not one of its details.
    assert validation.detail_problems("reaction", {**REACTION_DETAILS, "selector_id": "Not Snake"}) == []


def test_a_draft_cannot_use_effects_or_sounds_yet() -> None:
    """A draft's project has no dependencies in this phase, so an event would name an effect it does not carry."""

    with_event = {**VALID_CLIP, "events": [{"id": "pop", "time": 0.5, "kind": "avatar_vfx", "effectId": "sparkle"}]}

    assert validation.clip_problems(with_event) == []
    assert validation.draft_problems("gesture", with_event, GESTURE_DETAILS) == [
        "events: a draft cannot use effects or sounds yet; remove this field"
    ]
    assert validation.draft_problems("gesture", {**VALID_CLIP, "events": []}, GESTURE_DETAILS) == []


def test_a_draft_s_problems_are_the_clip_s_then_the_details() -> None:
    clip = {**VALID_CLIP, "schema": "animaPoseClip/1.0"}

    assert validation.draft_problems("gesture", clip, {**GESTURE_DETAILS, "name": ""}) == [
        'schema must be "animaPoseClip/2.0"',
        "name must be a non-empty string of at most 80 characters",
    ]
    # A clip that is not an object has nothing else to check, but the details still do.
    assert validation.draft_problems("gesture", None, {**GESTURE_DETAILS, "selector_id": "Wave"}) == [
        "clip must be a JSON object",
        "selector_id must be lower-case snake_case (letters, digits and single underscores) of at most 64 characters",
    ]


def test_the_intents_are_the_stored_ones() -> None:
    assert get_args(validation.Intent) == GENERATION_INTENTS
    assert set(validation.DETAIL_FIELDS) == set(GENERATION_INTENTS)


# --- Building the project ---------------------------------------------------------


def test_a_gesture_project_is_shaped_like_the_creator_s() -> None:
    project = validation.build_project("gesture", VALID_CLIP, GESTURE_DETAILS)

    assert project == {
        "schema": "animamaActionProject/1.0",
        "intent": "gesture",
        "name": "Shy Wave",
        "aiDescription": GESTURE_DETAILS["ai_description"],
        "semanticKey": "shy_wave",
        "suggestedEmotion": "",
        "suggestedIntensity": 1,
        "notes": "",
        "sequence": {**VALID_CLIP, "id": "shy-wave", "name": "Shy Wave"},
        "dependencies": [],
    }
    # The clip's own id and name keep their places; only their values follow the item's name.
    assert list(project["sequence"]) == list(VALID_CLIP)
    # The project owns its clip: a later edit of the working clip does not reach it.
    assert project["sequence"]["beats"] is not VALID_CLIP["beats"]


def test_a_reaction_project_carries_its_emotion_and_intensity() -> None:
    project = validation.build_project("reaction", REACTION_CLIP, REACTION_DETAILS)

    assert project["intent"] == "reaction" and project["name"] == "Soft Joy"
    assert project["suggestedEmotion"] == "joy" and project["suggestedIntensity"] == 2
    assert project["semanticKey"] == "" and project["aiDescription"] == ""
    assert project["sequence"]["id"] == "soft-joy" and project["dependencies"] == []


@pytest.mark.parametrize(
    ("name", "intent", "clip_id"),
    [
        ("Shy Wave", "gesture", "shy-wave"),
        ("  Wave   Hello!  ", "gesture", "wave-hello"),
        ("Café Olé (v2)", "gesture", "cafe-ole-v2"),
        ("ＦＵＬＬ width", "gesture", "full-width"),
        ("手を振る", "gesture", "new-gesture"),
        ("にっこり", "reaction", "new-reaction"),
        ("--- 9 lives ---", "gesture", "9-lives"),
    ],
)
def test_the_clip_takes_the_item_s_name_and_its_kebab_case_id(name: str, intent: Any, clip_id: str) -> None:
    """The creator's rule (``normalizeActionDocument`` and ``actionNameSlug``)."""

    details = {**(GESTURE_DETAILS if intent == "gesture" else REACTION_DETAILS), "name": name}

    project = validation.build_project(intent, VALID_CLIP if intent == "gesture" else REACTION_CLIP, details)

    assert project["name"] == project["sequence"]["name"] == name.strip()
    assert project["sequence"]["id"] == clip_id


def test_a_project_gives_back_its_clip_and_details() -> None:
    for intent, clip, details in (
        ("gesture", VALID_CLIP, GESTURE_DETAILS),
        ("reaction", REACTION_CLIP, REACTION_DETAILS),
    ):
        project = validation.build_project(intent, clip, details)  # type: ignore[arg-type]

        sequence, given = validation.clip_and_details(project)

        assert given == details and sequence == project["sequence"] and sequence is not project["sequence"]
        assert validation.build_project(intent, sequence, given) == project  # type: ignore[arg-type]


# --- The tools each pass offers ---------------------------------------------------


def test_each_pass_offers_its_tools_in_order() -> None:
    assert tools.offered_tools("write") == ("submit_draft", "read_example", "ask_questions")
    assert tools.offered_tools("revise") == ("edit_draft", "submit_draft", "read_example", "ask_questions")
    assert tools.offered_tools("repair") == ("edit_draft", "submit_draft")
    assert tools.offered_tools("review") == ("accept_draft", "edit_draft")
    # Questions are asked once: a request that was already asked gets no question tool.
    assert tools.offered_tools("write", can_ask=False) == ("submit_draft", "read_example")
    assert tools.offered_tools("revise", can_ask=False) == ("edit_draft", "submit_draft", "read_example")
    assert tools.offered_tools("repair", can_ask=False) == tools.offered_tools("repair")
    assert tools.MAX_TOOL_ROUNDS == 8


@pytest.mark.parametrize("intent", ["gesture", "reaction"])
@pytest.mark.parametrize("kind", ["write", "revise", "repair", "review"])
def test_a_pass_s_definitions_are_non_strict_function_tools(kind: Any, intent: Any) -> None:
    definitions = tools.tool_definitions(kind, intent)

    assert tuple(tool["function"]["name"] for tool in definitions) == tools.offered_tools(kind)
    for tool in definitions:
        function = tool["function"]
        assert tool["type"] == "function" and function["strict"] is False and function["description"]
        parameters = function["parameters"]
        assert parameters["type"] == "object" and parameters["additionalProperties"] is False
        assert set(parameters["required"]) <= set(parameters["properties"])
    assert tools.tool_definitions(kind, intent, can_ask=False) == tuple(
        tool for tool in definitions if tool["function"]["name"] != "ask_questions"
    )


def test_each_definition_names_the_typed_arguments_its_tool_reads() -> None:
    def properties(name: str, intent: Any) -> dict[str, Any]:
        found: dict[str, Any] = tools.tool_definition(name, intent)["function"]["parameters"]
        return found

    gesture_submit = properties("submit_draft", "gesture")
    assert list(gesture_submit["properties"]) == ["clip", "name", "ai_description", "selector_id", "note"]
    assert gesture_submit["required"] == ["clip", "name", "ai_description", "selector_id", "note"]
    assert gesture_submit["properties"]["clip"]["type"] == "object"

    reaction_submit = properties("submit_draft", "reaction")
    assert list(reaction_submit["properties"]) == ["clip", "name", "emotion", "intensity", "note"]
    assert reaction_submit["properties"]["emotion"]["enum"] == list(TRACKED_EMOTIONS)
    assert reaction_submit["properties"]["intensity"] == {
        "type": "integer",
        "enum": [1, 2, 3, 4],
        "description": reaction_submit["properties"]["intensity"]["description"],
    }

    # An edit may change the clip, the details or both, so only its note is required.
    gesture_edit = properties("edit_draft", "gesture")
    assert list(gesture_edit["properties"]) == ["operations", "name", "ai_description", "selector_id", "note"]
    assert gesture_edit["required"] == ["note"]
    operation = gesture_edit["properties"]["operations"]["items"]
    assert operation["properties"]["op"]["enum"] == ["set", "remove"] and operation["required"] == ["op", "path"]
    assert list(properties("edit_draft", "reaction")["properties"]) == [
        "operations",
        "name",
        "emotion",
        "intensity",
        "note",
    ]

    assert properties("read_example", "gesture")["properties"] == {
        "name": {"type": "string", "enum": ["wave-hello", "mild-laugh", "have-an-idea"]}
    }
    assert list(properties("accept_draft", "gesture")["properties"]) == ["note"]
    questions = properties("ask_questions", "gesture")["properties"]["questions"]
    assert (questions["minItems"], questions["maxItems"]) == (1, 4)
    options = questions["items"]["properties"]["options"]
    assert (options["minItems"], options["maxItems"]) == (2, 4) and options["items"] == {"type": "string"}

    with pytest.raises(KeyError):
        tools.tool_definition("run_command", "gesture")
    # A caller cannot change the definitions the next pass is given.
    tools.tool_definition("submit_draft", "gesture")["function"]["name"] = "changed"
    assert tools.tool_definition("submit_draft", "gesture")["function"]["name"] == "submit_draft"


# --- submit_draft -----------------------------------------------------------------


def test_a_valid_submission_becomes_the_working_draft_and_ends_the_pass() -> None:
    draft = tools.WorkingDraft(intent="gesture")

    reply = tools.run_tool(draft, _submit(name="  Shy Wave "), tools.offered_tools("write"))

    assert reply.problems == [] and "valid" in reply.output
    assert draft.outcome == "submitted" and draft.clip == VALID_CLIP and draft.note == NOTE
    assert draft.details == GESTURE_DETAILS
    assert draft.project() == validation.build_project("gesture", VALID_CLIP, GESTURE_DETAILS)


def test_an_invalid_submission_lists_its_problems_and_changes_nothing() -> None:
    broken = copy.deepcopy(VALID_CLIP)
    broken["joints"]["rightUpperArm"]["elevation"][1]["v"] = "sideways"
    draft = tools.WorkingDraft(intent="gesture")

    reply = tools.run_tool(draft, _submit(broken, selector_id="Shy Wave"), tools.offered_tools("write"))

    assert reply.problems == [
        "Gesture clip joints.rightUpperArm.elevation[1].v must be a finite number",
        "selector_id must be lower-case snake_case (letters, digits and single underscores) of at most 64 characters",
    ]
    assert reply.output == (
        "Nothing was changed. Problems:\n"
        f"- {reply.problems[0]}\n- {reply.problems[1]}\n"
        "Fix them and call the tool again."
    )
    assert draft == tools.WorkingDraft(intent="gesture")


@pytest.mark.parametrize("levels", [260, 600])
def test_a_deeply_nested_submission_is_a_refused_call(levels: int) -> None:
    # As a model could write it: a valid clip with one more key, holding arrays inside arrays.
    arguments = json.dumps({"clip": VALID_CLIP, **GESTURE_DETAILS, "note": NOTE})
    arguments = arguments.replace('"schema":', f'"x":{_nested_json(levels)},"schema":', 1)
    draft = tools.WorkingDraft(intent="gesture")

    reply = tools.run_tool(draft, _call("submit_draft", arguments), tools.offered_tools("write"))

    assert reply.problems == [TOO_DEEP]
    assert draft.clip is None and draft.outcome is None


@pytest.mark.parametrize("levels", [260, 600])
def test_a_deeply_nested_edit_value_is_a_refused_call(levels: int) -> None:
    arguments = f'{{"operations":[{{"op":"set","path":"/x","value":{_nested_json(levels)}}}],"note":"n"}}'
    draft = _drafted()

    reply = tools.run_tool(draft, _call("edit_draft", arguments), tools.offered_tools("repair"))

    assert reply.problems == [TOO_DEEP]
    assert draft.clip == VALID_CLIP and draft.outcome is None
    # What is left can still be made into a project.
    assert draft.project()["sequence"]["duration"] == VALID_CLIP["duration"]


def test_nesting_grown_one_edit_at_a_time_is_refused_at_the_bound() -> None:
    draft = _drafted()
    offered = tools.offered_tools("repair")
    assert tools.run_tool(
        draft, _call("edit_draft", {"operations": [{"op": "set", "path": "/x", "value": []}]}), offered
    )

    accepted = 0
    for level in range(100):
        grow = {"op": "set", "path": "/x" + "/0" * level + "/-", "value": []}
        reply = tools.run_tool(draft, _call("edit_draft", {"operations": [grow], "note": "deeper"}), offered)
        if reply.problems:
            break
        accepted += 1

    # ``x`` is the clip's second level; each accepted edit added one more, up to the bound and no further.
    assert reply.problems == [TOO_DEEP] and accepted == validation.MAX_CLIP_DEPTH - 2
    assert draft.clip is not None and validation.clip_problems(draft.clip) == []
    # Many operations in one call are judged by what they leave, like one.
    many = [{"op": "set", "path": "/y", "value": []}] + [
        {"op": "set", "path": "/y" + "/0" * level + "/-", "value": []} for level in range(60)
    ]
    assert tools.run_tool(draft, _call("edit_draft", {"operations": many}), offered).problems == [TOO_DEEP]
    assert "y" not in draft.clip


def test_a_submission_without_its_details_is_refused_in_a_write_pass() -> None:
    draft = tools.WorkingDraft(intent="gesture")

    reply = tools.run_tool(draft, _call("submit_draft", {"clip": VALID_CLIP}), tools.offered_tools("write"))

    assert len(reply.problems) == 3 and reply.problems[0].startswith("name must be")
    assert draft.clip is None and draft.outcome is None


def test_a_submission_with_a_selector_id_in_use_is_refused() -> None:
    draft = tools.WorkingDraft(intent="gesture")

    reply = tools.run_tool(
        draft, _submit(), tools.offered_tools("write"), selector_in_use=lambda selector_id: selector_id == "shy_wave"
    )

    assert reply.problems == ["selector_id shy_wave is already used by another Gesture; choose a different one"]
    assert draft.outcome is None


def test_a_rewrite_keeps_the_details_it_does_not_give() -> None:
    draft = _drafted()
    rewritten = {**VALID_CLIP, "duration": 2.2}

    reply = tools.run_tool(
        draft,
        _call("submit_draft", {"clip": rewritten, "name": "Shyer Wave", "note": "Slower."}),
        tools.offered_tools("repair"),
    )

    assert reply.problems == [] and draft.outcome == "submitted" and draft.clip == rewritten
    assert draft.details == {**GESTURE_DETAILS, "name": "Shyer Wave"} and draft.note == "Slower."


def test_a_reaction_is_submitted_with_its_emotion_and_intensity() -> None:
    draft = tools.WorkingDraft(intent="reaction")
    arguments = {"clip": REACTION_CLIP, **REACTION_DETAILS, "note": "A soft smile."}

    assert tools.run_tool(draft, _call("submit_draft", arguments), tools.offered_tools("write")).problems == []
    assert draft.outcome == "submitted" and draft.details == REACTION_DETAILS
    assert draft.project()["suggestedEmotion"] == "joy"

    with_body = tools.WorkingDraft(intent="reaction")
    arguments = {**arguments, "clip": {**REACTION_CLIP, "basePose": "relaxedRest"}, "intensity": 9}
    reply = tools.run_tool(with_body, _call("submit_draft", arguments), tools.offered_tools("write"))
    assert reply.problems == [
        "basePose: a Reaction has no body motion; remove this field",
        "intensity must be 1, 2, 3 or 4",
    ]
    assert with_body.outcome is None


def test_a_long_note_is_cut_and_an_unstorable_one_is_dropped() -> None:
    draft = tools.WorkingDraft(intent="gesture")
    tools.run_tool(draft, _submit(note="n" * 5000), tools.offered_tools("write"))
    assert draft.note == "n" * tools.MAX_NOTE_LENGTH

    for note in ("nul\x00", 7, None):
        draft = tools.WorkingDraft(intent="gesture")
        assert tools.run_tool(draft, _submit(note=note), tools.offered_tools("write")).problems == []
        assert draft.note == "" and draft.outcome == "submitted"


# --- edit_draft -------------------------------------------------------------------


def test_an_edit_changes_the_working_clip_and_ends_the_pass() -> None:
    draft = _drafted()
    lower = {"op": "set", "path": "/joints/rightUpperArm/elevation/1/v", "value": 95}
    drop = {"op": "remove", "path": "/joints/rightUpperArm/elevation/2"}

    reply = tools.run_tool(
        draft,
        _call("edit_draft", {"operations": [lower, drop], "note": "Lowered the arm."}),
        tools.offered_tools("repair"),
    )

    expected = copy.deepcopy(VALID_CLIP)
    expected["joints"]["rightUpperArm"]["elevation"][1]["v"] = 95
    del expected["joints"]["rightUpperArm"]["elevation"][2]
    assert reply.problems == [] and draft.outcome == "edited" and draft.clip == expected
    assert draft.details == GESTURE_DETAILS and draft.note == "Lowered the arm."


def test_an_edit_may_change_details_alone_or_with_the_clip() -> None:
    renamed = _drafted()
    reply = tools.run_tool(
        renamed,
        _call("edit_draft", {"name": "Bashful Wave", "selector_id": "bashful_wave", "note": "Renamed."}),
        tools.offered_tools("revise"),
    )
    assert reply.problems == [] and renamed.outcome == "edited" and renamed.clip == VALID_CLIP
    assert renamed.details == {**GESTURE_DETAILS, "name": "Bashful Wave", "selector_id": "bashful_wave"}

    both = _drafted("reaction")
    arguments = {"operations": [{"op": "set", "path": "/duration", "value": 1.5}], "intensity": 3, "note": "Longer."}
    assert tools.run_tool(both, _call("edit_draft", arguments), tools.offered_tools("revise")).problems == []
    assert both.clip is not None and both.clip["duration"] == 1.5
    assert both.details == {**REACTION_DETAILS, "intensity": 3}


def test_an_edit_that_breaks_the_draft_is_refused_and_leaves_it_as_it_was() -> None:
    draft = _drafted()
    before = copy.deepcopy(draft)
    offered = tools.offered_tools("repair")

    breaking = _call("edit_draft", {"operations": [{"op": "remove", "path": "/beats/0"}], "note": "x"})
    [invalid] = tools.run_tool(draft, breaking, offered).problems
    assert invalid.startswith("Gesture clip ") and draft == before

    missing = {"op": "set", "path": "/joints/leftUpperArm/elevation/0/v", "value": 10}
    assert tools.run_tool(draft, _call("edit_draft", {"operations": [missing], "note": "x"}), offered).problems == [
        "operations[0] (set /joints/leftUpperArm/elevation/0/v): 'leftUpperArm' does not exist"
    ]
    bad_detail = _call("edit_draft", {"selector_id": "Not Snake", "note": "x"})
    assert tools.run_tool(draft, bad_detail, offered).problems == [
        "selector_id must be lower-case snake_case (letters, digits and single underscores) of at most 64 characters"
    ]
    # A valid operation is not kept when a detail given with it is refused.
    mixed = _call(
        "edit_draft", {"operations": [{"op": "set", "path": "/duration", "value": 2.2}], "name": "", "note": "x"}
    )
    assert tools.run_tool(draft, mixed, offered).problems == [
        "name must be a non-empty string of at most 80 characters"
    ]
    assert draft == before


def test_an_edit_needs_something_to_change_and_a_draft_to_change() -> None:
    draft = _drafted()
    offered = tools.offered_tools("repair")

    assert tools.run_tool(draft, _call("edit_draft", {"note": "Nothing."}), offered).problems == [
        "edit_draft needs operations or a detail to change"
    ]
    assert tools.run_tool(draft, _call("edit_draft", {"operations": [], "note": "x"}), offered).problems == [
        "operations must be a non-empty array"
    ]
    assert draft.outcome is None

    empty = tools.WorkingDraft(intent="gesture")
    edit = _call("edit_draft", {"operations": [{"op": "set", "path": "/duration", "value": 3}], "note": "x"})
    assert tools.run_tool(empty, edit, tools.offered_tools("revise")).problems == [
        "there is no draft to edit; use submit_draft"
    ]


# --- accept_draft, read_example and ask_questions -----------------------------------


def test_a_review_may_accept_the_draft_unchanged() -> None:
    draft = _drafted()

    reply = tools.run_tool(
        draft, _call("accept_draft", {"note": "Both read as a wave."}), tools.offered_tools("review")
    )

    assert reply.problems == [] and draft.outcome == "accepted" and draft.note == "Both read as a wave."
    assert draft.clip == VALID_CLIP and draft.details == GESTURE_DETAILS
    # A call without arguments is an empty object.
    again = _drafted()
    assert tools.run_tool(again, _call("accept_draft", ""), tools.offered_tools("review")).problems == []
    assert again.outcome == "accepted"


def test_read_example_returns_only_the_listed_gestures() -> None:
    asked: list[str] = []

    def reader(name: str) -> dict[str, Any] | None:
        asked.append(name)
        return _included(name)

    draft = tools.WorkingDraft(intent="gesture")

    def read(name: Any) -> tools.ToolReply:
        return tools.run_tool(
            draft, _call("read_example", {"name": name}), tools.offered_tools("write"), example_reader=reader
        )

    assert tools.EXAMPLE_NAMES == ("wave-hello", "mild-laugh", "have-an-idea")
    for name in tools.EXAMPLE_NAMES:
        reply = read(name)
        without_events = {key: value for key, value in _included(name).items() if key != "events"}
        assert reply.problems == [] and json.loads(reply.output) == without_events
    # One of the examples plays an effect, which a draft may not: the model is not shown what it would be refused for.
    assert _included("have-an-idea")["events"]
    # A name is a key into a fixed list, never a path: nothing else reaches the reader.
    for refused in ("medium-laugh", "../../../pyproject", "wave-hello/../mild-laugh", "", None, ["wave-hello"]):
        reply = read(refused)
        assert reply.problems == ["name must be one of: wave-hello, mild-laugh, have-an-idea"]
        assert "schema" not in reply.output
    assert asked == list(tools.EXAMPLE_NAMES)
    # Reading is a round of the pass, not its end.
    assert draft.outcome is None and draft.clip is None


def test_an_example_is_shown_without_its_timeline_events() -> None:
    clip = {**VALID_CLIP, "events": [{"id": "spark", "time": 0.5, "kind": "avatar_vfx", "effectId": "spark"}]}
    draft = tools.WorkingDraft(intent="gesture")

    reply = tools.run_tool(
        draft,
        _call("read_example", {"name": "wave-hello"}),
        tools.offered_tools("write"),
        example_reader=lambda name: clip,
    )

    assert reply.problems == [] and json.loads(reply.output) == VALID_CLIP
    assert "avatar_vfx" not in reply.output
    # The reader's own clip is left as it was.
    assert clip["events"][0]["effectId"] == "spark"
    # What the model reads is itself a clip it could submit: copying the example whole is not refused.
    shown = json.loads(reply.output)
    assert validation.draft_problems("gesture", shown, GESTURE_DETAILS) == []
    assert validation.draft_problems("gesture", clip, GESTURE_DETAILS) == [
        "events: a draft cannot use effects or sounds yet; remove this field"
    ]


def test_an_example_that_cannot_be_read_is_a_refused_call(caplog: pytest.LogCaptureFixture) -> None:
    def raising(name: str) -> dict[str, Any] | None:
        raise OSError(f"MODEL-TEXT-SENTINEL {name}")

    draft = tools.WorkingDraft(intent="gesture")
    call = _call("read_example", {"name": "wave-hello"})
    offered = tools.offered_tools("write")

    for reader in (raising, lambda name: None, lambda name: ["not", "a", "clip"], None):
        reply = tools.run_tool(draft, call, offered, example_reader=reader)  # type: ignore[arg-type]
        assert reply.problems == ["the example wave-hello could not be read"]
        assert "SENTINEL" not in reply.output
    # Only the reader that raised is logged: by the example's name, the failure's type and the tools' line that
    # called it (the reader here is this module's, so that line is the package's innermost).
    [record] = caplog.records
    assert (record.example, record.exc_type) == ("wave-hello", "OSError")  # type: ignore[attr-defined]
    assert re.fullmatch(r"animama\.app\.generation\.tools:\d+", record.site)  # type: ignore[attr-defined]
    assert "SENTINEL" not in caplog.handler.format(record) + repr(record.__dict__)


def test_questions_end_the_pass_with_their_options() -> None:
    draft = tools.WorkingDraft(intent="gesture")
    questions = [
        {"question": " Which hand waves? ", "options": ["Right (recommended)", " Left ", "Both"], "extra": "ignored"},
        {"question": "How big is the wave?", "options": ["Small", "Whole arm"]},
    ]

    reply = tools.run_tool(draft, _call("ask_questions", {"questions": questions}), tools.offered_tools("write"))

    assert reply.problems == [] and draft.outcome == "asked" and draft.clip is None
    assert draft.questions == [
        {"question": "Which hand waves?", "options": ["Right (recommended)", "Left", "Both"]},
        {"question": "How big is the wave?", "options": ["Small", "Whole arm"]},
    ]


@pytest.mark.parametrize(
    ("questions", "problem"),
    [
        (None, "questions must be an array of one to four questions"),
        ("Which hand?", "questions must be an array of one to four questions"),
        ([], "questions must be an array of one to four questions"),
        (
            [{"question": f"Q{number}?", "options": ["a", "b"]} for number in range(5)],
            "questions must be an array of one to four questions",
        ),
        (["Which hand?"], "questions[0] must be an object with a question and its options"),
        ([{"question": "", "options": ["a", "b"]}], "questions[0].question must be a non-empty string"),
        ([{"question": 7, "options": ["a", "b"]}], "questions[0].question must be a non-empty string"),
        ([{"question": "nul\x00", "options": ["a", "b"]}], "questions[0].question must be a non-empty string"),
        (
            [{"question": "q" * 301, "options": ["a", "b"]}],
            "questions[0].question must be at most 300 characters",
        ),
        ([{"question": "Which hand?"}], "questions[0].options must be an array of two to four options"),
        (
            [{"question": "Which hand?", "options": ["a"]}],
            "questions[0].options must be an array of two to four options",
        ),
        (
            [{"question": "Which hand?", "options": ["a", "b", "c", "d", "e"]}],
            "questions[0].options must be an array of two to four options",
        ),
        (
            [{"question": "Which hand?", "options": ["a", "  "]}],
            "questions[0].options[1] must be a non-empty string",
        ),
        ([{"question": "Which hand?", "options": ["a", 2]}], "questions[0].options[1] must be a non-empty string"),
        (
            [{"question": "Which hand?", "options": ["a", "o" * 121]}],
            "questions[0].options[1] must be at most 120 characters",
        ),
        (
            [{"question": "Fine?", "options": ["a", "b"]}, {"question": "Which hand?", "options": "left"}],
            "questions[1].options must be an array of two to four options",
        ),
    ],
)
def test_questions_of_another_shape_are_refused(questions: Any, problem: str) -> None:
    draft = tools.WorkingDraft(intent="gesture")

    reply = tools.run_tool(draft, _call("ask_questions", {"questions": questions}), tools.offered_tools("write"))

    assert reply.problems == [problem]
    assert draft.outcome is None and draft.questions == []


# --- Refused calls ----------------------------------------------------------------


def test_a_tool_the_pass_does_not_offer_is_refused() -> None:
    draft = _drafted()

    assert tools.run_tool(draft, _call("accept_draft", {"note": "Fine."}), tools.offered_tools("write")).problems == [
        "this task has no tool named accept_draft; use submit_draft or read_example or ask_questions"
    ]
    asked = _call("ask_questions", {"questions": [{"question": "Which hand?", "options": ["Left", "Right"]}]})
    assert tools.run_tool(draft, asked, tools.offered_tools("write", can_ask=False)).problems == [
        "this task has no tool named ask_questions; use submit_draft or read_example"
    ]
    # A name the model invents is quoted in part, and a name offered by mistake still has to be a real tool.
    invented = "run_shell_" + "x" * 500
    for offered in (tools.offered_tools("repair"), (*tools.offered_tools("repair"), invented)):
        [problem] = tools.run_tool(draft, _call(invented, {"command": "ls"}), offered).problems
        assert problem.startswith("this task has no tool named run_shell_x") and "x" * 100 not in problem
    assert draft.outcome is None and draft.questions == []


def test_malformed_tool_arguments_are_refused() -> None:
    draft = tools.WorkingDraft(intent="gesture")
    offered = tools.offered_tools("write")

    for arguments, problem in (
        ("{not json", "the tool arguments are not valid JSON"),
        ("[" * 100_000, "the tool arguments are not valid JSON"),
        ('["clip"]', "the tool arguments must be a JSON object"),
        ('"clip"', "the tool arguments must be a JSON object"),
        ("null", "the tool arguments must be a JSON object"),
        (" " * (tools.MAX_ARGUMENTS_LENGTH + 1), "the tool arguments are too large"),
    ):
        assert tools.run_tool(draft, _call("submit_draft", arguments), offered).problems == [problem]
    assert draft == tools.WorkingDraft(intent="gesture")


def test_an_unexpected_failure_is_a_refused_call_with_fixed_wording(caplog: pytest.LogCaptureFixture) -> None:
    def failing(selector_id: str) -> bool:
        raise RuntimeError(f"unexpected: MODEL-TEXT-SENTINEL {selector_id}")

    draft = tools.WorkingDraft(intent="gesture")
    caplog.set_level(logging.DEBUG)

    reply = tools.run_tool(draft, _submit(), tools.offered_tools("write"), selector_in_use=failing)

    assert reply.problems == [tools.TOOL_FAILED] == ["the tool could not process these arguments"]
    assert "SENTINEL" not in reply.output and draft == tools.WorkingDraft(intent="gesture")
    # The log names the tool, the failure's type and the package's line that met it, never its wording or the
    # call's arguments.
    [record] = caplog.records
    assert (record.levelname, record.tool, record.exc_type) == ("WARNING", "submit_draft", "RuntimeError")  # type: ignore[attr-defined]
    assert re.fullmatch(r"animama\.app\.generation\.\w+:\d+", record.site)  # type: ignore[attr-defined]
    logged = caplog.handler.format(record) + repr(record.__dict__)
    assert "SENTINEL" not in logged and "shy_wave" not in logged and "rightUpperArm" not in logged


def test_a_refusal_is_bounded_and_a_second_call_in_a_response_gets_one() -> None:
    reply = tools.refused([f"problem {number} " + "x" * 1000 for number in range(50)])

    assert len(reply.problems) == validation.MAX_PROBLEMS
    assert all(len(problem) <= validation.MAX_PROBLEM_LENGTH for problem in reply.problems)
    assert reply.output.startswith("Nothing was changed. Problems:\n- problem 0 xxx")
    assert reply.output.endswith("\nFix them and call the tool again.")
    assert tools.ignored_call_reply().problems == ["only one tool call per response is run; call the tool again"]


def test_a_working_draft_starts_from_a_stored_project() -> None:
    project = validation.build_project("reaction", REACTION_CLIP, REACTION_DETAILS)

    draft = tools.WorkingDraft.from_project(project)

    assert draft.intent == "reaction" and draft.details == REACTION_DETAILS and draft.outcome is None
    assert draft.clip == project["sequence"] and draft.clip is not project["sequence"]
    assert draft.project() == project
    with pytest.raises(ValueError, match="no clip"):
        tools.WorkingDraft(intent="gesture").project()


# --- The deterministic author -------------------------------------------------------


def test_read_example_returns_only_the_listed_reactions_for_a_reaction() -> None:
    included = REPOSITORY / "content/included/reactions"
    asked: list[str] = []

    def reader(name: str) -> dict[str, Any] | None:
        asked.append(name)
        clip: dict[str, Any] = json.loads((included / name / f"{name}.json").read_text(encoding="utf-8"))
        return clip

    draft = tools.WorkingDraft(intent="reaction")

    def read(name: Any) -> tools.ToolReply:
        return tools.run_tool(
            draft, _call("read_example", {"name": name}), tools.offered_tools("write"), example_reader=reader
        )

    assert tools.REACTION_EXAMPLE_NAMES == ("joy-1", "curiosity-1", "fear-2-b")
    assert tools.example_names("reaction") == tools.REACTION_EXAMPLE_NAMES
    assert tools.example_names("gesture") == tools.EXAMPLE_NAMES
    for name in tools.REACTION_EXAMPLE_NAMES:
        reply = read(name)
        shown = json.loads(reply.output)
        assert reply.problems == []
        # What is shown is a Reaction a draft could be: no effect, no lifetime, and nothing a draft is refused for.
        assert not {"events", "playback", "role"} & set(shown) and shown["expressions"]
        assert validation.draft_problems("reaction", shown, REACTION_DETAILS) == [], name
    # The examples show both shapes the guidance names: one beat, and a pop that settles.
    assert [beat["id"] for beat in json.loads(read("joy-1").output)["beats"]] == ["peak"]
    assert [beat["id"] for beat in json.loads(read("fear-2-b").output)["beats"]] == ["pop", "settle"]
    # A Gesture's example is not a Reaction's, and a name is never a path.
    for refused in ("wave-hello", "joy-2", "../joy-1", "", None):
        assert read(refused).problems == ["name must be one of: joy-1, curiosity-1, fear-2-b"]
    assert tools.tool_definition("read_example", "reaction")["function"]["parameters"]["properties"]["name"] == {
        "type": "string",
        "enum": ["joy-1", "curiosity-1", "fear-2-b"],
    }
    assert "Included Reaction" in tools.tool_definition("read_example", "reaction")["function"]["description"]
    assert draft.outcome is None and draft.clip is None


def test_the_packaged_example_reaction_is_a_face_only_draft() -> None:
    assert files("animama.resources").joinpath("generation-example-reaction.json").is_file()
    clip = example_reaction_clip()
    details = {"name": "Example", "emotion": EXAMPLE_REACTION_EMOTION, "intensity": EXAMPLE_REACTION_INTENSITY}

    assert validation.draft_problems("reaction", clip, details) == []
    assert validation.reaction_body_problems(clip) == [] and "events" not in clip and "loop" not in clip
    # Parts only, as the guidance asks, and no whole-face preset.
    assert all(name.startswith(("Fcl_BRW_", "Fcl_EYE_", "Fcl_MTH_")) for name in clip["expressions"])
    assert [beat["id"] for beat in clip["beats"]] == ["pop", "settle"]
    clip["duration"] = 99
    assert example_reaction_clip()["duration"] != 99


def test_the_deterministic_author_writes_a_valid_reaction_and_revises_it() -> None:
    author = DeterministicAuthor()

    call = author.write("  a happy little gasp ", intent="reaction")

    draft = tools.WorkingDraft(intent="reaction")
    assert tools.run_tool(draft, call, tools.offered_tools("write")).problems == []
    assert draft.outcome == "submitted" and draft.clip == example_reaction_clip()
    assert draft.details == {
        "name": "A happy little gasp",
        "emotion": EXAMPLE_REACTION_EMOTION,
        "intensity": EXAMPLE_REACTION_INTENSITY,
    }
    assert json.loads(author.write("", intent="reaction").arguments)["name"] == "Example Reaction"
    # A Gesture's write is unchanged by the new argument.
    assert author.write("a nod", intent="gesture") == author.write("a nod")

    revising = tools.WorkingDraft.from_project(draft.project())
    assert tools.run_tool(revising, author.revise(draft.project()), tools.offered_tools("revise")).problems == []
    assert revising.intent == "reaction" and revising.outcome == "edited" and revising.clip is not None
    assert revising.clip["duration"] == pytest.approx(example_reaction_clip()["duration"] + 0.2)
    assert revising.clip["beats"][-1]["time"] == pytest.approx(0.45)
    assert validation.draft_problems("reaction", revising.clip, revising.details) == []


def test_the_packaged_example_is_a_small_valid_gesture() -> None:
    assert files("animama.resources").joinpath("generation-example-gesture.json").is_file()
    clip = example_gesture_clip()

    assert validation.draft_problems("gesture", clip, GESTURE_DETAILS) == []
    assert clip["duration"] <= 3 and "events" not in clip and "contacts" not in clip
    # Each caller gets a clip of its own.
    clip["duration"] = 99
    assert example_gesture_clip()["duration"] != 99


def test_the_deterministic_author_writes_a_valid_gesture_from_the_request() -> None:
    author = DeterministicAuthor()
    request = "  a shy little wave\nwith a small smile  "

    call = author.write(request)

    assert call.name == "submit_draft" and call == author.write(request)
    draft = tools.WorkingDraft(intent="gesture")
    assert tools.run_tool(draft, call, tools.offered_tools("write")).problems == []
    assert draft.outcome == "submitted" and draft.clip == example_gesture_clip() and draft.note
    assert draft.details["name"] == "A shy little wave with a small smile"
    assert draft.details["selector_id"] == "a_shy_little_wave_with_a_small_smile"
    assert "a shy little wave with a small smile" in draft.details["ai_description"]
    assert validation.clip_problems(draft.project()["sequence"]) == []
    assert validation.detail_problems("gesture", draft.details) == []


@pytest.mark.parametrize(
    "request_text",
    [
        "",
        "   ",
        "手を振って笑う",
        "!!!",
        "x" * 4000,
        "word " * 800,
        "nul\x00 and lone\ud800 and\ttab",
        "Ünïcödé wave ✨",
    ],
)
def test_the_deterministic_author_s_details_are_valid_for_any_request(request_text: str) -> None:
    draft = tools.WorkingDraft(intent="gesture")

    reply = tools.run_tool(draft, DeterministicAuthor().write(request_text), tools.offered_tools("write"))

    assert reply.problems == [] and draft.outcome == "submitted"
    assert len(draft.details["name"]) <= 60


def test_the_deterministic_author_avoids_a_selector_id_in_use() -> None:
    taken = {"wave_hello", "wave_hello_2"}

    call = DeterministicAuthor().write("Wave hello", selector_in_use=taken.__contains__)

    draft = tools.WorkingDraft(intent="gesture")
    assert tools.run_tool(draft, call, tools.offered_tools("write"), selector_in_use=taken.__contains__).problems == []
    assert draft.details["selector_id"] == "wave_hello_3"


@pytest.mark.parametrize("kind", ["revise", "repair"])
def test_the_deterministic_author_makes_one_fixed_valid_change(kind: str) -> None:
    author = DeterministicAuthor()
    draft = tools.WorkingDraft(intent="gesture")
    tools.run_tool(draft, author.write("a slow nod"), tools.offered_tools("write"))
    original = example_gesture_clip()

    for round_number in range(1, 4):
        project = draft.project()
        call = author.revise(project) if kind == "revise" else author.repair(project)
        draft = tools.WorkingDraft.from_project(project)

        assert call.name == "edit_draft"
        assert tools.run_tool(draft, call, tools.offered_tools(kind)).problems == []  # type: ignore[arg-type]
        assert draft.outcome == "edited" and draft.clip is not None
        assert draft.clip["duration"] == pytest.approx(original["duration"] + 0.2 * round_number)
        assert draft.clip["beats"][-1]["time"] == pytest.approx(original["beats"][-1]["time"] + 0.2 * round_number)
        assert draft.details["name"] == "A slow nod"


def test_the_deterministic_author_never_lengthens_a_draft_past_its_limit() -> None:
    clip = {**example_gesture_clip(), "duration": validation.MAX_DRAFT_SECONDS}
    project = validation.build_project("gesture", clip, GESTURE_DETAILS)
    draft = tools.WorkingDraft.from_project(project)

    reply = tools.run_tool(draft, DeterministicAuthor().revise(project), tools.offered_tools("revise"))

    assert reply.problems == [] and draft.outcome == "edited" and draft.clip != project["sequence"]


def test_the_deterministic_author_accepts_in_a_review() -> None:
    draft = _drafted()

    reply = tools.run_tool(draft, DeterministicAuthor().review(), tools.offered_tools("review"))

    assert reply.problems == [] and draft.outcome == "accepted" and draft.clip == VALID_CLIP

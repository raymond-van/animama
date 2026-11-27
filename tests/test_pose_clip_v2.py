"""animaPoseClip/2.0 admission agrees with the frontend parser's vocabulary and fixtures."""

from __future__ import annotations

import json
import math
import re
import subprocess
from pathlib import Path
from typing import Any

import pytest

from animama.app.services.content_package_capabilities import derive_capabilities
from animama.app.services.idle_clip_validation import (
    V2_CLIP_FIELDS,
    V2_CONTACT_POINTS,
    V2_CONTACT_SOLVE,
    V2_EASES,
    V2_HAND_ADJUSTMENT_LIMITS,
    V2_HAND_DIGIT_OFFSETS,
    V2_HAND_FINGER_OFFSET_LIMIT,
    V2_HAND_PRESETS,
    V2_JOINT_COMPONENTS,
    V2_LIMITS,
    V2_MIN_SPACING_SECONDS,
    V2_VALUE_BOUNDS,
    validate_clip_v2_timeline,
)
from animama.domain.content_documents import ContentDocumentError
from tests.test_content_package_capabilities import _document

REPOSITORY = Path(__file__).parents[1]
CLIP_FIXTURES = REPOSITORY / "src/frontend/web/src/lib/avatar/poses/animaPoseClip/fixtures"
HAND_KEYS = json.loads((CLIP_FIXTURES / "hand-keys-v2.json").read_text())
CONTACTS = json.loads((CLIP_FIXTURES / "contacts-v2.json").read_text())


def test_vocabulary_matches_the_frontend_joint_model() -> None:
    vocabulary = json.loads((CLIP_FIXTURES / "v2-vocabulary.json").read_text())
    assert {joint: list(components) for joint, components in V2_JOINT_COMPONENTS.items()} == vocabulary["joints"]
    assert V2_HAND_PRESETS == set(vocabulary["handPresets"])
    assert V2_HAND_ADJUSTMENT_LIMITS == vocabulary["handAdjustmentLimits"]
    assert {
        digit: {name: list(values) for name, values in offsets.items()}
        for digit, offsets in V2_HAND_DIGIT_OFFSETS.items()
    } == vocabulary["handDigitOffsets"]
    assert list(V2_HAND_DIGIT_OFFSETS) == list(vocabulary["handDigitOffsets"])
    assert V2_HAND_FINGER_OFFSET_LIMIT == vocabulary["handFingerOffsetLimit"]
    assert list(V2_CONTACT_POINTS) == vocabulary["contactPoints"]
    assert V2_CONTACT_SOLVE == vocabulary["contactSolve"]
    assert V2_EASES == set(vocabulary["eases"])
    assert V2_MIN_SPACING_SECONDS == vocabulary["minSpacingSeconds"]
    assert V2_LIMITS == vocabulary["limits"]
    assert V2_VALUE_BOUNDS == vocabulary["valueBounds"]
    assert list(V2_CLIP_FIELDS) == vocabulary["clipFields"]


def test_shared_valid_clip_is_admitted() -> None:
    clip = json.loads((CLIP_FIXTURES / "compatibility-valid-v2.json").read_text())
    assert validate_clip_v2_timeline(clip) == 2


def test_package_requires_the_2_0_capability_and_its_base_pose(tmp_path: Path) -> None:
    clip = json.loads((CLIP_FIXTURES / "compatibility-valid-v2.json").read_text())
    document = _document(
        "gesture",
        implementation={"kind": "anima_clip", "file_role": "sequence"},
        files=[{"path": "action.json", "role": "sequence"}],
    )
    path = tmp_path / "action.json"
    path.write_text(json.dumps(clip))
    requirements = derive_capabilities(document.kind, document, {"action.json": path})
    assert set(requirements) == {"animaPoseClip/2.0", "animama/builtin-pose/1/relaxedRest"}

    clip["joints"]["head"]["flexion"][1]["beat"] = "missing"
    path.write_text(json.dumps(clip))
    with pytest.raises(ContentDocumentError):
        derive_capabilities(document.kind, document, {"action.json": path})


@pytest.mark.parametrize(
    ("seconds", "ticks"),
    # Reference values from the frontend: Math.round(Number(x.toFixed(4)) * 1e4).
    [(0.00045, 4), (-0.00045, -4), (1.23456, 12346), (0.1 + 0.2, 3000), (2.00005, 20000), (-1.99995, -19999)],
)
def test_times_round_like_saved_frontend_files(seconds: float, ticks: int) -> None:
    from animama.app.services.idle_clip_validation import _v2_ticks

    assert _v2_ticks(seconds, "time") == ticks


def _contact(**fields: object) -> dict[str, object]:
    return {"bone": "rightHand", "target": "head", "beat": "raise", "from": 0, "to": 0} | fields


def _hand_key(**fields: object) -> dict[str, object]:
    return {"beat": "raise", "preset": "pinch"} | fields


_FINGERS = "hands.right[0].fingers"


@pytest.mark.parametrize(
    ("clip_patch", "field"),
    [
        ({"duration": 1e30}, "duration"),
        ({"beats": [{"id": "start", "label": "Start", "time": 1e30}]}, "beats[0].time"),
        ({"contacts": [_contact(bone=["head"])]}, "contacts[0].bone"),
        ({"contacts": [_contact(target={"x": 1})]}, "contacts[0].target"),
        ({"contacts": [_contact(to=1e30)]}, "contacts[0].to"),
        # Python's JSON reader admits NaN and integers too large for a float.
        ({"hands": {"right": [_hand_key(fingers={"index": {"curl": [1, math.nan, 2]}})]}}, _FINGERS + ".index.curl"),
        ({"hands": {"right": [_hand_key(fingers={"thumb": {"twist": 10**400}})]}}, _FINGERS + ".thumb.twist"),
        ({"contacts": [_contact(solve={"blendIn": math.nan})]}, "contacts[0].solve.blendIn"),
        ({"contacts": [_contact(point=["palm"])]}, "contacts[0].point"),
    ],
)
def test_hostile_values_are_rejected_not_raised(clip_patch: dict[str, object], field: str) -> None:
    clip = json.loads((CLIP_FIXTURES / "compatibility-valid-v2.json").read_text()) | clip_patch
    with pytest.raises(ContentDocumentError, match=rf"Gesture clip {re.escape(field)} "):
        validate_clip_v2_timeline(clip)


def test_lengths_count_utf16_units_like_the_frontend() -> None:
    clip = json.loads((CLIP_FIXTURES / "compatibility-valid-v2.json").read_text())
    # JSON can carry a lone surrogate; JavaScript counts it as one unit.
    lone = json.loads('"\\ud800"')
    clip["beats"][0]["label"] = lone * 80
    assert validate_clip_v2_timeline(clip) == 2
    clip["beats"][0]["label"] = lone * 81
    with pytest.raises(ContentDocumentError, match=r"beats\[0\]\.label is too long"):
        validate_clip_v2_timeline(clip)
    # An emoji is two units.
    clip["beats"][0]["label"] = "\U0001f600" * 41
    with pytest.raises(ContentDocumentError, match=r"beats\[0\]\.label is too long"):
        validate_clip_v2_timeline(clip)


@pytest.mark.parametrize("case", HAND_KEYS["valid"], ids=lambda case: case["name"])
def test_shared_hand_keys_are_admitted(case: dict[str, Any]) -> None:
    assert validate_clip_v2_timeline(HAND_KEYS["clip"] | {"hands": case["hands"]}) == 1


@pytest.mark.parametrize("case", HAND_KEYS["invalid"], ids=lambda case: case["name"])
def test_shared_invalid_hand_keys_are_rejected_at_their_path(case: dict[str, Any]) -> None:
    with pytest.raises(ContentDocumentError, match=rf"Gesture clip {re.escape(case['path'])} "):
        validate_clip_v2_timeline(HAND_KEYS["clip"] | {"hands": case["hands"]})


@pytest.mark.parametrize("case", CONTACTS["valid"], ids=lambda case: case["name"])
def test_shared_contacts_are_admitted(case: dict[str, Any]) -> None:
    assert validate_clip_v2_timeline(CONTACTS["clip"] | {"contacts": case["contacts"]}) == 2


@pytest.mark.parametrize("case", CONTACTS["invalid"], ids=lambda case: case["name"])
def test_shared_invalid_contacts_are_rejected_at_their_path(case: dict[str, Any]) -> None:
    with pytest.raises(ContentDocumentError, match=rf"Gesture clip {re.escape(case['path'])} "):
        validate_clip_v2_timeline(CONTACTS["clip"] | {"contacts": case["contacts"], "loop": case.get("loop", False)})


def _tracked_included_clips() -> list[str]:
    """Tracked Included Gesture and Reaction clips, named by their descriptors."""
    tracked = subprocess.check_output(
        ["git", "ls-files", "-z", "--", "content/included/gestures", "content/included/reactions"], cwd=REPOSITORY
    )
    clips: list[str] = []
    for name in sorted(filter(None, tracked.decode().split("\0"))):
        if not name.endswith(".meta.json"):
            continue
        descriptor = json.loads((REPOSITORY / name).read_text())
        implementation = descriptor.get("implementation", {})
        if implementation.get("kind") != "anima_clip":
            continue
        clips += [
            (Path(name).parent / item["path"]).as_posix()
            for item in descriptor["files"]
            if item.get("role") == implementation["file_role"]
        ]
    return clips


TRACKED_INCLUDED_CLIPS = _tracked_included_clips()


def test_tracked_included_clips_are_found() -> None:
    gestures = [path for path in TRACKED_INCLUDED_CLIPS if path.startswith("content/included/gestures/")]
    assert len(gestures) >= 40


@pytest.mark.parametrize("path", TRACKED_INCLUDED_CLIPS)
def test_tracked_included_clip_is_admitted(path: str) -> None:
    """Included content must never be rejected on package export, import or Idle eligibility."""
    clip = json.loads((REPOSITORY / path).read_text())
    assert clip["schema"] == "animaPoseClip/2.0"
    # As package validation does: a lifetime is checked separately from the timeline.
    timeline = {key: value for key, value in clip.items() if key != "playback"}
    assert validate_clip_v2_timeline(timeline) > 0

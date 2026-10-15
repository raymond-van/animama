from __future__ import annotations

import fnmatch
import json
import shutil
import wave
from dataclasses import replace
from pathlib import Path

import pytest

from animama.app.services.typed_content_service import TypedContentAdmissionError
from animama.domain.content_catalog import ContentKind, ContentSource, ContentStatus, ScannedContentEntry
from animama.runtime.starter_content import _regular_path, catalog_from_scan, starter_inventory
from tests.anima_creation_service_support import (
    EXPECTED_STARTER_GESTURE_IDS,
    INCLUDED_POSE_IDS,
    copy_tracked_included,
    write_supplied_starter_fixture,
)

# Library content ships in desktop core independently of the starter loadouts.
CORE_LIBRARY_LOCATORS = (
    "gestures/bgm-bob",
    "gestures/bored-wait",
    "gestures/chat-glance",
    "gestures/downcast-sigh",
    "gestures/dreamy-gaze",
    "gestures/hair-tuck-settle",
    "gestures/happy-sway",
    "gestures/hmm-drift",
    "gestures/nervous-fidget",
    "gestures/offscreen-look",
    "gestures/simmering-huff",
    "gestures/sleepy-nod-off",
    "vfx/avatar/annoyed_scribble",
    "vfx/avatar/gloomy_cloud",
    "vfx/avatar/mouth_hover_w",
    "vfx/avatar/mouth_w",
    "vfx/avatar/music_notes",
    "vfx/avatar/sigh_puff_droop",
    "vfx/avatar/zzz",
    "vfx/scene/dark",
    "vfx/scene/light-streak",
    "vfx/avatar/awkward-ellipsis",
    "vfx/avatar/blank-dot-eyes",
    "vfx/avatar/broken-heart",
    "vfx/avatar/burning-resolve-eyes",
    "vfx/avatar/calculating-glasses",
    "vfx/avatar/gray-silhouette",
    "vfx/avatar/knockout-x-eyes",
    "vfx/avatar/little-devil-horns",
    "vfx/avatar/mended-heart",
    "vfx/avatar/money-eyes",
    "vfx/avatar/suspicious-side-eye",
    "vfx/avatar/ticking-fuse",
    "vfx/avatar/tiny-victory-crown",
    "vfx/avatar/twitching-cat-ears",
    "vfx/particle/quark/butterfly-flutter",
    "vfx/particle/quark/musical-cascade",
    "vfx/particle/quark/snow-crystal-flurry",
    "vfx/scene/awkward-silence",
    "gestures/air-guitar",
    "gestures/big-arm-heart",
    "gestures/big-yawn",
    "gestures/brain-overload",
    "gestures/brush-off-shoulders",
    "gestures/dramatic-swoon",
    "gestures/energy-wave",
    "gestures/excited-two-arm-wave",
    "gestures/freezing-shiver",
    "gestures/idol-glowstick-cheer",
    "gestures/innocent-whistle",
    "gestures/jazz-hands-ta-da",
    "gestures/nom-nom",
    "gestures/raise-the-roof",
    "gestures/rock-paper-scissors-paper",
    "gestures/rock-paper-scissors-rock",
    "gestures/rock-paper-scissors-scissors",
    "gestures/sassy-hair-flip",
    "gestures/shadow-boxing",
    "gestures/slow-sarcastic-clap",
    "gestures/sniff-sniff",
    "gestures/spit-take",
    "vfx/avatar/delicious_sparkle",
    "vfx/avatar/dizzy_birds",
    "vfx/avatar/glowstick",
    "vfx/avatar/hitodama_flames",
    "vfx/avatar/interrobang",
    "vfx/avatar/overheat_smoke",
    "vfx/avatar/shiver_chatter",
    "vfx/avatar/shiver_undereye",
    "vfx/avatar/sniff_lines",
    "vfx/avatar/snot_bubble",
    "vfx/avatar/star_pupils",
    "vfx/avatar/whistle_notes",
    "vfx/avatar/yawn_tear",
    "vfx/particle/quark/aroma-ribbons",
    "vfx/particle/quark/cheer-streamers",
    "vfx/particle/quark/electric-crackle",
    "vfx/particle/quark/energy-wave-charge",
    "vfx/particle/quark/overheat-steam",
    "vfx/particle/quark/spit-spray-mist",
    "vfx/particle/quark/ta-da-glitter",
)
# Library Gestures reuse these real starter effects; the generated starter
# fixture has no effects, so supply them alongside the Library.
SHARED_STARTER_EFFECT_LOCATORS = (
    "vfx/avatar/angry",
    "vfx/avatar/hearts_burst",
    "vfx/avatar/puff",
    "vfx/avatar/sweat_drop",
    "vfx/avatar/happy_flowers",
    "vfx/avatar/impact_burst",
    "vfx/avatar/kira_star",
    "vfx/avatar/sly_glint",
    "vfx/particle/quark/dizzy-stars",
    "vfx/particle/quark/sparkle-hearts",
    "vfx/particle/quark/star-burst",
)


@pytest.fixture(scope="module")
def staged_core(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Supply structural starters and the reviewed, unequipped core Library."""
    root = write_supplied_starter_fixture(tmp_path_factory.mktemp("supplied-starter-core"))
    included = Path(__file__).resolve().parents[1] / "content/included"
    for locator in (*CORE_LIBRARY_LOCATORS, *SHARED_STARTER_EFFECT_LOCATORS):
        shutil.copytree(included / locator, root / locator)
    return root


def test_tracked_checkout_packages_both_starters_without_private_animations(tmp_path: Path) -> None:
    root = copy_tracked_included(tmp_path / "included")
    inventory = starter_inventory(root)
    assert [starter["name"] for starter in inventory["starters"]] == ["Annie", "Caitlyn"]
    assert not list(root.rglob("*.vrma"))
    poses = [entry for entry in inventory["entries"] if entry["kind"] == "pose"]
    assert all(entry["partition"] == "core" for entry in poses)
    assert sorted(entry["logical_key"] for entry in poses) == sorted(INCLUDED_POSE_IDS)
    assert all(not starter["diagnostics"] for starter in inventory["starters"])


def test_reviewed_library_ships_in_core_without_equipping_starters(tmp_path: Path) -> None:
    root = copy_tracked_included(tmp_path / "included")
    inventory = starter_inventory(root)
    entries = {entry["locator"]: entry for entry in inventory["entries"]}
    library = [entries[locator] for locator in CORE_LIBRARY_LOCATORS]

    assert len(library) == 81
    assert {entry["partition"] for entry in library} == {"core"}
    library_files = {file for entry in library for file in entry["files"]}
    assert len(library_files) == 192
    assert {file["partition"] for file in inventory["files"] if file["path"] in library_files} == {"core"}
    library_keys = {entry["logical_key"] for entry in library}
    for starter in inventory["starters"]:
        # Library items are never starter roots; starter Reactions may reuse
        # Library effects (the Reaction ladder does), which stay in core either way.
        assert not library_keys.intersection(starter["roots"])
        assert set(EXPECTED_STARTER_GESTURE_IDS) <= set(starter["roots"])
        assert starter["diagnostics"] == []
    expected_core = set(CORE_LIBRARY_LOCATORS)
    expected_core.update(entry["locator"] for entry in inventory["entries"] if entry["kind"] == "pose")
    for starter in inventory["starters"]:
        expected_core.update(starter["entries"])
    assert {entry["locator"] for entry in inventory["entries"] if entry["partition"] == "core"} == expected_core
    # Desktop core matches self-host: no valid tracked Included item is left
    # for the deferred expanded pack.
    assert [entry["locator"] for entry in inventory["entries"] if entry["partition"] == "expanded"] == []


@pytest.mark.parametrize("failure", ["missing", "untracked", "excluded", "non-portable", "dependency"])
def test_required_library_content_fails_instead_of_silently_leaving_core(
    staged_core: Path, tmp_path: Path, failure: str
) -> None:
    root = tmp_path / "included"
    shutil.copytree(staged_core, root)
    descriptor = root / "gestures/bgm-bob/bgm-bob.meta.json"
    allowed_paths = None
    if failure == "missing":
        shutil.rmtree(descriptor.parent)
    elif failure == "untracked":
        allowed_paths = {
            path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file() and path != descriptor
        }
    elif failure in {"excluded", "non-portable"}:
        license_path = root / "licenses/inventory.json"
        policy = json.loads(license_path.read_text())
        policy["rules"].insert(
            0,
            {
                "glob": "gestures/bgm-bob/**",
                "license_id": "test-unavailable",
                "provenance": "Explicitly unavailable test content",
                "distribution": failure,
            },
        )
        license_path.write_text(json.dumps(policy))
    else:
        document = json.loads(descriptor.read_text())
        document["dependencies"] = [
            {"ref": "builtin:avatar-effect:missing", "content_type": "avatar_effect", "alias": "missing"}
        ]
        descriptor.write_text(json.dumps(document))

    with pytest.raises(TypedContentAdmissionError, match="source_invalid|source_unavailable"):
        starter_inventory(root, allowed_paths=allowed_paths)


def test_core_library_includes_required_dependencies_without_equipping_them(staged_core: Path, tmp_path: Path) -> None:
    root = tmp_path / "included"
    shutil.copytree(staged_core, root)
    child = root / "vfx/avatar/library-child"
    shutil.copytree(root / "vfx/avatar/awkward-ellipsis", child)
    child_descriptor = child / "awkward-ellipsis.json"
    child_document = json.loads(child_descriptor.read_text())
    child_document["content_id"] = "builtin:avatar-effect:library-child"
    child_document["name"] = "Library child fixture"
    (child / "library-child.json").write_text(json.dumps(child_document))
    child_descriptor.unlink()
    descriptor = root / "gestures/bgm-bob/bgm-bob.meta.json"
    document = json.loads(descriptor.read_text())
    document["dependencies"] = [
        {"ref": "builtin:avatar-effect:library-child", "content_type": "avatar_effect", "alias": "child"}
    ]
    descriptor.write_text(json.dumps(document))

    inventory = starter_inventory(root)

    dependency = next(entry for entry in inventory["entries"] if entry["locator"] == "vfx/avatar/library-child")
    assert dependency["partition"] == "core"
    assert all(dependency["locator"] not in starter["entries"] for starter in inventory["starters"])
    assert all(dependency["logical_key"] not in starter["roots"] for starter in inventory["starters"])


def test_supplied_fixture_core_resolves_both_starters_without_expanded_content(staged_core: Path) -> None:
    inventory = starter_inventory(staged_core)
    assert [starter["name"] for starter in inventory["starters"]] == ["Annie", "Caitlyn"]
    assert all(not starter["diagnostics"] for starter in inventory["starters"])
    assert "avatars/AvatarSample_Y_0.vrm" in inventory["starters"][1]["roots"]
    assert "builtin:avatar-portrait:AvatarSample_Y_0" in inventory["starters"][1]["roots"]
    assert set(EXPECTED_STARTER_GESTURE_IDS) <= set(inventory["starters"][1]["roots"])
    assert all(file["partition"] == "core" for file in inventory["files"])
    assert all(
        not entry["dependencies"] or set(entry["dependencies"]) <= {e["locator"] for e in inventory["entries"]}
        for entry in inventory["entries"]
    )
    assert not inventory["excluded"]
    assert starter_inventory(staged_core)["id"] == inventory["id"]


def test_missing_required_dependency_fails_instead_of_trimming_a_starter(staged_core: Path) -> None:
    allowed = {
        p.relative_to(staged_core).as_posix()
        for p in staged_core.rglob("*")
        if p.is_file() and not p.relative_to(staged_core).as_posix().startswith("gestures/finger-heart-pose/")
    }
    with pytest.raises(TypedContentAdmissionError, match="source_unavailable"):
        starter_inventory(staged_core, allowed_paths=allowed)


def test_missing_license_record_is_a_hard_failure(staged_core: Path, tmp_path: Path) -> None:
    root = tmp_path / "included"
    shutil.copytree(staged_core, root)
    (root / "licenses/inventory.json").write_text(json.dumps({"rules": []}))
    with pytest.raises(ValueError, match="Missing license record"):
        starter_inventory(root)


def test_excluded_required_avatar_fails_instead_of_entering_either_pack(staged_core: Path, tmp_path: Path) -> None:
    root = tmp_path / "included"
    shutil.copytree(staged_core, root)
    license_path = root / "licenses/inventory.json"
    policy = json.loads(license_path.read_text())
    policy["rules"].insert(
        0,
        {
            "glob": "avatars/AvatarSample_Y_0.vrm",
            "license_id": "test-excluded",
            "provenance": "Explicitly excluded test input",
            "distribution": "excluded",
        },
    )
    license_path.write_text(json.dumps(policy))
    with pytest.raises(TypedContentAdmissionError, match="source_unavailable"):
        starter_inventory(root)


def test_excluded_optional_audio_never_enters_either_pack(staged_core: Path, tmp_path: Path) -> None:
    """Prove exclusion with generated bytes even when all private examples are absent."""

    root = tmp_path / "included"
    shutil.copytree(staged_core, root)
    (root / "voices").mkdir()
    with wave.open(str(root / "voices/excluded-fixture.wav"), "wb") as audio:
        audio.setparams((1, 2, 8_000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\0\0" * 800)

    inventory = starter_inventory(root)

    assert {"locator": "voices/excluded-fixture.wav", "reason": "redistribution_excluded"} in inventory["excluded"]
    assert not any(file["path"].startswith("voices/") for file in inventory["files"])


def test_non_portable_content_never_enters_either_staged_partition(staged_core: Path, tmp_path: Path) -> None:
    """Non-portable content ships only as its own private Included source."""

    root = tmp_path / "included"
    shutil.copytree(staged_core, root)
    (root / "voices").mkdir()
    with wave.open(str(root / "voices/non-portable-fixture.wav"), "wb") as audio:
        audio.setparams((1, 2, 8_000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\0\0" * 800)
    license_path = root / "licenses/inventory.json"
    policy = json.loads(license_path.read_text())
    policy["rules"].insert(
        0,
        {
            "glob": "voices/non-portable-*",
            "license_id": "test-non-portable",
            "provenance": "Non-portable test input",
            "distribution": "non-portable",
        },
    )
    license_path.write_text(json.dumps(policy))

    inventory = starter_inventory(root)

    assert {"locator": "voices/non-portable-fixture.wav", "reason": "non_portable"} in inventory["excluded"]
    assert not any(file["path"].startswith("voices/") for file in inventory["files"])


def test_unknown_distribution_policy_is_rejected(staged_core: Path, tmp_path: Path) -> None:
    root = tmp_path / "included"
    shutil.copytree(staged_core, root)
    license_path = root / "licenses/inventory.json"
    policy = json.loads(license_path.read_text())
    policy["rules"].insert(0, {**policy["rules"][-1], "glob": "**", "distribution": "shareable"})
    license_path.write_text(json.dumps(policy))
    with pytest.raises(ValueError, match="Invalid distribution policy"):
        starter_inventory(root)


def test_logical_identity_collisions_are_not_resolved_by_filename_order() -> None:
    first = ScannedContentEntry(
        ContentSource.INCLUDED,
        ContentKind.GESTURE,
        "gestures/a.vrma",
        "A",
        ContentStatus.VALID,
        "a" * 64,
        logical_key="builtin:gesture:a",
    )
    with pytest.raises(ValueError, match="Colliding Included identity"):
        catalog_from_scan([first, replace(first, relative_locator="gestures/b.vrma")])


def test_special_and_escaping_files_never_enter_a_content_inventory(tmp_path: Path) -> None:
    (tmp_path / "file").write_text("content")
    (tmp_path / "link").symlink_to(tmp_path / "file")
    for candidate in ("../file", "/file", "link", "x\\file"):
        with pytest.raises(ValueError):
            _regular_path(tmp_path, candidate)


def test_production_license_policy_keeps_private_examples_excluded() -> None:
    """Pin exclusion policy even when the private bytes are absent from Git."""
    inventory = Path(__file__).resolve().parents[1] / "content/included/licenses/inventory.json"
    rules = json.loads(inventory.read_text())["rules"]
    excluded_paths = (
        "avatars/AvatarChibi_2.vrm",
        "appearances/avatar-portraits/app-avatar-model-avatarchibi-2-v1.webp",
        "avatars/AvatarSample_R2.vrm",
        "appearances/avatar-portraits/app-avatar-model-avatarsample-r2-v1.webp",
        "voices/melina_original.mp3",
        "voices/donald-trump.wav",
        "music/bgm_sample_1.mp3",
        "appearances/tokyo-day.png",
        "appearances/thumbs/tokyo-day.jpg",
    )
    for path in excluded_paths:
        record = next(rule for rule in rules if fnmatch.fnmatchcase(path, rule["glob"]))
        assert record.get("distribution") == "excluded", path


def _with_authoring_pose(staged_core: Path, root: Path) -> Path:
    """Add an unequipped pose to otherwise complete starter content."""
    shutil.copytree(staged_core, root)
    descriptor = root / "poses/authoring-only/authoring-only.json"
    descriptor.parent.mkdir(parents=True)
    descriptor.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "content_type": "pose",
                "content_id": "authoringOnly",
                "name": "Authoring only",
                "pose": {
                    "schema": "animaPose/1.0",
                    "id": "authoringOnly",
                    "name": "Authoring only",
                    "humanoid": {"leftUpperArm": {"rotation": [0, 0, 0, 1]}},
                },
            }
        )
    )
    return descriptor


def test_unequipped_authoring_pose_is_required_core_content(staged_core: Path, tmp_path: Path) -> None:
    root = tmp_path / "included"
    descriptor = _with_authoring_pose(staged_core, root)

    inventory = starter_inventory(root)

    pose = next(entry for entry in inventory["entries"] if entry["logical_key"] == "authoringOnly")
    assert pose["partition"] == "core"
    assert pose["dependencies"] == []
    assert pose["files"] == [descriptor.relative_to(root).as_posix()]
    assert all(pose["locator"] not in starter["entries"] for starter in inventory["starters"])
    assert next(file for file in inventory["files"] if file["path"] == pose["files"][0])["partition"] == "core"


@pytest.mark.parametrize("failure", ["untracked", "excluded", "invalid"])
def test_required_authoring_pose_fails_instead_of_silently_leaving_core(
    staged_core: Path,
    tmp_path: Path,
    failure: str,
) -> None:
    root = tmp_path / "included"
    descriptor = _with_authoring_pose(staged_core, root)
    allowed_paths = None
    if failure == "untracked":
        allowed_paths = {
            path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file() and path != descriptor
        }
    elif failure == "excluded":
        license_path = root / "licenses/inventory.json"
        policy = json.loads(license_path.read_text())
        policy["rules"].insert(
            0,
            {
                "glob": "poses/**",
                "license_id": "test-excluded",
                "provenance": "Explicitly excluded test input",
                "distribution": "excluded",
            },
        )
        license_path.write_text(json.dumps(policy))
    else:
        document = json.loads(descriptor.read_text())
        document["pose"]["parent"] = {"ref": "missingParent"}
        descriptor.write_text(json.dumps(document))

    with pytest.raises(TypedContentAdmissionError, match="source_invalid|source_unavailable"):
        starter_inventory(root, allowed_paths=allowed_paths)

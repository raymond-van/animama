"""The packaged authoring guidance the app's assistant and the animama-animation skill share."""

from __future__ import annotations

import re
from importlib.resources import files
from pathlib import Path

import pytest

from animama.resources import authoring_guidance as guidance

ROOT = Path(__file__).resolve().parents[1]
PACKAGED = ROOT / "src/backend/animama/resources/authoring"
FRONTEND_JOINTS = ROOT / "src/frontend/web/src/lib/avatar/motion-authoring/authoring-joints.generated.md"
FACE_FAMILIES = ("VRM presets", "VRoid parts", "MMD morphs", "ARKit shapes", "own shapes")

_FENCED_BLOCK = re.compile(r"^```.*?^```", re.DOTALL | re.MULTILINE)
_LINK_TARGET = re.compile(r"\]\(([^)\s]+)\)")
_HEADING = re.compile(r"^#{1,6} +(.+?)\s*$", re.MULTILINE)


def _prose(text: str) -> str:
    """The text outside fenced code blocks, where headings and links are Markdown."""
    return _FENCED_BLOCK.sub("", text)


def _title(text: str) -> str:
    return text.splitlines()[0]


def _anchors(text: str) -> set[str]:
    """Heading anchors as Markdown renderers derive them: lower case, punctuation dropped, spaces to hyphens."""
    return {re.sub(r"[^\w\- ]", "", heading.lower()).replace(" ", "-") for heading in _HEADING.findall(_prose(text))}


def test_every_listed_file_ships_in_the_package_with_a_title_of_its_own() -> None:
    packaged = files("animama.resources").joinpath("authoring")
    titles = []
    for name in guidance.GESTURE_GUIDANCE_FILES:
        assert packaged.joinpath(name).is_file(), name
        text = guidance.authoring_guidance(name)
        assert text and _title(text).startswith("# "), name
        titles.append(_title(text))
    assert len(set(titles)) == len(titles)
    # A file added to the folder but not to the list would never reach an author.
    assert sorted(path.name for path in PACKAGED.iterdir()) == sorted(guidance.GESTURE_GUIDANCE_FILES)


def test_the_joined_guidance_holds_each_file_once_in_reading_order() -> None:
    joined = guidance.gesture_authoring_guidance()
    lines = joined.splitlines()
    positions = []
    for name in guidance.GESTURE_GUIDANCE_FILES:
        text = guidance.authoring_guidance(name)
        assert lines.count(_title(text)) == 1, name
        assert joined.count(text) == 1, name
        positions.append(joined.index(text))
    assert positions == sorted(positions)
    assert guidance.GESTURE_GUIDANCE_FILES[0] == "gesture.md" and guidance.GESTURE_GUIDANCE_FILES[-1] == "joints.md"


def test_guidance_names_no_command_or_draft_location() -> None:
    """The files serve authors who cannot run a command, so procedure stays in the skill."""
    for path in sorted(PACKAGED.iterdir()):
        text = path.read_text(encoding="utf-8")
        for forbidden in ("pnpm", ".animama-drafts", "content/included", "content/local"):
            assert forbidden not in text, f"{path.name} mentions {forbidden}"


def test_guidance_links_stay_inside_the_package() -> None:
    """A wheel holds no repository, so a link may only name another guidance file or a heading."""
    anchors = {name: _anchors(guidance.authoring_guidance(name)) for name in guidance.GESTURE_GUIDANCE_FILES}
    for name in guidance.GESTURE_GUIDANCE_FILES:
        for target in _LINK_TARGET.findall(_prose(guidance.authoring_guidance(name))):
            file, _, anchor = target.partition("#")
            linked = file or name
            assert linked in anchors, f"{name} links to {target}"
            assert not anchor or anchor in anchors[linked], f"{name} links to {target}"


def test_the_joint_table_is_the_frontend_generated_file() -> None:
    assert PACKAGED.joinpath("joints.md").read_bytes() == FRONTEND_JOINTS.read_bytes()


def test_the_faces_guidance_names_every_family() -> None:
    faces = guidance.authoring_guidance("faces.md")
    for family in FACE_FAMILIES:
        assert family in faces, family


def test_a_missing_or_empty_file_fails_by_name(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "authoring").mkdir()
    monkeypatch.setattr(guidance, "files", lambda package: tmp_path)

    with pytest.raises(FileNotFoundError, match=r"authoring guidance is missing: gesture\.md"):
        guidance.gesture_authoring_guidance()
    (tmp_path / "authoring" / "gesture.md").write_text("\n", encoding="utf-8")
    with pytest.raises(ValueError, match=r"authoring guidance is empty: gesture\.md"):
        guidance.gesture_authoring_guidance()


def test_only_listed_files_can_be_read() -> None:
    with pytest.raises(ValueError, match="Unknown authoring guidance file"):
        guidance.authoring_guidance("../catalogs.py")

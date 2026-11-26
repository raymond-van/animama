"""Shared authoring guidance shipped in source, wheel and frozen distributions.

The Markdown files under ``resources/authoring`` hold what any author of a
Gesture needs: a person, an agent at a command line, or the app's authoring
assistant. The ``animama-animation`` skill reads the same files and adds only
its command-line procedure. ``joints.md`` is a generated copy of a
frontend-owned file, which the build verifies byte-for-byte
(``src/backend/packaging/shared_catalogs.py``). There is no checkout discovery
or local-runtime fallback in this module.
"""

from importlib.resources import files

# Reading order: what a Gesture is and its rules, what to ask first, planning,
# the format and its vocabulary, what a check finding means, then the joint table.
GESTURE_GUIDANCE_FILES = (
    "gesture.md",
    "interview.md",
    "motion-principles.md",
    "clip-format.md",
    "human-movement.md",
    "hands.md",
    "faces.md",
    "checks.md",
    "joints.md",
)


def authoring_guidance(name: str) -> str:
    """Read one known guidance file from the installed package, failing on omission."""
    if name not in GESTURE_GUIDANCE_FILES:
        raise ValueError(f"Unknown authoring guidance file: {name}")
    resource = files("animama.resources").joinpath("authoring").joinpath(name)
    if not resource.is_file():
        raise FileNotFoundError(f"Required packaged authoring guidance is missing: {name}")
    text = resource.read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError(f"Packaged authoring guidance is empty: {name}")
    return text


def gesture_authoring_guidance() -> str:
    """Join the Gesture guidance files in reading order; each begins with its own title."""
    return "\n\n".join(authoring_guidance(name) for name in GESTURE_GUIDANCE_FILES) + "\n"

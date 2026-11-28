"""Named style presets: one fixed sentence each, chosen by id (spec R8.5).

A person may choose a style for a conversation. The page sends the preset's
id and nothing else; the sentence that reaches a model is written here, so a
caller can add no instruction of its own (threat T3). The ids are the page's
too: the shared fixture ``ui/generate/fixtures/style-presets.json`` under the
web sources lists them, and this module and the page are each tested against
it. The page words each preset's name from its catalogs.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Final

from animama.domain.generation import GenerationError

MAX_STYLE_SENTENCE_LENGTH: Final = 240
"""The longest a preset's sentence may be."""

STYLE_PRESETS: Final[Mapping[str, str]] = {
    "anime_expressive": (
        "Play it big and readable, like anime character acting: clear anticipation, a snappy main action, a held "
        "pose and an exaggerated face."
    ),
    "soft_natural": (
        "Keep it soft and natural: small, relaxed movements, gentle eases and a subtle face, as a calm person "
        "would move."
    ),
    "cute_playful": (
        "Make it cute and playful: bouncy timing, small tilts of the head and body, and a bright, cheerful face."
    ),
    "cool_composed": (
        "Keep it cool and composed: economical, confident movements with little bounce and a calm, restrained face."
    ),
    "dramatic_theatrical": (
        "Make it dramatic and theatrical: wide poses, strong contrast between slow and fast, and a strongly felt face."
    ),
}
"""Each preset's id and the one sentence it adds to a run's instructions, in the order the page lists them."""

for _preset_id, _sentence in STYLE_PRESETS.items():
    # Held here, where a preset is added: one bounded line each.
    if not 0 < len(_sentence) <= MAX_STYLE_SENTENCE_LENGTH or "\n" in _sentence:
        raise ValueError(f"The style preset {_preset_id} is not one line of at most {MAX_STYLE_SENTENCE_LENGTH}")


class GenerationStylePresetUnknownError(GenerationError):
    """The style preset named for a conversation is not one of ``STYLE_PRESETS``."""

    code = "generation_style_preset_unknown"


def style_sentence(preset_id: str | None) -> str | None:
    """The sentence of an allowlisted preset; ``None`` for no preset, or an id that is not on the list.

    A conversation may hold an id from a build that had another list; it
    then adds nothing, as if no style were chosen.
    """

    return STYLE_PRESETS.get(preset_id) if isinstance(preset_id, str) else None


__all__ = ["MAX_STYLE_SENTENCE_LENGTH", "STYLE_PRESETS", "GenerationStylePresetUnknownError", "style_sentence"]

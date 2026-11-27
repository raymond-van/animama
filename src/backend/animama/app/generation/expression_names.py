"""The chosen Avatar's expression names, as they may reach a model.

The names come from an Avatar file, which can name a morph target anything
(threat T10), so they are data: a name that is over-long or carries a
non-printing character is dropped and at most 400 are kept. The page applies
the same bounds before it sends the names (``expressionInventory.ts`` in the
frontend); they are applied again here because this is the boundary to the
model. ``prompts.expression_names_block`` lists the kept names as data.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Mapping
from typing import Final

MAX_EXPRESSION_NAMES: Final = 400
"""The most names kept, over all families."""
MAX_EXPRESSION_NAME_LENGTH: Final = 64
"""The longest name kept, in characters (code points)."""


def _is_non_printing(character: str) -> bool:
    """Unicode's "other" categories, and its line and paragraph separators.

    Control and format characters, surrogates, private-use and unassigned
    code points do not belong in a name shown to a model, and a line break or
    a direction override could disguise one.
    """

    category = unicodedata.category(character)
    return category.startswith("C") or category in {"Zl", "Zp"}


def is_listable_name(value: object) -> bool:
    """Whether ``value`` may be listed: a non-blank, short, fully printable string."""

    return (
        isinstance(value, str)
        and len(value) <= MAX_EXPRESSION_NAME_LENGTH
        and bool(value.strip())
        and not any(_is_non_printing(character) for character in value)
    )


def filter_expression_names(raw: Mapping[str, object]) -> tuple[dict[str, list[str]], int]:
    """Keep the names that may reach the model, by family, and count the names dropped.

    Families and names keep the order they came in, which is the order the cap
    takes them. A name is listed once; a family whose own name is unlistable
    is dropped whole; a family that is not a list holds no names.
    """

    kept: dict[str, list[str]] = {}
    seen: set[str] = set()
    dropped = 0
    for family, names in raw.items():
        listed = names if isinstance(names, list | tuple) else ()
        if not is_listable_name(family):
            dropped += len(listed)
            continue
        for name in listed:
            if len(seen) < MAX_EXPRESSION_NAMES and is_listable_name(name) and name not in seen:
                seen.add(name)
                kept.setdefault(family, []).append(name)
            else:
                dropped += 1
    return kept, dropped


__all__ = [
    "MAX_EXPRESSION_NAMES",
    "MAX_EXPRESSION_NAME_LENGTH",
    "filter_expression_names",
    "is_listable_name",
]

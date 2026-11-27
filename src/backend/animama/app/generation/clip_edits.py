"""Small edits to a clip by JSON Pointer (RFC 6901): the operations of the assistant's ``edit_draft`` tool.

The operations and their paths are a model's output. Every path is followed
through existing containers only, an index is bounded before it is read as a
number, and a failure is reported as text that quotes the model in part.
"""

from __future__ import annotations

import copy
import re
from typing import Any

JsonObject = dict[str, Any]

MAX_QUOTED_PATH = 120
"""How much of a path a failed operation quotes, so a long one cannot push the reason out of the problem."""

# At most nine digits: no array is longer, and int() refuses a digit string of several thousand.
_ARRAY_INDEX = re.compile(r"0|[1-9][0-9]{0,8}")
_BAD_POINTER_ESCAPE = re.compile(r"~(?![01])")


class PointerError(ValueError):
    """A JSON Pointer that cannot be applied to the document; the message says why."""


def pointer_tokens(pointer: str) -> list[str]:
    """Split a JSON Pointer into its reference tokens, with ``~1`` and ``~0`` unescaped."""

    if pointer == "":
        return []
    if not pointer.startswith("/"):
        raise PointerError("a path must start with '/'")
    if _BAD_POINTER_ESCAPE.search(pointer):
        raise PointerError("'~' must be written as ~0 and '/' as ~1")
    return [token.replace("~1", "/").replace("~0", "~") for token in pointer[1:].split("/")]


def _array_index(array: list[Any], token: str) -> int:
    if not _ARRAY_INDEX.fullmatch(token):
        raise PointerError(f"'{token[:16]}' is not an array index")
    index = int(token)
    if index >= len(array):
        raise PointerError(f"index {index} is past the end of an array of {len(array)}")
    return index


def _parent_and_last(document: Any, pointer: str) -> tuple[Any, str]:
    """Walk to the container that holds the pointer's last token."""

    tokens = pointer_tokens(pointer)
    if not tokens:
        raise PointerError("the path must name a value inside the clip, not the whole clip")
    current = document
    for depth, token in enumerate(tokens[:-1]):
        if isinstance(current, dict):
            if token not in current:
                raise PointerError(f"'{token}' does not exist")
            current = current[token]
        elif isinstance(current, list):
            current = current[_array_index(current, token)]
        else:
            raise PointerError(f"'{tokens[depth - 1]}' is not an object or array")
    if not isinstance(current, dict | list):
        raise PointerError(f"'{tokens[-2]}' is not an object or array")
    return current, tokens[-1]


def pointer_set(document: Any, pointer: str, value: Any) -> None:
    """Create or replace the value at ``pointer`` in place; a last token of ``-`` appends to an array.

    Every container on the way must exist: a missing parent is an error, not created.
    """

    parent, last = _parent_and_last(document, pointer)
    if isinstance(parent, dict):
        parent[last] = value
    elif last == "-":
        parent.append(value)
    else:
        parent[_array_index(parent, last)] = value


def pointer_remove(document: Any, pointer: str) -> None:
    """Delete the value at ``pointer`` in place; it must exist."""

    parent, last = _parent_and_last(document, pointer)
    if isinstance(parent, dict):
        if last not in parent:
            raise PointerError(f"'{last}' does not exist")
        del parent[last]
    else:
        del parent[_array_index(parent, last)]


def apply_operations(clip: JsonObject, operations: object) -> tuple[JsonObject, list[str]]:
    """Apply ``edit_draft`` operations in order to a copy of ``clip``.

    Returns the edited copy and no problems, or ``clip`` itself and the first
    operation that could not be applied. Later operations may depend on it, so
    nothing after it runs.
    """

    if not isinstance(operations, list) or not operations:
        return clip, ["operations must be a non-empty array"]
    edited = copy.deepcopy(clip)
    for index, operation in enumerate(operations):
        where = f"operations[{index}]"
        if not isinstance(operation, dict):
            return clip, [f"{where} must be an object"]
        op, path = operation.get("op"), operation.get("path")
        # Checked as strings first: any other JSON value there is refused, never compared or looked up.
        if not isinstance(op, str) or op not in {"set", "remove"} or not isinstance(path, str):
            return clip, [f'{where} needs "op" ("set" or "remove") and a string "path"']
        if op == "set" and "value" not in operation:
            return clip, [f'{where} is a "set" without a "value"']
        try:
            if op == "set":
                pointer_set(edited, path, operation["value"])
            else:
                pointer_remove(edited, path)
        except PointerError as error:
            return clip, [f"{where} ({op} {path[:MAX_QUOTED_PATH]}): {error}"]
    return edited, []


__all__ = [
    "MAX_QUOTED_PATH",
    "JsonObject",
    "PointerError",
    "apply_operations",
    "pointer_remove",
    "pointer_set",
    "pointer_tokens",
]

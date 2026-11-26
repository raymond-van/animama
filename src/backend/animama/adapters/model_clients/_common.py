from __future__ import annotations

import base64
import inspect
from collections.abc import Mapping
from typing import Any

from animama.app.model_clients.image_parts import ModelClientImage


def jsonable(value: Any) -> Any:
    """Return a plain JSON-like value from immutable request mappings."""

    if isinstance(value, Mapping):
        return {str(key): jsonable(item) for key, item in value.items()}
    if isinstance(value, tuple | list | set | frozenset):
        return [jsonable(item) for item in value]
    return value


def get_value(obj: Any, key: str, default: Any = None) -> Any:
    """Read a value from provider SDK objects or mapping-like payloads."""

    if isinstance(obj, Mapping):
        return obj.get(key, default)
    return getattr(obj, key, default)


def openai_cache_breakpoint_text_part(text: str, *, part_type: str) -> dict[str, Any]:
    """Return an OpenAI text content part marked as an explicit prompt-cache breakpoint.

    GPT-5.6 and later write a cache entry at the end of each marked part, and a
    request looks up only the breakpoints it marks plus eligible message
    endings. ``part_type`` is ``text`` for Chat Completions and ``input_text``
    for Responses. openai-python does not type ``prompt_cache_breakpoint`` but
    sends it unchanged.
    """

    return {"type": part_type, "text": text, "prompt_cache_breakpoint": {"mode": "explicit"}}


def image_data_url(image: ModelClientImage) -> str:
    """Return a stored chat image as the ``data:`` URL the OpenAI APIs accept."""

    return f"data:{image.media_type};base64,{base64.b64encode(image.content).decode('ascii')}"


async def close_maybe_async(value: Any) -> None:
    """Call ``close``/``aclose`` on SDK resources when present."""

    for name in ("aclose", "close"):
        close = getattr(value, name, None)
        if not callable(close):
            continue
        result = close()
        if inspect.isawaitable(result):
            await result
        return


__all__ = [
    "close_maybe_async",
    "get_value",
    "image_data_url",
    "jsonable",
    "openai_cache_breakpoint_text_part",
]

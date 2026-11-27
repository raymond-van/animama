"""Review frames: the contact sheets the page renders for a frame review, held in memory only.

When a draft version loads and the run's model accepts images, the run asks
the page for one contact sheet per Included Avatar and waits for them. The
sheets are the page's upload, so they are untrusted (threat T6): each is
bounded in size and decoded by the bounded image opener chat images use, which
also strips its metadata. They are never written to a table or a file. The
store keeps them only while the run that asked is still waiting or reviewing,
and takes nothing a run did not ask for.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from io import BytesIO
from typing import Final

from animama.app.services.content_file_validation import ContentFileInvalidError
from animama.app.services.content_image import canonicalize_chat_image_stream
from animama.domain.generation import GenerationError

MAX_REVIEW_SHEETS: Final = 2
"""One sheet per Included Avatar."""
MAX_REVIEW_SHEET_BYTES: Final = 4 * 1024 * 1024
"""The largest sheet the page may upload."""
MAX_REVIEW_SHEET_DIMENSION: Final = 2048
"""A sheet's longest edge. The page's tallest sheet is six rows of 330 pixels under its header, 2,008 pixels,
which is above a chat image's bound; a sheet within this one reaches the model at the size it was drawn."""


class ReviewSheetError(GenerationError):
    """An uploaded sheet was refused; ``code`` says why."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class ReviewSheet:
    """One decoded contact sheet, ready to send to a model: PNG or JPEG bytes without metadata."""

    media_type: str
    content: bytes = field(repr=False)
    width: int
    height: int


def decode_review_sheet(content: bytes) -> ReviewSheet:
    """Turn one uploaded sheet into the copy a model is sent (blocking: run it on a worker thread).

    Raises ``ReviewSheetError`` for a sheet that is empty or over
    ``MAX_REVIEW_SHEET_BYTES``, or that is not an image the bounded opener
    accepts (PNG, JPEG, WebP or GIF within its pixel limits). A sheet whose
    longest edge is over ``MAX_REVIEW_SHEET_DIMENSION`` is scaled down to it.
    """

    if not 0 < len(content) <= MAX_REVIEW_SHEET_BYTES:
        raise ReviewSheetError("generation_frame_too_large" if content else "generation_frame_not_an_image")
    try:
        image = canonicalize_chat_image_stream(content=BytesIO(content), maximum_dimension=MAX_REVIEW_SHEET_DIMENSION)
    except ContentFileInvalidError as error:
        raise ReviewSheetError("generation_frame_not_an_image") from error
    return ReviewSheet(media_type=image.media_type, content=image.content, width=image.width, height=image.height)


class ReviewFrameStore:
    """The sheets runs of this process are waiting for, keyed by draft.

    A run announces the draft version it wants sheets for with ``expecting``;
    only then does ``offer`` take an upload for it, once. Leaving the
    ``expecting`` block forgets the sheets, so nothing outlives the review that
    asked for it. Runs and uploads share one event loop.
    """

    def __init__(self) -> None:
        self._expected: dict[str, tuple[int, asyncio.Future[tuple[ReviewSheet, ...]]]] = {}

    @contextmanager
    def expecting(self, draft_id: str, version: int) -> Iterator[asyncio.Future[tuple[ReviewSheet, ...]]]:
        """Accept one upload for ``draft_id`` at ``version`` until the block ends; yields where it arrives."""

        arrival: asyncio.Future[tuple[ReviewSheet, ...]] = asyncio.get_running_loop().create_future()
        self._expected[draft_id] = (version, arrival)
        try:
            yield arrival
        finally:
            if self._expected.get(draft_id, (None, None))[1] is arrival:
                del self._expected[draft_id]
            # A wait that timed out or was stopped leaves the future unresolved.
            arrival.cancel()

    def expects(self, draft_id: str, version: int) -> bool:
        """Whether a run is waiting for sheets of this draft version and has none yet."""

        expected = self._expected.get(draft_id)
        return expected is not None and expected[0] == version and not expected[1].done()

    def offer(self, draft_id: str, version: int, sheets: Sequence[ReviewSheet]) -> bool:
        """Hand a run the sheets it waits for. ``False``, keeping nothing, when no run waits for them."""

        if not self.expects(draft_id, version):
            return False
        self._expected[draft_id][1].set_result(tuple(sheets))
        return True

    def held(self) -> int:
        """How many sheets the store holds in memory right now."""

        return sum(
            len(arrival.result())
            for _, arrival in self._expected.values()
            if arrival.done() and not arrival.cancelled()
        )


__all__ = [
    "MAX_REVIEW_SHEETS",
    "MAX_REVIEW_SHEET_BYTES",
    "MAX_REVIEW_SHEET_DIMENSION",
    "ReviewFrameStore",
    "ReviewSheet",
    "ReviewSheetError",
    "decode_review_sheet",
]

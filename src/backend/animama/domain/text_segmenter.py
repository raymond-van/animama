"""Helpers for turning streaming USER_RESPONSE text into sentence segments.

These utilities are domain-level (framework-free) so they can be shared by
runtime components (e.g., LiveKit voice session, LiveKit LLM adapter) without
introducing layering issues.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# A sentence end: ASCII marks need following whitespace, as in English or Korean.
# Japanese and Chinese marks need none. They end at the next character that is not
# a mark or a closing bracket or quote, so a run streamed one mark per delta, and
# its closer, stay with the sentence.
_SENTENCE_END = re.compile(
    r"(?P<ascii>[.!?]+[\"')\]}]*)(?=\s)"
    r"|(?P<full_width>[。！？][。！？.!?]*[」』”’)\]）】\"']*)(?=[^。！？.!?」』”’)\]）】\"'])"
)


@dataclass
class Segment:
    """A sentence-level segment of assistant text for a given run."""

    run_id: str
    text: str
    is_final: bool = False


@dataclass
class _RunBuffer:
    """Internal per-run buffer used by the segmenter."""

    text: str = ""


class UserResponseSegmenter:
    """Accumulates text deltas and yields sentence-level segments.

    Usage
    -----
    - Call ``add_delta(run_id, text)`` for each streaming delta.
      This returns zero or more ``Segment`` objects for complete sentences.
    - Call ``finish_run(run_id, final_text=None)`` when the run is known to be
      complete (e.g., a ``done`` delta or final egress response). This flushes
      any remaining buffered text as one or more segments and marks the last
      one as ``is_final=True``.
    """

    # A set of common abbreviations that typically end with a dot but do not end a sentence.
    # You can extend this list based on your domain needs.
    ABBREVIATIONS = {
        "Mr",
        "Mrs",
        "Ms",
        "Dr",
        "Prof",
        "Sr",
        "Jr",
        "St",
        "Rd",
        "Ave",
        "Inc",
        "Ltd",
        "Co",
        "vs",
        "e.g",
        "i.e",
        "etc",
        "approx",
    }

    def __init__(self, min_chars: int = 0) -> None:
        # Optional minimum character count for a segment; 0 disables.
        self._min_chars = max(0, int(min_chars))
        self._runs: dict[str, _RunBuffer] = {}

    def has_run(self, run_id: str) -> bool:
        """Return True if we have buffered text for ``run_id``."""
        return run_id in self._runs

    def reset_run(self, run_id: str) -> None:
        """Discard any buffered text for ``run_id``.

        Use this when an interruption occurs to prevent the segmenter from
        flushing incomplete sentence fragments later.
        """
        self._runs.pop(run_id, None)

    def add_delta(self, run_id: str, text: str) -> list[Segment]:
        """Add a text delta for ``run_id`` and return any complete segments."""
        if not text:
            return []

        buf = self._runs.get(run_id)
        if buf is None:
            buf = _RunBuffer()
            self._runs[run_id] = buf

        buf.text += text
        sentences, remainder = self._split_complete_sentences(buf.text, self._min_chars)
        buf.text = remainder

        return [Segment(run_id=run_id, text=s, is_final=False) for s in sentences]

    def finish_run(self, run_id: str, final_text: str | None = None) -> list[Segment]:
        """Flush any remaining buffered text for ``run_id``.

        If ``final_text`` is provided, it is appended to the existing buffer
        before segmentation. The last returned segment is marked ``is_final=True``.
        """
        buf = self._runs.pop(run_id, _RunBuffer())
        if final_text:
            buf.text += final_text

        sentences, remainder = self._split_complete_sentences(buf.text, self._min_chars)
        if remainder.strip():
            sentences.append(remainder)

        segments: list[Segment] = []
        for idx, sent in enumerate(sentences):
            segments.append(
                Segment(
                    run_id=run_id,
                    text=sent,
                    is_final=idx == len(sentences) - 1,
                )
            )
        return segments

    def _split_complete_sentences(self, text: str, min_chars: int) -> tuple[list[str], str]:
        sentences: list[str] = []
        start = 0

        # A run of marks ("...", "!!", "！？") with any closing quotes or brackets.
        for match in _SENTENCE_END.finditer(text):
            end_idx = match.end()
            candidate = text[start:end_idx]

            # --- Heuristics for ASCII marks only ---
            punctuation = match.group("ascii")
            if punctuation is not None:
                content = candidate[: -len(punctuation)]

                # 1. Skip list items (e.g., "1.").
                if content.isdigit():
                    continue

                # 2. Skip initials (e.g., "J.").
                if len(content) == 1 and content.isupper():
                    continue

                # 3. Skip common abbreviations (e.g., "Mr.").
                last_word_match = re.search(r"(\w+)$", content)
                if last_word_match and last_word_match.group(1) in self.ABBREVIATIONS:
                    continue

            # 4. Minimum Char Length Check
            # (Useful to avoid sending "Ok." if you want longer buffers, but usually 0 is fine)
            if min_chars > 0 and len(candidate) < min_chars:
                continue

            # Valid sentence found
            sentences.append(candidate)
            start = end_idx

        remainder = text[start:]
        return sentences, remainder


# def _split_complete_sentences(text: str, min_chars: int) -> tuple[list[str], str]:
#     """Split ``text`` into complete sentences and a remainder.

#     A sentence boundary is defined heuristically as:
#     - A '.', '!' or '?' character
#     - Followed by whitespace or end-of-string (optionally passing over a
#       trailing quote mark immediately after the punctuation).
#     """
#     sentences: list[str] = []
#     start = 0
#     i = 0
#     length = len(text)

#     while i < length:
#         ch = text[i]
#         if ch in ".!?":
#             end = i + 1
#             # Include trailing quote marks, e.g., '."'
#             while end < length and text[end] in "\"'":
#                 end += 1
#             # Boundary if next char is whitespace or this is the end
#             if end >= length or text[end].isspace():
#                 candidate = text[start:end].strip()
#                 # candidate = text[start:end]
#                 if candidate and (min_chars <= 0 or len(candidate) >= min_chars):
#                     sentences.append(candidate)
#                     start = end
#         i += 1

#     remainder = text[start:]
#     return sentences, remainder

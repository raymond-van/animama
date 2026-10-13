"""Tokenized text and per-word phonemes for chat frames and speech (gruut).

gruut comes with the ``server`` extra. Without it, ``build_gruut_sse_text`` returns
``None`` and frames carry no phoneme payloads.
"""

from __future__ import annotations

from time import perf_counter
from types import ModuleType
from typing import Literal

from animama.logging import get_logger

_log = get_logger("app.gruut_text")

_gruut: ModuleType | None
try:
    import gruut as _gruut_module

    _gruut = _gruut_module

    _GRUUT_IMPORT_ERROR: str | None = None
except Exception as _gruut_import_exc:
    _gruut = None
    _GRUUT_IMPORT_ERROR = str(_gruut_import_exc)


def gruut_prepares_text(text: str) -> bool:
    """Whether gruut's English model should prepare ``text`` for speech.

    It verbalizes numbers and symbols only in English, so text whose letters are
    all ASCII is treated as English; typographic punctuation, symbols and emoji
    do not count. Text with other letters (accented, CJK or Hangul) is spoken as
    written and left to the provider to normalize, until the reply carries its
    speech language.
    """

    return all(character.isascii() for character in text if character.isalpha())


def build_gruut_sse_text(
    text: str,
    *,
    lang: str = "en_US",
    tokenized_text_source: Literal["input", "text_with_ws"] = "input",
) -> dict[str, str | list[list[str]]] | None:
    """Tokenize and phonemize text with gruut for SSE and TTS text payloads.

    The text is an assistant reply, so log calls carry only sizes, counts and
    timings, never the text, tokens or phonemes.
    """

    final_text = text.strip()
    if not final_text:
        return None
    started_at = perf_counter()

    if _gruut is None:
        _log.warning(
            "gruut import failed",
            error=_GRUUT_IMPORT_ERROR or "Unknown import error",
            duration_ms=round((perf_counter() - started_at) * 1000, 3),
        )
        return None
    _log.info(
        "gruut start",
        input_len=len(final_text),
        tokenized_text_source=tokenized_text_source,
    )

    try:
        sentences = list(_gruut.sentences(final_text, lang=lang))
        _log.info(
            "gruut sentences done",
            sentence_count=len(sentences),
            word_count=sum(len(getattr(sent, "words", None) or []) for sent in sentences),
            tokenized_text_source=tokenized_text_source,
        )
    except Exception as exc:
        _log.warning(
            "gruut processing failed",
            lang=lang,
            error_type=type(exc).__name__,
            duration_ms=round((perf_counter() - started_at) * 1000, 3),
        )
        return None

    phoneme_words: list[list[str]] = []

    for sent in sentences:
        for word in getattr(sent, "words", []) or []:
            if not bool(getattr(word, "is_spoken", False)):
                continue
            phonemes = getattr(word, "phonemes", None)
            if not isinstance(phonemes, list | tuple):
                continue
            parts = [str(ph).strip() for ph in phonemes if str(ph).strip()]
            if parts:
                phoneme_words.append(parts)

    if tokenized_text_source == "text_with_ws":
        tokenized_text = "".join(
            str(getattr(sent, "text_with_ws", None) or f"{getattr(sent, 'text', '')} ") for sent in sentences
        ).strip()
    else:
        # Preserve original internal whitespace so downstream lip-sync planning
        # can distinguish line and paragraph breaks when deriving pause timing.
        tokenized_text = final_text

    if not tokenized_text and not phoneme_words:
        _log.info(
            "gruut text built empty",
            lang=lang,
            input_len=len(final_text),
            tokenized_text_source=tokenized_text_source,
            duration_ms=round((perf_counter() - started_at) * 1000, 3),
        )
        return None

    duration_ms = round((perf_counter() - started_at) * 1000, 3)
    _log.info(
        "gruut text built",
        lang=lang,
        input_len=len(final_text),
        tokenized_len=len(tokenized_text),
        phonemized_len=len(phoneme_words),
        tokenized_text_source=tokenized_text_source,
        duration_ms=duration_ms,
    )

    return {
        "tokenized_text": tokenized_text,
        "phonemized_text": phoneme_words,
    }

from __future__ import annotations

import logging
from collections.abc import Iterator

import pytest

from animama.app import gruut_text
from animama.app.gruut_text import build_gruut_sse_text, gruut_prepares_text

REPLY = "Some private reply."
_STANDARD_RECORD_FIELDS = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime"}


class _RecordList(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


@pytest.fixture
def gruut_records() -> Iterator[list[logging.LogRecord]]:
    # Attach to the module logger directly so capture does not depend on the
    # propagation configured by the host composition.
    logger = gruut_text._log.logger
    handler = _RecordList()
    previous_level, previous_disabled = logger.level, logger.disabled
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)
    # Alembic's fileConfig in the migration tests disables loggers that already exist.
    logger.disabled = False
    try:
        yield handler.records
    finally:
        logger.removeHandler(handler)
        logger.setLevel(previous_level)
        logger.disabled = previous_disabled


def _logged_content(record: logging.LogRecord) -> str:
    """Return the message and structured fields a log sink would persist."""

    fields = {key: value for key, value in record.__dict__.items() if key not in _STANDARD_RECORD_FIELDS}
    return f"{record.getMessage()} {fields!r}"


def test_build_gruut_sse_text_never_logs_reply_text(gruut_records: list[logging.LogRecord]) -> None:
    payload = build_gruut_sse_text(REPLY)

    # Backend tests install the ``server`` extra, so this exercises real gruut.
    assert payload is not None
    assert payload["tokenized_text"] == REPLY
    messages = [record.getMessage() for record in gruut_records]
    assert "gruut sentences done" in messages
    assert "gruut text built" in messages
    for record in gruut_records:
        content = _logged_content(record)
        for fragment in (REPLY, "private", "reply"):
            assert fragment not in content


@pytest.mark.parametrize(
    "text",
    [
        "That's great! See you at 3:30.",
        "That’s great! See you at 3:30.",
        "I don’t know — maybe tomorrow.",
        "Well… let me think.",
        "See you soon, bye! 😊",
        "42",
    ],
)
def test_gruut_prepares_english_whatever_its_punctuation_and_symbols(text: str) -> None:
    assert gruut_prepares_text(text)


@pytest.mark.parametrize(
    "text",
    [
        "おはようございます。",
        "안녕하세요.",
        "你好。",
        "¿Cómo estás?",
        # A known limit: an accented loanword sends English as written too.
        "I love this café.",
    ],
)
def test_gruut_leaves_text_with_other_letters_as_written(text: str) -> None:
    assert not gruut_prepares_text(text)

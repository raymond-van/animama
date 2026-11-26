from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, Literal

JOB_TYPE_PROCESS_FILE = "process_file"

JOB_STATUS_QUEUED = "queued"
JOB_STATUS_RUNNING = "running"
JOB_STATUS_SUCCEEDED = "succeeded"
JOB_STATUS_FAILED = "failed"

ACTIVE_PROCESSING_JOB_STATUSES = {
    JOB_STATUS_QUEUED,
    JOB_STATUS_RUNNING,
}

PROCESSING_INTERRUPTED_ERROR = "Processing was interrupted"
"""Recorded when a job's last attempt stopped (a crash or restart) before it finished."""

FILE_REMOVED_DURING_PROCESSING_ERROR = "The file was deleted before processing finished"
"""Recorded on a job whose file was deleted or aborted while the job was running."""

NO_SEARCHABLE_TEXT_ERROR = "No searchable text was extracted from the uploaded file"
"""Recorded when a file was read but holds no text to search, such as a workbook without values."""

MARKDOWN_ATX_HEADING_RE = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*))?$")
"""An ATX heading line: up to three spaces, one to six ``#``, then the line's end or a space or tab and the title.

It matches in linear time; :func:`markdown_heading` strips the closing ``#`` run.
Only ASCII spaces and tabs count, as in CommonMark.
"""
MARKDOWN_FENCE_RE = re.compile(r"^[ \t]*(`{3,}|~{3,})")
"""The opening or closing line of a fenced code block, whose lines are never headings."""

MARKDOWN_TEXT_FORMATS = frozenset({"md", "markdown", "html", "htm", "docx", "pptx", "xlsx", "pdf", "csv", "tsv"})
"""Formats whose parsed text is Markdown: its ``#`` lines are headings and its tables are Markdown tables.

The structured parsers write their headings and escape any other line that
would read as one (a PDF's text has none), and CSV and TSV become one table.
Plain text (``txt``, ``rst``, ``org``), JSON and XML keep their own syntax, so a
``#`` line there is text. Formats are named as :func:`user_file_document_format`
returns them.
"""

DEFAULT_USER_FILE_CHUNK_MAX_TOKENS = 800
"""Default chunk size in cl100k_base tokens, heading path included (``ANIMAMA_USER_FILE_CHUNK_MAX_TOKENS``)."""
MIN_USER_FILE_CHUNK_MAX_TOKENS = 64
"""Smallest chunk size accepted: room for a heading path and some text."""
MAX_USER_FILE_CHUNK_MAX_TOKENS = 1_400
"""Largest chunk size accepted, so one chunk always fits one read of the uploaded-file read tool.

A chunk holds at most four characters per token of the chunk size, and the read
tool's estimate counts at most one token per character, so the largest chunk is
at most 5,600 estimated tokens: inside the tool's 6,000 with room for its
framing, whatever the script.
"""

SEARCH_MODE_KEYWORD: Final = "keyword"
SEARCH_MODE_SEMANTIC: Final = "semantic"
SEARCH_MODE_HYBRID: Final = "hybrid"
SearchMode = Literal["keyword", "semantic", "hybrid"]
UserFileOverviewMethod = Literal["structured", "extractive", "table", "json", "xml", "fallback_excerpt"]


@dataclass(frozen=True, slots=True)
class UserFileOutlineItem:
    """Provider-neutral structural heading extracted from an uploaded document."""

    level: int
    title: str


@dataclass(frozen=True, slots=True)
class UserFileOverview:
    """Versioned, bounded navigation metadata generated for an uploaded document."""

    version: int
    description: str
    outline: tuple[UserFileOutlineItem, ...]
    method: UserFileOverviewMethod
    outline_truncated: bool


@dataclass(frozen=True, slots=True)
class UserFileReadableChunk:
    """Minimal ordered chunk content exposed by the attachment read port."""

    chunk_index: int
    text: str


@dataclass(frozen=True, slots=True)
class UserFileChunkDraft:
    """Deterministic chunk payload before repository ID assignment."""

    chunk_index: int
    text: str
    char_count: int
    token_estimate: int
    metadata: dict[str, Any]
    embedding_text: str | None = None
    embedding: list[float] | None = None


@dataclass(slots=True)
class UserFileProcessingJob:
    """Durable Postgres-backed processing job for an uploaded file."""

    id: str
    file_id: str
    user_id: str
    job_type: str = JOB_TYPE_PROCESS_FILE
    status: str = JOB_STATUS_QUEUED
    attempts: int = 0
    max_attempts: int = 3
    run_after: datetime | None = None
    locked_by: str | None = None
    locked_at: datetime | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    last_error: str | None = None
    metadata: dict[str, Any] | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class UserFileProcessingJobSummary:
    """Small job snapshot returned with file list/detail responses."""

    job_id: str
    status: str
    attempts: int
    max_attempts: int
    last_error: str | None = None
    run_after: datetime | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class UserFileProcessingInfo:
    """Cheap per-file processing summary for response decoration."""

    file_id: str
    chunk_count: int
    latest_job: UserFileProcessingJobSummary | None = None


@dataclass(frozen=True, slots=True)
class ClaimedUserFileProcessingJob:
    """Job lease plus immutable file metadata needed by a worker attempt."""

    job: UserFileProcessingJob
    storage_locator: str
    original_filename: str
    normalized_extension: str
    stored_size_bytes: int | None
    declared_size_bytes: int


@dataclass(frozen=True, slots=True)
class ParsedUserFileDocument:
    """Normalized parser output used by chunking and the overview.

    ``text`` holds the whole document, tables included, and every chunk is cut
    from it. ``tables`` only summarizes each table (its header cells, its number
    of rows and where it came from) for the overview, so a large workbook's
    cells cross from the parse child once.
    """

    text: str
    parser_name: str
    metadata: dict[str, Any]
    tables: list[dict[str, Any]] | None = None
    source_outline: tuple[UserFileOutlineItem, ...] = ()
    source_outline_truncated: bool = False


def markdown_table(rows: Sequence[Sequence[str]]) -> str:
    """Render rows as a Markdown table whose first row is the header; short rows are padded."""

    if not rows:
        return ""
    width = max(len(row) for row in rows)
    normalized = [[cell.strip() for cell in row] + [""] * (width - len(row)) for row in rows]
    header = normalized[0]
    lines = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join("---" for _ in header) + " |",
    ]
    for row in normalized[1:]:
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)


def user_file_document_format(document: ParsedUserFileDocument) -> str:
    """The parsed document's format without a dot: its ``format``, else its extension, else its parser's name."""

    value = document.metadata.get("format")
    if isinstance(value, str) and value.strip():
        return value.strip().lower().lstrip(".")
    extension = document.metadata.get("extension")
    if isinstance(extension, str) and extension.strip():
        return extension.strip().lower().lstrip(".")
    return document.parser_name.removeprefix("stdlib-").lower()


class MarkdownFenceTracker:
    """Follow fenced code blocks line by line, so their lines are never read as headings or tables.

    A fence opens at a line of three or more backticks or tildes and closes at
    the next fence line made of the same character.
    """

    __slots__ = ("_marker",)

    def __init__(self) -> None:
        self._marker: str | None = None

    @property
    def inside(self) -> bool:
        """Whether the lines read so far end inside a fenced block."""

        return self._marker is not None

    def is_code(self, line: str) -> bool:
        """Whether ``line`` is a fence line or lies inside a fenced block.

        Call it for every line in order, or at least for every line whose first
        character other than a space or tab is a backtick or tilde: no other line
        changes the state, and :attr:`inside` answers for those.
        """

        fence = MARKDOWN_FENCE_RE.match(line)
        if fence is not None:
            marker = fence.group(1)[0]
            if self._marker is None:
                self._marker = marker
            elif self._marker == marker:
                self._marker = None
            return True
        return self._marker is not None


def markdown_outline(text: str) -> tuple[UserFileOutlineItem, ...]:
    """Return the ATX headings of Markdown ``text`` in order, ignoring lines inside fenced code blocks."""

    items: list[UserFileOutlineItem] = []
    fences = MarkdownFenceTracker()
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if fences.is_code(line):
            continue
        heading = markdown_heading(line)
        if heading is not None:
            items.append(UserFileOutlineItem(level=heading[0], title=heading[1]))
    return tuple(items)


def markdown_heading(line: str) -> tuple[int, str] | None:
    """The level and title of an ATX heading line, or ``None`` for another line or an empty heading.

    A closing run of ``#`` is not part of the title when a space or tab precedes
    it or it makes up the whole title, as in CommonMark: ``## Setup ##`` is
    "Setup", while ``# C#`` keeps its ``#``.
    """

    match = MARKDOWN_ATX_HEADING_RE.match(line)
    if match is None:
        return None
    title = (match.group(2) or "").rstrip(" \t")
    unclosed = title.rstrip("#")
    if not unclosed or unclosed.endswith((" ", "\t")):
        title = unclosed.rstrip(" \t")
    return (len(match.group(1)), title) if title else None


@dataclass(frozen=True, slots=True)
class UserFileSearchResult:
    """Search result over processed user-file chunks."""

    chunk_id: str
    file_id: str
    chunk_index: int
    text: str
    score: float
    metadata: dict[str, Any]
    original_filename: str
    normalized_extension: str
    match_type: str


__all__ = [
    "ACTIVE_PROCESSING_JOB_STATUSES",
    "ClaimedUserFileProcessingJob",
    "DEFAULT_USER_FILE_CHUNK_MAX_TOKENS",
    "JOB_STATUS_FAILED",
    "JOB_STATUS_QUEUED",
    "JOB_STATUS_RUNNING",
    "JOB_STATUS_SUCCEEDED",
    "JOB_TYPE_PROCESS_FILE",
    "MARKDOWN_ATX_HEADING_RE",
    "MARKDOWN_FENCE_RE",
    "MARKDOWN_TEXT_FORMATS",
    "MAX_USER_FILE_CHUNK_MAX_TOKENS",
    "MIN_USER_FILE_CHUNK_MAX_TOKENS",
    "MarkdownFenceTracker",
    "NO_SEARCHABLE_TEXT_ERROR",
    "PROCESSING_INTERRUPTED_ERROR",
    "ParsedUserFileDocument",
    "SEARCH_MODE_HYBRID",
    "SEARCH_MODE_KEYWORD",
    "SEARCH_MODE_SEMANTIC",
    "SearchMode",
    "UserFileChunkDraft",
    "UserFileOutlineItem",
    "UserFileOverview",
    "UserFileOverviewMethod",
    "UserFileReadableChunk",
    "UserFileProcessingInfo",
    "UserFileProcessingJob",
    "UserFileProcessingJobSummary",
    "UserFileSearchResult",
    "markdown_heading",
    "markdown_outline",
    "markdown_table",
    "user_file_document_format",
]

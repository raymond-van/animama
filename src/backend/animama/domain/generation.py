"""The content assistant's stored state: conversations, their messages and drafts (spec #942).

An assistant conversation is not a Chat. It has no Anima, and nothing here is
read by chat lists, chat search, memory or Reflection.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, Literal, get_args

GenerationIntent = Literal["gesture", "reaction"]
"""The kind of content a draft becomes when saved."""

GenerationMessageRole = Literal["user", "assistant"]

GenerationDraftStatus = Literal["writing", "checking", "repairing", "reviewing", "ready", "warnings", "failed"]
"""Where a draft stands in its run.

``writing``, ``checking``, ``repairing`` and ``reviewing`` are a run's steps;
``ready``, ``warnings`` and ``failed`` are how a run leaves the draft.
"""

GENERATION_INTENTS: Final[tuple[str, ...]] = get_args(GenerationIntent)
GENERATION_MESSAGE_ROLES: Final[tuple[str, ...]] = get_args(GenerationMessageRole)
GENERATION_DRAFT_STATUSES: Final[tuple[str, ...]] = get_args(GenerationDraftStatus)

GENERATION_SCOPE_PAGE: Final = "page"
GENERATION_SCOPE_CREATOR: Final = "creator"


class GenerationError(Exception):
    """A refused assistant storage operation, with a stable code for the API."""

    code: str = "generation_error"

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or self.code)


class GenerationNotFoundError(GenerationError):
    """The conversation or draft does not exist for this owner; another owner's row reads the same."""

    code = "generation_not_found"


class GenerationStaleVersionError(GenerationError):
    """A check report named a version that is not the draft's current one."""

    code = "generation_stale_version"


class GenerationNothingToRestoreError(GenerationError):
    """The draft holds no project from before a revision."""

    code = "generation_nothing_to_restore"


@dataclass(frozen=True, slots=True)
class GenerationConversation:
    """One owner's conversation with the assistant.

    ``scope`` says where it was started: ``{"kind": "page"}`` for the Generate
    page, or ``{"kind": "creator", "intent": ..., "catalog_item_id": ... | None}``
    for a creator and the item open in it.
    """

    id: str
    owner_user_id: str
    title: str
    scope: dict[str, Any]
    style_preset: str | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class GenerationMessage:
    """One text turn. ``data`` holds what the turn carried besides text: questions asked,
    answers given, token use and the run's outcome."""

    id: str
    conversation_id: str
    role: GenerationMessageRole
    text: str
    data: dict[str, Any]
    created_at: datetime


@dataclass(frozen=True, slots=True)
class GenerationDraft:
    """A Gesture or Reaction the assistant is writing, shaped like the creator's ``animamaActionProject/1.0``.

    ``version`` starts at 1 and grows by one with every stored change to
    ``project``. ``check_report`` is the page's report for ``checked_version``,
    which may be older than ``version``. ``previous_project`` is the project
    as it stood before the person's last revising message.
    """

    id: str
    conversation_id: str
    owner_user_id: str
    intent: GenerationIntent
    position: int
    status: GenerationDraftStatus
    version: int
    project: dict[str, Any] | None
    previous_project: dict[str, Any] | None
    check_report: dict[str, Any] | None
    checked_version: int | None
    repair_count: int
    failure_reason: str | None
    saved_item_id: str | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class GenerationConversationSnapshot:
    """A conversation with its messages in the order they were added and its drafts by position."""

    conversation: GenerationConversation
    messages: tuple[GenerationMessage, ...]
    drafts: tuple[GenerationDraft, ...]


def normalized_generation_scope(scope: Mapping[str, Any]) -> dict[str, Any]:
    """Return ``scope`` as one of the two stored shapes, or raise ``ValueError``.

    A scope names where a conversation was started and nothing else, so any
    other key is refused rather than stored.
    """

    if not isinstance(scope, Mapping):
        raise ValueError("A conversation's scope is an object")
    kind = scope.get("kind")
    if kind == GENERATION_SCOPE_PAGE and set(scope) == {"kind"}:
        return {"kind": GENERATION_SCOPE_PAGE}
    if kind == GENERATION_SCOPE_CREATOR and set(scope) <= {"kind", "intent", "catalog_item_id"}:
        intent, catalog_item_id = scope.get("intent"), scope.get("catalog_item_id")
        item_named = catalog_item_id is None or (isinstance(catalog_item_id, str) and bool(catalog_item_id))
        if isinstance(intent, str) and intent in GENERATION_INTENTS and item_named:
            return {"kind": GENERATION_SCOPE_CREATOR, "intent": intent, "catalog_item_id": catalog_item_id}
    raise ValueError("A conversation's scope is the page, or a creator with its intent and item")


__all__ = [
    "GENERATION_DRAFT_STATUSES",
    "GENERATION_INTENTS",
    "GENERATION_MESSAGE_ROLES",
    "GENERATION_SCOPE_CREATOR",
    "GENERATION_SCOPE_PAGE",
    "GenerationConversation",
    "GenerationConversationSnapshot",
    "GenerationDraft",
    "GenerationDraftStatus",
    "GenerationError",
    "GenerationIntent",
    "GenerationMessage",
    "GenerationMessageRole",
    "GenerationNotFoundError",
    "GenerationNothingToRestoreError",
    "GenerationStaleVersionError",
    "normalized_generation_scope",
]

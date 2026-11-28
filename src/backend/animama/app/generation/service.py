"""Stored state of the content assistant: conversations, messages, drafts and their check reports.

The service owns every rule about a draft's version, its report and the project
kept from before a revision. It takes the owner from its caller on every call
and treats another owner's conversation or draft exactly like a missing one.
Nothing here writes a Chat, a chat message, memory or an episode.
"""

from __future__ import annotations

import asyncio
from collections.abc import Collection, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import replace
from typing import Any, Final, cast
from uuid import uuid4

from animama.app.ports.generation_port import GenerationRepository
from animama.app.ports.uow_port import UnitOfWork
from animama.domain.generation import (
    GENERATION_DRAFT_STATUSES,
    GENERATION_INTENTS,
    GENERATION_MESSAGE_ROLES,
    GenerationConversation,
    GenerationConversationSnapshot,
    GenerationDraft,
    GenerationDraftStatus,
    GenerationError,
    GenerationMessage,
    GenerationNotFoundError,
    GenerationNothingToRestoreError,
    GenerationStaleVersionError,
    normalized_generation_scope,
)

from .check_report import final_status
from .style_presets import GenerationStylePresetUnknownError, style_sentence

MAX_TITLE_LENGTH = 80
"""The longest title a conversation is given from the person's first message."""

_LEFT_STATUSES: Final[frozenset[str]] = frozenset({"ready", "warnings", "failed"})
"""How a run leaves a draft: the statuses that are no step of a run."""


def is_unsettled(draft: GenerationDraft, statuses: Collection[str]) -> bool:
    """Whether a draft that no run is working on is stored in a status that does not describe it.

    ``statuses`` are the steps of a run. Two cases need settling
    (``GenerationService.settle_draft``):

    - the draft is still in one of those steps. A run that ended without
      settling it left it there (the process was killed, or stopping took
      too long). A draft in ``checking`` whose current version has no report
      is not such a case: it waits for the page to check it;
    - the draft was left (``ready``, ``warnings`` or ``failed``) with a
      project, and the report of its current version says otherwise. That is
      a report the page sent after the draft was left, while another run held
      the conversation: the route stored it and left the status to that run,
      which settles only its own draft.
    """

    if draft.status in statuses:
        return not (draft.status == "checking" and draft.checked_version != draft.version)
    if draft.status not in _LEFT_STATUSES or draft.project is None:
        return False
    if draft.checked_version != draft.version or draft.check_report is None:
        return False
    return (draft.status, draft.failure_reason) != final_status(draft.check_report)


def conversation_title(text: str) -> str:
    """A conversation's title from a message: one line, at most ``MAX_TITLE_LENGTH`` characters.

    Whitespace runs become single spaces. A longer message is cut and ends
    with ``…``. A message of only whitespace gives no title.
    """

    line = " ".join(text.split())
    if len(line) <= MAX_TITLE_LENGTH:
        return line
    return line[: MAX_TITLE_LENGTH - 1].rstrip() + "…"


class CheckReportSignal:
    """In-process wake-ups for runs waiting on a draft's check report.

    The storage notifies it when a report is stored or a draft is deleted; a
    run listens while it waits (``app/generation/run.py``). A wake-up carries
    no data: the run reads the database again, which stays the source of
    truth, and it reads on a timer as well, so a missed wake-up only delays
    it. Waiters and callers share one event loop.
    """

    def __init__(self) -> None:
        self._waiters: dict[str, set[asyncio.Event]] = {}

    @contextmanager
    def listening(self, draft_id: str) -> Iterator[asyncio.Event]:
        """Yield an event that is set whenever ``draft_id`` is notified, until the block ends."""

        event = asyncio.Event()
        self._waiters.setdefault(draft_id, set()).add(event)
        try:
            yield event
        finally:
            waiters = self._waiters[draft_id]
            waiters.discard(event)
            if not waiters:
                del self._waiters[draft_id]

    def notify(self, draft_id: str) -> None:
        """Wake every wait on ``draft_id``; call it after the change is committed."""

        for event in self._waiters.get(draft_id, ()):
            event.set()

    def waiting(self, draft_id: str) -> int:
        """Return how many waits on ``draft_id`` are open."""

        return len(self._waiters.get(draft_id, ()))


_PROCESS_CHECK_REPORTS = CheckReportSignal()
"""Shared by every service of this process, so a report stored by one request wakes a run in another."""


class GenerationService:
    """Read and change one owner's assistant conversations and drafts.

    Every method takes the owner's id first and raises
    ``GenerationNotFoundError`` for a conversation or draft that is missing or
    another owner's. Each change is committed before the method returns.
    """

    def __init__(
        self,
        repository: GenerationRepository,
        uow: UnitOfWork,
        *,
        check_reports: CheckReportSignal | None = None,
    ) -> None:
        self._repository = repository
        self._uow = uow
        self._check_reports = check_reports if check_reports is not None else _PROCESS_CHECK_REPORTS

    # ------------------------------------------------------------ conversations

    async def create_conversation(self, owner_user_id: str, scope: Mapping[str, Any]) -> GenerationConversation:
        """Start an untitled conversation on the page or in a creator.

        Raises ``ValueError`` for a scope that is neither stored shape.
        """

        conversation = await self._repository.add_conversation(
            conversation_id=str(uuid4()), owner_user_id=owner_user_id, scope=normalized_generation_scope(scope)
        )
        await self._uow.commit()
        return conversation

    async def list_conversations(self, owner_user_id: str) -> list[GenerationConversation]:
        """Return the owner's conversations, the most recently written to first."""

        return await self._repository.list_conversations(owner_user_id=owner_user_id)

    async def get_conversation(self, owner_user_id: str, conversation_id: str) -> GenerationConversationSnapshot:
        """Return a conversation with its messages in the order added and its drafts by position."""

        conversation = await self._repository.get_conversation(
            owner_user_id=owner_user_id, conversation_id=conversation_id
        )
        if conversation is None:
            raise GenerationNotFoundError
        messages = await self._repository.list_messages(owner_user_id=owner_user_id, conversation_id=conversation_id)
        drafts = await self._repository.list_drafts(owner_user_id=owner_user_id, conversation_id=conversation_id)
        return GenerationConversationSnapshot(conversation=conversation, messages=tuple(messages), drafts=tuple(drafts))

    async def delete_conversation(self, owner_user_id: str, conversation_id: str) -> list[str]:
        """Delete a conversation with its messages, drafts and image links.

        Returns the ids of the reference images only this conversation used
        (``image_file_ids_only_in_conversation``): no other conversation
        links them and no chat message attaches them. They are read before
        the delete, in its transaction, and are the caller's to delete as a
        chat's own images are; the files themselves are not touched here.
        """

        orphaned = await self._repository.image_file_ids_only_in_conversation(
            owner_user_id=owner_user_id, conversation_id=conversation_id
        )
        if not await self._repository.delete_conversation(owner_user_id=owner_user_id, conversation_id=conversation_id):
            raise GenerationNotFoundError
        await self._uow.commit()
        return orphaned

    async def set_style_preset(
        self, owner_user_id: str, conversation_id: str, style_preset: str | None
    ) -> GenerationConversation:
        """Choose the conversation's style preset by id, or clear it with ``None`` (spec R8.5).

        Raises ``GenerationStylePresetUnknownError`` for an id that is not on
        the backend's list: a preset is one of its fixed sentences, never
        text of the caller's. The preset applies to the runs planned after
        this, and stays until it is changed or cleared.
        """

        if style_preset is not None and style_sentence(style_preset) is None:
            raise GenerationStylePresetUnknownError
        conversation = await self._repository.set_style_preset(
            owner_user_id=owner_user_id, conversation_id=conversation_id, style_preset=style_preset
        )
        if conversation is None:
            raise GenerationNotFoundError
        await self._uow.commit()
        return conversation

    async def link_reference_images(self, owner_user_id: str, conversation_id: str, file_ids: Sequence[str]) -> None:
        """Keep the owner's image files with a conversation as its reference images (spec R8.2).

        Only the owner's own image files are linked, whatever ids are named;
        an image already linked stays linked once.
        """

        if not await self._repository.link_reference_images(
            owner_user_id=owner_user_id, conversation_id=conversation_id, file_ids=file_ids
        ):
            raise GenerationNotFoundError
        await self._uow.commit()

    async def mark_images_sent(self, owner_user_id: str, message_id: str) -> None:
        """Record on the person's turn that a model request carried its reference images.

        A turn that attached images is stored with ``images_sent`` false. A
        run calls this just before its first model request that holds them,
        so the turn says they were sent only when a request carried them: not
        under the deterministic author, not on a model that takes no images,
        and not for a run that failed before it asked a model anything.
        """

        if not await self._repository.mark_images_sent(owner_user_id=owner_user_id, message_id=message_id):
            raise GenerationNotFoundError
        await self._uow.commit()

    async def add_message(
        self,
        owner_user_id: str,
        conversation_id: str,
        role: str,
        text: str,
        data: Mapping[str, Any] | None = None,
    ) -> GenerationMessage:
        """Append a text turn; ``data`` holds what it carried besides text (questions, answers, token use).

        The person's first message also titles the conversation: a message
        of theirs names it while it has no title, and no later one changes it.
        """

        message = await self._repository.add_message(
            message_id=str(uuid4()),
            owner_user_id=owner_user_id,
            conversation_id=conversation_id,
            role=_known(role, GENERATION_MESSAGE_ROLES, "role"),
            text=text,
            data=dict(data or {}),
            title=conversation_title(text) if role == "user" else None,
        )
        if message is None:
            raise GenerationNotFoundError
        await self._uow.commit()
        return message

    # --------------------------------------------------------------------- drafts

    async def create_draft(self, owner_user_id: str, conversation_id: str, intent: str) -> GenerationDraft:
        """Add an empty draft, being written, at the conversation's next position."""

        draft = await self._repository.add_draft(
            draft_id=str(uuid4()),
            owner_user_id=owner_user_id,
            conversation_id=conversation_id,
            intent=_known(intent, GENERATION_INTENTS, "intent"),
            status="writing",
        )
        if draft is None:
            raise GenerationNotFoundError
        await self._uow.commit()
        return draft

    async def get_draft(self, owner_user_id: str, draft_id: str) -> GenerationDraft:
        """Return a draft as it is stored now."""

        draft = await self._repository.get_draft(owner_user_id=owner_user_id, draft_id=draft_id)
        if draft is None:
            raise GenerationNotFoundError
        return draft

    async def store_revision(self, owner_user_id: str, draft_id: str, project: Mapping[str, Any]) -> GenerationDraft:
        """Replace the draft's project with a revision of it, keeping the replaced project as the one to restore.

        Called once for a run that revises a draft, with the first valid
        project of that run. The replaced project and the new one are stored
        in one transaction, so a run stopped at this point leaves either the
        whole revision or none of it, and never a restore point that is a
        copy of the current project. The draft becomes a new version waiting
        for its checks, with its repair count back at zero. Later
        ``store_project`` calls of the run replace only the project, so
        ``restore_previous`` returns to how the draft stood before the
        person's revising message.
        """

        draft = await self._locked_draft(owner_user_id, draft_id)
        return await self._save(
            replace(
                draft,
                previous_project=draft.project,
                project=dict(project),
                version=draft.version + 1,
                status="checking",
                repair_count=0,
                failure_reason=None,
            )
        )

    async def store_starting_point(
        self, owner_user_id: str, draft_id: str, start: Mapping[str, Any], project: Mapping[str, Any]
    ) -> GenerationDraft:
        """Store a new draft's starting point and the assistant's revision of it, as one change (spec R8.1).

        ``start`` is the copy of the Library Gesture the person chose to
        start from and ``project`` what a pass made of it. The copy is the
        draft's first version and the revision its next: both are written in
        one transaction, so a run that stops or fails here leaves a draft
        that holds neither, never an unrevised copy that the run did not
        report. ``restore_previous`` then returns to the Gesture itself. The
        draft is left waiting for its checks.
        """

        draft = await self._locked_draft(owner_user_id, draft_id)
        return await self._save(
            replace(
                draft,
                previous_project=dict(start),
                project=dict(project),
                # Two versions at once: the copy's, which nobody was shown, and the revision's.
                version=draft.version + 2,
                status="checking",
                repair_count=0,
                failure_reason=None,
            )
        )

    async def store_project(
        self, owner_user_id: str, draft_id: str, project: Mapping[str, Any], status: str
    ) -> GenerationDraft:
        """Replace the draft's project, which makes a new version, and set its status.

        The caller has already validated ``project``. A check report stored
        for an earlier version stays, marked with that version.
        """

        new_status = _status(status)
        draft = await self._locked_draft(owner_user_id, draft_id)
        return await self._save(
            replace(draft, project=dict(project), version=draft.version + 1, status=new_status, failure_reason=None)
        )

    async def record_check_report(
        self, owner_user_id: str, draft_id: str, version: int, report: Mapping[str, Any]
    ) -> GenerationDraft:
        """Store the page's check report for the draft's current version and wake a run waiting on it.

        Raises ``GenerationStaleVersionError`` when ``version`` is not the
        draft's version, leaving the stored report as it was. The caller has
        already bounded ``report``.
        """

        draft = await self._locked_draft(owner_user_id, draft_id)
        if version != draft.version:
            # End the transaction that holds the row before refusing.
            await self._uow.rollback()
            raise GenerationStaleVersionError
        stored = await self._save(replace(draft, check_report=dict(report), checked_version=version))
        self._check_reports.notify(draft_id)
        return stored

    async def set_status(
        self, owner_user_id: str, draft_id: str, status: str, failure_reason: str | None = None
    ) -> GenerationDraft:
        """Set the draft's status; ``failure_reason`` is a code, kept only until the status changes again."""

        new_status = _status(status)
        draft = await self._locked_draft(owner_user_id, draft_id)
        return await self._save(replace(draft, status=new_status, failure_reason=failure_reason))

    async def settle_draft(
        self, owner_user_id: str, draft_id: str, statuses: Collection[str]
    ) -> GenerationDraft | None:
        """Leave a draft that no run is working on in a status that describes it.

        Only a draft that ``is_unsettled`` is touched: one whose status is
        one of ``statuses`` (steps of a run), or one a run left whose current
        version's report says otherwise. Any other is returned as it stands.
        A draft that never got a project is deleted, and ``None`` is
        returned. One whose current version has a check report takes that
        report's final status and failure reason. One whose current version
        was never checked goes to ``checking``, for the page to check; its
        report then settles it.

        The draft is read and changed under one hold of its row, so a status
        another request stored meanwhile is never overwritten by an older
        reading of it.
        """

        draft = await self._locked_draft(owner_user_id, draft_id)
        if not is_unsettled(draft, statuses):
            # End the transaction that holds the row.
            await self._uow.rollback()
            return draft
        if draft.project is None:
            await self._repository.delete_draft(owner_user_id=owner_user_id, draft_id=draft_id)
            await self._uow.commit()
            self._check_reports.notify(draft_id)
            return None
        checked = draft.checked_version == draft.version and draft.check_report is not None
        status, reason = final_status(draft.check_report or {}) if checked else ("checking", None)
        if (status, reason) == (draft.status, draft.failure_reason):
            await self._uow.rollback()
            return draft
        return await self._save(replace(draft, status=status, failure_reason=reason))

    async def count_repair(self, owner_user_id: str, draft_id: str) -> int:
        """Count one more repair pass and return the passes run since the draft's last revision began."""

        draft = await self._locked_draft(owner_user_id, draft_id)
        return (await self._save(replace(draft, repair_count=draft.repair_count + 1))).repair_count

    async def restore_previous(self, owner_user_id: str, draft_id: str) -> GenerationDraft:
        """Put back the project from before the last revision, as a new version waiting for its checks.

        Raises ``GenerationNothingToRestoreError`` when there is none. The
        restored project is then no longer kept, so a second restore has
        nothing to return to.
        """

        draft = await self._locked_draft(owner_user_id, draft_id)
        if draft.previous_project is None:
            await self._uow.rollback()
            raise GenerationNothingToRestoreError
        return await self._save(
            replace(
                draft,
                project=draft.previous_project,
                previous_project=None,
                version=draft.version + 1,
                status="checking",
                failure_reason=None,
            )
        )

    async def delete_draft(self, owner_user_id: str, draft_id: str) -> None:
        """Discard a draft; a run waiting on its check report ends with ``GenerationNotFoundError``."""

        if not await self._repository.delete_draft(owner_user_id=owner_user_id, draft_id=draft_id):
            raise GenerationNotFoundError
        await self._uow.commit()
        self._check_reports.notify(draft_id)

    async def mark_saved(self, owner_user_id: str, draft_id: str, item_id: str) -> GenerationDraft:
        """Record the Library item the person saved this draft as."""

        draft = await self._locked_draft(owner_user_id, draft_id)
        return await self._save(replace(draft, saved_item_id=item_id))

    async def check_report_for(self, owner_user_id: str, draft_id: str, version: int) -> dict[str, Any] | None:
        """Return the check report stored for ``version`` of the draft, or ``None`` when there is none yet.

        One read of the database, never state an earlier read left in memory.
        Raises ``GenerationNotFoundError`` when the draft is missing or was
        discarded. A run that waits for a report reads through this each
        time ``CheckReportSignal`` wakes it.
        """

        state = await self._repository.check_state(owner_user_id=owner_user_id, draft_id=draft_id, version=version)
        if state is None:
            raise GenerationNotFoundError
        return state.report

    # -------------------------------------------------------------------- helpers

    async def _locked_draft(self, owner_user_id: str, draft_id: str) -> GenerationDraft:
        """Read a draft and hold its row, so the change that follows is not lost to another request's."""

        draft = await self._repository.get_draft(owner_user_id=owner_user_id, draft_id=draft_id, for_update=True)
        if draft is None:
            raise GenerationNotFoundError
        return draft

    async def _save(self, draft: GenerationDraft) -> GenerationDraft:
        stored = await self._repository.save_draft(draft)
        if stored is None:
            raise GenerationNotFoundError
        await self._uow.commit()
        return stored


def _known(value: str, allowed: tuple[str, ...], name: str) -> str:
    """Return ``value`` when it is one of ``allowed``; a caller's mistake, so a plain ``ValueError``."""

    if value not in allowed:
        raise ValueError(f"Unknown {name}: {value!r}")
    return value


def _status(value: str) -> GenerationDraftStatus:
    return cast(GenerationDraftStatus, _known(value, GENERATION_DRAFT_STATUSES, "status"))


__all__ = [
    "MAX_TITLE_LENGTH",
    "CheckReportSignal",
    "GenerationError",
    "GenerationNotFoundError",
    "GenerationNothingToRestoreError",
    "GenerationService",
    "GenerationStaleVersionError",
    "conversation_title",
    "is_unsettled",
]

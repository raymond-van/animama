"""The content assistant's storage: conversations, messages, drafts and check reports (spec #942)."""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import replace
from typing import Any
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from animama.adapters.repositories.sqlalchemy.generation_repo import SQLAlchemyGenerationRepository
from animama.adapters.repositories.sqlalchemy.uow import SQLAlchemyUnitOfWork
from animama.app.generation import service as service_module
from animama.app.generation.service import CheckReportSignal, GenerationService
from animama.app.ports.generation_port import GenerationCheckState
from animama.domain.generation import (
    GenerationConversation,
    GenerationDraft,
    GenerationNotFoundError,
    GenerationNothingToRestoreError,
    GenerationStaleVersionError,
)
from animama.orm import ORMChat, ORMChatMessage
from animama.orm.generation import ORMGenerationConversation, ORMGenerationDraft, ORMGenerationMessage

PAGE = {"kind": "page"}
IN_A_RUN = ("writing", "checking", "repairing", "reviewing")
REPORT = {"loads": True, "findings": [{"level": "WARN", "code": "wrist_twist"}]}


def _project(name: str) -> dict[str, Any]:
    """A draft project shaped like the creator's ``animamaActionProject/1.0``."""

    return {
        "schema": "animamaActionProject/1.0",
        "intent": "gesture",
        "name": name,
        "sequence": {"format": "animaPoseClip/2.0", "beats": [{"duration": 0.4}]},
        "dependencies": [],
    }


def _service(session: AsyncSession, *, check_reports: CheckReportSignal | None = None) -> GenerationService:
    return GenerationService(
        SQLAlchemyGenerationRepository(session), SQLAlchemyUnitOfWork(session), check_reports=check_reports
    )


def _owner() -> str:
    return f"owner-{uuid4().hex}"


async def _count(session: AsyncSession, model: type) -> int:
    return (await session.execute(select(func.count()).select_from(model))).scalar_one()


@pytest_asyncio.fixture
async def other_session(async_session_factory: async_sessionmaker[AsyncSession]) -> AsyncIterator[AsyncSession]:
    """A second request's session, on its own connection."""

    async with async_session_factory() as session:
        yield session


@pytest_asyncio.fixture(autouse=True)
async def _clean_generation_tables(async_session: AsyncSession) -> AsyncIterator[None]:
    yield
    await async_session.rollback()
    await async_session.execute(delete(ORMGenerationConversation))
    await async_session.commit()


async def _draft_with_project(service: GenerationService, owner: str) -> tuple[GenerationConversation, GenerationDraft]:
    conversation = await service.create_conversation(owner, PAGE)
    draft = await service.create_draft(owner, conversation.id, "gesture")
    return conversation, await service.store_project(owner, draft.id, _project("Wave"), "checking")


# ------------------------------------------------------------ conversations


async def test_conversations_are_listed_newest_first(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()

    first = await service.create_conversation(owner, PAGE)
    second = await service.create_conversation(owner, PAGE)
    assert [item.id for item in await service.list_conversations(owner)] == [second.id, first.id]

    # A conversation that was just written to is the newest again.
    await service.add_message(owner, first.id, "user", "A shy little wave", {})
    assert [item.id for item in await service.list_conversations(owner)] == [first.id, second.id]


async def test_a_new_conversation_has_an_id_an_empty_title_and_its_scope(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()

    page = await service.create_conversation(owner, {"kind": "page"})
    creator = await service.create_conversation(
        owner, {"kind": "creator", "intent": "reaction", "catalog_item_id": "item-1"}
    )
    unsaved = await service.create_conversation(owner, {"kind": "creator", "intent": "gesture"})

    assert (page.owner_user_id, page.title, page.style_preset, page.scope) == (owner, "", None, {"kind": "page"})
    assert creator.scope == {"kind": "creator", "intent": "reaction", "catalog_item_id": "item-1"}
    assert unsaved.scope == {"kind": "creator", "intent": "gesture", "catalog_item_id": None}
    assert len({page.id, creator.id, unsaved.id}) == 3
    assert page.created_at.tzinfo is not None


@pytest.mark.parametrize(
    "scope",
    [
        {},
        {"kind": "chat"},
        {"kind": "page", "anima_id": "anima-1"},
        {"kind": "creator"},
        {"kind": "creator", "intent": "pose"},
        {"kind": "creator", "intent": "gesture", "catalog_item_id": 7},
        {"kind": "creator", "intent": "gesture", "path": "/etc/passwd"},
    ],
)
async def test_an_unknown_scope_is_refused_before_anything_is_stored(
    async_session: AsyncSession, scope: dict[str, Any]
) -> None:
    service, owner = _service(async_session), _owner()

    with pytest.raises(ValueError):
        await service.create_conversation(owner, scope)

    assert await service.list_conversations(owner) == []


async def test_a_snapshot_holds_messages_in_the_order_added_and_drafts_by_position(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    conversation = await service.create_conversation(owner, PAGE)

    texts = [f"message {index}" for index in range(6)]
    for index, text in enumerate(texts):
        await service.add_message(owner, conversation.id, "user" if index % 2 == 0 else "assistant", text, {})
    asked = await service.add_message(
        owner, conversation.id, "assistant", "", {"questions": [{"question": "Which hand?", "options": ["Left"]}]}
    )
    drafts = [await service.create_draft(owner, conversation.id, intent) for intent in ("gesture", "reaction")]

    snapshot = await service.get_conversation(owner, conversation.id)

    assert snapshot.conversation.id == conversation.id
    assert [message.text for message in snapshot.messages] == [*texts, ""]
    assert [message.role for message in snapshot.messages[:2]] == ["user", "assistant"]
    assert snapshot.messages[-1] == asked
    assert asked.data == {"questions": [{"question": "Which hand?", "options": ["Left"]}]}
    assert [draft.id for draft in snapshot.drafts] == [draft.id for draft in drafts]
    assert [draft.position for draft in snapshot.drafts] == [0, 1]
    assert [draft.intent for draft in snapshot.drafts] == ["gesture", "reaction"]


async def test_messages_added_in_one_transaction_keep_their_order(async_session: AsyncSession) -> None:
    # Ids are random, so the stored time alone must order two rows of one transaction.
    owner = _owner()
    conversation = await _service(async_session).create_conversation(owner, PAGE)
    repository = SQLAlchemyGenerationRepository(async_session)

    for index in range(8):
        await repository.add_message(
            message_id=str(uuid4()),
            owner_user_id=owner,
            conversation_id=conversation.id,
            role="user",
            text=str(index),
            data={},
        )
    await async_session.commit()

    messages = await repository.list_messages(owner_user_id=owner, conversation_id=conversation.id)
    assert [message.text for message in messages] == [str(index) for index in range(8)]


async def test_the_persons_first_message_titles_the_conversation(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    conversation = await service.create_conversation(owner, PAGE)

    # The assistant speaking first names nothing.
    await service.add_message(owner, conversation.id, "assistant", "What shall I make?", {})
    assert (await service.get_conversation(owner, conversation.id)).conversation.title == ""
    await service.add_message(owner, conversation.id, "user", "  A shy\n\tlittle   wave\u3000with a smile  ", {})

    titled = (await service.get_conversation(owner, conversation.id)).conversation
    assert titled.title == "A shy little wave with a smile"
    # Later messages never change it.
    await service.add_message(owner, conversation.id, "assistant", "Here is a shy wave.", {})
    await service.add_message(owner, conversation.id, "user", "Now a deep bow", {})
    assert (await service.get_conversation(owner, conversation.id)).conversation.title == titled.title
    assert [item.title for item in await service.list_conversations(owner)] == [titled.title]


@pytest.mark.parametrize(
    ("text", "title"),
    [
        ("x" * 80, "x" * 80),
        ("x" * 81, "x" * 79 + "…"),
        ("word " * 40, ("word " * 40)[:79].rstrip() + "…"),
        # The cut never leaves a space before the mark.
        ("a" * 78 + " " + "b" * 50, "a" * 78 + "…"),
    ],
)
async def test_a_title_is_at_most_eighty_characters(async_session: AsyncSession, text: str, title: str) -> None:
    service, owner = _service(async_session), _owner()
    conversation = await service.create_conversation(owner, PAGE)

    await service.add_message(owner, conversation.id, "user", text, {})

    stored = (await service.get_conversation(owner, conversation.id)).conversation.title
    assert stored == title and len(stored) <= service_module.MAX_TITLE_LENGTH == 80


async def test_a_message_of_only_whitespace_titles_nothing(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    conversation = await service.create_conversation(owner, PAGE)

    await service.add_message(owner, conversation.id, "user", " \n\t ", {})
    assert (await service.get_conversation(owner, conversation.id)).conversation.title == ""

    # The conversation is still untitled, so the next thing the person says names it.
    await service.add_message(owner, conversation.id, "user", "A wave", {})
    assert (await service.get_conversation(owner, conversation.id)).conversation.title == "A wave"


async def test_deleting_a_conversation_removes_its_messages_and_drafts(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    kept = await service.create_conversation(owner, PAGE)
    await service.add_message(owner, kept.id, "user", "Keep me", {})
    kept_draft = await service.create_draft(owner, kept.id, "gesture")
    conversation, draft = await _draft_with_project(service, owner)
    await service.add_message(owner, conversation.id, "user", "A hearty laugh", {})

    await service.delete_conversation(owner, conversation.id)

    assert [item.id for item in await service.list_conversations(owner)] == [kept.id]
    with pytest.raises(GenerationNotFoundError):
        await service.get_conversation(owner, conversation.id)
    with pytest.raises(GenerationNotFoundError):
        await service.set_status(owner, draft.id, "ready")
    assert await _count(async_session, ORMGenerationConversation) == 1
    assert await _count(async_session, ORMGenerationMessage) == 1
    assert (await async_session.execute(select(ORMGenerationDraft.id))).scalars().all() == [kept_draft.id]


# ------------------------------------------------------------ owner isolation

OwnerCall = Callable[[GenerationService, str, str, str], Awaitable[object]]

OWNER_SCOPED_CALLS: dict[str, OwnerCall] = {
    "get_conversation": lambda s, owner, conversation_id, draft_id: s.get_conversation(owner, conversation_id),
    "delete_conversation": lambda s, owner, conversation_id, draft_id: s.delete_conversation(owner, conversation_id),
    "add_message": lambda s, owner, conversation_id, draft_id: s.add_message(owner, conversation_id, "user", "Hi", {}),
    "create_draft": lambda s, owner, conversation_id, draft_id: s.create_draft(owner, conversation_id, "gesture"),
    "get_draft": lambda s, owner, conversation_id, draft_id: s.get_draft(owner, draft_id),
    "store_revision": lambda s, owner, conversation_id, draft_id: s.store_revision(owner, draft_id, _project("Theirs")),
    "store_project": lambda s, owner, conversation_id, draft_id: s.store_project(
        owner, draft_id, _project("Theirs"), "checking"
    ),
    "record_check_report": lambda s, owner, conversation_id, draft_id: s.record_check_report(
        owner, draft_id, 2, REPORT
    ),
    "set_status": lambda s, owner, conversation_id, draft_id: s.set_status(owner, draft_id, "failed", "no_valid_clip"),
    "settle_draft": lambda s, owner, conversation_id, draft_id: s.settle_draft(owner, draft_id, IN_A_RUN),
    "count_repair": lambda s, owner, conversation_id, draft_id: s.count_repair(owner, draft_id),
    "restore_previous": lambda s, owner, conversation_id, draft_id: s.restore_previous(owner, draft_id),
    "delete_draft": lambda s, owner, conversation_id, draft_id: s.delete_draft(owner, draft_id),
    "mark_saved": lambda s, owner, conversation_id, draft_id: s.mark_saved(owner, draft_id, "item-9"),
    "check_report_for": lambda s, owner, conversation_id, draft_id: s.check_report_for(owner, draft_id, 2),
}


@pytest.mark.parametrize("method", OWNER_SCOPED_CALLS)
async def test_another_owners_ids_behave_as_missing(async_session: AsyncSession, method: str) -> None:
    service, owner, stranger = _service(async_session), _owner(), _owner()
    conversation, draft = await _draft_with_project(service, owner)
    await service.store_revision(owner, draft.id, _project("Wave, bigger"))
    await service.add_message(owner, conversation.id, "user", "A shy little wave", {})
    before = await service.get_conversation(owner, conversation.id)

    with pytest.raises(GenerationNotFoundError) as foreign:
        await OWNER_SCOPED_CALLS[method](service, stranger, conversation.id, draft.id)
    with pytest.raises(GenerationNotFoundError) as unknown:
        await OWNER_SCOPED_CALLS[method](service, owner, "no-such-conversation", "no-such-draft")

    # A foreign row and an unknown one read the same, and nothing of the owner's changed.
    assert foreign.value.code == unknown.value.code == "generation_not_found"
    assert await service.list_conversations(stranger) == []
    assert await service.get_conversation(owner, conversation.id) == before


async def test_the_repository_filters_by_owner_on_its_own(async_session: AsyncSession) -> None:
    service, owner, stranger = _service(async_session), _owner(), _owner()
    conversation, draft = await _draft_with_project(service, owner)
    await service.add_message(owner, conversation.id, "user", "A shy little wave", {})
    checked = await service.record_check_report(owner, draft.id, draft.version, REPORT)
    repository = SQLAlchemyGenerationRepository(async_session)

    assert await repository.get_conversation(owner_user_id=stranger, conversation_id=conversation.id) is None
    assert await repository.list_messages(owner_user_id=stranger, conversation_id=conversation.id) == []
    assert await repository.list_drafts(owner_user_id=stranger, conversation_id=conversation.id) == []
    assert await repository.get_draft(owner_user_id=stranger, draft_id=draft.id) is None
    assert await repository.check_state(owner_user_id=stranger, draft_id=draft.id, version=draft.version) is None
    assert await repository.save_draft(replace(checked, owner_user_id=stranger, status="failed")) is None
    assert await repository.delete_draft(owner_user_id=stranger, draft_id=draft.id) is False
    assert await repository.delete_conversation(owner_user_id=stranger, conversation_id=conversation.id) is False
    await async_session.commit()

    assert await repository.list_drafts(owner_user_id=owner, conversation_id=conversation.id) == [checked]
    assert len(await repository.list_messages(owner_user_id=owner, conversation_id=conversation.id)) == 1
    assert await repository.check_state(
        owner_user_id=owner, draft_id=draft.id, version=draft.version
    ) == GenerationCheckState(checked_version=draft.version, report=REPORT)
    # Another version's report is not handed out.
    assert await repository.check_state(
        owner_user_id=owner, draft_id=draft.id, version=draft.version + 1
    ) == GenerationCheckState(checked_version=draft.version, report=None)


async def test_a_session_that_reads_again_sees_what_another_session_stored(
    async_session: AsyncSession, other_session: AsyncSession
) -> None:
    # One request's session may read a conversation twice (before and after settling its drafts) while other
    # requests write the same rows: the second read is the stored state, not what the session read first.
    run, page, owner = _service(async_session), _service(other_session), _owner()
    conversation, draft = await _draft_with_project(run, owner)
    assert (await run.get_conversation(owner, conversation.id)).drafts == (draft,)

    await page.record_check_report(owner, draft.id, draft.version, REPORT)
    await page.add_message(owner, conversation.id, "user", "Slower, please", {})
    restored_elsewhere = await page.store_project(owner, draft.id, _project("Wave, slower"), "checking")

    snapshot = await run.get_conversation(owner, conversation.id)
    assert snapshot.drafts == (restored_elsewhere,)
    assert snapshot.drafts[0].check_report == REPORT
    assert [message.text for message in snapshot.messages] == ["Slower, please"]
    # The session's next change builds on the stored row, not on the one it read first.
    assert (await run.count_repair(owner, draft.id)) == 1
    (current,) = (await page.get_conversation(owner, conversation.id)).drafts
    assert (current.version, current.project, current.repair_count) == (3, _project("Wave, slower"), 1)


# --------------------------------------------------------------------- drafts


async def test_a_new_draft_is_being_written_at_version_one(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    conversation = await service.create_conversation(owner, PAGE)

    draft = await service.create_draft(owner, conversation.id, "reaction")

    assert (draft.conversation_id, draft.owner_user_id, draft.intent) == (conversation.id, owner, "reaction")
    assert (draft.status, draft.version, draft.position, draft.repair_count) == ("writing", 1, 0, 0)
    assert (draft.project, draft.previous_project, draft.check_report, draft.checked_version) == (
        None,
        None,
        None,
        None,
    )
    assert (draft.failure_reason, draft.saved_item_id) == (None, None)


async def test_a_draft_is_read_by_its_id(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    _, draft = await _draft_with_project(service, owner)

    assert await service.get_draft(owner, draft.id) == draft
    # Reading holds no row: another change follows at once.
    assert (await service.set_status(owner, draft.id, "ready")).status == "ready"
    assert (await service.get_draft(owner, draft.id)).status == "ready"


async def test_a_new_draft_takes_the_position_after_the_highest_one(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    conversation = await service.create_conversation(owner, PAGE)
    first, second = [await service.create_draft(owner, conversation.id, "gesture") for _ in range(2)]

    # A gap left by a deleted draft is not filled: the next draft goes after the last one.
    await service.delete_draft(owner, first.id)
    third = await service.create_draft(owner, conversation.id, "gesture")

    snapshot = await service.get_conversation(owner, conversation.id)
    assert [(draft.id, draft.position) for draft in snapshot.drafts] == [(second.id, 1), (third.id, 2)]
    with pytest.raises(GenerationNotFoundError):
        await service.delete_draft(owner, first.id)
    # Positions order the drafts that exist; they are not a count. Deleting the last one frees its position.
    await service.delete_draft(owner, third.id)
    assert (await service.create_draft(owner, conversation.id, "gesture")).position == 2


async def test_store_project_bumps_the_version(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    conversation = await service.create_conversation(owner, PAGE)
    draft = await service.create_draft(owner, conversation.id, "gesture")

    stored = await service.store_project(owner, draft.id, _project("Wave"), "checking")
    again = await service.store_project(owner, draft.id, _project("Wave, slower"), "repairing")

    assert (stored.version, stored.status, stored.project) == (2, "checking", _project("Wave"))
    assert (again.version, again.status, again.project) == (3, "repairing", _project("Wave, slower"))
    assert again.updated_at >= stored.updated_at >= draft.created_at
    snapshot = await service.get_conversation(owner, conversation.id)
    assert snapshot.drafts == (again,)


async def test_record_check_report_stores_the_report_for_the_current_version(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    _, draft = await _draft_with_project(service, owner)

    checked = await service.record_check_report(owner, draft.id, draft.version, REPORT)

    assert (checked.check_report, checked.checked_version) == (REPORT, draft.version)
    assert (checked.version, checked.status, checked.project) == (draft.version, "checking", draft.project)


async def test_record_check_report_refuses_a_stale_version(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    conversation, draft = await _draft_with_project(service, owner)
    await service.record_check_report(owner, draft.id, draft.version, REPORT)
    repaired = await service.store_project(owner, draft.id, _project("Wave, repaired"), "checking")

    for version in (draft.version, repaired.version + 1):
        with pytest.raises(GenerationStaleVersionError) as stale:
            await service.record_check_report(owner, draft.id, version, {"loads": False})
        assert stale.value.code == "generation_stale_version"

    # The report of the earlier version stays, marked with the version it is for.
    (stored,) = (await service.get_conversation(owner, conversation.id)).drafts
    assert (stored.version, stored.checked_version, stored.check_report) == (repaired.version, draft.version, REPORT)


async def test_a_revision_keeps_the_project_it_replaces_and_restore_returns_to_it(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    _, draft = await _draft_with_project(service, owner)
    await service.count_repair(owner, draft.id)
    await service.set_status(owner, draft.id, "failed", "generation_draft_unloadable")

    # One call, one transaction: the project to restore and its replacement are stored together.
    revised = await service.store_revision(owner, draft.id, _project("Wave, bigger"))
    assert (revised.project, revised.previous_project) == (_project("Wave, bigger"), _project("Wave"))
    assert (revised.status, revised.version, revised.repair_count) == ("checking", draft.version + 1, 0)
    assert revised.failure_reason is None

    # Repairs inside the run replace only the project.
    repaired = await service.store_project(owner, draft.id, _project("Wave, bigger, repaired"), "ready")
    assert (repaired.project, repaired.previous_project) == (_project("Wave, bigger, repaired"), _project("Wave"))

    restored = await service.restore_previous(owner, draft.id)
    assert (restored.project, restored.previous_project) == (_project("Wave"), None)
    assert (restored.version, restored.status) == (repaired.version + 1, "checking")

    with pytest.raises(GenerationNothingToRestoreError) as nothing:
        await service.restore_previous(owner, draft.id)
    assert nothing.value.code == "generation_nothing_to_restore"


async def test_a_second_revision_restores_to_the_one_before_it(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    _, draft = await _draft_with_project(service, owner)

    await service.store_revision(owner, draft.id, _project("Wave, bigger"))
    again = await service.store_revision(owner, draft.id, _project("Wave, slower"))

    # What a restore returns to is the project from before the person's last revising message.
    assert (again.project, again.previous_project) == (_project("Wave, slower"), _project("Wave, bigger"))


async def test_restore_previous_with_nothing_to_restore(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    conversation, draft = await _draft_with_project(service, owner)

    with pytest.raises(GenerationNothingToRestoreError):
        await service.restore_previous(owner, draft.id)

    assert (await service.get_conversation(owner, conversation.id)).drafts == (draft,)


async def test_count_repair_returns_the_passes_run_since_the_last_revision(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    _, draft = await _draft_with_project(service, owner)

    assert [await service.count_repair(owner, draft.id) for _ in range(3)] == [1, 2, 3]
    assert (await service.store_revision(owner, draft.id, _project("Wave, bigger"))).repair_count == 0
    assert await service.count_repair(owner, draft.id) == 1


async def test_a_failure_reason_lasts_until_the_status_changes_again(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    _, draft = await _draft_with_project(service, owner)

    failed = await service.set_status(owner, draft.id, "failed", "no_valid_clip")
    assert (failed.status, failed.failure_reason, failed.version) == ("failed", "no_valid_clip", draft.version)

    assert (await service.set_status(owner, draft.id, "warnings")).failure_reason is None
    await service.set_status(owner, draft.id, "failed", "no_valid_clip")
    assert (await service.store_project(owner, draft.id, _project("Wave"), "checking")).failure_reason is None


@pytest.mark.parametrize(
    ("report", "status", "reason"),
    [
        ({"loadable": True, "issues": [], "findings": []}, "ready", None),
        ({"loadable": True, "issues": [], "findings": [{"severity": "fail"}]}, "warnings", None),
        ({"unchecked": True}, "warnings", None),
        (
            {"loadable": False, "issues": [{"path": "$", "message": "Too large."}]},
            "failed",
            "generation_draft_unloadable",
        ),
    ],
)
async def test_a_draft_left_in_a_run_step_settles_as_its_current_report_describes_it(
    async_session: AsyncSession, report: dict[str, Any], status: str, reason: str | None
) -> None:
    service, owner = _service(async_session), _owner()
    _, draft = await _draft_with_project(service, owner)
    await service.record_check_report(owner, draft.id, draft.version, report)
    await service.set_status(owner, draft.id, "repairing")

    settled = await service.settle_draft(owner, draft.id, IN_A_RUN)

    assert settled is not None and settled == await service.get_draft(owner, draft.id)
    assert (settled.status, settled.failure_reason, settled.version, settled.check_report) == (
        status,
        reason,
        2,
        report,
    )
    # Settled once, it is no longer in a run's step: a second call changes nothing.
    assert await service.settle_draft(owner, draft.id, IN_A_RUN) == settled


async def test_a_draft_whose_current_version_was_never_checked_settles_to_checking(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    _, draft = await _draft_with_project(service, owner)
    await service.record_check_report(owner, draft.id, draft.version, REPORT)
    newer = await service.store_project(owner, draft.id, _project("Wave, slower"), "reviewing")

    settled = await service.settle_draft(owner, draft.id, IN_A_RUN)

    # The stored report is for the version before, so the page has this one to check.
    assert settled is not None
    assert (settled.status, settled.version, settled.checked_version) == ("checking", newer.version, draft.version)
    assert settled.project == _project("Wave, slower")


async def test_a_draft_that_never_got_a_project_is_deleted_when_it_settles(
    async_session: AsyncSession, other_session: AsyncSession
) -> None:
    service, owner = _service(async_session), _owner()
    conversation = await service.create_conversation(owner, PAGE)
    empty = await service.create_draft(owner, conversation.id, "gesture")
    kept = await service.create_draft(owner, conversation.id, "gesture")
    await service.set_status(owner, kept.id, "failed", "generation_no_valid_draft")

    assert await service.settle_draft(owner, empty.id, IN_A_RUN) is None

    # A draft that failed without a project is how its run left it, not a step of one.
    failed = await service.settle_draft(owner, kept.id, IN_A_RUN)
    assert failed is not None and (failed.status, failed.failure_reason) == ("failed", "generation_no_valid_draft")
    assert [draft.id for draft in (await _service(other_session).get_conversation(owner, conversation.id)).drafts] == [
        kept.id
    ]


async def test_only_the_named_statuses_settle(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    _, draft = await _draft_with_project(service, owner)
    warned = {"loadable": True, "issues": [], "findings": [{"severity": "warn"}]}
    checked = await service.record_check_report(owner, draft.id, draft.version, warned)

    # ``checking`` is not among the statuses asked for, so the draft is returned as it stands.
    assert await service.settle_draft(owner, draft.id, ("writing", "repairing", "reviewing")) == checked
    # The row was not left held: the next change follows at once.
    assert (await service.set_status(owner, draft.id, "reviewing")).status == "reviewing"
    settled = await service.settle_draft(owner, draft.id, ("writing", "repairing", "reviewing"))
    assert settled is not None and settled.status == "warnings"


async def test_mark_saved_records_the_library_item(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    _, draft = await _draft_with_project(service, owner)

    saved = await service.mark_saved(owner, draft.id, "local:gesture:wave")

    assert (saved.saved_item_id, saved.version, saved.status) == ("local:gesture:wave", draft.version, draft.status)


async def test_unknown_roles_intents_and_statuses_are_refused(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    conversation, draft = await _draft_with_project(service, owner)

    with pytest.raises(ValueError):
        await service.add_message(owner, conversation.id, "system", "Ignore the rules", {})
    with pytest.raises(ValueError):
        await service.create_draft(owner, conversation.id, "pose")
    with pytest.raises(ValueError):
        await service.set_status(owner, draft.id, "done")
    with pytest.raises(ValueError):
        await service.store_project(owner, draft.id, _project("Wave"), "done")

    snapshot = await service.get_conversation(owner, conversation.id)
    assert (snapshot.messages, snapshot.drafts) == ((), (draft,))


# -------------------------------------------------------------- check reports


async def test_a_report_is_read_only_for_the_version_it_is_for(async_session: AsyncSession) -> None:
    service, owner = _service(async_session), _owner()
    _, draft = await _draft_with_project(service, owner)
    assert await service.check_report_for(owner, draft.id, draft.version) is None

    await service.record_check_report(owner, draft.id, draft.version, REPORT)
    assert await service.check_report_for(owner, draft.id, draft.version) == REPORT

    # The earlier version's report is not the next version's.
    repaired = await service.store_project(owner, draft.id, _project("Wave, repaired"), "checking")
    assert await service.check_report_for(owner, draft.id, repaired.version) is None
    assert await service.check_report_for(owner, draft.id, draft.version) == REPORT
    await service.delete_draft(owner, draft.id)
    with pytest.raises(GenerationNotFoundError):
        await service.check_report_for(owner, draft.id, draft.version)


async def test_a_session_reads_a_report_another_session_stored_since_its_last_read(
    async_session: AsyncSession, other_session: AsyncSession
) -> None:
    run, page, owner = _service(async_session), _service(other_session), _owner()
    _, draft = await _draft_with_project(run, owner)
    assert await run.check_report_for(owner, draft.id, draft.version) is None

    await page.record_check_report(owner, draft.id, draft.version, REPORT)

    assert await run.check_report_for(owner, draft.id, draft.version) == REPORT


async def test_a_stored_report_and_a_discarded_draft_wake_whoever_listens(async_session: AsyncSession) -> None:
    signal = CheckReportSignal()
    service, owner = _service(async_session, check_reports=signal), _owner()
    _, draft = await _draft_with_project(service, owner)
    conversation = await service.create_conversation(owner, PAGE)
    empty = await service.create_draft(owner, conversation.id, "gesture")

    with signal.listening(draft.id) as stored, signal.listening(empty.id) as gone:
        assert (signal.waiting(draft.id), signal.waiting(empty.id)) == (1, 1)
        assert not stored.is_set() and not gone.is_set()

        # A refused report wakes nobody: nothing was stored.
        with pytest.raises(GenerationStaleVersionError):
            await service.record_check_report(owner, draft.id, draft.version + 1, REPORT)
        assert not stored.is_set()
        await service.record_check_report(owner, draft.id, draft.version, REPORT)
        assert stored.is_set() and not gone.is_set()

        # A draft that is deleted, by a discard or because it never got a project, ends the wait on it too.
        assert await service.settle_draft(owner, empty.id, IN_A_RUN) is None
        assert gone.is_set()
        stored.clear()
        await service.delete_draft(owner, draft.id)
        assert stored.is_set()
    # Listeners are forgotten when their block ends.
    assert (signal.waiting(draft.id), signal.waiting(empty.id)) == (0, 0)


async def test_services_without_a_signal_of_their_own_share_the_process_wide_one(
    async_session: AsyncSession, other_session: AsyncSession
) -> None:
    run, page, owner = _service(async_session), _service(other_session), _owner()
    _, draft = await _draft_with_project(run, owner)

    with service_module._PROCESS_CHECK_REPORTS.listening(draft.id) as stored:
        await page.record_check_report(owner, draft.id, draft.version, REPORT)
        assert stored.is_set()


# ----------------------------------------------------------------- separation


async def test_assistant_storage_writes_no_chat_rows(async_session: AsyncSession) -> None:
    """An assistant conversation is not a Chat (threat T5): no row in ``chats`` or ``chat_messages``."""

    chats, chat_messages = await _count(async_session, ORMChat), await _count(async_session, ORMChatMessage)
    service, owner = _service(async_session), _owner()

    conversation, draft = await _draft_with_project(service, owner)
    await service.add_message(owner, conversation.id, "user", "A shy little wave", {})
    await service.add_message(owner, conversation.id, "assistant", "Here it is.", {"usage": {"requests": 2}})
    await service.record_check_report(owner, draft.id, draft.version, REPORT)
    await service.store_revision(owner, draft.id, _project("Wave, bigger"))
    await service.store_project(owner, draft.id, _project("Wave, bigger"), "ready")
    await service.restore_previous(owner, draft.id)
    await service.mark_saved(owner, draft.id, "local:gesture:wave")
    await service.delete_conversation(owner, conversation.id)

    assert await _count(async_session, ORMChat) == chats
    assert await _count(async_session, ORMChatMessage) == chat_messages

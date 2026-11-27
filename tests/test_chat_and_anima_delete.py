"""Deleting a chat or an Anima stops its turns first and leaves no pending episode or chat-only image behind.

Issue #950 (R6, R8, R10–R12; decisions D1, D2, D4). The shared chat, Anima and
chat-turn routes run over deferred-commit ports with a scripted model on a real
database; a Memory Manager run uses a scripted runtime.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from animama.adapters.memory_manager import MemoryManagerVirtualWorkspace
from animama.adapters.repositories.sqlalchemy.memory_entry_repo import SQLAlchemyMemoryEntryRepository
from animama.adapters.repositories.sqlalchemy.memory_episode_repo import SQLAlchemyMemoryEpisodeRepository
from animama.adapters.repositories.sqlalchemy.memory_manager_repo import SQLAlchemyMemoryManagerRepository
from animama.adapters.repositories.sqlalchemy.uow import SQLAlchemyUnitOfWork
from animama.app.model_clients import StaticModelClientRegistry
from animama.app.ports.memory_manager_runtime import MemoryManagerRuntimeResult
from animama.app.services.memory_entry_service import MemoryEntryNotFoundError, MemoryEntryService
from animama.app.services.memory_episode_service import MemoryEpisodeService
from animama.app.services.memory_manager_service import MemoryManagerConflictError, MemoryManagerService
from animama.app.services.model_role_resolver import ModelRoleDefaults
from animama.domain.chat import MessageRole
from animama.domain.memory_episode import MemoryEpisodeItem, episode_path_for_date
from animama.domain.memory_manager import (
    MemoryManagerApproval,
    MemoryManagerEpisodeTaskState,
    MemoryManagerMessage,
    MemoryManagerRun,
)
from animama.domain.request_principal import RequestPrincipal
from animama.domain.user_file import STATUS_DELETED, STATUS_READY
from animama.orm import ORMAnima, ORMChat, ORMChatMessage, ORMMemoryEpisodeItem, ORMUserSettings
from animama.orm.memory_manager import ORMMemoryManagerApproval, ORMMemoryManagerMessage, ORMMemoryManagerRun
from animama.orm.user_file import ORMUserFile
from animama.product_http.chat import stream as chat_stream, turn_setup
from animama.product_http.chat.active_turns import ActiveChatTurn, active_chat_turns
from animama.product_http.routes import animas, chat_turns, chats
from tests.chat_turn_support import CHAT_ROW, ScriptedModel, remove_chat_owner, seed_chat_owner, structured
from tests.product_http_support import DeferredCommitPorts, TwoOwnerComposition, product_app

DAY = date(2026, 11, 20)
OTHER_DAY = date(2026, 11, 21)
SOURCE_DELETED = "Its source chat was deleted"


@dataclass
class Deletion:
    """One owner with an Anima ready to chat, served by the shared chat, Anima and chat-turn routes."""

    factory: async_sessionmaker[AsyncSession]
    ports: DeferredCommitPorts
    composition: TwoOwnerComposition
    model: ScriptedModel
    owner: str
    anima_id: str
    revision: str

    def client(self) -> httpx.AsyncClient:
        return self.composition.client(self.owner)

    async def turn(self, chat_id: str, run: str, **values: Any) -> httpx.Response:
        body = {"message": "Good morning!", "run_id": run, "chat_id": chat_id, "runtime_revision": self.revision}
        async with self.client() as client:
            return await client.post(f"/v1/animas/{self.anima_id}/chat:sse", json={**body, **values})

    async def chat(self, *, anima_id: str | None = None) -> str:
        chat_id = f"chat-{uuid4().hex}"
        async with self.factory() as session:
            session.add(ORMChat(id=chat_id, anima_id=anima_id or self.anima_id, user_id=self.owner, metadata_={}))
            await session.commit()
        return chat_id

    async def other_anima(self) -> str:
        anima_id = f"anima-other-{uuid4().hex}"
        async with self.factory() as session:
            session.add(ORMAnima(id=anima_id, user_id=self.owner, display_name="Other"))
            await session.commit()
        return anima_id

    async def episode(
        self,
        chat_id: str | None,
        text: str,
        *,
        anima_id: str | None = None,
        local_date: date = DAY,
        processed: bool = False,
    ) -> MemoryEpisodeItem:
        async with self.factory() as session:
            service = _episode_service(session)
            item = await service.create_episode_item(
                user_id=self.owner,
                source_anima_id=anima_id or self.anima_id,
                source_chat_id=chat_id,
                source_run_id=f"run-{uuid4().hex}",
                text=text,
                occurred_at=datetime.combine(local_date, datetime.min.time(), tzinfo=UTC) + timedelta(hours=9),
                local_date=local_date,
                local_timezone="UTC",
            )
            if processed:
                [item] = await service.mark_items_processed(user_id=self.owner, item_ids=[item.id])
        return item

    async def episode_statuses(self) -> dict[str, str]:
        async with self.factory() as session:
            rows = await session.execute(
                select(ORMMemoryEpisodeItem.id, ORMMemoryEpisodeItem.status).where(
                    ORMMemoryEpisodeItem.user_id == self.owner
                )
            )
        return {row.id: row.status for row in rows}

    async def episode_log(self, local_date: date = DAY) -> str:
        async with self.factory() as session:
            entry = await _entries(session).get_entry_by_path(
                user_id=self.owner, path=episode_path_for_date(local_date)
            )
        return entry.content or ""

    async def exists(self, model: type[Any], row_id: str) -> bool:
        async with self.factory() as session:
            return await session.get(model, row_id) is not None

    async def messages(self, chat_id: str) -> int:
        async with self.factory() as session:
            count = await session.scalar(
                select(func.count()).select_from(ORMChatMessage).where(ORMChatMessage.chat_id == chat_id)
            )
        return int(count or 0)

    async def image(self, chat_id: str, file_id: str) -> str:
        """Attach an image to ``chat_id`` as a user message, storing its bytes once."""

        storage = self.ports.uploads(RequestPrincipal(id=self.owner)).private_files
        locator = f"user-files/{self.owner}/{file_id}/original"
        async with self.factory() as session:
            if await session.get(ORMUserFile, file_id) is None:
                assert storage.put_stream(locator, BytesIO(b"png"), content_length=3)
                session.add(
                    ORMUserFile(
                        id=file_id,
                        user_id=self.owner,
                        storage_locator=locator,
                        original_filename=f"{file_id}.png",
                        normalized_extension=".png",
                        declared_size_bytes=3,
                        stored_size_bytes=3,
                        status=STATUS_READY,
                        upload_expires_at=datetime.now(UTC) + timedelta(minutes=10),
                        metadata_={"kind": "image", "image": {"width": 1, "height": 1, "media_type": "image/png"}},
                    )
                )
            session.add(
                ORMChatMessage(
                    chat_id=chat_id,
                    run_id=f"run-{uuid4().hex}",
                    role=MessageRole.USER.value,
                    content=f"Look\n\n[Image: {file_id}.png]",
                    message_data={"images": [{"file_id": file_id, "name": f"{file_id}.png", "width": 1, "height": 1}]},
                )
            )
            await session.commit()
        return locator

    async def image_state(self, file_id: str, locator: str) -> tuple[str | None, bool]:
        """The image row's status and whether its bytes are still stored."""

        storage = self.ports.uploads(RequestPrincipal(id=self.owner)).private_files
        async with self.factory() as session:
            row = await session.get(ORMUserFile, file_id)
        return (row.status if row is not None else None), storage.head(locator) is not None


def _entries(session: AsyncSession, *, commit: bool = True) -> MemoryEntryService:
    return MemoryEntryService(
        memory_entries=SQLAlchemyMemoryEntryRepository(session),
        uow=SQLAlchemyUnitOfWork(session),
        commit_on_write=commit,
    )


def _episode_service(session: AsyncSession) -> MemoryEpisodeService:
    return MemoryEpisodeService(
        memory_episodes=SQLAlchemyMemoryEpisodeRepository(session),
        memory_entries=_entries(session),
        uow=SQLAlchemyUnitOfWork(session),
    )


@pytest.fixture
async def deletion(async_session_factory: async_sessionmaker[AsyncSession], tmp_path: Path) -> AsyncIterator[Deletion]:
    suffix = uuid4().hex[:8]
    owner, other = f"delete-a-{suffix}", f"delete-b-{suffix}"
    anima_id, revision = f"delete-anima-{suffix}", f"tr1-delete-{suffix}"
    model = ScriptedModel()
    ports = DeferredCommitPorts(
        async_session_factory,
        model_clients=StaticModelClientRegistry({"OpenAIResponsesHTTPAgent": model}),
        model_role_defaults=ModelRoleDefaults(chat=CHAT_ROW, utility=CHAT_ROW),
        content_root=tmp_path / "roots",
    )
    app = product_app(chat_turns.router, chats.router, animas.router, ports=ports)
    composition = TwoOwnerComposition(app, tmp_path, owners=(owner, other))
    await seed_chat_owner(async_session_factory, owner=owner, anima_id=anima_id, revision=revision)
    try:
        yield Deletion(async_session_factory, ports, composition, model, owner, anima_id, revision)
    finally:
        await remove_chat_owner(async_session_factory, owner=owner, anima_id=anima_id)
        async with async_session_factory() as session:
            await session.execute(delete(ORMMemoryManagerApproval).where(ORMMemoryManagerApproval.user_id == owner))
            await session.execute(delete(ORMMemoryManagerMessage).where(ORMMemoryManagerMessage.user_id == owner))
            await session.execute(delete(ORMMemoryManagerRun).where(ORMMemoryManagerRun.user_id == owner))
            await session.execute(delete(ORMMemoryEpisodeItem).where(ORMMemoryEpisodeItem.user_id == owner))
            await session.execute(delete(ORMAnima).where(ORMAnima.user_id == owner))
            await session.execute(delete(ORMUserFile).where(ORMUserFile.user_id == owner))
            await session.execute(delete(ORMUserSettings).where(ORMUserSettings.user_id == owner))
            await session.commit()


def _line(item: MemoryEpisodeItem) -> str:
    return f"<!-- episode:{item.id} -->"


async def test_deleting_a_chat_removes_only_its_pending_episodes(deletion: Deletion) -> None:
    doomed, kept = await deletion.chat(), await deletion.chat()
    pending = await deletion.episode(doomed, "Sam is moving to Osaka next spring.")
    alone = await deletion.episode(doomed, "Sam's sister visits on Friday.", local_date=OTHER_DAY)
    processed = await deletion.episode(doomed, "Sam adopted a cat named Pickle.", processed=True)
    elsewhere = await deletion.episode(kept, "Sam started learning the cello.")
    async with deletion.factory() as session:
        await _entries(session).put_file_by_path(
            user_id=deletion.owner, path="notes/pickle.md", content="Pickle is a cat.", create_parents=True
        )

    async with deletion.client() as client:
        assert (await client.delete(f"/v1/chats/{doomed}")).status_code == 204

    assert not await deletion.exists(ORMChat, doomed)
    # Only the deleted chat's pending notes go; a processed one and another chat's stay.
    assert await deletion.episode_statuses() == {processed.id: "processed", elsewhere.id: "pending"}
    log = await deletion.episode_log()
    assert _line(pending) not in log and "Osaka" not in log
    assert _line(processed) in log and _line(elsewhere) in log
    # A day whose only note was removed keeps its log, without the note.
    other_day = await deletion.episode_log(OTHER_DAY)
    assert _line(alone) not in other_day and "Friday" not in other_day
    # Memory written from processed notes stays.
    async with deletion.factory() as session:
        kept_file = await _entries(session).get_entry_by_path(user_id=deletion.owner, path="notes/pickle.md")
    assert kept_file.content == "Pickle is a cat."


class _OneProposalRuntime:
    """A Memory Manager runtime that answers any batch with one proposed note."""

    name = "one_proposal_test"
    model_provider_id: str | None = None

    def __init__(self, *, user_id: str, memory_entries: MemoryEntryService) -> None:
        self._workspace = MemoryManagerVirtualWorkspace(user_id=user_id, memory_entries=memory_entries)

    async def for_run(self, run: MemoryManagerRun) -> _OneProposalRuntime:
        return self

    async def run_user_message(
        self, *, run: MemoryManagerRun, user_message: MemoryManagerMessage, history: object = ()
    ) -> MemoryManagerRuntimeResult:
        approval = await self._workspace.plan_full_content(
            path="notes/from-episodes.md",
            new_content="# From episodes\n\nSam is moving to Osaka.\n",
            new_description="Drafted from pending episodes.",
            summary="Save the move",
            metadata={"runtime": self.name},
        )
        return MemoryManagerRuntimeResult(
            assistant_message="I propose one note.",
            approvals=[approval],
            serialized_agent_state=f"{run.id}:proposal",
            metadata={"runtime": self.name},
        )

    async def resume_approval_decision(
        self, *, run: MemoryManagerRun, approval: MemoryManagerApproval, decision: str, feedback: str | None = None
    ) -> MemoryManagerRuntimeResult:
        return MemoryManagerRuntimeResult(assistant_message="Done.", metadata={"runtime": self.name})


def _manager(session: AsyncSession, owner: str) -> MemoryManagerService:
    uow = SQLAlchemyUnitOfWork(session)
    entries = _entries(session, commit=False)
    return MemoryManagerService(
        memory_manager=SQLAlchemyMemoryManagerRepository(session),
        memory_entries=entries,
        memory_episodes=MemoryEpisodeService(
            memory_episodes=SQLAlchemyMemoryEpisodeRepository(session),
            memory_entries=entries,
            uow=uow,
            commit_on_write=False,
        ),
        runtime=_OneProposalRuntime(user_id=owner, memory_entries=entries),
        uow=uow,
    )


async def test_deleting_a_chat_ends_the_episode_run_holding_its_pending_episodes(deletion: Deletion) -> None:
    doomed, kept = await deletion.chat(), await deletion.chat()
    removed = await deletion.episode(doomed, "Sam is moving to Osaka next spring.")
    held = await deletion.episode(kept, "Sam started learning the cello.")
    async with deletion.factory() as session:
        manager = _manager(session, deletion.owner)
        snapshot = await manager.create_episode_processing_run(user_id=deletion.owner)
        assert snapshot.run.status == "waiting_approval"
        [proposal] = snapshot.approvals

        async with deletion.client() as client:
            assert (await client.delete(f"/v1/chats/{doomed}")).status_code == 204

        # Its proposal can no longer be applied, even from the session that drafted it.
        with pytest.raises(MemoryManagerConflictError):
            await manager.decide_approval(user_id=deletion.owner, approval_id=proposal.id, decision="approve")

    async with deletion.factory() as session:
        ended = await _manager(session, deletion.owner).get_run_snapshot(user_id=deletion.owner, run_id=snapshot.run.id)
        assert (ended.run.status, ended.run.error) == ("failed", SOURCE_DELETED)
        assert [approval.status for approval in ended.approvals] == ["rejected"]
        # Nothing was written from it.
        with pytest.raises(MemoryEntryNotFoundError):
            await _entries(session).get_entry_by_path(user_id=deletion.owner, path="notes/from-episodes.md")
    # The run's other note is pending again, and a new run picks it up.
    assert await deletion.episode_statuses() == {held.id: "pending"}
    assert removed.id not in await deletion.episode_log()
    async with deletion.factory() as session:
        again = await _manager(session, deletion.owner).create_episode_processing_run(user_id=deletion.owner)
    assert [item.episode_item_id for item in MemoryManagerEpisodeTaskState.from_dict(again.run.task_state).items] == [
        held.id
    ]


async def test_an_episode_run_that_still_finishes_marks_only_the_notes_left(deletion: Deletion) -> None:
    gone_chat, kept_chat = await deletion.chat(), await deletion.chat()
    await deletion.episode(gone_chat, "Sam is moving to Osaka next spring.")
    left = await deletion.episode(kept_chat, "Sam started learning the cello.")
    async with deletion.factory() as session:
        manager = _manager(session, deletion.owner)
        snapshot = await manager.create_episode_processing_run(user_id=deletion.owner)
        # A note leaves the batch without its run ending, as a delete racing the run could leave it.
        await SQLAlchemyMemoryEpisodeRepository(session).delete_pending_items(
            user_id=deletion.owner, source_chat_ids=[gone_chat]
        )
        await session.commit()

        await manager.decide_approval(user_id=deletion.owner, approval_id=snapshot.approvals[0].id, decision="approve")
        finished = await manager.get_run_snapshot(user_id=deletion.owner, run_id=snapshot.run.id)

    assert MemoryManagerEpisodeTaskState.from_dict(finished.run.task_state).status == "processed"
    assert await deletion.episode_statuses() == {left.id: "processed"}


async def test_a_delete_between_an_automatic_runs_steps_ends_it_for_the_delete(deletion: Deletion) -> None:
    doomed = await deletion.chat()
    await deletion.episode(doomed, "Sam is moving to Osaka next spring.")
    async with deletion.factory() as session:
        manager = _manager(session, deletion.owner)
        approve = manager._approve_automatic_proposal
        deleted: list[int] = []

        async def delete_then_approve(**kwargs: Any) -> Any:
            # The chat is deleted after the run proposed its change, right before it approves it.
            if not deleted:
                async with deletion.client() as client:
                    deleted.append((await client.delete(f"/v1/chats/{doomed}")).status_code)
            return await approve(**kwargs)

        manager._approve_automatic_proposal = delete_then_approve  # type: ignore[method-assign]
        outcome = await manager.run_automatic_episode_processing(user_id=deletion.owner)

    assert deleted == [204]
    assert (outcome.status, outcome.reason) == ("failed", SOURCE_DELETED)
    async with deletion.factory() as session:
        [run] = await SQLAlchemyMemoryManagerRepository(session).list_automatic_runs(user_id=deletion.owner, limit=5)
        assert (run.status, run.error) == ("failed", SOURCE_DELETED)
        assert (run.metadata or {}).get("completion_reason") == "source_deleted"
        with pytest.raises(MemoryEntryNotFoundError):
            await _entries(session).get_entry_by_path(user_id=deletion.owner, path="notes/from-episodes.md")
    assert await deletion.episode_statuses() == {}


async def test_deleting_an_anima_removes_its_chat_only_images_and_pending_episodes(deletion: Deletion) -> None:
    first, second = await deletion.chat(), await deletion.chat()
    other_anima = await deletion.other_anima()
    other_chat = await deletion.chat(anima_id=other_anima)
    only_here, shared = f"file-only-{uuid4().hex}", f"file-shared-{uuid4().hex}"
    only_here_locator = await deletion.image(first, only_here)
    await deletion.image(second, only_here)
    shared_locator = await deletion.image(first, shared)
    await deletion.image(other_chat, shared)
    pending = await deletion.episode(first, "Sam is moving to Osaka next spring.")
    chatless = await deletion.episode(None, "Sam mentioned a new job.")
    processed = await deletion.episode(second, "Sam adopted a cat named Pickle.", processed=True)
    elsewhere = await deletion.episode(other_chat, "Sam started learning the cello.", anima_id=other_anima)
    async with deletion.factory() as session:
        session.add(ORMUserSettings(user_id=deletion.owner, last_active_anima_id=deletion.anima_id, preferences={}))
        await session.commit()

    async with deletion.client() as client:
        assert (await client.delete(f"/v1/animas/{deletion.anima_id}")).status_code == 204

    assert not await deletion.exists(ORMAnima, deletion.anima_id)
    assert not await deletion.exists(ORMChat, first) and not await deletion.exists(ORMChat, second)
    assert await deletion.exists(ORMChat, other_chat)
    # Images only its chats used are deleted; one another Anima's chat uses stays.
    assert await deletion.image_state(only_here, only_here_locator) == (STATUS_DELETED, False)
    assert await deletion.image_state(shared, shared_locator) == (STATUS_READY, True)
    assert await deletion.episode_statuses() == {processed.id: "processed", elsewhere.id: "pending"}
    log = await deletion.episode_log()
    assert _line(pending) not in log and _line(chatless) not in log
    assert _line(processed) in log and _line(elsewhere) in log
    async with deletion.factory() as session:
        settings = await session.get(ORMUserSettings, deletion.owner)
    assert settings is not None and settings.last_active_anima_id is None


async def _delete(deletion: Deletion, target: str, chat_id: str) -> httpx.Response:
    path = f"/v1/chats/{chat_id}" if target == "chat" else f"/v1/animas/{deletion.anima_id}"
    async with deletion.client() as client:
        return await client.delete(path)


def _errors(caplog: pytest.LogCaptureFixture) -> list[str]:
    """What was logged at ERROR or above; stopping a turn for a delete logs nothing there."""

    return [f"{record.name}: {record.getMessage()}" for record in caplog.records if record.levelno >= logging.ERROR]


async def _left_behind(deletion: Deletion, chat_id: str) -> tuple[bool, int, dict[str, str]]:
    """Whether the chat still exists, its message count and the owner's episode items."""

    return await deletion.exists(ORMChat, chat_id), await deletion.messages(chat_id), await deletion.episode_statuses()


@pytest.mark.parametrize("target", ["chat", "anima"])
async def test_a_delete_during_turn_setup_sends_no_model_request(
    deletion: Deletion, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, target: str
) -> None:
    caplog.set_level(logging.WARNING)
    chat_id = await deletion.chat()
    deletion.model.replies.append(structured("Good morning! Shall we have tea?", remember="Sam loves green tea."))
    in_setup, release = asyncio.Event(), asyncio.Event()
    prepare = turn_setup.prepare_direct_chat_turn

    async def gated_setup(**kwargs: Any) -> Any:
        in_setup.set()
        await release.wait()
        return await prepare(**kwargs)

    monkeypatch.setattr(chat_stream, "prepare_direct_chat_turn", gated_setup)
    replying = asyncio.create_task(deletion.turn(chat_id, "run-in-setup"))
    await asyncio.wait_for(in_setup.wait(), 10)
    deleting = asyncio.create_task(_delete(deletion, target, chat_id))
    [turn] = active_chat_turns(deletion.composition.app)

    async def stop_requested() -> None:
        while not turn.stop_requested:
            await asyncio.sleep(0.01)

    # The delete asks the turn to stop while its setup is still running.
    await asyncio.wait_for(stop_requested(), 10)
    release.set()

    deleted, reply = await asyncio.wait_for(asyncio.gather(deleting, replying), 15)

    assert (deleted.status_code, reply.status_code) == (204, 200)
    assert deletion.model.requests == []
    [lease] = deletion.ports.chat_guard.leases
    assert lease.settlements == ["unstarted"]
    assert await _left_behind(deletion, chat_id) == (False, 0, {})
    assert _errors(caplog) == []


async def test_a_stop_as_the_response_begins_sends_no_model_request(
    deletion: Deletion, monkeypatch: pytest.MonkeyPatch
) -> None:
    deletion.model.replies.append(structured("Good morning! Shall we have tea?"))
    bind = ActiveChatTurn.bind_cancel

    def bind_then_stop(turn: ActiveChatTurn, cancel: Callable[[], None]) -> None:
        # The stop lands just after the response checked for one, before its cancel takes effect.
        bind(turn, cancel)
        turn.request_stop()

    monkeypatch.setattr(ActiveChatTurn, "bind_cancel", bind_then_stop)

    reply = await deletion.turn(await deletion.chat(), "run-stopped-at-start")

    assert reply.status_code == 200
    assert deletion.model.requests == []
    [lease] = deletion.ports.chat_guard.leases
    assert lease.settlements == ["unstarted"]


@pytest.mark.parametrize("target", ["chat", "anima"])
async def test_a_delete_while_the_model_streams_cancels_the_reply(
    deletion: Deletion, caplog: pytest.LogCaptureFixture, target: str
) -> None:
    caplog.set_level(logging.WARNING)
    chat_id = await deletion.chat()
    deletion.model.hold = asyncio.Event()
    deletion.model.replies.append(structured("Good morning. Shall we have tea?", remember="Sam loves green tea."))
    replying = asyncio.create_task(deletion.turn(chat_id, "run-mid-stream"))
    await asyncio.wait_for(deletion.model.holding.wait(), 10)

    deleted = await _delete(deletion, target, chat_id)
    reply = await asyncio.wait_for(replying, 10)

    assert (deleted.status_code, reply.status_code) == (204, 200)
    assert deletion.model.cancelled
    [lease] = deletion.ports.chat_guard.leases
    assert lease.settlements == ["interrupted"]
    assert await _left_behind(deletion, chat_id) == (False, 0, {})
    assert _errors(caplog) == []


@pytest.mark.parametrize("target", ["chat", "anima"])
async def test_a_delete_during_a_reply_save_waits_for_it_and_leaves_nothing(
    deletion: Deletion, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, target: str
) -> None:
    caplog.set_level(logging.WARNING)
    chat_id = f"chat-{uuid4().hex}"
    deletion.model.replies.append(structured("Good morning! Shall we have tea?", remember="Sam loves green tea."))
    saving = asyncio.Event()
    original = deletion.ports.write_session

    @asynccontextmanager
    async def slow_save(principal: Any) -> AsyncIterator[Any]:
        current = asyncio.current_task()
        if current is not None and current.get_name() == "direct-chat-save":
            # The save has begun; the delete arrives while it runs.
            saving.set()
            await asyncio.sleep(0.3)
        async with original(principal) as session:
            yield session

    monkeypatch.setattr(deletion.ports, "write_session", slow_save)
    replying = asyncio.create_task(deletion.turn(chat_id, "run-mid-save"))
    await asyncio.wait_for(saving.wait(), 10)

    deleted = await _delete(deletion, target, chat_id)
    reply = await asyncio.wait_for(replying, 10)

    assert deleted.status_code == 204, deleted.text
    assert reply.status_code == 200
    assert "event: error" not in reply.text
    # The save finished before the delete, so the delete took the saved reply with it.
    [lease] = deletion.ports.chat_guard.leases
    assert lease.settlements == ["completed"]
    assert lease.running_at_settlement == []
    assert await _left_behind(deletion, chat_id) == (False, 0, {})
    assert len(active_chat_turns(deletion.composition.app)) == 0
    assert _errors(caplog) == []


@pytest.mark.parametrize("target", ["chat", "anima"])
async def test_a_turn_that_does_not_stop_in_time_refuses_the_delete(deletion: Deletion, target: str) -> None:
    chat_id = await deletion.chat()
    pending = await deletion.episode(chat_id, "Sam is moving to Osaka next spring.")
    turns = active_chat_turns(deletion.composition.app)
    turns.stop_timeout_seconds = 0.05
    stuck = turns.register(owner_id=deletion.owner, chat_id=chat_id, anima_id=deletion.anima_id)

    refused = await _delete(deletion, target, chat_id)

    assert (refused.status_code, refused.json()) == (409, {"detail": {"code": "chat_turn_stopping"}})
    assert stuck.stop_requested
    assert await deletion.exists(ORMAnima, deletion.anima_id) and await deletion.exists(ORMChat, chat_id)
    assert await deletion.episode_statuses() == {pending.id: "pending"}
    assert deletion.ports.commits == 0

    # Once the turn has stopped, the same delete succeeds.
    stuck.settled()
    assert (await _delete(deletion, target, chat_id)).status_code == 204
    assert not await deletion.exists(ORMChat, chat_id)


async def test_a_delete_stops_only_the_owners_turns_of_that_chat(deletion: Deletion) -> None:
    doomed, kept = await deletion.chat(), await deletion.chat()
    turns = active_chat_turns(deletion.composition.app)
    other_chat = turns.register(owner_id=deletion.owner, chat_id=kept, anima_id=deletion.anima_id)
    other_owner = turns.register(owner_id="someone-else", chat_id=doomed, anima_id=deletion.anima_id)

    async with deletion.client() as client:
        assert (await client.delete(f"/v1/chats/{doomed}")).status_code == 204

    assert not other_chat.stop_requested and not other_owner.stop_requested

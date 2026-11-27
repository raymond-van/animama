"""Automatic episode processing in the local composition (spec #775, R5, R6, R8, R9 and R11)."""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from typing import Any, cast

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from animama.adapters.repositories.sqlalchemy.memory_entry_repo import SQLAlchemyMemoryEntryRepository
from animama.adapters.repositories.sqlalchemy.memory_episode_repo import SQLAlchemyMemoryEpisodeRepository
from animama.adapters.repositories.sqlalchemy.memory_manager_repo import SQLAlchemyMemoryManagerRepository
from animama.adapters.repositories.sqlalchemy.uow import SQLAlchemyUnitOfWork
from animama.app.services.memory_entry_service import MemoryEntryService
from animama.app.services.memory_episode_service import MemoryEpisodeService
from animama.app.services.memory_manager_service import MemoryManagerService
from animama.domain.memory_manager import (
    MemoryManagerEpisodeTaskItem,
    MemoryManagerEpisodeTaskState,
    MemoryManagerRun,
    new_memory_manager_run_id,
)
from animama.domain.request_principal import RequestPrincipal
from animama.local.installation_repository import SQLAlchemyEpisodeProcessingSettingsRepository
from animama.orm import ORMUserSettings
from animama.server.episode_processing import (
    AutomaticEpisodeProcessingWorker,
    EpisodeProcessingStatus,
    ModelReadiness,
)
from animama.server.product_ports import LocalChatTurnLease
from animama.server.routers import memory_automation
from animama.server.schemas.memory_automation import PyAutomaticEpisodeProcessingUpdate
from tests.product_http_support import local_ports

_NOW = datetime(2026, 10, 28, 15, 0, tzinfo=UTC)
_LOCAL_PORTS = local_ports()


@pytest.fixture(autouse=True)
def use_fake_memory_manager_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANIMAMA_LLM_SKIP", "1")


@dataclass
class _Harness:
    worker: AutomaticEpisodeProcessingWorker
    owner_id: str
    clock: list[datetime]


def _harness(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    model_usable: bool | str = True,
    real_clock: bool = False,
    rest_seconds: float = 300.0,
    memory_manager: Any = None,
) -> _Harness:
    owner_id = f"user-{uuid.uuid4()}"
    clock = [_NOW]

    async def local_memory_manager(session: AsyncSession, user_id: str) -> MemoryManagerService:
        return await _LOCAL_PORTS.memory_manager(session, RequestPrincipal(id=user_id))

    async def usable(session: AsyncSession, user_id: str) -> ModelReadiness:
        if isinstance(model_usable, str):
            return cast(ModelReadiness, model_usable)
        return "usable" if model_usable else "needs_model"

    worker = AutomaticEpisodeProcessingWorker(
        session_factory,
        owner_id=owner_id,
        memory_manager=memory_manager or local_memory_manager,
        model_usable=usable,
        clock=None if real_clock else (lambda: clock[0]),
        rest_seconds=rest_seconds,
    )
    return _Harness(worker=worker, owner_id=owner_id, clock=clock)


async def _set_threshold(session: AsyncSession, owner_id: str, threshold: int, changed_at: datetime = _NOW) -> None:
    await SQLAlchemyEpisodeProcessingSettingsRepository(session).set_threshold(
        user_id=owner_id, threshold=threshold, changed_at=changed_at
    )
    await session.commit()


async def _eventually(check: Any, *, timeout: float = 15.0) -> None:
    """Wait until ``check()`` returns true, for the background task's work."""

    deadline = asyncio.get_running_loop().time() + timeout
    while not await check():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("the background task did not get there in time")
        await asyncio.sleep(0.05)


async def _notes(session: AsyncSession, owner_id: str, count: int) -> None:
    entries = MemoryEntryService(
        memory_entries=SQLAlchemyMemoryEntryRepository(session), uow=SQLAlchemyUnitOfWork(session)
    )
    episodes = MemoryEpisodeService(
        memory_episodes=SQLAlchemyMemoryEpisodeRepository(session),
        memory_entries=entries,
        uow=SQLAlchemyUnitOfWork(session),
    )
    for index in range(count):
        await episodes.create_episode_item(
            user_id=owner_id,
            source_anima_id="anima-1",
            source_chat_id=f"chat-{uuid.uuid4()}",
            source_run_id=f"run-{uuid.uuid4()}",
            text=f"Note number {index}.",
            occurred_at=_NOW - timedelta(minutes=count - index),
            local_date=date(2026, 10, 28),
            local_timezone="UTC",
        )


async def _automatic_run(
    session: AsyncSession,
    owner_id: str,
    *,
    status: str,
    started_at: datetime,
    completed_at: datetime | None = None,
    reason: str | None = None,
    error: str | None = None,
) -> None:
    task = MemoryManagerEpisodeTaskState(
        status="processed" if status == "completed" else "processing",
        items=(MemoryManagerEpisodeTaskItem(episode_item_id=f"mei-{uuid.uuid4()}", ref="E01"),),
        has_more=False,
        started_at=started_at,
        processed_at=(completed_at or started_at) if status == "completed" else None,
    )
    await SQLAlchemyMemoryManagerRepository(session).create_run(
        MemoryManagerRun(
            id=new_memory_manager_run_id(),
            user_id=owner_id,
            status=status,
            kind="episode_processing",
            task_state=task.to_dict(),
            error=error,
            metadata={"origin": "automatic", **({"completion_reason": reason} if reason else {})},
            completed_at=completed_at.replace(tzinfo=None) if completed_at else None,
        )
    )
    await session.commit()


@pytest.mark.asyncio
async def test_a_run_starts_once_the_default_threshold_of_ten_notes_is_pending(
    async_session: AsyncSession,
    async_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    harness = _harness(async_session_factory)
    await _notes(async_session, harness.owner_id, 9)

    assert (await harness.worker.status()).state == "waiting"
    assert await harness.worker.run_pass() is None

    await _notes(async_session, harness.owner_id, 1)
    status = await harness.worker.status()
    assert (status.threshold, status.state, status.pending_count) == (10, "ready", 10)
    outcome = await harness.worker.run_pass()

    assert outcome is not None and outcome.status == "completed"
    assert outcome.batch_size == 10
    after = await harness.worker.status()
    assert (after.state, after.pending_count, after.runs_today) == ("waiting", 0, 1)


@pytest.mark.asyncio
@pytest.mark.parametrize("memory_flag", ["disable_influence", "disable_updates"])
async def test_off_memory_off_and_a_missing_model_start_nothing(
    async_session: AsyncSession,
    async_session_factory: async_sessionmaker[AsyncSession],
    memory_flag: str,
) -> None:
    harness = _harness(async_session_factory)
    await _notes(async_session, harness.owner_id, 10)

    await _set_threshold(async_session, harness.owner_id, 0)
    assert (await harness.worker.status()).state == "off"
    assert await harness.worker.run_pass() is None

    await _set_threshold(async_session, harness.owner_id, 10)
    async_session.add(ORMUserSettings(user_id=harness.owner_id, preferences={"memory": {memory_flag: True}}))
    await async_session.commit()
    assert (await harness.worker.status()).state == "memory_off"

    no_model = _harness(async_session_factory, model_usable=False)
    await _notes(async_session, no_model.owner_id, 10)
    assert (await no_model.worker.status()).state == "needs_model"
    assert await no_model.worker.run_pass() is None

    # A ChatGPT plan model without the owner's agreement, or paused by a usage limit, waits (D5, D6).
    for readiness in ("needs_plan_agreement", "plan_paused"):
        waiting = _harness(async_session_factory, model_usable=readiness)
        await _notes(async_session, waiting.owner_id, 10)
        assert (await waiting.worker.status()).state == readiness
        assert await waiting.worker.run_pass() is None


@pytest.mark.asyncio
async def test_an_open_automatic_run_reports_running_with_its_batch(
    async_session: AsyncSession,
    async_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    harness = _harness(async_session_factory)
    await _notes(async_session, harness.owner_id, 12)
    await _automatic_run(async_session, harness.owner_id, status="active", started_at=_NOW - timedelta(seconds=5))

    status = await harness.worker.status()

    assert (status.state, status.batch_size, status.started_at) == ("running", 1, _NOW - timedelta(seconds=5))
    assert await harness.worker.run_pass() is None


@pytest.mark.asyncio
async def test_failures_back_off_then_pause_and_interrupted_runs_do_not_count(
    async_session: AsyncSession,
    async_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    harness = _harness(async_session_factory)
    await _notes(async_session, harness.owner_id, 10)
    first_failure = _NOW - timedelta(hours=5)
    await _automatic_run(
        async_session,
        harness.owner_id,
        status="failed",
        started_at=first_failure,
        completed_at=first_failure,
        error="first",
    )
    await _automatic_run(
        async_session,
        harness.owner_id,
        status="failed",
        started_at=_NOW - timedelta(hours=4),
        completed_at=_NOW - timedelta(hours=4),
        reason="automatic_interrupted",
    )
    second_failure = _NOW - timedelta(minutes=30)
    await _automatic_run(
        async_session,
        harness.owner_id,
        status="failed",
        started_at=second_failure,
        completed_at=second_failure,
        error="second",
    )

    status = await harness.worker.status()
    # Two failures: the next attempt waits two hours after the latest one.
    assert (status.state, status.last_error) == ("backing_off", "second")
    assert status.next_attempt_at == second_failure + timedelta(hours=2)
    assert await harness.worker.run_pass() is None

    harness.clock[0] = second_failure + timedelta(hours=2, seconds=1)
    assert (await harness.worker.status()).state == "ready"

    await _automatic_run(
        async_session,
        harness.owner_id,
        status="failed",
        started_at=harness.clock[0],
        completed_at=harness.clock[0],
        error="third",
    )
    paused = await harness.worker.status()
    assert (paused.state, paused.last_error) == ("paused", "third")

    # Changing the threshold lifts the pause.
    harness.clock[0] += timedelta(minutes=1)
    await _set_threshold(async_session, harness.owner_id, 5, harness.clock[0])
    assert (await harness.worker.status()).state == "ready"


@pytest.mark.asyncio
async def test_a_run_a_chat_delete_ended_is_not_a_failure(
    async_session: AsyncSession,
    async_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    harness = _harness(async_session_factory)
    await _notes(async_session, harness.owner_id, 10)
    failure = _NOW - timedelta(hours=2)
    await _automatic_run(
        async_session, harness.owner_id, status="failed", started_at=failure, completed_at=failure, error="first"
    )
    ended = _NOW - timedelta(minutes=30)
    await _automatic_run(
        async_session,
        harness.owner_id,
        status="failed",
        started_at=ended,
        completed_at=ended,
        reason="source_deleted",
        error="Its source chat was deleted",
    )

    status = await harness.worker.status()
    # Only the real failure counts, and its one-hour backoff has passed.
    assert (status.state, status.last_error) == ("ready", "first")


@pytest.mark.asyncio
async def test_a_successful_owner_run_lifts_the_pause(
    async_session: AsyncSession,
    async_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    harness = _harness(async_session_factory)
    for offset in (3, 2, 1):
        failed_at = _NOW - timedelta(days=1, hours=offset)
        await _automatic_run(
            async_session, harness.owner_id, status="failed", started_at=failed_at, completed_at=failed_at
        )
    await _notes(async_session, harness.owner_id, 1)
    assert (await harness.worker.status()).state == "paused"

    service = await _LOCAL_PORTS.memory_manager(async_session, RequestPrincipal(id=harness.owner_id))
    await service.create_episode_processing_run(user_id=harness.owner_id, auto_approve_diffs=True)
    await _notes(async_session, harness.owner_id, 10)

    assert (await harness.worker.status()).state == "ready"


@pytest.mark.asyncio
async def test_at_most_ten_automatic_runs_start_per_local_day(
    async_session: AsyncSession,
    async_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    harness = _harness(async_session_factory)
    await _notes(async_session, harness.owner_id, 10)
    for index in range(9):
        started = _NOW.replace(hour=1) + timedelta(minutes=index)
        await _automatic_run(
            async_session, harness.owner_id, status="completed", started_at=started, completed_at=started
        )
    # The tenth run failed long enough ago that its backoff has passed: the wait is the daily limit.
    failed_at = _NOW.replace(hour=2)
    await _automatic_run(
        async_session, harness.owner_id, status="failed", started_at=failed_at, completed_at=failed_at, error="boom"
    )

    status = await harness.worker.status()

    assert (status.state, status.runs_today) == ("backing_off", 10)
    assert status.next_attempt_at == datetime(2026, 10, 29, tzinfo=UTC)
    assert status.last_error is None


@pytest.mark.asyncio
async def test_recovery_closes_runs_an_earlier_process_left_open(
    async_session: AsyncSession,
    async_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    harness = _harness(async_session_factory)
    await _automatic_run(async_session, harness.owner_id, status="active", started_at=_NOW - timedelta(minutes=2))

    assert await harness.worker.recover() == 1

    await _notes(async_session, harness.owner_id, 10)
    # An interrupted run is not a failure, so nothing waits.
    assert (await harness.worker.status()).state == "ready"


def test_the_threshold_is_off_or_five_to_fifty() -> None:
    for valid in (0, 5, 10, 50):
        assert PyAutomaticEpisodeProcessingUpdate(threshold=valid).threshold == valid
    for invalid in (-1, 1, 4, 51):
        with pytest.raises(ValidationError):
            PyAutomaticEpisodeProcessingUpdate(threshold=invalid)


@pytest.mark.asyncio
async def test_the_route_stores_the_threshold_and_returns_the_status(
    async_session: AsyncSession,
    async_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    harness = _harness(async_session_factory)
    app = SimpleNamespace(state=SimpleNamespace(automatic_episode_processing_worker=harness.worker))
    request: Any = SimpleNamespace(app=app)
    principal = RequestPrincipal(id=harness.owner_id)

    updated = await memory_automation.update_automatic_episode_processing(
        PyAutomaticEpisodeProcessingUpdate(threshold=20), request, principal, async_session
    )
    read = await memory_automation.get_automatic_episode_processing(request, principal)

    assert (updated.threshold, updated.state) == (20, "waiting")
    assert read.threshold == 20
    threshold, reset_at = await SQLAlchemyEpisodeProcessingSettingsRepository(async_session).get(
        user_id=harness.owner_id
    )
    assert threshold == 20 and reset_at is not None
    with pytest.raises(HTTPException) as foreign:
        await memory_automation.get_automatic_episode_processing(request, RequestPrincipal(id="someone-else"))
    assert foreign.value.status_code == 404


@pytest.mark.asyncio
async def test_a_local_chat_turn_wakes_processing_when_it_settles(
    async_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    harness = _harness(async_session_factory)
    app: Any = SimpleNamespace(state=SimpleNamespace(automatic_episode_processing_worker=harness.worker))

    await LocalChatTurnLease(app).settle("completed")

    assert harness.worker._wake.is_set()
    # Without a worker (for example during startup) settling still succeeds.
    without_worker: Any = SimpleNamespace(state=SimpleNamespace())
    await LocalChatTurnLease(without_worker).settle("completed")


def test_status_fields_match_the_api_schema() -> None:
    from dataclasses import fields

    from animama.server.schemas.memory_automation import PyAutomaticEpisodeProcessingStatus

    assert {field.name for field in fields(EpisodeProcessingStatus)} == set(
        PyAutomaticEpisodeProcessingStatus.model_fields
    )


@pytest.mark.asyncio
async def test_a_run_in_flight_stays_visible_after_processing_is_turned_off(
    async_session: AsyncSession,
    async_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    harness = _harness(async_session_factory)
    await _automatic_run(async_session, harness.owner_id, status="active", started_at=_NOW - timedelta(seconds=5))
    await _set_threshold(async_session, harness.owner_id, 0)
    async_session.add(ORMUserSettings(user_id=harness.owner_id, preferences={"memory": {"disable_updates": True}}))
    await async_session.commit()

    assert (await harness.worker.status()).state == "running"


@pytest.mark.asyncio
async def test_the_daily_limit_follows_the_owners_day_and_reports_utc(
    async_session: AsyncSession,
    async_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    harness = _harness(async_session_factory)
    # 15:00 UTC on 28 October is 11:00 in Toronto; its day began at 04:00 UTC.
    async_session.add(ORMUserSettings(user_id=harness.owner_id, preferences={"timezone": "America/Toronto"}))
    await async_session.commit()
    await _notes(async_session, harness.owner_id, 10)
    yesterday_in_toronto = datetime(2026, 10, 28, 3, 30, tzinfo=UTC)
    await _automatic_run(
        async_session,
        harness.owner_id,
        status="completed",
        started_at=yesterday_in_toronto,
        completed_at=yesterday_in_toronto,
    )
    for index in range(10):
        started = datetime(2026, 10, 28, 5, index, tzinfo=UTC)
        await _automatic_run(
            async_session, harness.owner_id, status="completed", started_at=started, completed_at=started
        )

    status = await harness.worker.status()

    assert (status.state, status.runs_today) == ("backing_off", 10)
    assert status.next_attempt_at == datetime(2026, 10, 29, 4, tzinfo=UTC)
    assert status.next_attempt_at is not None and status.next_attempt_at.utcoffset() == timedelta(0)


@pytest.mark.asyncio
async def test_the_task_recovers_at_startup_then_processes(
    async_session: AsyncSession,
    async_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    harness = _harness(async_session_factory, real_clock=True, rest_seconds=0.05)
    await _automatic_run(async_session, harness.owner_id, status="active", started_at=datetime.now(UTC))
    await _notes(async_session, harness.owner_id, 10)

    harness.worker.start()
    try:

        async def processed() -> bool:
            status = await harness.worker.status()
            return status.pending_count == 0 and status.state != "running"

        await _eventually(processed)
    finally:
        await harness.worker.stop()

    runs = await SQLAlchemyMemoryManagerRepository(async_session).list_automatic_runs(user_id=harness.owner_id, limit=5)
    assert sorted(run.status for run in runs) == ["completed", "failed"]
    assert any(dict(run.metadata or {}).get("completion_reason") == "automatic_interrupted" for run in runs)


@pytest.mark.asyncio
async def test_the_task_works_through_a_backlog_until_the_daily_limit(
    async_session: AsyncSession,
    async_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    harness = _harness(async_session_factory, real_clock=True, rest_seconds=0.05)
    await _set_threshold(async_session, harness.owner_id, 5, datetime.now(UTC))
    now = datetime.now(UTC)
    for index in range(8):
        started = now - timedelta(seconds=index + 1)
        await _automatic_run(
            async_session, harness.owner_id, status="completed", started_at=started, completed_at=started
        )
    # 110 notes: two runs of 50 reach the limit of ten today and leave ten pending.
    await _notes(async_session, harness.owner_id, 110)

    harness.worker.start()
    try:

        async def at_limit() -> bool:
            return (await harness.worker.status()).state == "backing_off"

        await _eventually(at_limit, timeout=30)
    finally:
        await harness.worker.stop()

    status = await harness.worker.status()
    assert (status.runs_today, status.pending_count) == (10, 10)


@pytest.mark.asyncio
async def test_a_failing_pass_does_not_end_the_task(
    async_session: AsyncSession,
    async_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    calls = 0

    async def flaky(session: AsyncSession, user_id: str) -> MemoryManagerService:
        nonlocal calls
        calls += 1
        if calls == 2:  # The first call is startup recovery; the first pass fails.
            raise RuntimeError("database briefly unavailable")
        return await _LOCAL_PORTS.memory_manager(session, RequestPrincipal(id=user_id))

    harness = _harness(async_session_factory, real_clock=True, rest_seconds=0.05, memory_manager=flaky)
    await _notes(async_session, harness.owner_id, 10)

    harness.worker.start()
    try:

        async def processed() -> bool:
            return (await harness.worker.status()).pending_count == 0

        await _eventually(processed)
        assert harness.worker._task is not None and not harness.worker._task.done()
    finally:
        await harness.worker.stop()
    assert calls >= 3


@pytest.mark.asyncio
async def test_a_chat_turn_settling_wakes_a_resting_task(
    async_session: AsyncSession,
    async_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    harness = _harness(async_session_factory, real_clock=True, rest_seconds=600)
    await _notes(async_session, harness.owner_id, 9)
    app: Any = SimpleNamespace(state=SimpleNamespace(automatic_episode_processing_worker=harness.worker))

    harness.worker.start()
    try:

        async def waiting() -> bool:
            return (await harness.worker.status()).state == "waiting"

        await _eventually(waiting)
        await asyncio.sleep(0.2)  # Let the task settle into its ten-minute rest.
        await _notes(async_session, harness.owner_id, 1)
        await LocalChatTurnLease(app).settle("completed")

        async def processed() -> bool:
            return (await harness.worker.status()).pending_count == 0

        await _eventually(processed)
    finally:
        await harness.worker.stop()


@pytest.mark.asyncio
async def test_the_model_check_needs_a_tool_capable_row_with_its_key(monkeypatch: pytest.MonkeyPatch) -> None:
    from animama.app.model_clients.credentials import static_credential_resolver
    from animama.domain import ModelProvider
    from animama.server import memory_manager as local_manager

    # The role resolver already admits only tool-capable rows; this check adds the key.
    row = ModelProvider(
        id="OpenAIResponsesHTTPAgent:gpt-6-luna",
        provider_type="OpenAIResponsesHTTPAgent",
        model="gpt-6-luna",
        model_label="GPT-6 Luna",
        provider_label="OpenAI",
        connection_id="openai",
    )

    class _Roles:
        def __init__(self, model_provider: ModelProvider | None) -> None:
            self._model_provider = model_provider

        async def resolve(self, owner_id: str, role: str) -> Any:
            return SimpleNamespace(model_provider=self._model_provider)

    readiness = local_manager.local_memory_manager_model_readiness
    assert await readiness("owner", roles=_Roles(None), llm_skip=False) == "needs_model"  # type: ignore[arg-type]
    monkeypatch.setattr(local_manager, "build_model_credential_resolver", lambda: static_credential_resolver({}))
    assert await readiness("owner", roles=_Roles(row), llm_skip=False) == "needs_model"  # type: ignore[arg-type]
    monkeypatch.setattr(
        local_manager,
        "build_model_credential_resolver",
        lambda: static_credential_resolver({"OPENAI_API_KEY": "sk-test"}),
    )
    assert await readiness("owner", roles=_Roles(row), llm_skip=False) == "usable"  # type: ignore[arg-type]
    assert await readiness("owner", roles=_Roles(None), llm_skip=True) == "usable"  # type: ignore[arg-type]

    # A ChatGPT plan model needs a usable sign-in, the owner's agreement and no usage-limit pause (spec #919 D5).
    plan = replace(row, id="ChatGPTPlanResponsesHTTPAgent:gpt-6-luna", provider_type="ChatGPTPlanResponsesHTTPAgent")
    plan.connection_id = "chatgpt_plan"

    def session(**status: Any) -> Any:
        values = {"state": "signed_in", "plan_use_granted": True, "background_agreed": True, "paused": False, **status}

        class _Session:
            async def status(self) -> Any:
                return SimpleNamespace(**values)

        return _Session

    def plan_readiness(**status: Any) -> Any:
        return readiness("owner", roles=_Roles(plan), llm_skip=False, chatgpt_plan_session=session(**status))  # type: ignore[arg-type]

    assert await plan_readiness() == "usable"
    assert await plan_readiness(background_agreed=False) == "needs_plan_agreement"
    assert await plan_readiness(paused=True) == "plan_paused"
    assert await plan_readiness(state="sign_in_required") == "needs_plan_sign_in"
    assert await plan_readiness(plan_use_granted=False) == "needs_plan_sign_in"
    # Without the local composition's session (hosted), a plan row cannot run.
    assert await readiness("owner", roles=_Roles(plan), llm_skip=False) == "needs_model"  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_a_database_without_the_settings_table_reads_the_defaults(async_session: AsyncSession) -> None:
    from sqlalchemy import text

    # A database created before the table: rename it inside a transaction that is rolled back.
    await async_session.execute(
        text("ALTER TABLE episode_processing_settings RENAME TO episode_processing_settings_gone")
    )
    try:
        assert await SQLAlchemyEpisodeProcessingSettingsRepository(async_session).get(user_id="owner") == (None, None)
        # The savepoint kept the outer transaction usable.
        assert (await async_session.execute(text("SELECT 1"))).scalar_one() == 1
    finally:
        await async_session.rollback()

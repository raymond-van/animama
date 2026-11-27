"""Automatic episode processing for the local composition (spec #775, R5–R9 and R11).

One task, started by the application lifespan, runs the Memory Manager's episode
processing for the installation owner once enough ``remember`` notes are pending.
The local chat-turn lease wakes it after each turn, once the turn's note is saved;
settings changes wake it too, and otherwise it rests until its next backoff ends,
at most ``EPISODE_PROCESSING_REST_SECONDS``. It never runs inside a chat turn, and
nothing on the turn path waits for it.

A run starts only while the owner's threshold is on, App Settings memory and memory
updates are on, a usable Memory Manager model is configured and no backoff, pause or
daily limit applies. Those limits come from the stored automatic runs, so they hold
across restarts.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from animama.adapters.repositories.sqlalchemy.memory_episode_repo import SQLAlchemyMemoryEpisodeRepository
from animama.adapters.repositories.sqlalchemy.memory_manager_repo import SQLAlchemyMemoryManagerRepository
from animama.adapters.repositories.sqlalchemy.settings_repo import SQLAlchemyUserSettingsRepository
from animama.app.services.memory_manager_service import (
    AUTOMATIC_COMPLETION_INTERRUPTED,
    SOURCE_DELETED_COMPLETION,
    AutomaticEpisodeProcessingOutcome,
    MemoryManagerService,
)
from animama.domain.memory_episode import MEMORY_EPISODE_STATUS_PENDING
from animama.domain.memory_manager import (
    MEMORY_MANAGER_RUN_STATUS_ACTIVE,
    MEMORY_MANAGER_RUN_STATUS_COMPLETED,
    MEMORY_MANAGER_RUN_STATUS_FAILED,
    MEMORY_MANAGER_RUN_STATUS_WAITING_APPROVAL,
    MemoryManagerEpisodeTaskState,
    MemoryManagerRun,
)
from animama.domain.settings import preferred_time_zone
from animama.local.installation_repository import SQLAlchemyEpisodeProcessingSettingsRepository
from animama.logging import get_logger

# The owner's threshold: Off (0) or MIN..MAX pending notes; DEFAULT when never set.
EPISODE_PROCESSING_DEFAULT_THRESHOLD = 10
EPISODE_PROCESSING_MIN_THRESHOLD = 5
EPISODE_PROCESSING_MAX_THRESHOLD = 50
EPISODE_PROCESSING_OFF = 0
# Cost bounds (R8): at most this many automatic runs start per local day, a failure
# waits 1 hour doubling to 24 hours before the next attempt, and this many
# consecutive failures pause processing until a successful owner-started run or a
# threshold change.
EPISODE_PROCESSING_DAILY_RUN_LIMIT = 10
EPISODE_PROCESSING_PAUSE_AFTER_FAILURES = 3
EPISODE_PROCESSING_FIRST_BACKOFF = timedelta(hours=1)
EPISODE_PROCESSING_MAX_BACKOFF = timedelta(hours=24)
# The longest rest between passes when nothing wakes the task.
EPISODE_PROCESSING_REST_SECONDS = 300.0
# Enough history to count today's runs and the latest failures.
_RUN_HISTORY_LIMIT = EPISODE_PROCESSING_DAILY_RUN_LIMIT + EPISODE_PROCESSING_PAUSE_AFTER_FAILURES + 5
# Failed runs whose ending says nothing about processing itself.
_NOT_FAILURES = frozenset({AUTOMATIC_COMPLETION_INTERRUPTED, SOURCE_DELETED_COMPLETION})

EpisodeProcessingState = Literal[
    "off",
    "memory_off",
    "needs_model",
    "needs_plan_agreement",
    "needs_plan_sign_in",
    "plan_paused",
    "running",
    "paused",
    "backing_off",
    "waiting",
    "ready",
]

ModelReadiness = Literal["usable", "needs_model", "needs_plan_agreement", "needs_plan_sign_in", "plan_paused"]
"""Whether the Memory Manager's model may run work that starts by itself, and if not, why."""

MemoryManagerFactory = Callable[[AsyncSession, str], Awaitable[MemoryManagerService]]
"""Build the owner's Memory Manager service on a session."""

ModelCheck = Callable[[AsyncSession, str], Awaitable[ModelReadiness]]
"""Whether the owner's Memory Manager model may run automatic work: a tool-capable model whose key is
present, or a ChatGPT plan model the owner agreed to and that no usage limit paused (spec #919 D5, D6)."""

_STATE_ATTR = "automatic_episode_processing_worker"
_log = get_logger("server.episode_processing")


@dataclass(frozen=True, slots=True)
class EpisodeProcessingStatus:
    """What automatic processing will do next, as the setting and the chat show it.

    ``state`` is ``off``, ``memory_off`` (App Settings memory or memory updates off),
    ``needs_model``, ``needs_plan_agreement``, ``needs_plan_sign_in`` or ``plan_paused``
    (a ChatGPT plan model without the owner's agreement, whose sign-in or plan use
    needs attention, or after a usage limit), ``running``, ``paused``
    (after repeated failures),
    ``backing_off`` (after a failure, or at the daily limit, until ``next_attempt_at``),
    ``waiting`` (fewer than ``threshold`` notes pending) or ``ready``.
    """

    threshold: int
    state: EpisodeProcessingState
    pending_count: int
    runs_today: int
    last_error: str | None = None
    next_attempt_at: datetime | None = None
    batch_size: int | None = None
    started_at: datetime | None = None


class AutomaticEpisodeProcessingWorker:
    """Start the owner's automatic episode-processing runs when their conditions hold."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        owner_id: str,
        memory_manager: MemoryManagerFactory,
        model_usable: ModelCheck,
        clock: Callable[[], datetime] | None = None,
        rest_seconds: float = EPISODE_PROCESSING_REST_SECONDS,
    ) -> None:
        self._session_factory = session_factory
        self._owner_id = owner_id
        self._memory_manager = memory_manager
        self._model_usable = model_usable
        self._clock = clock or (lambda: datetime.now(UTC))
        self._rest_seconds = rest_seconds
        self._wake = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._recovered = False

    @property
    def owner_id(self) -> str:
        return self._owner_id

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="automatic-episode-processing")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    def wake(self) -> None:
        """Check now, for example after a chat turn saved its note or a setting changed."""

        self._wake.set()

    async def recover(self) -> int:
        """Close automatic runs an earlier process left open; return how many."""

        async with self._session_factory() as session:
            service = await self._memory_manager(session, self._owner_id)
            return await service.fail_interrupted_automatic_runs(user_id=self._owner_id)

    async def status(self) -> EpisodeProcessingStatus:
        """Evaluate the conditions without starting anything."""

        async with self._session_factory() as session:
            return await self._evaluate(session)

    async def run_pass(self) -> AutomaticEpisodeProcessingOutcome | None:
        """Start one run when the conditions hold; return its outcome, or None when none started."""

        async with self._session_factory() as session:
            status = await self._evaluate(session)
            if status.state != "ready":
                return None
            service = await self._memory_manager(session, self._owner_id)
            return await service.run_automatic_episode_processing(user_id=self._owner_id)

    async def _evaluate(self, session: AsyncSession) -> EpisodeProcessingStatus:
        stored_threshold, reset_at = await SQLAlchemyEpisodeProcessingSettingsRepository(session).get(
            user_id=self._owner_id
        )
        threshold = EPISODE_PROCESSING_DEFAULT_THRESHOLD if stored_threshold is None else stored_threshold
        settings = await SQLAlchemyUserSettingsRepository(session).get(self._owner_id)
        preferences = dict(getattr(settings, "preferences", None) or {})
        pending_count = await SQLAlchemyMemoryEpisodeRepository(session).count_items(
            user_id=self._owner_id, status=MEMORY_EPISODE_STATUS_PENDING
        )
        runs_repo = SQLAlchemyMemoryManagerRepository(session)
        history = await runs_repo.list_automatic_runs(user_id=self._owner_id, limit=_RUN_HISTORY_LIMIT)
        now = self._clock()
        zone, _zone_name = preferred_time_zone(preferences)
        local_midnight = datetime.combine(now.astimezone(zone).date(), datetime.min.time(), tzinfo=zone)
        runs_today = sum(1 for run in history if (_started_at(run) or now) >= local_midnight)
        base = EpisodeProcessingStatus(
            threshold=threshold, state="ready", pending_count=pending_count, runs_today=runs_today
        )

        # A run in flight finishes and stays visible even after the owner turns processing off.
        open_run = next((run for run in history if run.status in _OPEN_STATUSES), None)
        if open_run is not None:
            task = _task_state(open_run)
            return replace(
                base,
                state="running",
                batch_size=task.batch_size if task is not None else None,
                started_at=_utc(task.started_at) if task is not None else None,
            )
        if threshold == EPISODE_PROCESSING_OFF:
            return replace(base, state="off")
        raw_memory = preferences.get("memory")
        memory: dict[str, Any] = raw_memory if isinstance(raw_memory, dict) else {}
        if memory.get("disable_influence") is True or memory.get("disable_updates") is True:
            return replace(base, state="memory_off")
        readiness = await self._model_usable(session, self._owner_id)
        if readiness != "usable":
            return replace(base, state=readiness)

        owner_success = await runs_repo.latest_processed_owner_episode_run(user_id=self._owner_id)
        owner_task = _task_state(owner_success) if owner_success is not None else None
        boundary = max(
            (moment for moment in (_utc(reset_at), _utc(owner_task.processed_at) if owner_task else None) if moment),
            default=None,
        )
        failures = _consecutive_failures(history, since=boundary)
        if failures:
            last_failure = failures[0]
            last_error = last_failure.error
            if len(failures) >= EPISODE_PROCESSING_PAUSE_AFTER_FAILURES:
                return replace(base, state="paused", last_error=last_error)
            backoff = min(
                EPISODE_PROCESSING_FIRST_BACKOFF * 2 ** (len(failures) - 1),
                EPISODE_PROCESSING_MAX_BACKOFF,
            )
            next_attempt = (_utc(last_failure.completed_at) or now) + backoff
            if now < next_attempt:
                return replace(base, state="backing_off", last_error=last_error, next_attempt_at=next_attempt)
            base = replace(base, last_error=last_error)
        if runs_today >= EPISODE_PROCESSING_DAILY_RUN_LIMIT:
            # Not a failure retry, so no error; reported in UTC, like every timestamp in the status.
            return replace(
                base, state="backing_off", last_error=None, next_attempt_at=_utc(local_midnight + timedelta(days=1))
            )
        if pending_count < threshold:
            return replace(base, state="waiting")
        return base

    async def _run(self) -> None:
        while True:
            outcome: AutomaticEpisodeProcessingOutcome | None = None
            try:
                if not self._recovered:
                    # Retried on later passes if the database was not ready at startup.
                    closed = await self.recover()
                    self._recovered = True
                    if closed:
                        _log.info("Closed interrupted automatic episode-processing runs", count=closed)
                outcome = await self.run_pass()
            except Exception as exc:
                # Never let one pass end the task; the stored runs decide the next attempt.
                _log.warning("Automatic episode-processing pass failed", error_type=exc.__class__.__name__)
            if outcome is not None and outcome.status == "completed":
                # A backlog continues right away, within the daily limit.
                await asyncio.sleep(0)
                continue
            await self._rest()

    async def _rest(self) -> None:
        seconds = self._rest_seconds
        with suppress(Exception):
            status = await self.status()
            if status.next_attempt_at is not None:
                until = (status.next_attempt_at - self._clock()).total_seconds()
                seconds = max(1.0, min(seconds, until))
        with suppress(TimeoutError):
            await asyncio.wait_for(self._wake.wait(), timeout=seconds)
        self._wake.clear()


_OPEN_STATUSES = frozenset({MEMORY_MANAGER_RUN_STATUS_ACTIVE, MEMORY_MANAGER_RUN_STATUS_WAITING_APPROVAL})


def _utc(moment: datetime | None) -> datetime | None:
    """Return ``moment`` in UTC, treating naive timestamps (written by ``naive_utc_now()``) as UTC."""

    if moment is None:
        return None
    return moment.astimezone(UTC) if moment.tzinfo is not None else moment.replace(tzinfo=UTC)


def _task_state(run: MemoryManagerRun) -> MemoryManagerEpisodeTaskState | None:
    if run.task_state is None:
        return None
    try:
        return MemoryManagerEpisodeTaskState.from_dict(run.task_state)
    except ValueError:
        return None


def _started_at(run: MemoryManagerRun) -> datetime | None:
    task = _task_state(run)
    return _utc(task.started_at) if task is not None else _utc(run.created_at)


def _consecutive_failures(history: list[MemoryManagerRun], *, since: datetime | None) -> list[MemoryManagerRun]:
    """Return the newest failed automatic runs back to the last success or ``since``, newest first.

    Interrupted runs (a closed app or a restart) and runs a chat or Anima delete
    ended neither count nor end the streak.
    """

    failures: list[MemoryManagerRun] = []
    for run in history:
        started = _started_at(run)
        if since is not None and started is not None and started < since:
            break
        if run.status == MEMORY_MANAGER_RUN_STATUS_COMPLETED:
            break
        if run.status != MEMORY_MANAGER_RUN_STATUS_FAILED:
            continue
        if dict(run.metadata or {}).get("completion_reason") in _NOT_FAILURES:
            continue
        failures.append(run)
    return failures


def start_automatic_episode_processing(
    app: Any,
    *,
    session_factory: async_sessionmaker[AsyncSession],
    owner_id: str,
    memory_manager: MemoryManagerFactory,
    model_usable: ModelCheck,
) -> AutomaticEpisodeProcessingWorker:
    worker = AutomaticEpisodeProcessingWorker(
        session_factory, owner_id=owner_id, memory_manager=memory_manager, model_usable=model_usable
    )
    setattr(app.state, _STATE_ATTR, worker)
    worker.start()
    return worker


async def stop_automatic_episode_processing(app: Any) -> None:
    worker = get_automatic_episode_processing_worker(app)
    if worker is not None:
        await worker.stop()


def wake_automatic_episode_processing(app: Any) -> None:
    """Check now; call after a local chat turn or a settings change."""

    worker = get_automatic_episode_processing_worker(app)
    if worker is not None:
        worker.wake()


def get_automatic_episode_processing_worker(app: Any) -> AutomaticEpisodeProcessingWorker | None:
    worker = getattr(app.state, _STATE_ATTR, None)
    return worker if isinstance(worker, AutomaticEpisodeProcessingWorker) else None


__all__ = [
    "EPISODE_PROCESSING_DAILY_RUN_LIMIT",
    "EPISODE_PROCESSING_DEFAULT_THRESHOLD",
    "EPISODE_PROCESSING_FIRST_BACKOFF",
    "EPISODE_PROCESSING_MAX_BACKOFF",
    "EPISODE_PROCESSING_MAX_THRESHOLD",
    "EPISODE_PROCESSING_MIN_THRESHOLD",
    "EPISODE_PROCESSING_OFF",
    "EPISODE_PROCESSING_PAUSE_AFTER_FAILURES",
    "AutomaticEpisodeProcessingWorker",
    "EpisodeProcessingStatus",
    "get_automatic_episode_processing_worker",
    "start_automatic_episode_processing",
    "stop_automatic_episode_processing",
    "wake_automatic_episode_processing",
]

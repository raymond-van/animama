"""Manual memory-manager chat workflow and approval commit orchestration."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, Literal, NoReturn

from animama.app.model_clients.context_budget import estimate_text_tokens
from animama.app.ports.anima_memory_reflection_port import AnimaMemoryReflectionRepository
from animama.app.ports.chat_message_port import ChatMessageRepository
from animama.app.ports.memory_manager_port import MemoryManagerRepository, MemoryManagerRepositoryConflictError
from animama.app.ports.memory_manager_runtime import (
    MEMORY_MANAGER_RUNTIME_OUTCOME_BLOCKED,
    MEMORY_MANAGER_RUNTIME_OUTCOME_COMPLETED,
    MEMORY_MANAGER_RUNTIME_OUTCOME_FAILED,
    MEMORY_MANAGER_RUNTIME_OUTCOME_WAITING_APPROVAL,
    MEMORY_MANAGER_RUNTIME_OUTCOMES,
    MemoryManagerPinnedModelUnavailableError,
    MemoryManagerRuntime,
    MemoryManagerRuntimeApprovalRequest,
    MemoryManagerRuntimeError,
    MemoryManagerRuntimeResult,
)
from animama.app.ports.uow_port import UnitOfWork
from animama.domain.chat import AnimaHistoryTurn
from animama.domain.memory_entry import MEMORY_ENTRY_TYPE_FILE, MemoryEntry
from animama.domain.memory_manager import (
    MEMORY_MANAGER_APPROVAL_STATUS_APPROVED,
    MEMORY_MANAGER_APPROVAL_STATUS_PENDING,
    MEMORY_MANAGER_APPROVAL_STATUS_REJECTED,
    MEMORY_MANAGER_APPROVAL_STATUSES,
    MEMORY_MANAGER_EPISODE_TASK_STATUS_PROCESSED,
    MEMORY_MANAGER_EPISODE_TASK_STATUS_PROCESSING,
    MEMORY_MANAGER_MESSAGE_ROLE_ASSISTANT,
    MEMORY_MANAGER_MESSAGE_ROLE_USER,
    MEMORY_MANAGER_RUN_KIND_EPISODE_PROCESSING,
    MEMORY_MANAGER_RUN_KIND_GENERAL,
    MEMORY_MANAGER_RUN_KIND_REFLECTION,
    MEMORY_MANAGER_RUN_ORIGIN_AUTOMATIC,
    MEMORY_MANAGER_RUN_ORIGIN_KEY,
    MEMORY_MANAGER_RUN_STATUS_ACTIVE,
    MEMORY_MANAGER_RUN_STATUS_COMPLETED,
    MEMORY_MANAGER_RUN_STATUS_FAILED,
    MEMORY_MANAGER_RUN_STATUS_WAITING_APPROVAL,
    MEMORY_PATCH_OPERATION_CREATE,
    MEMORY_PATCH_OPERATION_UPDATE,
    AnimaMemoryReflection,
    MemoryManagerApproval,
    MemoryManagerApprovalUndoResult,
    MemoryManagerEpisodeTaskItem,
    MemoryManagerEpisodeTaskState,
    MemoryManagerMessage,
    MemoryManagerReflectionTaskState,
    MemoryManagerRun,
    MemoryManagerRunSnapshot,
    format_turn_count,
    memory_manager_run_is_automatic,
    new_memory_manager_approval_id,
    new_memory_manager_message_id,
    new_memory_manager_run_id,
    shorten_reflection_turn_text,
)
from animama.logging import get_logger
from animama.utils.clock import naive_utc_now

from .anima_identity_memory import AnimaManagerPath, manager_file_access_for_run, parse_anima_manager_path
from .memory_entry_service import (
    MemoryEntryConflictError,
    MemoryEntryNotFoundError,
    MemoryEntryProtectedError,
    MemoryEntryService,
    MemoryEntryValidationError,
    is_anima_identity,
    is_anima_memories,
    is_protected_memory_entry,
    is_protected_memory_path,
    normalize_memory_file_path,
)
from .memory_episode_service import MemoryEpisodeConflictError, MemoryEpisodeService

_MEMORY_MANAGER_MESSAGE_MAX_CHARS = 4000
_MAX_AUTO_APPROVALS_PER_MESSAGE = 8
_USER_MEMORY_KIND = "user_memory"
_USAGE_COUNTER_KEYS = frozenset({"requests", "input_tokens", "output_tokens", "total_tokens"})
_SUPERSEDED_COMPLETION_REASON = "superseded_by_new_run"
_EPISODE_PROCESSING_BATCH_SIZE = 50
# How an automatic run ended (run metadata "completion_reason") and why a proposal it
# left was closed unapplied (approval operation_metadata "closed_reason").
AUTOMATIC_COMPLETION_PROCESSED = "automatic_processed"
AUTOMATIC_COMPLETION_CLOSED = "automatic_closed"
AUTOMATIC_COMPLETION_INTERRUPTED = "automatic_interrupted"
# The change provenance of versions an automatic run writes (spec #775, R10).
AUTOMATIC_EPISODE_PROCESSING_TRIGGER = "automatic_episode_processing"
_AUTOMATIC_PROCESSING_IN_PROGRESS = "Automatic memory processing is in progress; try again shortly"
# Safety cap on the turns one Reflection reads; later turns wait for the next Reflection.
REFLECTION_MAX_TURNS = 400
# Budget for the turn text one Reflection reads, in estimated tokens (estimate_text_tokens), counted
# after each side is shortened past REFLECTION_TURN_TEXT_MAX_CHARS. It admits every ASCII batch the
# former 200,000-character budget did, rounding included: a maximal English turn reads 4,000 characters,
# 1,002 tokens, so a full page of 50 fits. Japanese or Chinese text costs about one token per character,
# so its batches hold about a quarter as many long turns.
REFLECTION_MAX_BATCH_TOKENS = 51_000
_REJECTION_FEEDBACK_MAX_CHARS = 2000


class MemoryManagerError(Exception):
    """Base class for memory-manager service errors."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class MemoryManagerValidationError(MemoryManagerError):
    """Raised when a manager request is invalid."""


class MemoryManagerNotFoundError(MemoryManagerError):
    """Raised when a run or approval is not visible to the current user."""


class MemoryManagerConflictError(MemoryManagerError):
    """Raised when a manager state transition is not allowed."""


AutomaticEpisodeProcessingStatus = Literal["completed", "failed", "skipped"]


@dataclass(frozen=True, slots=True)
class AutomaticEpisodeProcessingOutcome:
    """The result of one backend-started episode-processing attempt.

    ``reason`` names why a run was skipped (``no_pending_episodes``,
    ``owner_processing_in_progress`` or ``automatic_run_open``) or holds a failed
    run's error.
    """

    status: AutomaticEpisodeProcessingStatus
    run_id: str | None = None
    batch_size: int = 0
    reason: str | None = None


class MemoryManagerService:
    """Use-case service for memory-manager runs, approvals, and commits."""

    def __init__(
        self,
        *,
        memory_manager: MemoryManagerRepository,
        memory_entries: MemoryEntryService,
        memory_episodes: MemoryEpisodeService | None = None,
        chat_messages: ChatMessageRepository | None = None,
        anima_reflections: AnimaMemoryReflectionRepository | None = None,
        runtime: MemoryManagerRuntime,
        uow: UnitOfWork,
        commit_on_write: bool = True,
    ) -> None:
        """``chat_messages`` and ``anima_reflections`` enable Reflection runs."""

        self._memory_manager = memory_manager
        self._memory_entries = memory_entries
        self._memory_episodes = memory_episodes
        self._chat_messages = chat_messages
        self._anima_reflections = anima_reflections
        self._runtime = runtime
        self._uow = uow
        self._commit_on_write = commit_on_write
        self._log = get_logger("app.services.memory_manager")

    async def create_run(
        self,
        *,
        user_id: str,
        initial_message: str | None = None,
        auto_approve_diffs: bool = False,
        metadata: dict[str, object] | None = None,
    ) -> MemoryManagerRunSnapshot:
        """Create a manual memory-manager run and optionally submit its first message."""

        try:
            open_runs = await self._memory_manager.list_open_runs_for_update(user_id=user_id)
            if any(run.status == MEMORY_MANAGER_RUN_STATUS_WAITING_APPROVAL for run in open_runs):
                raise MemoryManagerConflictError("Resolve the pending memory approval before starting a new run")

            await self._supersede_open_runs(open_runs)

            run = MemoryManagerRun(
                id=new_memory_manager_run_id(),
                user_id=user_id,
                status=MEMORY_MANAGER_RUN_STATUS_ACTIVE,
                kind=MEMORY_MANAGER_RUN_KIND_GENERAL,
                model_provider_id=self._runtime.model_provider_id,
                # The origin is backend-owned: a caller cannot mark its own run automatic.
                metadata={
                    **{key: value for key, value in (metadata or {}).items() if key != MEMORY_MANAGER_RUN_ORIGIN_KEY},
                    "runtime": self._runtime.name,
                },
            )
            stored = await self._memory_manager.create_run(run)
            await self._commit_if_enabled()
        except MemoryManagerRepositoryConflictError as exc:
            await self._rollback_if_enabled()
            raise MemoryManagerConflictError(
                "Another memory manager run is already open; reload and continue it"
            ) from exc
        except Exception:
            await self._rollback_if_enabled()
            raise
        self._log.info("MemoryManagerService.create_run.created", user_id=user_id, run_id=stored.id)
        if initial_message is not None and initial_message.strip():
            return await self.append_user_message(
                user_id=user_id,
                run_id=stored.id,
                content=initial_message,
                auto_approve_diffs=auto_approve_diffs,
            )
        return await self.get_run_snapshot(user_id=user_id, run_id=stored.id)

    async def create_episode_processing_run(
        self,
        *,
        user_id: str,
        auto_approve_diffs: bool = False,
    ) -> MemoryManagerRunSnapshot:
        """Create and execute one backend-owned fixed episode review batch."""

        if self._memory_episodes is None:
            raise MemoryManagerValidationError("Episode processing is not configured")
        try:
            open_runs = await self._memory_manager.list_open_runs_for_update(user_id=user_id)
            if any(run.status == MEMORY_MANAGER_RUN_STATUS_WAITING_APPROVAL for run in open_runs):
                raise MemoryManagerConflictError("Resolve the pending memory approval before processing episodes")
            # An automatic run holds its own batch; selecting now would review the same notes
            # twice. The selection lock makes this check see an automatic run created meanwhile.
            await self._memory_episodes.lock_batch_selection(user_id=user_id)
            if await self._memory_manager.list_open_automatic_runs(user_id=user_id):
                raise MemoryManagerConflictError(_AUTOMATIC_PROCESSING_IN_PROGRESS)

            task = await self._select_episode_batch(user_id=user_id)
            if task is None:
                raise MemoryManagerConflictError("No pending episodes are available to process")

            await self._supersede_open_runs(open_runs)

            run = MemoryManagerRun(
                id=new_memory_manager_run_id(),
                user_id=user_id,
                status=MEMORY_MANAGER_RUN_STATUS_ACTIVE,
                kind=MEMORY_MANAGER_RUN_KIND_EPISODE_PROCESSING,
                task_state=task.to_dict(),
                model_provider_id=self._runtime.model_provider_id,
                metadata={"runtime": self._runtime.name},
            )
            stored = await self._memory_manager.create_run(run)
            await self._commit_if_enabled()
        except MemoryManagerRepositoryConflictError as exc:
            await self._rollback_if_enabled()
            raise MemoryManagerConflictError(
                "Another memory manager run is already open; reload and continue it"
            ) from exc
        except Exception:
            await self._rollback_if_enabled()
            raise

        self._log.info(
            "MemoryManagerService.create_episode_processing_run.created",
            user_id=user_id,
            run_id=stored.id,
            batch_size=task.batch_size,
            has_more=task.has_more,
        )
        return await self.append_user_message(
            user_id=user_id,
            run_id=stored.id,
            content=f"Process {task.batch_size} pending episodes.",
            auto_approve_diffs=auto_approve_diffs,
        )

    async def create_reflection_run(
        self,
        *,
        user_id: str,
        anima_id: str,
        auto_approve_diffs: bool = False,
        timezone: str = "UTC",
    ) -> MemoryManagerRunSnapshot:
        """Start a Reflection over one owned Anima's oldest uncovered chat turns.

        Like other runs it supersedes the open run and is refused while an
        approval is pending. When no turn is uncovered it creates nothing. The
        batch stops at ``REFLECTION_MAX_TURNS`` turns or ``REFLECTION_MAX_BATCH_TOKENS``
        of turn text, whichever comes first, and always holds at least one
        turn. ``timezone`` is the owner's IANA zone for showing turn times.
        """

        if self._chat_messages is None or self._anima_reflections is None:
            raise MemoryManagerValidationError("Reflection is not configured")
        try:
            anima = next(
                (
                    summary
                    for summary in await self._memory_entries.list_anima_identities(user_id=user_id)
                    if summary.anima_id == anima_id
                ),
                None,
            )
            if anima is None:
                raise MemoryManagerNotFoundError("Anima not found")
            anima_name = anima.display_name.strip() or "this Anima"

            open_runs = await self._memory_manager.list_open_runs_for_update(user_id=user_id)
            if any(run.status == MEMORY_MANAGER_RUN_STATUS_WAITING_APPROVAL for run in open_runs):
                raise MemoryManagerConflictError("Resolve the pending memory approval before reflecting")
            if anima.memories is None:
                raise MemoryManagerConflictError(f"{anima_name}'s MEMORIES.md is missing; repair it before reflecting")

            coverage = await self._anima_reflections.get(user_id=user_id, anima_id=anima_id)
            covered_after = coverage.covered_through if coverage is not None else None
            batch = await self._chat_messages.select_reflection_batch(
                user_id=user_id,
                anima_id=anima_id,
                after=covered_after,
                max_turns=REFLECTION_MAX_TURNS,
            )
            turns: list[AnimaHistoryTurn] = []
            if batch.through is not None:
                # The token budget needs the text of the turn-capped batch.
                turns = _turns_within_token_budget(
                    await self._chat_messages.list_reflection_turns(
                        user_id=user_id,
                        anima_id=anima_id,
                        after=covered_after,
                        through=batch.through,
                        limit=batch.turn_count,
                    )
                )
            if not turns:
                raise MemoryManagerConflictError(f"There are no new turns with {anima_name} to reflect on")
            task = MemoryManagerReflectionTaskState(
                anima_id=anima_id,
                anima_name=anima_name,
                covered_after=covered_after,
                covered_after_run_id=coverage.run_id if coverage is not None else None,
                # A budget cut moves the boundary back to the last turn kept.
                covered_through=turns[-1].position,
                turn_count=len(turns),
                # Still counts every uncovered turn, so the remainder includes budget-cut turns.
                uncovered_turn_count=batch.uncovered_turn_count,
                started_at=datetime.now(UTC),
                timezone=timezone,
            )

            await self._supersede_open_runs(open_runs)
            stored = await self._memory_manager.create_run(
                MemoryManagerRun(
                    id=new_memory_manager_run_id(),
                    user_id=user_id,
                    status=MEMORY_MANAGER_RUN_STATUS_ACTIVE,
                    kind=MEMORY_MANAGER_RUN_KIND_REFLECTION,
                    task_state=task.to_dict(),
                    model_provider_id=self._runtime.model_provider_id,
                    metadata={"runtime": self._runtime.name},
                )
            )
            await self._commit_if_enabled()
        except MemoryManagerRepositoryConflictError as exc:
            await self._rollback_if_enabled()
            raise MemoryManagerConflictError(
                "Another memory manager run is already open; reload and continue it"
            ) from exc
        except Exception:
            await self._rollback_if_enabled()
            raise

        self._log.info(
            "MemoryManagerService.create_reflection_run.created",
            user_id=user_id,
            run_id=stored.id,
            anima_id=anima_id,
            turn_count=task.turn_count,
            remaining_turn_count=task.remaining_turn_count,
        )
        return await self.append_user_message(
            user_id=user_id,
            run_id=stored.id,
            content=f"Reflect on {format_turn_count(task.turn_count)} with {anima_name}.",
            auto_approve_diffs=auto_approve_diffs,
        )

    async def _select_episode_batch(self, *, user_id: str) -> MemoryManagerEpisodeTaskState | None:
        """Lock the oldest pending notes and build a fixed batch's task state, or None when none are pending."""

        assert self._memory_episodes is not None
        candidates = await self._memory_episodes.select_pending_batch_for_update(
            user_id=user_id,
            limit=_EPISODE_PROCESSING_BATCH_SIZE + 1,
        )
        if not candidates:
            return None
        selected = candidates[:_EPISODE_PROCESSING_BATCH_SIZE]
        return MemoryManagerEpisodeTaskState(
            status=MEMORY_MANAGER_EPISODE_TASK_STATUS_PROCESSING,
            items=tuple(
                MemoryManagerEpisodeTaskItem(
                    episode_item_id=item.id,
                    ref=f"E{index:02d}",
                )
                for index, item in enumerate(selected, start=1)
            ),
            has_more=len(candidates) > _EPISODE_PROCESSING_BATCH_SIZE,
            started_at=datetime.now(UTC),
        )

    async def run_automatic_episode_processing(self, *, user_id: str) -> AutomaticEpisodeProcessingOutcome:
        """Process the oldest pending notes in a backend-started run, approving its own proposals.

        The run never touches the owner's runs: one owner run and one automatic run may
        be open together. Each proposal is approved in its own transaction before the
        runtime resumes, so no file row stays locked during a model request. The run
        always closes: completed once its batch is processed, otherwise failed, with
        any proposal it could not apply closed unapplied and its notes left pending.
        """

        if self._memory_episodes is None:
            raise MemoryManagerValidationError("Episode processing is not configured")
        try:
            # The selection lock serializes this check against owner-started processing.
            # Nothing here locks an owner run, so a run that is mid-request never delays it.
            await self._memory_episodes.lock_batch_selection(user_id=user_id)
            if await self._memory_manager.list_open_automatic_runs(user_id=user_id):
                await self._rollback_if_enabled()
                return AutomaticEpisodeProcessingOutcome(status="skipped", reason="automatic_run_open")
            owner_runs = await self._memory_manager.list_open_runs(user_id=user_id)
            if any(_episode_task_is_processing(run) for run in owner_runs):
                await self._rollback_if_enabled()
                return AutomaticEpisodeProcessingOutcome(status="skipped", reason="owner_processing_in_progress")
            task = await self._select_episode_batch(user_id=user_id)
            if task is None:
                await self._rollback_if_enabled()
                return AutomaticEpisodeProcessingOutcome(status="skipped", reason="no_pending_episodes")
            stored = await self._memory_manager.create_run(
                MemoryManagerRun(
                    id=new_memory_manager_run_id(),
                    user_id=user_id,
                    status=MEMORY_MANAGER_RUN_STATUS_ACTIVE,
                    kind=MEMORY_MANAGER_RUN_KIND_EPISODE_PROCESSING,
                    task_state=task.to_dict(),
                    model_provider_id=self._runtime.model_provider_id,
                    metadata={
                        "runtime": self._runtime.name,
                        MEMORY_MANAGER_RUN_ORIGIN_KEY: MEMORY_MANAGER_RUN_ORIGIN_AUTOMATIC,
                    },
                )
            )
            await self._commit_if_enabled()
        except MemoryManagerRepositoryConflictError:
            # Another automatic run won the race, or a database created before the
            # origin-scoped indexes refuses a second open run.
            await self._rollback_if_enabled()
            return AutomaticEpisodeProcessingOutcome(status="skipped", reason="automatic_run_open")
        except Exception:
            await self._rollback_if_enabled()
            raise

        self._log.info(
            "MemoryManagerService.automatic_episode_processing.started",
            user_id=user_id,
            run_id=stored.id,
            batch_size=task.batch_size,
        )
        try:
            stop_error = await self._process_automatic_run(
                user_id=user_id, run_id=stored.id, batch_size=task.batch_size
            )
        except Exception as exc:
            # Whatever went wrong, the run must close so it never blocks later processing.
            await self._rollback_if_enabled()
            self._log.exception(
                "MemoryManagerService.automatic_episode_processing.error", user_id=user_id, run_id=stored.id
            )
            stop_error = (
                exc.detail
                if isinstance(exc, MemoryManagerError)
                else f"Automatic processing failed ({type(exc).__name__})"
            )
        return await self._close_automatic_run(
            user_id=user_id,
            run_id=stored.id,
            batch_size=task.batch_size,
            stop_error=stop_error,
        )

    async def _process_automatic_run(self, *, user_id: str, run_id: str, batch_size: int) -> str | None:
        """Send the batch message and approve each proposal; return why the chain stopped early, if it did."""

        await self.append_user_message(
            user_id=user_id,
            run_id=run_id,
            content=f"Process {batch_size} pending episodes.",
        )
        for _ in range(_MAX_AUTO_APPROVALS_PER_MESSAGE):
            snapshot = await self.get_run_snapshot(user_id=user_id, run_id=run_id)
            if snapshot.run.status != MEMORY_MANAGER_RUN_STATUS_WAITING_APPROVAL:
                return None
            pending = next(
                (item for item in snapshot.approvals if item.status == MEMORY_MANAGER_APPROVAL_STATUS_PENDING),
                None,
            )
            if pending is None:
                return None
            try:
                await self._approve_automatic_proposal(user_id=user_id, approval_id=pending.id)
            except MemoryManagerError as exc:
                return exc.detail
        snapshot = await self.get_run_snapshot(user_id=user_id, run_id=run_id)
        if any(item.status == MEMORY_MANAGER_APPROVAL_STATUS_PENDING for item in snapshot.approvals):
            return f"Automatic processing reached its limit of {_MAX_AUTO_APPROVALS_PER_MESSAGE} approvals"
        return None

    async def _approve_automatic_proposal(self, *, user_id: str, approval_id: str) -> None:
        """Commit one approval, then resume the runtime in a second transaction.

        A crash between the two leaves the run open with its change applied;
        ``fail_interrupted_automatic_runs`` closes it at the next startup.
        """

        try:
            decided, run, runtime = await self._apply_decision(
                user_id=user_id,
                approval_id=approval_id,
                status=MEMORY_MANAGER_APPROVAL_STATUS_APPROVED,
                feedback=None,
            )
            await self._commit_if_enabled()
        except Exception:
            await self._rollback_if_enabled()
            raise
        try:
            locked = await self._memory_manager.get_run_for_update(user_id=user_id, run_id=run.id)
            if locked is None:
                raise MemoryManagerNotFoundError("Memory manager run not found")
            # Recovery may have closed the run between the two transactions; never reopen it.
            if locked.status in {MEMORY_MANAGER_RUN_STATUS_COMPLETED, MEMORY_MANAGER_RUN_STATUS_FAILED}:
                raise MemoryManagerConflictError("Memory manager run is closed")
            await self._resume_after_decision(
                run=locked,
                approval=decided,
                runtime=runtime,
                decision="approve",
                feedback=None,
            )
            await self._commit_if_enabled()
        except Exception:
            await self._rollback_if_enabled()
            raise

    async def _close_automatic_run(
        self,
        *,
        user_id: str,
        run_id: str,
        batch_size: int,
        stop_error: str | None,
    ) -> AutomaticEpisodeProcessingOutcome:
        """Complete a processed automatic run, or fail it and close any proposal it left unapplied."""

        try:
            run = await self._memory_manager.get_run_for_update(user_id=user_id, run_id=run_id)
            if run is None:
                raise MemoryManagerNotFoundError("Memory manager run not found")
            processed = _episode_task_status(run) == MEMORY_MANAGER_EPISODE_TASK_STATUS_PROCESSED
            if processed and run.status == MEMORY_MANAGER_RUN_STATUS_ACTIVE:
                await self._memory_manager.update_run(
                    replace(
                        run,
                        status=MEMORY_MANAGER_RUN_STATUS_COMPLETED,
                        completed_at=naive_utc_now(),
                        metadata={**dict(run.metadata or {}), "completion_reason": AUTOMATIC_COMPLETION_PROCESSED},
                    )
                )
                await self._commit_if_enabled()
                self._log.info(
                    "MemoryManagerService.automatic_episode_processing.completed", user_id=user_id, run_id=run_id
                )
                return AutomaticEpisodeProcessingOutcome(status="completed", run_id=run_id, batch_size=batch_size)
            error = run.error if run.status == MEMORY_MANAGER_RUN_STATUS_FAILED else None
            error = error or stop_error or "Automatic processing stopped before it finished its batch"
            await self._fail_automatic_run(run, error=error, completion_reason=AUTOMATIC_COMPLETION_CLOSED)
            await self._commit_if_enabled()
        except Exception:
            await self._rollback_if_enabled()
            raise
        self._log.warning(
            "MemoryManagerService.automatic_episode_processing.failed", user_id=user_id, run_id=run_id, error=error
        )
        return AutomaticEpisodeProcessingOutcome(status="failed", run_id=run_id, batch_size=batch_size, reason=error)

    async def fail_interrupted_automatic_runs(self, *, user_id: str) -> int:
        """Close automatic runs left open by an earlier process; return how many were closed.

        Only the backend that starts automatic runs calls this, at startup, before it
        starts another. Applied changes stay; the notes stay pending for a later run.
        """

        try:
            runs = await self._memory_manager.list_open_automatic_runs(user_id=user_id, for_update=True)
            for run in runs:
                await self._fail_automatic_run(
                    run,
                    error="Automatic processing was interrupted",
                    completion_reason=AUTOMATIC_COMPLETION_INTERRUPTED,
                )
            await self._commit_if_enabled()
        except Exception:
            await self._rollback_if_enabled()
            raise
        return len(runs)

    async def _fail_automatic_run(self, run: MemoryManagerRun, *, error: str, completion_reason: str) -> None:
        """Close an automatic run as failed and its pending proposals as rejected, without resuming the runtime."""

        decided_at = naive_utc_now()
        approvals = await self._memory_manager.list_approvals_for_update(user_id=run.user_id, run_id=run.id)
        for approval in approvals:
            if approval.status != MEMORY_MANAGER_APPROVAL_STATUS_PENDING:
                continue
            await self._memory_manager.update_approval(
                replace(
                    approval,
                    status=MEMORY_MANAGER_APPROVAL_STATUS_REJECTED,
                    decided_at=decided_at,
                    operation_metadata={
                        **dict(approval.operation_metadata or {}),
                        "closed_reason": AUTOMATIC_COMPLETION_CLOSED,
                    },
                )
            )
        await self._memory_manager.update_run(
            replace(
                run,
                status=MEMORY_MANAGER_RUN_STATUS_FAILED,
                error=error,
                completed_at=decided_at,
                metadata={**dict(run.metadata or {}), "completion_reason": completion_reason},
            )
        )

    async def _supersede_open_runs(self, open_runs: list[MemoryManagerRun]) -> None:
        """Close locked open runs that a new run replaces; callers refuse pending approvals first."""

        superseded_at = naive_utc_now()
        for open_run in open_runs:
            await self._memory_manager.update_run(
                replace(
                    open_run,
                    status=MEMORY_MANAGER_RUN_STATUS_COMPLETED,
                    completed_at=superseded_at,
                    metadata={
                        **dict(open_run.metadata or {}),
                        "completion_reason": _SUPERSEDED_COMPLETION_REASON,
                    },
                )
            )

    async def get_current_run_snapshot(self, *, user_id: str) -> MemoryManagerRunSnapshot | None:
        """Return the user's one open run, or None when no run is active."""

        open_runs = await self._memory_manager.list_open_runs(user_id=user_id)
        if len(open_runs) > 1:
            raise MemoryManagerConflictError(
                "Multiple open memory manager runs were found; reset or repair the local database"
            )
        if not open_runs:
            return None
        return await self.get_run_snapshot(user_id=user_id, run_id=open_runs[0].id)

    async def get_run_snapshot(self, *, user_id: str, run_id: str) -> MemoryManagerRunSnapshot:
        """Return the current run with visible messages and approval rows."""

        run = await self._memory_manager.get_run(user_id=user_id, run_id=run_id)
        if run is None:
            raise MemoryManagerNotFoundError("Memory manager run not found")
        messages = await self._memory_manager.list_messages(user_id=user_id, run_id=run_id)
        approvals = await self._memory_manager.list_approvals(user_id=user_id, run_id=run_id)
        has_pending_approval = any(approval.status == MEMORY_MANAGER_APPROVAL_STATUS_PENDING for approval in approvals)
        projected_approvals = [
            replace(
                approval,
                can_undo=await self._can_undo_approval(
                    user_id=user_id,
                    approval=approval,
                    run_has_pending_approval=has_pending_approval,
                ),
            )
            for approval in approvals
        ]
        return MemoryManagerRunSnapshot(
            run=run,
            messages=messages,
            approvals=projected_approvals,
        )

    async def complete_run(self, *, user_id: str, run_id: str) -> MemoryManagerRunSnapshot:
        """Close an owned run after confirming no approval remains unresolved."""

        try:
            run = await self._memory_manager.get_run_for_update(user_id=user_id, run_id=run_id)
            if run is None:
                raise MemoryManagerNotFoundError("Memory manager run not found")
            if run.status in {MEMORY_MANAGER_RUN_STATUS_COMPLETED, MEMORY_MANAGER_RUN_STATUS_FAILED}:
                await self._commit_if_enabled()
                return await self.get_run_snapshot(user_id=user_id, run_id=run_id)

            approvals = await self._memory_manager.list_approvals(user_id=user_id, run_id=run_id)
            if any(item.status == MEMORY_MANAGER_APPROVAL_STATUS_PENDING for item in approvals):
                raise MemoryManagerConflictError("Resolve pending memory approvals before completing this run")

            await self._memory_manager.update_run(
                replace(
                    run,
                    status=MEMORY_MANAGER_RUN_STATUS_COMPLETED,
                    completed_at=naive_utc_now(),
                )
            )
            await self._commit_if_enabled()
        except Exception:
            await self._rollback_if_enabled()
            raise
        self._log.info("MemoryManagerService.complete_run.completed", user_id=user_id, run_id=run_id)
        return await self.get_run_snapshot(user_id=user_id, run_id=run_id)

    async def append_user_message(
        self,
        *,
        user_id: str,
        run_id: str,
        content: str,
        auto_approve_diffs: bool = False,
    ) -> MemoryManagerRunSnapshot:
        """Append one user request and run the configured manager runtime."""

        clean_content = self._normalize_message_content(content)
        try:
            run = await self._memory_manager.get_run_for_update(user_id=user_id, run_id=run_id)
            if run is None:
                raise MemoryManagerNotFoundError("Memory manager run not found")
            if run.status in {MEMORY_MANAGER_RUN_STATUS_COMPLETED, MEMORY_MANAGER_RUN_STATUS_FAILED}:
                raise MemoryManagerConflictError("Memory manager run is closed")
            if run.status == MEMORY_MANAGER_RUN_STATUS_WAITING_APPROVAL:
                approvals = await self._memory_manager.list_approvals(user_id=user_id, run_id=run.id)
                if any(item.status == MEMORY_MANAGER_APPROVAL_STATUS_PENDING for item in approvals):
                    raise MemoryManagerConflictError("Resolve pending memory approvals before sending another message")

            history = await self._memory_manager.list_messages(user_id=user_id, run_id=run.id)
            user_message = await self._memory_manager.create_message(
                MemoryManagerMessage(
                    id=new_memory_manager_message_id(),
                    run_id=run.id,
                    user_id=user_id,
                    role=MEMORY_MANAGER_MESSAGE_ROLE_USER,
                    content=clean_content,
                    metadata={"runtime": self._runtime.name},
                )
            )
            try:
                runtime_result = await self._runtime.run_user_message(
                    run=run,
                    user_message=user_message,
                    history=history,
                )
            except MemoryManagerRuntimeError as exc:
                runtime_result = self._runtime_failure_result(exc)
            await self._persist_runtime_result(
                run=run,
                result=runtime_result,
                source_message_id=user_message.id,
            )
            await self._commit_if_enabled()
        except Exception:
            await self._rollback_if_enabled()
            raise
        if auto_approve_diffs:
            await self._auto_approve_message_diffs(
                user_id=user_id,
                run_id=run_id,
                source_message_id=user_message.id,
            )
        return await self.get_run_snapshot(user_id=user_id, run_id=run_id)

    async def decide_approval(
        self,
        *,
        user_id: str,
        approval_id: str,
        decision: str,
        feedback: str | None = None,
    ) -> MemoryManagerApproval:
        """Approve or reject a pending memory-manager proposal."""

        status = self._status_for_decision(decision)
        clean_feedback = self._normalize_rejection_feedback(feedback)
        if status != MEMORY_MANAGER_APPROVAL_STATUS_REJECTED and clean_feedback is not None:
            raise MemoryManagerValidationError("Feedback is only allowed when rejecting an approval")
        try:
            stored, run, runtime = await self._apply_decision(
                user_id=user_id,
                approval_id=approval_id,
                status=status,
                feedback=clean_feedback,
            )
            await self._resume_after_decision(
                run=run,
                approval=stored,
                runtime=runtime,
                decision=decision.strip().lower(),
                feedback=clean_feedback,
            )
            await self._commit_if_enabled()
        except Exception:
            await self._rollback_if_enabled()
            raise
        self._log.info(
            "MemoryManagerService.decide_approval.updated",
            user_id=user_id,
            approval_id=approval_id,
            status=status,
        )
        snapshot = await self.get_run_snapshot(user_id=user_id, run_id=stored.run_id)
        return next(item for item in snapshot.approvals if item.id == stored.id)

    async def _apply_decision(
        self,
        *,
        user_id: str,
        approval_id: str,
        status: str,
        feedback: str | None,
    ) -> tuple[
        MemoryManagerApproval, MemoryManagerRun, MemoryManagerRuntime | MemoryManagerPinnedModelUnavailableError
    ]:
        """Lock one pending approval and its run, commit an approved patch and record the decision.

        Returns the decided approval, its run and the runtime that resumes it, or,
        for a rejection whose pinned model cannot resume, the error that says why.
        """

        approval = await self._memory_manager.get_approval_for_update(user_id=user_id, approval_id=approval_id)
        if approval is None:
            raise MemoryManagerNotFoundError("Memory manager approval not found")
        if approval.status != MEMORY_MANAGER_APPROVAL_STATUS_PENDING:
            raise MemoryManagerConflictError("Memory manager approval is already decided")
        run = await self._memory_manager.get_run_for_update(user_id=user_id, run_id=approval.run_id)
        if run is None:
            raise MemoryManagerNotFoundError("Memory manager run not found")
        # Resume on the model that proposed the change. Without it, an
        # approval changes nothing (the owner can restore the model or
        # reject), and a rejection ends the review without resuming.
        runtime: MemoryManagerRuntime | MemoryManagerPinnedModelUnavailableError
        try:
            runtime = await self._runtime.for_run(run)
        except MemoryManagerPinnedModelUnavailableError as exc:
            if status == MEMORY_MANAGER_APPROVAL_STATUS_APPROVED:
                raise MemoryManagerConflictError(exc.detail) from exc
            # A rejection still ends the review; the error says why it cannot resume.
            runtime = exc
        committed_entry_id = approval.target_entry_id
        applied_version = approval.applied_version
        if status == MEMORY_MANAGER_APPROVAL_STATUS_APPROVED:
            committed = await self._commit_approval_patch(user_id=user_id, approval=approval, run=run)
            committed_entry_id = committed.id
            applied_version = committed.version

        decided = replace(
            approval,
            status=status,
            target_entry_id=committed_entry_id,
            applied_version=applied_version,
            decision_feedback=feedback,
            decided_at=naive_utc_now(),
        )
        stored = await self._memory_manager.update_approval(decided)
        return stored, run, runtime

    async def _resume_after_decision(
        self,
        *,
        run: MemoryManagerRun,
        approval: MemoryManagerApproval,
        runtime: MemoryManagerRuntime | MemoryManagerPinnedModelUnavailableError,
        decision: str,
        feedback: str | None,
    ) -> None:
        """Resume the runtime with a recorded decision and persist its result."""

        try:
            if isinstance(runtime, MemoryManagerPinnedModelUnavailableError):
                runtime_result = self._pinned_model_gone_result(runtime.detail)
            else:
                runtime_result = await runtime.resume_approval_decision(
                    run=run,
                    approval=approval,
                    decision=decision,
                    feedback=feedback,
                )
        except MemoryManagerRuntimeError as exc:
            # The pinned row's runtime ran the resume, which may differ from the role's.
            runtime_name = None if isinstance(runtime, MemoryManagerPinnedModelUnavailableError) else runtime.name
            runtime_result = self._runtime_failure_result(exc, runtime_name=runtime_name)
        await self._persist_runtime_result(
            run=run,
            result=runtime_result,
            source_message_id=self._approval_source_message_id(approval),
        )

    async def undo_approval(
        self,
        *,
        user_id: str,
        approval_id: str,
    ) -> MemoryManagerApprovalUndoResult:
        """Append the one-level inverse of an eligible approved patch."""

        try:
            approval = await self._memory_manager.get_approval_for_update(
                user_id=user_id,
                approval_id=approval_id,
            )
            if approval is None:
                raise MemoryManagerNotFoundError("Memory manager approval not found")
            if approval.undone_at is not None or approval.undo_version is not None:
                if approval.undone_at is None or approval.undo_version is None or approval.target_entry_id is None:
                    raise MemoryManagerConflictError("Memory approval Undo state is incomplete")
                return self._approval_undo_result(approval)
            if approval.status != MEMORY_MANAGER_APPROVAL_STATUS_APPROVED:
                raise MemoryManagerConflictError("Only approved memory changes can be undone")
            if approval.target_entry_id is None or approval.applied_version is None:
                raise MemoryManagerConflictError("Approved memory change has no application Version")

            run = await self._memory_manager.get_run_for_update(
                user_id=user_id,
                run_id=approval.run_id,
            )
            if run is None:
                raise MemoryManagerNotFoundError("Memory manager run not found")
            run_approvals = await self._memory_manager.list_approvals_for_update(
                user_id=user_id,
                run_id=approval.run_id,
            )
            if any(item.status == MEMORY_MANAGER_APPROVAL_STATUS_PENDING for item in run_approvals):
                raise MemoryManagerConflictError("Resolve pending memory approvals before undoing this change")

            latest = await self._memory_manager.get_latest_approved_approval_for_entry(
                user_id=user_id,
                target_entry_id=approval.target_entry_id,
                for_update=True,
            )
            if latest is None or latest.id != approval.id:
                raise MemoryManagerConflictError("A newer approved change exists for this memory file")

            change_metadata = {
                "source_type": "memory_manager_approval_undo",
                "source_id": approval.id,
                "run_id": approval.run_id,
                "applied_version": approval.applied_version,
            }
            if approval.operation == MEMORY_PATCH_OPERATION_CREATE:
                entry = await self._memory_entries.undo_approved_create(
                    user_id=user_id,
                    entry_id=approval.target_entry_id,
                    expected_version=approval.applied_version,
                    change_metadata=change_metadata,
                )
                deleted = True
            elif approval.operation == MEMORY_PATCH_OPERATION_UPDATE:
                if approval.old_content is None:
                    raise MemoryManagerConflictError("Approved memory update has no prior content")
                # Identity Undo locks the Anima's current revision, like approval.
                entry = await self._memory_entries.undo_approved_update(
                    user_id=user_id,
                    entry_id=approval.target_entry_id,
                    expected_version=approval.applied_version,
                    old_content=approval.old_content,
                    old_description=approval.old_description,
                    change_metadata=change_metadata,
                    use_current_aggregate_revision=True,
                )
                deleted = False
                await self._restore_reflection_coverage(
                    run=run,
                    undone=approval,
                    entry=entry,
                    run_approvals=run_approvals,
                )
            else:
                raise MemoryManagerConflictError("This memory approval operation cannot be undone")

            stored = await self._memory_manager.update_approval(
                replace(
                    approval,
                    undone_at=naive_utc_now(),
                    undo_version=entry.version,
                    can_undo=False,
                )
            )
            await self._commit_if_enabled()
        except (MemoryEntryConflictError, MemoryEntryNotFoundError) as exc:
            await self._rollback_if_enabled()
            raise MemoryManagerConflictError(exc.detail) from exc
        except (MemoryEntryProtectedError, MemoryEntryValidationError) as exc:
            await self._rollback_if_enabled()
            raise MemoryManagerValidationError(exc.detail) from exc
        except Exception:
            await self._rollback_if_enabled()
            raise
        self._log.info(
            "MemoryManagerService.undo_approval.completed",
            user_id=user_id,
            approval_id=approval_id,
            undo_version=stored.undo_version,
        )
        return MemoryManagerApprovalUndoResult(
            approval=replace(stored, can_undo=False),
            target_entry_id=stored.target_entry_id or entry.id,
            undo_version=stored.undo_version or entry.version,
            deleted=deleted,
        )

    async def _can_undo_approval(
        self,
        *,
        user_id: str,
        approval: MemoryManagerApproval,
        run_has_pending_approval: bool,
    ) -> bool:
        """Project advisory Undo eligibility without replacing locked checks."""

        if (
            run_has_pending_approval
            or approval.status != MEMORY_MANAGER_APPROVAL_STATUS_APPROVED
            or approval.undone_at is not None
            or approval.undo_version is not None
            or approval.target_entry_id is None
            or approval.applied_version is None
            or approval.operation not in {MEMORY_PATCH_OPERATION_CREATE, MEMORY_PATCH_OPERATION_UPDATE}
        ):
            return False
        latest = await self._memory_manager.get_latest_approved_approval_for_entry(
            user_id=user_id,
            target_entry_id=approval.target_entry_id,
        )
        if latest is None or latest.id != approval.id:
            return False
        try:
            entry = await self._memory_entries.get_entry(
                user_id=user_id,
                entry_id=approval.target_entry_id,
            )
        except (MemoryEntryNotFoundError, MemoryEntryValidationError):
            return False
        return (
            entry.type == MEMORY_ENTRY_TYPE_FILE
            and not is_protected_memory_entry(entry)
            and entry.version == approval.applied_version
        )

    @staticmethod
    def _approval_undo_result(
        approval: MemoryManagerApproval,
    ) -> MemoryManagerApprovalUndoResult:
        """Return the durable result of an already-committed Undo."""

        if approval.target_entry_id is None or approval.undo_version is None:
            raise MemoryManagerConflictError("Memory approval Undo state is incomplete")
        return MemoryManagerApprovalUndoResult(
            approval=replace(approval, can_undo=False),
            target_entry_id=approval.target_entry_id,
            undo_version=approval.undo_version,
            deleted=approval.operation == MEMORY_PATCH_OPERATION_CREATE,
        )

    async def _auto_approve_message_diffs(
        self,
        *,
        user_id: str,
        run_id: str,
        source_message_id: str,
    ) -> None:
        """Approve one submitted message's durable patch chain within a safety bound."""

        approved_count = 0
        while approved_count < _MAX_AUTO_APPROVALS_PER_MESSAGE:
            snapshot = await self.get_run_snapshot(user_id=user_id, run_id=run_id)
            if snapshot.run.status != MEMORY_MANAGER_RUN_STATUS_WAITING_APPROVAL:
                return
            approval = self._next_pending_approval_for_message(
                approvals=snapshot.approvals,
                source_message_id=source_message_id,
            )
            if approval is None:
                return
            try:
                await self.decide_approval(
                    user_id=user_id,
                    approval_id=approval.id,
                    decision="approve",
                )
            except MemoryManagerError as exc:
                self._log.warning(
                    "MemoryManagerService.auto_approve.stopped",
                    user_id=user_id,
                    run_id=run_id,
                    approval_id=approval.id,
                    approved_count=approved_count,
                    error=exc.detail,
                )
                return
            approved_count += 1

        snapshot = await self.get_run_snapshot(user_id=user_id, run_id=run_id)
        if (
            self._next_pending_approval_for_message(
                approvals=snapshot.approvals,
                source_message_id=source_message_id,
            )
            is not None
        ):
            self._log.warning(
                "MemoryManagerService.auto_approve.limit_reached",
                user_id=user_id,
                run_id=run_id,
                source_message_id=source_message_id,
                approved_count=approved_count,
            )

    async def _persist_runtime_result(
        self,
        *,
        run: MemoryManagerRun,
        result: MemoryManagerRuntimeResult,
        source_message_id: str | None,
    ) -> MemoryManagerRun:
        approval_ids: list[str] = []
        existing_approvals = await self._memory_manager.list_approvals(user_id=run.user_id, run_id=run.id)
        existing_sdk_call_ids = self._sdk_call_ids(existing_approvals)
        for request in result.approvals or []:
            request_metadata = dict(request.operation_metadata or {})
            sdk_call_id = request_metadata.get("sdk_call_id")
            if isinstance(sdk_call_id, str) and sdk_call_id in existing_sdk_call_ids:
                continue
            approval = await self._memory_manager.create_approval(
                self._approval_from_runtime_request(
                    run=run,
                    request=request,
                    source_message_id=source_message_id,
                )
            )
            approval_ids.append(approval.id)
            if isinstance(sdk_call_id, str):
                existing_sdk_call_ids.add(sdk_call_id)

        assistant_message = (result.assistant_message or "").strip()
        if assistant_message:
            await self._memory_manager.create_message(
                MemoryManagerMessage(
                    id=new_memory_manager_message_id(),
                    run_id=run.id,
                    user_id=run.user_id,
                    role=MEMORY_MANAGER_MESSAGE_ROLE_ASSISTANT,
                    content=assistant_message,
                    metadata={
                        "runtime": self._runtime.name,
                        "approval_ids": approval_ids,
                        **dict(result.metadata or {}),
                    },
                )
            )

        approvals = await self._memory_manager.list_approvals(user_id=run.user_id, run_id=run.id)
        has_pending = any(item.status == MEMORY_MANAGER_APPROVAL_STATUS_PENDING for item in approvals)
        # The origin is backend-owned; a runtime result cannot change it.
        result_metadata = {
            key: value for key, value in (result.metadata or {}).items() if key != MEMORY_MANAGER_RUN_ORIGIN_KEY
        }
        result_model = result_metadata.get("model")
        result_provider = result_metadata.get("model_provider")
        # The row that ran this step proposed any new approval, so it becomes the pin.
        result_provider_id = result_metadata.get("model_provider_id")
        outcome = self._validated_runtime_outcome(result=result, has_pending=has_pending)
        failed = outcome in {MEMORY_MANAGER_RUNTIME_OUTCOME_BLOCKED, MEMORY_MANAGER_RUNTIME_OUTCOME_FAILED}
        next_status = (
            MEMORY_MANAGER_RUN_STATUS_FAILED
            if failed
            else MEMORY_MANAGER_RUN_STATUS_WAITING_APPROVAL
            if has_pending
            else MEMORY_MANAGER_RUN_STATUS_ACTIVE
        )
        stored_run = await self._memory_manager.update_run(
            replace(
                run,
                status=next_status,
                model_provider=result_provider if isinstance(result_provider, str) else run.model_provider,
                model_name=result_model if isinstance(result_model, str) else run.model_name,
                model_provider_id=(
                    result_provider_id if isinstance(result_provider_id, str) else run.model_provider_id
                ),
                # A step that kept no conversation leaves the cursor behind it; a failed run keeps it for recovery.
                openai_previous_response_id=(
                    (self._nonblank_string(result.openai_previous_response_id) or run.openai_previous_response_id)
                    if result.keeps_conversation_state or failed
                    else None
                ),
                serialized_agent_state=result.serialized_agent_state,
                summary=result.summary or run.summary,
                error=result.error or ("Memory manager execution was blocked" if failed else None),
                usage_metadata=self._merged_usage_metadata(run.usage_metadata, result.usage_metadata),
                metadata={
                    **dict(run.metadata or {}),
                    "runtime": self._runtime.name,
                    **result_metadata,
                },
                completed_at=naive_utc_now() if failed else None,
            )
        )
        if outcome == MEMORY_MANAGER_RUNTIME_OUTCOME_COMPLETED and not has_pending:
            stored_run = await self._finalize_episode_processing_run(stored_run)
        return stored_run

    def _approval_from_runtime_request(
        self,
        *,
        run: MemoryManagerRun,
        request: MemoryManagerRuntimeApprovalRequest,
        source_message_id: str | None,
    ) -> MemoryManagerApproval:
        operation_metadata = dict(request.operation_metadata or {})
        if source_message_id is not None:
            operation_metadata["source_message_id"] = source_message_id
        operation_metadata.setdefault("runtime", self._runtime.name)
        return MemoryManagerApproval(
            id=new_memory_manager_approval_id(),
            run_id=run.id,
            user_id=run.user_id,
            status=MEMORY_MANAGER_APPROVAL_STATUS_PENDING,
            operation=request.operation,
            target_path=request.target_path,
            target_entry_id=request.target_entry_id,
            expected_version=request.expected_version,
            summary=request.summary,
            old_content=request.old_content,
            new_content=request.new_content,
            old_description=request.old_description,
            new_description=request.new_description,
            unified_diff=request.unified_diff,
            operation_metadata=operation_metadata,
            decision_feedback=None,
        )

    async def _finalize_episode_processing_run(self, run: MemoryManagerRun) -> MemoryManagerRun:
        """Atomically close one fixed episode task after terminal runtime success."""

        if run.kind != MEMORY_MANAGER_RUN_KIND_EPISODE_PROCESSING:
            return run
        if self._memory_episodes is None:
            raise MemoryManagerValidationError("Episode processing is not configured")
        try:
            task = MemoryManagerEpisodeTaskState.from_dict(run.task_state)
        except ValueError as exc:
            raise MemoryManagerConflictError(str(exc)) from exc
        if task.status == MEMORY_MANAGER_EPISODE_TASK_STATUS_PROCESSED:
            return run

        approvals = await self._memory_manager.list_approvals(user_id=run.user_id, run_id=run.id)
        if any(item.status == MEMORY_MANAGER_APPROVAL_STATUS_PENDING for item in approvals):
            return run
        try:
            await self._memory_episodes.mark_items_processed(
                user_id=run.user_id,
                item_ids=[item.episode_item_id for item in task.items],
                processed_by_run_id=run.id,
            )
        except MemoryEpisodeConflictError as exc:
            raise MemoryManagerConflictError(exc.detail) from exc

        processed_task = MemoryManagerEpisodeTaskState(
            status=MEMORY_MANAGER_EPISODE_TASK_STATUS_PROCESSED,
            items=task.items,
            has_more=task.has_more,
            started_at=task.started_at,
            processed_at=datetime.now(UTC),
        )
        return await self._memory_manager.update_run(
            replace(
                run,
                status=MEMORY_MANAGER_RUN_STATUS_ACTIVE,
                task_state=processed_task.to_dict(),
                completed_at=None,
            )
        )

    @staticmethod
    def _sdk_call_ids(approvals: list[MemoryManagerApproval]) -> set[str]:
        call_ids: set[str] = set()
        for approval in approvals:
            sdk_call_id = dict(approval.operation_metadata or {}).get("sdk_call_id")
            if isinstance(sdk_call_id, str):
                call_ids.add(sdk_call_id)
        return call_ids

    @staticmethod
    def _approval_source_message_id(approval: MemoryManagerApproval) -> str | None:
        source_message_id = dict(approval.operation_metadata or {}).get("source_message_id")
        return source_message_id if isinstance(source_message_id, str) and source_message_id else None

    @classmethod
    def _next_pending_approval_for_message(
        cls,
        *,
        approvals: list[MemoryManagerApproval],
        source_message_id: str,
    ) -> MemoryManagerApproval | None:
        return next(
            (
                approval
                for approval in approvals
                if approval.status == MEMORY_MANAGER_APPROVAL_STATUS_PENDING
                and cls._approval_source_message_id(approval) == source_message_id
            ),
            None,
        )

    async def _commit_approval_patch(
        self,
        *,
        user_id: str,
        approval: MemoryManagerApproval,
        run: MemoryManagerRun,
    ) -> MemoryEntry:
        try:
            clean_path, anima_file = self._validate_approval_target_path(approval.target_path)
            change_metadata = self._approval_change_metadata(approval, run=run)
            if anima_file is not None:
                return await self._commit_anima_file_approval(
                    user_id=user_id,
                    approval=approval,
                    run=run,
                    anima_file=anima_file,
                    change_metadata=change_metadata,
                )
            access = manager_file_access_for_run(run)
            if not access.user_files_writable:
                raise MemoryEntryValidationError(access.denied_message(clean_path))
            if approval.operation == MEMORY_PATCH_OPERATION_CREATE:
                if approval.new_content is None:
                    raise MemoryEntryValidationError("Approved memory create is missing content")
                return await self._memory_entries.put_file_by_path(
                    user_id=user_id,
                    anima_id=None,
                    path=clean_path,
                    content=approval.new_content,
                    kind=_USER_MEMORY_KIND,
                    description=approval.new_description,
                    change_metadata=change_metadata,
                    expected_version=approval.expected_version,
                    create_parents=True,
                )

            if approval.operation == MEMORY_PATCH_OPERATION_UPDATE:
                if approval.new_content is None:
                    raise MemoryEntryValidationError("Approved memory update is missing content")
                current = await self._entry_for_update_approval(user_id=user_id, approval=approval)
                if current.path != clean_path:
                    raise MemoryEntryConflictError("Memory entry path changed after approval was created")
                return await self._memory_entries.patch_entry(
                    user_id=user_id,
                    entry_id=current.id,
                    expected_version=approval.expected_version,
                    content=approval.new_content,
                    content_set=True,
                    description=approval.new_description,
                    description_set=True,
                    change_metadata=change_metadata,
                )

            raise MemoryEntryValidationError("Memory manager approvals cannot delete memory files")
        except (MemoryEntryConflictError, MemoryEntryNotFoundError) as exc:
            raise MemoryManagerConflictError(exc.detail) from exc
        except MemoryEntryProtectedError as exc:
            raise MemoryManagerValidationError(exc.detail) from exc
        except MemoryEntryValidationError as exc:
            raise MemoryManagerValidationError(exc.detail) from exc

    async def _commit_anima_file_approval(
        self,
        *,
        user_id: str,
        approval: MemoryManagerApproval,
        run: MemoryManagerRun,
        anima_file: AnimaManagerPath,
        change_metadata: dict[str, Any],
    ) -> MemoryEntry:
        """Apply one reviewed update to the Anima file it was proposed for.

        The run's file scope is checked again here, so episode processing never
        changes an Anima file and a Reflection changes only its own Anima's
        ``MEMORIES.md``. The approval is fenced by the file's memory version, not
        the Anima's aggregate revision, so a rename between proposal and approval
        still applies while newer content conflicts. A Reflection's applied
        ``MEMORIES.md`` change also advances its Anima's coverage in the same
        transaction.
        """

        access = manager_file_access_for_run(run)
        if not access.allows(anima_file):
            if run.kind == MEMORY_MANAGER_RUN_KIND_EPISODE_PROCESSING:
                raise MemoryEntryValidationError("Episode processing cannot change Anima files")
            raise MemoryEntryValidationError(access.denied_message(anima_file.path))
        if approval.operation != MEMORY_PATCH_OPERATION_UPDATE or approval.new_content is None:
            raise MemoryEntryValidationError("Memory Manager can only update existing Anima files")
        if approval.target_entry_id is None:
            raise MemoryEntryConflictError(f"{anima_file.filename} approval has no target entry")
        try:
            current = await self._memory_entries.get_entry(user_id=user_id, entry_id=approval.target_entry_id)
        except MemoryEntryNotFoundError as exc:
            raise MemoryEntryConflictError("This Anima no longer exists; reject the proposal") from exc
        same_kind = is_anima_identity(current) if anima_file.is_identity else is_anima_memories(current)
        if not same_kind or current.anima_id != anima_file.anima_id:
            raise MemoryEntryConflictError(f"{anima_file.filename} approval target changed after it was proposed")
        committed = await self._memory_entries.patch_entry(
            user_id=user_id,
            entry_id=current.id,
            expected_version=approval.expected_version,
            content=approval.new_content,
            content_set=True,
            description=approval.new_description,
            description_set=True,
            change_metadata=change_metadata,
            use_current_aggregate_revision=True,
        )
        if not anima_file.is_identity:
            await self._advance_reflection_coverage(run=run, anima_id=anima_file.anima_id)
        return committed

    def _reflection_task_for_anima(
        self,
        *,
        run: MemoryManagerRun,
        anima_id: str,
    ) -> MemoryManagerReflectionTaskState | None:
        """Return the task of a Reflection run bound to ``anima_id``, or ``None`` for any other run."""

        if run.kind != MEMORY_MANAGER_RUN_KIND_REFLECTION:
            return None
        try:
            task = MemoryManagerReflectionTaskState.from_dict(run.task_state)
        except ValueError as exc:
            raise MemoryEntryConflictError(str(exc)) from exc
        if task.anima_id != anima_id:
            return None
        if self._anima_reflections is None:
            raise MemoryManagerValidationError("Reflection is not configured")
        return task

    async def _advance_reflection_coverage(self, *, run: MemoryManagerRun, anima_id: str) -> None:
        """Mark a Reflection's batch covered once its ``MEMORIES.md`` change is applied.

        General runs never move coverage. Coverage must still be where the
        Reflection started (or already at its boundary, for a second change in
        the same run); otherwise the approval conflicts and stays pending.
        """

        task = self._reflection_task_for_anima(run=run, anima_id=anima_id)
        if task is None:
            return
        assert self._anima_reflections is not None
        coverage = await self._anima_reflections.get(user_id=run.user_id, anima_id=anima_id, for_update=True)
        current = coverage.covered_through if coverage is not None else None
        if current == task.covered_through:
            return
        if current != task.covered_after:
            raise MemoryEntryConflictError(
                f"Reflection coverage for {task.anima_name} changed after this Reflection started; "
                "reject the proposal and reflect again"
            )
        await self._anima_reflections.put(
            AnimaMemoryReflection(
                anima_id=anima_id,
                user_id=run.user_id,
                covered_through=task.covered_through,
                run_id=run.id,
            )
        )

    async def _restore_reflection_coverage(
        self,
        *,
        run: MemoryManagerRun,
        undone: MemoryManagerApproval,
        entry: MemoryEntry,
        run_approvals: list[MemoryManagerApproval],
    ) -> None:
        """Return coverage to where a Reflection started when its applied change is undone.

        Coverage is left alone when another applied change from the same run
        still stands, or when coverage no longer sits at this run's boundary.
        """

        if not is_anima_memories(entry) or entry.anima_id is None:
            return
        task = self._reflection_task_for_anima(run=run, anima_id=entry.anima_id)
        if task is None:
            return
        if any(
            item.id != undone.id
            and item.status == MEMORY_MANAGER_APPROVAL_STATUS_APPROVED
            and item.undone_at is None
            and item.target_entry_id == entry.id
            for item in run_approvals
        ):
            return
        assert self._anima_reflections is not None
        coverage = await self._anima_reflections.get(user_id=run.user_id, anima_id=task.anima_id, for_update=True)
        if coverage is None or coverage.run_id != run.id or coverage.covered_through != task.covered_through:
            return
        if task.covered_after is None or task.covered_after_run_id is None:
            await self._anima_reflections.delete(user_id=run.user_id, anima_id=task.anima_id)
            return
        await self._anima_reflections.put(
            AnimaMemoryReflection(
                anima_id=task.anima_id,
                user_id=run.user_id,
                covered_through=task.covered_after,
                run_id=task.covered_after_run_id,
            )
        )

    @staticmethod
    def _approval_change_metadata(approval: MemoryManagerApproval, *, run: MemoryManagerRun) -> dict[str, Any]:
        """Return safe provenance for the version produced by one approval."""

        metadata: dict[str, Any] = {
            "source_type": "memory_manager_approval",
            "source_id": approval.id,
            "run_id": approval.run_id,
        }
        if memory_manager_run_is_automatic(run):
            # Version history labels these as automatic updates from episode notes.
            metadata["trigger"] = AUTOMATIC_EPISODE_PROCESSING_TRIGGER
        operation_metadata = dict(approval.operation_metadata or {})
        for key in ("runtime", "source_message_id"):
            value = operation_metadata.get(key)
            if isinstance(value, str) and value:
                metadata[key] = value
        return metadata

    async def _entry_for_update_approval(self, *, user_id: str, approval: MemoryManagerApproval) -> MemoryEntry:
        if approval.target_entry_id is not None:
            return await self._memory_entries.get_entry(user_id=user_id, entry_id=approval.target_entry_id)
        return await self._memory_entries.get_entry_by_path(
            user_id=user_id,
            anima_id=None,
            path=approval.target_path,
            type=MEMORY_ENTRY_TYPE_FILE,
        )

    def _pinned_model_gone_result(self, detail: str | None = None) -> MemoryManagerRuntimeResult:
        """End a review after a rejection the proposing model can no longer resume.

        ``detail`` is why it cannot, when the model is there but cannot serve the run now (a ChatGPT plan's state).
        """

        if detail and detail != MemoryManagerPinnedModelUnavailableError().detail:
            message = f"The review ended after your rejection: {detail}"
        else:
            message = (
                "The model that proposed this change is no longer available, so the review ended after your "
                "rejection. Start a new run to continue."
            )
        return MemoryManagerRuntimeResult(
            assistant_message=message,
            metadata={
                "runtime": self._runtime.name,
                "runtime_error_code": MemoryManagerPinnedModelUnavailableError.code,
            },
            error=message,
            outcome=MEMORY_MANAGER_RUNTIME_OUTCOME_BLOCKED,
        )

    def _runtime_failure_result(
        self,
        exc: MemoryManagerRuntimeError,
        *,
        runtime_name: str | None = None,
    ) -> MemoryManagerRuntimeResult:
        """A failed result recording ``runtime_name``, the runtime that failed (the role's by default)."""

        detail = exc.detail
        runtime_name = runtime_name or self._runtime.name
        self._log.warning(
            "MemoryManagerService.runtime.failed",
            runtime=runtime_name,
            error=detail,
            exc_info=True,
        )
        return MemoryManagerRuntimeResult(
            assistant_message=f"Memory manager runtime failed: {detail}",
            serialized_agent_state=None,
            metadata={
                "runtime": runtime_name,
                "exception_class": exc.__class__.__name__,
                "runtime_error_code": exc.code,
            },
            error=detail,
            outcome=MEMORY_MANAGER_RUNTIME_OUTCOME_FAILED,
        )

    @staticmethod
    def _validated_runtime_outcome(
        *,
        result: MemoryManagerRuntimeResult,
        has_pending: bool,
    ) -> str:
        outcome = result.outcome
        if outcome not in MEMORY_MANAGER_RUNTIME_OUTCOMES:
            return MEMORY_MANAGER_RUNTIME_OUTCOME_FAILED
        if outcome in {
            MEMORY_MANAGER_RUNTIME_OUTCOME_BLOCKED,
            MEMORY_MANAGER_RUNTIME_OUTCOME_FAILED,
        }:
            return outcome
        if has_pending:
            if not isinstance(result.serialized_agent_state, str) or not result.serialized_agent_state.strip():
                return MEMORY_MANAGER_RUNTIME_OUTCOME_BLOCKED
            return MEMORY_MANAGER_RUNTIME_OUTCOME_WAITING_APPROVAL
        if outcome == MEMORY_MANAGER_RUNTIME_OUTCOME_WAITING_APPROVAL:
            return MEMORY_MANAGER_RUNTIME_OUTCOME_BLOCKED
        if result.error and outcome == MEMORY_MANAGER_RUNTIME_OUTCOME_COMPLETED:
            return MEMORY_MANAGER_RUNTIME_OUTCOME_FAILED
        return outcome

    @staticmethod
    def _nonblank_string(value: object) -> str | None:
        if not isinstance(value, str):
            return None
        normalized = value.strip()
        return normalized or None

    @staticmethod
    def _normalize_message_content(content: str) -> str:
        if not isinstance(content, str):
            raise MemoryManagerValidationError("Message content must be a string")
        normalized = content.strip()
        if not normalized:
            raise MemoryManagerValidationError("Message content is required")
        if len(normalized) > _MEMORY_MANAGER_MESSAGE_MAX_CHARS:
            raise MemoryManagerValidationError("Message content is too long")
        return normalized

    @staticmethod
    def _normalize_rejection_feedback(feedback: str | None) -> str | None:
        if feedback is None:
            return None
        if not isinstance(feedback, str):
            raise MemoryManagerValidationError("Feedback must be a string")
        normalized = feedback.strip()
        if not normalized:
            return None
        if len(normalized) > _REJECTION_FEEDBACK_MAX_CHARS:
            raise MemoryManagerValidationError("Feedback is too long")
        return normalized

    @staticmethod
    def _validate_approval_target_path(path: str) -> tuple[str, AnimaManagerPath | None]:
        """Return the clean target path and, for Anima file targets, the addressed file."""

        anima_file = parse_anima_manager_path(path)
        if anima_file is not None:
            return anima_file.path, anima_file
        # parse_anima_manager_path already rejects other reserved paths.
        clean_path, _normalized_path = normalize_memory_file_path(path)
        if is_protected_memory_path(clean_path):
            raise MemoryEntryProtectedError("Generated episode logs are read-only")
        return clean_path, None

    @staticmethod
    def _merged_usage_metadata(
        current: dict[str, object] | None,
        delta: dict[str, object] | None,
    ) -> dict[str, object]:
        merged: dict[str, object] = dict(current or {})
        incoming = dict(delta or {})
        for key in _USAGE_COUNTER_KEYS:
            before = merged.get(key, 0)
            after = incoming.pop(key, 0)
            if isinstance(before, int | float) and isinstance(after, int | float):
                merged[key] = int(before) + int(after)
            elif after:
                merged[key] = after
        merged.update(incoming)
        return merged

    @staticmethod
    def _status_for_decision(decision: str) -> str:
        normalized = decision.strip().lower() if isinstance(decision, str) else ""
        if normalized == "approve":
            return MEMORY_MANAGER_APPROVAL_STATUS_APPROVED
        if normalized == "reject":
            return MEMORY_MANAGER_APPROVAL_STATUS_REJECTED
        if normalized in MEMORY_MANAGER_APPROVAL_STATUSES - {MEMORY_MANAGER_APPROVAL_STATUS_PENDING}:
            return normalized
        raise MemoryManagerValidationError("Decision must be approve or reject")

    async def _commit_if_enabled(self) -> None:
        if self._commit_on_write:
            await self._uow.commit()

    async def _rollback_if_enabled(self) -> None:
        if self._commit_on_write:
            await self._uow.rollback()

    async def _raise_not_found(self, detail: str) -> NoReturn:
        await self._rollback_if_enabled()
        raise MemoryManagerNotFoundError(detail)


def _episode_task_status(run: MemoryManagerRun) -> str | None:
    """The status of an episode-processing run's fixed batch, or None for other runs."""

    if run.kind != MEMORY_MANAGER_RUN_KIND_EPISODE_PROCESSING or run.task_state is None:
        return None
    try:
        return MemoryManagerEpisodeTaskState.from_dict(run.task_state).status
    except ValueError:
        return None


def _episode_task_is_processing(run: MemoryManagerRun) -> bool:
    return _episode_task_status(run) == MEMORY_MANAGER_EPISODE_TASK_STATUS_PROCESSING


def _turns_within_token_budget(turns: list[AnimaHistoryTurn]) -> list[AnimaHistoryTurn]:
    """Keep the oldest turns whose read text fits ``REFLECTION_MAX_BATCH_TOKENS``, always at least one.

    Without the budget, a history of very long replies would make every
    Reflection fail on the same oversized oldest batch.
    """

    total = 0
    for index, turn in enumerate(turns):
        total += sum(
            estimate_text_tokens(shorten_reflection_turn_text(text) or "") for text in (turn.user_text, turn.anima_text)
        )
        if index > 0 and total > REFLECTION_MAX_BATCH_TOKENS:
            return turns[:index]
    return turns


__all__ = [
    "AUTOMATIC_COMPLETION_CLOSED",
    "AUTOMATIC_COMPLETION_INTERRUPTED",
    "AUTOMATIC_COMPLETION_PROCESSED",
    "AUTOMATIC_EPISODE_PROCESSING_TRIGGER",
    "AutomaticEpisodeProcessingOutcome",
    "MemoryManagerConflictError",
    "MemoryManagerError",
    "MemoryManagerNotFoundError",
    "MemoryManagerService",
    "MemoryManagerValidationError",
]

"""Runtime port for the user-invoked memory manager agent."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from animama.domain.memory_manager import MemoryManagerApproval, MemoryManagerMessage, MemoryManagerRun

MEMORY_MANAGER_RUNTIME_OUTCOME_COMPLETED = "completed"
MEMORY_MANAGER_RUNTIME_OUTCOME_WAITING_APPROVAL = "waiting_approval"
MEMORY_MANAGER_RUNTIME_OUTCOME_BLOCKED = "blocked"
MEMORY_MANAGER_RUNTIME_OUTCOME_FAILED = "failed"
MEMORY_MANAGER_RUNTIME_OUTCOMES = frozenset(
    {
        MEMORY_MANAGER_RUNTIME_OUTCOME_COMPLETED,
        MEMORY_MANAGER_RUNTIME_OUTCOME_WAITING_APPROVAL,
        MEMORY_MANAGER_RUNTIME_OUTCOME_BLOCKED,
        MEMORY_MANAGER_RUNTIME_OUTCOME_FAILED,
    }
)


@dataclass(slots=True)
class MemoryManagerRuntimeApprovalRequest:
    """One proposed memory file operation returned by a manager runtime pause."""

    operation: str
    target_path: str
    target_entry_id: str | None
    expected_version: int | None
    summary: str | None
    old_content: str | None
    new_content: str | None
    old_description: str | None
    new_description: str | None
    unified_diff: str
    operation_metadata: dict[str, Any] | None = None


@dataclass(slots=True)
class MemoryManagerRuntimeResult:
    """Normalized result from a memory-manager runtime invocation."""

    assistant_message: str | None = None
    approvals: list[MemoryManagerRuntimeApprovalRequest] | None = None
    serialized_agent_state: str | None = None
    openai_previous_response_id: str | None = None
    summary: str | None = None
    usage_metadata: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None
    error: str | None = None
    outcome: str = MEMORY_MANAGER_RUNTIME_OUTCOME_COMPLETED
    keeps_conversation_state: bool = False
    """True only for a step on stored OpenAI Responses, whose cursor covers the conversation.

    After any other step (Chat Completions, Anthropic, a ChatGPT plan) the run's stored cursor
    no longer covers the conversation, so the service drops it and a later stored-response step
    replays the run."""


class MemoryManagerRuntimeError(Exception):
    """Base class for memory-manager runtime failures."""

    code = "memory_manager_runtime_error"

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class MemoryManagerRuntimeConfigurationError(MemoryManagerRuntimeError):
    """Raised when the live runtime is invoked without required configuration."""


class MemoryManagerPreviousResponseUnresolvableError(MemoryManagerRuntimeError):
    """Raised when OpenAI can no longer resolve a persisted Responses cursor."""

    code = "memory_manager_previous_response_unresolvable"

    def __init__(self) -> None:
        super().__init__(
            "The stored OpenAI response cursor is no longer available. Start a new Memory Manager run to continue."
        )


class MemoryManagerPinnedModelUnavailableError(MemoryManagerRuntimeError):
    """Raised when the model a run started on can no longer resume it."""

    code = "memory_manager_pinned_model_unavailable"

    def __init__(self, detail: str | None = None) -> None:
        """``detail`` says why when the model is there but cannot serve the run now (a ChatGPT plan's state)."""

        super().__init__(
            detail
            or "The model that proposed this change is no longer available for the Memory Manager. "
            "Restore it in App Settings and approve again, or reject the change."
        )


class MemoryManagerRuntime(Protocol):
    """Agent runtime boundary used by ``MemoryManagerService``."""

    name: str

    @property
    def model_provider_id(self) -> str | None:
        """The catalog row new runs start on and record, or ``None`` without one."""

        raise NotImplementedError

    async def for_run(self, run: MemoryManagerRun) -> MemoryManagerRuntime:
        """Return the runtime on the row ``run`` is pinned to, for resuming it.

        That may be another runtime kind when the row's provider type differs
        from the role row's. Raises ``MemoryManagerPinnedModelUnavailableError``
        when that row was removed or can no longer run the Memory Manager.
        """

        raise NotImplementedError

    async def run_user_message(
        self,
        *,
        run: MemoryManagerRun,
        user_message: MemoryManagerMessage,
        history: Sequence[MemoryManagerMessage] = (),
    ) -> MemoryManagerRuntimeResult:
        """Process a newly appended user message.

        ``history`` holds the run's earlier messages for runtimes whose model
        server keeps no conversation state.
        """

        raise NotImplementedError

    async def resume_approval_decision(
        self,
        *,
        run: MemoryManagerRun,
        approval: MemoryManagerApproval,
        decision: str,
        feedback: str | None = None,
    ) -> MemoryManagerRuntimeResult:
        """Best-effort resume after a persisted approval decision."""

        raise NotImplementedError


__all__ = [
    "MEMORY_MANAGER_RUNTIME_OUTCOME_BLOCKED",
    "MEMORY_MANAGER_RUNTIME_OUTCOME_COMPLETED",
    "MEMORY_MANAGER_RUNTIME_OUTCOME_FAILED",
    "MEMORY_MANAGER_RUNTIME_OUTCOME_WAITING_APPROVAL",
    "MEMORY_MANAGER_RUNTIME_OUTCOMES",
    "MemoryManagerRuntime",
    "MemoryManagerRuntimeApprovalRequest",
    "MemoryManagerPinnedModelUnavailableError",
    "MemoryManagerRuntimeConfigurationError",
    "MemoryManagerRuntimeError",
    "MemoryManagerPreviousResponseUnresolvableError",
    "MemoryManagerRuntimeResult",
]

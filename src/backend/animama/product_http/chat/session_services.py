"""Chat-turn collaborators that work in their own short-lived owner sessions."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping, Sequence
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from animama.adapters.memory_patch import AgentsSDKV4AMemoryPatchPlanner
from animama.app.chat import DirectChatMemoryToolService, memory_tool_specs
from animama.app.chat.memory_tools import MEMORY_TOOL_BUSY_RESULT
from animama.app.model_clients.image_parts import ModelClientImage
from animama.app.ports.private_file_storage import PrivateFileStorage, PrivateFileUnavailableError
from animama.app.services.memory_entry_service import MemoryEntryService
from animama.app.services.memory_episode_service import MemoryEpisodeService
from animama.app.services.user_file_service import is_image_user_file
from animama.domain.settings import preferred_time_zone
from animama.domain.user_file import STATUS_READY, UserFile
from animama.logging import get_logger
from animama.product_http.ports import ProductRepositories

from .setup_helpers import TurnSessions, chat_manager, with_short_lived_session

_log = get_logger("product_http.chat.session_services")


class SessionBackedChatTurnRecorder:
    """Records final direct chat turns through fresh short-lived sessions.

    A save that has begun completes even if the turn is cancelled meanwhile (a stop
    or a disconnect), and ``on_recorded`` runs once it has, so the stream always
    knows whether the reply was saved.
    """

    def __init__(
        self,
        sessions: TurnSessions,
        *,
        chat_manager_factory: Callable[[ProductRepositories], Any] = chat_manager,
        on_recorded: Callable[[], None] | None = None,
    ) -> None:
        self._sessions = sessions
        self._chat_manager_factory = chat_manager_factory
        self._on_recorded = on_recorded

    async def record_turn(self, **kwargs: Any) -> Any:
        async def _record(repositories: ProductRepositories) -> Any:
            return await self._chat_manager_factory(repositories).record_turn(**kwargs)

        saving = asyncio.create_task(with_short_lived_session(self._sessions, _record), name="direct-chat-save")
        try:
            result = await asyncio.shield(saving)
        except asyncio.CancelledError:
            with suppress(Exception):
                await saving
                self._recorded()
            raise
        self._recorded()
        return result

    def _recorded(self) -> None:
        if self._on_recorded is not None:
            self._on_recorded()


class SessionBackedMemoryEpisodeRecorder:
    """Records episodic memory capture through fresh short-lived sessions."""

    def __init__(self, sessions: TurnSessions) -> None:
        self._sessions = sessions

    async def record_episode_item(
        self,
        *,
        user_id: str,
        text: str,
        source_anima_id: str | None = None,
        source_chat_id: str | None = None,
        source_run_id: str | None = None,
        source_message_id: str | None = None,
    ) -> Any:
        async def _record(repositories: ProductRepositories) -> Any:
            user_settings = await repositories.user_settings.get(user_id)
            local_zone, local_timezone = preferred_time_zone(getattr(user_settings, "preferences", None))
            occurred_at = datetime.now(UTC)
            local_date = occurred_at.astimezone(local_zone).date()
            uow = repositories.unit_of_work
            service = MemoryEpisodeService(
                memory_episodes=repositories.memory_episodes,
                memory_entries=MemoryEntryService(
                    memory_entries=repositories.memory_entries,
                    uow=uow,
                    commit_on_write=False,
                ),
                uow=uow,
                commit_on_write=True,
            )
            return await service.create_episode_item(
                user_id=user_id,
                source_anima_id=source_anima_id,
                source_chat_id=source_chat_id,
                source_run_id=source_run_id,
                source_message_id=source_message_id,
                text=text,
                occurred_at=occurred_at,
                local_date=local_date,
                local_timezone=local_timezone,
            )

        return await with_short_lived_session(self._sessions, _record)


def _chat_tool_memory_entries(repositories: ProductRepositories, *, max_file_bytes: int) -> MemoryEntryService:
    """Build the committed memory service used by chat tools.

    The Anima repository lets a turn reach its own ``MEMORIES.md`` (whose size
    limit the service enforces), and the file limit matches the memory API.
    """

    return MemoryEntryService(
        memory_entries=repositories.memory_entries,
        uow=repositories.unit_of_work,
        animas=repositories.animas,
        max_file_bytes=max_file_bytes,
        commit_on_write=True,
    )


# The longest a chat memory tool waits for a file another transaction holds, such as a
# Memory Manager approval, before it returns a retryable "busy" result (spec #775, R6).
MEMORY_TOOL_LOCK_TIMEOUT_SECONDS = 6.0
# PostgreSQL's lock_not_available, raised when lock_timeout expires.
_LOCK_NOT_AVAILABLE = "55P03"


class SessionBackedMemoryToolService:
    """Executes direct-chat memory tools through fresh short-lived sessions."""

    def __init__(
        self,
        sessions: TurnSessions,
        *,
        max_file_bytes: int,
        embedder_factory: Callable[[], Any] | None = None,
        allowed_uploaded_files: Mapping[str, str] | None = None,
        lock_timeout_seconds: float = MEMORY_TOOL_LOCK_TIMEOUT_SECONDS,
    ) -> None:
        self._sessions = sessions
        self._max_file_bytes = max_file_bytes
        self._embedder_factory = embedder_factory
        self._allowed_uploaded_files = dict(allowed_uploaded_files or {})
        self._lock_timeout_ms = max(1, round(lock_timeout_seconds * 1000))

    def tool_specs(
        self,
        *,
        allow_reads: bool,
        allow_writes: bool,
        allow_uploaded_file_tools: bool = False,
    ) -> tuple[dict[str, Any], ...]:
        return memory_tool_specs(
            allow_reads=allow_reads,
            allow_writes=allow_writes,
            allow_uploaded_file_tools=allow_uploaded_file_tools,
        )

    async def execute(self, **kwargs: Any) -> str:
        async def _execute(repositories: ProductRepositories) -> str:
            memory_entries = _chat_tool_memory_entries(repositories, max_file_bytes=self._max_file_bytes)
            service = DirectChatMemoryToolService(
                memory_entries=memory_entries,
                user_file_processing=repositories.user_file_processing,
                user_file_embedder_factory=self._embedder_factory,
                allowed_uploaded_files=self._allowed_uploaded_files,
                patch_planner=AgentsSDKV4AMemoryPatchPlanner(memory_entries=memory_entries),
            )
            return await service.execute(**kwargs)

        return await self._with_bounded_lock_wait(_execute)

    async def execute_native_patch(self, **kwargs: Any) -> str:
        """Execute one native Apply Patch call in a fresh committed session."""

        async def _execute(repositories: ProductRepositories) -> str:
            memory_entries = _chat_tool_memory_entries(repositories, max_file_bytes=self._max_file_bytes)
            service = DirectChatMemoryToolService(
                memory_entries=memory_entries,
                patch_planner=AgentsSDKV4AMemoryPatchPlanner(memory_entries=memory_entries),
            )
            return await service.execute_native_patch(**kwargs)

        return await self._with_bounded_lock_wait(_execute)

    async def _with_bounded_lock_wait(self, operation: Callable[[ProductRepositories], Awaitable[str]]) -> str:
        """Run one tool call in a fresh write session whose lock waits end after the bound.

        The turn then gets the busy result instead of waiting for whichever
        transaction holds the file.
        """

        async with self._sessions.write() as session:
            await session.execute(
                text("SELECT set_config('lock_timeout', :timeout, true)"), {"timeout": f"{self._lock_timeout_ms}ms"}
            )
            try:
                return await operation(self._sessions.repositories(session))
            except DBAPIError as exc:
                if getattr(exc.orig, "sqlstate", None) != _LOCK_NOT_AVAILABLE:
                    raise
                await session.rollback()
                return MEMORY_TOOL_BUSY_RESULT


class SessionBackedChatImageLoader:
    """Loads the owner's ready chat images for a turn's requests (``ChatImageLoader``).

    Each load opens a short read session, so it also serves requests made after
    the setup session closed. Only the owner's ready images are read, and only
    when the stored bytes still match their record; anything else is left out
    and goes to the model as its placeholder.
    """

    def __init__(self, sessions: TurnSessions) -> None:
        self._sessions = sessions

    async def load(self, file_ids: Sequence[str]) -> dict[str, ModelClientImage]:
        user_id = self._sessions.principal.id
        async with self._sessions.read() as session:
            user_files = self._sessions.repositories(session).user_file_processing
            rows = [await user_files.get_user_file(user_id=user_id, file_id=file_id) for file_id in file_ids]
        images = [row for row in rows if row is not None and _servable_image(row)]
        if not images:
            return {}
        storage = self._sessions.ports.uploads(self._sessions.principal).private_files
        loaded: dict[str, ModelClientImage] = {}
        for row in images:
            try:
                content = await asyncio.to_thread(_read_image, storage, row)
            except Exception as exc:
                _log.warning("Chat image could not be read", file_id=row.id, user_id=user_id, error=str(exc))
                continue
            loaded[row.id] = ModelClientImage(media_type=row.detected_content_type or "", content=content)
        return loaded


def read_stored_image(storage: PrivateFileStorage, row: UserFile) -> ModelClientImage | None:
    """One stored image as a model request carries it; ``None`` for a row that is not a ready image (blocking).

    The rules a chat turn's images follow, for another caller that sends the
    owner's images to a model: a ready image of a type model providers take,
    whose stored bytes still match their record. Raises as the storage does
    when the bytes cannot be read or no longer match.
    """

    if not _servable_image(row):
        return None
    return ModelClientImage(media_type=row.detected_content_type or "", content=_read_image(storage, row))


def _servable_image(row: UserFile) -> bool:
    return (
        is_image_user_file(row)
        and row.status == STATUS_READY
        and bool(row.stored_size_bytes)
        and bool(row.sha256)
        and row.detected_content_type in {"image/png", "image/jpeg"}
    )


def _read_image(storage: PrivateFileStorage, row: UserFile) -> bytes:
    """Read a stored image and check it is still the recorded copy (blocking)."""

    with storage.open_bounded(row.storage_locator, expected_size_bytes=row.stored_size_bytes or 0) as stored:
        content = stored.stream.read()
        digest = stored.sha256
    if digest != row.sha256:
        raise PrivateFileUnavailableError("Stored image no longer matches its record")
    return content


__all__ = [
    "SessionBackedChatImageLoader",
    "SessionBackedChatTurnRecorder",
    "SessionBackedMemoryEpisodeRecorder",
    "SessionBackedMemoryToolService",
    "read_stored_image",
]

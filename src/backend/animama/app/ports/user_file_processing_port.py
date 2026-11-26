"""Repository protocol for user-file processing jobs, chunks, and search."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Protocol

from animama.domain.user_file import UserFile
from animama.domain.user_file_processing import (
    ClaimedUserFileProcessingJob,
    UserFileChunkDraft,
    UserFileProcessingInfo,
    UserFileProcessingJob,
    UserFileReadableChunk,
    UserFileSearchResult,
)


class UserFileProcessingRepository(Protocol):
    """Persistence operations for file processing queues and chunk search."""

    async def get_user_file(self, *, user_id: str, file_id: str, include_deleted: bool = False) -> UserFile | None:
        raise NotImplementedError

    async def list_processing_info(
        self,
        *,
        user_id: str,
        file_ids: list[str],
    ) -> dict[str, UserFileProcessingInfo]:
        raise NotImplementedError

    async def count_chunks(self, *, user_id: str, file_id: str) -> int:
        raise NotImplementedError

    async def read_chunks(
        self,
        *,
        user_id: str,
        file_id: str,
        start_chunk: int,
        limit: int,
    ) -> list[UserFileReadableChunk]:
        """Read one searchable file's chunks in source order."""

        raise NotImplementedError

    async def get_reusable_job(self, *, user_id: str, file_id: str) -> UserFileProcessingJob | None:
        raise NotImplementedError

    async def get_latest_job(self, *, user_id: str, file_id: str) -> UserFileProcessingJob | None:
        raise NotImplementedError

    async def create_processing_job(
        self,
        *,
        job: UserFileProcessingJob,
        set_file_processing: bool = True,
    ) -> UserFileProcessingJob:
        raise NotImplementedError

    async def claim_next_job(
        self,
        *,
        worker_id: str,
        lease_seconds: int,
        now: datetime,
        limit_file_id: str | None = None,
    ) -> ClaimedUserFileProcessingJob | None:
        """Lease the next due job, after failing jobs whose last attempt was interrupted.

        A running job whose lease expired is claimed again while attempts
        remain; on its last attempt it fails with ``PROCESSING_INTERRUPTED_ERROR``.
        """

        raise NotImplementedError

    async def replace_chunks_and_mark_success(
        self,
        *,
        job_id: str,
        user_id: str,
        file_id: str,
        sha256: str,
        chunks: list[UserFileChunkDraft],
        file_status: str,
        processing_metadata: dict[str, Any],
        file_metadata_updates: dict[str, Any] | None = None,
        processed_at: datetime,
        embedding_model_id: str | None = None,
    ) -> UserFileProcessingJob:
        """Replace a file's chunks; chunk vectors are recorded as ``embedding_model_id``'s."""

        raise NotImplementedError

    async def reuse_processed_file(
        self,
        *,
        job_id: str,
        user_id: str,
        file_id: str,
        sha256: str,
        processed_at: datetime,
        embedding_model_id: str | None = None,
    ) -> UserFileProcessingJob | None:
        """Clone a same-user ready file's processed result when its digest matches.

        Only vectors from ``embedding_model_id`` are copied; other chunks are
        left for re-embedding.
        """

        raise NotImplementedError

    async def mark_job_failure(
        self,
        *,
        job_id: str,
        user_id: str,
        file_id: str,
        error: str,
        now: datetime,
        retry_delay_seconds: int,
        retryable: bool = True,
    ) -> UserFileProcessingJob:
        """Requeue a failed attempt after a delay, or fail the job and its file.

        The job fails at once when ``retryable`` is false or no attempt remains.
        """

        raise NotImplementedError

    async def release_claimed_job(self, *, job_id: str, worker_id: str, now: datetime) -> bool:
        """Return a job still running under ``worker_id`` to the queue, giving back its attempt.

        Returns whether the job was released.
        """

        raise NotImplementedError

    async def delete_chunks_for_file(self, *, user_id: str, file_id: str) -> None:
        raise NotImplementedError

    async def image_file_ids_only_in_chat(self, *, user_id: str, chat_id: str) -> list[str]:
        """Return the chat images this chat's messages attach and no other chat of the owner does."""
        raise NotImplementedError

    async def record_file_deleted(self, *, user_id: str, file_id: str, object_deleted: bool) -> None:
        """Mark a file deleted, or delete-pending when its bytes could not be removed."""
        raise NotImplementedError

    async def keyword_search(
        self,
        *,
        user_id: str,
        query: str,
        limit: int,
        file_ids: list[str] | None = None,
    ) -> list[UserFileSearchResult]:
        raise NotImplementedError

    async def semantic_search(
        self,
        *,
        user_id: str,
        embedding: list[float],
        embedding_model_id: str,
        limit: int,
        file_ids: list[str] | None = None,
    ) -> list[UserFileSearchResult]:
        """Rank chunks whose vectors come from ``embedding_model_id`` by similarity."""

        raise NotImplementedError

    async def count_stale_chunks(
        self,
        *,
        user_id: str,
        embedding_model_id: str,
        file_ids: list[str] | None = None,
    ) -> int:
        """Count searchable chunks still waiting for a vector from ``embedding_model_id``."""

        raise NotImplementedError


__all__ = ["UserFileProcessingRepository"]

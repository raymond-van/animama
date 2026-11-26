"""Application service for user-file processing jobs, chunks, and debug search."""

from __future__ import annotations

import asyncio
import hashlib
import time
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from animama.app.ports.private_file_storage import PrivateFileStorage, PrivateFileUnavailableError
from animama.app.ports.text_embedder import TextEmbedder
from animama.app.ports.uow_port import UnitOfWork
from animama.app.ports.user_file_parser_port import UserFileParser, UserFileParseRejectedError
from animama.app.ports.user_file_processing_port import UserFileProcessingRepository
from animama.app.services.user_file_chunking import chunk_parsed_user_file_document
from animama.app.services.user_file_overview import (
    build_user_file_overview,
    fallback_user_file_overview,
    serialize_user_file_overview,
)
from animama.domain.user_file import (
    STATUS_FAILED,
    STATUS_PENDING_UPLOAD,
    STATUS_PROCESSING,
    STATUS_READY,
    STATUS_READY_KEYWORD_ONLY,
    STATUS_UPLOADED,
)
from animama.domain.user_file_processing import (
    DEFAULT_USER_FILE_CHUNK_MAX_TOKENS,
    JOB_STATUS_SUCCEEDED,
    JOB_TYPE_PROCESS_FILE,
    NO_SEARCHABLE_TEXT_ERROR,
    SEARCH_MODE_HYBRID,
    SEARCH_MODE_KEYWORD,
    SEARCH_MODE_SEMANTIC,
    ClaimedUserFileProcessingJob,
    SearchMode,
    UserFileChunkDraft,
    UserFileProcessingInfo,
    UserFileProcessingJob,
    UserFileSearchResult,
)
from animama.logging import get_logger
from animama.utils.clock import utc_now

PROCESSABLE_FILE_STATUSES = {
    STATUS_UPLOADED,
    STATUS_PROCESSING,
    STATUS_READY,
    STATUS_READY_KEYWORD_ONLY,
    STATUS_FAILED,
}

RRF_K = 60

TRANSIENT_PARSER_METADATA = frozenset({"pdf_pages"})
"""Parser metadata that only chunking reads, left out of the file's stored processing metadata."""


class UserFileProcessingServiceError(Exception):
    """Base error raised by user-file processing services."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class UserFileProcessingValidationError(UserFileProcessingServiceError):
    """Raised when a processing or search request is invalid."""


class UserFileProcessingNotFoundError(UserFileProcessingServiceError):
    """Raised when a current-user processing target cannot be found."""


class UserFileProcessingConflictError(UserFileProcessingServiceError):
    """Raised when a file status does not allow the requested operation."""


class UserFileProcessingUnavailableError(UserFileProcessingServiceError):
    """Raised when semantic search dependencies are unavailable."""


def is_retryable_processing_failure(error: BaseException) -> bool:
    """Return whether a failed processing attempt may succeed when retried.

    A missing, empty or oversized upload, a file without searchable text and
    content the parser rejects fail the same way every time, so they fail the
    file at once. Anything else (a database or provider hiccup, a parser crash
    in this process) is retried with backoff.
    """

    return not isinstance(error, UserFileProcessingValidationError | UserFileParseRejectedError)


def read_claimed_upload(
    storage: PrivateFileStorage,
    claimed: ClaimedUserFileProcessingJob,
    *,
    max_process_bytes: int,
) -> bytes | None:
    """Read a claimed upload's private bytes, at most one byte past the processing limit.

    One extra byte is enough for :meth:`UserFileProcessingService.complete_claimed_job`
    to report an oversized upload without holding an arbitrarily large document
    in memory. A file that is missing or no longer its recorded size returns
    ``None``, which fails the job for good. Any other read error (a permission
    problem, an unavailable disk) propagates, so the job is retried. This blocks
    on file IO; async callers run it in a thread.
    """

    expected_size = claimed.stored_size_bytes or claimed.declared_size_bytes
    try:
        with storage.open_bounded(claimed.storage_locator, expected_size_bytes=expected_size) as stored:
            return stored.stream.read(max_process_bytes + 1)
    except PrivateFileUnavailableError as exc:
        get_logger("app.services.user_file_processing").warning(
            "User-file upload is missing or changed",
            file_id=claimed.job.file_id,
            error_type=exc.__class__.__name__,
        )
        return None


@dataclass(frozen=True, slots=True)
class ProcessFileResult:
    """Response payload for enqueueing or reusing a processing job."""

    file_id: str
    job_id: str | None
    file_status: str
    job_status: str | None
    reused_existing_job: bool


@dataclass(frozen=True, slots=True)
class UserFileSearchResults:
    """Debug search results plus dependency warnings."""

    query: str
    mode: SearchMode
    results: list[UserFileSearchResult]
    warnings: list[str]


def new_user_file_processing_job_id() -> str:
    """Return an opaque user-file processing job identifier."""

    return f"job-{uuid4().hex}"


class UserFileProcessingService:
    """Coordinate user-file processing queue, worker, and debug search use cases."""

    def __init__(
        self,
        *,
        processing: UserFileProcessingRepository,
        uow: UnitOfWork,
        max_attempts: int = 3,
        processing_enabled: bool = True,
        chunk_max_tokens: int = DEFAULT_USER_FILE_CHUNK_MAX_TOKENS,
    ) -> None:
        self._processing = processing
        self._uow = uow
        self._max_attempts = max(1, max_attempts)
        self._processing_enabled = processing_enabled
        self._chunk_max_tokens = chunk_max_tokens
        self._log = get_logger("app.services.user_file_processing")

    async def list_processing_info(self, *, user_id: str, file_ids: list[str]) -> dict[str, UserFileProcessingInfo]:
        return await self._processing.list_processing_info(user_id=user_id, file_ids=file_ids)

    async def enqueue_processing_job(
        self,
        *,
        user_id: str,
        file_id: str,
        force: bool = False,
    ) -> ProcessFileResult:
        if not self._processing_enabled:
            raise UserFileProcessingConflictError("file_processing_unavailable")
        self._log.info("UserFileProcessingService.enqueue_processing_job", file_id=file_id, user_id=user_id)
        user_file = await self._processing.get_user_file(user_id=user_id, file_id=file_id)
        if user_file is None:
            raise UserFileProcessingNotFoundError("File not found")
        if user_file.status == STATUS_PENDING_UPLOAD:
            raise UserFileProcessingConflictError("File upload is not finalized")
        if user_file.status not in PROCESSABLE_FILE_STATUSES:
            raise UserFileProcessingConflictError("File cannot be processed in its current state")

        if not force:
            reusable = await self._processing.get_reusable_job(user_id=user_id, file_id=file_id)
            if reusable is not None:
                return ProcessFileResult(
                    file_id=file_id,
                    job_id=reusable.id,
                    file_status=user_file.status,
                    job_status=reusable.status,
                    reused_existing_job=True,
                )

            chunk_count = await self._processing.count_chunks(user_id=user_id, file_id=file_id)
            if user_file.status in {STATUS_READY, STATUS_READY_KEYWORD_ONLY} and chunk_count > 0:
                latest = await self._processing.get_latest_job(user_id=user_id, file_id=file_id)
                return ProcessFileResult(
                    file_id=file_id,
                    job_id=latest.id if latest is not None else None,
                    file_status=user_file.status,
                    job_status=latest.status if latest is not None else JOB_STATUS_SUCCEEDED,
                    reused_existing_job=latest is not None,
                )

        job = UserFileProcessingJob(
            id=new_user_file_processing_job_id(),
            user_id=user_id,
            file_id=file_id,
            job_type=JOB_TYPE_PROCESS_FILE,
            max_attempts=self._max_attempts,
            run_after=utc_now(),
            metadata={"force": force},
        )
        created = await self._processing.create_processing_job(job=job, set_file_processing=True)
        await self._uow.commit()
        return ProcessFileResult(
            file_id=file_id,
            job_id=created.id,
            file_status=STATUS_PROCESSING,
            job_status=created.status,
            reused_existing_job=False,
        )

    async def claim_next_job(
        self,
        *,
        worker_id: str,
        lease_seconds: int,
        limit_file_id: str | None = None,
    ) -> ClaimedUserFileProcessingJob | None:
        claimed = await self._processing.claim_next_job(
            worker_id=worker_id,
            lease_seconds=lease_seconds,
            now=utc_now(),
            limit_file_id=limit_file_id,
        )
        # Commit even without a claim: claiming also fails interrupted last attempts.
        await self._uow.commit()
        return claimed

    async def complete_claimed_job(
        self,
        *,
        claimed: ClaimedUserFileProcessingJob,
        payload: bytes | None,
        parser: UserFileParser,
        embedder: TextEmbedder | None,
        max_process_bytes: int,
    ) -> UserFileProcessingJob:
        """Parse, chunk and (when embeddings are on) embed a claimed upload.

        ``parser`` reads every format; this service never parses upload bytes
        itself. Chunks follow the document's headings (see
        :mod:`animama.app.services.user_file_chunking`). Chunking and the
        overview run in a worker thread so a large document does not stall the
        server's other requests. With embeddings off the file is ready for
        keyword search; only an embedding failure marks it ``ready_keyword_only``.
        """

        if payload is None:
            raise UserFileProcessingValidationError("Uploaded file was not found in private local storage")
        if len(payload) <= 0:
            raise UserFileProcessingValidationError("Uploaded object is empty")
        if len(payload) > max_process_bytes:
            raise UserFileProcessingValidationError(f"Uploaded object exceeds the {max_process_bytes} byte limit")

        content_sha256 = hashlib.sha256(payload).hexdigest()
        force_processing = (claimed.job.metadata or {}).get("force") is True
        if not force_processing:
            reused = await self._processing.reuse_processed_file(
                job_id=claimed.job.id,
                user_id=claimed.job.user_id,
                file_id=claimed.job.file_id,
                sha256=content_sha256,
                processed_at=utc_now(),
                embedding_model_id=embedder.model_id if embedder is not None else None,
            )
            if reused is not None:
                self._log.info(
                    "User-file processed content reused"
                    if reused.status == JOB_STATUS_SUCCEEDED
                    else "User-file processing stopped: the file was deleted",
                    job_id=claimed.job.id,
                    file_id=claimed.job.file_id,
                    user_id=claimed.job.user_id,
                )
                await self._uow.commit()
                return reused
            # End the reuse attempt's transaction, and any file-row lock it took,
            # before parsing: a delete must not wait for the parse and embedding.
            await self._uow.rollback()

        extension = claimed.normalized_extension.lower()
        parse_started = time.perf_counter()
        self._log.info(
            "User-file parsing started",
            job_id=claimed.job.id,
            file_id=claimed.job.file_id,
            user_id=claimed.job.user_id,
            extension=extension,
            byte_count=len(payload),
            parser=type(parser).__name__,
        )
        parsed = await parser.parse(
            payload=payload,
            filename=claimed.original_filename,
            extension=extension,
        )
        self._log.info(
            "User-file parsing finished",
            job_id=claimed.job.id,
            file_id=claimed.job.file_id,
            user_id=claimed.job.user_id,
            parser=parsed.parser_name,
            text_chars=len(parsed.text),
            duration_seconds=round(time.perf_counter() - parse_started, 3),
        )

        chunk_started = time.perf_counter()
        self._log.info(
            "User-file chunking started",
            job_id=claimed.job.id,
            file_id=claimed.job.file_id,
            user_id=claimed.job.user_id,
            parser=parsed.parser_name,
        )
        chunks = await asyncio.to_thread(chunk_parsed_user_file_document, parsed, max_tokens=self._chunk_max_tokens)
        self._log.info(
            "User-file chunking finished",
            job_id=claimed.job.id,
            file_id=claimed.job.file_id,
            user_id=claimed.job.user_id,
            chunk_count=len(chunks),
            duration_seconds=round(time.perf_counter() - chunk_started, 3),
        )
        if not chunks:
            raise UserFileProcessingValidationError(NO_SEARCHABLE_TEXT_ERROR)

        overview_warning: str | None = None
        try:
            overview = await asyncio.to_thread(
                build_user_file_overview, filename=claimed.original_filename, document=parsed
            )
        except Exception as exc:
            message = str(exc).strip() or exc.__class__.__name__
            overview_warning = f"Overview generation failed; using safe fallback: {message[:300]}"
            self._log.warning(
                "User-file overview generation failed",
                job_id=claimed.job.id,
                file_id=claimed.job.file_id,
                user_id=claimed.job.user_id,
                error=message,
            )
            overview = await asyncio.to_thread(
                fallback_user_file_overview, filename=claimed.original_filename, document=parsed
            )

        embedding_warning: str | None = None
        embedding_model_id: str | None = None
        embedded_chunks = chunks
        if embedder is not None:
            embedding_inputs = [chunk.embedding_text or chunk.text for chunk in chunks]
            embedding_started = time.perf_counter()
            self._log.info(
                "User-file embedding started",
                job_id=claimed.job.id,
                file_id=claimed.job.file_id,
                user_id=claimed.job.user_id,
                chunk_count=len(chunks),
                contextualized_chunk_count=sum(1 for chunk in chunks if chunk.embedding_text),
                input_chars=sum(len(text) for text in embedding_inputs),
            )
            try:
                vectors = await embedder.embed_texts(embedding_inputs)
                self._log.info(
                    "User-file embedding finished",
                    job_id=claimed.job.id,
                    file_id=claimed.job.file_id,
                    user_id=claimed.job.user_id,
                    chunk_count=len(chunks),
                    vector_count=len(vectors),
                    duration_seconds=round(time.perf_counter() - embedding_started, 3),
                )
                if len(vectors) == len(chunks):
                    embedding_model_id = embedder.model_id
                    embedded_chunks = [
                        UserFileChunkDraft(
                            chunk_index=chunk.chunk_index,
                            text=chunk.text,
                            char_count=chunk.char_count,
                            token_estimate=chunk.token_estimate,
                            metadata=chunk.metadata,
                            embedding_text=chunk.embedding_text,
                            embedding=vector,
                        )
                        for chunk, vector in zip(chunks, vectors, strict=True)
                    ]
                else:
                    embedding_warning = "Embedding provider returned an unexpected number of vectors"
            except Exception as exc:
                self._log.warning(
                    "User-file embedding failed",
                    job_id=claimed.job.id,
                    file_id=claimed.job.file_id,
                    user_id=claimed.job.user_id,
                    duration_seconds=round(time.perf_counter() - embedding_started, 3),
                    error=str(exc),
                )
                embedding_warning = f"Embedding failed: {exc}"

        file_status = STATUS_READY if embedding_warning is None else STATUS_READY_KEYWORD_ONLY
        processing_warnings = [warning for warning in (embedding_warning, overview_warning) if warning]
        processing_metadata: dict[str, Any] = {
            "parser": parsed.parser_name,
            "source_extension": extension,
            "embedded": embedding_model_id is not None,
            "warnings": processing_warnings,
            "parser_metadata": {
                key: value for key, value in parsed.metadata.items() if key not in TRANSIENT_PARSER_METADATA
            },
        }
        completed = await self._processing.replace_chunks_and_mark_success(
            job_id=claimed.job.id,
            user_id=claimed.job.user_id,
            file_id=claimed.job.file_id,
            sha256=content_sha256,
            chunks=embedded_chunks,
            file_status=file_status,
            processing_metadata=processing_metadata,
            file_metadata_updates={"overview": serialize_user_file_overview(overview)},
            processed_at=utc_now(),
            embedding_model_id=embedding_model_id,
        )
        await self._uow.commit()
        return completed

    async def record_claimed_job_failure(
        self,
        *,
        claimed: ClaimedUserFileProcessingJob,
        error: str,
        retryable: bool = True,
    ) -> UserFileProcessingJob:
        """Record a failed attempt; see :func:`is_retryable_processing_failure` for ``retryable``.

        A retryable failure is queued again with backoff until the attempt
        limit; otherwise the job and its file fail now with ``error``.
        """

        retry_delay = _retry_delay_seconds(claimed.job.attempts)
        updated = await self._processing.mark_job_failure(
            job_id=claimed.job.id,
            user_id=claimed.job.user_id,
            file_id=claimed.job.file_id,
            error=error,
            now=utc_now(),
            retry_delay_seconds=retry_delay,
            retryable=retryable,
        )
        await self._uow.commit()
        return updated

    async def release_claimed_job(self, *, claimed: ClaimedUserFileProcessingJob, worker_id: str) -> bool:
        """Return a job this worker stopped processing to the queue now, without spending its attempt.

        Only a job still running under ``worker_id`` is released; its file stays
        at Processing. Returns whether the job was released.
        """

        released = await self._processing.release_claimed_job(
            job_id=claimed.job.id,
            worker_id=worker_id,
            now=utc_now(),
        )
        await self._uow.commit()
        return released

    async def delete_chunks_for_file(self, *, user_id: str, file_id: str) -> None:
        await self._processing.delete_chunks_for_file(user_id=user_id, file_id=file_id)
        await self._uow.commit()

    async def search(
        self,
        *,
        user_id: str,
        query: str,
        mode: SearchMode,
        limit: int,
        file_ids: list[str] | None = None,
        embedder: TextEmbedder | None = None,
    ) -> UserFileSearchResults:
        return await search_user_file_chunks(
            processing=self._processing,
            user_id=user_id,
            query=query,
            mode=mode,
            limit=limit,
            file_ids=file_ids,
            embedder=embedder,
        )

    async def _owned_file_filters(self, *, user_id: str, file_ids: list[str] | None) -> list[str] | None:
        return await _owned_file_filters(processing=self._processing, user_id=user_id, file_ids=file_ids)


EMBEDDINGS_OFF_DETAIL = "Embeddings are off. Choose an embedding model in App Settings."
REEMBEDDING_WARNING = "Files are being re-embedded; using keyword search until it finishes."


async def search_user_file_chunks(
    *,
    processing: UserFileProcessingRepository,
    user_id: str,
    query: str,
    mode: SearchMode,
    limit: int,
    file_ids: list[str] | None = None,
    embedder: TextEmbedder | None = None,
) -> UserFileSearchResults:
    """Search current-user processed upload chunks through the shared retrieval policy.

    Semantic matching compares only vectors from the embedder's model. Hybrid
    search uses keyword retrieval alone while embeddings are off or while the
    searched files wait for re-embedding.
    """

    normalized_query = query.strip()
    if not normalized_query:
        raise UserFileProcessingValidationError("Search query is required")
    bounded_limit = min(max(1, limit), 50)
    filters = await _owned_file_filters(processing=processing, user_id=user_id, file_ids=file_ids)

    warnings: list[str] = []
    if mode == SEARCH_MODE_KEYWORD:
        results = await processing.keyword_search(
            user_id=user_id,
            query=normalized_query,
            limit=bounded_limit,
            file_ids=filters,
        )
        return UserFileSearchResults(query=normalized_query, mode=mode, results=results, warnings=warnings)

    if mode == SEARCH_MODE_SEMANTIC:
        if embedder is None:
            raise UserFileProcessingUnavailableError(EMBEDDINGS_OFF_DETAIL)
        if await _reembedding_pending(processing, user_id=user_id, embedder=embedder, file_ids=filters):
            warnings.append("Files are being re-embedded; results include only re-embedded chunks.")
        embedding = await _embed_query(embedder, normalized_query)
        results = await processing.semantic_search(
            user_id=user_id,
            embedding=embedding,
            embedding_model_id=embedder.model_id,
            limit=bounded_limit,
            file_ids=filters,
        )
        return UserFileSearchResults(query=normalized_query, mode=mode, results=results, warnings=warnings)

    if mode != SEARCH_MODE_HYBRID:
        raise UserFileProcessingValidationError("Unsupported search mode")

    keyword_results = await processing.keyword_search(
        user_id=user_id,
        query=normalized_query,
        limit=bounded_limit * 2,
        file_ids=filters,
    )
    semantic_results: list[UserFileSearchResult] = []
    if embedder is not None:
        if await _reembedding_pending(processing, user_id=user_id, embedder=embedder, file_ids=filters):
            warnings.append(REEMBEDDING_WARNING)
        else:
            try:
                embedding = await _embed_query(embedder, normalized_query)
                semantic_results = await processing.semantic_search(
                    user_id=user_id,
                    embedding=embedding,
                    embedding_model_id=embedder.model_id,
                    limit=bounded_limit * 2,
                    file_ids=filters,
                )
            except UserFileProcessingUnavailableError as exc:
                warnings.append(exc.detail)

    fused = _reciprocal_rank_fusion(keyword_results, semantic_results, limit=bounded_limit)
    return UserFileSearchResults(query=normalized_query, mode=mode, results=fused, warnings=warnings)


async def _reembedding_pending(
    processing: UserFileProcessingRepository,
    *,
    user_id: str,
    embedder: TextEmbedder,
    file_ids: list[str] | None,
) -> bool:
    stale = await processing.count_stale_chunks(
        user_id=user_id, embedding_model_id=embedder.model_id, file_ids=file_ids
    )
    return stale > 0


async def _owned_file_filters(
    *,
    processing: UserFileProcessingRepository,
    user_id: str,
    file_ids: list[str] | None,
) -> list[str] | None:
    if not file_ids:
        return None
    owned: list[str] = []
    for file_id in dict.fromkeys(file_ids):
        user_file = await processing.get_user_file(user_id=user_id, file_id=file_id)
        if user_file is None:
            raise UserFileProcessingNotFoundError("File not found")
        owned.append(file_id)
    return owned


async def _embed_query(embedder: TextEmbedder, query: str) -> list[float]:
    try:
        vectors = await embedder.embed_texts([query])
    except Exception as exc:
        raise UserFileProcessingUnavailableError(f"Semantic search embedding failed: {exc}") from exc
    if not vectors or not vectors[0]:
        raise UserFileProcessingUnavailableError("Semantic search embedding returned no vector")
    return [float(value) for value in vectors[0]]


def _reciprocal_rank_fusion(
    keyword_results: Iterable[UserFileSearchResult],
    semantic_results: Iterable[UserFileSearchResult],
    *,
    limit: int,
) -> list[UserFileSearchResult]:
    by_id: dict[str, UserFileSearchResult] = {}
    scores: dict[str, float] = {}
    match_types: dict[str, set[str]] = {}
    for ranked_results, match_type in ((list(keyword_results), "keyword"), (list(semantic_results), "semantic")):
        for rank, result in enumerate(ranked_results, start=1):
            by_id.setdefault(result.chunk_id, result)
            scores[result.chunk_id] = scores.get(result.chunk_id, 0.0) + 1.0 / (RRF_K + rank)
            match_types.setdefault(result.chunk_id, set()).add(match_type)

    fused: list[UserFileSearchResult] = []
    for chunk_id, score in sorted(
        scores.items(),
        key=lambda item: (-item[1], by_id[item[0]].file_id, by_id[item[0]].chunk_index),
    ):
        result = by_id[chunk_id]
        fused.append(
            UserFileSearchResult(
                chunk_id=result.chunk_id,
                file_id=result.file_id,
                chunk_index=result.chunk_index,
                text=result.text,
                score=score,
                metadata=result.metadata,
                original_filename=result.original_filename,
                normalized_extension=result.normalized_extension,
                match_type="+".join(sorted(match_types[chunk_id])),
            )
        )
        if len(fused) >= limit:
            break
    return fused


def _retry_delay_seconds(attempts: int) -> int:
    return min(300, 1 << max(0, attempts - 1))


__all__ = [
    "PROCESSABLE_FILE_STATUSES",
    "ProcessFileResult",
    "UserFileProcessingConflictError",
    "UserFileProcessingNotFoundError",
    "UserFileProcessingService",
    "UserFileProcessingServiceError",
    "UserFileProcessingUnavailableError",
    "UserFileProcessingValidationError",
    "UserFileSearchResults",
    "is_retryable_processing_failure",
    "new_user_file_processing_job_id",
    "read_claimed_upload",
    "search_user_file_chunks",
]

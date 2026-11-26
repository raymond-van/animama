from __future__ import annotations

import asyncio
import hashlib
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from io import BytesIO
from types import SimpleNamespace
from typing import Any, cast

import pytest
from fastapi import HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from animama.adapters.content_store.private_file_store import (
    PrivateFileNotFoundError,
    PrivateFileReadError,
    PrivateFileSizeMismatchError,
)
from animama.adapters.parsers.dispatch import parse_user_file
from animama.adapters.parsers.isolated_user_file_parser import UserFileParseChildError
from animama.adapters.parsers.rejections import ENCRYPTED_DOCUMENT_REASON
from animama.adapters.parsers.text_user_file_parser import parse_text_user_file
from animama.adapters.repositories.sqlalchemy.runtime_worker_repo import record_document_heartbeat
from animama.adapters.repositories.sqlalchemy.uow import SQLAlchemyUnitOfWork
from animama.adapters.repositories.sqlalchemy.user_file_processing_repo import SQLAlchemyUserFileProcessingRepository
from animama.adapters.repositories.sqlalchemy.user_file_repo import SQLAlchemyUserFileRepository
from animama.app.ports.private_file_storage import PrivateFileStorage
from animama.app.ports.user_file_parser_port import UserFileParseRejectedError
from animama.app.ports.user_file_processing_port import UserFileProcessingRepository
from animama.app.services import user_file_processing_service as processing_service_module
from animama.app.services.user_file_chunking import chunk_parsed_user_file_document
from animama.app.services.user_file_processing_service import (
    UserFileProcessingService,
    UserFileProcessingUnavailableError,
    UserFileProcessingValidationError,
    is_retryable_processing_failure,
    read_claimed_upload,
)
from animama.domain.request_principal import RequestPrincipal
from animama.domain.user_file import (
    STATUS_FAILED,
    STATUS_PROCESSING,
    STATUS_READY,
    STATUS_READY_KEYWORD_ONLY,
    STATUS_UPLOADED,
)
from animama.domain.user_file_processing import (
    JOB_STATUS_FAILED,
    JOB_STATUS_QUEUED,
    JOB_STATUS_RUNNING,
    JOB_STATUS_SUCCEEDED,
    PROCESSING_INTERRUPTED_ERROR,
    ClaimedUserFileProcessingJob,
    ParsedUserFileDocument,
    UserFileChunkDraft,
    UserFileOutlineItem,
    UserFileProcessingJob,
    UserFileSearchResult,
    markdown_table,
)
from animama.orm.user_file import ORMUserFile
from animama.orm.user_file_chunk import ORMUserFileChunk
from animama.orm.user_file_processing_job import ORMUserFileProcessingJob
from animama.server.model_roles import ModelRoleSettings
from animama.server.routers import user_files as user_files_router
from animama.server.schemas.user_file import PyUserFileProcessRequest, PyUserFileSearchRequest
from tests.user_file_fixtures import IMAGE_PAGE, pdf_bytes, text_page


class _FakeEmbedder:
    model_id = "test:embedding"

    async def embed_texts(self, texts):
        return [[1.0, 0.0, float(index)] for index, _text in enumerate(texts)]


class _RecordingEmbedder:
    model_id = "test:embedding"

    def __init__(self) -> None:
        self.texts: list[str] = []

    async def embed_texts(self, texts):
        self.texts = list(texts)
        return [[1.0, 0.0, float(index)] for index, _text in enumerate(texts)]


class _FailingEmbedder:
    model_id = "test:embedding"

    async def embed_texts(self, texts):
        raise RuntimeError(f"embedding unavailable for {len(texts)} chunks")


class _HybridRepo:
    def __init__(self, *, stale_chunks: int = 0) -> None:
        self.stale_chunks = stale_chunks
        self.semantic_model_ids: list[str] = []

    async def count_stale_chunks(
        self, *, user_id: str, embedding_model_id: str, file_ids: list[str] | None = None
    ) -> int:
        return self.stale_chunks

    async def get_user_file(self, *, user_id: str, file_id: str, include_deleted: bool = False):
        return SimpleNamespace(id=file_id, user_id=user_id)

    async def keyword_search(self, *, user_id: str, query: str, limit: int, file_ids: list[str] | None = None):
        return [
            UserFileSearchResult(
                chunk_id="chunk-a",
                file_id="file-1",
                chunk_index=0,
                text="keyword",
                score=0.8,
                metadata={},
                original_filename="a.txt",
                normalized_extension=".txt",
                match_type="keyword",
            ),
            UserFileSearchResult(
                chunk_id="chunk-b",
                file_id="file-1",
                chunk_index=1,
                text="both",
                score=0.5,
                metadata={},
                original_filename="a.txt",
                normalized_extension=".txt",
                match_type="keyword",
            ),
        ]

    async def semantic_search(
        self,
        *,
        user_id: str,
        embedding: list[float],
        embedding_model_id: str,
        limit: int,
        file_ids: list[str] | None = None,
    ):
        self.semantic_model_ids.append(embedding_model_id)
        return [
            UserFileSearchResult(
                chunk_id="chunk-b",
                file_id="file-1",
                chunk_index=1,
                text="both",
                score=0.9,
                metadata={},
                original_filename="a.txt",
                normalized_extension=".txt",
                match_type="semantic",
            )
        ]


class _NoopUow:
    async def commit(self) -> None:
        pass

    async def rollback(self) -> None:
        pass


class _CapturingProcessingRepo:
    def __init__(self, *, reuse_result: UserFileProcessingJob | None = None) -> None:
        self.chunks: list[UserFileChunkDraft] = []
        self.file_metadata: dict[str, Any] | None = None
        self.file_metadata_updates: dict[str, Any] | None = None
        self.file_status: str | None = None
        self.sha256: str | None = None
        self.reuse_calls: list[dict[str, Any]] = []
        self.reuse_result = reuse_result

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
        self.reuse_calls.append(
            {
                "job_id": job_id,
                "user_id": user_id,
                "file_id": file_id,
                "sha256": sha256,
                "processed_at": processed_at,
                "embedding_model_id": embedding_model_id,
            }
        )
        return self.reuse_result

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
        self.chunks = chunks
        self.embedding_model_id = embedding_model_id
        self.file_metadata = processing_metadata
        self.file_metadata_updates = file_metadata_updates
        self.file_status = file_status
        self.sha256 = sha256
        return UserFileProcessingJob(
            id=job_id,
            user_id=user_id,
            file_id=file_id,
            status=JOB_STATUS_SUCCEEDED,
            finished_at=processed_at,
            metadata={"chunk_count": len(chunks)},
        )


class _StaticParser:
    def __init__(self, parsed: ParsedUserFileDocument) -> None:
        self.parsed = parsed

    async def parse(self, *, payload: bytes, filename: str, extension: str) -> ParsedUserFileDocument:
        return self.parsed


class _UnexpectedParser:
    async def parse(self, *, payload: bytes, filename: str, extension: str) -> ParsedUserFileDocument:
        pytest.fail("duplicate content should not be parsed")


class _RouterFileService:
    """The process route reads the file first: an image has no processing job."""

    async def get_user_file(self, *, user_id: str, file_id: str):
        if file_id == "missing":
            from animama.app.services.user_file_service import UserFileNotFoundError

            raise UserFileNotFoundError("File not found")
        return SimpleNamespace(id=file_id, user_id=user_id, metadata={})


class _RouterProcessingService:
    async def enqueue_processing_job(self, *, user_id: str, file_id: str, force: bool = False):
        if file_id == "missing":
            from animama.app.services.user_file_processing_service import UserFileProcessingNotFoundError

            raise UserFileProcessingNotFoundError("File not found")
        return SimpleNamespace(
            file_id=file_id,
            job_id="job-forced" if force else "job-1",
            file_status=STATUS_PROCESSING,
            job_status=JOB_STATUS_QUEUED,
            reused_existing_job=not force,
        )

    async def search(
        self,
        *,
        user_id: str,
        query: str,
        mode: str,
        limit: int,
        file_ids: list[str] | None,
        embedder: Any,
    ):
        return SimpleNamespace(
            query=query,
            mode=mode,
            warnings=[],
            results=[
                UserFileSearchResult(
                    chunk_id="chunk-1",
                    file_id="file-1",
                    chunk_index=0,
                    text="alpha result",
                    score=1.0,
                    metadata={},
                    original_filename="notes.txt",
                    normalized_extension=".txt",
                    match_type=mode,
                )
            ],
        )


def _now() -> datetime:
    return datetime.now(UTC)


@pytest.fixture
async def clean_user_file_tables(async_session):
    await async_session.execute(delete(ORMUserFileProcessingJob))
    await async_session.execute(delete(ORMUserFileChunk))
    await async_session.execute(delete(ORMUserFile))
    await async_session.commit()
    yield
    await async_session.execute(delete(ORMUserFileProcessingJob))
    await async_session.execute(delete(ORMUserFileChunk))
    await async_session.execute(delete(ORMUserFile))
    await async_session.commit()


async def _insert_file(
    session,
    *,
    file_id: str = "file-1",
    user_id: str = "user-1",
    status: str = STATUS_UPLOADED,
    extension: str = ".txt",
    storage_locator: str | None = None,
    original_filename: str | None = None,
    sha256: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    session.add(
        ORMUserFile(
            id=file_id,
            user_id=user_id,
            storage_locator=storage_locator or f"users/{user_id}/files/{file_id}/original{extension}",
            original_filename=original_filename or f"{file_id}{extension}",
            normalized_extension=extension,
            declared_content_type="text/plain",
            declared_size_bytes=64,
            stored_size_bytes=64,
            sha256=sha256,
            status=status,
            upload_expires_at=_now() + timedelta(minutes=10),
            metadata_=dict(metadata or {}),
        )
    )
    await session.commit()


async def _insert_job(
    session,
    *,
    job_id: str = "job-1",
    file_id: str = "file-1",
    user_id: str = "user-1",
    status: str = JOB_STATUS_QUEUED,
    attempts: int = 0,
    max_attempts: int = 3,
    locked_at: datetime | None = None,
    run_after: datetime | None = None,
) -> None:
    session.add(
        ORMUserFileProcessingJob(
            id=job_id,
            file_id=file_id,
            user_id=user_id,
            status=status,
            attempts=attempts,
            max_attempts=max_attempts,
            run_after=run_after or _now() - timedelta(seconds=1),
            locked_by="old-worker" if locked_at else None,
            locked_at=locked_at,
            metadata_={},
        )
    )
    await session.commit()


def _claimed_processing_job(
    *,
    file_id: str = "file-1",
    extension: str = ".pdf",
    force: bool = False,
) -> ClaimedUserFileProcessingJob:
    return ClaimedUserFileProcessingJob(
        job=UserFileProcessingJob(
            id=f"job-{file_id}",
            user_id="user-1",
            file_id=file_id,
            attempts=1,
            max_attempts=3,
            metadata={"force": True} if force else {},
        ),
        storage_locator=f"users/user-1/files/{file_id}/original{extension}",
        original_filename=f"{file_id}{extension}",
        normalized_extension=extension,
        stored_size_bytes=64,
        declared_size_bytes=64,
    )


async def test_worker_heartbeat_renews_only_its_current_job(async_session, clean_user_file_tables):
    """A job the worker left behind, such as one whose outcome failed to record, must let its lease expire."""

    before = _now() - timedelta(seconds=600)
    jobs = (
        ("own", JOB_STATUS_RUNNING),
        ("stranded", JOB_STATUS_RUNNING),
        ("foreign", JOB_STATUS_RUNNING),
        ("queued", JOB_STATUS_QUEUED),
    )
    for name, status in jobs:
        await _insert_file(async_session, file_id=name)
        await _insert_job(async_session, job_id=name, file_id=name, status=status, locked_at=before)
    foreign = await async_session.get(ORMUserFileProcessingJob, "foreign")
    foreign.locked_by = "other-worker"
    await async_session.commit()

    await record_document_heartbeat(
        async_session, instance_id="installation-worker", worker_id="old-worker", job_id="own"
    )
    async_session.expire_all()
    own = await async_session.get(ORMUserFileProcessingJob, "own")
    stranded = await async_session.get(ORMUserFileProcessingJob, "stranded")
    foreign = await async_session.get(ORMUserFileProcessingJob, "foreign")
    queued = await async_session.get(ORMUserFileProcessingJob, "queued")
    assert own.locked_at > _now() - timedelta(seconds=5)
    assert stranded.locked_at == before
    assert foreign.locked_at == before
    assert queued.locked_at == before
    assert queued.status == JOB_STATUS_QUEUED


async def test_idle_worker_heartbeat_renews_no_job(async_session, clean_user_file_tables):
    before = _now() - timedelta(seconds=600)
    await _insert_file(async_session, file_id="stranded")
    await _insert_job(async_session, job_id="stranded", file_id="stranded", status=JOB_STATUS_RUNNING, locked_at=before)

    await record_document_heartbeat(
        async_session, instance_id="installation-worker", worker_id="old-worker", job_id=None
    )
    async_session.expire_all()
    stranded = await async_session.get(ORMUserFileProcessingJob, "stranded")
    assert stranded.locked_at == before


@pytest.mark.asyncio
async def test_processing_enqueue_reuses_active_job_and_force_creates_new(
    async_session,
    clean_user_file_tables,
) -> None:
    await _insert_file(async_session, file_id="file-enqueue")
    service = UserFileProcessingService(
        processing=SQLAlchemyUserFileProcessingRepository(async_session),
        uow=SQLAlchemyUnitOfWork(async_session),
        max_attempts=3,
    )

    first = await service.enqueue_processing_job(user_id="user-1", file_id="file-enqueue")
    reused = await service.enqueue_processing_job(user_id="user-1", file_id="file-enqueue")
    forced = await service.enqueue_processing_job(user_id="user-1", file_id="file-enqueue", force=True)

    assert first.reused_existing_job is False
    assert reused.reused_existing_job is True
    assert reused.job_id == first.job_id
    assert forced.reused_existing_job is False
    assert forced.job_id != first.job_id


@pytest.mark.asyncio
async def test_process_endpoint_returns_accepted_response(monkeypatch) -> None:
    monkeypatch.setattr(user_files_router, "_service", lambda _session: _RouterFileService())
    monkeypatch.setattr(
        user_files_router, "_processing_service", lambda _session, **_policy: _RouterProcessingService()
    )

    response = await user_files_router.process_user_file(
        "file-1",
        session=AsyncSession(),
        user=RequestPrincipal(id="user-1"),
        req=PyUserFileProcessRequest(force=True),
    )

    assert response.file_id == "file-1"
    assert response.job_id == "job-forced"
    assert response.file_status == STATUS_PROCESSING
    assert response.job_status == JOB_STATUS_QUEUED
    assert response.reused_existing_job is False


@pytest.mark.asyncio
async def test_process_endpoint_enforces_current_user_not_found(monkeypatch) -> None:
    monkeypatch.setattr(user_files_router, "_service", lambda _session: _RouterFileService())
    monkeypatch.setattr(
        user_files_router, "_processing_service", lambda _session, **_policy: _RouterProcessingService()
    )

    with pytest.raises(HTTPException) as exc_info:
        await user_files_router.process_user_file(
            "missing",
            session=AsyncSession(),
            user=RequestPrincipal(id="user-1"),
            req=PyUserFileProcessRequest(),
        )

    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_debug_search_endpoint_returns_results_without_embedder_for_keyword(monkeypatch) -> None:
    monkeypatch.setattr(user_files_router, "_processing_service", lambda _session: _RouterProcessingService())

    async def _unexpected_embedder(*_args, **_kwargs):
        pytest.fail("keyword search should not resolve an embedder")

    monkeypatch.setattr(user_files_router, "role_embedder", _unexpected_embedder)

    response = await user_files_router.search_user_file_chunks(
        PyUserFileSearchRequest(query="alpha", mode="keyword", limit=5),
        session=AsyncSession(),
        user=RequestPrincipal(id="user-1"),
        roles=ModelRoleSettings(owner_roles_enabled=True),
    )

    assert response.query == "alpha"
    assert response.mode == "keyword"
    assert response.results[0].file_id == "file-1"


@pytest.mark.asyncio
async def test_claim_next_job_skips_locked_rows(async_session_factory, clean_user_file_tables) -> None:
    async with async_session_factory() as setup:
        await _insert_file(setup, file_id="file-lock-1")
        await _insert_file(setup, file_id="file-lock-2")
        await _insert_job(setup, job_id="job-lock-1", file_id="file-lock-1")
        await _insert_job(setup, job_id="job-lock-2", file_id="file-lock-2")

    async with async_session_factory() as session1, async_session_factory() as session2:
        repo1 = SQLAlchemyUserFileProcessingRepository(session1)
        repo2 = SQLAlchemyUserFileProcessingRepository(session2)
        claimed1 = await repo1.claim_next_job(worker_id="worker-1", lease_seconds=300, now=_now())
        claimed2 = await repo2.claim_next_job(worker_id="worker-2", lease_seconds=300, now=_now())

        assert claimed1 is not None
        assert claimed2 is not None
        assert claimed1.job.id == "job-lock-1"
        assert claimed2.job.id == "job-lock-2"

        await session1.rollback()
        await session2.rollback()


@pytest.mark.asyncio
async def test_claim_next_job_recovers_stale_running_lease(async_session, clean_user_file_tables) -> None:
    await _insert_file(async_session, file_id="file-stale")
    await _insert_job(
        async_session,
        job_id="job-stale",
        file_id="file-stale",
        status=JOB_STATUS_RUNNING,
        attempts=1,
        locked_at=_now() - timedelta(minutes=10),
    )
    repo = SQLAlchemyUserFileProcessingRepository(async_session)

    claimed = await repo.claim_next_job(worker_id="worker-new", lease_seconds=300, now=_now())

    assert claimed is not None
    assert claimed.job.id == "job-stale"
    assert claimed.job.attempts == 2
    assert claimed.job.locked_by == "worker-new"


@pytest.mark.asyncio
async def test_replace_chunks_success_and_search_modes(async_session, clean_user_file_tables) -> None:
    await _insert_file(
        async_session,
        file_id="file-search",
        metadata={"preserved": "yes", "overview": {"version": 0, "description": "stale"}},
    )
    await _insert_job(async_session, job_id="job-search", file_id="file-search", status=JOB_STATUS_RUNNING, attempts=1)
    repo = SQLAlchemyUserFileProcessingRepository(async_session)
    parsed = ParsedUserFileDocument(
        text="# Alpha\n\n" + "Alpha project notes. " * 8 + "\n\n# Beta\n\n" + "Beta budget table. " * 8,
        parser_name="test",
        metadata={"parser": "test", "format": "md"},
    )
    chunks = chunk_parsed_user_file_document(parsed, max_tokens=64)
    assert len(chunks) == 2

    completed = await repo.replace_chunks_and_mark_success(
        job_id="job-search",
        user_id="user-1",
        file_id="file-search",
        sha256="a" * 64,
        chunks=[
            type(chunk)(
                chunk_index=chunk.chunk_index,
                text=chunk.text,
                char_count=chunk.char_count,
                token_estimate=chunk.token_estimate,
                metadata=chunk.metadata,
                embedding=[1.0, 0.0, float(chunk.chunk_index)],
            )
            for chunk in chunks
        ],
        file_status=STATUS_READY,
        processing_metadata={"parser": "test"},
        file_metadata_updates={"overview": {"version": 1}},
        processed_at=_now(),
        embedding_model_id="model-a",
    )
    await async_session.commit()

    keyword = await repo.keyword_search(user_id="user-1", query="Alpha", limit=5)
    semantic = await repo.semantic_search(
        user_id="user-1", embedding=[1.0, 0.0, 0.0], embedding_model_id="model-a", limit=5
    )
    other_model = await repo.semantic_search(
        user_id="user-1", embedding=[1.0, 0.0, 0.0], embedding_model_id="model-b", limit=5
    )
    ordered_chunks = await repo.read_chunks(
        user_id="user-1",
        file_id="file-search",
        start_chunk=0,
        limit=5,
    )
    later_chunks = await repo.read_chunks(
        user_id="user-1",
        file_id="file-search",
        start_chunk=1,
        limit=1,
    )
    foreign_read = await repo.read_chunks(
        user_id="user-2",
        file_id="file-search",
        start_chunk=0,
        limit=5,
    )
    stored_file = await async_session.get(ORMUserFile, "file-search")

    assert completed.status == JOB_STATUS_SUCCEEDED
    assert keyword[0].file_id == "file-search"
    assert "Alpha" in keyword[0].text
    assert semantic[0].file_id == "file-search"
    # Vectors from another embedding model are never compared.
    assert other_model == []
    assert await repo.count_stale_chunks(user_id="user-1", embedding_model_id="model-a") == 0
    assert await repo.count_stale_chunks(user_id="user-1", embedding_model_id="model-b") == len(chunks)
    assert [chunk.chunk_index for chunk in ordered_chunks] == list(range(len(chunks)))
    assert [chunk.chunk_index for chunk in later_chunks] == ([1] if len(chunks) > 1 else [])
    assert foreign_read == []
    assert stored_file is not None
    assert stored_file.sha256 == "a" * 64
    assert stored_file.metadata_["preserved"] == "yes"
    assert stored_file.metadata_["processing"] == {"parser": "test", "chunk_count": len(chunks)}
    assert stored_file.metadata_["overview"] == {"version": 1}

    stored_file.status = STATUS_PROCESSING
    await async_session.flush()
    assert (
        await repo.read_chunks(
            user_id="user-1",
            file_id="file-search",
            start_chunk=0,
            limit=5,
        )
        == []
    )


@pytest.mark.asyncio
async def test_reuse_processed_file_clones_same_user_digest_result_atomically(
    async_session,
    clean_user_file_tables,
) -> None:
    digest = hashlib.sha256(b"same bytes").hexdigest()
    # The source is a row the retired Docling worker processed: its chunks,
    # overview and processing record are reused exactly as stored.
    await _insert_file(
        async_session,
        file_id="file-source",
        status=STATUS_READY,
        sha256=digest,
        metadata={
            "source_only": "not copied",
            "overview": {"version": 1, "description": "Reusable overview"},
            "processing": {"parser": "docling", "embedded": True, "chunk_count": 1},
        },
    )
    async_session.add(
        ORMUserFileChunk(
            id="chunk-file-source-000000",
            file_id="file-source",
            user_id="user-1",
            chunk_index=0,
            text="Reusable source chunk",
            embedding_text="Reusable\nReusable source chunk",
            embedding=[1.0, 2.0, 3.0],
            embedding_model_id="model-a",
            char_count=21,
            token_estimate=5,
            metadata_={
                "headings": ["Reusable"],
                "filename": "file-source.txt",
                "extension": ".txt",
            },
        )
    )
    await _insert_file(
        async_session,
        file_id="file-target",
        status=STATUS_PROCESSING,
        metadata={"preserved": "target", "overview": {"version": 0}},
    )
    await _insert_job(
        async_session,
        job_id="job-target",
        file_id="file-target",
        status=JOB_STATUS_RUNNING,
        attempts=1,
    )
    repo = SQLAlchemyUserFileProcessingRepository(async_session)

    completed = await repo.reuse_processed_file(
        job_id="job-target",
        user_id="user-1",
        file_id="file-target",
        sha256=digest,
        processed_at=_now(),
        embedding_model_id="model-a",
    )
    await async_session.commit()

    target = await async_session.get(ORMUserFile, "file-target")
    target_chunks = list(
        (
            await async_session.execute(select(ORMUserFileChunk).where(ORMUserFileChunk.file_id == "file-target"))
        ).scalars()
    )
    source_chunks = list(
        (
            await async_session.execute(select(ORMUserFileChunk).where(ORMUserFileChunk.file_id == "file-source"))
        ).scalars()
    )

    assert completed is not None
    assert completed.status == JOB_STATUS_SUCCEEDED
    assert completed.metadata is not None
    assert completed.metadata["content_reused"] is True
    assert target is not None
    assert target.status == STATUS_READY
    assert target.sha256 == digest
    assert target.metadata_["preserved"] == "target"
    assert "source_only" not in target.metadata_
    assert target.metadata_["overview"] == {"version": 1, "description": "Reusable overview"}
    assert target.metadata_["processing"] == {
        "parser": "docling",
        "embedded": True,
        "chunk_count": 1,
        "content_reused": True,
    }
    assert len(target_chunks) == 1
    assert target_chunks[0].id == "chunk-file-target-000000"
    assert target_chunks[0].text == "Reusable source chunk"
    assert target_chunks[0].embedding is not None
    assert list(target_chunks[0].embedding) == [1.0, 2.0, 3.0]
    assert target_chunks[0].embedding_model_id == "model-a"
    assert target_chunks[0].embedding_text == "Reusable\nReusable source chunk"
    assert target_chunks[0].metadata_ == {
        "headings": ["Reusable"],
        "filename": "file-target.txt",
        "extension": ".txt",
    }
    assert len(source_chunks) == 1
    assert source_chunks[0].id == "chunk-file-source-000000"


@pytest.mark.asyncio
async def test_reuse_processed_file_copies_only_vectors_from_the_current_model(
    async_session,
    clean_user_file_tables,
) -> None:
    digest = hashlib.sha256(b"same bytes").hexdigest()
    await _insert_file(async_session, file_id="file-source", status=STATUS_READY, sha256=digest)
    async_session.add(
        ORMUserFileChunk(
            id="chunk-file-source-000000",
            file_id="file-source",
            user_id="user-1",
            chunk_index=0,
            text="Reusable source chunk",
            embedding=[1.0, 2.0, 3.0],
            embedding_model_id="model-old",
            char_count=21,
            token_estimate=5,
            metadata_={},
        )
    )
    await _insert_file(async_session, file_id="file-target", status=STATUS_PROCESSING)
    await _insert_job(async_session, job_id="job-target", file_id="file-target", status=JOB_STATUS_RUNNING, attempts=1)
    repo = SQLAlchemyUserFileProcessingRepository(async_session)

    await repo.reuse_processed_file(
        job_id="job-target",
        user_id="user-1",
        file_id="file-target",
        sha256=digest,
        processed_at=_now(),
        embedding_model_id="model-new",
    )
    await async_session.commit()

    target_chunk = await async_session.get(ORMUserFileChunk, "chunk-file-target-000000")
    assert target_chunk is not None
    assert target_chunk.text == "Reusable source chunk"
    assert target_chunk.embedding is None
    assert target_chunk.embedding_model_id is None
    assert (
        await repo.count_stale_chunks(user_id="user-1", embedding_model_id="model-new", file_ids=["file-target"]) == 1
    )


@pytest.mark.asyncio
async def test_reuse_processed_file_ignores_foreign_or_empty_digest_matches(
    async_session,
    clean_user_file_tables,
) -> None:
    digest = hashlib.sha256(b"same bytes").hexdigest()
    await _insert_file(
        async_session,
        file_id="file-foreign-source",
        user_id="user-2",
        status=STATUS_READY,
        sha256=digest,
    )
    async_session.add(
        ORMUserFileChunk(
            id="chunk-file-foreign-source-000000",
            file_id="file-foreign-source",
            user_id="user-2",
            chunk_index=0,
            text="Foreign content",
            embedding=None,
            char_count=15,
            token_estimate=4,
            metadata_={},
        )
    )
    await _insert_file(
        async_session,
        file_id="file-empty-source",
        status=STATUS_READY,
        sha256=digest,
    )
    await _insert_file(
        async_session,
        file_id="file-wrong-extension-source",
        status=STATUS_READY,
        extension=".md",
        sha256=digest,
    )
    async_session.add(
        ORMUserFileChunk(
            id="chunk-file-wrong-extension-source-000000",
            file_id="file-wrong-extension-source",
            user_id="user-1",
            chunk_index=0,
            text="Markdown content",
            embedding=None,
            char_count=16,
            token_estimate=4,
            metadata_={},
        )
    )
    await _insert_file(async_session, file_id="file-target", status=STATUS_PROCESSING)
    await _insert_job(
        async_session,
        job_id="job-target",
        file_id="file-target",
        status=JOB_STATUS_RUNNING,
        attempts=1,
    )
    repo = SQLAlchemyUserFileProcessingRepository(async_session)

    completed = await repo.reuse_processed_file(
        job_id="job-target",
        user_id="user-1",
        file_id="file-target",
        sha256=digest,
        processed_at=_now(),
    )

    target = await async_session.get(ORMUserFile, "file-target")
    assert completed is None
    assert target is not None
    assert target.status == STATUS_PROCESSING
    assert target.sha256 is None


@pytest.mark.asyncio
async def test_mark_job_failure_retries_then_fails_file(async_session, clean_user_file_tables) -> None:
    await _insert_file(async_session, file_id="file-failure", status=STATUS_PROCESSING)
    await _insert_job(
        async_session,
        job_id="job-failure",
        file_id="file-failure",
        status=JOB_STATUS_RUNNING,
        attempts=1,
        max_attempts=2,
    )
    repo = SQLAlchemyUserFileProcessingRepository(async_session)

    retried = await repo.mark_job_failure(
        job_id="job-failure",
        user_id="user-1",
        file_id="file-failure",
        error="parse failed",
        now=_now(),
        retry_delay_seconds=10,
    )
    await async_session.commit()
    failed_claim = await repo.claim_next_job(
        worker_id="worker-1",
        lease_seconds=300,
        now=_now() + timedelta(seconds=11),
    )
    assert failed_claim is not None
    final = await repo.mark_job_failure(
        job_id="job-failure",
        user_id="user-1",
        file_id="file-failure",
        error="parse failed again",
        now=_now(),
        retry_delay_seconds=10,
    )
    file_obj = await async_session.get(ORMUserFile, "file-failure")

    assert retried.status == JOB_STATUS_QUEUED
    assert final.status == JOB_STATUS_FAILED
    assert file_obj is not None
    assert file_obj.status == STATUS_FAILED


async def test_mark_job_failure_without_retry_fails_job_and_file_at_once(async_session, clean_user_file_tables) -> None:
    await _insert_file(async_session, file_id="file-permanent", status=STATUS_PROCESSING)
    await _insert_job(
        async_session,
        job_id="job-permanent",
        file_id="file-permanent",
        status=JOB_STATUS_RUNNING,
        attempts=1,
        max_attempts=3,
    )
    repo = SQLAlchemyUserFileProcessingRepository(async_session)

    failed = await repo.mark_job_failure(
        job_id="job-permanent",
        user_id="user-1",
        file_id="file-permanent",
        error="No searchable text was extracted from the uploaded file",
        now=_now(),
        retry_delay_seconds=10,
        retryable=False,
    )
    file_obj = await async_session.get(ORMUserFile, "file-permanent")

    assert (failed.status, failed.attempts, failed.locked_by) == (JOB_STATUS_FAILED, 1, None)
    assert failed.finished_at is not None
    assert file_obj is not None
    assert (file_obj.status, file_obj.last_error) == (
        STATUS_FAILED,
        "No searchable text was extracted from the uploaded file",
    )


async def test_claim_fails_interrupted_last_attempts_but_spares_files_with_newer_work(
    async_session_factory, clean_user_file_tables
) -> None:
    expired = _now() - timedelta(minutes=10)
    async with async_session_factory() as setup:
        await _insert_file(setup, file_id="file-interrupted", status=STATUS_PROCESSING)
        await _insert_job(
            setup,
            job_id="job-interrupted",
            file_id="file-interrupted",
            status=JOB_STATUS_RUNNING,
            attempts=3,
            max_attempts=3,
            locked_at=expired,
        )
        # A forced reprocess queued a newer job (due later) before the old last attempt expired.
        await _insert_file(setup, file_id="file-requeued", status=STATUS_PROCESSING)
        await _insert_job(
            setup,
            job_id="job-requeued-old",
            file_id="file-requeued",
            status=JOB_STATUS_RUNNING,
            attempts=3,
            max_attempts=3,
            locked_at=expired,
        )
        await _insert_job(
            setup,
            job_id="job-requeued-new",
            file_id="file-requeued",
            run_after=_now() + timedelta(minutes=5),
        )

    async with async_session_factory() as session:
        service = UserFileProcessingService(
            processing=SQLAlchemyUserFileProcessingRepository(session),
            uow=SQLAlchemyUnitOfWork(session),
        )
        assert await service.claim_next_job(worker_id="worker-1", lease_seconds=300) is None

    # The sweep committed although nothing was claimed.
    async with async_session_factory() as session:
        interrupted_job = await session.get(ORMUserFileProcessingJob, "job-interrupted")
        interrupted_file = await session.get(ORMUserFile, "file-interrupted")
        old_job = await session.get(ORMUserFileProcessingJob, "job-requeued-old")
        new_job = await session.get(ORMUserFileProcessingJob, "job-requeued-new")
        requeued_file = await session.get(ORMUserFile, "file-requeued")
    assert interrupted_job is not None and interrupted_file is not None
    assert (interrupted_job.status, interrupted_job.last_error) == (JOB_STATUS_FAILED, PROCESSING_INTERRUPTED_ERROR)
    assert (interrupted_job.locked_by, interrupted_job.locked_at) == (None, None)
    assert interrupted_job.finished_at is not None
    assert (interrupted_file.status, interrupted_file.last_error) == (STATUS_FAILED, PROCESSING_INTERRUPTED_ERROR)
    assert old_job is not None and new_job is not None and requeued_file is not None
    assert old_job.status == JOB_STATUS_FAILED
    assert new_job.status == JOB_STATUS_QUEUED
    assert (requeued_file.status, requeued_file.last_error) == (STATUS_PROCESSING, None)


def test_only_unexpected_failures_are_retried() -> None:
    assert is_retryable_processing_failure(RuntimeError("database restarted")) is True
    assert is_retryable_processing_failure(UserFileParseChildError("The file could not be read.")) is True
    assert is_retryable_processing_failure(UserFileProcessingValidationError("Uploaded object is empty")) is False
    assert is_retryable_processing_failure(UserFileParseRejectedError(ENCRYPTED_DOCUMENT_REASON)) is False


def _claimed_upload_from(storage: object) -> bytes | None:
    return read_claimed_upload(
        cast(PrivateFileStorage, storage),
        _claimed_processing_job(file_id="file-read", extension=".txt"),
        max_process_bytes=16,
    )


@pytest.mark.parametrize(
    "missing",
    [PrivateFileNotFoundError("gone"), PrivateFileSizeMismatchError(expected_size_bytes=64, actual_size_bytes=3)],
)
def test_missing_or_resized_upload_reads_as_absent(missing: Exception) -> None:
    """Reading again cannot help, so the job fails as a missing upload."""

    class Storage:
        @contextmanager
        def open_bounded(self, locator: str, *, expected_size_bytes: int) -> Iterator[SimpleNamespace]:
            raise missing
            yield SimpleNamespace()

    assert _claimed_upload_from(Storage()) is None


@pytest.mark.parametrize(
    "failure",
    [PrivateFileReadError("Private file changed or became unreadable"), PermissionError(13, "Permission denied")],
)
def test_other_upload_read_errors_propagate_so_the_job_retries(failure: Exception) -> None:
    class Storage:
        @contextmanager
        def open_bounded(self, locator: str, *, expected_size_bytes: int) -> Iterator[SimpleNamespace]:
            raise failure
            yield SimpleNamespace()

    with pytest.raises(type(failure)):
        _claimed_upload_from(Storage())
    assert is_retryable_processing_failure(failure) is True


def test_upload_reads_at_most_one_byte_past_the_processing_limit() -> None:
    class Storage:
        @contextmanager
        def open_bounded(self, locator: str, *, expected_size_bytes: int) -> Iterator[SimpleNamespace]:
            yield SimpleNamespace(stream=BytesIO(b"x" * 64), size_bytes=64, sha256="unused")

    assert _claimed_upload_from(Storage()) == b"x" * 17


async def test_storing_and_reusing_embedded_chunks_keeps_the_event_loop_responsive(
    async_session_factory, clean_user_file_tables
) -> None:
    """Writing or copying a large file's vectors leaves other requests running (spec R1.6)."""

    digest = "e" * 64
    async with async_session_factory() as setup:
        for file_id in ("file-embedded", "file-duplicate"):
            await _insert_file(setup, file_id=file_id, status=STATUS_PROCESSING)
            await _insert_job(setup, job_id=f"job-{file_id}", file_id=file_id, status=JOB_STATUS_RUNNING, attempts=1)
    vector = [(index % 97) / 97 for index in range(1536)]
    chunks = [
        UserFileChunkDraft(
            chunk_index=index,
            text=f"Chunk {index} " * 40,
            char_count=400,
            token_estimate=100,
            metadata={"filename": "file-embedded.txt", "chunk_type": "prose"},
            embedding=vector,
        )
        for index in range(1200)
    ]
    gaps: list[float] = []

    async def tick() -> None:
        previous = time.perf_counter()
        while True:
            await asyncio.sleep(0.005)
            current = time.perf_counter()
            gaps.append(current - previous)
            previous = current

    async def longest_stall(write) -> tuple[float, float]:
        gaps.clear()
        ticker = asyncio.create_task(tick())
        await asyncio.sleep(0.02)
        started = time.perf_counter()
        try:
            async with async_session_factory() as session:
                await write(SQLAlchemyUserFileProcessingRepository(session))
                await session.commit()
        finally:
            ticker.cancel()
        return max(gaps), time.perf_counter() - started

    async def store(repo: SQLAlchemyUserFileProcessingRepository) -> None:
        await repo.replace_chunks_and_mark_success(
            job_id="job-file-embedded",
            user_id="user-1",
            file_id="file-embedded",
            sha256=digest,
            chunks=chunks,
            file_status=STATUS_READY,
            processing_metadata={"parser": "test"},
            processed_at=_now(),
            embedding_model_id="test:embedding",
        )

    async def reuse(repo: SQLAlchemyUserFileProcessingRepository) -> None:
        reused = await repo.reuse_processed_file(
            job_id="job-file-duplicate",
            user_id="user-1",
            file_id="file-duplicate",
            sha256=digest,
            processed_at=_now(),
            embedding_model_id="test:embedding",
        )
        assert reused is not None

    store_stall, store_elapsed = await longest_stall(store)
    reuse_stall, reuse_elapsed = await longest_stall(reuse)

    # Encoding every vector in one flush stalled the loop for about the whole write.
    assert store_stall < max(0.1, store_elapsed / 4)
    assert reuse_stall < max(0.1, reuse_elapsed / 4)
    async with async_session_factory() as session:
        copies = (
            (
                await session.execute(
                    select(ORMUserFileChunk)
                    .where(ORMUserFileChunk.file_id == "file-duplicate")
                    # Without ORDER BY, PostgreSQL may return rows in any order.
                    .order_by(ORMUserFileChunk.chunk_index)
                )
            )
            .scalars()
            .all()
        )
    assert len(copies) == len(chunks)
    assert all(copy.embedding_model_id == "test:embedding" and copy.embedding is not None for copy in copies)
    assert {copy.metadata_["filename"] for copy in copies} == {"file-duplicate.txt"}
    assert [copy.id for copy in copies] == [f"chunk-file-duplicate-{index:06d}" for index in range(len(chunks))]


async def test_complete_claimed_job_reads_every_format_through_the_injected_parser() -> None:
    """The server never parses upload bytes itself, even plain text."""

    class RecordingParser:
        def __init__(self) -> None:
            self.extensions: list[str] = []

        async def parse(self, *, payload: bytes, filename: str, extension: str) -> ParsedUserFileDocument:
            self.extensions.append(extension)
            return ParsedUserFileDocument(text=payload.decode(), parser_name="isolated", metadata={})

    parser = RecordingParser()
    repo = _CapturingProcessingRepo()
    service = UserFileProcessingService(processing=cast(UserFileProcessingRepository, repo), uow=_NoopUow())

    for extension in (".txt", ".json", ".pdf"):
        await service.complete_claimed_job(
            claimed=_claimed_processing_job(file_id=f"file{extension}", extension=extension),
            payload=b"Readable text",
            parser=parser,
            embedder=None,
            max_process_bytes=1024,
        )

    assert parser.extensions == [".txt", ".json", ".pdf"]
    assert repo.chunks[0].text == "Readable text"


async def test_complete_claimed_job_chunks_large_documents_off_the_event_loop() -> None:
    """Chunking and overviews of a large table leave the server responsive (spec R1.6)."""

    rows = [["name", "value", "notes"], *[[f"row {index}", str(index), "x" * 40] for index in range(6000)]]
    parsed = ParsedUserFileDocument(
        text=markdown_table(rows),
        parser_name="stdlib-tsv",
        metadata={"format": "tsv", "table_only": True},
        tables=[{"table_index": 0, "header": rows[0], "data_row_count": len(rows) - 1, "source": "tsv"}],
    )
    service = UserFileProcessingService(
        processing=cast(UserFileProcessingRepository, _CapturingProcessingRepo()), uow=_NoopUow()
    )
    gaps: list[float] = []

    async def tick() -> None:
        previous = time.perf_counter()
        while True:
            await asyncio.sleep(0.005)
            current = time.perf_counter()
            gaps.append(current - previous)
            previous = current

    ticker = asyncio.create_task(tick())
    started = time.perf_counter()
    try:
        await service.complete_claimed_job(
            claimed=_claimed_processing_job(file_id="file-large-table", extension=".tsv"),
            payload=b"large table",
            parser=_StaticParser(parsed),
            embedder=None,
            max_process_bytes=1024,
        )
    finally:
        ticker.cancel()
    elapsed = time.perf_counter() - started

    assert gaps
    # Blocking work would stall the loop for about the whole call.
    assert max(gaps) < max(0.1, elapsed / 2)


@pytest.mark.asyncio
async def test_complete_claimed_job_embeds_chunks_and_stores_their_vectors() -> None:
    parsed = ParsedUserFileDocument(
        text="# Field guide\n\nDisplay chunk text",
        parser_name="stdlib-text",
        metadata={"format": "md"},
    )
    repo = _CapturingProcessingRepo()
    embedder = _RecordingEmbedder()
    service = UserFileProcessingService(processing=cast(UserFileProcessingRepository, repo), uow=_NoopUow())

    completed = await service.complete_claimed_job(
        claimed=_claimed_processing_job(file_id="file-embedded", extension=".md"),
        payload=b"# Field guide",
        parser=_StaticParser(parsed),
        embedder=embedder,
        max_process_bytes=1024,
    )

    assert completed.status == JOB_STATUS_SUCCEEDED
    assert embedder.texts == ["Field guide\n\n# Field guide\n\nDisplay chunk text"]
    assert repo.file_status == STATUS_READY
    assert repo.sha256 == hashlib.sha256(b"# Field guide").hexdigest()
    assert len(repo.reuse_calls) == 1
    assert len(repo.chunks) == 1
    assert repo.chunks[0].text == "# Field guide\n\nDisplay chunk text"
    assert repo.chunks[0].embedding_text == embedder.texts[0]
    assert repo.chunks[0].embedding == [1.0, 0.0, 0.0]
    assert repo.embedding_model_id == "test:embedding"
    assert repo.reuse_calls[0]["embedding_model_id"] == "test:embedding"
    assert repo.file_metadata is not None
    assert repo.file_metadata["embedded"] is True
    assert repo.file_metadata_updates is not None
    assert repo.file_metadata_updates["overview"]["outline"] == [{"level": 1, "title": "Field guide"}]


@pytest.mark.asyncio
async def test_complete_claimed_job_reuses_verified_content_before_parsing() -> None:
    reused_job = UserFileProcessingJob(
        id="job-file-duplicate",
        user_id="user-1",
        file_id="file-duplicate",
        status=JOB_STATUS_SUCCEEDED,
        metadata={"content_reused": True, "chunk_count": 2},
    )
    repo = _CapturingProcessingRepo(reuse_result=reused_job)
    service = UserFileProcessingService(processing=cast(UserFileProcessingRepository, repo), uow=_NoopUow())
    payload = b"%PDF-1.7\nidentical bytes"

    completed = await service.complete_claimed_job(
        claimed=_claimed_processing_job(file_id="file-duplicate"),
        payload=payload,
        parser=_UnexpectedParser(),
        embedder=_FailingEmbedder(),
        max_process_bytes=1024,
    )

    assert completed is reused_job
    assert repo.chunks == []
    assert repo.reuse_calls[0]["sha256"] == hashlib.sha256(payload).hexdigest()


@pytest.mark.asyncio
async def test_complete_claimed_job_force_bypasses_content_reuse() -> None:
    parsed = ParsedUserFileDocument(
        text="Forced processing content.", parser_name="pypdfium2", metadata={"format": "pdf"}
    )
    repo = _CapturingProcessingRepo()
    service = UserFileProcessingService(processing=cast(UserFileProcessingRepository, repo), uow=_NoopUow())

    await service.complete_claimed_job(
        claimed=_claimed_processing_job(file_id="file-forced", force=True),
        payload=b"%PDF-1.7\nforced bytes",
        parser=_StaticParser(parsed),
        embedder=None,
        max_process_bytes=1024,
    )

    assert repo.reuse_calls == []
    assert len(repo.chunks) == 1


@pytest.mark.asyncio
async def test_complete_claimed_job_keeps_overview_when_embedding_fails() -> None:
    parsed = ParsedUserFileDocument(
        text="A durable overview remains available even when semantic embedding fails.",
        parser_name="pypdfium2",
        metadata={"format": "pdf"},
        source_outline=(UserFileOutlineItem(level=1, title="Overview title"),),
    )
    repo = _CapturingProcessingRepo()
    service = UserFileProcessingService(processing=cast(UserFileProcessingRepository, repo), uow=_NoopUow())

    await service.complete_claimed_job(
        claimed=_claimed_processing_job(file_id="file-embedding-failure"),
        payload=b"%PDF-1.7\nbody",
        parser=_StaticParser(parsed),
        embedder=_FailingEmbedder(),
        max_process_bytes=1024,
    )

    assert repo.file_status == STATUS_READY_KEYWORD_ONLY
    assert repo.file_metadata is not None
    assert repo.file_metadata["embedded"] is False
    assert repo.file_metadata_updates is not None
    assert repo.file_metadata_updates["overview"]["outline"] == [{"level": 1, "title": "Overview title"}]


@pytest.mark.asyncio
async def test_complete_claimed_job_uses_safe_overview_fallback_on_builder_failure(monkeypatch) -> None:
    parsed = ParsedUserFileDocument(
        text="Fallback source text remains safe and searchable.", parser_name="pypdfium2", metadata={"format": "pdf"}
    )
    repo = _CapturingProcessingRepo()
    service = UserFileProcessingService(processing=cast(UserFileProcessingRepository, repo), uow=_NoopUow())

    def _fail_overview(**_kwargs):
        raise RuntimeError("overview exploded")

    monkeypatch.setattr(processing_service_module, "build_user_file_overview", _fail_overview)

    await service.complete_claimed_job(
        claimed=_claimed_processing_job(file_id="file-overview-failure"),
        payload=b"%PDF-1.7\nbody",
        parser=_StaticParser(parsed),
        embedder=None,
        max_process_bytes=1024,
    )

    assert repo.file_metadata is not None
    assert any("Overview generation failed" in warning for warning in repo.file_metadata["warnings"])
    # Embeddings being off is not a failure: the file is ready for keyword search.
    assert repo.file_status == STATUS_READY
    assert repo.file_metadata["embedded"] is False
    assert not any("mbedding" in warning for warning in repo.file_metadata["warnings"])
    assert repo.embedding_model_id is None
    assert repo.file_metadata_updates is not None
    assert repo.file_metadata_updates["overview"] == {
        "version": 1,
        "description": "Fallback source text remains safe and searchable.",
        "outline": [],
        "method": "fallback_excerpt",
        "outline_truncated": False,
    }


async def test_complete_claimed_job_chunks_at_headings_within_the_configured_size() -> None:
    """Chunks follow headings, stay within the chunk size and embed their heading path (spec R4.1 to R4.3)."""

    # Each section fits 64 tokens and 256 characters; two together do not.
    sections = "\n\n".join(f"## Part {index}\n\n" + " ".join(["budget"] * 30) + "." for index in range(4))
    parsed = ParsedUserFileDocument(
        text=f"# Report\n\n{sections}", parser_name="stdlib-text", metadata={"format": "md"}
    )
    repo = _CapturingProcessingRepo()
    embedder = _RecordingEmbedder()
    service = UserFileProcessingService(
        processing=cast(UserFileProcessingRepository, repo), uow=_NoopUow(), chunk_max_tokens=64
    )

    await service.complete_claimed_job(
        claimed=_claimed_processing_job(file_id="file-headings", extension=".md"),
        payload=b"# Report",
        parser=_StaticParser(parsed),
        embedder=embedder,
        max_process_bytes=1024,
    )

    first_lines = [chunk.text.split("\n", 1)[0] for chunk in repo.chunks]
    assert first_lines == ["# Report", "## Part 1", "## Part 2", "## Part 3"]
    assert [chunk.metadata for chunk in repo.chunks] == [
        {"chunk_type": "prose", "headings": ["Report", f"Part {index}"]} for index in range(4)
    ]
    assert embedder.texts == [f"Report > Part {index}\n\n{chunk.text}" for index, chunk in enumerate(repo.chunks)]
    assert [chunk.embedding_text for chunk in repo.chunks] == embedder.texts
    assert all(chunk.token_estimate <= 64 for chunk in repo.chunks)


async def test_complete_claimed_job_records_pdf_pages_per_chunk_but_not_in_the_file_row() -> None:
    parsed = parse_user_file(
        payload=pdf_bytes(text_page(b"First page text."), IMAGE_PAGE, text_page(b"Third page text.")),
        filename="paper.pdf",
        extension=".pdf",
    )
    repo = _CapturingProcessingRepo()
    service = UserFileProcessingService(processing=cast(UserFileProcessingRepository, repo), uow=_NoopUow())

    await service.complete_claimed_job(
        claimed=_claimed_processing_job(file_id="file-paper"),
        payload=b"%PDF-1.4",
        parser=_StaticParser(parsed),
        embedder=None,
        max_process_bytes=1024,
    )

    assert [chunk.metadata for chunk in repo.chunks] == [{"chunk_type": "prose", "pages": [1, 3]}]
    assert repo.file_metadata is not None
    parser_metadata = repo.file_metadata["parser_metadata"]
    # Page offsets only serve chunking; the skipped pages stay recorded with the file.
    assert "pdf_pages" not in parser_metadata
    assert parser_metadata["page_count"] == 3 and parser_metadata["pdf_skipped_pages"] == [2]
    assert repo.file_metadata_updates is not None
    assert repo.file_metadata_updates["overview"]["description"].startswith("Page 2 has no selectable text. ")


async def test_processing_the_same_file_again_yields_the_same_chunks() -> None:
    steps = "\n\n".join(f"## Step {index}\n\n" + "Install the package and restart the app. " * 20 for index in range(5))
    parsed = ParsedUserFileDocument(text=f"# Guide\n\n{steps}", parser_name="stdlib-text", metadata={"format": "md"})
    results: list[list[UserFileChunkDraft]] = []
    for _attempt in range(2):
        repo = _CapturingProcessingRepo()
        service = UserFileProcessingService(
            processing=cast(UserFileProcessingRepository, repo), uow=_NoopUow(), chunk_max_tokens=100
        )
        await service.complete_claimed_job(
            claimed=_claimed_processing_job(file_id="file-repeat", extension=".md", force=True),
            payload=b"same bytes",
            parser=_StaticParser(parsed),
            embedder=None,
            max_process_bytes=1024,
        )
        results.append(repo.chunks)

    assert len(results[0]) > 1
    assert results[0] == results[1]


def test_text_parsers_validate_json_and_xml() -> None:
    parsed_json = parse_text_user_file(payload=b'{"b": 2, "a": 1}', filename="data.json", extension=".json")
    parsed_xml = parse_text_user_file(payload=b"<root><item /></root>", filename="data.xml", extension=".xml")

    assert '"a": 1' in parsed_json.text
    assert parsed_xml.text.startswith("<root>")


@pytest.mark.asyncio
async def test_hybrid_search_dedupes_with_rrf() -> None:
    service = UserFileProcessingService(processing=cast(UserFileProcessingRepository, _HybridRepo()), uow=_NoopUow())

    response = await service.search(
        user_id="user-1",
        query="both",
        mode="hybrid",
        limit=5,
        embedder=_FakeEmbedder(),
    )

    assert [result.chunk_id for result in response.results] == ["chunk-b", "chunk-a"]
    assert response.results[0].match_type == "keyword+semantic"


@pytest.mark.asyncio
async def test_hybrid_search_uses_keywords_while_embeddings_are_off_or_pending() -> None:
    pending = _HybridRepo(stale_chunks=3)
    off = _HybridRepo()

    while_pending = await UserFileProcessingService(
        processing=cast(UserFileProcessingRepository, pending), uow=_NoopUow()
    ).search(user_id="user-1", query="both", mode="hybrid", limit=5, embedder=_FakeEmbedder())
    while_off = await UserFileProcessingService(
        processing=cast(UserFileProcessingRepository, off), uow=_NoopUow()
    ).search(user_id="user-1", query="both", mode="hybrid", limit=5, embedder=None)

    assert {result.match_type for result in while_pending.results} == {"keyword"}
    assert pending.semantic_model_ids == []
    assert "re-embedded" in while_pending.warnings[0]
    assert {result.match_type for result in while_off.results} == {"keyword"}
    assert while_off.warnings == []


@pytest.mark.asyncio
async def test_semantic_search_compares_only_the_embedder_model_and_requires_embeddings() -> None:
    repo = _HybridRepo()
    service = UserFileProcessingService(processing=cast(UserFileProcessingRepository, repo), uow=_NoopUow())

    response = await service.search(user_id="user-1", query="both", mode="semantic", limit=5, embedder=_FakeEmbedder())
    with pytest.raises(UserFileProcessingUnavailableError, match="Embeddings are off"):
        await service.search(user_id="user-1", query="both", mode="semantic", limit=5, embedder=None)

    assert repo.semantic_model_ids == ["test:embedding"]
    assert response.results[0].chunk_id == "chunk-b"


@pytest.mark.asyncio
async def test_locked_file_read_sees_a_change_another_session_committed(async_session, clean_user_file_tables) -> None:
    await _insert_file(async_session)
    await async_session.commit()
    # Keep the row alive in this session, as a request that read it earlier would.
    held = await async_session.get(ORMUserFile, "file-1")
    assert held is not None and held.status == STATUS_UPLOADED
    await async_session.commit()
    async with async_sessionmaker(async_session.bind, expire_on_commit=False)() as other:
        await other.execute(update(ORMUserFile).where(ORMUserFile.id == "file-1").values(status=STATUS_READY))
        await other.commit()

    locked = await SQLAlchemyUserFileRepository(async_session).get_user_file_for_update(
        user_id="user-1", file_id="file-1"
    )
    await async_session.rollback()

    assert locked is not None
    assert locked.status == STATUS_READY

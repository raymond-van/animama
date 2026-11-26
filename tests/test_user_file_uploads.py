from __future__ import annotations

import hashlib
from collections.abc import Callable
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from io import BytesIO
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession

from animama.adapters.content_store.private_file_store import (
    FilesystemPrivateFileStorage,
    PrivateFileNotFoundError,
    PrivateFilePathError,
    PrivateFileReadError,
)
from animama.app.services import content_image
from animama.app.services.user_file_service import UserFileService
from animama.domain.request_principal import RequestPrincipal
from animama.domain.user_file import (
    STATUS_ABORTED,
    STATUS_DELETE_PENDING,
    STATUS_DELETED,
    STATUS_FAILED,
    STATUS_PENDING_UPLOAD,
    STATUS_READY,
    STATUS_UPLOADED,
    UserFile,
)
from animama.domain.user_file_processing import UserFileProcessingInfo
from animama.product_http.uploads import SpooledUpload
from animama.server import user_file_storage
from animama.server.config import Settings, settings
from animama.server.local_runtime import initialize_local_runtime
from animama.server.routers import user_files as user_files_router
from animama.server.schemas.user_file import PyUserFileUploadInitRequest


class _FakeUserFileRepository:
    def __init__(self, files: list[UserFile] | None = None) -> None:
        self.files: dict[str, UserFile] = {user_file.id: user_file for user_file in files or []}

    async def create_user_file(self, user_file: UserFile) -> UserFile:
        self.files[user_file.id] = user_file
        return user_file

    async def get_user_file(
        self,
        *,
        user_id: str,
        file_id: str,
        include_deleted: bool = False,
    ) -> UserFile | None:
        user_file = self.files.get(file_id)
        if user_file is None or user_file.user_id != user_id:
            return None
        if not include_deleted and user_file.status == STATUS_DELETED:
            return None
        return user_file

    async def get_user_file_for_update(
        self,
        *,
        user_id: str,
        file_id: str,
        include_deleted: bool = False,
    ) -> UserFile | None:
        return await self.get_user_file(user_id=user_id, file_id=file_id, include_deleted=include_deleted)

    async def list_user_files(self, *, user_id: str) -> list[UserFile]:
        files = [
            user_file
            for user_file in self.files.values()
            if user_file.user_id == user_id and user_file.status != STATUS_DELETED
        ]
        return sorted(files, key=lambda user_file: user_file.created_at or datetime.min, reverse=True)

    async def update_user_file(self, user_file: UserFile) -> UserFile:
        self.files[user_file.id] = user_file
        return user_file


class _FakeUnitOfWork:
    def __init__(self) -> None:
        self.commit_calls = 0
        self.rollback_calls = 0

    async def commit(self) -> None:
        self.commit_calls += 1

    async def rollback(self) -> None:
        self.rollback_calls += 1


class _FakeProcessingService:
    def __init__(self) -> None:
        self.deleted_chunks: list[tuple[str, str]] = []

    async def list_processing_info(self, *, user_id: str, file_ids: list[str]) -> dict[str, UserFileProcessingInfo]:
        return {file_id: UserFileProcessingInfo(file_id=file_id, chunk_count=0) for file_id in file_ids}

    async def delete_chunks_for_file(self, *, user_id: str, file_id: str) -> None:
        self.deleted_chunks.append((user_id, file_id))


def _user(user_id: str = "user-1") -> RequestPrincipal:
    return RequestPrincipal(id=user_id)


def _file(
    file_id: str = "file-1",
    *,
    user_id: str = "user-1",
    status: str = STATUS_PENDING_UPLOAD,
    declared_size_bytes: int = 12,
    created_at: datetime | None = None,
) -> UserFile:
    return UserFile(
        id=file_id,
        user_id=user_id,
        storage_locator=f"user-files/{user_id}/{file_id}/original",
        original_filename=f"{file_id}.txt",
        normalized_extension=".txt",
        declared_content_type="text/plain",
        declared_size_bytes=declared_size_bytes,
        status=status,
        upload_expires_at=datetime.now(UTC) + timedelta(minutes=10),
        metadata={},
        created_at=created_at,
    )


def _patch_service(monkeypatch: pytest.MonkeyPatch, repo: _FakeUserFileRepository, uow: _FakeUnitOfWork) -> None:
    monkeypatch.setattr(
        user_files_router,
        "_service",
        lambda _session: UserFileService(user_files=repo, uow=uow),
    )
    monkeypatch.setattr(user_files_router, "_processing_service", lambda _session: _FakeProcessingService())


@pytest.mark.asyncio
async def test_init_user_file_upload_returns_authenticated_local_put_and_file_id(monkeypatch) -> None:
    expires_at = datetime(2026, 6, 9, 12, 0, tzinfo=UTC)
    repo = _FakeUserFileRepository()
    uow = _FakeUnitOfWork()
    _patch_service(monkeypatch, repo, uow)

    monkeypatch.setattr(user_files_router, "new_user_file_id", lambda: "file-fixed")
    monkeypatch.setattr(user_files_router, "private_upload_expires_at", lambda: expires_at)

    response = await user_files_router.init_user_file_upload(
        PyUserFileUploadInitRequest(
            filename="notes.TXT",
            content_type="text/plain",
            size_bytes=12,
        ),
        session=AsyncSession(),
        user=_user(),
    )

    assert response.method == "PUT"
    assert response.file_id == "file-fixed"
    assert response.headers == {"Content-Type": "text/plain"}
    assert response.expires_at == expires_at
    assert response.upload_url == "/v1/files/file-fixed/content"
    assert repo.files["file-fixed"].storage_locator == "user-files/user-1/file-fixed/original"
    assert repo.files["file-fixed"].original_filename == "notes.TXT"
    assert repo.files["file-fixed"].normalized_extension == ".txt"
    assert repo.files["file-fixed"].status == STATUS_PENDING_UPLOAD
    assert uow.commit_calls == 1


@pytest.mark.asyncio
async def test_init_user_file_upload_rejects_unsupported_extension() -> None:
    with pytest.raises(HTTPException) as exc_info:
        await user_files_router.init_user_file_upload(
            PyUserFileUploadInitRequest(filename="run.sh", content_type="text/x-shellscript", size_bytes=12),
            session=AsyncSession(),
            user=_user(),
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Unsupported file extension"


@pytest.mark.parametrize("filename", ["paper.pdf", "brief.docx", "deck.pptx", "sheet.xlsx"])
@pytest.mark.asyncio
async def test_init_user_file_upload_accepts_phase_2_rich_extensions(monkeypatch, filename: str) -> None:
    expires_at = datetime(2026, 6, 9, 12, 0, tzinfo=UTC)
    repo = _FakeUserFileRepository()
    uow = _FakeUnitOfWork()
    _patch_service(monkeypatch, repo, uow)

    monkeypatch.setattr(user_files_router, "new_user_file_id", lambda: "file-fixed")
    monkeypatch.setattr(user_files_router, "private_upload_expires_at", lambda: expires_at)

    response = await user_files_router.init_user_file_upload(
        PyUserFileUploadInitRequest(filename=filename, content_type=None, size_bytes=12),
        session=AsyncSession(),
        user=_user(),
    )

    assert response.file_id == "file-fixed"
    assert repo.files["file-fixed"].normalized_extension == f".{filename.rsplit('.', 1)[1]}"


@pytest.mark.parametrize("filename", ["template.docm", "macro.xlsm", "slides.pptm", "archive.zip", "run.py"])
@pytest.mark.asyncio
async def test_init_user_file_upload_rejects_blocked_extensions(filename: str) -> None:
    with pytest.raises(HTTPException) as exc_info:
        await user_files_router.init_user_file_upload(
            PyUserFileUploadInitRequest(filename=filename, content_type=None, size_bytes=12),
            session=AsyncSession(),
            user=_user(),
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Unsupported file extension"


@pytest.mark.asyncio
async def test_init_user_file_upload_rejects_too_large_file() -> None:
    with pytest.raises(HTTPException) as exc_info:
        await user_files_router.init_user_file_upload(
            PyUserFileUploadInitRequest(
                filename="notes.txt",
                content_type="text/plain",
                size_bytes=settings.anima_user_file_max_upload_bytes + 1,
            ),
            session=AsyncSession(),
            user=_user(),
        )

    assert exc_info.value.status_code == 400
    assert "byte limit" in exc_info.value.detail


@pytest.mark.asyncio
async def test_init_user_file_upload_returns_503_when_local_target_cannot_be_built(monkeypatch) -> None:
    repo = _FakeUserFileRepository()
    uow = _FakeUnitOfWork()
    _patch_service(monkeypatch, repo, uow)
    monkeypatch.setattr(user_files_router, "private_upload_url", lambda *_args, **_kwargs: None)

    with pytest.raises(HTTPException) as exc_info:
        await user_files_router.init_user_file_upload(
            PyUserFileUploadInitRequest(filename="notes.txt", content_type="text/plain", size_bytes=12),
            session=AsyncSession(),
            user=_user(),
        )

    assert exc_info.value.status_code == 503
    assert exc_info.value.detail == "Failed to initialize upload"


@pytest.mark.asyncio
async def test_upload_user_file_content_promotes_exact_bytes_to_private_storage(monkeypatch) -> None:
    payload = b"hello local!"
    repo = _FakeUserFileRepository([_file(declared_size_bytes=len(payload))])
    uow = _FakeUnitOfWork()
    _patch_service(monkeypatch, repo, uow)
    captured: dict[str, object] = {}

    async def fake_spool(*_args, **_kwargs) -> SpooledUpload:
        return SpooledUpload(stream=BytesIO(payload), size_bytes=len(payload), sha256="unused")

    def fake_put(locator, content, *, content_type, content_length):
        captured.update(
            locator=locator,
            payload=content.read(),
            content_type=content_type,
            content_length=content_length,
        )
        return True

    monkeypatch.setattr(user_files_router, "spool_bounded_request", fake_spool)
    monkeypatch.setattr(user_files_router, "write_private_file_stream", fake_put)

    response = await user_files_router.upload_user_file_content(
        "file-1",
        request=object(),  # type: ignore[arg-type]
        session=AsyncSession(),
        user=_user(),
    )

    assert response.status_code == 204
    assert captured == {
        "locator": "user-files/user-1/file-1/original",
        "payload": payload,
        "content_type": "text/plain",
        "content_length": len(payload),
    }


@pytest.mark.asyncio
async def test_finalize_user_file_upload_returns_error_when_object_missing(monkeypatch) -> None:
    repo = _FakeUserFileRepository([_file()])
    uow = _FakeUnitOfWork()
    _patch_service(monkeypatch, repo, uow)
    monkeypatch.setattr(user_files_router, "private_file_metadata", lambda storage_locator: None)
    monkeypatch.setattr(user_files_router, "is_user_file_storage_locator", lambda storage_locator, user_id: True)

    with pytest.raises(HTTPException) as exc_info:
        await user_files_router.finalize_user_file_upload("file-1", session=AsyncSession(), user=_user())

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == "Uploaded object not found"
    assert repo.files["file-1"].status == STATUS_PENDING_UPLOAD
    assert uow.commit_calls == 0


@pytest.mark.asyncio
async def test_finalize_user_file_upload_rejects_size_mismatch(monkeypatch) -> None:
    repo = _FakeUserFileRepository([_file(declared_size_bytes=12)])
    uow = _FakeUnitOfWork()
    _patch_service(monkeypatch, repo, uow)
    monkeypatch.setattr(user_files_router, "private_file_metadata", lambda storage_locator: {"ContentLength": 13})
    monkeypatch.setattr(user_files_router, "is_user_file_storage_locator", lambda storage_locator, user_id: True)

    with pytest.raises(HTTPException) as exc_info:
        await user_files_router.finalize_user_file_upload("file-1", session=AsyncSession(), user=_user())

    assert exc_info.value.status_code == 409
    assert repo.files["file-1"].status == "failed"
    assert repo.files["file-1"].last_error == "Uploaded object size does not match declared size"
    assert uow.commit_calls == 1


@pytest.mark.asyncio
async def test_finalize_user_file_upload_updates_status_and_metadata(monkeypatch) -> None:
    repo = _FakeUserFileRepository([_file(declared_size_bytes=12)])
    uow = _FakeUnitOfWork()
    _patch_service(monkeypatch, repo, uow)
    monkeypatch.setattr(
        user_files_router,
        "private_file_metadata",
        lambda storage_locator: {"ContentLength": 12, "ContentType": "text/plain; charset=utf-8"},
    )
    monkeypatch.setattr(user_files_router, "is_user_file_storage_locator", lambda storage_locator, user_id: True)

    response = await user_files_router.finalize_user_file_upload("file-1", session=AsyncSession(), user=_user())

    assert response.file_id == "file-1"
    assert response.status == STATUS_UPLOADED
    assert response.stored_size_bytes == 12
    assert response.detected_content_type == "text/plain; charset=utf-8"
    assert repo.files["file-1"].status == STATUS_UPLOADED
    assert uow.commit_calls == 1


@pytest.mark.asyncio
async def test_list_and_get_user_files_only_return_current_users_files(monkeypatch) -> None:
    repo = _FakeUserFileRepository(
        [
            _file("file-old", user_id="user-1", created_at=datetime(2026, 1, 1)),
            _file("file-new", user_id="user-1", created_at=datetime(2026, 1, 2)),
            _file("file-other", user_id="user-2", created_at=datetime(2026, 1, 3)),
            _file("file-deleted", user_id="user-1", status=STATUS_DELETED, created_at=datetime(2026, 1, 4)),
        ]
    )
    uow = _FakeUnitOfWork()
    _patch_service(monkeypatch, repo, uow)

    listed = await user_files_router.list_user_files(session=AsyncSession(), user=_user("user-1"))

    assert [item.file_id for item in listed.files] == ["file-new", "file-old"]

    found = await user_files_router.get_user_file("file-new", session=AsyncSession(), user=_user("user-1"))
    assert found.file_id == "file-new"

    with pytest.raises(HTTPException) as exc_info:
        await user_files_router.get_user_file("file-other", session=AsyncSession(), user=_user("user-1"))

    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_delete_user_file_marks_deleted_when_object_delete_succeeds(monkeypatch) -> None:
    repo = _FakeUserFileRepository([_file(status=STATUS_UPLOADED)])
    uow = _FakeUnitOfWork()
    _patch_service(monkeypatch, repo, uow)
    monkeypatch.setattr(user_files_router, "delete_private_file", lambda storage_locator: True)

    response = await user_files_router.delete_user_file("file-1", session=AsyncSession(), user=_user())

    assert response.status_code == 204
    assert repo.files["file-1"].status == STATUS_DELETED
    assert repo.files["file-1"].last_error is None
    assert uow.commit_calls == 1


@pytest.mark.asyncio
async def test_delete_user_file_marks_delete_pending_when_object_delete_fails(monkeypatch) -> None:
    repo = _FakeUserFileRepository([_file(status=STATUS_UPLOADED)])
    uow = _FakeUnitOfWork()
    _patch_service(monkeypatch, repo, uow)
    monkeypatch.setattr(user_files_router, "delete_private_file", lambda storage_locator: False)

    response = await user_files_router.delete_user_file("file-1", session=AsyncSession(), user=_user())

    assert response.status_code == 204
    assert repo.files["file-1"].status == STATUS_DELETE_PENDING
    assert repo.files["file-1"].last_error == "Delete cleanup will retry"
    assert uow.commit_calls == 1


@pytest.mark.asyncio
async def test_abort_user_file_upload_marks_aborted_when_object_delete_succeeds(monkeypatch) -> None:
    repo = _FakeUserFileRepository([_file(status=STATUS_PENDING_UPLOAD)])
    uow = _FakeUnitOfWork()
    _patch_service(monkeypatch, repo, uow)
    monkeypatch.setattr(user_files_router, "delete_private_file", lambda storage_locator: True)

    response = await user_files_router.abort_user_file_upload("file-1", session=AsyncSession(), user=_user())

    assert response.status_code == 204
    assert repo.files["file-1"].status == STATUS_ABORTED
    assert repo.files["file-1"].last_error is None
    assert uow.commit_calls == 1


@pytest.mark.asyncio
async def test_abort_user_file_upload_conflicts_when_already_uploaded(monkeypatch) -> None:
    repo = _FakeUserFileRepository([_file(status=STATUS_UPLOADED)])
    uow = _FakeUnitOfWork()
    _patch_service(monkeypatch, repo, uow)
    monkeypatch.setattr(
        user_files_router,
        "delete_private_file",
        lambda storage_locator: pytest.fail("uploaded files should not be deleted through abort"),
    )

    with pytest.raises(HTTPException) as exc_info:
        await user_files_router.abort_user_file_upload("file-1", session=AsyncSession(), user=_user())

    assert exc_info.value.status_code == 409
    assert repo.files["file-1"].status == STATUS_UPLOADED
    assert uow.commit_calls == 0


class _FakeImageStorage:
    """One stored object, read, replaced and deleted through the router's storage helpers."""

    def __init__(self, content: bytes) -> None:
        self.content: bytes | None = content
        self.writes = 0
        self.write_succeeds = True
        self.read_error: Exception | None = None
        # Runs while the router is reading the upload, before any row lock is taken.
        self.while_decoding: Callable[[], None] = lambda: None

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(user_files_router, "private_file_metadata", self._head)
        monkeypatch.setattr(user_files_router, "is_user_file_storage_locator", lambda storage_locator, user_id: True)
        monkeypatch.setattr(user_files_router, "open_private_file", self._open)
        monkeypatch.setattr(user_files_router, "write_private_file_stream", self._write)
        monkeypatch.setattr(user_files_router, "delete_private_file", self._delete)

    def _head(self, storage_locator: str) -> dict[str, object] | None:
        return None if self.content is None else {"ContentLength": len(self.content)}

    @contextmanager
    def _open(self, storage_locator: str, *, expected_size_bytes: int):
        if self.read_error is not None:
            raise self.read_error
        content = self.content
        if content is None:
            raise PrivateFileNotFoundError("missing")
        assert expected_size_bytes == len(content)
        self.while_decoding()
        yield SimpleNamespace(
            stream=BytesIO(content), size_bytes=len(content), sha256=hashlib.sha256(content).hexdigest()
        )

    def _write(self, storage_locator: str, content: BytesIO, *, content_type: str, content_length: int) -> bool:
        if not self.write_succeeds:
            return False
        self.content = content.read()
        assert len(self.content) == content_length
        self.writes += 1
        return True

    def _delete(self, storage_locator: str) -> bool:
        self.content = None
        return True


def _photo_with_location() -> bytes:
    source = Image.new("RGB", (40, 20), "red")
    exif = source.getexif()
    exif.get_ifd(0x8825)[2] = (40.0, 26.0, 46.0)  # GPSLatitude
    output = BytesIO()
    source.save(output, format="JPEG", exif=exif)
    return output.getvalue()


def _image_file(content: bytes, *, status: str = STATUS_PENDING_UPLOAD) -> UserFile:
    user_file = _file(status=status, declared_size_bytes=len(content))
    user_file.original_filename = "photo.jpg"
    user_file.normalized_extension = ".jpg"
    user_file.declared_content_type = "image/jpeg"
    user_file.metadata = {"kind": "image"}
    return user_file


@pytest.mark.asyncio
@pytest.mark.parametrize("filename", ["shot.PNG", "photo.jpg", "photo.jpeg", "drawing.webp", "clip.gif"])
async def test_init_accepts_an_image_and_records_its_kind(monkeypatch, filename: str) -> None:
    repo = _FakeUserFileRepository()
    _patch_service(monkeypatch, repo, _FakeUnitOfWork())
    monkeypatch.setattr(user_files_router, "new_user_file_id", lambda: "file-fixed")

    await user_files_router.init_user_file_upload(
        PyUserFileUploadInitRequest(filename=filename, content_type="image/png", size_bytes=1234),
        session=AsyncSession(),
        user=_user(),
    )

    assert repo.files["file-fixed"].metadata == {"kind": "image"}


@pytest.mark.asyncio
async def test_init_keeps_documents_without_a_kind(monkeypatch) -> None:
    repo = _FakeUserFileRepository()
    _patch_service(monkeypatch, repo, _FakeUnitOfWork())
    monkeypatch.setattr(user_files_router, "new_user_file_id", lambda: "file-fixed")

    await user_files_router.init_user_file_upload(
        PyUserFileUploadInitRequest(filename="notes.txt", content_type="text/plain", size_bytes=12),
        session=AsyncSession(),
        user=_user(),
    )

    assert repo.files["file-fixed"].metadata == {}


@pytest.mark.asyncio
async def test_init_rejects_an_image_over_the_image_limit(monkeypatch) -> None:
    _patch_service(monkeypatch, _FakeUserFileRepository(), _FakeUnitOfWork())
    monkeypatch.setattr(settings, "anima_user_file_max_upload_bytes", 64 * 1024 * 1024)

    with pytest.raises(HTTPException) as exc_info:
        await user_files_router.init_user_file_upload(
            PyUserFileUploadInitRequest(filename="huge.png", content_type="image/png", size_bytes=20 * 1024 * 1024 + 1),
            session=AsyncSession(),
            user=_user(),
        )

    assert exc_info.value.status_code == 400
    assert "20971520 byte limit" in exc_info.value.detail


@pytest.mark.asyncio
@pytest.mark.parametrize(("filename", "name"), [("IMG_0001.HEIC", "HEIC"), ("IMG_0002.heif", "HEIF")])
async def test_init_names_the_image_format_it_does_not_accept(monkeypatch, filename: str, name: str) -> None:
    _patch_service(monkeypatch, _FakeUserFileRepository(), _FakeUnitOfWork())

    with pytest.raises(HTTPException) as exc_info:
        await user_files_router.init_user_file_upload(
            PyUserFileUploadInitRequest(filename=filename, content_type="image/heic", size_bytes=1234),
            session=AsyncSession(),
            user=_user(),
        )

    assert exc_info.value.status_code == 400
    assert name in exc_info.value.detail


@pytest.mark.asyncio
async def test_finalize_replaces_an_image_with_its_canonical_copy_and_marks_it_ready(monkeypatch) -> None:
    uploaded = _photo_with_location()
    repo = _FakeUserFileRepository([_image_file(uploaded)])
    _patch_service(monkeypatch, repo, _FakeUnitOfWork())
    storage = _FakeImageStorage(uploaded)
    storage.install(monkeypatch)

    response = await user_files_router.finalize_user_file_upload("file-1", session=AsyncSession(), user=_user())

    assert response.status == STATUS_READY
    assert response.metadata == {"kind": "image", "image": {"width": 40, "height": 20, "media_type": "image/jpeg"}}
    assert response.detected_content_type == "image/jpeg"
    stored = storage.content
    assert stored is not None
    assert stored != uploaded
    assert response.stored_size_bytes == len(stored)
    assert response.sha256 == hashlib.sha256(stored).hexdigest()
    assert response.processed_at is not None
    assert response.last_error is None
    assert storage.writes == 1
    with Image.open(BytesIO(stored)) as canonical:
        assert not canonical.getexif()


def _png(image: Image.Image) -> bytes:
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("uploaded", "reason"),
    [
        (b"not an image, whatever the name says", "This file is not a PNG, JPEG, WebP or GIF image."),
        (_png(Image.new("1", (7_000, 6_000))), "This image has too many pixels."),
        (_png(Image.new("1", (12_000, 9_000))), "This image has too many pixels."),
        (_png(Image.new("RGB", (64, 64), "red"))[:120], "This image could not be read."),
    ],
    ids=["not-an-image", "over-the-pixel-budget", "decompression-bomb", "truncated"],
)
async def test_finalize_fails_an_upload_it_cannot_store_and_deletes_its_bytes(
    monkeypatch, uploaded: bytes, reason: str
) -> None:
    repo = _FakeUserFileRepository([_image_file(uploaded)])
    _patch_service(monkeypatch, repo, _FakeUnitOfWork())
    storage = _FakeImageStorage(uploaded)
    storage.install(monkeypatch)

    response = await user_files_router.finalize_user_file_upload("file-1", session=AsyncSession(), user=_user())

    assert response.status == STATUS_FAILED
    assert response.last_error == reason
    assert "image" not in response.metadata
    assert storage.writes == 0
    assert storage.content is None


@pytest.mark.asyncio
async def test_finalize_names_the_reason_when_an_image_is_too_detailed_to_store(monkeypatch) -> None:
    uploaded = _photo_with_location()
    repo = _FakeUserFileRepository([_image_file(uploaded)])
    _patch_service(monkeypatch, repo, _FakeUnitOfWork())
    storage = _FakeImageStorage(uploaded)
    storage.install(monkeypatch)
    monkeypatch.setattr(
        user_files_router,
        "canonicalize_chat_image_stream",
        lambda *, content: content_image.canonicalize_chat_image_stream(content=content, maximum_bytes=64),
    )

    response = await user_files_router.finalize_user_file_upload("file-1", session=AsyncSession(), user=_user())

    assert response.status == STATUS_FAILED
    assert response.last_error == "This image is too detailed to store."
    assert storage.content is None


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", [RuntimeError("encoder bug"), OSError("encoder error -2 when writing image file")])
async def test_finalize_keeps_the_upload_when_the_server_fails_to_encode_it(monkeypatch, fault: Exception) -> None:
    uploaded = _photo_with_location()
    repo = _FakeUserFileRepository([_image_file(uploaded)])
    _patch_service(monkeypatch, repo, _FakeUnitOfWork())
    storage = _FakeImageStorage(uploaded)
    storage.install(monkeypatch)

    def broken_encoder(*_args: object, **_kwargs: object) -> tuple[bytes, str]:
        raise fault

    monkeypatch.setattr(content_image, "_encode_chat_image", broken_encoder)

    # A server fault is neither a refusal nor a storage failure: it surfaces as itself.
    with pytest.raises(type(fault), match=str(fault)):
        await user_files_router.finalize_user_file_upload("file-1", session=AsyncSession(), user=_user())

    assert repo.files["file-1"].status == STATUS_UPLOADED
    assert repo.files["file-1"].last_error is None
    assert storage.content == uploaded


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "read_error",
    [
        PrivateFileReadError("disk error"),
        PermissionError("parent directory is not readable"),
        PrivateFilePathError("Private locator escaped its root"),
    ],
    ids=["read", "parent-permission", "parent-link"],
)
async def test_finalize_reports_a_read_failure_and_leaves_the_upload_for_a_retry(
    monkeypatch, read_error: Exception
) -> None:
    uploaded = _photo_with_location()
    repo = _FakeUserFileRepository([_image_file(uploaded)])
    _patch_service(monkeypatch, repo, _FakeUnitOfWork())
    storage = _FakeImageStorage(uploaded)
    storage.install(monkeypatch)
    storage.read_error = read_error

    with pytest.raises(HTTPException) as exc_info:
        await user_files_router.finalize_user_file_upload("file-1", session=AsyncSession(), user=_user())

    assert exc_info.value.status_code == 503
    assert repo.files["file-1"].status == STATUS_UPLOADED
    assert storage.content == uploaded


@pytest.mark.asyncio
async def test_finalize_reports_a_write_failure_and_leaves_the_upload_for_a_retry(monkeypatch) -> None:
    uploaded = _photo_with_location()
    repo = _FakeUserFileRepository([_image_file(uploaded)])
    _patch_service(monkeypatch, repo, _FakeUnitOfWork())
    storage = _FakeImageStorage(uploaded)
    storage.install(monkeypatch)
    storage.write_succeeds = False

    with pytest.raises(HTTPException) as exc_info:
        await user_files_router.finalize_user_file_upload("file-1", session=AsyncSession(), user=_user())

    assert exc_info.value.status_code == 507
    assert repo.files["file-1"].status == STATUS_UPLOADED
    assert storage.content == uploaded


@pytest.mark.asyncio
async def test_finalize_writes_nothing_when_the_file_is_deleted_while_it_decodes(monkeypatch) -> None:
    uploaded = _photo_with_location()
    repo = _FakeUserFileRepository([_image_file(uploaded)])
    _patch_service(monkeypatch, repo, _FakeUnitOfWork())
    storage = _FakeImageStorage(uploaded)
    storage.install(monkeypatch)

    def delete_the_file() -> None:
        repo.files["file-1"].status = STATUS_DELETED
        storage.content = None

    storage.while_decoding = delete_the_file

    with pytest.raises(HTTPException) as exc_info:
        await user_files_router.finalize_user_file_upload("file-1", session=AsyncSession(), user=_user())

    assert exc_info.value.status_code == 404
    assert storage.writes == 0
    assert storage.content is None


@pytest.mark.asyncio
async def test_process_does_not_overwrite_an_image_another_request_finished(monkeypatch) -> None:
    uploaded = _photo_with_location()
    repo = _FakeUserFileRepository([_image_file(uploaded, status=STATUS_UPLOADED)])
    _patch_service(monkeypatch, repo, _FakeUnitOfWork())
    storage = _FakeImageStorage(uploaded)
    storage.install(monkeypatch)

    def finish_elsewhere() -> None:
        repo.files["file-1"].status = STATUS_READY

    storage.while_decoding = finish_elsewhere

    response = await user_files_router.process_user_file("file-1", session=AsyncSession(), user=_user())

    assert response.file_status == STATUS_READY
    assert storage.writes == 0
    assert storage.content == uploaded


@pytest.mark.asyncio
async def test_process_reports_an_uploaded_image_whose_bytes_are_missing(monkeypatch) -> None:
    uploaded = _photo_with_location()
    repo = _FakeUserFileRepository([_image_file(uploaded, status=STATUS_UPLOADED)])
    _patch_service(monkeypatch, repo, _FakeUnitOfWork())
    storage = _FakeImageStorage(uploaded)
    storage.install(monkeypatch)
    storage.content = None

    with pytest.raises(HTTPException) as exc_info:
        await user_files_router.process_user_file("file-1", session=AsyncSession(), user=_user())

    assert exc_info.value.status_code == 503
    assert repo.files["file-1"].status == STATUS_UPLOADED


@pytest.mark.asyncio
async def test_finalize_replaces_the_original_in_private_storage(monkeypatch, tmp_path) -> None:
    paths = initialize_local_runtime(
        Settings(animama_content_root=tmp_path / "content", animama_data_root=tmp_path / "data")
    )
    storage = FilesystemPrivateFileStorage(paths)
    monkeypatch.setattr(user_file_storage, "_storage", lambda: storage)
    uploaded = _photo_with_location()
    user_file = _image_file(uploaded)
    assert storage.put_stream(user_file.storage_locator, BytesIO(uploaded), content_length=len(uploaded))
    repo = _FakeUserFileRepository([user_file])
    _patch_service(monkeypatch, repo, _FakeUnitOfWork())

    response = await user_files_router.finalize_user_file_upload("file-1", session=AsyncSession(), user=_user())

    stored_files = [path for path in paths.user_files_root.rglob("*") if path.is_file()]
    assert [path.name for path in stored_files] == ["original"]
    stored = stored_files[0].read_bytes()
    assert stored != uploaded
    assert response.status == STATUS_READY
    assert response.stored_size_bytes == len(stored)
    assert response.sha256 == hashlib.sha256(stored).hexdigest()
    with Image.open(BytesIO(stored)) as canonical:
        assert not canonical.getexif()

    served = await user_files_router.get_user_file_content("file-1", session=AsyncSession(), user=_user())

    assert served.status_code == 200
    assert await _body(served) == stored


@pytest.mark.asyncio
async def test_process_returns_a_ready_image_without_a_job(monkeypatch) -> None:
    stored = _photo_with_location()
    repo = _FakeUserFileRepository([_image_file(stored, status=STATUS_READY)])
    _patch_service(monkeypatch, repo, _FakeUnitOfWork())
    storage = _FakeImageStorage(stored)
    storage.install(monkeypatch)

    response = await user_files_router.process_user_file("file-1", session=AsyncSession(), user=_user())

    assert response.file_status == STATUS_READY
    assert response.job_id is None
    assert response.job_status is None
    assert storage.writes == 0


@pytest.mark.asyncio
async def test_process_completes_an_image_left_uploaded(monkeypatch) -> None:
    uploaded = _photo_with_location()
    repo = _FakeUserFileRepository([_image_file(uploaded, status=STATUS_UPLOADED)])
    _patch_service(monkeypatch, repo, _FakeUnitOfWork())
    storage = _FakeImageStorage(uploaded)
    storage.install(monkeypatch)

    response = await user_files_router.process_user_file("file-1", session=AsyncSession(), user=_user())

    assert response.file_status == STATUS_READY
    assert response.job_id is None
    assert repo.files["file-1"].metadata == {
        "kind": "image",
        "image": {"width": 40, "height": 20, "media_type": "image/jpeg"},
    }
    assert storage.writes == 1


async def _body(response) -> bytes:
    return b"".join([chunk async for chunk in response.body_iterator])


def _ready_image(content: bytes, *, user_id: str = "user-1", media_type: str = "image/jpeg") -> UserFile:
    user_file = _image_file(content, status=STATUS_READY)
    user_file.user_id = user_id
    user_file.storage_locator = f"user-files/{user_id}/file-1/original"
    user_file.stored_size_bytes = len(content)
    user_file.sha256 = hashlib.sha256(content).hexdigest()
    user_file.detected_content_type = media_type
    user_file.metadata = {"kind": "image", "image": {"width": 40, "height": 20, "media_type": media_type}}
    return user_file


def _jpeg(size: tuple[int, int]) -> bytes:
    output = BytesIO()
    Image.new("RGB", size, "red").save(output, format="JPEG")
    return output.getvalue()


@pytest.mark.asyncio
async def test_content_returns_a_ready_image_to_its_owner_with_revalidation(monkeypatch) -> None:
    stored = _jpeg((40, 20))
    _patch_service(monkeypatch, _FakeUserFileRepository([_ready_image(stored)]), _FakeUnitOfWork())
    _FakeImageStorage(stored).install(monkeypatch)

    response = await user_files_router.get_user_file_content("file-1", session=AsyncSession(), user=_user())

    assert response.status_code == 200
    assert response.media_type == "image/jpeg"
    assert response.headers["ETag"] == f'"{hashlib.sha256(stored).hexdigest()}"'
    assert response.headers["Cache-Control"] == "private, no-cache"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Content-Security-Policy"] == "sandbox; default-src 'none'"
    assert await _body(response) == stored


@pytest.mark.asyncio
async def test_content_answers_304_when_the_client_already_has_the_image(monkeypatch) -> None:
    stored = _jpeg((40, 20))
    _patch_service(monkeypatch, _FakeUserFileRepository([_ready_image(stored)]), _FakeUnitOfWork())
    _FakeImageStorage(stored).install(monkeypatch)

    response = await user_files_router.get_user_file_content(
        "file-1",
        session=AsyncSession(),
        user=_user(),
        if_none_match=f'"{hashlib.sha256(stored).hexdigest()}"',
    )

    assert response.status_code == 304


@pytest.mark.asyncio
async def test_content_thumbnail_is_a_small_copy(monkeypatch) -> None:
    stored = _jpeg((1600, 800))
    _patch_service(monkeypatch, _FakeUserFileRepository([_ready_image(stored)]), _FakeUnitOfWork())
    _FakeImageStorage(stored).install(monkeypatch)

    response = await user_files_router.get_user_file_content(
        "file-1", session=AsyncSession(), user=_user(), variant="thumbnail"
    )

    assert response.status_code == 200
    assert response.media_type == "image/webp"
    with Image.open(BytesIO(await _body(response))) as thumbnail:
        assert max(thumbnail.size) <= 128


@pytest.mark.asyncio
async def test_content_preview_is_a_copy_sized_for_the_chat_transcript(monkeypatch) -> None:
    stored = _jpeg((1600, 800))
    _patch_service(monkeypatch, _FakeUserFileRepository([_ready_image(stored)]), _FakeUnitOfWork())
    _FakeImageStorage(stored).install(monkeypatch)

    response = await user_files_router.get_user_file_content(
        "file-1", session=AsyncSession(), user=_user(), variant="preview"
    )

    assert response.status_code == 200
    assert response.media_type == "image/webp"
    with Image.open(BytesIO(await _body(response))) as preview:
        assert preview.size == (320, 160)


def _not_servable(case: str) -> UserFile:
    stored = _jpeg((40, 20))
    if case == "another-owner":
        return _ready_image(stored, user_id="user-2")
    user_file = _ready_image(stored)
    if case == "document":
        user_file.metadata = {}
        user_file.normalized_extension = ".txt"
    elif case == "not-ready":
        user_file.status = STATUS_UPLOADED
    elif case == "failed":
        user_file.status = STATUS_FAILED
    elif case == "deleted":
        user_file.status = STATUS_DELETED
    elif case == "aborted":
        user_file.status = STATUS_ABORTED
    elif case == "delete-pending":
        user_file.status = STATUS_DELETE_PENDING
    return user_file


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case", ["another-owner", "document", "not-ready", "failed", "deleted", "aborted", "delete-pending"]
)
async def test_content_is_not_served_unless_it_is_the_owners_ready_image(monkeypatch, case: str) -> None:
    user_file = _not_servable(case)
    _patch_service(monkeypatch, _FakeUserFileRepository([user_file]), _FakeUnitOfWork())
    storage = _FakeImageStorage(_jpeg((40, 20)))
    storage.install(monkeypatch)

    with pytest.raises(HTTPException) as exc_info:
        await user_files_router.get_user_file_content("file-1", session=AsyncSession(), user=_user())

    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_content_refuses_bytes_that_no_longer_match_the_record(monkeypatch) -> None:
    stored = _jpeg((40, 20))
    _patch_service(monkeypatch, _FakeUserFileRepository([_ready_image(stored)]), _FakeUnitOfWork())
    storage = _FakeImageStorage(stored)
    storage.install(monkeypatch)
    replaced = bytearray(stored)
    replaced[-3] ^= 0xFF
    storage.content = bytes(replaced)

    with pytest.raises(HTTPException) as exc_info:
        await user_files_router.get_user_file_content("file-1", session=AsyncSession(), user=_user())

    assert exc_info.value.status_code == 409
    detail: object = exc_info.value.detail
    assert detail == {"code": "user_file_content_changed"}


@pytest.mark.asyncio
async def test_content_reports_bytes_that_are_gone(monkeypatch) -> None:
    stored = _jpeg((40, 20))
    _patch_service(monkeypatch, _FakeUserFileRepository([_ready_image(stored)]), _FakeUnitOfWork())
    storage = _FakeImageStorage(stored)
    storage.install(monkeypatch)
    storage.content = None

    with pytest.raises(HTTPException) as exc_info:
        await user_files_router.get_user_file_content("file-1", session=AsyncSession(), user=_user())

    assert exc_info.value.status_code == 409


@pytest.mark.asyncio
async def test_content_returns_a_small_image_itself_as_its_thumbnail(monkeypatch) -> None:
    stored = _jpeg((100, 50))
    _patch_service(monkeypatch, _FakeUserFileRepository([_ready_image(stored)]), _FakeUnitOfWork())
    _FakeImageStorage(stored).install(monkeypatch)

    response = await user_files_router.get_user_file_content(
        "file-1", session=AsyncSession(), user=_user(), variant="thumbnail"
    )

    assert response.media_type == "image/jpeg"
    assert await _body(response) == stored


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "read_error",
    [
        PrivateFileReadError("disk error"),
        PermissionError("parent directory is not readable"),
        PrivateFilePathError("Private locator escaped its root"),
    ],
    ids=["read", "parent-permission", "parent-link"],
)
async def test_content_reports_a_read_failure(monkeypatch, read_error: Exception) -> None:
    stored = _jpeg((40, 20))
    _patch_service(monkeypatch, _FakeUserFileRepository([_ready_image(stored)]), _FakeUnitOfWork())
    storage = _FakeImageStorage(stored)
    storage.install(monkeypatch)
    storage.read_error = read_error

    with pytest.raises(HTTPException) as exc_info:
        await user_files_router.get_user_file_content("file-1", session=AsyncSession(), user=_user())

    assert exc_info.value.status_code == 503

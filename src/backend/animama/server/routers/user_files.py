"""RequestPrincipal-owned file upload lifecycle endpoints."""

from __future__ import annotations

import asyncio
import threading
from io import BytesIO
from typing import Annotated, Literal, NoReturn

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from animama.adapters.content_store.private_file_store import PrivateFilePathError, PrivateFileReadError
from animama.adapters.repositories.sqlalchemy.uow import SQLAlchemyUnitOfWork
from animama.adapters.repositories.sqlalchemy.user_file_processing_repo import SQLAlchemyUserFileProcessingRepository
from animama.adapters.repositories.sqlalchemy.user_file_repo import SQLAlchemyUserFileRepository
from animama.app.ports.private_file_storage import PrivateFileUnavailableError
from animama.app.services.content_file_validation import ContentFileInvalidError
from animama.app.services.content_image import CanonicalChatImage, canonicalize_chat_image_stream
from animama.app.services.content_thumbnails import (
    PREVIEW_EDGE,
    THUMBNAIL_EDGE,
    ContentThumbnailError,
    thumbnail_file,
)
from animama.app.services.user_file_processing_service import (
    UserFileProcessingConflictError,
    UserFileProcessingNotFoundError,
    UserFileProcessingService,
    UserFileProcessingUnavailableError,
    UserFileProcessingValidationError,
)
from animama.app.services.user_file_service import (
    UserFileConflictError,
    UserFileGoneError,
    UserFileNotFoundError,
    UserFileService,
    UserFileStorageError,
    UserFileValidationError,
    is_image_user_file,
    new_user_file_id,
    validate_user_file_upload_request,
)
from animama.domain.content_catalog import VerifiedContentFile
from animama.domain.request_principal import RequestPrincipal
from animama.domain.user_file import STATUS_ABORTED, STATUS_DELETE_PENDING, STATUS_READY, STATUS_UPLOADED, UserFile
from animama.domain.user_file_processing import (
    UserFileProcessingInfo,
    UserFileProcessingJobSummary,
    UserFileSearchResult,
)
from animama.logging_config import get_logger
from animama.product_http.uploads import UploadEnvelopeError, spool_bounded_request
from animama.server.config import Settings, settings
from animama.server.deps import get_async_session, get_current_principal
from animama.server.embeddings import role_embedder
from animama.server.local_runtime import initialize_local_runtime
from animama.server.model_roles import ModelRoleSettings, get_model_role_settings
from animama.server.product_ports import local_file_response
from animama.server.runtime_capabilities import get_runtime_settings
from animama.server.schemas.user_file import (
    PyUserFileFinalizeRequest,
    PyUserFileListResponse,
    PyUserFileProcessingJobResponse,
    PyUserFileProcessRequest,
    PyUserFileProcessResponse,
    PyUserFileResponse,
    PyUserFileSearchRequest,
    PyUserFileSearchResponse,
    PyUserFileSearchResult,
    PyUserFileUploadInitRequest,
    PyUserFileUploadInitResponse,
)
from animama.server.user_file_processing import UserFileProcessingRunner, request_user_file_processing_runner
from animama.server.user_file_storage import (
    build_user_file_storage_locator,
    delete_private_file,
    is_user_file_storage_locator,
    open_private_file,
    private_file_metadata,
    private_upload_expires_at,
    private_upload_url,
    write_private_file_stream,
)

router = APIRouter()
_log = get_logger("server.routers.user_files")
SessionDep = Annotated[AsyncSession, Depends(get_async_session)]
UserDep = Annotated[RequestPrincipal, Depends(get_current_principal)]


def _service(session: AsyncSession) -> UserFileService:
    return UserFileService(
        user_files=SQLAlchemyUserFileRepository(session),
        uow=SQLAlchemyUnitOfWork(session),
    )


def _processing_service(session: AsyncSession, *, processing_enabled: bool = True) -> UserFileProcessingService:
    return UserFileProcessingService(
        processing=SQLAlchemyUserFileProcessingRepository(session),
        uow=SQLAlchemyUnitOfWork(session),
        max_attempts=settings.anima_user_file_processing_max_attempts,
        processing_enabled=processing_enabled,
    )


def _to_job_response(job: UserFileProcessingJobSummary) -> PyUserFileProcessingJobResponse:
    return PyUserFileProcessingJobResponse(
        job_id=job.job_id,
        status=job.status,
        attempts=job.attempts,
        max_attempts=job.max_attempts,
        last_error=job.last_error,
        run_after=job.run_after,
        started_at=job.started_at,
        finished_at=job.finished_at,
        created_at=job.created_at,
        updated_at=job.updated_at,
    )


# What the composer shows when an upload cannot be kept as a chat image.
_IMAGE_REJECTIONS = {
    "unsupported_image_format": "This file is not a PNG, JPEG, WebP or GIF image.",
    "image_pixel_budget": "This image has too many pixels.",
    "canonical_image_size_limit": "This image is too detailed to store.",
}
_UNREADABLE_IMAGE = "This image could not be read."
# A decoded image can hold several hundred megabytes for a moment. Several images
# pasted together are canonicalized two at a time, as thumbnails are.
_IMAGE_DECODE_SLOTS = threading.BoundedSemaphore(2)


# Everything a read from private storage can raise. The storage adapter checks
# the path before it opens the file, so a parent directory that became
# unreadable (OSError) or was replaced by a link (PrivateFilePathError) fails
# there; neither is the file's fault. Missing or resized bytes are
# PrivateFileUnavailableError, which callers may answer differently.
_STORAGE_READ_ERRORS = (PrivateFileUnavailableError, PrivateFileReadError, PrivateFilePathError, OSError)


def _read_private_file(storage_locator: str, size_bytes: int) -> tuple[bytes, str]:
    """Return a stored private file's bytes and digest (blocking).

    Reading is finished before the bytes are used: the storage adapter reports
    any ``OSError`` raised inside its block as a read failure, which would hide a
    decoder or encoder fault. Chat images are at most 20 MiB uploaded and
    3.5 MiB stored.
    """

    with open_private_file(storage_locator, expected_size_bytes=size_bytes) as stored:
        return stored.stream.read(), stored.sha256


def _canonical_chat_image(content: bytes) -> CanonicalChatImage:
    """Canonicalize an uploaded image's bytes (blocking)."""

    with _IMAGE_DECODE_SLOTS:
        return canonicalize_chat_image_stream(content=BytesIO(content))


async def _store_canonical_image(service: UserFileService, user_file: UserFile, *, size_bytes: int) -> UserFile:
    """Replace an uploaded image with its canonical copy and make it ready.

    The copy takes the uploaded file's place, so the original and its metadata
    (such as a photo's location) are not kept and one locator still owns the
    file's bytes. A file that cannot be stored as an image is failed with a
    reason for the composer, and its uploaded bytes are deleted.

    Decoding runs without a row lock. The service repeats the state check under
    the lock before any write or delete, so if another request deleted or
    finished the file meanwhile, nothing is written and this returns its state.

    Only a refusal of the image itself fails the file. A read, write or server
    fault raises and leaves the upload as it was, for ``:process`` to retry.
    """

    locator = user_file.storage_locator

    async def store_canonical() -> bool:
        return await asyncio.to_thread(
            write_private_file_stream,
            locator,
            BytesIO(canonical.content),
            content_type=canonical.media_type,
            content_length=len(canonical.content),
        )

    async def discard_upload() -> bool:
        return await asyncio.to_thread(delete_private_file, locator)

    try:
        try:
            uploaded, _digest = await asyncio.to_thread(_read_private_file, locator, size_bytes)
        except _STORAGE_READ_ERRORS as exc:
            _log.error("User image read failed", file_id=user_file.id, user_id=user_file.user_id, error=str(exc))
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Local file unavailable"
            ) from exc
        try:
            # Pillow decoding is CPU work; keep it off the event loop.
            canonical = await asyncio.to_thread(_canonical_chat_image, uploaded)
        except ContentFileInvalidError as exc:
            _log.info("User image refused", file_id=user_file.id, user_id=user_file.user_id, reason=exc.reason)
            return await service.fail_image_upload(
                user_id=user_file.user_id,
                file_id=user_file.id,
                reason=_IMAGE_REJECTIONS.get(exc.reason, _UNREADABLE_IMAGE),
                discard_upload=discard_upload,
            )
        return await service.complete_image_upload(
            user_id=user_file.user_id,
            file_id=user_file.id,
            stored_size_bytes=len(canonical.content),
            sha256=canonical.sha256,
            media_type=canonical.media_type,
            width=canonical.width,
            height=canonical.height,
            store_canonical=store_canonical,
        )
    except UserFileStorageError as exc:
        raise HTTPException(status_code=507, detail={"code": "local_file_write_failed"}) from exc
    except UserFileConflictError:
        # Another request finished or failed this image while it was decoding here.
        try:
            return await service.get_user_file(user_id=user_file.user_id, file_id=user_file.id)
        except UserFileNotFoundError as exc:
            _raise_http_error(exc)
    except UserFileNotFoundError as exc:
        _raise_http_error(exc)


def _stored_size_bytes(storage_locator: str) -> int:
    """Return the size of a stored private file, or 503 when it cannot be read."""

    try:
        size_bytes = (private_file_metadata(storage_locator) or {}).get("ContentLength")
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Local file unavailable") from exc
    if not isinstance(size_bytes, int) or isinstance(size_bytes, bool) or size_bytes <= 0:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Local file unavailable")
    return size_bytes


def _to_response(user_file: UserFile, processing_info: UserFileProcessingInfo | None = None) -> PyUserFileResponse:
    return PyUserFileResponse(
        file_id=user_file.id,
        original_filename=user_file.original_filename,
        normalized_extension=user_file.normalized_extension,
        status=user_file.status,
        declared_content_type=user_file.declared_content_type,
        detected_content_type=user_file.detected_content_type,
        declared_size_bytes=user_file.declared_size_bytes,
        stored_size_bytes=user_file.stored_size_bytes,
        sha256=user_file.sha256,
        upload_expires_at=user_file.upload_expires_at,
        processed_at=user_file.processed_at,
        last_error=user_file.last_error,
        metadata=dict(user_file.metadata or {}),
        chunk_count=processing_info.chunk_count if processing_info is not None else 0,
        latest_processing_job=(
            _to_job_response(processing_info.latest_job)
            if processing_info is not None and processing_info.latest_job is not None
            else None
        ),
        created_at=user_file.created_at,
        updated_at=user_file.updated_at,
    )


def _raise_http_error(exc: Exception) -> NoReturn:
    if isinstance(exc, UserFileValidationError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=exc.detail) from exc
    if isinstance(exc, UserFileNotFoundError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=exc.detail) from exc
    if isinstance(exc, UserFileGoneError):
        raise HTTPException(status_code=status.HTTP_410_GONE, detail=exc.detail) from exc
    if isinstance(exc, UserFileConflictError):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=exc.detail) from exc
    raise exc


def _raise_processing_http_error(exc: Exception) -> NoReturn:
    if isinstance(exc, UserFileProcessingValidationError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=exc.detail) from exc
    if isinstance(exc, UserFileProcessingNotFoundError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=exc.detail) from exc
    if isinstance(exc, UserFileProcessingConflictError):
        detail = {"code": exc.detail} if exc.detail == "file_processing_unavailable" else exc.detail
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail) from exc
    if isinstance(exc, UserFileProcessingUnavailableError):
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=exc.detail) from exc
    raise exc


def _search_result_response(result: UserFileSearchResult) -> PyUserFileSearchResult:
    return PyUserFileSearchResult(
        chunk_id=result.chunk_id,
        file_id=result.file_id,
        chunk_index=result.chunk_index,
        original_filename=result.original_filename,
        normalized_extension=result.normalized_extension,
        score=result.score,
        match_type=result.match_type,
        text=result.text,
        metadata=dict(result.metadata),
    )


@router.post(
    "/v1/files/uploads",
    response_model=PyUserFileUploadInitResponse,
    status_code=status.HTTP_200_OK,
)
async def init_user_file_upload(
    req: PyUserFileUploadInitRequest,
    session: SessionDep,
    user: UserDep,
) -> PyUserFileUploadInitResponse:
    """Create a gateway-protected local PUT target and pending private-file row."""

    try:
        validated = validate_user_file_upload_request(
            filename=req.filename,
            content_type=req.content_type,
            size_bytes=req.size_bytes,
            max_upload_bytes=settings.anima_user_file_max_upload_bytes,
        )
    except UserFileValidationError as exc:
        _raise_http_error(exc)

    file_id = new_user_file_id()
    storage_locator = build_user_file_storage_locator(
        user_id=user.id,
        file_id=file_id,
        extension=validated.normalized_extension,
    )
    upload_url = private_upload_url(
        storage_locator,
        content_type=validated.declared_content_type,
    )
    if upload_url is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Failed to initialize upload")

    expires_at = private_upload_expires_at()
    user_file = await _service(session).create_pending_upload(
        file_id=file_id,
        user_id=user.id,
        storage_locator=storage_locator,
        validated=validated,
        upload_expires_at=expires_at,
    )

    return PyUserFileUploadInitResponse(
        file_id=user_file.id,
        upload_url=upload_url,
        method="PUT",
        headers={"Content-Type": validated.declared_content_type},
        expires_at=expires_at,
    )


@router.put(
    "/v1/files/{file_id}/content",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def upload_user_file_content(
    file_id: str,
    request: Request,
    session: SessionDep,
    user: UserDep,
) -> Response:
    """Stream private bytes through FastAPI and atomically promote to data/user-files."""

    service = _service(session)
    try:
        user_file = await service.get_user_file(user_id=user.id, file_id=file_id)
    except UserFileNotFoundError as exc:
        _raise_http_error(exc)
    if user_file.status != "pending_upload":
        raise HTTPException(status_code=409, detail={"code": "user_file_upload_not_pending"})
    try:
        upload = await spool_bounded_request(
            request,
            expected_size_bytes=user_file.declared_size_bytes,
            max_size_bytes=settings.anima_user_file_max_upload_bytes,
            staging_directory=initialize_local_runtime(settings).uploads_staging_root,
        )
    except UploadEnvelopeError as exc:
        raise HTTPException(status_code=422, detail={"code": exc.code}) from exc
    try:
        if not write_private_file_stream(
            user_file.storage_locator,
            upload.stream,
            content_type=user_file.declared_content_type or "application/octet-stream",
            content_length=upload.size_bytes,
        ):
            raise HTTPException(status_code=507, detail={"code": "local_file_write_failed"})
    finally:
        upload.close()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/v1/files/{file_id}:finalize",
    response_model=PyUserFileResponse,
    status_code=status.HTTP_200_OK,
)
async def finalize_user_file_upload(
    file_id: str,
    session: SessionDep,
    user: UserDep,
    _req: PyUserFileFinalizeRequest | None = None,
) -> PyUserFileResponse:
    """Finalize a pending upload after verifying its atomically promoted local file."""

    service = _service(session)
    try:
        user_file = await service.get_user_file(user_id=user.id, file_id=file_id)
    except UserFileNotFoundError as exc:
        _raise_http_error(exc)

    try:
        object_metadata = private_file_metadata(user_file.storage_locator)
    except Exception as exc:
        _log.error("User file local stat failed", file_id=file_id, user_id=user.id, error=str(exc))
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Local file unavailable") from exc

    try:
        finalized = await service.finalize_upload(
            user_id=user.id,
            file_id=file_id,
            object_metadata=object_metadata,
            object_key_is_valid=is_user_file_storage_locator(user_file.storage_locator, user.id),
            max_upload_bytes=settings.anima_user_file_max_upload_bytes,
        )
    except (UserFileValidationError, UserFileNotFoundError, UserFileGoneError, UserFileConflictError) as exc:
        _raise_http_error(exc)

    if is_image_user_file(finalized) and finalized.stored_size_bytes is not None:
        finalized = await _store_canonical_image(service, finalized, size_bytes=finalized.stored_size_bytes)
    return _to_response(finalized)


@router.get(
    "/v1/files",
    response_model=PyUserFileListResponse,
    status_code=status.HTTP_200_OK,
)
async def list_user_files(
    session: SessionDep,
    user: UserDep,
) -> PyUserFileListResponse:
    """List the current user's non-deleted files newest first."""

    files = await _service(session).list_user_files(user_id=user.id)
    info = await _processing_service(session).list_processing_info(
        user_id=user.id,
        file_ids=[user_file.id for user_file in files],
    )
    return PyUserFileListResponse(files=[_to_response(user_file, info.get(user_file.id)) for user_file in files])


@router.get(
    "/v1/files/{file_id}",
    response_model=PyUserFileResponse,
    status_code=status.HTTP_200_OK,
)
async def get_user_file(
    file_id: str,
    session: SessionDep,
    user: UserDep,
) -> PyUserFileResponse:
    """Return one current-user file or 404."""

    try:
        user_file = await _service(session).get_user_file(user_id=user.id, file_id=file_id)
    except UserFileNotFoundError as exc:
        _raise_http_error(exc)
    info = await _processing_service(session).list_processing_info(user_id=user.id, file_ids=[user_file.id])
    return _to_response(user_file, info.get(user_file.id))


def _verified_image(user_file: UserFile) -> VerifiedContentFile:
    """Read a ready image's stored copy and check it is still the recorded one (blocking)."""

    content, digest = _read_private_file(user_file.storage_locator, user_file.stored_size_bytes or 0)
    if digest != user_file.sha256:
        raise PrivateFileUnavailableError("Stored image no longer matches its record")
    return VerifiedContentFile(
        handle=BytesIO(content),
        size_bytes=len(content),
        sha256=digest,
        media_type=user_file.detected_content_type or "application/octet-stream",
    )


@router.get("/v1/files/{file_id}/content")
async def get_user_file_content(
    file_id: str,
    session: SessionDep,
    user: UserDep,
    if_none_match: Annotated[str | None, Header(alias="If-None-Match")] = None,
    variant: Annotated[Literal["thumbnail", "preview"] | None, Query()] = None,
) -> Response:
    """Return the stored copy of one of the current user's ready chat images.

    `variant=thumbnail` returns a copy at most 128 px on its long edge, and
    `variant=preview` one at most 320 px for the chat transcript. The reply is
    private and revalidated by its digest `ETag`. Documents and images that are
    not ready are not served.
    """

    try:
        user_file = await _service(session).get_user_file(user_id=user.id, file_id=file_id)
    except UserFileNotFoundError as exc:
        _raise_http_error(exc)
    if not is_image_user_file(user_file) or user_file.status != STATUS_READY:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    try:
        image = await asyncio.to_thread(_verified_image, user_file)
    except PrivateFileUnavailableError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": "user_file_content_changed"}) from exc
    except _STORAGE_READ_ERRORS as exc:
        _log.error("User image read failed", file_id=file_id, user_id=user.id, error=str(exc))
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Local file unavailable") from exc
    if variant is not None:
        edge = PREVIEW_EDGE if variant == "preview" else THUMBNAIL_EDGE
        try:
            image = await asyncio.to_thread(thumbnail_file, image, edge=edge)
        except ContentThumbnailError as exc:
            raise HTTPException(status_code=422, detail={"code": "content_thumbnail_unsupported"}) from exc
    return local_file_response(image, if_none_match=if_none_match, revalidate=True)


@router.post(
    "/v1/files/{file_id}:process",
    response_model=PyUserFileProcessResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def process_user_file(
    file_id: str,
    session: SessionDep,
    user: UserDep,
    req: PyUserFileProcessRequest | None = None,
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)] = settings,
    runner: Annotated[UserFileProcessingRunner | None, Depends(request_user_file_processing_runner)] = None,
) -> PyUserFileProcessResponse:
    """Enqueue a durable processing job for a finalized current-user file."""

    # An image has no processing job: it is ready once its canonical copy is
    # stored. This route returns its state, first storing the copy if an
    # interrupted finalize left the image at ``uploaded``. (Kept out of the
    # docstring, which is the operation's OpenAPI description.)
    service = _service(session)
    try:
        user_file = await service.get_user_file(user_id=user.id, file_id=file_id)
    except UserFileNotFoundError:
        user_file = None  # The processing service reports a missing file below.
    if user_file is not None and is_image_user_file(user_file):
        if user_file.status == STATUS_UPLOADED:
            user_file = await _store_canonical_image(
                service,
                user_file,
                size_bytes=_stored_size_bytes(user_file.storage_locator),
            )
        return PyUserFileProcessResponse(file_id=user_file.id, file_status=user_file.status, reused_existing_job=False)

    try:
        result = await _processing_service(
            session, processing_enabled=runtime_settings.animama_user_file_processing_enabled
        ).enqueue_processing_job(
            user_id=user.id,
            file_id=file_id,
            force=bool(req.force) if req is not None else False,
        )
    except (
        UserFileProcessingValidationError,
        UserFileProcessingNotFoundError,
        UserFileProcessingConflictError,
        UserFileProcessingUnavailableError,
    ) as exc:
        _raise_processing_http_error(exc)
    if runner is not None:
        # Start the job now rather than at the runner's next poll.
        runner.wake()
    return PyUserFileProcessResponse(
        file_id=result.file_id,
        job_id=result.job_id,
        file_status=result.file_status,
        job_status=result.job_status,
        reused_existing_job=result.reused_existing_job,
    )


@router.post(
    "/v1/files/debug/search",
    response_model=PyUserFileSearchResponse,
    status_code=status.HTTP_200_OK,
)
async def search_user_file_chunks(
    req: PyUserFileSearchRequest,
    session: SessionDep,
    user: UserDep,
    roles: Annotated[ModelRoleSettings, Depends(get_model_role_settings)],
) -> PyUserFileSearchResponse:
    """Search current-user processed file chunks for debug retrieval validation."""

    embedder = await role_embedder(session, user.id, roles) if req.mode in {"semantic", "hybrid"} else None
    try:
        results = await _processing_service(session).search(
            user_id=user.id,
            query=req.query,
            mode=req.mode,
            limit=req.limit,
            file_ids=req.file_ids,
            embedder=embedder,
        )
    except (
        UserFileProcessingValidationError,
        UserFileProcessingNotFoundError,
        UserFileProcessingConflictError,
        UserFileProcessingUnavailableError,
    ) as exc:
        _raise_processing_http_error(exc)
    return PyUserFileSearchResponse(
        query=results.query,
        mode=results.mode,
        results=[_search_result_response(result) for result in results.results],
        warnings=results.warnings,
    )


@router.delete(
    "/v1/files/uploads/{file_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def abort_user_file_upload(
    file_id: str,
    session: SessionDep,
    user: UserDep,
) -> Response:
    """Abort a pending user-file upload and best-effort delete its object."""

    service = _service(session)
    try:
        user_file = await service.get_file_for_abort(user_id=user.id, file_id=file_id)
    except (UserFileNotFoundError, UserFileConflictError) as exc:
        _raise_http_error(exc)

    if user_file.status in {STATUS_ABORTED, STATUS_DELETE_PENDING}:
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    object_deleted = delete_private_file(user_file.storage_locator)
    try:
        await service.mark_upload_abort_result(
            user_id=user.id,
            file_id=file_id,
            object_deleted=object_deleted,
        )
    except (UserFileNotFoundError, UserFileConflictError) as exc:
        _raise_http_error(exc)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/v1/files/{file_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_user_file(
    file_id: str,
    session: SessionDep,
    user: UserDep,
) -> Response:
    """Best-effort delete a user file object and tombstone its metadata row."""

    service = _service(session)
    try:
        user_file = await service.get_file_for_delete(user_id=user.id, file_id=file_id)
    except UserFileNotFoundError as exc:
        _raise_http_error(exc)

    object_deleted = delete_private_file(user_file.storage_locator)
    try:
        await service.mark_file_delete_result(
            user_id=user.id,
            file_id=file_id,
            object_deleted=object_deleted,
        )
        await _processing_service(session).delete_chunks_for_file(user_id=user.id, file_id=file_id)
    except UserFileNotFoundError as exc:
        _raise_http_error(exc)
    except Exception as exc:
        _log.warning(
            "User file chunk cleanup failed during delete",
            file_id=file_id,
            user_id=user.id,
            error=str(exc),
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = [
    "abort_user_file_upload",
    "delete_user_file",
    "finalize_user_file_upload",
    "get_user_file",
    "get_user_file_content",
    "init_user_file_upload",
    "upload_user_file_content",
    "list_user_files",
    "process_user_file",
    "router",
    "search_user_file_chunks",
]

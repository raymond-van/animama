from __future__ import annotations

import hashlib
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from animama.adapters.content_store.private_file_store import FilesystemPrivateFileStorage
from animama.domain.request_principal import RequestPrincipal
from animama.domain.user_file import STATUS_FAILED, STATUS_READY, UserFile
from animama.product_http.chat.session_services import SessionBackedChatImageLoader
from animama.server.config import Settings
from animama.server.local_runtime import initialize_local_runtime


class _Files:
    def __init__(self, rows: list[UserFile]) -> None:
        self.rows = {row.id: row for row in rows}

    async def get_user_file(self, *, user_id: str, file_id: str, include_deleted: bool = False) -> UserFile | None:
        row = self.rows.get(file_id)
        return row if row is not None and row.user_id == user_id else None


def _sessions(tmp_path: Path, rows: list[UserFile]) -> tuple[Any, FilesystemPrivateFileStorage]:
    storage = FilesystemPrivateFileStorage(
        initialize_local_runtime(
            Settings(animama_content_root=tmp_path / "content", animama_data_root=tmp_path / "data")
        )
    )
    files = _Files(rows)

    @asynccontextmanager
    async def read():
        yield object()

    sessions = SimpleNamespace(
        principal=RequestPrincipal(id="user-1"),
        read=read,
        repositories=lambda _session: SimpleNamespace(user_file_processing=files),
        ports=SimpleNamespace(uploads=lambda _principal: SimpleNamespace(private_files=storage)),
    )
    return sessions, storage


def _image(file_id: str, content: bytes, *, user_id: str = "user-1", status: str = STATUS_READY) -> UserFile:
    return UserFile(
        id=file_id,
        user_id=user_id,
        storage_locator=f"user-files/{user_id}/{file_id}/original",
        original_filename=f"{file_id}.png",
        normalized_extension=".png",
        declared_size_bytes=len(content),
        status=status,
        detected_content_type="image/png",
        stored_size_bytes=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
        upload_expires_at=datetime.now(UTC) + timedelta(minutes=10),
        metadata={"kind": "image", "image": {"width": 4, "height": 4, "media_type": "image/png"}},
    )


def _store(storage: FilesystemPrivateFileStorage, row: UserFile, content: bytes) -> None:
    assert storage.put_stream(row.storage_locator, BytesIO(content), content_length=len(content))


@pytest.mark.asyncio
async def test_loader_reads_the_owners_ready_images(tmp_path: Path) -> None:
    row = _image("file-1", b"png bytes")
    sessions, storage = _sessions(tmp_path, [row])
    _store(storage, row, b"png bytes")

    loaded = await SessionBackedChatImageLoader(sessions).load(["file-1"])

    assert set(loaded) == {"file-1"}
    assert loaded["file-1"].content == b"png bytes"
    assert loaded["file-1"].media_type == "image/png"


@pytest.mark.asyncio
async def test_loader_leaves_out_what_it_must_not_send(tmp_path: Path) -> None:
    foreign = _image("foreign", b"theirs", user_id="user-2")
    failed = _image("failed", b"failed", status=STATUS_FAILED)
    document = _image("document", b"text")
    document.metadata = {}
    changed = _image("changed", b"original")
    missing = _image("missing", b"never stored")
    sessions, storage = _sessions(tmp_path, [foreign, failed, document, changed, missing])
    for row, content in ((foreign, b"theirs"), (failed, b"failed"), (document, b"text"), (changed, b"replaced")):
        _store(storage, row, content)

    loaded = await SessionBackedChatImageLoader(sessions).load(
        ["foreign", "failed", "document", "changed", "missing", "unknown"]
    )

    assert loaded == {}

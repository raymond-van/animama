"""Shared routes take per-owner sessions from composition-installed ports (ADR 0021)."""

from __future__ import annotations

import asyncio
import hashlib
import io
import shutil
from collections.abc import AsyncIterator, MutableMapping
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

from fastapi import FastAPI, Request, Response, WebSocket
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from animama.app.contracts.runtime_capabilities import RuntimeCapabilities
from animama.app.safety.crisis_resources import CrisisResourceTable, crisis_resource_table
from animama.app.services.embedding_refresh_service import EmbeddingRefreshStatus
from animama.app.services.memory_manager_service import MemoryManagerService
from animama.app.services.model_provider_catalog_service import ModelCatalogPolicy
from animama.app.services.model_role_resolver import ModelRoleDefaults
from animama.domain.content_catalog import VerifiedContentFile
from animama.domain.request_principal import RequestPrincipal
from animama.product_http.delivery import PackageDownloadResponse
from animama.product_http.ports import (
    ChatTurnAdmission,
    ChatTurnLease,
    ChatTurnServices,
    ProductPolicy,
    ProductUploads,
    ReadContent,
    ReadRepositories,
    ReadSession,
    UserSettingsMutation,
    WriteContent,
    WriteRepositories,
    WriteSession,
    install_product_ports,
)
from animama.server.app import create_local_app
from animama.server.config import Settings
from animama.server.local_runtime import initialize_local_runtime
from animama.server.product_ports import LocalProductPorts, local_file_response
from tests.product_http_support import HOSTED_CAPABILITIES, TEST_CHAT_POLICY, FakeSpeech

OWNER = RequestPrincipal(id="owner")


class FixedOwner:
    async def resolve_http(self, request: Request) -> RequestPrincipal:
        return OWNER

    async def resolve_websocket(self, websocket: WebSocket) -> RequestPrincipal:
        return OWNER


def session_probe_app(*, resolver: object | None = FixedOwner()) -> FastAPI:
    app = FastAPI()
    if resolver is not None:
        app.state.request_principal_resolver = resolver

    @app.get("/read")
    async def read(session: ReadSession) -> dict[str, str]:
        return {"session": str(session)}

    @app.post("/write")
    async def write(session: WriteSession) -> dict[str, str]:
        return {"session": str(session)}

    return app


class RecordingPorts:
    """Opens placeholder sessions and records whose they are; can fail the deferred commit."""

    policy = ProductPolicy(memory_file_max_bytes=1, voice_catalog_max_upload_bytes=1, private_upload_ttl_seconds=1)
    model_catalog_policy = ModelCatalogPolicy()
    model_role_defaults = ModelRoleDefaults(chat="chat-model")
    speech = FakeSpeech()
    chat_policy = TEST_CHAT_POLICY

    def __init__(self, *, fail_commit: bool = False) -> None:
        self.opened: list[tuple[str, str]] = []
        self.fail_commit = fail_commit

    @asynccontextmanager
    async def read_session(self, principal: RequestPrincipal) -> AsyncIterator[AsyncSession]:
        self.opened.append(("read", principal.id))
        yield MagicMock(spec=AsyncSession)

    @asynccontextmanager
    async def write_session(self, principal: RequestPrincipal) -> AsyncIterator[AsyncSession]:
        self.opened.append(("write", principal.id))
        yield MagicMock(spec=AsyncSession)
        if self.fail_commit:
            raise RuntimeError("deferred commit failed")

    def repositories(self, session: AsyncSession) -> Any:
        return SimpleNamespace(session=session)

    async def update_display_name(self, session: AsyncSession, principal: RequestPrincipal, display_name: str) -> str:
        return display_name

    def crisis_resources(self) -> CrisisResourceTable:
        return crisis_resource_table()

    def content(self, session: AsyncSession, principal: RequestPrincipal) -> Any:
        raise NotImplementedError

    def file_response(
        self, request: Request, file: VerifiedContentFile, *, if_none_match: str | None, revalidate: bool
    ) -> Response:
        raise NotImplementedError

    async def json_response(
        self,
        request: Request,
        body: bytes,
        *,
        encoding: str,
        headers: dict[str, str],
        if_none_match: str | None,
        cacheable: bool,
    ) -> Response:
        raise NotImplementedError

    def download_response(self, request: Request, download: Any) -> Response:
        raise NotImplementedError

    async def runtime_capabilities(self, session: AsyncSession, principal: RequestPrincipal) -> RuntimeCapabilities:
        return HOSTED_CAPABILITIES

    async def prepare_user_settings_change(
        self, session: AsyncSession, principal: RequestPrincipal, mutation: UserSettingsMutation
    ) -> None:
        pass

    def user_settings_changed(self, principal: RequestPrincipal) -> None:
        pass

    async def embedding_refresh_status(
        self, session: AsyncSession, principal: RequestPrincipal, embedding_model_id: str | None
    ) -> EmbeddingRefreshStatus:
        raise NotImplementedError

    async def memory_manager(self, session: AsyncSession, principal: RequestPrincipal) -> MemoryManagerService:
        raise NotImplementedError

    def uploads(self, principal: RequestPrincipal) -> ProductUploads:
        raise NotImplementedError

    async def admit_chat_turn(self, principal: RequestPrincipal, admission: ChatTurnAdmission) -> ChatTurnLease:
        raise NotImplementedError

    def chat_turn(self, principal: RequestPrincipal, lease: ChatTurnLease) -> ChatTurnServices:
        raise NotImplementedError


def test_shared_routes_fail_closed_without_installed_ports() -> None:
    with TestClient(session_probe_app()) as client:
        responses = [client.get("/read"), client.post("/write")]
    for response in responses:
        assert response.status_code == 503
        assert response.json() == {"detail": {"code": "product_ports_unavailable"}}


def test_no_session_opens_before_the_principal_resolves() -> None:
    app = session_probe_app(resolver=None)
    ports = RecordingPorts()
    install_product_ports(app, ports)
    with TestClient(app) as client:
        responses = [client.get("/read"), client.post("/write")]
    for response in responses:
        assert response.status_code == 503
        assert response.json() == {"detail": {"code": "request_principal_unavailable"}}
    assert ports.opened == []


def test_sessions_open_for_the_resolved_principal() -> None:
    app = session_probe_app()
    ports = RecordingPorts()
    install_product_ports(app, ports)
    with TestClient(app) as client:
        assert client.get("/read").status_code == 200
        assert client.post("/write").status_code == 200
    assert ports.opened == [("read", "owner"), ("write", "owner")]


def test_local_app_installs_ports_without_opening_the_database(tmp_path: Path) -> None:
    factory = MagicMock(side_effect=AssertionError("ports must not open a session at startup"))
    app = create_local_app(
        runtime_settings=Settings(animama_content_root=tmp_path / "content", animama_data_root=tmp_path / "data"),
        session_factory=factory,
    )
    assert isinstance(app.state.product_ports, LocalProductPorts)
    factory.assert_not_called()


def test_local_ports_open_sessions_from_the_app_factory() -> None:
    opened: list[str] = []

    @asynccontextmanager
    async def factory() -> AsyncIterator[str]:
        opened.append("session")
        yield "session"

    app = session_probe_app()
    app.state.session_factory = factory
    install_product_ports(app, LocalProductPorts(app))
    with TestClient(app) as client:
        assert client.get("/read").json() == {"session": "session"}
        assert client.post("/write").json() == {"session": "session"}
    assert opened == ["session", "session"]


def test_a_write_session_ends_before_the_response_is_sent() -> None:
    # The failure must replace the handler's success; a session ended after
    # sending would have reported 200 for a write that never became durable.
    app = session_probe_app()
    install_product_ports(app, RecordingPorts(fail_commit=True))
    with TestClient(app, raise_server_exceptions=False) as client:
        assert client.post("/write").status_code == 500
        assert client.get("/read").status_code == 200


def test_repositories_come_from_the_ports_over_the_opened_session() -> None:
    app = FastAPI()
    app.state.request_principal_resolver = FixedOwner()

    @app.get("/repositories")
    async def read(repositories: ReadRepositories, session: ReadSession) -> dict[str, bool]:
        return {"same_session": repositories.session is session}  # type: ignore[attr-defined]

    @app.post("/repositories")
    async def write(repositories: WriteRepositories, session: WriteSession) -> dict[str, bool]:
        return {"same_session": repositories.session is session}  # type: ignore[attr-defined]

    ports = RecordingPorts()
    install_product_ports(app, ports)
    with TestClient(app) as client:
        assert client.get("/repositories").json() == {"same_session": True}
        assert client.post("/repositories").json() == {"same_session": True}
    # Each request opened one session, shared by its repositories.
    assert ports.opened == [("read", "owner"), ("write", "owner")]


def test_local_policy_follows_the_apps_runtime_settings(tmp_path: Path) -> None:
    app = create_local_app(
        runtime_settings=Settings(
            animama_content_root=tmp_path / "content",
            animama_data_root=tmp_path / "data",
            anima_memory_file_max_bytes=1234,
            anima_pocket_voice_catalog_max_upload_bytes=5678,
            private_upload_url_ttl_seconds=60,
        ),
        session_factory=MagicMock(),
    )
    assert app.state.product_ports.policy == ProductPolicy(
        memory_file_max_bytes=1234, voice_catalog_max_upload_bytes=5678, private_upload_ttl_seconds=60
    )


class ContentRecordingPorts(RecordingPorts):
    """Records when content opens, closes and when a streamed body runs."""

    def __init__(self) -> None:
        super().__init__()
        self.events: list[str] = []

    @asynccontextmanager
    async def content(self, session: AsyncSession, principal: RequestPrincipal) -> AsyncIterator[Any]:
        self.events.append(f"open:{principal.id}")
        yield SimpleNamespace(session=session)
        self.events.append("close")


def test_read_content_outlives_a_streamed_body_and_write_content_does_not() -> None:
    app = FastAPI()
    app.state.request_principal_resolver = FixedOwner()
    ports = ContentRecordingPorts()
    install_product_ports(app, ports)

    def body() -> Any:
        ports.events.append("body")
        yield b"bytes"

    @app.get("/content")
    async def read(content: ReadContent) -> StreamingResponse:
        return StreamingResponse(body())

    @app.post("/content")
    async def write(content: WriteContent) -> StreamingResponse:
        return StreamingResponse(body())

    with TestClient(app) as client:
        assert client.get("/content").content == b"bytes"
        read_events, ports.events[:] = list(ports.events), []
        assert client.post("/content").content == b"bytes"
    # Streamed bytes stay readable for read content; write content ends with its session.
    assert read_events == ["open:owner", "body", "close"]
    assert ports.events == ["open:owner", "close", "body"]


def test_local_content_requires_the_startup_runtime_paths(tmp_path: Path) -> None:
    app = session_probe_app()
    app.state.session_factory = MagicMock()
    app.state.runtime_settings = Settings(
        animama_content_root=tmp_path / "content", animama_data_root=tmp_path / "data"
    )
    install_product_ports(app, LocalProductPorts(app))

    @app.get("/content")
    async def read(content: ReadContent) -> dict[str, str]:
        return {"store": type(content.store).__name__}

    with TestClient(app) as client:
        refused = client.get("/content")
    assert (refused.status_code, refused.json()) == (503, {"detail": {"code": "content_unavailable"}})
    # The refused request created nothing.
    assert list(tmp_path.iterdir()) == []

    paths = initialize_local_runtime(app.state.runtime_settings)
    app.state.local_runtime_paths = paths
    with TestClient(app) as client:
        assert client.get("/content").json() == {"store": "FilesystemContentStore"}


def test_local_files_are_revalidated_or_never_stored() -> None:
    def verified(content: bytes) -> VerifiedContentFile:
        return VerifiedContentFile(
            handle=io.BytesIO(content),
            size_bytes=len(content),
            sha256=hashlib.sha256(content).hexdigest(),
            media_type="application/octet-stream",
        )

    revalidated = local_file_response(verified(b"abc"), if_none_match=None, revalidate=True)
    assert (revalidated.status_code, revalidated.headers["cache-control"]) == (200, "private, no-cache")
    assert revalidated.headers["content-length"] == "3"
    assert revalidated.headers["x-content-type-options"] == "nosniff"
    etag = revalidated.headers["etag"]
    assert etag == f'"{hashlib.sha256(b"abc").hexdigest()}"'

    file = verified(b"abc")
    unchanged = local_file_response(file, if_none_match=etag, revalidate=True)
    assert unchanged.status_code == 304 and "content-length" not in unchanged.headers
    assert file.handle.closed

    never_stored = local_file_response(verified(b"abc"), if_none_match=None, revalidate=False)
    assert never_stored.headers["cache-control"] == "private, no-store"


def test_content_requests_never_recreate_the_staging_directories(tmp_path: Path) -> None:
    app = session_probe_app()
    app.state.session_factory = MagicMock()
    app.state.runtime_settings = Settings(
        animama_content_root=tmp_path / "content", animama_data_root=tmp_path / "data"
    )
    paths = initialize_local_runtime(app.state.runtime_settings)
    app.state.local_runtime_paths = paths
    install_product_ports(app, LocalProductPorts(app))

    @app.get("/content")
    async def read(content: ReadContent) -> dict[str, str]:
        return {"store": type(content.store).__name__}

    with TestClient(app) as client:
        assert client.get("/content").status_code == 200
        shutil.rmtree(paths.data_staging_root)
        assert client.get("/content").status_code == 200
    # One package-stage coordinator serves every request; none recreated its roots.
    assert not paths.data_staging_root.exists()


async def test_a_download_releases_its_lease_before_the_last_chunk_is_sent() -> None:
    events: list[str] = []
    archive = b"z" * (1024 * 1024 + 7)

    class Download:
        handle = io.BytesIO(archive)
        review = SimpleNamespace(filename="wave.zip", size_bytes=len(archive), package_sha256="0" * 64)

        def close(self, *, reclaimable: bool = False) -> None:
            events.append(f"release reclaimable={reclaimable}")

    async def receive() -> MutableMapping[str, Any]:
        # The client never disconnects; the response stops listening when it ends.
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    async def send(message: MutableMapping[str, Any]) -> None:
        if message["type"] == "http.response.body":
            events.append(f"body {len(message.get('body', b''))} more={message.get('more_body', False)}")

    response = PackageDownloadResponse(Download())  # type: ignore[arg-type]
    await response({"type": "http", "method": "GET", "path": "/"}, receive, send)
    # The lease is released, once, before the client can receive the last byte.
    assert events == [
        "body 1048576 more=True",
        "release reclaimable=True",
        "body 7 more=True",
        "body 0 more=False",
    ]


async def test_a_failed_lease_release_still_delivers_the_whole_archive() -> None:
    sent: list[bytes] = []
    archive = b"z" * (1024 * 1024 + 7)

    class Download:
        handle = io.BytesIO(archive)
        review = SimpleNamespace(filename="wave.zip", size_bytes=len(archive), package_sha256="0" * 64)

        def close(self, *, reclaimable: bool = False) -> None:
            raise OSError("disk full")

    async def receive() -> MutableMapping[str, Any]:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    async def send(message: MutableMapping[str, Any]) -> None:
        if message["type"] == "http.response.body":
            sent.append(message.get("body", b""))

    response = PackageDownloadResponse(Download())  # type: ignore[arg-type]
    await response({"type": "http", "method": "GET", "path": "/"}, receive, send)
    # The verified archive is delivered in full; the stage merely stays unreclaimed.
    assert b"".join(sent) == archive

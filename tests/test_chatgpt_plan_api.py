"""ChatGPT plan routes and the sign-in return through the real admission boundary (T1 to T3, T8)."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import textwrap
from collections.abc import AsyncIterator, Callable, Iterator, MutableMapping
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI

from animama.adapters.chatgpt_plan.openai_identity import OpenAIChatGPTPlanIdentity
from animama.adapters.chatgpt_plan.session_store import FileChatGPTPlanSessionStore
from animama.app.services.chatgpt_plan_session import ChatGPTPlanSessionService
from animama.domain.chatgpt_plan import ChatGPTPlanAccount, ChatGPTPlanRecord, ChatGPTPlanTokens
from animama.local.http.assets import LocalAssets
from animama.local.http.composition import install_local_http
from animama.local.http.config import CAPABILITY_COOKIE, DesktopAccess, LocalHTTPConfig
from animama.server import chatgpt_plan as chatgpt_plan_module
from animama.server.app import create_local_app
from animama.server.chatgpt_plan import (
    chatgpt_plan_return_uri,
    chatgpt_plan_session_for,
    chatgpt_plan_store_key,
    chatgpt_plan_unavailable_reason,
)
from animama.server.config import Settings
from animama.server.routers.chatgpt_plan import (
    get_chatgpt_plan_model_catalog,
    get_chatgpt_plan_model_refresh,
    router,
)
from tests.chatgpt_plan_fakes import FakeOpenAIAuth

PORT = 8765
DESKTOP = DesktopAccess(renderer_capability="r" * 64, control_token="c" * 64)
KEY = bytes(range(32))
NAVIGATION = {"sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document"}


@dataclass
class Installation:
    app: FastAPI
    client: httpx.AsyncClient
    fake: FakeOpenAIAuth
    origin: str
    desktop: bool

    def page_headers(self, *, mutation: bool = False) -> dict[str, str]:
        headers = {"origin": self.origin, "sec-fetch-site": "same-origin"}
        if mutation:
            headers["x-animama-csrf"] = "1"
        if self.desktop:
            headers["cookie"] = f"{CAPABILITY_COOKIE}={DESKTOP.renderer_capability}"
        return headers

    async def begin(self) -> str:
        response = await self.client.post(
            "/v1/chatgpt-plan/sign-in", json={"ui_locale": "ja"}, headers=self.page_headers(mutation=True)
        )
        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "no-store"
        return str(response.json()["authorize_url"])

    async def return_from_openai(self, params: dict[str, str], **headers: str) -> httpx.Response:
        return await self.client.get(
            "/auth/callback",
            params=params,
            headers={"host": f"127.0.0.1:{PORT}", **NAVIGATION, **headers},
        )


def _app(tmp_path: Path, *, origin: str, desktop: bool, key: bytes | None, fake: FakeOpenAIAuth) -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    config = LocalHTTPConfig(origin, desktop=DESKTOP if desktop else None, sign_in_return_path="/auth/callback")
    app.state.local_http_config = config
    app.state.local_runtime_paths = SimpleNamespace(data_internal_root=tmp_path / "internal")
    app.state.chatgpt_plan_store_key = key
    identity = OpenAIChatGPTPlanIdentity(transport=fake.transport())
    app.state.chatgpt_plan_identity = identity
    app.state.chatgpt_plan_session = ChatGPTPlanSessionService(
        identity=identity, store=FileChatGPTPlanSessionStore(tmp_path / "internal" / "chatgpt-plan", key=key)
    )
    app.state.model_catalog = _FakeModelCatalog()
    app.dependency_overrides[get_chatgpt_plan_model_catalog] = lambda: app.state.model_catalog
    app.dependency_overrides[get_chatgpt_plan_model_refresh] = lambda: app.state.model_catalog.refresh_after_sign_in
    install_local_http(app, config).mark_ready("installation-owner")
    return app


class _FakeModelCatalog:
    """The plan's model rows, without a database: records what the routes asked for."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def refresh(self) -> list[Any]:
        self.calls.append("refresh")
        return []

    async def withdraw(self) -> int:
        self.calls.append("withdraw")
        return 0

    async def refresh_after_sign_in(self) -> None:
        self.calls.append("refresh after sign-in")


@pytest_asyncio.fixture(params=["self-host", "desktop"])
async def installation(request: pytest.FixtureRequest, tmp_path: Path) -> AsyncIterator[Installation]:
    desktop = request.param == "desktop"
    origin = f"http://127.0.0.1:{PORT}" if desktop else f"http://localhost:{PORT}"
    fake = FakeOpenAIAuth()
    app = _app(tmp_path, origin=origin, desktop=desktop, key=KEY if desktop else None, fake=fake)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url=origin) as client:
        yield Installation(app=app, client=client, fake=fake, origin=origin, desktop=desktop)
    await app.state.chatgpt_plan_identity.aclose()


async def test_a_sign_in_completes_through_the_return(installation: Installation) -> None:
    status = await installation.client.get("/v1/chatgpt-plan", headers=installation.page_headers())
    assert status.json()["sign_in_available"] is True and status.json()["state"] == "signed_out"

    url = await installation.begin()
    assert parse_qs(urlsplit(url).query)["redirect_uri"] == [f"http://127.0.0.1:{PORT}/auth/callback"]
    page = await installation.return_from_openai(installation.fake.authorize(url))

    assert page.status_code == 200 and page.headers["content-type"].startswith("text/html")
    assert page.headers["cache-control"] == "no-store" and page.headers["referrer-policy"] == "no-referrer"
    assert "default-src 'none'" in page.headers["content-security-policy"]
    assert 'lang="ja"' in page.text
    assert installation.app.state.model_catalog.calls == ["refresh after sign-in"]
    after = (await installation.client.get("/v1/chatgpt-plan", headers=installation.page_headers())).json()
    assert (after["state"], after["email"], after["confirmation_due"]) == ("signed_in", "person@example.test", True)


def _refusal(installation: Installation, *, desktop: int = 403) -> int:
    """What the normal checks answer a request at the return authority.

    A self-hosted page lives at ``localhost``, so ``127.0.0.1`` fails its exact
    Host rule (421). Desktop's page origin is the return authority, so the
    browser checks answer instead: a cross-site or Origin-less mutation is 403,
    and a request with no renderer cookie is 401.
    """

    return desktop if installation.desktop else 421


@pytest.mark.parametrize(
    ("variant", "headers", "desktop"),
    [
        ("an Origin header", {"origin": "https://auth.openai.com"}, 403),
        ("another port", {"host": f"127.0.0.1:{PORT + 1}"}, 421),
        ("a foreign host", {"host": "evil.test"}, 421),
        ("a subresource fetch", {"sec-fetch-mode": "no-cors", "sec-fetch-dest": "image"}, 403),
        ("a script fetch", {"sec-fetch-mode": "cors", "sec-fetch-dest": "empty"}, 403),
        ("a frame", {"sec-fetch-dest": "iframe"}, 403),
        ("a non-navigation fetch of a document", {"sec-fetch-mode": "cors"}, 403),
        ("a chunked body", {"transfer-encoding": "chunked"}, 403),
    ],
)
async def test_a_return_that_misses_a_condition_gets_the_normal_checks(
    installation: Installation, variant: str, headers: dict[str, str], desktop: int
) -> None:
    url = await installation.begin()
    params = installation.fake.authorize(url)

    refused = await installation.return_from_openai(params, **headers)

    assert refused.status_code == (desktop if installation.desktop else 421), variant
    status = (await installation.client.get("/v1/chatgpt-plan", headers=installation.page_headers())).json()
    assert (status["state"], status["sign_in_pending"]) == ("signed_out", True), variant


async def test_a_return_at_the_page_host_gets_the_normal_checks(installation: Installation) -> None:
    page_host = urlsplit(installation.origin).netloc
    refused = await installation.return_from_openai(
        installation.fake.authorize(await installation.begin()), host=page_host
    )
    # Self-hosted: the page host passes the Host rule, then cross-site fetch metadata is refused.
    # Desktop: the page host is the return authority itself, so the return completes.
    assert refused.status_code == (200 if installation.desktop else 403)


@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE", "PATCH"])
async def test_only_get_is_exempt(installation: Installation, method: str) -> None:
    response = await installation.client.request(
        method, "/auth/callback", headers={"host": f"127.0.0.1:{PORT}", **NAVIGATION}
    )
    assert response.status_code == _refusal(installation)


@pytest.mark.parametrize("path", ["/auth/callback/x", "/auth/other", "/auth", "/v1/chatgpt-plan", "/health"])
async def test_no_other_path_is_exempt(installation: Installation, path: str) -> None:
    response = await installation.client.get(path, headers={"host": f"127.0.0.1:{PORT}", **NAVIGATION})
    assert response.status_code == _refusal(installation)


async def test_desktop_api_routes_still_need_the_renderer_cookie_at_the_return_authority(
    installation: Installation,
) -> None:
    # Everything the exemption checks, except the path: an Origin-less top-level navigation.
    response = await installation.client.get(
        "/v1/chatgpt-plan",
        headers={"host": f"127.0.0.1:{PORT}", "sec-fetch-site": "none", "sec-fetch-mode": "navigate"},
    )
    assert response.status_code == _refusal(installation, desktop=401)


async def test_a_body_is_refused(installation: Installation) -> None:
    response = await installation.client.request(
        "GET", "/auth/callback", content=b"x", headers={"host": f"127.0.0.1:{PORT}", **NAVIGATION}
    )
    assert response.status_code == _refusal(installation)


@pytest.mark.parametrize("desktop", [False, True])
async def test_a_websocket_to_the_return_is_refused(tmp_path: Path, desktop: bool) -> None:
    origin = f"http://127.0.0.1:{PORT}" if desktop else f"http://localhost:{PORT}"
    app = _app(tmp_path, origin=origin, desktop=desktop, key=KEY if desktop else None, fake=FakeOpenAIAuth())
    sent: list[MutableMapping[str, Any]] = []
    scope = {
        "type": "websocket",
        "path": "/auth/callback",
        "raw_path": b"/auth/callback",
        "query_string": b"code=c&state=s",
        # No fetch metadata, so only the method check can refuse the upgrade.
        "headers": [(b"host", f"127.0.0.1:{PORT}".encode())],
        "scheme": "ws",
        "asgi": {"version": "3.0"},
    }

    async def receive() -> MutableMapping[str, Any]:
        return {"type": "websocket.connect"}

    async def send(message: MutableMapping[str, Any]) -> None:
        sent.append(message)

    await app(scope, receive, send)
    await app.state.chatgpt_plan_identity.aclose()

    assert sent and sent[0]["type"] == "websocket.close"
    assert sent[0]["reason"] in {"gateway_request_rejected", "not_found"}


async def test_a_return_with_the_wrong_state_shows_failure_and_keeps_the_attempt(installation: Installation) -> None:
    params = installation.fake.authorize(await installation.begin())

    forged = await installation.return_from_openai({**params, "state": "forged"})
    real = await installation.return_from_openai(params)

    assert forged.status_code == 400 and real.status_code == 200
    assert "forged" not in forged.text and params["code"] not in forged.text


async def test_a_declined_and_a_replayed_return(installation: Installation) -> None:
    url = await installation.begin()
    declined = await installation.return_from_openai(installation.fake.authorize(url, decline=True))
    params = installation.fake.authorize(await installation.begin())
    await installation.return_from_openai(params)
    replayed = await installation.return_from_openai(params)

    assert declined.status_code == 400 and replayed.status_code == 400
    assert (await installation.client.get("/v1/chatgpt-plan", headers=installation.page_headers())).json()[
        "state"
    ] == "signed_in"


async def test_a_repeated_field_is_refused(installation: Installation) -> None:
    params = installation.fake.authorize(await installation.begin())
    response = await installation.client.get(
        f"/auth/callback?code={params['code']}&state={params['state']}&state=other",
        headers={"host": f"127.0.0.1:{PORT}", **NAVIGATION},
    )
    assert response.status_code == 400


async def test_the_return_is_never_logged(installation: Installation, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    params = installation.fake.authorize(await installation.begin())

    page = await installation.return_from_openai(params)

    assert page.status_code == 200
    # Capture includes non-propagating loggers such as httpx, so it also holds this
    # test client's own request line, the browser's navigation in production.
    # Every other record, including the server's outbound httpx calls, still counts.
    navigation = f"{installation.origin}/auth/callback?"
    logged = "\n".join(
        caplog.handler.format(record)
        for record in caplog.records
        if not (record.name == "httpx" and navigation in record.getMessage())
    )
    assert params["code"] not in logged and params["state"] not in logged


async def test_sign_out_and_preferences(installation: Installation) -> None:
    refused = await installation.client.put(
        "/v1/chatgpt-plan/preferences", json={"confirmed": True}, headers=installation.page_headers(mutation=True)
    )
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "chatgpt_plan_not_signed_in"

    await installation.return_from_openai(installation.fake.authorize(await installation.begin()))
    updated = await installation.client.put(
        "/v1/chatgpt-plan/preferences",
        json={"confirmed": True, "background_agreed": True},
        headers=installation.page_headers(mutation=True),
    )
    assert updated.json()["confirmation_due"] is False and updated.json()["background_agreed"] is True

    signed_out = await installation.client.post(
        "/v1/chatgpt-plan:sign-out", headers=installation.page_headers(mutation=True)
    )
    assert signed_out.json() == {"was_signed_in": True, "confirmed": True}
    assert installation.app.state.model_catalog.calls[-1] == "withdraw"

    refreshed = await installation.client.post(
        "/v1/chatgpt-plan/models:refresh", headers=installation.page_headers(mutation=True)
    )
    assert refreshed.json() == {"model_provider_ids": []}
    assert installation.app.state.model_catalog.calls[-1] == "refresh"


async def test_responses_never_carry_a_token(installation: Installation) -> None:
    await installation.return_from_openai(installation.fake.authorize(await installation.begin()))
    body = (await installation.client.get("/v1/chatgpt-plan", headers=installation.page_headers())).text
    assert "access-" not in body and "refresh-" not in body and "eyJ" not in body


async def test_page_routes_still_need_the_page_checks(installation: Installation) -> None:
    response = await installation.client.post(
        "/v1/chatgpt-plan/sign-in", json={}, headers={"origin": "https://evil.test"}
    )
    assert response.status_code == 403


async def test_sign_in_is_not_offered_away_from_a_loopback_origin(tmp_path: Path) -> None:
    fake = FakeOpenAIAuth()
    app = _app(tmp_path, origin="https://animama.example.test", desktop=False, key=None, fake=fake)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="https://animama.example.test") as client:
        headers = {"origin": "https://animama.example.test", "sec-fetch-site": "same-origin", "x-animama-csrf": "1"}
        status = (await client.get("/v1/chatgpt-plan", headers=headers)).json()
        refused = await client.post("/v1/chatgpt-plan/sign-in", json={}, headers=headers)
        callback = await client.get("/auth/callback", headers={"host": "127.0.0.1:443", **NAVIGATION})
    await app.state.chatgpt_plan_identity.aclose()

    assert (status["sign_in_available"], status["unavailable_reason"]) == (False, "remote_origin")
    assert refused.status_code == 409 and refused.json()["detail"]["reason"] == "remote_origin"
    assert callback.status_code == 421


async def test_desktop_without_its_key_offers_no_sign_in(tmp_path: Path) -> None:
    fake = FakeOpenAIAuth()
    origin = f"http://127.0.0.1:{PORT}"
    app = _app(tmp_path, origin=origin, desktop=True, key=None, fake=fake)
    headers = {
        "origin": origin,
        "sec-fetch-site": "same-origin",
        "x-animama-csrf": "1",
        "cookie": f"{CAPABILITY_COOKIE}={DESKTOP.renderer_capability}",
    }
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url=origin) as client:
        status = (await client.get("/v1/chatgpt-plan", headers=headers)).json()
        refused = await client.post("/v1/chatgpt-plan/sign-in", json={}, headers=headers)
    await app.state.chatgpt_plan_identity.aclose()

    assert status["unavailable_reason"] == "secure_storage_unavailable"
    assert refused.status_code == 409


def test_the_return_is_never_traced(monkeypatch: pytest.MonkeyPatch) -> None:
    from animama.server.telemetry import fastapi_excluded_urls

    monkeypatch.delenv("OTEL_PYTHON_FASTAPI_EXCLUDED_URLS", raising=False)
    monkeypatch.delenv("OTEL_PYTHON_EXCLUDED_URLS", raising=False)
    assert fastapi_excluded_urls() == "auth/callback"
    monkeypatch.setenv("OTEL_PYTHON_FASTAPI_EXCLUDED_URLS", "health")
    assert fastapi_excluded_urls() == "health,auth/callback"


@pytest.mark.parametrize(
    ("origin", "authority"),
    [
        ("http://localhost:8000", "127.0.0.1:8000"),
        ("http://127.0.0.1:41234", "127.0.0.1:41234"),
        ("http://localhost", "127.0.0.1"),
        ("http://localhost:80", "127.0.0.1"),
        ("https://localhost:8000", None),
        ("http://[::1]:8000", None),
        ("http://animama.lan:8000", None),
        ("http://animama-task.localhost:8200", "127.0.0.1:8200"),
        ("http://localhost.example.test:8000", None),
    ],
)
def test_the_return_reaches_only_a_loopback_http_origin(origin: str, authority: str | None) -> None:
    assert LocalHTTPConfig(origin, sign_in_return_path="/auth/callback").sign_in_return_authority == authority
    assert LocalHTTPConfig(origin).sign_in_return_authority is None


def test_configured_logging_writes_no_request_lines(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Uvicorn writes access lines, query included, whenever its access logger has a handler."""

    from animama import logging_config

    monkeypatch.setenv("ANIMAMA_LOG_TO_FILE", "0")
    access = logging.getLogger("uvicorn.access")
    saved = (access.handlers[:], access.propagate, access.level)
    try:
        logging_config.configure_logging()
        assert access.hasHandlers() is False
    finally:
        access.handlers[:], access.propagate = saved[0], saved[1]
        access.setLevel(saved[2])


@pytest.fixture
def restored_environment() -> Iterator[None]:
    """A desktop app removes provider keys from the process environment; give them back."""

    saved = dict(os.environ)
    yield
    os.environ.clear()
    os.environ.update(saved)


@pytest.fixture
def store_key(monkeypatch: pytest.MonkeyPatch) -> Callable[[str | None], None]:
    """Deliver a key as Electron main does, to a process that has not taken one yet."""

    monkeypatch.setattr(chatgpt_plan_module, "_PROCESS_STORE_KEY", chatgpt_plan_module._ProcessStoreKey())

    def deliver(value: str | None) -> None:
        if value is None:
            monkeypatch.delenv(chatgpt_plan_module.STORE_KEY_ENV, raising=False)
        else:
            monkeypatch.setenv(chatgpt_plan_module.STORE_KEY_ENV, value)

    return deliver


def _local_app(tmp_path: Path, *, desktop: bool) -> FastAPI:
    origin = f"http://127.0.0.1:{PORT}" if desktop else f"http://localhost:{PORT}"
    settings = Settings(
        animama_public_origin=origin,
        animama_content_root=tmp_path / "content",
        animama_data_root=tmp_path / "data",
        **(
            {"animama_desktop_renderer_capability": "r" * 64, "animama_desktop_control_token": "c" * 64}
            if desktop
            else {}
        ),
    )
    app = create_local_app(runtime_settings=settings)
    app.state.local_runtime_paths = SimpleNamespace(data_internal_root=tmp_path / "data" / "internal")
    return app


def test_the_local_app_offers_sign_in_on_its_loopback_origin(tmp_path: Path) -> None:
    app = _local_app(tmp_path, desktop=False)

    assert chatgpt_plan_unavailable_reason(app) is None
    assert chatgpt_plan_return_uri(app) == f"http://127.0.0.1:{PORT}/auth/callback"


async def test_a_desktop_app_without_its_key_reads_no_session_file(
    tmp_path: Path, restored_environment: None, store_key: Callable[[str | None], None]
) -> None:
    store_key(None)
    app = _local_app(tmp_path, desktop=True)
    tokens = ChatGPTPlanTokens("access-1", "refresh-1", "id-1", expires_at=4e9, earliest_refresh_at=None)
    planted = ChatGPTPlanRecord(
        host_id="urn:uuid:00000000-0000-4000-8000-000000000000",
        client_id="app_1",
        account=ChatGPTPlanAccount(
            subject="s", email="person@example.test", scopes=("chatgpt.tokens.use.direct",), tokens=tokens
        ),
    )
    FileChatGPTPlanSessionStore(tmp_path / "data" / "internal" / "chatgpt-plan", key=None).save(planted)

    try:
        status = await chatgpt_plan_session_for(app).status()
    finally:
        await app.state.chatgpt_plan_identity.aclose()

    assert chatgpt_plan_unavailable_reason(app) == "secure_storage_unavailable"
    assert (status.state, status.email) == ("signed_out", None)


async def test_no_auth_path_falls_back_to_the_app_page(tmp_path: Path) -> None:
    web_root = tmp_path / "web"
    web_root.mkdir()
    (web_root / "index.html").write_text("<!doctype html><title>app shell</title>")
    app = FastAPI()
    config = LocalHTTPConfig(f"http://localhost:{PORT}", sign_in_return_path="/auth/callback")
    install_local_http(app, config, assets=LocalAssets(web_root)).mark_ready("installation-owner")
    page = {"origin": f"http://localhost:{PORT}", "sec-fetch-site": "same-origin", "accept": "text/html"}

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url=f"http://localhost:{PORT}") as client:
        shell = await client.get("/settings", headers=page)
        missing = [await client.get(path, headers=page) for path in ("/auth", "/auth/other", "/auth/callback")]

    assert shell.status_code == 200 and "app shell" in shell.text
    assert [response.status_code for response in missing] == [404, 404, 404]


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("POST", "/v1/chatgpt-plan/sign-in", {"enable_plan_use": False, "redirect_uri": "https://evil.test"}),
        ("PUT", "/v1/chatgpt-plan/preferences", {"confirmed": True, "email": "other@example.test"}),
    ],
)
async def test_routes_accept_fixed_fields_only(
    installation: Installation, method: str, path: str, body: dict[str, object]
) -> None:
    response = await installation.client.request(
        method, path, json=body, headers=installation.page_headers(mutation=True)
    )
    assert response.status_code == 422


async def test_an_unreadable_session_is_a_temporary_failure_on_every_route(
    installation: Installation, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = installation.app.state.chatgpt_plan_session
    service._record = None  # forget the cached record, so the next call reads the file

    def unreadable(self: FileChatGPTPlanSessionStore) -> None:
        raise OSError("disk unavailable")

    monkeypatch.setattr(FileChatGPTPlanSessionStore, "load", unreadable)
    headers = installation.page_headers(mutation=True)
    answers = [
        await installation.client.get("/v1/chatgpt-plan", headers=installation.page_headers()),
        await installation.client.post("/v1/chatgpt-plan/sign-in", json={}, headers=headers),
        await installation.client.post("/v1/chatgpt-plan:sign-out", headers=headers),
        await installation.client.put("/v1/chatgpt-plan/preferences", json={"confirmed": True}, headers=headers),
    ]

    assert [answer.status_code for answer in answers] == [503] * 4
    assert {answer.json()["detail"]["code"] for answer in answers} == {"chatgpt_plan_temporarily_unavailable"}


def test_tracing_uses_the_exclusions(monkeypatch: pytest.MonkeyPatch) -> None:
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    from animama.server import telemetry

    seen: dict[str, object] = {}
    monkeypatch.setattr(FastAPIInstrumentor, "instrument_app", lambda app, **options: seen.update(options))
    monkeypatch.setattr(telemetry, "_instrumented", set())
    monkeypatch.delenv("OTEL_PYTHON_DISABLED_INSTRUMENTATIONS", raising=False)

    telemetry._instrument_fastapi(FastAPI())

    assert seen == {"excluded_urls": telemetry.fastapi_excluded_urls()}


async def test_a_desktop_app_keeps_its_session_encrypted_under_the_vault_key(
    tmp_path: Path, restored_environment: None, store_key: Callable[[str | None], None]
) -> None:
    key = "ab" * 32
    store_key(key)
    app = _local_app(tmp_path, desktop=True)
    # A second app in the same process, as the desktop serve command builds, keeps the key.
    assert chatgpt_plan_store_key(_local_app(tmp_path / "second", desktop=True)) == bytes.fromhex(key)
    directory = tmp_path / "data" / "internal" / "chatgpt-plan"

    try:
        await chatgpt_plan_session_for(app).begin(redirect_uri=f"http://127.0.0.1:{PORT}/auth/callback")
    finally:
        await app.state.chatgpt_plan_identity.aclose()

    assert chatgpt_plan_unavailable_reason(app) is None
    assert sorted(item.name for item in directory.iterdir()) == ["session.bin"]
    assert FileChatGPTPlanSessionStore(directory, key=bytes.fromhex(key)).load() is not None
    # The key reaches no child process and no settings printout.
    assert "ANIMAMA_CHATGPT_PLAN_STORE_KEY" not in os.environ
    assert key not in repr(app.state.runtime_settings) and key not in repr(app.state.chatgpt_plan_session)


@pytest.mark.parametrize("key", ["short", "zz" * 32, "AB" * 32 + "00"])
def test_a_malformed_key_means_no_sign_in(
    tmp_path: Path,
    restored_environment: None,
    key: str,
    caplog: pytest.LogCaptureFixture,
    store_key: Callable[[str | None], None],
) -> None:
    store_key(key)
    app = _local_app(tmp_path, desktop=True)

    assert chatgpt_plan_unavailable_reason(app) == "secure_storage_unavailable"
    assert "ChatGPT plan store key" in caplog.text and key not in caplog.text


def test_the_desktop_serve_command_hands_the_key_to_the_app_it_serves(tmp_path: Path) -> None:
    """``animama-runtime serve`` imports the module-level app first, then builds the one it serves.

    It runs in a fresh interpreter, as Electron main launches it: the module
    import order there is what lost the key, and this test process has already
    imported the app.
    """

    script = textwrap.dedent(
        """
        import json, os, sys
        import animama.local.http.server as server
        captured = {}
        server.serve = lambda application, **options: captured.update(app=application)
        from animama.runtime import cli
        cli.main(["serve", "--host", "127.0.0.1", "--port", sys.argv[1]])
        from animama.server.chatgpt_plan import chatgpt_plan_unavailable_reason
        print(json.dumps({
            "reason": chatgpt_plan_unavailable_reason(captured["app"]),
            "key_in_environment": "ANIMAMA_CHATGPT_PLAN_STORE_KEY" in os.environ,
        }))
        """
    )
    environment = {
        name: value
        for name, value in os.environ.items()
        if not name.startswith("ANIMAMA_") and name not in {"OPENAI_API_KEY", "ANTHROPIC_API_KEY"}
    }
    environment.update(
        ANIMAMA_PUBLIC_ORIGIN=f"http://127.0.0.1:{PORT}",
        ANIMAMA_DESKTOP_RENDERER_CAPABILITY="r" * 64,
        ANIMAMA_DESKTOP_CONTROL_TOKEN="c" * 64,
        ANIMAMA_WEB_ROOT=str(tmp_path / "web"),
        ANIMAMA_DATA_ROOT=str(tmp_path / "data"),
        ANIMAMA_CONTENT_ROOT=str(tmp_path / "content"),
        ANIMAMA_PROCESS_START_TOKEN="start-token",
        ANIMAMA_LOG_TO_FILE="0",
        ANIMAMA_LOG_TO_CONSOLE="0",
        OTEL_SDK_DISABLED="1",
        ANIMAMA_CHATGPT_PLAN_STORE_KEY="ab" * 32,
    )

    result = subprocess.run(
        [sys.executable, "-c", script, str(PORT)],
        env=environment,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )

    assert result.returncode == 0, result.stderr[-2000:]
    assert json.loads(result.stdout.strip().splitlines()[-1]) == {"reason": None, "key_in_environment": False}

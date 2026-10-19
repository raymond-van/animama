"""Mount the shared product HTTP package from an installed wheel, with local code blocked.

Run with Python isolated mode from outside the source checkout. Importing a local
composition module fails here, so the shared package cannot depend on one.
"""

from __future__ import annotations

import importlib.abc
import json
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from copy import deepcopy
from types import SimpleNamespace

FORBIDDEN = ("animama.local", "animama.server", "animama.runtime", "animama.hooks", "animama.logging_config")


class LocalImportBlocker(importlib.abc.MetaPathFinder):
    """Refuse every local composition module a shared import might reach."""

    def find_spec(self, fullname, path=None, target=None):  # noqa: ANN001, ANN201
        if any(fullname == prefix or fullname.startswith(prefix + ".") for prefix in FORBIDDEN):
            raise ImportError(f"shared product HTTP imported local module {fullname}")
        return None


# Block local modules before the shared package (and anything it imports) loads.
sys.meta_path.insert(0, LocalImportBlocker())

from fastapi import FastAPI, Request, WebSocket  # noqa: E402
from fastapi.routing import APIRoute  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from animama.adapters.repositories.sqlalchemy.product_repositories import (  # noqa: E402
    SQLAlchemyProductRepositories,
)
from animama.app.services.model_provider_catalog_service import ModelCatalogPolicy  # noqa: E402
from animama.domain.request_principal import RequestPrincipal  # noqa: E402
from animama.domain.settings import UserSettings  # noqa: E402
from animama.product_http.inventory import ROUTES, SERVED_STAGES  # noqa: E402
from animama.product_http.ports import (  # noqa: E402
    ProductRefusal,
    ReadSession,
    UserSettingsMutation,
    WriteSession,
    install_product_ports,
)
from animama.product_http.routes import ROUTERS  # noqa: E402

OWNER = RequestPrincipal(id="consumer-owner")


class Owner:
    """A consumer's resolver: every request belongs to OWNER."""

    async def resolve_http(self, request: Request) -> RequestPrincipal:
        return OWNER

    async def resolve_websocket(self, websocket: WebSocket) -> RequestPrincipal:
        return OWNER


class Ports:
    """A consumer's ports with placeholder sessions; it can fail its deferred commit."""

    def __init__(self, *, fail_commit: bool = False) -> None:
        self.opened: list[tuple[str, str]] = []
        self.fail_commit = fail_commit

    @asynccontextmanager
    async def read_session(self, principal: RequestPrincipal) -> AsyncIterator[object]:
        self.opened.append(("read", principal.id))
        yield object()

    @asynccontextmanager
    async def write_session(self, principal: RequestPrincipal) -> AsyncIterator[object]:
        self.opened.append(("write", principal.id))
        yield object()
        if self.fail_commit:
            raise RuntimeError("deferred commit failed")


class SettingsPorts(Ports):
    """An independent composition with separate remote and transactional local state.

    The repositories stage writes on the exact session given to the intent hook.
    Only the composition commits that state. A remote save survives a failed local
    commit; the response reports that fact without issuing compensation.
    """

    model_catalog_policy = ModelCatalogPolicy()

    def __init__(self) -> None:
        super().__init__()
        self.settings = None
        self.remote_locale = None
        self.remote_writes = []
        self.mutations = []
        self.refuse_remote = False
        self.unknown_remote = False

    @asynccontextmanager
    async def read_session(self, principal):
        yield {"settings": deepcopy(self.settings), "owner": principal.id}

    @asynccontextmanager
    async def write_session(self, principal):
        session = {"settings": deepcopy(self.settings), "owner": principal.id, "commit": False, "confirmed": False}
        yield session
        if session["commit"]:
            if self.fail_commit:
                if session["confirmed"]:
                    raise ProductRefusal(409, "locale_saved_settings_failed")
                raise RuntimeError("deferred commit failed")
            self.settings = session["settings"]

    def repositories(self, session):
        async def get(owner):
            assert owner == session["owner"]
            return session["settings"]

        async def upsert(settings):
            assert settings.user_id == session["owner"]
            session["settings"] = settings
            return settings

        async def delete(owner):
            assert owner == session["owner"]
            existed = session["settings"] is not None
            session["settings"] = None
            return existed

        async def commit():
            session["commit"] = True

        return SimpleNamespace(
            user_settings=SimpleNamespace(get=get, upsert=upsert, delete=delete),
            anima_settings=None,
            unit_of_work=SimpleNamespace(commit=commit),
        )

    async def prepare_user_settings_change(self, session, principal, mutation):
        assert isinstance(mutation, UserSettingsMutation)
        assert session["owner"] == principal.id
        # Consumer-specific validation must precede the external effect too.
        if "theme" in mutation.patch and mutation.patch["theme"] not in {"anima", "dusk"}:
            raise ProductRefusal(422, "fixture_invalid_theme")
        self.mutations.append((mutation.operation, dict(mutation.patch)))
        if mutation.operation != "reset" and "locale" not in mutation.patch:
            return
        if self.refuse_remote:
            raise ProductRefusal(503, "locale_authority_unavailable")
        locale = None if mutation.operation == "reset" else mutation.patch["locale"]
        self.remote_locale = locale
        self.remote_writes.append(locale)
        if self.unknown_remote:
            # The remote wrote, but its reply was lost. The consumer cannot claim
            # success or undo the remote write from an ambiguous history.
            raise ProductRefusal(503, "locale_save_outcome_unknown")
        session["confirmed"] = True

    def user_settings_changed(self, principal):
        assert principal == OWNER


def settings_contract() -> int:
    """Exercise real installed handlers, exported intent and deferred error mapping."""
    ports = SettingsPorts()
    route = "/v1/users/me/settings"
    with TestClient(consumer_app(ports=ports, resolver=Owner()), raise_server_exceptions=False) as client:
        for body in ({"locale": "en-US"}, {"locale": "ja", "user_id": "another-owner"}):
            assert client.patch(route, json=body).status_code == 422
        assert ports.mutations == ports.remote_writes == []
        assert client.post(route, json={"locale": "ja"}).status_code == 201
        assert client.post(route, json={"locale": "ko"}).status_code == 409
        assert ports.remote_writes == ["ja"]
        assert client.patch(route, json={"theme": "dusk"}).status_code == 200
        assert ports.remote_writes == ["ja"], "materialized locale must not imply write intent"
        assert client.patch(route, json={"locale": None}).status_code == 200
        assert client.delete(route).status_code == 204
        assert ports.mutations == [
            ("create", {"locale": "ja"}),
            ("patch", {"theme": "dusk"}),
            ("patch", {"locale": None}),
            ("reset", {}),
        ]
        assert ports.remote_writes == ["ja", None, None]
        assert ports.settings is None

        # A composition's own rejection of a mixed request has no remote effect.
        assert client.patch(route, json={"locale": "ko", "theme": "invalid"}).status_code == 422
        assert ports.remote_writes == ["ja", None, None]

        ports.settings = UserSettings(user_id=OWNER.id, locale="ja")
        ports.remote_locale = "ja"
        ports.refuse_remote = True
        refused = client.patch(route, json={"locale": "ko", "theme": "dusk"})
        assert (refused.status_code, refused.json()) == (
            503,
            {"detail": {"code": "locale_authority_unavailable"}},
        )
        assert ports.settings.locale == ports.remote_locale == "ja"
        assert ports.settings.theme == "anima"

        ports.refuse_remote = False
        ports.unknown_remote = True
        unknown = client.patch(route, json={"locale": "ko", "theme": "dusk"})
        assert (unknown.status_code, unknown.json()) == (503, {"detail": {"code": "locale_save_outcome_unknown"}})
        assert ports.settings.locale == "ja" and ports.settings.theme == "anima"
        assert ports.remote_locale == "ko"

        ports.unknown_remote = False
        ports.fail_commit = True
        partial = client.patch(route, json={"locale": "zh-Hant", "theme": "dusk"})
        assert (partial.status_code, partial.json()) == (409, {"detail": {"code": "locale_saved_settings_failed"}})
        assert ports.settings.locale == "ja" and ports.settings.theme == "anima"
        assert ports.remote_locale == "zh-Hant"
        assert ports.remote_writes == ["ja", None, None, "ko", "zh-Hant"], "no implicit retry or compensation"
        assert client.get(route).status_code == 200
        assert ports.remote_writes == ["ja", None, None, "ko", "zh-Hant"], "readback never writes"
    return len(ports.mutations)


def consumer_app(*, ports: Ports | None, resolver: Owner | None) -> FastAPI:
    """Mount every shared router, plus session probes, the way a consumer would."""

    app = FastAPI()
    for router in ROUTERS:
        app.include_router(router)
    if resolver is not None:
        app.state.request_principal_resolver = resolver
    if ports is not None:
        install_product_ports(app, ports)  # type: ignore[arg-type]

    @app.get("/probe/read")
    async def read(session: ReadSession) -> dict[str, bool]:
        return {"ok": True}

    @app.post("/probe/write")
    async def write(session: WriteSession) -> dict[str, bool]:
        return {"ok": True}

    return app


def probe(app: FastAPI) -> list[tuple[int, object]]:
    with TestClient(app, raise_server_exceptions=False) as client:
        responses = [client.get("/probe/read"), client.post("/probe/write")]
    return [(response.status_code, response.json() if response.status_code != 500 else None) for response in responses]


def main() -> None:
    # The routers mount exactly the shared inventory routes of the stages the package serves.
    shared = {
        (spec.method, spec.path, spec.handler)
        for spec in ROUTES
        if spec.disposition == "shared" and spec.stage in SERVED_STAGES
    }
    # Enumerate the routers' own routes: newer FastAPI releases keep each included
    # router as one nested entry in the app's route list.
    mounted = {
        (method, route.path, route.endpoint.__name__)
        for router in ROUTERS
        for route in router.routes
        if isinstance(route, APIRoute)
        for method in route.methods
    }
    assert mounted == shared, sorted(mounted ^ shared)

    missing_ports = {"detail": {"code": "product_ports_unavailable"}}
    assert probe(consumer_app(ports=None, resolver=Owner())) == [(503, missing_ports)] * 2

    # No session opens for a request whose owner is unknown.
    ports = Ports()
    missing_principal = {"detail": {"code": "request_principal_unavailable"}}
    assert probe(consumer_app(ports=ports, resolver=None)) == [(503, missing_principal)] * 2
    assert ports.opened == []

    assert probe(consumer_app(ports=ports, resolver=Owner())) == [(200, {"ok": True})] * 2
    assert ports.opened == [("read", OWNER.id), ("write", OWNER.id)]

    # A failed deferred commit replaces the handler's success.
    assert [status for status, _ in probe(consumer_app(ports=Ports(fail_commit=True), resolver=Owner()))] == [200, 500]

    # The shared repository bundle a consumer may reuse builds every repository without local code.
    bundle = SQLAlchemyProductRepositories(object())  # type: ignore[arg-type]
    for name in dir(type(bundle)):
        if not name.startswith("_"):
            getattr(bundle, name)

    settings_mutations = settings_contract()
    leaked = sorted(name for name in sys.modules if any(name == p or name.startswith(p + ".") for p in FORBIDDEN))
    assert not leaked, leaked
    print(
        json.dumps(
            {
                "inventory_routes": len(ROUTES),
                "mounted_shared_routes": len(mounted),
                "settings_mutations": settings_mutations,
                "local_imports": 0,
            }
        )
    )


if __name__ == "__main__":
    main()

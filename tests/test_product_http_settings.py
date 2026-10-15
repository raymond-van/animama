"""Shared settings routes isolate owners and commit through the composition (ADR 0021)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import FrozenInstanceError
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from animama.adapters.repositories.sqlalchemy.settings_repo import SQLAlchemyUserSettingsRepository
from animama.app.services.model_provider_catalog_service import ModelCatalogPolicy
from animama.domain.request_principal import RequestPrincipal
from animama.domain.settings import UserSettings
from animama.orm import ORMAnima
from animama.product_http.ports import ProductRefusal, UserSettingsMutation
from animama.product_http.routes import settings
from tests.product_http_support import DeferredCommitPorts, TwoOwnerComposition, product_app

USER_SETTINGS = "/v1/users/me/settings"


class SettingsIntentPorts(DeferredCommitPorts):
    """A consumer observes explicit intent on the same session as its repositories."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        super().__init__(session_factory)
        self.mutations: list[tuple[str, UserSettingsMutation]] = []
        self.before_local_write: list[str | None] = []

    async def prepare_user_settings_change(
        self, session: AsyncSession, principal: RequestPrincipal, mutation: UserSettingsMutation
    ) -> None:
        current = await self.repositories(session).user_settings.get(principal.id)
        self.before_local_write.append(current.locale if current else None)
        self.mutations.append((principal.id, mutation))


async def test_composition_receives_exact_create_patch_and_reset_intent_before_the_local_write(
    async_session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    ports = SettingsIntentPorts(async_session_factory)
    owner = f"owner-{uuid4().hex}"
    composition = TwoOwnerComposition(product_app(settings.router, ports=ports), tmp_path, owners=(owner, "unused"))

    async with composition.client(owner) as client:
        assert (await client.post(USER_SETTINGS, json={"locale": "ja"})).status_code == 201
        assert (await client.patch(USER_SETTINGS, json={"theme": "anima"})).status_code == 200
        assert (await client.patch(USER_SETTINGS, json={"locale": None})).status_code == 200
        assert (await client.delete(USER_SETTINGS)).status_code == 204

    assert [(user, mutation.operation, dict(mutation.patch)) for user, mutation in ports.mutations] == [
        (owner, "create", {"locale": "ja"}),
        (owner, "patch", {"theme": "anima"}),
        (owner, "patch", {"locale": None}),
        (owner, "reset", {}),
    ]
    assert ports.before_local_write == [None, "ja", "ja", None]
    assert ports.commits == ports.commits_requested == 4
    assert ports.settings_changes == [owner] * 4
    assert ports.owners == [owner] * 4


def test_mutation_preserves_omission_and_defensively_freezes_nested_input() -> None:
    preferences = {"custom": {"labels": ["one"]}}
    supplied: dict[str, Any] = {"locale": None, "preferences": preferences}
    mutation = UserSettingsMutation("patch", supplied)
    supplied["locale"] = "ja"
    preferences["custom"]["labels"].append("two")

    assert mutation.patch["locale"] is None
    assert "theme" not in mutation.patch
    assert mutation.patch["preferences"]["custom"]["labels"] == ("one",)
    with pytest.raises(TypeError):
        mutation.patch["preferences"]["custom"]["labels"][0] = "changed"
    with pytest.raises(TypeError):
        mutation.patch["preferences"]["custom"]["labels"] = ()
    with pytest.raises(TypeError):
        mutation.patch["locale"] = "ko"  # type: ignore[index]
    with pytest.raises(FrozenInstanceError):
        mutation.operation = "reset"  # type: ignore[misc]
    with pytest.raises(ValidationError):
        UserSettingsMutation("patch", {"locale": "en-US"})
    with pytest.raises(ValidationError):
        UserSettingsMutation("patch", {"owner_id": "someone-else"})
    with pytest.raises(ValueError, match="no patch"):
        UserSettingsMutation("reset", {"locale": None})


async def test_rejected_requests_never_prepare_a_settings_effect(
    async_session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    ports = SettingsIntentPorts(async_session_factory)
    ports.model_catalog_policy = ModelCatalogPolicy(validate_role_preferences=True)
    owner = f"owner-{uuid4().hex}"
    app = product_app(settings.router, ports=ports)
    composition = TwoOwnerComposition(app, tmp_path, owners=(owner, "unused"))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as anonymous:
        assert (await anonymous.patch(USER_SETTINGS, json={"locale": "ko"})).status_code == 401
    async with composition.client(owner) as client:
        invalid_bodies: tuple[dict[str, Any], ...] = (
            {"locale": "zh"},
            {"locale": "ja", "user_id": "foreign"},
            {"preferences": []},
        )
        for body in invalid_bodies:
            assert (await client.patch(USER_SETTINGS, json=body)).status_code == 422
        bad_model = {"locale": "ja", "preferences": {"chat": {"default_model_provider_id": "missing:row"}}}
        assert (await client.post(USER_SETTINGS, json=bad_model)).status_code == 422
        assert (await client.patch(USER_SETTINGS, json=bad_model)).status_code == 422
        assert ports.mutations == []
        assert (await client.post(USER_SETTINGS, json={"locale": "en"})).status_code == 201
        assert (await client.post(USER_SETTINGS, json={"locale": "ko"})).status_code == 409
        assert (await client.get(USER_SETTINGS)).json()["locale"] == "en"
    assert len(ports.mutations) == 1
    assert ports.commits == 1


@pytest.mark.parametrize("body", [None, {}, {"locale": None}])
async def test_create_without_locale_and_reset_without_a_row_keep_their_explicit_intent(
    async_session_factory: async_sessionmaker[AsyncSession], tmp_path: Path, body: dict[str, Any] | None
) -> None:
    ports = SettingsIntentPorts(async_session_factory)
    owner = f"owner-{uuid4().hex}"
    composition = TwoOwnerComposition(product_app(settings.router, ports=ports), tmp_path, owners=(owner, "unused"))
    async with composition.client(owner) as client:
        assert (await client.delete(USER_SETTINGS)).status_code == 204
        assert (await client.post(USER_SETTINGS, json=body)).status_code == 201
    assert [(mutation.operation, dict(mutation.patch)) for _, mutation in ports.mutations] == [
        ("reset", {}),
        ("create", body or {}),
    ]


class ExternalSettingsPorts(SettingsIntentPorts):
    """A fake remote authority with request-scoped outcomes and deferred notifications."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        super().__init__(session_factory)
        self.remote: dict[str, str | None] = {}
        self.remote_writes: list[tuple[str, str | None]] = []
        self.refusal: ProductRefusal | None = None
        self.unknown_outcome = False
        self.active_session: ContextVar[AsyncSession] = ContextVar("settings_session")

    @asynccontextmanager
    async def write_session(self, principal: RequestPrincipal) -> AsyncIterator[AsyncSession]:
        session: AsyncSession | None = None
        try:
            async with super().write_session(principal) as session:
                token = self.active_session.set(session)
                try:
                    yield session
                finally:
                    self.active_session.reset(token)
        except ProductRefusal:
            raise
        except Exception as exc:
            if session is not None and session.info.get("locale_confirmed"):
                raise ProductRefusal(409, "locale_saved_settings_failed") from exc
            raise
        else:
            assert session is not None
            self.settings_changes.extend(session.info.get("settings_notifications", []))

    def user_settings_changed(self, principal: RequestPrincipal) -> None:
        self.active_session.get().info.setdefault("settings_notifications", []).append(principal.id)

    async def prepare_user_settings_change(
        self, session: AsyncSession, principal: RequestPrincipal, mutation: UserSettingsMutation
    ) -> None:
        assert session is self.active_session.get()
        await super().prepare_user_settings_change(session, principal, mutation)
        # A consumer's own deterministic field/ownership rules must precede its
        # external effect, even though shared JSON/model-role validation passed.
        if "theme" in mutation.patch and mutation.patch["theme"] not in {"anima", "dusk"}:
            raise HTTPException(422, detail={"code": "invalid_theme"})
        anima_id = mutation.patch.get("last_active_anima_id")
        if anima_id is not None and not await self.repositories(session).animas.is_owned_by_user(
            user_id=principal.id, anima_id=anima_id
        ):
            raise HTTPException(404, detail="Anima not found")
        if self.refusal is not None:
            raise self.refusal
        if mutation.operation == "reset" or "locale" in mutation.patch:
            locale = None if mutation.operation == "reset" else mutation.patch["locale"]
            self.remote[principal.id] = locale
            self.remote_writes.append((principal.id, locale))
            if self.unknown_outcome:
                raise ProductRefusal(503, "locale_save_outcome_unknown")
            session.info["locale_confirmed"] = True


@pytest.mark.parametrize(("status", "code"), [(409, "locale_conflict"), (503, "locale_authority_unavailable")])
async def test_a_known_external_refusal_has_no_local_write_or_notification(
    async_session_factory: async_sessionmaker[AsyncSession], tmp_path: Path, status: int, code: str
) -> None:
    ports = ExternalSettingsPorts(async_session_factory)
    ports.refusal = ProductRefusal(status, code)
    owner = f"owner-{uuid4().hex}"
    composition = TwoOwnerComposition(product_app(settings.router, ports=ports), tmp_path, owners=(owner, "unused"))
    async with composition.client(owner) as client:
        response = await client.patch(USER_SETTINGS, json={"locale": "ja", "theme": "dusk"})
        assert (response.status_code, response.json()) == (status, {"detail": {"code": code}})
        assert (await client.get(USER_SETTINGS)).json()["theme"] == "anima"
    assert ports.remote_writes == []
    assert ports.commits_requested == 0
    assert ports.settings_changes == []


async def test_a_consumer_rejects_invalid_mixed_fields_before_its_remote_effect(
    async_session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    ports = ExternalSettingsPorts(async_session_factory)
    owner = f"owner-{uuid4().hex}"
    other_anima = f"anima-{uuid4().hex}"
    async with async_session_factory() as session:
        session.add(ORMAnima(id=other_anima, user_id="another-owner"))
        await session.commit()
    composition = TwoOwnerComposition(product_app(settings.router, ports=ports), tmp_path, owners=(owner, "unused"))
    async with composition.client(owner) as client:
        invalid = await client.patch(USER_SETTINGS, json={"locale": "ko", "theme": "unknown"})
        foreign = await client.patch(USER_SETTINGS, json={"locale": "ko", "last_active_anima_id": other_anima})
    assert (invalid.status_code, foreign.status_code) == (422, 404)
    assert ports.remote_writes == []
    assert ports.commits_requested == 0


@pytest.mark.parametrize("failure", ["write", "deferred_commit"])
async def test_confirmed_external_save_survives_local_failure_with_a_partial_http_result(
    async_session_factory: async_sessionmaker[AsyncSession],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    ports = ExternalSettingsPorts(async_session_factory)
    owner = f"owner-{uuid4().hex}"
    composition = TwoOwnerComposition(product_app(settings.router, ports=ports), tmp_path, owners=(owner, "unused"))
    if failure == "write":

        async def unavailable(self: SQLAlchemyUserSettingsRepository, value: UserSettings) -> UserSettings:
            raise RuntimeError("local persistence unavailable")

        monkeypatch.setattr(SQLAlchemyUserSettingsRepository, "upsert", unavailable)
    else:
        ports.fail_next_commit = True
    async with composition.client(owner) as client:
        response = await client.patch(USER_SETTINGS, json={"locale": "ja", "theme": "dusk"})
        assert (response.status_code, response.json()) == (409, {"detail": {"code": "locale_saved_settings_failed"}})
        assert (await client.get(USER_SETTINGS)).json()["theme"] == "anima"
    assert ports.remote == {owner: "ja"}
    assert ports.remote_writes == [(owner, "ja")]
    assert ports.commits == 0
    assert ports.settings_changes == []


async def test_an_unknown_remote_outcome_does_not_write_locally_or_compensate_or_retry(
    async_session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    ports = ExternalSettingsPorts(async_session_factory)
    ports.unknown_outcome = True
    owner = f"owner-{uuid4().hex}"
    composition = TwoOwnerComposition(product_app(settings.router, ports=ports), tmp_path, owners=(owner, "unused"))
    async with composition.client(owner) as client:
        response = await client.patch(USER_SETTINGS, json={"locale": "ko", "theme": "dusk"})
        assert (response.status_code, response.json()) == (503, {"detail": {"code": "locale_save_outcome_unknown"}})
        assert (await client.get(USER_SETTINGS)).json()["theme"] == "anima"
    assert ports.remote == {owner: "ko"}
    assert ports.remote_writes == [(owner, "ko")]
    assert ports.commits_requested == 0
    assert ports.settings_changes == []


async def test_owners_keep_separate_settings_and_cannot_reach_each_others_animas(
    async_session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    ports = DeferredCommitPorts(async_session_factory)
    owner_a, owner_b = f"owner-a-{uuid4().hex[:8]}", f"owner-b-{uuid4().hex[:8]}"
    composition = TwoOwnerComposition(product_app(settings.router, ports=ports), tmp_path, owners=(owner_a, owner_b))
    anima_id = f"anima-{uuid4().hex}"
    async with async_session_factory() as session:
        session.add(ORMAnima(id=anima_id, user_id=owner_a))
        await session.commit()

    async with composition.client(owner_a) as a:
        assert (await a.post(USER_SETTINGS, json={"locale": "ja"})).status_code == 201
        assert (await a.patch(f"/v1/animas/{anima_id}/settings", json={"favorited": True})).status_code == 200
    commits = ports.commits

    async with composition.client(owner_b) as b:
        # Owner b sees only its own (default) user settings and creates its own row.
        assert (await b.get(USER_SETTINGS)).json()["locale"] is None
        assert (await b.post(USER_SETTINGS, json={"theme": "dusk"})).status_code == 201
        assert (await b.patch(USER_SETTINGS, json={"locale": "ko"})).status_code == 200
        assert (await b.delete(USER_SETTINGS)).status_code == 204
        for request in (b.get, b.delete):
            assert (await request(f"/v1/animas/{anima_id}/settings")).status_code == 404
        assert (await b.patch(f"/v1/animas/{anima_id}/settings", json={"favorited": False})).status_code == 404

    async with composition.client(owner_a) as a:
        assert (await a.get(USER_SETTINGS)).json()["locale"] == "ja"
        assert (await a.get(f"/v1/animas/{anima_id}/settings")).json()["favorited"] is True
        assert (await a.delete(f"/v1/animas/{anima_id}/settings")).status_code == 204
        assert (await a.get(f"/v1/animas/{anima_id}/settings")).json()["favorited"] is False

    # Owner b's three writes and owner a's delete committed through the composition;
    # owner b's refused Anima writes committed nothing.
    assert ports.commits == commits + 4
    assert ports.commits == ports.commits_requested
    # Each user-settings write told the composition whose settings changed.
    assert ports.settings_changes == [owner_a, owner_b, owner_b, owner_b]

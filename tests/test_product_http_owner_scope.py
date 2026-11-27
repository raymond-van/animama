"""Shared routes see only the caller's records; a NULL owner is nobody's (ADR 0021)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from animama.adapters.repositories.sqlalchemy.product_repositories import SQLAlchemyProductRepositories
from animama.app.contracts.anima import PyAnimaChatProfileUpdateRequest, PyAnimaUpdateRequest, PyEmotionalState
from animama.app.contracts.settings import PyAnimaSettingsUpdate
from animama.domain.request_principal import RequestPrincipal
from animama.orm import ORMAnima
from animama.product_http.chat.active_turns import ActiveChatTurns
from animama.product_http.routes import animas as anima, settings
from tests.product_http_support import local_ports

CALLER = RequestPrincipal(id="caller-owner")


def anima_scoped_calls(anima_id: str, session: AsyncSession) -> dict[str, Callable[[], Awaitable[Any]]]:
    """The Anima and Anima-settings handlers, invoked by a caller who does not own the Anima.

    Each moved family's two-owner test covers its other Anima-scoped routes over HTTP.
    """

    return {
        "get_anima": lambda: anima.get_anima(
            anima_id=anima_id, repositories=SQLAlchemyProductRepositories(session), user=CALLER
        ),
        "patch_anima": lambda: anima.patch_anima(
            anima_id=anima_id,
            req=PyAnimaUpdateRequest(),
            repositories=SQLAlchemyProductRepositories(session),
            user=CALLER,
        ),
        "update_anima_chat_profile": lambda: anima.update_anima_chat_profile(
            anima_id=anima_id,
            req=PyAnimaChatProfileUpdateRequest(default_model_provider_id="model"),
            repositories=SQLAlchemyProductRepositories(session),
            user=CALLER,
        ),
        "update_anima_emotional_state": lambda: anima.update_anima_emotional_state(
            anima_id=anima_id,
            emotional_state=PyEmotionalState(),
            repositories=SQLAlchemyProductRepositories(session),
            user=CALLER,
        ),
        "delete_anima": lambda: anima.delete_anima(
            anima_id=anima_id,
            repositories=SQLAlchemyProductRepositories(session),
            user=CALLER,
            ports=local_ports(),
            turns=ActiveChatTurns(),
        ),
        "get_anima_settings": lambda: settings.get_anima_settings(
            anima_id=anima_id, repositories=SQLAlchemyProductRepositories(session), user=CALLER
        ),
        "patch_anima_settings": lambda: settings.patch_anima_settings(
            anima_id=anima_id,
            req=PyAnimaSettingsUpdate(favorited=True),
            repositories=SQLAlchemyProductRepositories(session),
            user=CALLER,
        ),
        "delete_anima_settings": lambda: settings.delete_anima_settings(
            anima_id=anima_id, repositories=SQLAlchemyProductRepositories(session), user=CALLER
        ),
    }


@pytest.mark.parametrize("owner", ["another-owner", None])
async def test_shared_anima_routes_hide_animas_the_caller_does_not_own(
    async_session: AsyncSession, owner: str | None
) -> None:
    anima_id = f"anima-{uuid4().hex}"
    async_session.add(ORMAnima(id=anima_id, user_id=owner))
    await async_session.commit()

    for name, call in anima_scoped_calls(anima_id, async_session).items():
        with pytest.raises(HTTPException) as refused:
            await call()
        assert refused.value.status_code == 404, name

    # The refusals changed nothing.
    async_session.expire_all()
    row = await async_session.get(ORMAnima, anima_id)
    assert row is not None
    assert row.user_id == owner

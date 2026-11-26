"""The ChatGPT plan connection's models: listed from the account, kept as read-only rows (D4, D8, D9)."""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import delete, select

from animama.adapters.chatgpt_plan.openai_identity import OpenAIChatGPTPlanIdentity
from animama.adapters.chatgpt_plan.openai_models import OpenAIChatGPTPlanModels
from animama.adapters.chatgpt_plan.session_store import FileChatGPTPlanSessionStore
from animama.adapters.repositories.sqlalchemy.model_provider_repo import SQLAlchemyModelProviderRepository
from animama.adapters.repositories.sqlalchemy.uow import SQLAlchemyUnitOfWork
from animama.app.ports.chatgpt_plan_port import ChatGPTPlanModelListError, PlanModelListing
from animama.app.services.chatgpt_plan_models import ChatGPTPlanModelCatalog, plan_model_row
from animama.app.services.chatgpt_plan_session import ChatGPTPlanSessionService
from animama.app.services.model_provider_catalog_service import ModelCatalogPolicy, ModelProviderCatalogService
from animama.domain.chatgpt_plan import ChatGPTPlanUnavailableError
from animama.domain.model_connection import BUILTIN_CHATGPT_PLAN_CONNECTION_ID
from tests.chatgpt_plan_fakes import FakeOpenAIAuth

REDIRECT = "http://127.0.0.1:8123/auth/callback"


def _item(slug: str, **fields: Any) -> dict[str, Any]:
    return {
        "slug": slug,
        "display_name": slug.upper(),
        "visibility": "list",
        "context_window": 272_000,
        "input_modalities": ["text", "image"],
        "supported_reasoning_levels": [{"effort": "low"}, {"effort": "high"}, {"effort": "ultra"}],
        "supports_search_tool": True,
        "base_instructions": "x" * 20_000,
        **fields,
    }


def _listing(slug: str, **fields: Any) -> PlanModelListing:
    values: dict[str, Any] = {
        "slug": slug,
        "display_name": slug.upper(),
        "listed": True,
        "context_window": 272_000,
        "input_modalities": ("text", "image"),
        "reasoning_efforts": ("low", "high"),
        "supports_search": True,
    }
    values.update(fields)
    return PlanModelListing(**values)


async def test_the_listing_keeps_only_the_fields_animama_uses() -> None:
    seen: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={"models": [_item("gpt-6-luna"), _item("hidden", visibility="hide"), {"slug": ""}, "junk"]},
        )

    models = OpenAIChatGPTPlanModels(transport=httpx.MockTransport(respond))
    try:
        listings = await models.list_models("access-token")
    finally:
        await models.aclose()

    assert [(listing.slug, listing.listed) for listing in listings] == [("gpt-6-luna", True), ("hidden", False)]
    assert listings[0].reasoning_efforts == ("low", "high", "ultra")
    assert listings[0].input_modalities == ("text", "image") and listings[0].supports_search is True
    assert [str(request.url) for request in seen] == ["https://api.openai.com/v1/models"]
    assert seen[0].headers["authorization"] == "Bearer access-token"


@pytest.mark.parametrize(
    ("answer", "code", "rejected"),
    [
        (httpx.Response(401), "token_rejected", True),
        (httpx.Response(503), "status_503", False),
        (httpx.Response(302, headers={"location": "https://elsewhere.example.test/"}), "status_302", False),
        (httpx.Response(200, text="not json"), "listing_invalid", False),
    ],
)
async def test_a_listing_that_fails_says_whether_the_token_was_refused(
    answer: httpx.Response, code: str, rejected: bool
) -> None:
    models = OpenAIChatGPTPlanModels(transport=httpx.MockTransport(lambda request: answer))
    try:
        with pytest.raises(ChatGPTPlanModelListError) as failed:
            await models.list_models("access-token")
    finally:
        await models.aclose()

    assert (failed.value.code, failed.value.rejected_token) == (code, rejected)


def test_a_row_takes_the_listing_and_the_app_s_known_efforts() -> None:
    row = plan_model_row(_listing("gpt-6-luna", reasoning_efforts=("low", "high", "ultra")))

    assert row.id == "ChatGPTPlanResponsesHTTPAgent:gpt-6-luna"
    assert (row.connection_id, row.source, row.provider_type) == (
        BUILTIN_CHATGPT_PLAN_CONNECTION_ID,
        "builtin",
        "ChatGPTPlanResponsesHTTPAgent",
    )
    assert row.context_window_tokens == 272_000
    assert row.capabilities.supported_reasoning_efforts == ["low", "high"]
    assert row.capabilities.accepts == ["text", "image"]
    assert row.capabilities.native_tool_support == ["web_search"]
    assert row.capabilities.supports_tools is True


def test_a_row_without_a_listed_window_falls_back_to_the_catalog_then_a_default() -> None:
    assert plan_model_row(_listing("gpt-6-luna", context_window=None)).context_window_tokens == 1_050_000
    assert plan_model_row(_listing("unknown-model", context_window=None)).context_window_tokens == 128_000
    assert plan_model_row(_listing("quiet", supports_search=False)).capabilities.native_tool_support == []


class _Listing:
    """The account's model list, steered by the test."""

    def __init__(self) -> None:
        self.models: list[PlanModelListing] = [_listing("gpt-6-luna"), _listing("gpt-5.6-terra")]
        self.refuse_next = False
        self.tokens: list[str] = []

    async def list_models(self, access_token: str) -> list[PlanModelListing]:
        self.tokens.append(access_token)
        if self.refuse_next:
            self.refuse_next = False
            raise ChatGPTPlanModelListError("token_rejected", rejected_token=True)
        return list(self.models)


@pytest_asyncio.fixture
async def signed_in(tmp_path: Path) -> AsyncIterator[ChatGPTPlanSessionService]:
    fake = FakeOpenAIAuth()
    identity = OpenAIChatGPTPlanIdentity(transport=fake.transport())
    service = ChatGPTPlanSessionService(
        identity=identity, store=FileChatGPTPlanSessionStore(tmp_path / "plan", key=None), clock=time.time
    )
    await service.complete(fake.authorize(await service.begin(redirect_uri=REDIRECT)))
    yield service
    await identity.aclose()


@pytest_asyncio.fixture
async def plan_rows_cleanup(async_session: Any) -> AsyncIterator[None]:
    """Plan rows are derived data; leave none behind for other tests that share this database."""

    yield
    from animama.orm import ORMModelProvider

    await async_session.rollback()
    await async_session.execute(
        delete(ORMModelProvider).where(ORMModelProvider.connection_id == BUILTIN_CHATGPT_PLAN_CONNECTION_ID)
    )
    await async_session.commit()


def _catalog(session: Any, plan: ChatGPTPlanSessionService, listing: _Listing) -> ChatGPTPlanModelCatalog:
    return ChatGPTPlanModelCatalog(
        session=plan,
        models=listing,
        model_providers=SQLAlchemyModelProviderRepository(session),
        uow=SQLAlchemyUnitOfWork(session),
    )


async def _plan_rows(session: Any) -> dict[str, bool]:
    from animama.orm import ORMModelProvider

    rows = await session.execute(
        select(ORMModelProvider).where(ORMModelProvider.connection_id == BUILTIN_CHATGPT_PLAN_CONNECTION_ID)
    )
    return {row.id: row.active for row in rows.scalars()}


@pytest.mark.usefixtures("plan_rows_cleanup")
async def test_a_refresh_stores_listed_models_and_retires_the_rest(
    async_session: Any, signed_in: ChatGPTPlanSessionService
) -> None:
    listing = _Listing()
    catalog = _catalog(async_session, signed_in, listing)

    active = await catalog.refresh()
    assert sorted(row.model for row in active) == ["gpt-5.6-terra", "gpt-6-luna"]

    # The person hides one; a later refresh keeps that choice and retires a model no longer listed.
    await SQLAlchemyModelProviderRepository(async_session).set_hidden(
        "ChatGPTPlanResponsesHTTPAgent:gpt-6-luna", hidden=True
    )
    await async_session.commit()
    listing.models = [_listing("gpt-6-luna"), _listing("codex-auto-review", listed=False)]
    active = await catalog.refresh()

    assert [row.model for row in active] == ["gpt-6-luna"] and active[0].hidden is True
    async_session.expire_all()
    assert await _plan_rows(async_session) == {
        "ChatGPTPlanResponsesHTTPAgent:gpt-6-luna": True,
        "ChatGPTPlanResponsesHTTPAgent:gpt-5.6-terra": False,
    }

    assert await catalog.withdraw() == 1
    async_session.expire_all()
    assert set((await _plan_rows(async_session)).values()) == {False}

    # No token reaches the catalog: the rows and the connection hold none (acceptance line 2).
    from animama.orm import ORMModelConnection, ORMModelProvider

    record = signed_in._store.load()  # noqa: SLF001
    assert record is not None and record.account is not None and record.account.tokens is not None
    tokens = record.account.tokens
    for table in (ORMModelProvider, ORMModelConnection):
        dumped = repr([vars(row) for row in (await async_session.execute(select(table))).scalars().all()])
        for secret in (tokens.access_token, tokens.refresh_token, tokens.id_token):
            assert secret not in dumped, table.__name__


@pytest.mark.usefixtures("plan_rows_cleanup")
async def test_a_refused_token_is_renewed_once_before_listing_again(
    async_session: Any, signed_in: ChatGPTPlanSessionService
) -> None:
    listing = _Listing()
    listing.refuse_next = True

    await _catalog(async_session, signed_in, listing).refresh()

    assert len(listing.tokens) == 2 and listing.tokens[0] != listing.tokens[1]


class _GatedListing(_Listing):
    """A listing that waits for the test before OpenAI's answer arrives."""

    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()
        self.answer = asyncio.Event()

    async def list_models(self, access_token: str) -> list[PlanModelListing]:
        self.started.set()
        await self.answer.wait()
        return await super().list_models(access_token)


@pytest.mark.usefixtures("plan_rows_cleanup")
async def test_a_sign_out_during_a_refresh_leaves_no_plan_model_active(
    async_session: Any, async_session_factory: Any, signed_in: ChatGPTPlanSessionService
) -> None:
    """Refresh and withdrawal are serialized, so the withdrawal applies after the refresh stores its rows (D4)."""

    lock = asyncio.Lock()
    listing = _GatedListing()
    async with async_session_factory() as refreshing, async_session_factory() as signing_out:
        refresh = asyncio.create_task(
            ChatGPTPlanModelCatalog(
                session=signed_in,
                models=listing,
                model_providers=SQLAlchemyModelProviderRepository(refreshing),
                uow=SQLAlchemyUnitOfWork(refreshing),
                lock=lock,
            ).refresh()
        )
        await listing.started.wait()
        withdraw = asyncio.create_task(
            ChatGPTPlanModelCatalog(
                session=signed_in,
                models=_Listing(),
                model_providers=SQLAlchemyModelProviderRepository(signing_out),
                uow=SQLAlchemyUnitOfWork(signing_out),
                lock=lock,
            ).withdraw()
        )
        await asyncio.sleep(0.05)
        listing.answer.set()
        await refresh
        assert await withdraw == 2

    async_session.expire_all()
    assert set((await _plan_rows(async_session)).values()) == {False}


@pytest.mark.usefixtures("plan_rows_cleanup")
async def test_the_chat_picker_lists_plan_models_under_the_plan_with_search_per_row(
    async_session: Any, signed_in: ChatGPTPlanSessionService
) -> None:
    """Phase 6: grouped under "ChatGPT plan", hosted search only where the account's listing has it (R3.5)."""

    listing = _Listing()
    listing.models = [_listing("gpt-6-luna"), _listing("gpt-5.6-terra", supports_search=False)]
    await _catalog(async_session, signed_in, listing).refresh()
    service = ModelProviderCatalogService(model_providers=SQLAlchemyModelProviderRepository(async_session))

    local = {
        item["model"]: item
        for item in await service.list_public_catalog(ModelCatalogPolicy.local())
        if item["model_provider"] == "ChatGPTPlanResponsesHTTPAgent"
    }
    hosted = await service.list_public_catalog(ModelCatalogPolicy())

    assert {item["connection_name"] for item in local.values()} == {"ChatGPT plan"}
    assert local["gpt-6-luna"]["requestable_native_tool_support"] == ["web_search"]
    assert local["gpt-5.6-terra"]["requestable_native_tool_support"] == []
    # The hosted composition's catalog never lists them.
    assert not [item for item in hosted if item["model_provider"] == "ChatGPTPlanResponsesHTTPAgent"]


@pytest.mark.usefixtures("plan_rows_cleanup")
async def test_no_listing_without_a_usable_plan(async_session: Any, tmp_path: Path) -> None:
    fake = FakeOpenAIAuth()
    identity = OpenAIChatGPTPlanIdentity(transport=fake.transport())
    signed_out = ChatGPTPlanSessionService(
        identity=identity, store=FileChatGPTPlanSessionStore(tmp_path / "plan", key=None)
    )
    listing = _Listing()
    try:
        with pytest.raises(ChatGPTPlanUnavailableError) as refused:
            await _catalog(async_session, signed_out, listing).refresh()
    finally:
        await identity.aclose()

    assert refused.value.code == "not_signed_in" and listing.tokens == []


async def test_the_evaluation_tools_leave_plan_models_out() -> None:
    """They run outside the app, without its session (spec #919: the plan serves Animama's own features)."""

    from scripts.evals.core.catalog import chat_model_rows

    class _Active:
        async def list_active(self) -> list[Any]:
            return [plan_model_row(_listing("gpt-6-luna"))]

    assert await chat_model_rows(_Active()) == []  # type: ignore[arg-type]

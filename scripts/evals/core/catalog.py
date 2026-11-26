"""The application's model catalog, read-only, and chat's shared model client registry.

Database and server imports stay inside the functions: the dry runs need no
database, and the test suite patches the engine these functions open.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager

from sqlalchemy.engine import URL

from animama.app.model_clients import StaticModelClientRegistry
from animama.app.ports import ModelProviderRepository
from animama.domain import ModelProvider
from animama.domain.model_connection import BUILTIN_CHATGPT_PLAN_CONNECTION_ID, MODEL_KIND_CHAT

__all__ = [
    "application_database_url",
    "build_model_client_registry",
    "chat_model_rows",
    "llm_skip",
    "read_only_model_providers",
]


@asynccontextmanager
async def read_only_model_providers() -> AsyncIterator[ModelProviderRepository]:
    """Open the application database's model catalog in a read-only transaction."""

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from animama.adapters.repositories.sqlalchemy.model_provider_repo import SQLAlchemyModelProviderRepository
    from animama.local.database import dispose_engine, get_engine

    engine = get_engine()
    try:
        async with async_sessionmaker(engine)() as session:
            await session.execute(text("SET TRANSACTION READ ONLY"))
            yield SQLAlchemyModelProviderRepository(session)
    finally:
        await dispose_engine(engine=engine)


def application_database_url() -> URL:
    """The application database's URL, credentials included; never print or log it."""

    from animama.local.database import get_engine

    return get_engine().url


async def chat_model_rows(model_providers: ModelProviderRepository) -> Sequence[ModelProvider]:
    """Return the catalog's active chat rows, except a signed-in ChatGPT plan's.

    The plan serves Animama's own features through the app (spec #919); these
    tools build their registry without the app's session, so its rows are left out.
    """

    rows = await model_providers.list_active()
    return [
        row
        for row in rows
        if row.model_kind == MODEL_KIND_CHAT and row.connection_id != BUILTIN_CHATGPT_PLAN_CONNECTION_ID
    ]


def build_model_client_registry() -> StaticModelClientRegistry:
    """Build chat's shared model clients; each request reads its connection's key from the credential store."""

    from animama.server.model_clients import build_model_client_registry as build

    return build()


def llm_skip() -> bool:
    """Whether ``ANIMAMA_LLM_SKIP`` is set, so the app's compositions serve their deterministic stand-ins.

    It reads the variable as ``server/model_clients.py`` and ``server/memory_manager.py`` do.
    """

    return os.environ.get("ANIMAMA_LLM_SKIP", "").strip().lower() in {"1", "true", "yes", "y", "on"}

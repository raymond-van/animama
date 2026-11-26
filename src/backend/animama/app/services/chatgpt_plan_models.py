"""The ChatGPT plan connection's models: listed from the signed-in account, kept as read-only rows.

Rows are built-in rows on the ``chatgpt_plan`` connection with ids
``ChatGPTPlanResponsesHTTPAgent:<slug>`` (D4). A refresh adds or updates a row
for every model OpenAI lists for people to pick and retires rows it no longer
lists; signing out retires them all. Catalog seeding never touches them. The
person may only hide or show them. Their context window is the listing's own
figure, else the catalog's for the same model, else 128,000 tokens (D9), and
hosted search is offered only where the listing says the model supports it
(D8).
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterable
from dataclasses import replace

from animama.app.chat.api_standard import CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE
from animama.app.model_catalog import (
    MAIN_STRUCTURED_RESPONSE_KINDS,
    MODEL_CATALOG,
    REASONING_EFFORT_ORDER,
    STRUCTURED_OUTPUT_TRANSPORT_JSON_SCHEMA,
)
from animama.app.ports.chatgpt_plan_port import (
    ChatGPTPlanModelListError,
    ChatGPTPlanModelListPort,
    PlanModelListing,
)
from animama.app.ports.model_provider_port import ModelProviderRepository
from animama.app.ports.uow_port import UnitOfWork
from animama.app.services.chatgpt_plan_session import ChatGPTPlanSessionService
from animama.domain import ModelProvider, ModelProviderCapabilities
from animama.domain.chatgpt_plan import ChatGPTPlanUnavailableError
from animama.domain.model_connection import BUILTIN_CHATGPT_PLAN_CONNECTION_ID, MODEL_SOURCE_BUILTIN

DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000
_ACCEPTED_INPUTS = ("text", "image")


def plan_model_row(listing: PlanModelListing) -> ModelProvider:
    """The catalog row for one listed model."""

    efforts = [effort for effort in REASONING_EFFORT_ORDER if effort in listing.reasoning_efforts]
    accepts = [kind for kind in _ACCEPTED_INPUTS if kind in listing.input_modalities] or ["text"]
    catalog_window = MODEL_CATALOG.get(listing.slug, {}).get("model_metadata", {}).get("context_window_tokens")
    return ModelProvider(
        id=f"{CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE}:{listing.slug}",
        model=listing.slug,
        provider_type=CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE,
        model_label=listing.display_name,
        provider_label="ChatGPT plan",
        logo_provider="openai",
        model_type="reasoning" if efforts else "chat",
        current_snapshot=listing.slug,
        context_window_tokens=listing.context_window or catalog_window or DEFAULT_CONTEXT_WINDOW_TOKENS,
        connection_id=BUILTIN_CHATGPT_PLAN_CONNECTION_ID,
        source=MODEL_SOURCE_BUILTIN,
        capabilities=ModelProviderCapabilities(
            accepts=accepts,
            produces=["text"],
            supports_tools=True,
            supports_streaming=True,
            structured_kinds=sorted(MAIN_STRUCTURED_RESPONSE_KINDS),
            structured_output_transport=STRUCTURED_OUTPUT_TRANSPORT_JSON_SCHEMA,
            supports_reasoning=bool(efforts),
            supported_reasoning_efforts=efforts or None,
            native_tool_support=["web_search"] if listing.supports_search else [],
        ),
    )


class ChatGPTPlanModelCatalog:
    """Keep the plan connection's rows in step with the signed-in account.

    ``lock`` serializes every refresh and withdrawal in the process (the
    composition passes one per app), so a sign-out that withdraws the rows
    while a refresh waits on OpenAI is applied after it, and two refreshes
    never insert the same new rows at once.
    """

    def __init__(
        self,
        *,
        session: ChatGPTPlanSessionService,
        models: ChatGPTPlanModelListPort,
        model_providers: ModelProviderRepository,
        uow: UnitOfWork,
        lock: asyncio.Lock | None = None,
    ) -> None:
        self._session = session
        self._models = models
        self._model_providers = model_providers
        self._uow = uow
        self._lock = lock or asyncio.Lock()

    async def refresh(self) -> list[ModelProvider]:
        """List the account's models and store them; returns the active rows.

        Raises ``ChatGPTPlanUnavailableError`` when the plan cannot be used
        (not signed in, plan use off, OpenAI unreachable or the session ended).
        """

        async with self._lock:
            return await self._refresh()

    async def _refresh(self) -> list[ModelProvider]:
        listings = await self._list()
        rows = [plan_model_row(listing) for listing in listings if listing.listed]
        listed_ids = {row.id for row in rows}
        stale = [row for row in await self._current_rows() if row.id not in listed_ids]
        stored = await self._model_providers.upsert_many([*rows, *_retired(stale)])
        await self._uow.commit()
        return [row for row in stored if row.active]

    async def withdraw(self) -> int:
        """Retire every plan row, as after sign-out. Returns how many were active."""

        async with self._lock:
            active = await self._current_rows()
            if active:
                await self._model_providers.upsert_many(_retired(active))
                await self._uow.commit()
            return len(active)

    async def _list(self) -> list[PlanModelListing]:
        token = await self._session.access_token("interactive")
        try:
            return await self._models.list_models(token)
        except ChatGPTPlanModelListError as error:
            if not error.rejected_token:
                raise ChatGPTPlanUnavailableError("temporarily_unavailable") from error
        # A token OpenAI refused is renewed once, however many callers saw the refusal.
        token = await self._session.refresh_rejected(token, "interactive")
        try:
            return await self._models.list_models(token)
        except ChatGPTPlanModelListError as error:
            raise ChatGPTPlanUnavailableError("temporarily_unavailable") from error

    async def _current_rows(self) -> list[ModelProvider]:
        return await self._model_providers.list_for_connection(BUILTIN_CHATGPT_PLAN_CONNECTION_ID)


def _retired(rows: Iterable[ModelProvider]) -> list[ModelProvider]:
    return [replace(row, active=False) for row in rows]

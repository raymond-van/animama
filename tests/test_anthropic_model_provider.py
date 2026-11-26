"""Anthropic provider identity, built-in connection, credentials and catalog.

These tests cover the backend contract that later phases build the Anthropic
chat adapter on: the provider type and API standard, the built-in ``anthropic``
connection and its key, the Claude Haiku 5.5 catalog row, owner rows on that
connection, the persisted **Compact early** flag, catalog exposure and roles.
No test sends a request to Anthropic.
"""

from __future__ import annotations

import json
import re
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from sqlalchemy import select

import tests.test_anima_chat_sse as chat_sse_helpers
from animama.adapters.repositories.sqlalchemy.chat_repo import SQLAlchemyChatRepository
from animama.adapters.repositories.sqlalchemy.model_provider_repo import SQLAlchemyModelProviderRepository
from animama.adapters.repositories.sqlalchemy.uow import SQLAlchemyUnitOfWork
from animama.app.chat.api_standard import (
    ANTHROPIC_MESSAGES_PROVIDER_TYPE,
    CHAT_API_STANDARD_ANTHROPIC_MESSAGES,
    CHAT_API_STANDARD_CHAT_COMPLETIONS,
    CHAT_API_STANDARD_RESPONSES,
    MODEL_CLIENT_ANTHROPIC_MESSAGES,
    chat_api_standard_for_provider_type,
)
from animama.app.chat.direct_turn.constants import DIRECT_MEMORY_TOOL_SUPPORT_BY_PROVIDER
from animama.app.model_catalog import (
    DEFAULT_ANTHROPIC_CHAT_EFFORT,
    default_chat_reasoning_effort,
    early_compaction_available,
    serialize_builtin_model_connections,
    serialize_model_catalog,
    serialize_model_provider_catalog,
)
from animama.app.model_clients.credential_store import (
    ANTHROPIC_CREDENTIAL_ENV,
    KNOWN_PROVIDER_CREDENTIAL_ENVS,
    credential_values_from_environment,
    is_allowed_credential_env,
    is_deliverable_credential_env,
)
from animama.app.model_clients.credentials import (
    CREDENTIAL_CONFIGURED,
    CREDENTIAL_MISSING,
    builtin_anthropic_connection,
    builtin_openai_connection,
    connection_for_model_provider,
    static_credential_resolver,
)
from animama.app.model_clients.probe import ModelProbeReport, ModelProbeStep
from animama.app.model_connection_presets import MODEL_CONNECTION_PRESETS, PRESET_ANTHROPIC
from animama.app.model_provider_native_tools import requestable_native_tool_support
from animama.app.services import ChatApiStandardConflictError, ChatManager
from animama.app.services.model_provider_catalog_service import ModelCatalogPolicy, ModelProviderCatalogService
from animama.app.services.model_role_resolver import (
    ROLE_CHAT,
    ROLE_EMBEDDINGS,
    ROLE_MEMORY_MANAGER,
    ROLE_UTILITY,
    suits_role,
)
from animama.domain import ModelProvider, ModelProviderCapabilities, ModelProviderPricing
from animama.domain.model_connection import (
    BUILTIN_ANTHROPIC_CONNECTION_ID,
    BUILTIN_OPENAI_CONNECTION_ID,
    ModelConnection,
)
from animama.domain.request_principal import RequestPrincipal
from animama.orm import ORMAnima, ORMChat, ORMChatMessage, ORMModelProvider
from animama.orm.base import Base
from animama.server.model_clients import build_model_client_registry
from animama.server.routers.model_configuration import get_anthropic_connection_probe
from animama.utils.type_helpers import coerce_provider_type
from tests.anthropic_fakes import (
    SENTINEL_KEY,
    FakeAnthropicClient,
    FakeClientFactory,
    captured_anima_log_records,
    message_events,
    structured_reply,
    text_block,
    thinking_block,
)
from tests.local_http_client import local_client
from tests.test_model_configuration_api import _app, _seed_builtins
from tests.test_model_provider_catalog import _apply_seed_sql, _clear_model_provider_rows

HAIKU_ID = "AnthropicMessagesHTTPAgent:claude-haiku-5-5"
LUNA_ID = "OpenAIResponsesHTTPAgent:gpt-6-luna"
BASELINE_SQL = Path(__file__).parents[1] / "src" / "backend" / "migrations" / "versions" / "0001_baseline.sql"


def _rows_by_id() -> dict[str, dict[str, Any]]:
    return {str(row["id"]): row for row in serialize_model_provider_catalog()}


def _anthropic_row(**overrides: Any) -> ModelProvider:
    values: dict[str, Any] = {
        "id": HAIKU_ID,
        "model": "claude-haiku-5-5",
        "provider_type": ANTHROPIC_MESSAGES_PROVIDER_TYPE,
        "model_label": "claude-haiku-5-5",
        "provider_label": "Anthropic",
        "connection_id": BUILTIN_ANTHROPIC_CONNECTION_ID,
        "context_window_tokens": 1_000_000,
        "capabilities": ModelProviderCapabilities(
            accepts=["image", "text"],
            produces=["text"],
            supports_tools=True,
            supports_streaming=True,
        ),
        "pricing": ModelProviderPricing(long_context_token_threshold=100_000),
        "connection": builtin_anthropic_connection(),
    }
    values.update(overrides)
    return ModelProvider(**values)


# --------------------------------------------------------------- identity


def test_anthropic_provider_type_has_its_own_api_standard_and_model_client() -> None:
    profile = chat_api_standard_for_provider_type(ANTHROPIC_MESSAGES_PROVIDER_TYPE)

    assert ANTHROPIC_MESSAGES_PROVIDER_TYPE == "AnthropicMessagesHTTPAgent"
    assert profile is not None
    assert profile.api_standard == CHAT_API_STANDARD_ANTHROPIC_MESSAGES == "anthropic_messages"
    assert profile.model_client == MODEL_CLIENT_ANTHROPIC_MESSAGES == "anthropic_messages"
    assert coerce_provider_type("AnthropicMessagesHTTPAgent") == ANTHROPIC_MESSAGES_PROVIDER_TYPE
    assert coerce_provider_type("anthropic_messages_http") == ANTHROPIC_MESSAGES_PROVIDER_TYPE


def test_chats_accept_the_anthropic_api_standard_in_the_orm_and_the_baseline() -> None:
    checks = {
        str(constraint.name): str(getattr(constraint, "sqltext", ""))
        for constraint in Base.metadata.tables["chats"].constraints
        if constraint.name
    }
    baseline = BASELINE_SQL.read_text(encoding="utf-8")

    for suffix in ("api_standard_valid", "last_model_client_valid"):
        (sqltext,) = [text for name, text in checks.items() if name.endswith(suffix)]
        assert "'anthropic_messages'" in sqltext
    for constraint in ("ck_chats_api_standard_valid", "ck_chats_last_model_client_valid"):
        line = next(line for line in baseline.splitlines() if constraint in line)
        assert "'anthropic_messages'::character varying" in line
    assert "early_compaction boolean DEFAULT true NOT NULL" in baseline


def test_anthropic_rows_offer_direct_memory_tools_and_request_native_web_search() -> None:
    assert ANTHROPIC_MESSAGES_PROVIDER_TYPE in DIRECT_MEMORY_TOOL_SUPPORT_BY_PROVIDER
    assert requestable_native_tool_support(ANTHROPIC_MESSAGES_PROVIDER_TYPE, ["web_search", "code_execution"]) == [
        "web_search"
    ]


# ------------------------------------------------------- connection and catalog


def test_both_built_in_connections_are_seeded_and_anthropic_is_not_owner_selectable() -> None:
    connections = {row["id"]: row for row in serialize_builtin_model_connections()}
    preset = MODEL_CONNECTION_PRESETS[PRESET_ANTHROPIC]

    # The ChatGPT plan's connection is built in too; its credential is a sign-in (spec #919).
    assert set(connections) == {BUILTIN_OPENAI_CONNECTION_ID, BUILTIN_ANTHROPIC_CONNECTION_ID, "chatgpt_plan"}
    anthropic = connections[BUILTIN_ANTHROPIC_CONNECTION_ID]
    assert anthropic["source"] == "builtin"
    assert anthropic["name"] == "Anthropic"
    assert anthropic["preset"] == PRESET_ANTHROPIC
    # The connection's key comes only from ANTHROPIC_API_KEY, never a stored reference or URL.
    assert anthropic["base_url"] is None
    assert anthropic["credential_env"] is None
    assert preset.owner_selectable is False
    assert preset.label == "Anthropic"
    assert preset.logo_provider == "anthropic"
    assert builtin_anthropic_connection().is_builtin
    assert not builtin_anthropic_connection().is_builtin_openai


def test_haiku_row_declares_the_anthropic_contract() -> None:
    row = _rows_by_id()[HAIKU_ID]

    assert row["model"] == "claude-haiku-5-5"
    assert row["provider_type"] == ANTHROPIC_MESSAGES_PROVIDER_TYPE
    assert row["connection_id"] == BUILTIN_ANTHROPIC_CONNECTION_ID
    assert row["source"] == "builtin"
    assert row["model_kind"] == "chat"
    assert row["hidden"] is False
    assert row["early_compaction"] is True
    assert row["provider_label"] == "Anthropic"
    assert row["logo_provider"] == "anthropic"
    assert row["context_window_tokens"] == 1_000_000
    assert row["max_output_tokens"] == 128_000
    assert row["accepts"] == ["image", "text"]
    assert row["supports_tools"] is True
    assert row["supports_streaming"] is True
    assert row["structured_kinds"] == ["main_structured_response"]
    assert row["structured_output_transport"] == "json_schema"
    assert row["supports_reasoning"] is True
    assert row["supported_reasoning_efforts"] == ["none", "low", "medium", "high", "xhigh", "max"]
    assert row["native_tool_support"] == ["web_search"]


def test_haiku_row_prices_standard_batch_and_the_long_context_step() -> None:
    row = _rows_by_id()[HAIKU_ID]

    assert row["pricing_status"] == "priced"
    assert row["pricing_source_provider"] == "anthropic"
    assert row["pricing_source_model"] == "claude-haiku-5-5"
    assert row["currency"] == "USD"
    assert row["billing_unit"] == "1M_tokens"
    assert row["service_tiers_supported"] == ["standard", "batch"]
    expected = {
        "standard_input_price_per_million": "0.10",
        "standard_cached_input_price_per_million": "0.01",
        "standard_output_price_per_million": "0.50",
        "batch_input_price_per_million": "0.05",
        "batch_cached_input_price_per_million": "0.005",
        "batch_output_price_per_million": "0.25",
        "standard_long_context_input_price_per_million": "0.50",
        "standard_long_context_cached_input_price_per_million": "0.05",
        "standard_long_context_output_price_per_million": "2.50",
        "batch_long_context_input_price_per_million": "0.25",
        "batch_long_context_cached_input_price_per_million": "0.025",
        "batch_long_context_output_price_per_million": "1.25",
    }
    for column, value in expected.items():
        assert row[column] == Decimal(value), column
    assert row["long_context_token_threshold"] == 100_000
    for column in ("flex_input_price_per_million", "priority_input_price_per_million"):
        assert row[column] is None


def test_public_haiku_row_names_its_connection_and_api_standard() -> None:
    row = next(item for item in serialize_model_catalog() if item["id"] == HAIKU_ID)

    assert row["connection_id"] == BUILTIN_ANTHROPIC_CONNECTION_ID
    assert row["connection_name"] == "Anthropic"
    assert row["api_standard"] == "anthropic_messages"
    assert row["model_client"] == "anthropic_messages"
    assert row["requestable_native_tool_support"] == ["web_search"]
    assert "early_compaction" not in row


def test_public_rows_report_the_anthropic_chat_default_effort() -> None:
    rows = {str(row["id"]): row for row in serialize_model_catalog()}

    # The chat picker preselects this effort (D26); requests without one use it too (D22).
    assert DEFAULT_ANTHROPIC_CHAT_EFFORT == "medium"
    assert rows[HAIKU_ID]["default_reasoning_effort"] == DEFAULT_ANTHROPIC_CHAT_EFFORT
    for row in rows.values():
        if row["model_provider"] != ANTHROPIC_MESSAGES_PROVIDER_TYPE:
            assert row["default_reasoning_effort"] is None, row["id"]


def test_only_anthropic_rows_offering_the_chat_default_effort_report_it() -> None:
    assert default_chat_reasoning_effort(ANTHROPIC_MESSAGES_PROVIDER_TYPE, ["low", "medium"]) == "medium"
    assert default_chat_reasoning_effort(ANTHROPIC_MESSAGES_PROVIDER_TYPE, [" medium "]) == "medium"
    assert default_chat_reasoning_effort(ANTHROPIC_MESSAGES_PROVIDER_TYPE, ["none", "high"]) is None
    assert default_chat_reasoning_effort(ANTHROPIC_MESSAGES_PROVIDER_TYPE, None) is None
    assert default_chat_reasoning_effort("OpenAIResponsesHTTPAgent", ["none", "medium"]) is None
    assert default_chat_reasoning_effort("OpenAIHTTPAgent", ["medium"]) is None


def test_only_anthropic_rows_with_a_long_context_price_step_offer_compact_early() -> None:
    assert early_compaction_available(_anthropic_row())
    # Owner-added rows are unpriced, so they have no price step.
    assert not early_compaction_available(_anthropic_row(pricing=ModelProviderPricing()))
    assert not early_compaction_available(
        _anthropic_row(provider_type="OpenAIResponsesHTTPAgent", connection_id=BUILTIN_OPENAI_CONNECTION_ID)
    )


def test_anthropic_rows_without_a_loaded_connection_use_the_built_in_anthropic_connection() -> None:
    row = _anthropic_row(connection=None)

    assert connection_for_model_provider(row).id == BUILTIN_ANTHROPIC_CONNECTION_ID


# ------------------------------------------------------------------ credentials


def test_each_built_in_connection_resolves_only_its_own_key() -> None:
    both = static_credential_resolver({"OPENAI_API_KEY": "sk-openai", ANTHROPIC_CREDENTIAL_ENV: "sk-ant"})
    openai_only = static_credential_resolver({"OPENAI_API_KEY": "sk-openai"})
    anthropic_only = static_credential_resolver({ANTHROPIC_CREDENTIAL_ENV: "sk-ant"})

    assert both.resolve(builtin_anthropic_connection()).api_key == "sk-ant"
    assert both.resolve(builtin_openai_connection()).api_key == "sk-openai"
    # A missing key never borrows the other built-in connection's key.
    missing_anthropic = openai_only.resolve(builtin_anthropic_connection())
    assert missing_anthropic.state == CREDENTIAL_MISSING and missing_anthropic.api_key is None
    missing_openai = anthropic_only.resolve(builtin_openai_connection())
    assert missing_openai.state == CREDENTIAL_MISSING and missing_openai.api_key is None
    assert anthropic_only.resolve(builtin_anthropic_connection()).state == CREDENTIAL_CONFIGURED


@pytest.mark.asyncio
async def test_openai_clients_never_send_the_anthropic_key(monkeypatch) -> None:
    from openai import AsyncOpenAI

    from animama.adapters.model_clients import OpenAIChatCompletionsModelClient
    from animama.app.model_clients import ModelClientProviderError
    from tests.test_model_client_registry import _collect, _spec

    built: list[dict[str, Any]] = []
    original_init = AsyncOpenAI.__init__

    def _record(self, *args, **kwargs):
        built.append(kwargs)
        original_init(self, *args, **kwargs)

    monkeypatch.setattr(AsyncOpenAI, "__init__", _record)
    client = OpenAIChatCompletionsModelClient(
        credential_resolver=static_credential_resolver({"OPENAI_API_KEY": "sk-openai", "ANTHROPIC_API_KEY": "sk-ant"}),
        client=None,
    )

    with pytest.raises(ModelClientProviderError) as caught:
        await _collect(client.stream(_spec(connection=builtin_anthropic_connection())))

    # The Anthropic connection has no OpenAI-compatible endpoint, so no client is built.
    assert caught.value.code == "connection_base_url_missing"
    assert built == []


def test_the_anthropic_key_is_read_at_startup_and_deliverable_by_the_desktop_vault() -> None:
    assert ANTHROPIC_CREDENTIAL_ENV == "ANTHROPIC_API_KEY"
    assert is_deliverable_credential_env(ANTHROPIC_CREDENTIAL_ENV)
    assert credential_values_from_environment({"ANTHROPIC_API_KEY": " sk-ant ", "ANTHROPIC_BASE_URL": "x"}) == {
        "ANTHROPIC_API_KEY": "sk-ant"
    }


def test_owner_connections_can_never_read_the_anthropic_key() -> None:
    # Only the built-in Anthropic connection sends this key, and only to Anthropic's API.
    assert ANTHROPIC_CREDENTIAL_ENV not in KNOWN_PROVIDER_CREDENTIAL_ENVS
    assert not is_allowed_credential_env(ANTHROPIC_CREDENTIAL_ENV)
    owner = ModelConnection(
        id="c_owner",
        name="Proxy",
        preset="custom",
        source="owner",
        base_url="https://example.invalid/v1",
        credential_env=ANTHROPIC_CREDENTIAL_ENV,
    )
    resolver = static_credential_resolver({ANTHROPIC_CREDENTIAL_ENV: "sk-ant-secret"})

    assert resolver.resolve(owner).state == CREDENTIAL_MISSING
    assert resolver.resolve(builtin_anthropic_connection()).api_key == "sk-ant-secret"


def test_compose_passes_the_anthropic_key_only_to_the_application_server() -> None:
    compose = (Path(__file__).parents[1] / "docker-compose.yml").read_text(encoding="utf-8")

    assert [line.strip() for line in compose.splitlines() if "ANTHROPIC_API_KEY" in line] == [
        "ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}"
    ]
    after_server = compose.split("\n  animama-server:\n", 1)[1]
    server_block = re.split(r"\n  [a-z][a-z0-9_-]*:\n", after_server, maxsplit=1)[0]
    assert "ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}" in server_block


# ------------------------------------------------------------ policy and roles


def test_default_policy_hides_anthropic_built_ins_while_the_local_policy_shows_them() -> None:
    haiku = _anthropic_row()
    luna = _anthropic_row(
        id=LUNA_ID, provider_type="OpenAIResponsesHTTPAgent", connection_id=BUILTIN_OPENAI_CONNECTION_ID
    )

    assert not ModelCatalogPolicy().allows(haiku)
    assert ModelCatalogPolicy().allows(luna)
    assert ModelCatalogPolicy.local().allows(haiku)
    assert ModelCatalogPolicy.local().allows(luna)
    assert ModelCatalogPolicy.local().owner_models_enabled
    assert ModelCatalogPolicy(builtin_allowlist=frozenset({HAIKU_ID})).allows(haiku)


def test_anthropic_chat_rows_suit_chat_utility_and_memory_manager_but_never_embeddings() -> None:
    row = _anthropic_row()

    assert suits_role(ROLE_CHAT, row)
    assert suits_role(ROLE_UTILITY, row)
    assert suits_role(ROLE_MEMORY_MANAGER, row)
    assert not suits_role(ROLE_EMBEDDINGS, row)


# --------------------------------------------------------------------- registry


def test_llm_skip_serves_anthropic_rows_with_the_mock_client(monkeypatch) -> None:
    from animama.adapters.model_clients import MockModelClient

    monkeypatch.setenv("ANIMAMA_LLM_SKIP", "1")
    registry = build_model_client_registry()

    assert isinstance(registry.get(ANTHROPIC_MESSAGES_PROVIDER_TYPE), MockModelClient)


def test_startup_without_an_anthropic_key_registers_the_anthropic_client() -> None:
    from animama.adapters.model_clients import AnthropicMessagesModelClient

    # The key is read per request, so the backend starts without one.
    registry = build_model_client_registry(credential_resolver=static_credential_resolver())

    assert isinstance(registry.get(ANTHROPIC_MESSAGES_PROVIDER_TYPE), AnthropicMessagesModelClient)


# ------------------------------------------------------------------- persistence


@pytest.mark.asyncio
async def test_reseeding_keeps_hidden_and_compact_early_on_both_built_in_connections(async_session) -> None:
    await _clear_model_provider_rows(async_session)
    await _apply_seed_sql(async_session)
    await async_session.commit()
    async_session.expire_all()
    haiku = await async_session.get(ORMModelProvider, HAIKU_ID)
    luna = await async_session.get(ORMModelProvider, LUNA_ID)
    assert haiku is not None and luna is not None
    assert haiku.connection_id == BUILTIN_ANTHROPIC_CONNECTION_ID
    assert (haiku.hidden, haiku.early_compaction) == (False, True)
    haiku.hidden = True
    haiku.early_compaction = False
    luna.hidden = True
    await async_session.commit()

    for _ in range(2):
        await _apply_seed_sql(async_session)
        await async_session.commit()
    async_session.expire_all()

    haiku = await async_session.get(ORMModelProvider, HAIKU_ID)
    luna = await async_session.get(ORMModelProvider, LUNA_ID)
    assert haiku is not None and (haiku.hidden, haiku.early_compaction, haiku.active) == (True, False, True)
    assert luna is not None and (luna.hidden, luna.active) == (True, True)


@pytest.mark.asyncio
async def test_catalog_sync_keeps_the_owner_compact_early_choice(async_session) -> None:
    await _clear_model_provider_rows(async_session)
    await _seed_builtins(async_session)
    repo = SQLAlchemyModelProviderRepository(async_session)
    await repo.set_early_compaction(HAIKU_ID, enabled=False)
    await async_session.commit()

    await _seed_builtins(async_session)
    stored = await repo.get(HAIKU_ID)

    assert stored is not None
    assert stored.early_compaction is False
    assert stored.connection is not None and stored.connection.id == BUILTIN_ANTHROPIC_CONNECTION_ID


@pytest.mark.asyncio
async def test_default_catalog_policy_hides_anthropic_built_ins_from_the_public_catalog(async_session) -> None:
    await _clear_model_provider_rows(async_session)
    await _seed_builtins(async_session)
    service = ModelProviderCatalogService(model_providers=SQLAlchemyModelProviderRepository(async_session))

    hosted = {row["id"] for row in await service.list_public_catalog()}
    local = {row["id"]: row for row in await service.list_public_catalog(ModelCatalogPolicy.local())}

    assert HAIKU_ID not in hosted
    assert LUNA_ID in hosted
    assert local[HAIKU_ID]["connection_name"] == "Anthropic"


@pytest.mark.asyncio
async def test_an_anthropic_chat_is_fenced_from_openai_models(async_session) -> None:
    from animama.adapters.repositories.sqlalchemy.chat_compaction_repo import SQLAlchemyChatCompactionRepository
    from animama.adapters.repositories.sqlalchemy.chat_message_repo import SQLAlchemyChatMessageRepository

    anima_id = f"anima-fence-{uuid4().hex[:8]}"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    await async_session.commit()
    manager = ChatManager(
        chats=SQLAlchemyChatRepository(async_session),
        messages=SQLAlchemyChatMessageRepository(async_session),
        compactions=SQLAlchemyChatCompactionRepository(async_session),
        uow=SQLAlchemyUnitOfWork(async_session),
    )
    chat_id = f"chat-fence-{uuid4().hex[:8]}"

    chat = await manager.ensure_owned_chat(
        anima_id=anima_id,
        chat_id=chat_id,
        user_id="user-1",
        api_standard=CHAT_API_STANDARD_ANTHROPIC_MESSAGES,
        model_provider_id=HAIKU_ID,
    )
    with pytest.raises(ChatApiStandardConflictError) as caught:
        await manager.ensure_owned_chat(
            anima_id=anima_id,
            chat_id=chat_id,
            user_id="user-1",
            api_standard=CHAT_API_STANDARD_RESPONSES,
            model_provider_id=LUNA_ID,
        )

    assert chat.api_standard == CHAT_API_STANDARD_ANTHROPIC_MESSAGES
    assert caught.value.detail["chat_api_standard"] == CHAT_API_STANDARD_ANTHROPIC_MESSAGES
    assert caught.value.detail["action"] == "start_new_chat"


# ------------------------------------------------------------- owner settings


class _FakeAnthropicProbe:
    """Stands in for the Models API probe on the Anthropic connection."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str]] = []

    async def list_models(self, connection):
        self.calls.append(("list", connection.id, ""))
        return ["claude-haiku-5-5", "claude-sonnet-5-5"]

    async def probe_chat_model(self, connection, *, model):
        self.calls.append(("chat", connection.id, model))
        return ModelProbeReport(
            model=model,
            steps=(ModelProbeStep(name="available", ok=True),),
            supports_streaming=True,
            structured_output_transport="json_schema",
            supports_tools=True,
            tools_with_structured_output=True,
            context_window_tokens=1_000_000,
            max_output_tokens=64_000,
            supported_reasoning_efforts=("low", "medium", "high"),
            native_tool_support=("web_search",),
        )

    async def probe_responses_model(self, connection, *, model):
        raise AssertionError("Responses is never probed on the Anthropic connection")

    async def probe_embedding_model(self, connection, *, model):
        raise AssertionError("Embeddings are never probed on the Anthropic connection")


def _anthropic_app(async_session, tmp_path, owner_id: str, probe: _FakeAnthropicProbe | None = None) -> FastAPI:
    app = _app(async_session, tmp_path, owner_id)
    app.state.model_catalog_policy = ModelCatalogPolicy.local()
    app.dependency_overrides[get_anthropic_connection_probe] = lambda: probe or _FakeAnthropicProbe()
    return app


@pytest.fixture
def owner_id() -> str:
    return f"owner-{uuid4().hex[:8]}"


@pytest.mark.asyncio
async def test_the_anthropic_connection_is_listed_with_its_key_state(
    async_session, tmp_path, owner_id, set_runtime_credentials
) -> None:
    # Start from catalog defaults: other tests change built-in flags that sync keeps.
    await _clear_model_provider_rows(async_session)
    await _seed_builtins(async_session)
    app = _anthropic_app(async_session, tmp_path, owner_id)
    set_runtime_credentials(OPENAI_API_KEY="sk-openai-secret")
    async with local_client(app) as client:
        without_key = {item["id"]: item for item in (await client.get("/v1/model-connections")).json()}
        set_runtime_credentials(OPENAI_API_KEY="sk-openai-secret", ANTHROPIC_API_KEY="sk-ant-secret")
        listed = await client.get("/v1/model-connections")
        removed = await client.delete("/v1/model-connections/anthropic")
        edited = await client.patch("/v1/model-connections/anthropic", json={"name": "Claude"})

    with_key = {item["id"]: item for item in listed.json()}
    assert [item["id"] for item in listed.json()][:2] == ["openai", "anthropic"]
    anthropic = without_key["anthropic"]
    assert anthropic["source"] == "builtin"
    assert anthropic["name"] == "Anthropic"
    assert anthropic["logo_provider"] == "anthropic"
    assert anthropic["credential_state"] == "missing"
    assert with_key["anthropic"]["credential_state"] == "configured"
    haiku = next(model for model in anthropic["models"] if model["id"] == HAIKU_ID)
    assert haiku["early_compaction"] is True
    assert {model["provider_type"] for model in anthropic["models"]} == {ANTHROPIC_MESSAGES_PROVIDER_TYPE}
    assert all(model["early_compaction"] is None for model in without_key["openai"]["models"])
    assert "sk-ant-secret" not in listed.text and "sk-openai-secret" not in listed.text
    assert removed.status_code == 400 and removed.json()["detail"]["code"] == "connection_read_only"
    assert edited.status_code == 400 and edited.json()["detail"]["code"] == "connection_read_only"


@pytest.mark.asyncio
async def test_owner_models_on_the_anthropic_connection_use_the_messages_api(async_session, tmp_path, owner_id) -> None:
    await _seed_builtins(async_session)
    app = _anthropic_app(async_session, tmp_path, owner_id)
    async with local_client(app) as client:
        templated = await client.post(
            "/v1/model-connections/anthropic/models",
            json={"model": f"claude-haiku-5-5-{uuid4().hex[:8]}", "template_id": HAIKU_ID},
        )
        probed = await client.post(
            "/v1/model-connections/anthropic/models",
            json={
                "model": f"claude-sonnet-5-5-{uuid4().hex[:8]}",
                "capabilities": {
                    "accepts_images": True,
                    "supports_tools": True,
                    "supported_reasoning_efforts": ["low", "medium", "high"],
                },
                "context_window_tokens": 1_000_000,
                "probe_result": {
                    "model": "claude-sonnet-5-5-probed",
                    "max_output_tokens": 64_000,
                    "native_tool_support": ["web_search", "code_execution"],
                    "supported_reasoning_efforts": ["low", "medium", "high"],
                },
            },
        )
        without_medium = await client.post(
            "/v1/model-connections/anthropic/models",
            json={
                "model": f"claude-opus-5-5-{uuid4().hex[:8]}",
                "capabilities": {"supports_tools": True, "supported_reasoning_efforts": ["none", "high"]},
                "context_window_tokens": 200_000,
            },
        )
        catalog = {row["id"]: row for row in (await client.get("/v1/model-providers")).json()}

    assert templated.status_code == 201, templated.text
    template_view = templated.json()
    assert template_view["provider_type"] == ANTHROPIC_MESSAGES_PROVIDER_TYPE
    assert template_view["connection_id"] == BUILTIN_ANTHROPIC_CONNECTION_ID
    assert template_view["context_window_tokens"] == 1_000_000
    assert template_view["capabilities"]["native_tool_support"] == ["web_search"]
    assert template_view["capabilities"]["supported_reasoning_efforts"] == [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ]
    # Owner rows are unpriced, so they have no long-context step and no Compact early setting.
    assert template_view["early_compaction"] is None
    assert probed.status_code == 201, probed.text
    probed_view = probed.json()
    assert probed_view["provider_type"] == ANTHROPIC_MESSAGES_PROVIDER_TYPE
    assert probed_view["capabilities"]["native_tool_support"] == ["web_search"]
    assert probed_view["probe_result"]["max_output_tokens"] == 64_000
    stored_template = await SQLAlchemyModelProviderRepository(async_session).get(template_view["id"])
    stored_probed = await SQLAlchemyModelProviderRepository(async_session).get(probed_view["id"])
    assert stored_template is not None and stored_template.max_output_tokens == 128_000
    assert stored_template.pricing.pricing_status == "unpriced"
    assert stored_probed is not None and stored_probed.max_output_tokens == 64_000
    row = catalog[probed_view["id"]]
    assert row["api_standard"] == "anthropic_messages"
    assert row["provider_label"] == "Anthropic"
    assert row["logo_provider"] == "anthropic"
    assert row["requestable_native_tool_support"] == ["web_search"]
    # Owner rows report the Anthropic chat default only when they offer it (D26).
    assert without_medium.status_code == 201, without_medium.text
    assert catalog[template_view["id"]]["default_reasoning_effort"] == "medium"
    assert row["default_reasoning_effort"] == "medium"
    assert catalog[without_medium.json()["id"]]["default_reasoning_effort"] is None
    assert catalog[HAIKU_ID]["default_reasoning_effort"] == "medium"
    assert catalog[LUNA_ID]["default_reasoning_effort"] is None


@pytest.mark.parametrize(
    ("connection", "body", "code"),
    [
        ("anthropic", {"provider_type": "OpenAIHTTPAgent"}, "invalid_provider_type"),
        ("anthropic", {"provider_type": "OpenAIResponsesHTTPAgent"}, "invalid_provider_type"),
        ("anthropic", {"template_id": LUNA_ID}, "invalid_template"),
        ("anthropic", {"kind": "embedding"}, "invalid_model_kind"),
        ("openai", {"provider_type": ANTHROPIC_MESSAGES_PROVIDER_TYPE}, "invalid_provider_type"),
        ("openai", {"template_id": HAIKU_ID}, "invalid_template"),
        ("owner", {"provider_type": ANTHROPIC_MESSAGES_PROVIDER_TYPE}, "invalid_provider_type"),
        ("owner", {"template_id": HAIKU_ID}, "invalid_template"),
        ("anthropic", {"capabilities": {"supported_reasoning_efforts": ["minimal"]}}, "invalid_capabilities"),
        ("anthropic", {"capabilities": {"structured_output_transport": "json_object"}}, "invalid_capabilities"),
    ],
)
@pytest.mark.asyncio
async def test_the_anthropic_type_and_templates_stay_on_the_anthropic_connection(
    async_session, tmp_path, owner_id, connection, body, code
) -> None:
    await _seed_builtins(async_session)
    app = _anthropic_app(async_session, tmp_path, owner_id)
    async with local_client(app) as client:
        if connection == "owner":
            created = await client.post(
                "/v1/model-connections",
                json={"name": "Ollama", "preset": "ollama", "base_url": "http://127.0.0.1:11434/v1"},
            )
            connection = created.json()["id"]
        response = await client.post(
            f"/v1/model-connections/{connection}/models",
            json={"model": "claude-sonnet-5-5", "context_window_tokens": 8192, **body},
        )

    assert response.status_code == 400, response.text
    assert response.json()["detail"]["code"] == code


@pytest.mark.asyncio
async def test_probe_and_model_listing_on_the_anthropic_connection_use_the_models_api(
    async_session, tmp_path, owner_id
) -> None:
    probe = _FakeAnthropicProbe()
    app = _anthropic_app(async_session, tmp_path, owner_id, probe=probe)
    async with local_client(app) as client:
        listed = await client.get("/v1/model-connections/anthropic/available-models")
        report = await client.post("/v1/model-connections/anthropic/probe", json={"model": "claude-sonnet-5-5"})
        explicit = await client.post(
            "/v1/model-connections/anthropic/probe",
            json={"model": "claude-sonnet-5-5", "provider_type": ANTHROPIC_MESSAGES_PROVIDER_TYPE},
        )
        embedding = await client.post(
            "/v1/model-connections/anthropic/probe", json={"model": "voyage", "kind": "embedding"}
        )
        openai_type = await client.post(
            "/v1/model-connections/anthropic/probe",
            json={"model": "claude-sonnet-5-5", "provider_type": "OpenAIHTTPAgent"},
        )
        elsewhere = await client.post(
            "/v1/model-connections/openai/probe",
            json={"model": "claude-sonnet-5-5", "provider_type": ANTHROPIC_MESSAGES_PROVIDER_TYPE},
        )

    assert listed.json() == {"models": ["claude-haiku-5-5", "claude-sonnet-5-5"]}
    assert report.status_code == 200, report.text
    view = report.json()
    assert view["context_window_tokens"] == 1_000_000
    assert view["max_output_tokens"] == 64_000
    assert view["supported_reasoning_efforts"] == ["low", "medium", "high"]
    assert view["native_tool_support"] == ["web_search"]
    assert explicit.status_code == 200
    assert embedding.status_code == 400 and embedding.json()["detail"]["code"] == "invalid_model_kind"
    assert openai_type.status_code == 400 and openai_type.json()["detail"]["code"] == "invalid_provider_type"
    assert elsewhere.status_code == 400 and elsewhere.json()["detail"]["code"] == "invalid_provider_type"
    assert probe.calls == [
        ("list", "anthropic", ""),
        ("chat", "anthropic", "claude-sonnet-5-5"),
        ("chat", "anthropic", "claude-sonnet-5-5"),
    ]


@pytest.mark.asyncio
async def test_compact_early_can_be_changed_only_on_rows_with_a_long_context_price_step(
    async_session, tmp_path, owner_id
) -> None:
    await _seed_builtins(async_session)
    app = _anthropic_app(async_session, tmp_path, owner_id)
    async with local_client(app) as client:
        owner_row = (
            await client.post(
                "/v1/model-connections/anthropic/models",
                json={"model": f"claude-sonnet-5-5-{uuid4().hex[:8]}", "template_id": HAIKU_ID},
            )
        ).json()
        turned_off = await client.patch(f"/v1/model-providers/{HAIKU_ID}", json={"early_compaction": False})
        hidden_too = await client.patch(
            f"/v1/model-providers/{HAIKU_ID}", json={"early_compaction": True, "hidden": True}
        )
        openai_builtin = await client.patch(f"/v1/model-providers/{LUNA_ID}", json={"early_compaction": False})
        unpriced_owner = await client.patch(f"/v1/model-providers/{owner_row['id']}", json={"early_compaction": False})
        label_on_builtin = await client.patch(f"/v1/model-providers/{HAIKU_ID}", json={"label": "Mine"})
        await client.patch(f"/v1/model-providers/{HAIKU_ID}", json={"hidden": False})

    assert turned_off.status_code == 200, turned_off.text
    assert turned_off.json()["early_compaction"] is False
    assert hidden_too.json()["early_compaction"] is True and hidden_too.json()["hidden"] is True
    for rejected in (openai_builtin, unpriced_owner):
        assert rejected.status_code == 400
        assert rejected.json()["detail"]["code"] == "early_compaction_unavailable"
    assert label_on_builtin.status_code == 400
    assert label_on_builtin.json()["detail"]["code"] == "model_read_only"


# --------------------------------------------------------------- chat turns


async def _seed_anthropic_turn(async_session, anima_id: str) -> None:
    await _seed_builtins(async_session)
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    await async_session.commit()
    await chat_sse_helpers._seed_anima_identity_file(async_session, anima_id=anima_id)


@pytest.mark.asyncio
async def test_a_mock_mode_turn_on_an_anthropic_row_records_the_anthropic_api_standard(
    monkeypatch, async_session, async_session_factory
) -> None:
    anima_id = f"anima-anthropic-{uuid4().hex[:8]}"
    chat_id = f"chat-anthropic-{uuid4().hex[:8]}"
    await _seed_anthropic_turn(async_session, anima_id)
    monkeypatch.setenv("ANIMAMA_LLM_SKIP", "1")
    chat_sse_helpers._install_db_route_mocks(monkeypatch, async_session_factory, default_model_provider_id=HAIKU_ID)
    monkeypatch.setattr(chat_sse_helpers, "_CURRENT_TEST_REGISTRY", build_model_client_registry())

    response = await chat_sse_helpers.chat_anima_direct_sse(
        anima_id,
        chat_sse_helpers._chat_request(message="hello claude", run_id=f"run-{chat_id}", chat_id=chat_id),
        request=chat_sse_helpers._test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await chat_sse_helpers._collect_chunks(response)

    assert chat_sse_helpers._event_data(chunks, "run.completed")["chat_id"] == chat_id
    async_session.expire_all()
    chat = await async_session.get(ORMChat, chat_id)
    assert chat is not None
    assert chat.api_standard == "anthropic_messages"
    assert chat.last_model_client == "anthropic_messages"
    assert chat.last_model_provider_id == HAIKU_ID


@pytest.mark.asyncio
async def test_a_turn_on_an_anthropic_row_without_its_client_fails_before_any_request(
    monkeypatch, async_session, async_session_factory
) -> None:
    anima_id = f"anima-anthropic-{uuid4().hex[:8]}"
    chat_id = f"chat-anthropic-{uuid4().hex[:8]}"
    await _seed_anthropic_turn(async_session, anima_id)
    openai_client = chat_sse_helpers._RouteModelClient()
    chat_sse_helpers._install_db_route_mocks(
        monkeypatch, async_session_factory, model_client=openai_client, default_model_provider_id=HAIKU_ID
    )

    with pytest.raises(HTTPException) as caught:
        await chat_sse_helpers.chat_anima_direct_sse(
            anima_id,
            chat_sse_helpers._chat_request(message="hello", run_id=f"run-{chat_id}", chat_id=chat_id),
            request=chat_sse_helpers._test_request(),
            user=RequestPrincipal(id="user-1"),
        )

    assert caught.value.status_code == 400
    assert ANTHROPIC_MESSAGES_PROVIDER_TYPE in str(caught.value.detail)
    assert openai_client.seen_specs == []
    stored = (await async_session.execute(select(ORMChat).where(ORMChat.id == chat_id))).scalar_one_or_none()
    assert stored is None


@pytest.mark.asyncio
async def test_a_turn_without_the_anthropic_key_reports_the_missing_key_naming_the_anthropic_connection(
    monkeypatch, async_session, async_session_factory
) -> None:
    anima_id = f"anima-anthropic-{uuid4().hex[:8]}"
    chat_id = f"chat-anthropic-{uuid4().hex[:8]}"
    await _seed_anthropic_turn(async_session, anima_id)
    fake = FakeAnthropicClient([])
    chat_sse_helpers._install_db_route_mocks(monkeypatch, async_session_factory, default_model_provider_id=HAIKU_ID)
    monkeypatch.setattr(
        chat_sse_helpers,
        "_CURRENT_TEST_REGISTRY",
        build_model_client_registry(
            credential_resolver=static_credential_resolver({"OPENAI_API_KEY": "sk-openai-not-for-anthropic"}),
            anthropic_client_factory=FakeClientFactory(fake),
        ),
    )

    response = await chat_sse_helpers.chat_anima_direct_sse(
        anima_id,
        chat_sse_helpers._chat_request(message="hello", run_id=f"run-{chat_id}", chat_id=chat_id),
        request=chat_sse_helpers._test_request(),
        user=RequestPrincipal(id="user-1"),
    )
    chunks = await chat_sse_helpers._collect_chunks(response)

    error = chat_sse_helpers._event_data(chunks, "error")
    assert error["code"] == "missing_api_key"
    assert error["error"] == "No key is configured for Anthropic"
    assert error["details"]["category"] == "credential_missing"
    assert error["details"]["connection_name"] == "Anthropic"
    assert fake.requests == []


@pytest.mark.asyncio
async def test_an_anthropic_turn_keeps_the_key_out_of_rows_responses_and_logs(
    monkeypatch, async_session, async_session_factory
) -> None:
    monkeypatch.setenv("ANIMAMA_MODEL_CLIENT_LOG_PREVIEWS", "true")
    anima_id = f"anima-anthropic-{uuid4().hex[:8]}"
    chat_id = f"chat-anthropic-{uuid4().hex[:8]}"
    await _seed_anthropic_turn(async_session, anima_id)
    fake = FakeAnthropicClient([message_events(thinking_block(), text_block(structured_reply("Hello from Claude.")))])
    chat_sse_helpers._install_db_route_mocks(monkeypatch, async_session_factory, default_model_provider_id=HAIKU_ID)
    monkeypatch.setattr(
        chat_sse_helpers,
        "_CURRENT_TEST_REGISTRY",
        build_model_client_registry(
            credential_resolver=static_credential_resolver({"ANTHROPIC_API_KEY": SENTINEL_KEY}),
            anthropic_client_factory=FakeClientFactory(fake),
        ),
    )

    with captured_anima_log_records() as records:
        response = await chat_sse_helpers.chat_anima_direct_sse(
            anima_id,
            chat_sse_helpers._chat_request(message="hello claude", run_id=f"run-{chat_id}", chat_id=chat_id),
            request=chat_sse_helpers._test_request(),
            user=RequestPrincipal(id="user-1"),
        )
        chunks = await chat_sse_helpers._collect_chunks(response)

    assert chat_sse_helpers._event_data(chunks, "run.completed")["chat_id"] == chat_id
    assert SENTINEL_KEY not in "".join(chunks)
    async_session.expire_all()
    rows = (await async_session.execute(select(ORMChatMessage).where(ORMChatMessage.chat_id == chat_id))).scalars()
    stored = [
        json.dumps(
            {"content": row.content, "data": row.message_data, "raw": row.raw_provider_message},
            default=str,
        )
        for row in rows
    ]
    assert len(stored) == 2
    assert all(SENTINEL_KEY not in row for row in stored)
    assert any('"anthropic"' in row for row in stored)
    chat = await async_session.get(ORMChat, chat_id)
    assert chat is not None and SENTINEL_KEY not in json.dumps(chat.metadata_, default=str)
    assert chat.cum_cached_input_tokens == 900
    assert any(record.getMessage() == "Anthropic Messages stream completed" for record in records)
    assert all(SENTINEL_KEY not in json.dumps(record.__dict__, default=str) for record in records)


@pytest.mark.parametrize(
    ("first_standard", "first_row", "second_standard", "second_row"),
    [
        (
            CHAT_API_STANDARD_ANTHROPIC_MESSAGES,
            HAIKU_ID,
            CHAT_API_STANDARD_CHAT_COMPLETIONS,
            "OpenAIHTTPAgent:gpt-6-luna",
        ),
        (
            CHAT_API_STANDARD_CHAT_COMPLETIONS,
            "OpenAIHTTPAgent:gpt-6-luna",
            CHAT_API_STANDARD_ANTHROPIC_MESSAGES,
            HAIKU_ID,
        ),
        (CHAT_API_STANDARD_RESPONSES, LUNA_ID, CHAT_API_STANDARD_ANTHROPIC_MESSAGES, HAIKU_ID),
    ],
)
@pytest.mark.asyncio
async def test_the_chat_fence_holds_both_ways_between_anthropic_and_openai(
    async_session, first_standard: str, first_row: str, second_standard: str, second_row: str
) -> None:
    from animama.adapters.repositories.sqlalchemy.chat_compaction_repo import SQLAlchemyChatCompactionRepository
    from animama.adapters.repositories.sqlalchemy.chat_message_repo import SQLAlchemyChatMessageRepository

    anima_id = f"anima-fence-{uuid4().hex[:8]}"
    async_session.add(ORMAnima(id=anima_id, user_id="user-1"))
    await async_session.commit()
    manager = ChatManager(
        chats=SQLAlchemyChatRepository(async_session),
        messages=SQLAlchemyChatMessageRepository(async_session),
        compactions=SQLAlchemyChatCompactionRepository(async_session),
        uow=SQLAlchemyUnitOfWork(async_session),
    )
    chat_id = f"chat-fence-{uuid4().hex[:8]}"
    await manager.ensure_owned_chat(
        anima_id=anima_id, chat_id=chat_id, user_id="user-1", api_standard=first_standard, model_provider_id=first_row
    )

    with pytest.raises(ChatApiStandardConflictError) as caught:
        await manager.ensure_owned_chat(
            anima_id=anima_id,
            chat_id=chat_id,
            user_id="user-1",
            api_standard=second_standard,
            model_provider_id=second_row,
        )

    assert caught.value.detail["code"] == "chat_api_standard_mismatch"
    assert caught.value.detail["chat_api_standard"] == first_standard
    assert caught.value.detail["requested_api_standard"] == second_standard
    assert caught.value.detail["action"] == "start_new_chat"


def test_the_anthropic_connection_has_neutral_options_and_openai_keeps_its_own() -> None:
    from animama.app.model_clients.credentials import builtin_anthropic_connection, builtin_openai_connection
    from animama.app.model_connection_presets import (
        ANTHROPIC_CONNECTION_COMPATIBILITY,
        MODEL_CONNECTION_PRESETS,
        PRESET_ANTHROPIC,
        PRESET_OPENAI,
    )
    from animama.domain.model_connection import ModelConnectionCompatibility

    assert builtin_anthropic_connection().compatibility == ANTHROPIC_CONNECTION_COMPATIBILITY
    assert MODEL_CONNECTION_PRESETS[PRESET_ANTHROPIC].compatibility == ANTHROPIC_CONNECTION_COMPATIBILITY
    assert not ANTHROPIC_CONNECTION_COMPATIBILITY.send_openai_extensions
    assert builtin_openai_connection().compatibility == ModelConnectionCompatibility()
    assert MODEL_CONNECTION_PRESETS[PRESET_OPENAI].compatibility == ModelConnectionCompatibility()


@pytest.mark.parametrize(
    "capabilities",
    [
        {"supported_reasoning_efforts": ["minimal"], "supports_tools": True},
        {"structured_output_transport": "json_object", "supports_tools": True},
    ],
)
@pytest.mark.asyncio
async def test_editing_an_anthropic_owner_model_keeps_the_messages_api_limits(
    async_session, tmp_path, owner_id, capabilities
) -> None:
    await _seed_builtins(async_session)
    app = _anthropic_app(async_session, tmp_path, owner_id)
    async with local_client(app) as client:
        created = await client.post(
            "/v1/model-connections/anthropic/models",
            json={"model": f"claude-haiku-5-5-{uuid4().hex[:8]}", "template_id": HAIKU_ID},
        )
        assert created.status_code == 201, created.text
        edited = await client.patch(f"/v1/model-providers/{created.json()['id']}", json={"capabilities": capabilities})

    assert edited.status_code == 400, edited.text
    assert edited.json()["detail"]["code"] == "invalid_capabilities"

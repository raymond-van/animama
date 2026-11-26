from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import Numeric, String, UniqueConstraint, delete, func, select, update

from animama.adapters.mappers.model_provider_map import model_provider_domain_to_public_catalog_row
from animama.adapters.repositories.sqlalchemy.model_provider_repo import SQLAlchemyModelProviderRepository
from animama.adapters.repositories.sqlalchemy.uow import SQLAlchemyUnitOfWork
from animama.app.model_catalog import (
    MODEL_CATALOG,
    RETIRED_BUILTIN_REPLACEMENTS,
    STRUCTURED_OUTPUT_TRANSPORT_JSON_SCHEMA,
    serialize_builtin_model_connections,
    serialize_model_catalog,
    serialize_model_provider_catalog,
    structured_output_transport,
)
from animama.app.services.model_provider_catalog_service import ModelCatalogPolicy, ModelProviderCatalogService
from animama.app.services.model_role_resolver import ROLE_EMBEDDINGS, ROLE_PREFERENCE_PATHS
from animama.domain import ModelProvider, ModelProviderCapabilities, ModelProviderPricing
from animama.domain.model_connection import BUILTIN_CHATGPT_PLAN_CONNECTION_ID
from animama.orm import ORMAnimaChatProfile, ORMChatMessage, ORMModelProvider
from animama.orm.base import Base

PRICE_COLUMNS = (
    "standard_input_price_per_million",
    "standard_cached_input_price_per_million",
    "standard_output_price_per_million",
    "batch_input_price_per_million",
    "batch_cached_input_price_per_million",
    "batch_output_price_per_million",
    "flex_input_price_per_million",
    "flex_cached_input_price_per_million",
    "flex_output_price_per_million",
    "priority_input_price_per_million",
    "priority_cached_input_price_per_million",
    "priority_output_price_per_million",
    "standard_long_context_input_price_per_million",
    "standard_long_context_cached_input_price_per_million",
    "standard_long_context_output_price_per_million",
    "batch_long_context_input_price_per_million",
    "batch_long_context_cached_input_price_per_million",
    "batch_long_context_output_price_per_million",
    "flex_long_context_input_price_per_million",
    "flex_long_context_cached_input_price_per_million",
    "flex_long_context_output_price_per_million",
    "priority_long_context_input_price_per_million",
    "priority_long_context_cached_input_price_per_million",
    "priority_long_context_output_price_per_million",
)
# Retired built-ins are chat rows, so only chat-model roles can name them.
CHAT_ROLE_PREFERENCE_PATHS = tuple(path for role, path in ROLE_PREFERENCE_PATHS.items() if role != ROLE_EMBEDDINGS)
SEED_SQL_PATH = Path("src/backend/migrations/seeds/01-seed-model-providers.sql")
SEED_COLUMNS = (
    "id",
    "model",
    "provider_type",
    "model_label",
    "provider_label",
    "logo_provider",
    "model_type",
    "current_snapshot",
    "context_window_tokens",
    "max_output_tokens",
    "connection_id",
    "source",
    "model_kind",
    "hidden",
    "early_compaction",
    "service_tiers_supported",
    "active",
    "deprecated_at",
    "accepts",
    "produces",
    "supports_developer_role",
    "supports_tools",
    "supports_streaming",
    "structured_kinds",
    "structured_output_transport",
    "supports_reasoning",
    "supported_reasoning_efforts",
    "native_tool_support",
    "pricing_status",
    "pricing_source_provider",
    "pricing_source_model",
    "pricing_source_url",
    "pricing_source_checked_at",
    "currency",
    "billing_unit",
    "standard_input_price_per_million",
    "standard_cached_input_price_per_million",
    "standard_output_price_per_million",
    "batch_input_price_per_million",
    "batch_cached_input_price_per_million",
    "batch_output_price_per_million",
    "flex_input_price_per_million",
    "flex_cached_input_price_per_million",
    "flex_output_price_per_million",
    "priority_input_price_per_million",
    "priority_cached_input_price_per_million",
    "priority_output_price_per_million",
    "long_context_token_threshold",
    "standard_long_context_input_price_per_million",
    "standard_long_context_cached_input_price_per_million",
    "standard_long_context_output_price_per_million",
    "batch_long_context_input_price_per_million",
    "batch_long_context_cached_input_price_per_million",
    "batch_long_context_output_price_per_million",
    "flex_long_context_input_price_per_million",
    "flex_long_context_cached_input_price_per_million",
    "flex_long_context_output_price_per_million",
    "priority_long_context_input_price_per_million",
    "priority_long_context_cached_input_price_per_million",
    "priority_long_context_output_price_per_million",
    "regional_processing_uplift_factor",
    "pricing_notes",
    "metadata",
)
CONNECTION_SEED_COLUMNS = (
    "id",
    "source",
    "name",
    "preset",
    "base_url",
    "credential_env",
    "compatibility",
    "timeout_seconds",
    "active",
)
SEED_JSONB_COLUMNS = {"compatibility"}
SEED_JSON_COLUMNS = {
    "service_tiers_supported",
    "accepts",
    "produces",
    "structured_kinds",
    "supported_reasoning_efforts",
    "native_tool_support",
    "pricing_notes",
    "metadata",
}


async def _clear_model_provider_rows(session) -> None:
    await session.execute(delete(ORMAnimaChatProfile))
    await session.execute(update(ORMChatMessage).values(model_provider=None, model=None))
    await session.execute(delete(ORMModelProvider))
    await session.commit()


async def _sync_registry_catalog(session) -> list[ModelProvider]:
    service = ModelProviderCatalogService(
        model_providers=SQLAlchemyModelProviderRepository(session),
        uow=SQLAlchemyUnitOfWork(session),
    )
    return await service.sync_from_registry()


def _sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _seed_sql_literal(value: Any, column: str) -> str:
    if value is None:
        return "NULL"
    if column in SEED_JSON_COLUMNS or column in SEED_JSONB_COLUMNS:
        cast = "::jsonb" if column in SEED_JSONB_COLUMNS else "::json"
        return _sql_quote(json.dumps(value, sort_keys=True, separators=(",", ":"))) + cast
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, Decimal):
        return format(value, "f")
    if hasattr(value, "isoformat"):
        return _sql_quote(value.isoformat())
    if isinstance(value, int):
        return str(value)
    return _sql_quote(str(value))


def _render_upsert(
    table: str,
    columns: tuple[str, ...],
    rows: list[dict[str, Any]],
    *,
    where: str,
    insert_only: frozenset[str] = frozenset(),
) -> str:
    column_sql = ",\n    ".join(columns)
    value_lines = []
    for row in rows:
        values = ", ".join(_seed_sql_literal(row.get(column), column) for column in columns)
        value_lines.append(f"    ({values})")
    set_lines = [
        f"    {column} = EXCLUDED.{column}" for column in columns if column != "id" and column not in insert_only
    ]
    set_lines.append("    updated_at = CURRENT_TIMESTAMP")
    return (
        f"INSERT INTO {table} (\n"
        f"    {column_sql}\n"
        ") VALUES\n"
        + ",\n".join(value_lines)
        + "\nON CONFLICT (id) DO UPDATE SET\n"
        + ",\n".join(set_lines)
        + f"\nWHERE {table}.{where};\n"
    )


def _render_seed_sql() -> str:
    provider_rows = serialize_model_provider_catalog()
    builtin_ids = ", ".join(_sql_quote(str(row["id"])) for row in provider_rows)
    return (
        "-- Seed the built-in model connections and their provider/model catalog rows after\n"
        "-- Alembic creates the tables. Only built-in rows are inserted, updated or retired;\n"
        "-- owner-added connections and models, and the owner's hidden and Compact early\n"
        "-- flags, are never changed. A newly inserted built-in Chat Completions chat row\n"
        "-- starts hidden.\n"
        "-- Generated from animama.app.model_catalog serializers by tests/test_model_provider_catalog.py.\n"
        + _render_upsert(
            "model_connections",
            CONNECTION_SEED_COLUMNS,
            serialize_builtin_model_connections(),
            where="source = 'builtin'",
        )
        + "\n"
        + _render_upsert(
            "model_providers",
            SEED_COLUMNS,
            provider_rows,
            where="source = 'builtin'",
            # A built-in row's ownership never changes after insertion, and its
            # hidden and Compact early flags are fresh-install defaults the
            # owner may change.
            insert_only=frozenset({"connection_id", "source", "hidden", "early_compaction"}),
        )
        + "\n-- Retire built-in rows that the current release no longer ships. The ChatGPT plan\n"
        + "-- connection's rows are listed from the signed-in account at run time, not shipped.\n"
        + "UPDATE model_providers SET\n"
        + "    active = FALSE,\n"
        + "    deprecated_at = COALESCE(deprecated_at, CURRENT_TIMESTAMP),\n"
        + "    updated_at = CURRENT_TIMESTAMP\n"
        + f"WHERE source = 'builtin' AND active AND connection_id <> '{BUILTIN_CHATGPT_PLAN_CONNECTION_ID}'\n"
        + f"    AND id NOT IN ({builtin_ids});\n"
        + _render_retired_builtin_remap()
    )


def _render_retired_builtin_remap() -> str:
    remap = ",\n".join(
        f"    ({_sql_quote(retired)}, {_sql_quote(replacement)})"
        for retired, replacement in sorted(RETIRED_BUILTIN_REPLACEMENTS.items())
    )
    remap_from = f"FROM (VALUES\n{remap}\n) AS remap(retired_id, replacement_id)\n"
    sql = (
        "\n-- Move Animas and the owner's chat-model roles off retired built-in rows onto the\n"
        "-- current built-in row on the same API, so existing installations keep chatting.\n"
        "UPDATE anima_chat_profiles AS profile SET\n"
        "    default_model_provider_id = remap.replacement_id,\n"
        # The saved effort belongs to the retired model; the new one starts at its default.
        "    reasoning_effort = NULL,\n"
        "    updated_at = CURRENT_TIMESTAMP\n"
        + remap_from
        + "WHERE profile.default_model_provider_id = remap.retired_id;\n"
    )
    for section, key in CHAT_ROLE_PREFERENCE_PATHS:
        path = "'{" + section + "," + key + "}'"
        sql += (
            "\nUPDATE user_settings AS settings SET\n"
            f"    preferences = jsonb_set(settings.preferences, {path}, to_jsonb(remap.replacement_id)),\n"
            "    updated_at = CURRENT_TIMESTAMP\n"
            + remap_from
            + f"WHERE settings.preferences #>> {path} = remap.retired_id;\n"
        )
    return sql


def _rows_by_id() -> dict[str, dict[str, object]]:
    return {str(row["id"]): row for row in serialize_model_provider_catalog()}


def _expected_provider_model_pairs() -> set[tuple[str, str]]:
    return {
        (str(provider), model) for model, entry in MODEL_CATALOG.items() for provider in (entry.get("providers") or {})
    }


def test_model_provider_catalog_has_one_row_per_registry_provider_model_pair() -> None:
    rows = serialize_model_provider_catalog()
    actual = {(str(row["provider_type"]), str(row["model"])) for row in rows}
    expected = _expected_provider_model_pairs()

    assert actual == expected
    assert len(rows) == len(expected)
    assert all(row["id"] == f"{row['provider_type']}:{row['model']}" for row in rows)


def test_built_in_chat_rows_are_gpt_6_luna_on_both_apis_haiku_and_embeddings() -> None:
    assert set(_rows_by_id()) == {
        "OpenAIHTTPAgent:gpt-6-luna",
        "OpenAIResponsesHTTPAgent:gpt-6-luna",
        "OpenAIHTTPAgent:text-embedding-3-small",
        "OpenAIHTTPAgent:text-embedding-3-large",
        "AnthropicMessagesHTTPAgent:claude-haiku-5-5",
    }


def test_each_built_in_row_belongs_to_its_api_family_connection() -> None:
    for row in serialize_model_provider_catalog():
        expected = "anthropic" if row["provider_type"] == "AnthropicMessagesHTTPAgent" else "openai"
        assert row["connection_id"] == expected, row["id"]
    for row in serialize_model_catalog():
        expected = "anthropic" if row["model_provider"] == "AnthropicMessagesHTTPAgent" else "openai"
        assert row["connection_id"] == expected, row["id"]
        assert row["connection_name"] == ("Anthropic" if expected == "anthropic" else "OpenAI")


@pytest.mark.parametrize("provider_type", ["OpenAIHTTPAgent", "OpenAIResponsesHTTPAgent"])
def test_gpt_6_luna_rows_price_only_the_known_standard_and_cached_rates(provider_type: str) -> None:
    row = _rows_by_id()[f"{provider_type}:gpt-6-luna"]

    assert row["pricing_status"] == "priced"
    assert row["current_snapshot"] == "gpt-6-luna"
    assert row["context_window_tokens"] == 1_050_000
    assert row["max_output_tokens"] == 128_000
    assert row["pricing_source_provider"] == "openai"
    assert row["pricing_source_model"] == "gpt-6-luna"
    assert row["pricing_source_checked_at"] == date(2026, 9, 28)
    assert row["currency"] == "USD"
    assert row["billing_unit"] == "1M_tokens"
    assert row["standard_input_price_per_million"] == Decimal("0.10")
    assert str(row["standard_input_price_per_million"]) == "0.10"
    assert row["standard_output_price_per_million"] == Decimal("0.50")
    assert row["standard_cached_input_price_per_million"] == Decimal("0.01")
    assert row["service_tiers_supported"] == ["standard"]
    assert row["long_context_token_threshold"] is None
    assert row["regional_processing_uplift_factor"] is None
    for column in PRICE_COLUMNS:
        # Unknown rates stay unknown: never zero.
        if column not in {
            "standard_input_price_per_million",
            "standard_cached_input_price_per_million",
            "standard_output_price_per_million",
        }:
            assert row[column] is None, column
    assert row["pricing_notes"]


def test_retired_built_ins_map_to_gpt_6_luna_on_the_same_api() -> None:
    current_ids = set(_rows_by_id())

    assert set(RETIRED_BUILTIN_REPLACEMENTS) == {
        "OpenAIResponsesHTTPAgent:gpt-5.6-luna",
        "OpenAIResponsesHTTPAgent:gpt-5.6-terra",
        "OpenAIResponsesHTTPAgent:gpt-5-nano",
        "OpenAIResponsesHTTPAgent:gpt-5.4-nano",
        "OpenAIHTTPAgent:gpt-5-nano",
        "OpenAIHTTPAgent:gpt-5.4-nano",
    }
    for retired, replacement in RETIRED_BUILTIN_REPLACEMENTS.items():
        assert retired not in current_ids
        assert replacement in current_ids
        assert retired.split(":", 1)[0] == replacement.split(":", 1)[0]


def test_public_model_catalog_serializer_does_not_expose_pricing() -> None:
    for row in serialize_model_catalog():
        assert "pricing_status" not in row
        assert "pricing_source_provider" not in row
        assert "standard_input_price_per_million" not in row
        assert "structured_output_transport" not in row
        assert "provider_type" not in row
        assert "model_provider" in row


def test_public_model_catalog_serializer_exposes_api_standard_fields() -> None:
    rows = {str(row["id"]): row for row in serialize_model_catalog()}

    assert rows
    for row in rows.values():
        assert "model_client" in row
        assert "api_standard" in row
        assert "supports_developer_role" in row

    chat_row = rows["OpenAIHTTPAgent:gpt-6-luna"]
    assert chat_row["model_client"] == "openai_chat_completions"
    assert chat_row["api_standard"] == "chat_completions"
    assert chat_row["supports_developer_role"] is True

    responses_row = rows["OpenAIResponsesHTTPAgent:gpt-6-luna"]
    assert responses_row["model_client"] == "openai_responses"
    assert responses_row["api_standard"] == "responses"
    assert responses_row["supports_developer_role"] is True

    for row in (chat_row, responses_row):
        assert row["context_window_tokens"] == 1_050_000
        assert row["accepts"] == ["image", "text"]
        assert row["supported_reasoning_efforts"] == ["none", "low", "medium", "high", "xhigh", "max"]
        # The frontend uses the first catalog effort as its explicit default.
        assert row["supported_reasoning_efforts"][0] == "none"


def test_internal_catalog_rows_include_structured_output_transport() -> None:
    rows = _rows_by_id()

    for provider_type in ("OpenAIHTTPAgent", "OpenAIResponsesHTTPAgent"):
        assert rows[f"{provider_type}:gpt-6-luna"]["structured_output_transport"] == (
            STRUCTURED_OUTPUT_TRANSPORT_JSON_SCHEMA
        )

    for row in rows.values():
        assert row["structured_output_transport"] == structured_output_transport(
            str(row["provider_type"]),
            str(row["model"]),
        )


EXPECTED_SEED_HIDDEN = {
    # Built-in Chat Completions chat rows start hidden; the OpenAI connection
    # chats through Responses by default (D10).
    "OpenAIHTTPAgent:gpt-6-luna": True,
    "OpenAIResponsesHTTPAgent:gpt-6-luna": False,
    "OpenAIHTTPAgent:text-embedding-3-small": False,
    "OpenAIHTTPAgent:text-embedding-3-large": False,
    "AnthropicMessagesHTTPAgent:claude-haiku-5-5": False,
}


def test_built_in_chat_completions_chat_rows_start_hidden() -> None:
    internal = {row_id: row["hidden"] for row_id, row in _rows_by_id().items()}
    public = {str(row["id"]): row["hidden"] for row in serialize_model_catalog()}

    assert internal == EXPECTED_SEED_HIDDEN
    assert public == EXPECTED_SEED_HIDDEN


def test_openai_native_web_search_and_apply_patch_are_responses_only() -> None:
    public_rows = {row["id"]: row for row in serialize_model_catalog()}
    provider_rows = _rows_by_id()

    assert "native_tool_support" not in public_rows["OpenAIHTTPAgent:gpt-6-luna"]
    assert provider_rows["OpenAIHTTPAgent:gpt-6-luna"]["native_tool_support"] is None
    responses_row = public_rows["OpenAIResponsesHTTPAgent:gpt-6-luna"]
    assert responses_row["native_tool_support"] == ["apply_patch", "web_search"]
    assert responses_row["requestable_native_tool_support"] == ["web_search"]
    assert provider_rows["OpenAIResponsesHTTPAgent:gpt-6-luna"]["native_tool_support"] == [
        "apply_patch",
        "web_search",
    ]
    assert "requestable_native_tool_support" not in provider_rows["OpenAIResponsesHTTPAgent:gpt-6-luna"]


@pytest.mark.asyncio
async def test_model_provider_catalog_sync_inserts_current_registry_rows(async_session) -> None:
    await _clear_model_provider_rows(async_session)

    stored = await _sync_registry_catalog(async_session)
    count = await async_session.scalar(select(func.count()).select_from(ORMModelProvider))

    assert len(stored) == len(serialize_model_provider_catalog())
    assert count == len(serialize_model_provider_catalog())


@pytest.mark.asyncio
async def test_model_provider_catalog_sync_is_idempotent_and_updates_existing_rows(async_session) -> None:
    await _clear_model_provider_rows(async_session)
    await _sync_registry_catalog(async_session)

    row = await async_session.get(ORMModelProvider, "OpenAIResponsesHTTPAgent:gpt-6-luna")
    assert row is not None
    row.model_label = "stale label"
    await async_session.commit()

    await _sync_registry_catalog(async_session)
    count = await async_session.scalar(select(func.count()).select_from(ORMModelProvider))
    refreshed = await async_session.get(ORMModelProvider, "OpenAIResponsesHTTPAgent:gpt-6-luna")

    assert count == len(serialize_model_provider_catalog())
    assert refreshed is not None
    assert refreshed.model_label == "gpt-6-luna"


@pytest.mark.asyncio
async def test_model_provider_catalog_sync_keeps_owner_hidden_built_ins_hidden(async_session) -> None:
    await _clear_model_provider_rows(async_session)
    await _sync_registry_catalog(async_session)
    row = await async_session.get(ORMModelProvider, "OpenAIResponsesHTTPAgent:gpt-6-luna")
    assert row is not None
    row.hidden = True
    await async_session.commit()

    await _sync_registry_catalog(async_session)
    async_session.expire_all()
    refreshed = await async_session.get(ORMModelProvider, "OpenAIResponsesHTTPAgent:gpt-6-luna")

    assert refreshed is not None
    assert refreshed.hidden is True


@pytest.mark.asyncio
async def test_model_provider_catalog_sync_inserts_default_hidden_flags_and_keeps_owner_changes(async_session) -> None:
    await _clear_model_provider_rows(async_session)
    await _sync_registry_catalog(async_session)
    async_session.expire_all()
    rows = (await async_session.execute(select(ORMModelProvider))).scalars()
    assert {row.id: row.hidden for row in rows} == EXPECTED_SEED_HIDDEN

    shown = await async_session.get(ORMModelProvider, "OpenAIHTTPAgent:gpt-6-luna")
    assert shown is not None
    shown.hidden = False
    await async_session.commit()
    await _sync_registry_catalog(async_session)
    async_session.expire_all()

    refreshed = await async_session.get(ORMModelProvider, "OpenAIHTTPAgent:gpt-6-luna")
    assert refreshed is not None and refreshed.hidden is False


@pytest.mark.asyncio
async def test_model_provider_catalog_sync_soft_retires_rows_missing_from_registry(async_session) -> None:
    await _clear_model_provider_rows(async_session)
    repo = SQLAlchemyModelProviderRepository(async_session)
    retired_id = "RetiredAgent:retired-model"
    owner_id = "owner:kept-model"
    capabilities = ModelProviderCapabilities(
        accepts=["text"],
        produces=["text"],
        supports_tools=False,
        supports_streaming=False,
    )
    await repo.upsert_many(
        [
            ModelProvider(
                id=retired_id,
                model="retired-model",
                provider_type="RetiredAgent",
                model_label="Retired model",
                provider_label="Retired",
                capabilities=capabilities,
            ),
            ModelProvider(
                id=owner_id,
                model="kept-model",
                provider_type="OpenAIHTTPAgent",
                model_label="Kept model",
                provider_label="OpenAI HTTP",
                source="owner",
                capabilities=capabilities,
            ),
        ]
    )
    await async_session.commit()

    await _sync_registry_catalog(async_session)
    retired = await async_session.get(ORMModelProvider, retired_id)
    kept = await async_session.get(ORMModelProvider, owner_id)

    assert retired is not None
    assert retired.active is False
    assert retired.deprecated_at is not None
    assert kept is not None
    assert kept.active is True


@pytest.mark.asyncio
async def test_synced_db_rows_retain_pricing_and_explicit_unpriced_values(async_session) -> None:
    await _clear_model_provider_rows(async_session)
    await _sync_registry_catalog(async_session)
    repo = SQLAlchemyModelProviderRepository(async_session)

    openai_chat = await repo.get("OpenAIHTTPAgent:gpt-6-luna")
    assert openai_chat is not None
    assert openai_chat.capabilities.supports_developer_role is True
    assert openai_chat.capabilities.structured_output_transport == STRUCTURED_OUTPUT_TRANSPORT_JSON_SCHEMA
    assert openai_chat.capabilities.native_tool_support is None

    openai_responses = await repo.get("OpenAIResponsesHTTPAgent:gpt-6-luna")
    assert openai_responses is not None
    assert openai_responses.capabilities.supports_developer_role is True
    assert openai_responses.capabilities.supports_tools is True
    assert openai_responses.capabilities.supports_streaming is True
    assert openai_responses.capabilities.structured_output_transport == STRUCTURED_OUTPUT_TRANSPORT_JSON_SCHEMA
    assert openai_responses.capabilities.supports_reasoning is True
    assert openai_responses.capabilities.supported_reasoning_efforts == [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ]
    assert openai_responses.capabilities.native_tool_support == ["apply_patch", "web_search"]
    assert openai_responses.pricing.pricing_status == "priced"
    assert openai_responses.pricing.pricing_source_provider == "openai"
    assert openai_responses.pricing.pricing_source_model == "gpt-6-luna"
    assert openai_responses.pricing.pricing_source_checked_at == date(2026, 9, 28)
    assert openai_responses.pricing.currency == "USD"
    assert openai_responses.pricing.billing_unit == "1M_tokens"
    assert openai_responses.pricing.service_tiers_supported == ["standard"]
    assert openai_responses.pricing.standard_input_price_per_million == Decimal("0.10")
    assert openai_responses.pricing.standard_cached_input_price_per_million == Decimal("0.01")
    assert openai_responses.pricing.standard_output_price_per_million == Decimal("0.50")
    assert openai_responses.pricing.batch_input_price_per_million is None
    assert openai_responses.pricing.priority_input_price_per_million is None
    assert openai_responses.pricing.regional_processing_uplift_factor is None

    for row in await repo.list_active():
        assert row.source == "builtin"
        assert row.connection is not None
        assert row.connection.id == row.connection_id
        assert row.connection.is_builtin
        assert row.connection.is_builtin_anthropic == (row.provider_type == "AnthropicMessagesHTTPAgent")


@pytest.mark.asyncio
async def test_public_db_catalog_matches_public_registry_shape_without_pricing(async_session) -> None:
    await _clear_model_provider_rows(async_session)
    await _sync_registry_catalog(async_session)
    service = ModelProviderCatalogService(model_providers=SQLAlchemyModelProviderRepository(async_session))

    # The local policy exposes every built-in row; the default hides Anthropic rows.
    db_rows = await service.list_public_catalog(ModelCatalogPolicy.local())

    assert db_rows == serialize_model_catalog()
    for row in db_rows:
        assert "pricing_status" not in row
        assert "pricing_source_provider" not in row
        assert "standard_input_price_per_million" not in row
        assert "structured_output_transport" not in row
        assert "provider_type" not in row
        assert "model_provider" in row
        assert "model_client" in row
        assert "api_standard" in row


def test_public_catalog_mapper_uses_model_provider_key_without_pricing() -> None:
    row = model_provider_domain_to_public_catalog_row(
        ModelProvider(
            id="Provider:model",
            model="model",
            provider_type="Provider",
            model_label="Model",
            provider_label="Provider",
            capabilities=ModelProviderCapabilities(
                accepts=["text"],
                produces=["text"],
                supports_tools=True,
                supports_streaming=True,
            ),
            pricing=ModelProviderPricing(standard_input_price_per_million=Decimal("1.23")),
        )
    )

    assert row["model_provider"] == "Provider"
    assert row["model_client"] is None
    assert row["api_standard"] is None
    assert "provider_type" not in row
    assert "standard_input_price_per_million" not in row
    assert "structured_output_transport" not in row


def test_public_catalog_mapper_computes_api_standard_from_provider_type() -> None:
    row = model_provider_domain_to_public_catalog_row(
        ModelProvider(
            id="OpenAIResponsesHTTPAgent:gpt-6-luna",
            model="gpt-6-luna",
            provider_type="OpenAIResponsesHTTPAgent",
            model_label="gpt-6-luna",
            provider_label="OpenAI Responses HTTP",
            capabilities=ModelProviderCapabilities(
                accepts=["text"],
                produces=["text"],
                supports_tools=True,
                supports_streaming=True,
            ),
        )
    )

    assert row["model_client"] == "openai_responses"
    assert row["api_standard"] == "responses"


def test_model_provider_catalog_entry_keeps_prices_out_of_top_level_fields() -> None:
    entry = ModelProvider(
        id="Provider:model",
        model="model",
        provider_type="Provider",
        model_label="Model",
        provider_label="Provider",
        pricing=ModelProviderPricing(standard_input_price_per_million=Decimal("1.23")),
    )

    assert not hasattr(entry, "standard_input_price_per_million")
    assert entry.pricing.standard_input_price_per_million == Decimal("1.23")


def test_model_provider_seed_sql_matches_registry_catalog() -> None:
    assert SEED_SQL_PATH.read_text(encoding="utf-8") == _render_seed_sql()


def test_model_provider_orm_metadata_is_registered() -> None:
    assert ORMModelProvider.__tablename__ == "model_providers"
    assert "model_providers" in Base.metadata.tables

    table = Base.metadata.tables["model_providers"]
    assert table.c.id.primary_key
    assert table.c.id.type.python_type is str
    assert table.c.deprecated_at.nullable
    assert "created_at" in table.c
    assert "updated_at" in table.c
    assert isinstance(table.c.structured_output_transport.type, String)
    assert not table.c.early_compaction.nullable
    assert str(getattr(table.c.early_compaction.server_default, "arg", None)) == "true"
    assert table.c.structured_output_transport.nullable
    assert not table.c.connection_id.nullable
    assert {fk.column.table.name for fk in table.c.connection_id.foreign_keys} == {"model_connections"}

    unique_constraints = [constraint for constraint in table.constraints if isinstance(constraint, UniqueConstraint)]
    assert any(
        {column.name for column in constraint.columns} == {"connection_id", "provider_type", "model", "source"}
        for constraint in unique_constraints
    )

    for column_name in PRICE_COLUMNS:
        column_type = table.c[column_name].type
        assert isinstance(column_type, Numeric)
        assert column_type.precision == 12
        assert column_type.scale == 6
        assert table.c[column_name].nullable

    regional_type = table.c.regional_processing_uplift_factor.type
    assert isinstance(regional_type, Numeric)
    assert regional_type.precision == 12
    assert regional_type.scale == 6
    assert table.c.regional_processing_uplift_factor.nullable


async def _apply_seed_sql(session) -> None:
    connection = await session.connection()
    raw = await connection.get_raw_connection()
    await raw.driver_connection.execute(SEED_SQL_PATH.read_text(encoding="utf-8"))


@pytest.mark.asyncio
async def test_seed_rerun_keeps_owner_rows_and_hidden_flags_and_retires_missing_builtins(async_session) -> None:
    from animama.orm import ORMModelConnection

    await _clear_model_provider_rows(async_session)
    await async_session.execute(delete(ORMModelConnection).where(ORMModelConnection.source == "owner"))
    await async_session.commit()
    await _apply_seed_sql(async_session)
    await async_session.commit()

    async_session.add(ORMModelConnection(id="seed-conn-ollama", source="owner", name="Ollama", preset="ollama"))
    async_session.add(ORMModelConnection(id="seed-conn-lmstudio", source="owner", name="LM Studio", preset="lmstudio"))
    common = {
        "provider_type": "OpenAIHTTPAgent",
        "provider_label": "Local",
        "source": "owner",
        "accepts": ["text"],
        "produces": ["text"],
        "supports_streaming": True,
        "structured_kinds": [],
        "service_tiers_supported": [],
        "pricing_notes": [],
        "metadata_": {},
    }
    for connection_id in ("seed-conn-ollama", "seed-conn-lmstudio"):
        async_session.add(
            ORMModelProvider(
                id=f"owner:{connection_id}",
                model="qwen3:8b",
                model_label="qwen3:8b",
                connection_id=connection_id,
                **common,
            )
        )
    # An owner row that later collides with a built-in on the same connection.
    async_session.add(
        ORMModelProvider(
            id="owner:openai-gpt-6-luna",
            model="gpt-6-luna",
            model_label="my luna",
            connection_id="openai",
            **common,
        )
    )
    retired = ORMModelProvider(
        id="OpenAIHTTPAgent:gpt-retired",
        model="gpt-retired",
        model_label="gpt-retired",
        **{**common, "source": "builtin"},
    )
    async_session.add(retired)
    # Listed from the signed-in ChatGPT account at run time; the seed must not retire it.
    async_session.add(
        ORMModelProvider(
            id="ChatGPTPlanResponsesHTTPAgent:gpt-6-luna",
            model="gpt-6-luna",
            model_label="GPT-6-Luna",
            connection_id=BUILTIN_CHATGPT_PLAN_CONNECTION_ID,
            **{**common, "provider_type": "ChatGPTPlanResponsesHTTPAgent", "source": "builtin"},
        )
    )
    hidden = await async_session.get(ORMModelProvider, "OpenAIResponsesHTTPAgent:gpt-6-luna")
    assert hidden is not None
    hidden.hidden = True
    await async_session.commit()

    await _apply_seed_sql(async_session)
    await async_session.commit()
    async_session.expire_all()

    owner_rows = (
        await async_session.execute(select(ORMModelProvider).where(ORMModelProvider.source == "owner"))
    ).scalars()
    assert {(row.id, row.model_label, row.active) for row in owner_rows} == {
        ("owner:seed-conn-ollama", "qwen3:8b", True),
        ("owner:seed-conn-lmstudio", "qwen3:8b", True),
        ("owner:openai-gpt-6-luna", "my luna", True),
    }
    hidden_luna = await async_session.get(ORMModelProvider, "OpenAIResponsesHTTPAgent:gpt-6-luna")
    assert hidden_luna is not None and hidden_luna.hidden is True and hidden_luna.active is True
    retired_row = await async_session.get(ORMModelProvider, "OpenAIHTTPAgent:gpt-retired")
    assert retired_row is not None and retired_row.active is False and retired_row.deprecated_at is not None
    builtin_luna = await async_session.get(ORMModelProvider, "OpenAIHTTPAgent:gpt-6-luna")
    assert builtin_luna is not None and builtin_luna.active is True
    plan_row = await async_session.get(ORMModelProvider, "ChatGPTPlanResponsesHTTPAgent:gpt-6-luna")
    assert plan_row is not None and plan_row.active is True and plan_row.deprecated_at is None


@pytest.mark.asyncio
async def test_seed_inserts_hidden_chat_completions_rows_and_never_changes_existing_flags(async_session) -> None:
    await _clear_model_provider_rows(async_session)
    await _apply_seed_sql(async_session)
    await async_session.commit()
    async_session.expire_all()
    rows = (await async_session.execute(select(ORMModelProvider))).scalars()
    assert {row.id: row.hidden for row in rows} == EXPECTED_SEED_HIDDEN

    # An existing installation (or an owner who showed the row) keeps its flag.
    shown = await async_session.get(ORMModelProvider, "OpenAIHTTPAgent:gpt-6-luna")
    assert shown is not None
    shown.hidden = False
    await async_session.commit()
    await _apply_seed_sql(async_session)
    await async_session.commit()
    async_session.expire_all()

    refreshed = await async_session.get(ORMModelProvider, "OpenAIHTTPAgent:gpt-6-luna")
    assert refreshed is not None and refreshed.hidden is False


@pytest.mark.asyncio
async def test_seed_moves_animas_and_chat_roles_off_retired_built_ins(async_session) -> None:
    from uuid import uuid4

    from animama.orm import ORMAnima
    from animama.orm.settings import ORMUserSettings

    await _clear_model_provider_rows(async_session)
    await _apply_seed_sql(async_session)
    await async_session.commit()

    owner_id = f"owner-{uuid4().hex[:8]}"
    common = {
        "accepts": ["text"],
        "produces": ["text"],
        "supports_streaming": True,
        "structured_kinds": [],
        "service_tiers_supported": [],
        "pricing_notes": [],
        "metadata_": {},
        "connection_id": "openai",
    }
    # Rows an earlier release shipped; the next seed retires them.
    for provider_type, model in (("OpenAIResponsesHTTPAgent", "gpt-5.6-luna"), ("OpenAIHTTPAgent", "gpt-5-nano")):
        async_session.add(
            ORMModelProvider(
                id=f"{provider_type}:{model}",
                model=model,
                model_label=model,
                provider_type=provider_type,
                provider_label="OpenAI",
                source="builtin",
                **common,
            )
        )
    owner_row_id = f"owner:{uuid4().hex[:8]}"
    async_session.add(
        ORMModelProvider(
            id=owner_row_id,
            model="gpt-5-nano",
            model_label="my nano",
            provider_type="OpenAIHTTPAgent",
            provider_label="OpenAI",
            source="owner",
            **common,
        )
    )
    await async_session.flush()
    suffix = uuid4().hex[:8]
    profiles = {
        f"anima-responses-{suffix}": "OpenAIResponsesHTTPAgent:gpt-5.6-luna",
        f"anima-chat-{suffix}": "OpenAIHTTPAgent:gpt-5-nano",
        f"anima-owner-{suffix}": owner_row_id,
    }
    for anima_id, model_provider_id in profiles.items():
        async_session.add(ORMAnima(id=anima_id, user_id=owner_id, display_name=anima_id))
        await async_session.flush()
        async_session.add(
            ORMAnimaChatProfile(anima_id=anima_id, default_model_provider_id=model_provider_id, metadata_={"k": 1})
        )
    async_session.add(
        ORMUserSettings(
            user_id=owner_id,
            preferences={
                "chat": {"default_model_provider_id": "OpenAIHTTPAgent:gpt-5.4-nano", "keep": True},
                "models": {
                    "utility_model_provider_id": "OpenAIResponsesHTTPAgent:gpt-5.6-terra",
                    "memory_manager_model_provider_id": owner_row_id,
                    "embedding_model_provider_id": "OpenAIHTTPAgent:text-embedding-3-small",
                },
                "voice": {"enabled": True},
            },
        )
    )
    await async_session.commit()

    for _ in range(2):  # The seed runs on every startup.
        await _apply_seed_sql(async_session)
        await async_session.commit()
    async_session.expire_all()

    moved = {
        anima_id: (await async_session.get(ORMAnimaChatProfile, anima_id)).default_model_provider_id
        for anima_id in profiles
    }
    assert list(moved.values()) == [
        "OpenAIResponsesHTTPAgent:gpt-6-luna",
        "OpenAIHTTPAgent:gpt-6-luna",
        owner_row_id,
    ]
    first_profile = await async_session.get(ORMAnimaChatProfile, next(iter(profiles)))
    assert first_profile.metadata_ == {"k": 1}
    settings = await async_session.get(ORMUserSettings, owner_id)
    assert settings.preferences == {
        "chat": {"default_model_provider_id": "OpenAIHTTPAgent:gpt-6-luna", "keep": True},
        "models": {
            "utility_model_provider_id": "OpenAIResponsesHTTPAgent:gpt-6-luna",
            "memory_manager_model_provider_id": owner_row_id,
            "embedding_model_provider_id": "OpenAIHTTPAgent:text-embedding-3-small",
        },
        "voice": {"enabled": True},
    }
    owner_row = await async_session.get(ORMModelProvider, owner_row_id)
    assert owner_row.model == "gpt-5-nano" and owner_row.active is True
    for retired_id in ("OpenAIResponsesHTTPAgent:gpt-5.6-luna", "OpenAIHTTPAgent:gpt-5-nano"):
        retired = await async_session.get(ORMModelProvider, retired_id)
        assert retired.active is False

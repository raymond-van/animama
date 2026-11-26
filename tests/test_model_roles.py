"""Model roles: resolution, fallbacks and the local ``/v1/model-roles`` report (spec R4, R2)."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI
from sqlalchemy import delete

from animama.adapters.repositories.sqlalchemy.model_provider_repo import SQLAlchemyModelProviderRepository
from animama.adapters.repositories.sqlalchemy.uow import SQLAlchemyUnitOfWork
from animama.app.model_clients import (
    ModelClientDelta,
    ModelClientFinal,
    ModelClientRequest,
    StaticModelClientRegistry,
)
from animama.app.services.direct_model_prompt_runner import DirectModelPromptRequest, DirectModelPromptRunner
from animama.app.services.model_provider_catalog_service import ModelCatalogPolicy, ModelProviderCatalogService
from animama.app.services.model_role_resolver import (
    ROLE_CHAT,
    ROLE_EMBEDDINGS,
    ROLE_MEMORY_MANAGER,
    ROLE_PREFERENCE_PATHS,
    ROLE_SOURCE_DEFAULT,
    ROLE_SOURCE_INHERITED,
    ROLE_SOURCE_OFF,
    ROLE_SOURCE_OWNER,
    ROLE_UTILITY,
    ModelRoleDefaults,
    ModelRoleResolver,
    usable_for_role,
)
from animama.domain import ModelConnection, ModelProvider, ModelProviderCapabilities
from animama.domain.model_connection import MODEL_KIND_CHAT, MODEL_KIND_EMBEDDING
from animama.domain.request_principal import RequestPrincipal
from animama.domain.settings import UserSettings
from animama.domain.usage import Usage
from animama.orm.settings import ORMUserSettings
from animama.orm.user_file import ORMUserFile
from animama.orm.user_file_chunk import ORMUserFileChunk
from animama.product_http.routes import model_catalog
from animama.server.app import create_local_app
from animama.server.config import Settings
from animama.server.deps import get_async_session, get_current_principal
from animama.server.model_roles import ModelRoleSettings
from animama.server.routers import model_configuration
from tests.local_http_client import local_client
from tests.product_http_support import install_local_ports

CHAT = "OpenAIResponsesHTTPAgent:gpt-6-luna"


def _row(
    row_id: str,
    *,
    kind: str = MODEL_KIND_CHAT,
    tools: bool = True,
    streaming: bool = True,
    active: bool = True,
    connection_active: bool = True,
) -> ModelProvider:
    return ModelProvider(
        id=row_id,
        provider_type="OpenAIHTTPAgent",
        model=row_id,
        model_label=row_id,
        provider_label="Local",
        active=active,
        model_kind=kind,
        capabilities=ModelProviderCapabilities(supports_tools=tools, supports_streaming=streaming),
        connection=ModelConnection(id="conn", name="Ollama", preset="ollama", active=connection_active),
    )


class _Rows:
    def __init__(self, *rows: ModelProvider) -> None:
        self._rows = {row.id: row for row in rows}

    async def get(self, model_provider_id: str) -> ModelProvider | None:
        return self._rows.get(model_provider_id)


class _Preferences:
    def __init__(self, preferences: dict[str, Any] | None = None) -> None:
        self._preferences = preferences

    async def get(self, user_id: str) -> UserSettings | None:
        if self._preferences is None:
            return None
        return UserSettings(user_id=user_id, preferences=self._preferences)


def _resolver(
    *rows: ModelProvider,
    preferences: dict[str, Any] | None = None,
    defaults: ModelRoleDefaults | None = None,
    owner_roles_enabled: bool = True,
) -> ModelRoleResolver:
    return ModelRoleResolver(
        model_providers=_Rows(*rows),  # type: ignore[arg-type]
        user_settings=_Preferences(preferences),  # type: ignore[arg-type]
        defaults=defaults or ModelRoleDefaults(chat=CHAT),
        owner_roles_enabled=owner_roles_enabled,
    )


async def test_unassigned_roles_inherit_the_chat_default_and_embeddings_stay_off():
    resolver = _resolver(_row(CHAT))

    chat = await resolver.resolve("owner", ROLE_CHAT)
    utility = await resolver.resolve("owner", ROLE_UTILITY)
    manager = await resolver.resolve("owner", ROLE_MEMORY_MANAGER)
    embeddings = await resolver.resolve("owner", ROLE_EMBEDDINGS)

    assert (chat.model_provider.id, chat.source) == (CHAT, ROLE_SOURCE_DEFAULT)  # type: ignore[union-attr]
    assert (utility.model_provider.id, utility.source) == (CHAT, ROLE_SOURCE_INHERITED)  # type: ignore[union-attr]
    assert (manager.model_provider.id, manager.source) == (CHAT, ROLE_SOURCE_INHERITED)  # type: ignore[union-attr]
    assert (embeddings.model_provider, embeddings.source) == (None, ROLE_SOURCE_OFF)


async def test_owner_assignments_take_precedence_over_defaults():
    preferences = {
        "chat": {"default_model_provider_id": "owner:chat"},
        "models": {
            "utility_model_provider_id": "owner:small",
            "memory_manager_model_provider_id": "owner:tools",
            "embedding_model_provider_id": "owner:embed",
        },
    }
    resolver = _resolver(
        _row(CHAT),
        _row("owner:chat"),
        _row("owner:small", tools=False),
        _row("owner:tools"),
        _row("owner:embed", kind=MODEL_KIND_EMBEDDING, streaming=False, tools=False),
        preferences=preferences,
    )

    roles = (ROLE_CHAT, ROLE_UTILITY, ROLE_MEMORY_MANAGER, ROLE_EMBEDDINGS)
    resolved = {role: await resolver.resolve("owner", role) for role in roles}

    assert {role: value.model_provider.id for role, value in resolved.items()} == {  # type: ignore[union-attr]
        ROLE_CHAT: "owner:chat",
        ROLE_UTILITY: "owner:small",
        ROLE_MEMORY_MANAGER: "owner:tools",
        ROLE_EMBEDDINGS: "owner:embed",
    }
    assert {value.source for value in resolved.values()} == {ROLE_SOURCE_OWNER}


@pytest.mark.parametrize(
    ("role", "assigned", "expected_id", "expected_source"),
    [
        # Removed rows and rows on a removed connection fall back.
        (ROLE_UTILITY, _row("owner:gone", active=False), CHAT, ROLE_SOURCE_INHERITED),
        (ROLE_UTILITY, _row("owner:gone", connection_active=False), CHAT, ROLE_SOURCE_INHERITED),
        # Utility needs a streaming chat model.
        (ROLE_UTILITY, _row("owner:gone", streaming=False), CHAT, ROLE_SOURCE_INHERITED),
        (ROLE_UTILITY, _row("owner:gone", kind=MODEL_KIND_EMBEDDING), CHAT, ROLE_SOURCE_INHERITED),
        # The Memory Manager needs tool calling.
        (ROLE_MEMORY_MANAGER, _row("owner:gone", tools=False), CHAT, ROLE_SOURCE_INHERITED),
        # Embeddings need an embedding model; there is no default to fall back to.
        (ROLE_EMBEDDINGS, _row("owner:gone"), None, ROLE_SOURCE_OFF),
    ],
)
async def test_unusable_assignments_fall_back_and_report_the_lost_choice(role, assigned, expected_id, expected_source):
    path = {
        ROLE_UTILITY: "utility_model_provider_id",
        ROLE_MEMORY_MANAGER: "memory_manager_model_provider_id",
        ROLE_EMBEDDINGS: "embedding_model_provider_id",
    }[role]
    resolver = _resolver(_row(CHAT), assigned, preferences={"models": {path: assigned.id}})

    resolved = await resolver.resolve("owner", role)

    assert (resolved.model_provider.id if resolved.model_provider else None) == expected_id
    assert resolved.source == expected_source
    assert resolved.requested_id == assigned.id
    assert resolved.assignment_available is False


PLAN = "ChatGPTPlanResponsesHTTPAgent:gpt-6-luna"


def _plan_row(*, active: bool) -> ModelProvider:
    return ModelProvider(
        id=PLAN,
        provider_type="ChatGPTPlanResponsesHTTPAgent",
        model="gpt-6-luna",
        model_label="GPT-6 Luna",
        provider_label="ChatGPT plan",
        connection_id="chatgpt_plan",
        source="builtin",
        active=active,
        context_window_tokens=272_000,
        capabilities=ModelProviderCapabilities(supports_tools=True, supports_streaming=True),
        connection=ModelConnection(id="chatgpt_plan", name="ChatGPT plan", preset="chatgpt_plan", source="builtin"),
    )


@pytest.mark.parametrize("role", [ROLE_CHAT, ROLE_UTILITY, ROLE_MEMORY_MANAGER])
async def test_a_plan_model_no_longer_available_waits_rather_than_moving_to_another_connection(role):
    """Signing out, or OpenAI no longer listing the model, retires the row; the job waits (spec R5.2, D6)."""

    section, key = ROLE_PREFERENCE_PATHS[role]
    resolver = _resolver(_row(CHAT), _plan_row(active=False), preferences={section: {key: PLAN}})

    resolved = await resolver.resolve("owner", role)

    assert (resolved.model_provider, resolved.source) == (None, ROLE_SOURCE_OFF)
    assert (resolved.requested_id, resolved.assignment_available) == (PLAN, False)


@pytest.mark.parametrize(
    ("role", "suits"),
    [(ROLE_CHAT, True), (ROLE_UTILITY, True), (ROLE_MEMORY_MANAGER, True), (ROLE_EMBEDDINGS, False)],
)
def test_a_plan_model_suits_every_role_but_embeddings(role, suits):
    """Spec #919 R3.2."""

    assert usable_for_role(role, _plan_row(active=True)) is suits


async def test_roles_inheriting_a_waiting_plan_chat_model_wait_too():
    resolver = _resolver(_row(CHAT), _plan_row(active=False), preferences={"chat": {"default_model_provider_id": PLAN}})

    utility = await resolver.resolve("owner", ROLE_UTILITY)
    manager = await resolver.resolve("owner", ROLE_MEMORY_MANAGER)

    assert utility.model_provider is None and manager.model_provider is None
    # Settings say they wait for the chosen model, not that no model can do the job (P5-R2-F1).
    assert (utility.source, utility.assignment_available) == (ROLE_SOURCE_OFF, False)
    assert (manager.source, manager.assignment_available) == (ROLE_SOURCE_OFF, False)
    # While the plan model is listed, the roles use it.
    usable = _resolver(_row(CHAT), _plan_row(active=True), preferences={"chat": {"default_model_provider_id": PLAN}})
    assert (await usable.resolve("owner", ROLE_UTILITY)).model_provider.id == PLAN  # type: ignore[union-attr]


async def test_operator_defaults_apply_before_inheritance_and_unusable_ones_are_skipped():
    defaults = ModelRoleDefaults(chat=CHAT, utility="default:small", memory_manager="default:no-tools")
    resolver = _resolver(_row(CHAT), _row("default:small"), _row("default:no-tools", tools=False), defaults=defaults)

    utility = await resolver.resolve("owner", ROLE_UTILITY)
    manager = await resolver.resolve("owner", ROLE_MEMORY_MANAGER)

    assert (utility.model_provider.id, utility.source) == ("default:small", ROLE_SOURCE_DEFAULT)  # type: ignore[union-attr]
    assert (manager.model_provider.id, manager.source) == (CHAT, ROLE_SOURCE_INHERITED)  # type: ignore[union-attr]


async def test_memory_manager_is_off_when_the_chat_model_cannot_call_tools():
    resolver = _resolver(_row(CHAT, tools=False))

    manager = await resolver.resolve("owner", ROLE_MEMORY_MANAGER)

    assert (manager.model_provider, manager.source) == (None, ROLE_SOURCE_OFF)


async def test_compositions_without_owner_roles_use_only_operator_defaults():
    resolver = _resolver(
        _row(CHAT),
        _row("owner:small"),
        preferences={"models": {"utility_model_provider_id": "owner:small"}},
        owner_roles_enabled=False,
    )

    utility = await resolver.resolve("owner", ROLE_UTILITY)

    assert (utility.model_provider.id, utility.source) == (CHAT, ROLE_SOURCE_INHERITED)  # type: ignore[union-attr]
    assert utility.assignment_available is True


def _app(session, tmp_path, owner_id: str) -> FastAPI:
    app = FastAPI()
    app.state.runtime_settings = Settings(
        animama_content_root=tmp_path / "content",
        animama_data_root=tmp_path / "data",
    )
    app.state.local_runtime_paths = SimpleNamespace(included_sources=(), operations_root=tmp_path / "operations")
    app.state.model_catalog_policy = ModelCatalogPolicy(owner_models_enabled=True)
    app.include_router(model_configuration.router)
    app.include_router(model_catalog.router)

    async def principal():
        return RequestPrincipal(id=owner_id)

    async def database():
        yield session

    app.dependency_overrides[get_current_principal] = principal
    app.dependency_overrides[get_async_session] = database
    install_local_ports(app, session)
    return app


@pytest.fixture
def owner_id() -> str:
    return f"owner-{uuid4().hex[:8]}"


async def _set_preferences(session, owner_id: str, preferences: dict[str, Any]) -> None:
    await session.execute(delete(ORMUserSettings).where(ORMUserSettings.user_id == owner_id))
    session.add(ORMUserSettings(user_id=owner_id, preferences=preferences))
    await session.commit()


async def test_model_roles_report_the_effective_rows_and_embedding_progress(async_session, tmp_path, owner_id):
    await ModelProviderCatalogService(
        model_providers=SQLAlchemyModelProviderRepository(async_session),
        uow=SQLAlchemyUnitOfWork(async_session),
    ).sync_from_registry()
    app = _app(async_session, tmp_path, owner_id)
    file_id = f"file-{uuid4().hex[:8]}"
    async with local_client(app) as client:
        connection = (
            await client.post(
                "/v1/model-connections",
                json={"name": "Ollama", "preset": "ollama", "base_url": "http://127.0.0.1:11434/v1"},
            )
        ).json()
        embed = (
            await client.post(
                f"/v1/model-connections/{connection['id']}/models",
                json={"model": "nomic-embed-text", "kind": "embedding"},
            )
        ).json()
        off = (await client.get("/v1/model-roles")).json()

        await _set_preferences(async_session, owner_id, {"models": {"embedding_model_provider_id": embed["id"]}})
        async_session.add(
            ORMUserFile(
                id=file_id,
                user_id=owner_id,
                storage_locator=f"users/{owner_id}/files/{file_id}/original.txt",
                original_filename="notes.txt",
                normalized_extension=".txt",
                declared_size_bytes=5,
                status="ready",
                upload_expires_at=datetime.now(UTC),
                metadata_={},
            )
        )
        await async_session.flush()
        async_session.add(
            ORMUserFileChunk(
                id=f"chunk-{file_id}-000000",
                file_id=file_id,
                user_id=owner_id,
                chunk_index=0,
                text="notes",
                embedding=[1.0, 0.0],
                embedding_model_id="OpenAIHTTPAgent:text-embedding-3-small",
                char_count=5,
                token_estimate=1,
                metadata_={},
            )
        )
        await async_session.commit()
        pending = (await client.get("/v1/model-roles")).json()

        removed = await client.delete(f"/v1/model-providers/{embed['id']}", params={"confirm": "true"})
        after_removal = (await client.get("/v1/model-roles")).json()

    roles = {role["role"]: role for role in off["roles"]}
    assert roles["embeddings"]["source"] == "off"
    assert roles["utility"]["source"] == "inherited"
    assert off["embeddings_refresh"] == {"state": "off", "pending": 0, "error_category": None}

    embeddings = next(role for role in pending["roles"] if role["role"] == "embeddings")
    assert embeddings["source"] == "owner"
    assert embeddings["model_provider_id"] == embed["id"]
    assert embeddings["connection_name"] == "Ollama"
    assert pending["embeddings_refresh"] == {"state": "re_embedding", "pending": 1, "error_category": None}

    assert removed.json()["usage"]["roles"] == ["models.embedding_model_provider_id"]
    assert after_removal["embeddings_refresh"]["state"] == "off"
    embeddings_after = next(role for role in after_removal["roles"] if role["role"] == "embeddings")
    # Removal clears the assignment, so nothing is reported as lost.
    assert embeddings_after["requested_model_provider_id"] is None
    assert embeddings_after["assignment_available"] is True


class _CapturingClient:
    def __init__(self) -> None:
        self.requests: list[ModelClientRequest] = []

    async def aclose(self) -> None:
        pass

    async def stream(self, request: ModelClientRequest):
        self.requests.append(request)
        yield ModelClientDelta(kind="final", final=ModelClientFinal(text="A title", usage=Usage()))


def _prompt_request(**options: Any) -> DirectModelPromptRequest:
    return DirectModelPromptRequest(
        anima_id="anima",
        user_id="owner",
        chat_id="chat",
        prompt="Name this chat",
        task="chat_title",
        request_options=options,
    )


@pytest.mark.parametrize(
    ("supports_reasoning", "efforts", "expected"),
    [(True, ["none", "low"], "low"), (True, ["none"], None), (False, None, None)],
)
async def test_utility_prompts_send_reasoning_effort_only_when_the_row_supports_it(
    supports_reasoning, efforts, expected
):
    row = _row("owner:small")
    row.capabilities.supports_reasoning = supports_reasoning
    row.capabilities.supported_reasoning_efforts = efforts
    client = _CapturingClient()
    registry = StaticModelClientRegistry()
    registry.register("OpenAIHTTPAgent", client)
    runner = DirectModelPromptRunner(
        registry=registry,
        role_resolver=_resolver(_row(CHAT), row, preferences={"models": {"utility_model_provider_id": row.id}}),
    )

    result = await runner.run_prompt(_prompt_request(reasoning_effort="low"))

    assert result.model_provider.id == "owner:small"
    assert client.requests[0].model_provider.id == "owner:small"
    assert client.requests[0].prompt.reasoning_effort == expected


async def test_utility_prompts_fail_clearly_when_no_model_is_available():
    runner = DirectModelPromptRunner(
        registry=StaticModelClientRegistry(), role_resolver=_resolver(defaults=ModelRoleDefaults(chat="missing"))
    )

    with pytest.raises(ValueError, match="No model is available for the utility role"):
        await runner.run_prompt(_prompt_request())


async def test_memory_manager_needs_tools_but_not_streaming_and_owner_chat_rows_need_a_window_for_chat_and_utility():
    no_window = _row("owner:no-window")
    no_window.source = "owner"
    no_window.context_window_tokens = None
    batch_only = _row("owner:batch", streaming=False)
    resolver = _resolver(
        _row(CHAT),
        no_window,
        batch_only,
        preferences={
            "chat": {"default_model_provider_id": "owner:no-window"},
            "models": {
                "memory_manager_model_provider_id": "owner:batch",
                "utility_model_provider_id": "owner:no-window",
            },
        },
    )

    chat = await resolver.resolve("owner", ROLE_CHAT)
    manager = await resolver.resolve("owner", ROLE_MEMORY_MANAGER)
    utility = await resolver.resolve("owner", ROLE_UTILITY)

    assert (chat.model_provider.id, chat.assignment_available) == (CHAT, False)  # type: ignore[union-attr]
    assert (manager.model_provider.id, manager.source) == ("owner:batch", ROLE_SOURCE_OWNER)  # type: ignore[union-attr]
    assert (utility.model_provider.id, utility.assignment_available) == (CHAT, False)  # type: ignore[union-attr]


def test_only_compositions_that_enable_owner_models_apply_role_preferences():
    hosted = FastAPI()
    local = FastAPI()
    local.state.model_catalog_policy = ModelCatalogPolicy(owner_models_enabled=True)

    assert ModelRoleSettings.for_app(hosted).owner_roles_enabled is False
    assert ModelRoleSettings.for_app(local).owner_roles_enabled is True
    assert create_local_app().state.model_catalog_policy.owner_models_enabled is True


def test_operator_defaults_naming_a_retired_built_in_use_its_replacement() -> None:
    """An older `.env` may still pin a retired row; creation and roles need the current one."""

    configured = Settings(
        anima_default_model_provider_id="OpenAIResponsesHTTPAgent:gpt-5.6-luna",
        anima_default_utility_model_provider_id="OpenAIHTTPAgent:gpt-5-nano",
        anima_default_memory_manager_model_provider_id="owner:kept",
        anima_default_embedding_model_provider_id="OpenAIHTTPAgent:text-embedding-3-small",
    )

    assert configured.anima_default_model_provider_id == "OpenAIResponsesHTTPAgent:gpt-6-luna"
    assert configured.anima_default_utility_model_provider_id == "OpenAIHTTPAgent:gpt-6-luna"
    assert configured.anima_default_memory_manager_model_provider_id == "owner:kept"
    assert configured.anima_default_embedding_model_provider_id == "OpenAIHTTPAgent:text-embedding-3-small"

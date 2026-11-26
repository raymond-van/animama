"""Owner model configuration routes (spec R1, R2, R3, R8)."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute
from sqlalchemy import delete

from animama.adapters.repositories.sqlalchemy.model_provider_repo import SQLAlchemyModelProviderRepository
from animama.adapters.repositories.sqlalchemy.uow import SQLAlchemyUnitOfWork
from animama.app.model_clients.probe import ModelConnectionProbeError, ModelProbeReport, ModelProbeStep
from animama.app.services.model_provider_catalog_service import ModelCatalogPolicy, ModelProviderCatalogService
from animama.domain.chatgpt_plan import ChatGPTPlanUnavailableError
from animama.domain.request_principal import RequestPrincipal
from animama.orm import ORMAnima, ORMAnimaChatProfile, ORMModelProvider
from animama.orm.settings import ORMUserSettings
from animama.product_http.routes import model_catalog
from animama.server.config import Settings
from animama.server.deps import get_async_session, get_current_principal
from animama.server.routers import model_configuration, router as shared_router
from animama.server.routers.model_configuration import get_model_connection_probe
from tests.local_http_client import local_client
from tests.product_http_support import install_local_ports
from tests.route_support import served_routes


class _FakeProbe:
    def __init__(self, *, fail: bool = False, fail_category: str = "unreachable") -> None:
        self.fail = fail
        self.fail_category = fail_category
        self.calls: list[tuple[str, str, str]] = []
        self.listed: list[Any] = []

    async def list_models(self, connection):
        self.listed.append(connection)
        if self.fail:
            raise ModelConnectionProbeError("Probe failed", category=self.fail_category)
        return ["qwen3:8b", "gemma4:e4b"]

    async def probe_chat_model(self, connection, *, model):
        self.calls.append(("chat", connection.id, model))
        return ModelProbeReport(
            model=model,
            steps=(ModelProbeStep(name="streaming", ok=True), ModelProbeStep(name="tool_calls", ok=False)),
            supports_streaming=True,
            structured_output_transport="json_schema",
            supports_tools=False,
            context_window_tokens=8192,
        )

    async def probe_responses_model(self, connection, *, model):
        self.calls.append(("responses", connection.id, model))
        return ModelProbeReport(model=model, steps=(ModelProbeStep(name="available", ok=True),))

    async def probe_embedding_model(self, connection, *, model):
        self.calls.append(("embedding", connection.id, model))
        return ModelProbeReport(model=model, embedding_dimensions=768)


def _app(session, tmp_path, owner_id: str, probe: _FakeProbe | None = None, **settings) -> FastAPI:
    app = FastAPI()
    app.state.runtime_settings = Settings(
        animama_content_root=tmp_path / "content",
        animama_data_root=tmp_path / "data",
        **settings,
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
    app.dependency_overrides[get_model_connection_probe] = lambda: probe or _FakeProbe()
    # The shared catalog reads use the local ports on the same session.
    install_local_ports(app, session)
    return app


async def _seed_builtins(session) -> None:
    await ModelProviderCatalogService(
        model_providers=SQLAlchemyModelProviderRepository(session),
        uow=SQLAlchemyUnitOfWork(session),
    ).sync_from_registry()


def _connection_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"name": "Ollama", "preset": "ollama", "base_url": "http://127.0.0.1:11434/v1/"}
    body.update(overrides)
    return body


def _local_model_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": "qwen3:8b",
        "capabilities": {"supports_tools": True, "structured_output_transport": "json_schema"},
        "context_window_tokens": 8192,
    }
    body.update(overrides)
    return body


@pytest.fixture
def owner_id() -> str:
    return f"owner-{uuid4().hex[:8]}"


async def test_presets_use_the_composition_local_model_host(async_session, tmp_path, owner_id):
    app = _app(async_session, tmp_path, owner_id, animama_local_model_host="host.docker.internal")
    async with local_client(app) as client:
        presets = {preset["id"]: preset for preset in (await client.get("/v1/model-connection-presets")).json()}

    assert "openai" not in presets
    assert presets["ollama"]["default_base_url"] == "http://host.docker.internal:11434/v1"
    assert presets["ollama"]["compatibility"]["fold_developer_role"] is True
    assert presets["deepseek"]["default_base_url"] == "https://api.deepseek.com"
    assert presets["deepseek"]["suggested_credential_env"] == "DEEPSEEK_API_KEY"


async def test_openrouter_preset_is_listed_and_accepts_its_key_name(
    async_session, tmp_path, owner_id, set_runtime_credentials
):
    set_runtime_credentials(OPENROUTER_API_KEY="sk-or-secret")
    app = _app(async_session, tmp_path, owner_id)
    async with local_client(app) as client:
        presets = {preset["id"]: preset for preset in (await client.get("/v1/model-connection-presets")).json()}
        created = await client.post(
            "/v1/model-connections",
            json=_connection_body(
                name="OpenRouter",
                preset="openrouter",
                base_url="https://openrouter.ai/api/v1",
                credential={"mode": "env", "env": "OPENROUTER_API_KEY"},
            ),
        )

    assert presets["openrouter"] == {
        "id": "openrouter",
        "label": "OpenRouter",
        "logo_provider": "openrouter",
        "local": False,
        "expects_key": True,
        "default_base_url": "https://openrouter.ai/api/v1",
        "suggested_credential_env": "OPENROUTER_API_KEY",
        "compatibility": {
            "fold_developer_role": True,
            "send_openai_extensions": False,
            "send_stream_usage": True,
            "strip_function_strict": False,
            "reasoning_mode": "openai_effort",
        },
        "timeout_seconds": 60.0,
    }
    assert created.status_code == 201
    assert created.json()["preset"] == "openrouter"
    assert created.json()["logo_provider"] == "openrouter"
    assert created.json()["credential_env"] == "OPENROUTER_API_KEY"
    assert created.json()["credential_state"] == "configured"
    assert "sk-or-secret" not in created.text


async def test_refused_key_names_list_every_allowed_provider_name(async_session, tmp_path, owner_id):
    app = _app(async_session, tmp_path, owner_id)
    async with local_client(app) as client:
        response = await client.post(
            "/v1/model-connections",
            json=_connection_body(credential={"mode": "env", "env": "ANIMAMA_DATABASE_URL"}),
        )

    message = response.json()["detail"]["message"]
    for name in ("OPENAI_API_KEY", "DEEPSEEK_API_KEY", "HF_TOKEN", "OPENROUTER_API_KEY"):
        assert name in message


async def test_connections_record_credential_references_but_never_values(
    async_session, tmp_path, owner_id, set_runtime_credentials
):
    set_runtime_credentials(DEEPSEEK_API_KEY="sk-deepseek-secret")
    app = _app(async_session, tmp_path, owner_id)
    async with local_client(app) as client:
        keyless = await client.post("/v1/model-connections", json=_connection_body())
        env = await client.post(
            "/v1/model-connections",
            json=_connection_body(
                name="DeepSeek",
                preset="deepseek",
                base_url="https://api.deepseek.com",
                credential={"mode": "env", "env": "DEEPSEEK_API_KEY"},
            ),
        )
        managed = await client.post(
            "/v1/model-connections",
            json=_connection_body(name="Remote vLLM", preset="vllm", credential={"mode": "managed"}),
        )
        listed = await client.get("/v1/model-connections")

    assert keyless.status_code == 201
    assert keyless.json()["base_url"] == "http://127.0.0.1:11434/v1"
    assert keyless.json()["credential_state"] == "not_required"
    assert keyless.json()["timeout_seconds"] == 300.0
    assert env.json()["credential_env"] == "DEEPSEEK_API_KEY"
    assert env.json()["credential_state"] == "configured"
    assert env.json()["compatibility"]["reasoning_mode"] == "deepseek_thinking"
    managed_view = managed.json()
    assert managed_view["credential_env"] == f"ANIMAMA_CONNECTION_{managed_view['id'].upper()}_API_KEY"
    assert managed_view["credential_state"] == "missing"
    assert "sk-deepseek-secret" not in listed.text
    ids = [connection["id"] for connection in listed.json()]
    assert ids[0] == "openai"
    assert {keyless.json()["id"], env.json()["id"], managed_view["id"]} <= set(ids)


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"base_url": "ftp://models.example/v1"}, "invalid_base_url"),
        ({"base_url": "http://user:secret@models.example/v1"}, "invalid_base_url"),
        ({"base_url": "http://models.example/v1?key=1"}, "invalid_base_url"),
        ({"base_url": "http://[::1:11434/v1"}, "invalid_base_url"),
        ({"base_url": "http://models.example:abc/v1"}, "invalid_base_url"),
        ({"base_url": "http://models.example:99999/v1"}, "invalid_base_url"),
        ({"preset": "openai"}, "invalid_preset"),
        ({"credential": {"mode": "env", "env": "ANIMAMA_DATABASE_URL"}}, "invalid_credential"),
        # Only the Gemini voice reads the Gemini key; Google's SDK name is never accepted.
        ({"credential": {"mode": "env", "env": "GEMINI_API_KEY"}}, "invalid_credential"),
        ({"credential": {"mode": "env", "env": "GOOGLE_API_KEY"}}, "invalid_credential"),
        ({"timeout_seconds": 0.1}, "invalid_timeout"),
    ],
)
async def test_invalid_connections_are_rejected(async_session, tmp_path, owner_id, overrides, code):
    app = _app(async_session, tmp_path, owner_id)
    async with local_client(app) as client:
        response = await client.post("/v1/model-connections", json=_connection_body(**overrides))

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == code


async def test_new_openai_model_from_a_template_is_selectable_without_a_code_change(async_session, tmp_path, owner_id):
    await _seed_builtins(async_session)
    app = _app(async_session, tmp_path, owner_id)
    async with local_client(app) as client:
        added = await client.post(
            "/v1/model-connections/openai/models",
            json={"model": "gpt-6-sol", "template_id": "OpenAIResponsesHTTPAgent:gpt-6-luna"},
        )
        catalog = (await client.get("/v1/model-providers")).json()

    assert added.status_code == 201
    model = added.json()
    assert model["provider_type"] == "OpenAIResponsesHTTPAgent"
    assert model["source"] == "owner"
    assert model["context_window_tokens"] == 1_050_000
    assert model["capabilities"]["native_tool_support"] == ["apply_patch", "web_search"]
    assert model["template_id"] == "OpenAIResponsesHTTPAgent:gpt-6-luna"
    row = next(item for item in catalog if item["id"] == model["id"])
    assert row["model"] == "gpt-6-sol"
    assert row["api_standard"] == "responses"
    assert row["connection_name"] == "OpenAI"
    assert row["requestable_native_tool_support"] == ["web_search"]


async def test_templates_on_owner_connections_use_chat_completions_without_native_tools(
    async_session, tmp_path, owner_id
):
    await _seed_builtins(async_session)
    app = _app(async_session, tmp_path, owner_id)
    async with local_client(app) as client:
        connection = (await client.post("/v1/model-connections", json=_connection_body())).json()
        added = await client.post(
            f"/v1/model-connections/{connection['id']}/models",
            json={"model": "qwen3:8b", "template_id": "OpenAIResponsesHTTPAgent:gpt-6-luna"},
        )
        responses = await client.post(
            f"/v1/model-connections/{connection['id']}/models",
            json={"model": "qwen3:8b", "provider_type": "OpenAIResponsesHTTPAgent"},
        )

    assert added.json()["provider_type"] == "OpenAIHTTPAgent"
    assert added.json()["capabilities"]["native_tool_support"] is None
    # Another server serves its own window; the OpenAI template's does not apply.
    assert added.json()["context_window_tokens"] is None
    assert responses.status_code == 400
    assert responses.json()["detail"]["code"] == "invalid_provider_type"


async def test_owner_models_are_unpriced_and_reactivate_after_removal(async_session, tmp_path, owner_id):
    app = _app(async_session, tmp_path, owner_id)
    async with local_client(app) as client:
        connection = (await client.post("/v1/model-connections", json=_connection_body())).json()
        first = (await client.post(f"/v1/model-connections/{connection['id']}/models", json=_local_model_body())).json()
        duplicate = await client.post(
            f"/v1/model-connections/{connection['id']}/models", json=_local_model_body(label="Other")
        )
        removed = await client.delete(f"/v1/model-providers/{first['id']}")
        catalog_after_removal = (await client.get("/v1/model-providers")).json()
        again = (
            await client.post(
                f"/v1/model-connections/{connection['id']}/models", json=_local_model_body(label="Qwen 3")
            )
        ).json()

    assert duplicate.status_code == 409 and duplicate.json()["detail"]["code"] == "model_already_added"
    assert removed.status_code == 200
    assert first["id"] not in {row["id"] for row in catalog_after_removal}
    assert again["id"] == first["id"]
    assert again["model_label"] == "Qwen 3"
    stored = await SQLAlchemyModelProviderRepository(async_session).get(first["id"])
    assert stored is not None and stored.active
    assert stored.pricing.pricing_status == "unpriced"
    assert stored.source == "owner"
    assert stored.connection_id == connection["id"]


async def test_built_in_models_can_only_be_hidden(async_session, tmp_path, owner_id):
    await _seed_builtins(async_session)
    app = _app(async_session, tmp_path, owner_id)
    builtin_id = "OpenAIResponsesHTTPAgent:gpt-6-luna"
    async with local_client(app) as client:
        hidden = await client.patch(f"/v1/model-providers/{builtin_id}", json={"hidden": True})
        edited = await client.patch(f"/v1/model-providers/{builtin_id}", json={"label": "Mine"})
        removed = await client.delete(f"/v1/model-providers/{builtin_id}")
        catalog = {row["id"]: row for row in (await client.get("/v1/model-providers")).json()}
        await client.patch(f"/v1/model-providers/{builtin_id}", json={"hidden": False})

    assert hidden.json()["hidden"] is True
    assert catalog[builtin_id]["hidden"] is True
    assert edited.status_code == 400 and edited.json()["detail"]["code"] == "model_read_only"
    assert removed.status_code == 400 and removed.json()["detail"]["code"] == "model_read_only"


async def test_removing_a_model_in_use_needs_confirmation_and_clears_roles(async_session, tmp_path, owner_id):
    app = _app(async_session, tmp_path, owner_id)
    anima_id = f"anima-{uuid4().hex[:8]}"
    async with local_client(app) as client:
        connection = (await client.post("/v1/model-connections", json=_connection_body())).json()
        model = (await client.post(f"/v1/model-connections/{connection['id']}/models", json=_local_model_body())).json()
        async_session.add(ORMAnima(id=anima_id, user_id=owner_id, display_name="Mira"))
        await async_session.flush()
        async_session.add(ORMAnimaChatProfile(anima_id=anima_id, default_model_provider_id=model["id"], metadata_={}))
        await async_session.execute(delete(ORMUserSettings).where(ORMUserSettings.user_id == owner_id))
        async_session.add(
            ORMUserSettings(user_id=owner_id, preferences={"chat": {"default_model_provider_id": model["id"]}})
        )
        await async_session.commit()

        blocked = await client.delete(f"/v1/model-providers/{model['id']}")
        confirmed = await client.delete(f"/v1/model-providers/{model['id']}", params={"confirm": "true"})

    assert blocked.status_code == 409
    detail = blocked.json()["detail"]
    assert detail["code"] == "model_in_use"
    assert detail["usage"]["animas"] == [
        {"anima_id": anima_id, "display_name": "Mira", "model_provider_id": model["id"]}
    ]
    assert detail["usage"]["roles"] == ["chat.default_model_provider_id"]
    assert confirmed.status_code == 200
    async_session.expire_all()
    settings = await async_session.get(ORMUserSettings, owner_id)
    assert settings is not None and "default_model_provider_id" not in settings.preferences["chat"]
    # The Anima keeps its selection and shows the model as unavailable.
    profile = await async_session.get(ORMAnimaChatProfile, anima_id)
    assert profile is not None and profile.default_model_provider_id == model["id"]
    row = await async_session.get(ORMModelProvider, model["id"])
    assert row is not None and row.active is False


async def test_removing_a_connection_retires_its_models(async_session, tmp_path, owner_id):
    app = _app(async_session, tmp_path, owner_id)
    async with local_client(app) as client:
        connection = (await client.post("/v1/model-connections", json=_connection_body())).json()
        model = (await client.post(f"/v1/model-connections/{connection['id']}/models", json=_local_model_body())).json()
        removed = await client.delete(f"/v1/model-connections/{connection['id']}")
        builtin = await client.delete("/v1/model-connections/openai")
        listed = [item["id"] for item in (await client.get("/v1/model-connections")).json()]
        catalog = [item["id"] for item in (await client.get("/v1/model-providers")).json()]

    assert removed.status_code == 200
    assert builtin.status_code == 400
    assert connection["id"] not in listed
    assert model["id"] not in catalog


async def test_available_models_and_probe_use_the_connection(async_session, tmp_path, owner_id):
    probe = _FakeProbe()
    app = _app(async_session, tmp_path, owner_id, probe=probe)
    async with local_client(app) as client:
        connection = (await client.post("/v1/model-connections", json=_connection_body())).json()
        models = await client.get(f"/v1/model-connections/{connection['id']}/available-models")
        chat = await client.post(f"/v1/model-connections/{connection['id']}/probe", json={"model": "qwen3:8b"})
        embedding = await client.post(
            f"/v1/model-connections/{connection['id']}/probe", json={"model": "nomic-embed", "kind": "embedding"}
        )
        responses_elsewhere = await client.post(
            f"/v1/model-connections/{connection['id']}/probe",
            json={"model": "gpt-6-luna", "provider_type": "OpenAIResponsesHTTPAgent"},
        )

    assert models.json() == {"models": ["qwen3:8b", "gemma4:e4b"]}
    report = chat.json()
    assert report["context_window_tokens"] == 8192
    assert report["supports_tools"] is False
    assert [step["name"] for step in report["steps"]] == ["streaming", "tool_calls"]
    assert embedding.json()["embedding_dimensions"] == 768
    assert responses_elsewhere.status_code == 400
    assert probe.calls == [("chat", connection["id"], "qwen3:8b"), ("embedding", connection["id"], "nomic-embed")]


async def test_unreachable_connections_report_a_category(async_session, tmp_path, owner_id):
    app = _app(async_session, tmp_path, owner_id, probe=_FakeProbe(fail=True))
    async with local_client(app) as client:
        connection = (await client.post("/v1/model-connections", json=_connection_body())).json()
        response = await client.get(f"/v1/model-connections/{connection['id']}/available-models")

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "unreachable"


async def test_detect_lists_models_at_the_local_preset_default_address(async_session, tmp_path, owner_id):
    probe = _FakeProbe()
    app = _app(async_session, tmp_path, owner_id, probe=probe, animama_local_model_host="host.docker.internal")
    async with local_client(app) as client:
        response = await client.post("/v1/model-connection-presets/ollama/detect")

    assert response.status_code == 200
    assert response.json() == {
        "preset": "ollama",
        "base_url": "http://host.docker.internal:11434/v1",
        "reachable": True,
        "models": ["qwen3:8b", "gemma4:e4b"],
        "category": None,
    }
    [connection] = probe.listed
    assert connection.base_url == "http://host.docker.internal:11434/v1"
    assert connection.credential_env is None
    assert connection.timeout_seconds == 3.0


async def test_detect_reports_an_unreachable_server_as_a_result(async_session, tmp_path, owner_id):
    app = _app(async_session, tmp_path, owner_id, probe=_FakeProbe(fail=True, fail_category="timeout"))
    async with local_client(app) as client:
        response = await client.post("/v1/model-connection-presets/lmstudio/detect")

    assert response.status_code == 200
    assert response.json() == {
        "preset": "lmstudio",
        "base_url": "http://127.0.0.1:1234/v1",
        "reachable": False,
        "models": [],
        "category": "timeout",
    }


@pytest.mark.parametrize(
    ("preset", "status_code", "code"),
    [
        ("deepseek", 400, "preset_not_local"),
        ("custom", 400, "preset_not_local"),
        ("openai", 404, "unknown_preset"),
        ("nope", 404, "unknown_preset"),
    ],
)
async def test_detect_accepts_only_local_presets(async_session, tmp_path, owner_id, preset, status_code, code):
    probe = _FakeProbe()
    app = _app(async_session, tmp_path, owner_id, probe=probe)
    async with local_client(app) as client:
        response = await client.post(f"/v1/model-connection-presets/{preset}/detect")

    assert response.status_code == status_code
    assert response.json()["detail"]["code"] == code
    assert probe.listed == []


async def test_detect_ignores_a_requested_address(async_session, tmp_path, owner_id):
    probe = _FakeProbe()
    app = _app(async_session, tmp_path, owner_id, probe=probe)
    async with local_client(app) as client:
        response = await client.post(
            "/v1/model-connection-presets/vllm/detect",
            params={"base_url": "http://169.254.169.254/v1"},
            json={"base_url": "http://169.254.169.254/v1"},
        )

    assert response.json()["base_url"] == "http://127.0.0.1:8000/v1"
    assert [connection.base_url for connection in probe.listed] == ["http://127.0.0.1:8000/v1"]


async def test_detect_lists_a_real_server_without_a_key_and_bounds_the_models(
    async_session, tmp_path, owner_id, monkeypatch
):
    import httpx2
    from openai import AsyncOpenAI

    from animama.adapters.model_clients.openai_chat_completions.probe import OpenAICompatibleConnectionProbe
    from animama.app.model_clients.credentials import static_credential_resolver

    requests: list[httpx2.Request] = []

    def server(request: httpx2.Request) -> httpx2.Response:
        requests.append(request)
        data = [
            {"id": f"model-{index:03d}", "object": "model", "created": 0, "owned_by": "local"} for index in range(250)
        ]
        return httpx2.Response(200, json={"object": "list", "data": data})

    original_init = AsyncOpenAI.__init__

    def _init(self, *args, **kwargs):
        kwargs["http_client"] = httpx2.AsyncClient(transport=httpx2.MockTransport(server))
        original_init(self, *args, **kwargs)

    monkeypatch.setattr(AsyncOpenAI, "__init__", _init)
    probe = OpenAICompatibleConnectionProbe(
        credential_resolver=static_credential_resolver({"OPENAI_API_KEY": "sk-openai"}),
    )
    app = _app(async_session, tmp_path, owner_id)
    app.dependency_overrides[get_model_connection_probe] = lambda: probe
    async with local_client(app) as client:
        response = await client.post("/v1/model-connection-presets/llamacpp/detect")

    body = response.json()
    assert body["reachable"] is True
    assert len(body["models"]) == 200
    assert body["models"][0] == "model-000"
    assert [str(request.url) for request in requests] == ["http://127.0.0.1:8080/v1/models"]
    assert "authorization" not in {name.lower() for name in requests[0].headers}


def test_only_the_local_composition_mounts_model_configuration_routes(tmp_path):
    from animama.server.app import create_local_app

    configuration_paths = {route.path for route in model_configuration.router.routes if isinstance(route, APIRoute)}
    shared_paths = {route.path for route in served_routes(shared_router) if isinstance(route, APIRoute)}
    local_app = create_local_app(
        runtime_settings=Settings(animama_content_root=tmp_path / "content", animama_data_root=tmp_path / "data")
    )
    local_paths = {route.path for route in served_routes(local_app) if isinstance(route, APIRoute)}

    assert "/v1/model-connections" in configuration_paths
    assert "/v1/model-connection-presets/openrouter/models" in configuration_paths
    assert not configuration_paths & shared_paths
    assert configuration_paths <= local_paths
    assert local_app.state.model_catalog_policy.owner_models_enabled is True


async def test_default_catalog_policy_serves_built_in_rows_only(async_session, tmp_path, owner_id):
    await _seed_builtins(async_session)
    app = _app(async_session, tmp_path, owner_id)
    async with local_client(app) as client:
        connection = (await client.post("/v1/model-connections", json=_connection_body())).json()
        model = (await client.post(f"/v1/model-connections/{connection['id']}/models", json=_local_model_body())).json()
    service = ModelProviderCatalogService(model_providers=SQLAlchemyModelProviderRepository(async_session))

    hosted = {row["id"] for row in await service.list_public_catalog()}
    allowlisted = await service.list_public_catalog(
        ModelCatalogPolicy(builtin_allowlist=frozenset({"OpenAIResponsesHTTPAgent:gpt-6-luna"}))
    )
    local = {row["id"] for row in await service.list_public_catalog(ModelCatalogPolicy(owner_models_enabled=True))}

    assert model["id"] not in hosted
    assert "OpenAIResponsesHTTPAgent:gpt-6-luna" in hosted
    assert [row["id"] for row in allowlisted] == ["OpenAIResponsesHTTPAgent:gpt-6-luna"]
    assert model["id"] in local


async def test_a_missing_key_is_a_configuration_error_not_an_upstream_failure(async_session, tmp_path, owner_id):
    app = _app(async_session, tmp_path, owner_id, probe=_FakeProbe(fail=True, fail_category="credential_missing"))
    async with local_client(app) as client:
        connection = (await client.post("/v1/model-connections", json=_connection_body())).json()
        response = await client.get(f"/v1/model-connections/{connection['id']}/available-models")

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "credential_missing"


async def test_connection_updates_keep_omitted_fields_and_relabel_their_models(async_session, tmp_path, owner_id):
    app = _app(async_session, tmp_path, owner_id)
    async with local_client(app) as client:
        created = (
            await client.post(
                "/v1/model-connections",
                json=_connection_body(
                    name="Workstation",
                    preset="custom",
                    base_url="https://192.168.1.20:8443/v1",
                    credential={"mode": "env", "env": "ANIMAMA_CONNECTION_WORKSTATION_API_KEY"},
                    compatibility={"fold_developer_role": False, "send_openai_extensions": True},
                    timeout_seconds=120,
                ),
            )
        ).json()
        model = (await client.post(f"/v1/model-connections/{created['id']}/models", json=_local_model_body())).json()
        renamed = await client.patch(
            f"/v1/model-connections/{created['id']}", json={"name": "Workstation vLLM", "preset": "vllm"}
        )
        builtin = await client.patch("/v1/model-connections/openai", json={"name": "Mine"})
        catalog = {row["id"]: row for row in (await client.get("/v1/model-providers")).json()}

    assert renamed.status_code == 200
    view = renamed.json()
    assert view["name"] == "Workstation vLLM"
    assert view["preset"] == "vllm"
    assert view["base_url"] == "https://192.168.1.20:8443/v1"
    assert view["credential_env"] == "ANIMAMA_CONNECTION_WORKSTATION_API_KEY"
    assert view["compatibility"]["fold_developer_role"] is False
    assert view["timeout_seconds"] == 120
    assert [item["id"] for item in view["models"]] == [model["id"]]
    assert builtin.status_code == 400 and builtin.json()["detail"]["code"] == "connection_read_only"
    assert catalog[model["id"]]["provider_label"] == "Workstation vLLM"
    assert catalog[model["id"]]["logo_provider"] == "vllm"


async def test_owner_model_updates_change_only_the_given_fields(async_session, tmp_path, owner_id):
    await _seed_builtins(async_session)
    app = _app(async_session, tmp_path, owner_id)
    async with local_client(app) as client:
        model = (
            await client.post(
                "/v1/model-connections/openai/models",
                json={"model": "gpt-6-sol-edit", "template_id": "OpenAIResponsesHTTPAgent:gpt-6-luna"},
            )
        ).json()
        updated = await client.patch(
            f"/v1/model-providers/{model['id']}",
            json={
                "label": "GPT-6 Sol",
                "capabilities": {"supports_tools": True, "supported_reasoning_efforts": ["none", "low"]},
                "allow_memory_writes": False,
            },
        )
        cleared = await client.patch(f"/v1/model-providers/{model['id']}", json={"clear_context_window": True})

    assert updated.status_code == 200
    view = updated.json()
    assert view["model_label"] == "GPT-6 Sol"
    assert view["allow_memory_writes"] is False
    assert view["context_window_tokens"] == 1_050_000
    assert view["capabilities"]["supported_reasoning_efforts"] == ["none", "low"]
    # Hosted tools come from the Responses template and survive capability edits.
    assert view["capabilities"]["native_tool_support"] == ["apply_patch", "web_search"]
    assert cleared.json()["context_window_tokens"] is None
    assert cleared.json()["model_label"] == "GPT-6 Sol"


async def test_templates_describe_chat_models_only(async_session, tmp_path, owner_id):
    await _seed_builtins(async_session)
    app = _app(async_session, tmp_path, owner_id)
    async with local_client(app) as client:
        connection = (await client.post("/v1/model-connections", json=_connection_body())).json()
        response = await client.post(
            f"/v1/model-connections/{connection['id']}/models",
            json={"model": "nomic-embed", "kind": "embedding", "template_id": "OpenAIResponsesHTTPAgent:gpt-6-luna"},
        )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "invalid_template"


class _UnavailableSession:
    async def execute(self, *_args, **_kwargs):
        from sqlalchemy.exc import OperationalError

        raise OperationalError("SELECT", {}, Exception("database is down"))


async def test_catalog_failures_are_reported_instead_of_a_static_catalog(tmp_path, owner_id):
    app = _app(_UnavailableSession(), tmp_path, owner_id)
    async with local_client(app) as client:
        response = await client.get("/v1/model-providers")

    assert response.status_code == 503
    assert response.json()["detail"] == {"code": "model_catalog_unavailable"}


async def test_runtime_capabilities_report_model_configuration_from_the_composition(async_session, tmp_path, owner_id):
    from animama.product_http.routes import runtime_capabilities

    local = _app(async_session, tmp_path, owner_id, animama_user_file_processing_enabled=False)
    local.include_router(runtime_capabilities.router)
    install_local_ports(local, async_session)
    hosted = _app(async_session, tmp_path, owner_id, animama_user_file_processing_enabled=False)
    hosted.include_router(runtime_capabilities.router)
    install_local_ports(hosted, async_session)
    del hosted.state.model_catalog_policy
    async with local_client(local) as client:
        local_view = (await client.get("/v1/runtime-capabilities")).json()
    async with local_client(hosted) as client:
        hosted_view = (await client.get("/v1/runtime-capabilities")).json()

    assert local_view["model_configuration"] is True
    assert hosted_view["model_configuration"] is False


class _PlanStatus:
    """The ChatGPT plan session's status, as the connection list reads it."""

    def __init__(self, state: str, plan_use_granted: bool) -> None:
        self.state, self.plan_use_granted = state, plan_use_granted

    async def status(self) -> _PlanStatus:
        return self


@pytest.mark.parametrize(
    ("state", "granted", "expected"),
    [("signed_in", True, "configured"), ("signed_in", False, "missing"), ("signed_out", False, "missing")],
)
async def test_the_chatgpt_plan_connection_reports_its_sign_in_as_its_credential(
    async_session, tmp_path, owner_id, state: str, granted: bool, expected: str
):
    app = _app(async_session, tmp_path, owner_id)
    app.state.local_runtime_paths = SimpleNamespace(data_internal_root=tmp_path / "internal")
    app.state.chatgpt_plan_session = _PlanStatus(state, granted)
    async with local_client(app) as client:
        listed = (await client.get("/v1/model-connections")).json()

    plan = next(connection for connection in listed if connection["id"] == "chatgpt_plan")
    assert (plan["source"], plan["preset"], plan["credential_state"]) == ("builtin", "chatgpt_plan", expected)


class _UnreadablePlanSession:
    async def status(self) -> None:
        raise ChatGPTPlanUnavailableError("temporarily_unavailable")


async def test_an_unreadable_plan_session_reads_as_missing_and_keeps_the_list(async_session, tmp_path, owner_id):
    app = _app(async_session, tmp_path, owner_id)
    app.state.local_runtime_paths = SimpleNamespace(data_internal_root=tmp_path / "internal")
    app.state.chatgpt_plan_session = _UnreadablePlanSession()
    async with local_client(app) as client:
        response = await client.get("/v1/model-connections")

    assert response.status_code == 200
    plan = next(connection for connection in response.json() if connection["id"] == "chatgpt_plan")
    assert plan["credential_state"] == "missing"


async def test_owners_cannot_add_or_probe_models_on_the_chatgpt_plan_connection(async_session, tmp_path, owner_id):
    app = _app(async_session, tmp_path, owner_id)
    async with local_client(app) as client:
        added = await client.post("/v1/model-connections/chatgpt_plan/models", json=_local_model_body())
        listed = await client.get("/v1/model-connections/chatgpt_plan/available-models")
        probed = await client.post("/v1/model-connections/chatgpt_plan/probe", json={"model": "gpt-6-luna"})

    for response in (added, listed, probed):
        assert response.status_code in {400, 403, 409}, response.text
        assert response.json()["detail"]["code"] == "connection_read_only"

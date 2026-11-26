"""Runtime capabilities and private desktop controls are decided by the API, independently of renderer state."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import cast
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from animama.adapters.model_assets import FilesystemModelAssetStore
from animama.adapters.repositories.sqlalchemy.runtime_worker_repo import (
    clear_document_heartbeat,
    record_document_heartbeat,
)
from animama.app.ports.private_file_storage import PrivateFileStorage
from animama.app.ports.text_embedder import TextEmbedder
from animama.app.services.model_asset_service import ModelAssetService
from animama.app.services.user_file_processing_service import (
    UserFileProcessingConflictError,
    UserFileProcessingService,
)
from animama.domain.model_assets import ASSET_CATALOG_SCHEMA, parse_asset_catalog
from animama.domain.request_principal import RequestPrincipal
from animama.orm.runtime_worker import ORMRuntimeWorkerHeartbeat
from animama.product_http.routes import runtime_capabilities
from animama.server.config import Settings
from animama.server.deps import get_async_session, get_current_principal
from animama.server.routers import desktop_control, user_files
from animama.server.user_file_processing import UserFileProcessingRunner
from tests.local_http_client import local_client
from tests.product_http_support import install_local_ports
from tests.test_model_asset_sets import FILES, GPU_FILES, GPU_MANIFEST, MANIFEST, SetRelease, _set_entry


def _idle_runner(runtime_settings: Settings, instance_id: str) -> UserFileProcessingRunner:
    """A processing runner that never starts; the capability reads only its identity."""

    async def embeddings_off(_session: AsyncSession, _user_id: str) -> TextEmbedder | None:
        return None

    return UserFileProcessingRunner(
        cast(async_sessionmaker[AsyncSession], None),
        private_storage=cast(PrivateFileStorage, None),
        embedder_resolver=embeddings_off,
        runtime_settings=runtime_settings,
        instance_id=instance_id,
    )


def _app(session, tmp_path, *, enabled=False, runner_instance="expected-instance", **settings):
    """Use real route dependencies with a deliberately separate test principal."""

    app = FastAPI()
    app.state.runtime_settings = Settings(
        animama_content_root=tmp_path / "content",
        animama_data_root=tmp_path / "data",
        animama_user_file_processing_enabled=enabled,
        animama_desktop_control_token="c" * 64,
        **{"animama_parakeet_stt_enabled": False, **settings},
    )
    if runner_instance is not None:
        app.state.user_file_processing_runner = _idle_runner(app.state.runtime_settings, runner_instance)
    app.state.local_runtime_paths = SimpleNamespace(included_sources=(), operations_root=tmp_path / "operations")
    app.include_router(runtime_capabilities.router)
    app.include_router(desktop_control.router)
    app.include_router(user_files.router)

    async def principal():
        return RequestPrincipal(id="installation-owner")

    async def database():
        yield session

    app.dependency_overrides[get_current_principal] = principal
    app.dependency_overrides[get_async_session] = database
    install_local_ports(app, session)
    return app


@pytest.mark.parametrize(
    ("enabled", "age", "instance", "expected"),
    [
        (False, None, None, "disabled"),
        (True, None, None, "starting"),
        (True, 1, "expected-instance", "ready"),
        (True, 21, "expected-instance", "stale"),
        (True, 1, "previous-instance", "starting"),
    ],
)
async def test_capabilities_report_the_processors_liveness(async_session, tmp_path, enabled, age, instance, expected):
    await async_session.execute(delete(ORMRuntimeWorkerHeartbeat))
    if age is not None:
        async_session.add(
            ORMRuntimeWorkerHeartbeat(
                kind="document-processing",
                instance_id=instance,
                heartbeat_at=datetime.now(UTC) - timedelta(seconds=age),
            )
        )
    await async_session.commit()
    app = _app(async_session, tmp_path, enabled=enabled)
    async with local_client(app) as client:
        response = await client.get("/v1/runtime-capabilities")
        assert response.status_code == 200
        body = response.json()
        assert body["runtime_kind"] == "desktop"
        assert body["offline_speech_enabled"] is False
        assert body["offline_speech_asset_version"] is None
        assert body["offline_speech_gpu_asset_version"] is None
        processing = body["user_file_processing"]
        assert processing["enabled"] is enabled
        assert processing["worker_state"] == expected
        assert bool(processing["supported_extensions"]) is enabled
        assert (processing["last_heartbeat_at"] is not None) == (expected in {"ready", "stale"})
        assert "expected-instance" not in response.text
        assert "c" * 64 not in response.text
        # The capability keeps its shape (spec R1.7), though no pack provides processing any more.
        assert processing["pack_id"] == "document-processing"
    await async_session.execute(delete(ORMRuntimeWorkerHeartbeat))
    await async_session.commit()


async def test_capabilities_wait_for_the_servers_own_processor(async_session, tmp_path):
    """A fresh heartbeat proves nothing until this server's runner is the one renewing it."""

    await async_session.execute(delete(ORMRuntimeWorkerHeartbeat))
    async_session.add(
        ORMRuntimeWorkerHeartbeat(
            kind="document-processing", instance_id="expected-instance", heartbeat_at=datetime.now(UTC)
        )
    )
    await async_session.commit()
    try:
        app = _app(async_session, tmp_path, enabled=True, runner_instance=None)
        async with local_client(app) as client:
            processing = (await client.get("/v1/runtime-capabilities")).json()["user_file_processing"]
        assert (processing["enabled"], processing["worker_state"]) == (True, "starting")
        assert processing["last_heartbeat_at"] is None
    finally:
        await async_session.execute(delete(ORMRuntimeWorkerHeartbeat))
        await async_session.commit()


async def test_operator_parakeet_source_reports_its_flag_without_versions(async_session, tmp_path):
    # Development Vite serves the operator's host sets; the backend pins no version.
    app = _app(async_session, tmp_path, animama_parakeet_source="operator", animama_parakeet_stt_enabled=True)
    async with local_client(app) as client:
        body = (await client.get("/v1/runtime-capabilities")).json()
    assert (body["offline_speech_enabled"], body["offline_speech_asset_version"]) == (True, None)
    assert body["offline_speech_gpu_asset_version"] is None
    # SenseVoice follows the same source with its own operator flag.
    assert (body["offline_multilingual_speech_enabled"], body["offline_multilingual_speech_asset_version"]) == (
        True,
        None,
    )


@pytest.mark.parametrize("operator_enabled", [True, False])
@pytest.mark.parametrize(
    ("engine", "capability"),
    [("parakeet", "offline_speech"), ("sensevoice", "offline_multilingual_speech")],
)
async def test_asset_store_offline_speech_follows_installs_without_a_restart(
    async_session, tmp_path, operator_enabled, engine, capability
):
    app = _app(
        async_session,
        tmp_path,
        animama_parakeet_source="asset-store",
        **{f"animama_{engine}_stt_enabled": operator_enabled},
    )
    base, gpu = f"{engine}-stt", f"{engine}-stt-webgpu"
    service = ModelAssetService(
        parse_asset_catalog(
            {
                "schema": ASSET_CATALOG_SCHEMA,
                "assets": [
                    _set_entry(base, "speech-model", FILES, MANIFEST),
                    _set_entry(gpu, "speech-gpu-model", GPU_FILES, GPU_MANIFEST, requires=[base]),
                ],
            }
        ),
        FilesystemModelAssetStore(tmp_path / "data"),
        SetRelease().fetcher(),
    )
    app.state.model_asset_service = service

    async def capabilities():
        body = (await client.get("/v1/runtime-capabilities")).json()
        return (
            body[f"{capability}_enabled"],
            body[f"{capability}_asset_version"],
            body[f"{capability}_gpu_asset_version"],
        )

    async with local_client(app) as client:
        assert await capabilities() == (False, None, None)
        for asset_id in (base, gpu):
            service.install(asset_id)
            assert (await service.wait(asset_id)).status == "installed"
        assert await capabilities() == (operator_enabled, MANIFEST, GPU_MANIFEST)
        await service.remove(gpu)
        await service.remove(base)
        assert await capabilities() == (False, None, None)


async def test_api_guard_returns_409_before_looking_up_or_queueing_a_file(async_session, tmp_path):
    app = _app(async_session, tmp_path)
    async with local_client(app) as client:
        result = await client.post("/v1/files/does-not-matter:process", json={"force": True})
        assert result.status_code == 409
        assert result.json()["detail"]["code"] == "file_processing_unavailable"


async def test_service_guard_precedes_repository_calls():
    processing, uow = AsyncMock(), AsyncMock()
    service = UserFileProcessingService(processing=processing, uow=uow, processing_enabled=False)
    with pytest.raises(UserFileProcessingConflictError, match="file_processing_unavailable"):
        await service.enqueue_processing_job(user_id="owner", file_id="file", force=True)
    assert processing.mock_calls == []
    assert uow.mock_calls == []


async def test_private_control_is_not_a_browser_api_and_contains_no_paths(async_session, tmp_path):
    app = _app(async_session, tmp_path)
    assert not any(key.startswith("/_desktop") for key in app.openapi()["paths"])
    async with local_client(app) as client:
        url = "/_desktop/feature-packs/expanded-included-content:removal-check"
        for headers in ({}, {"X-Animama-Desktop-Control": "wrong"}, {"X-Animama-Internal-Token": "c" * 64}):
            assert (await client.post(url, headers=headers)).status_code == 404
        result = await client.post(url, headers={"X-Animama-Desktop-Control": "c" * 64})
        assert result.status_code == 200
        assert result.json()["removable"] is True
        assert result.json()["blockers"] == []
        assert str(tmp_path) not in result.text
        # Parakeet sets are backend model assets now, and the server itself processes
        # uploads, so none of these is a removable pack.
        for unknown in ("unknown", "parakeet-stt", "parakeet-stt-webgpu", "document-processing"):
            assert (
                await client.post(
                    f"/_desktop/feature-packs/{unknown}:removal-check", headers={"X-Animama-Desktop-Control": "c" * 64}
                )
            ).status_code == 404

        async def denied():
            raise HTTPException(401)

        app.dependency_overrides[get_current_principal] = denied
        assert (await client.get("/v1/runtime-capabilities")).status_code == 401


async def test_old_worker_cannot_clear_replacement_heartbeat(async_session):
    await record_document_heartbeat(async_session, instance_id="new", worker_id="new-worker", job_id=None)
    await clear_document_heartbeat(async_session, instance_id="old")
    row = await async_session.get(ORMRuntimeWorkerHeartbeat, "document-processing")
    assert row.instance_id == "new"
    await clear_document_heartbeat(async_session, instance_id="new")
    async_session.expire_all()
    assert await async_session.get(ORMRuntimeWorkerHeartbeat, "document-processing") is None


@pytest.mark.parametrize("desktop_token", ["c" * 64, None])
async def test_local_composition_reports_uploads_and_anima_creation(async_session, tmp_path, desktop_token):
    """Local desktop and self-hosted web both admit uploads and Anima creation and keep Library previews."""

    app = _app(async_session, tmp_path)
    app.state.runtime_settings = app.state.runtime_settings.model_copy(
        update={"animama_desktop_control_token": desktop_token}
    )
    async with local_client(app) as client:
        body = (await client.get("/v1/runtime-capabilities")).json()
    assert body["runtime_kind"] == ("desktop" if desktop_token else "self_hosted_web")
    assert (body["chat_file_uploads"], body["anima_creation"]) == (True, True)
    assert body["schema_version"] == 2
    assert body["chat"] and body["model_selection"] and body["model_role_selection"]
    assert body["provider_credentials"] and body["local_filesystem_administration"]
    assert body["native_features"] is bool(desktop_token)
    assert body["library_previews"] is True
    assert body["automatic_episode_processing"] is True
    assert body["chatgpt_plan"] is True


def test_library_previews_are_on_unless_a_runtime_turns_them_off():
    """A composition that omits the field keeps Library previews."""

    from animama.app.contracts.runtime_capabilities import RuntimeCapabilities

    assert RuntimeCapabilities.model_fields["library_previews"].default is True
    assert RuntimeCapabilities.model_json_schema()["properties"]["library_previews"]["default"] is True


@pytest.mark.parametrize("desktop_token", ["c" * 64, None])
async def test_local_composition_never_advertises_browser_telemetry(
    async_session, tmp_path, monkeypatch, desktop_token
):
    """Even an enabled local forwarder leaves the browser without an exporter."""

    monkeypatch.setenv("ANIMAMA_DISABLE_WEBUI_TELEMETRY", "false")
    app = _app(async_session, tmp_path)
    app.state.runtime_settings = app.state.runtime_settings.model_copy(
        update={"animama_desktop_control_token": desktop_token}
    )
    async with local_client(app) as client:
        body = (await client.get("/v1/runtime-capabilities")).json()
    assert body.get("browser_telemetry") is None


def test_browser_telemetry_capability_is_optional_and_same_origin():
    """Absent means off; a present capability names only a relative same-origin path."""

    from pydantic import ValidationError

    from animama.app.contracts.runtime_capabilities import BrowserTelemetryCapability, RuntimeCapabilities

    assert RuntimeCapabilities.model_fields["browser_telemetry"].default is None
    assert BrowserTelemetryCapability().path == "/api/telemetry"
    assert BrowserTelemetryCapability(path="/v1/hosted/browser-telemetry").path == "/v1/hosted/browser-telemetry"
    for path in (
        "",
        "/",
        "api/telemetry",
        "//collector.example/v1",
        "https://collector.example/v1",
        "/api/../telemetry",
        "/api/telemetry/",
        "/api/telemetry?signal=logs",
        "/api/telemetry#logs",
        "/api\\telemetry",
        "/" + "a" * 128,
    ):
        with pytest.raises(ValidationError):
            BrowserTelemetryCapability(path=path)


def test_capability_contract_is_neutral_and_admits_hosted_presentation():
    """Another composition can return the contract without importing local handlers."""

    import subprocess
    import sys

    probe = (
        "import sys\n"
        "from animama.app.contracts.runtime_capabilities import RuntimeCapabilities\n"
        "assert 'hosted' in RuntimeCapabilities.model_fields['runtime_kind'].annotation.__args__\n"
        "leaked = sorted(m for m in sys.modules if m == 'animama.server' or m.startswith('animama.server.'))\n"
        "assert not leaked, leaked\n"
    )
    subprocess.run([sys.executable, "-c", probe], check=True)

    from animama.app.contracts import runtime_capabilities as contract

    # The local route serves the shared model rather than a local copy.
    route = next(r for r in runtime_capabilities.router.routes if getattr(r, "path", "") == "/v1/runtime-capabilities")
    assert getattr(route, "response_model", None) is contract.RuntimeCapabilities
    for flag in ("chat_file_uploads", "anima_creation"):
        assert contract.RuntimeCapabilities.model_fields[flag].is_required()


def test_hosted_parity_contract_keeps_choices_independent_of_administration():
    """The eight exceptions never imply loss of chat or operator-catalog choices."""

    import json
    from pathlib import Path

    from animama.app.contracts.runtime_capabilities import RuntimeCapabilities

    fixture = Path(__file__).parents[1] / "contracts/runtime-capabilities/hosted.json"
    capabilities = RuntimeCapabilities.model_validate(json.loads(fixture.read_text()))
    assert capabilities.schema_version == 2
    assert capabilities.chat is True
    assert capabilities.model_selection is True
    assert capabilities.model_role_selection is True
    assert capabilities.anima_creation is False
    assert capabilities.chat_file_uploads is False
    assert capabilities.user_file_processing.enabled is False
    assert capabilities.model_configuration is False
    assert capabilities.provider_credentials is False
    assert capabilities.web_search.configuration is False
    assert capabilities.local_filesystem_administration is False
    assert capabilities.native_features is False
    assert capabilities.library_previews is False
    # Hosted never processes episode notes in the background (spec #775).
    assert capabilities.automatic_episode_processing is False
    # Hosted has no ChatGPT plan sign-in (spec #919).
    assert capabilities.chatgpt_plan is False


@pytest.mark.parametrize(
    "flag",
    [
        "chat",
        "model_selection",
        "model_role_selection",
        "provider_credentials",
        "local_filesystem_administration",
        "native_features",
    ],
)
def test_compositions_explicitly_report_parity_permissions(flag):
    """Absent permission must not silently enable or hide a hosted workflow."""

    from animama.app.contracts.runtime_capabilities import RuntimeCapabilities

    assert flag in RuntimeCapabilities.model_fields
    assert RuntimeCapabilities.model_fields[flag].is_required()

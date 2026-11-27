"""Local FastAPI composition root for desktop and self-hosted installations."""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from animama.app.safety.config import safety_override_warnings
from animama.app.services.memory_manager_service import MemoryManagerService
from animama.app.services.model_provider_catalog_service import ModelCatalogPolicy
from animama.domain.request_principal import RequestPrincipal
from animama.local.database import LocalDatabase
from animama.local.http.composition import install_local_http
from animama.logging_config import configure_logging
from animama.product_http.ports import ProductPorts, install_product_ports, model_role_resolver
from animama.server.chatgpt_plan import (
    chatgpt_plan_session_for,
    close_chatgpt_plan_session,
    install_chatgpt_plan_store_key,
)
from animama.server.config import Settings
from animama.server.content_startup import start_content_runtime, stop_content_runtime
from animama.server.deps import get_async_session_factory
from animama.server.embedding_refresh import start_embedding_refresh, stop_embedding_refresh
from animama.server.episode_processing import (
    ModelReadiness,
    start_automatic_episode_processing,
    stop_automatic_episode_processing,
)
from animama.server.local_http import local_assets, local_http_config, local_telemetry
from animama.server.local_installation_bootstrap import create_local_installation_bootstrap_service
from animama.server.local_runtime import initialize_local_runtime
from animama.server.memory_manager import local_memory_manager_model_readiness
from animama.server.model_assets import close_model_asset_service, model_asset_service_for
from animama.server.product_ports import LocalProductPorts
from animama.server.routers import router
from animama.server.routers.chatgpt_plan import router as chatgpt_plan_router
from animama.server.routers.desktop_control import require_desktop_control, router as desktop_control_router
from animama.server.routers.generation import router as generation_router
from animama.server.routers.memory_automation import router as memory_automation_router
from animama.server.routers.model_configuration import router as model_configuration_router
from animama.server.routers.web_search import router as web_search_router
from animama.server.runtime_credentials import (
    PinnedCredentialsMiddleware,
    follow_trace_export_key,
    scrub_credential_environment,
)
from animama.server.telemetry import setup_telemetry
from animama.server.user_file_processing import start_user_file_processing, stop_user_file_processing

logger = logging.getLogger(__name__)


def _start_automatic_episode_processing(application: FastAPI, *, owner_id: str) -> None:
    """Start the installation owner's automatic episode processing (spec #775) on the app's ports."""

    # The ports create_local_app installed (construction performs no IO).
    ports: ProductPorts = application.state.product_ports

    async def memory_manager(session: AsyncSession, user_id: str) -> MemoryManagerService:
        return await ports.memory_manager(session, RequestPrincipal(id=user_id))

    async def model_usable(session: AsyncSession, user_id: str) -> ModelReadiness:
        roles = model_role_resolver(ports, ports.repositories(session))
        return await local_memory_manager_model_readiness(
            user_id, roles=roles, chatgpt_plan_session=lambda: chatgpt_plan_session_for(application)
        )

    start_automatic_episode_processing(
        application,
        session_factory=get_async_session_factory(application),
        owner_id=owner_id,
        memory_manager=memory_manager,
        model_usable=model_usable,
    )


def create_local_app(
    *,
    runtime_settings: Settings | None = None,
    session_factory: async_sessionmaker[AsyncSession] | None = None,
) -> FastAPI:
    """Create only the local accountless composition.

    Product traffic stays fail-closed until startup completes bootstrap for the
    migration-owned principal. Browser metadata never supplies that identity.
    """

    local_settings = runtime_settings or Settings()
    http_config = local_http_config(local_settings)
    application = FastAPI(title="Animama Local Server", version="0.1.0")
    application.state.runtime_settings = local_settings
    application.state.local_http_config = http_config
    install_chatgpt_plan_store_key(application)
    database = LocalDatabase(local_settings) if session_factory is None else None
    application.state.session_factory = session_factory
    if database is not None:
        application.state.session_factory_provider = database.session_factory
    # Shared product routes resolve sessions through these ports (ADR 0021).
    install_product_ports(application, LocalProductPorts(application))
    setup_telemetry(application, service_name="animama-server", service_version=application.version)

    @application.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    application.include_router(router)
    # The installation owner may add model connections and models. These routes
    # reach owner-supplied endpoints, so only the local composition mounts them.
    # Anthropic built-ins are local-only as well (spec constraint "Local only").
    application.state.model_catalog_policy = ModelCatalogPolicy.local()
    application.include_router(model_configuration_router)
    # Signing in with a ChatGPT plan stores tokens on this machine and needs a return
    # address on loopback, so only this composition mounts it (spec #919).
    application.include_router(chatgpt_plan_router)
    # Application web search sends queries to an owner-configured backend
    # (a SearXNG URL may be a loopback or LAN host), so only this composition
    # enables it and mounts its settings routes.
    application.state.application_web_search_enabled = True
    application.include_router(web_search_router)
    # Hosted never processes episode notes in the background, so only this composition
    # mounts the automatic-processing routes (spec #775).
    application.include_router(memory_automation_router)
    # The content assistant spends the owner's own plan or key on requests this backend
    # builds, so only this composition mounts its routes (spec #942).
    application.include_router(generation_router)
    if http_config.desktop is not None:
        # Desktop keys change while this process runs; the runtime store is
        # their only copy (see runtime_credentials).
        scrub_credential_environment()
        application.include_router(desktop_control_router)

        @application.get("/_desktop/health", include_in_schema=False)
        async def desktop_health(request: Request) -> dict[str, object]:
            """Identify this exact owned child without exposing browser credentials."""
            require_desktop_control(request)
            state = getattr(application.state, "local_bootstrap_state", None)
            if state is not None and not state.content_ready:
                # Nothing updates content_ready after startup, so this process
                # can never become ready. A distinct terminal code lets the
                # supervisor stop waiting.
                raise HTTPException(status_code=503, detail={"code": "content_startup_failed"})
            if state is None or not lifecycle.ready:
                raise HTTPException(status_code=503, detail="runtime_starting")
            from alembic.script import ScriptDirectory

            from animama.runtime.resources import alembic_config

            return {
                "schema_version": 1,
                # The desktop app version, not this API's schema version: the
                # supervisor refuses a backend reporting any other value.
                "runtime_version": os.getenv("ANIMAMA_DESKTOP_APP_VERSION", application.version),
                "build_id": os.getenv("ANIMAMA_DESKTOP_BUILD_ID", "development"),
                "alembic_head": ScriptDirectory.from_config(alembic_config()).get_current_head(),
                "installation_principal_id": state.principal_id,
                "local_http_schema_version": 1,
                "process_id": os.getpid(),
                "process_start_token": os.getenv("ANIMAMA_PROCESS_START_TOKEN", ""),
            }

    @application.on_event("startup")
    async def initialize_accountless_runtime() -> None:  # pragma: no cover - startup IO
        """Validate local paths, require the principal, and ensure owner defaults."""

        paths = initialize_local_runtime(local_settings)
        application.state.local_runtime_paths = paths
        # Discard staging left by an interrupted install before serving requests.
        model_asset_service_for(application)
        bootstrap = create_local_installation_bootstrap_service(
            session_factory=get_async_session_factory(application),
            paths=paths,
            settings=local_settings,
        )
        application.state.local_installation_bootstrap_service = bootstrap
        state = await bootstrap.ensure()
        application.state.local_bootstrap_state = state
        await start_content_runtime(
            application,
            owner_id=state.principal_id,
            perform_initial_scan=False,
        )
        start_embedding_refresh(application, session_factory=get_async_session_factory(application))
        # Uploads are processed in this process unless the operator turned processing off.
        start_user_file_processing(
            application,
            session_factory=get_async_session_factory(application),
            paths=paths,
            runtime_settings=local_settings,
        )
        _start_automatic_episode_processing(application, owner_id=state.principal_id)
        # A bounded repair state may still use the existing bootstrap API. The
        # owner is established by completed service bootstrap, never that API's
        # request body; desktop readiness separately requires content readiness.
        lifecycle.mark_ready(state.principal_id)

    @application.on_event("shutdown")
    async def stop_accountless_runtime() -> None:  # pragma: no cover - startup IO
        await stop_user_file_processing(application)
        await stop_automatic_episode_processing(application)
        await stop_embedding_refresh(application)
        await close_model_asset_service(application)
        await close_chatgpt_plan_session(application)
        await stop_content_runtime(application)
        if database is not None:
            await database.close()

    @application.on_event("startup")
    async def configure_anima_logging() -> None:  # pragma: no cover - simple IO
        try:
            configure_logging()
        except Exception:
            # Serving continues with the default handlers; say why file logs are missing.
            logger.warning("Logging configuration failed; using default handlers", exc_info=True)

    @application.on_event("startup")
    async def warn_companion_safety_overrides() -> None:
        for warning in safety_override_warnings(local_settings.companion_safety):
            logger.warning("Companion safety override: %s", warning)

    @application.on_event("startup")
    async def init_model_clients() -> None:  # pragma: no cover - simple IO
        try:
            from animama.server.model_clients import init_model_client_registry

            await init_model_client_registry(
                application, chatgpt_plan_session=lambda: chatgpt_plan_session_for(application)
            )
        except Exception:
            logger.warning("Model client registry failed to start; model calls are unavailable", exc_info=True)
            application.state.model_client_registry = None

    @application.on_event("shutdown")
    async def close_model_clients() -> None:  # pragma: no cover - simple IO
        try:
            from animama.server.model_clients import close_model_client_registry

            await close_model_client_registry(application)
        except Exception:
            logger.warning("Model client registry did not close cleanly", exc_info=True)

    lifecycle = install_local_http(
        application,
        http_config,
        assets=local_assets(local_settings, application),
        telemetry=local_telemetry(http_config),
    )
    # Outermost, so everything a request runs sees the keys it was admitted with.
    application.add_middleware(PinnedCredentialsMiddleware)
    follow_trace_export_key()
    return application


app = create_local_app()

__all__ = ["app", "create_local_app"]

"""The local composition's runtime capabilities (ADR 0021).

The shared route asks each composition's ports what it offers; the local ports
answer with :func:`local_runtime_capabilities`. The response models live in
:mod:`animama.app.contracts.runtime_capabilities`.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import FastAPI, Request
from sqlalchemy.ext.asyncio import AsyncSession

from animama.adapters.repositories.sqlalchemy.web_search_settings_repo import SQLAlchemyWebSearchSettingsRepository
from animama.app.contracts.gemini import gemini_tts_capability
from animama.app.contracts.runtime_capabilities import (
    CompanionSafetyCapability,
    RuntimeCapabilities,
    UserFileProcessingCapability,
    WebSearchCapability,
)
from animama.app.services.user_file_service import ALLOWED_USER_FILE_EXTENSIONS
from animama.orm.runtime_worker import ORMRuntimeWorkerHeartbeat
from animama.server.config import Settings, settings
from animama.server.model_assets import parakeet_availability, sensevoice_availability
from animama.server.model_roles import composition_model_policy
from animama.server.user_file_processing import get_user_file_processing_runner
from animama.server.web_search import composition_web_search_enabled, web_search_credential_state


def runtime_settings_for(app: FastAPI) -> Settings:
    """The app's runtime policy, including explicitly supplied test settings."""

    return getattr(app.state, "runtime_settings", settings)


def get_runtime_settings(request: Request) -> Settings:
    """Use the composition's policy, including explicitly supplied test settings."""

    return runtime_settings_for(request.app)


async def local_runtime_capabilities(app: FastAPI, session: AsyncSession) -> RuntimeCapabilities:
    """Describe the local app; enabled processing accepts durable jobs even while its processor is stale."""

    runtime_settings = runtime_settings_for(app)
    enabled = runtime_settings.animama_user_file_processing_enabled
    state: Literal["disabled", "starting", "ready", "stale"] = "disabled"
    last_heartbeat_at = None
    if enabled:
        heartbeat = await session.get(ORMRuntimeWorkerHeartbeat, "document-processing")
        # Only this server's own processor counts, not a row another process left behind.
        runner = get_user_file_processing_runner(app)
        if heartbeat is None or runner is None or heartbeat.instance_id != runner.instance_id:
            state = "starting"
        else:
            last_heartbeat_at = heartbeat.heartbeat_at
            state = "ready" if heartbeat.heartbeat_at >= datetime.now(UTC) - timedelta(seconds=20) else "stale"
    desktop = bool(runtime_settings.animama_desktop_control_token)
    speech = parakeet_availability(app, runtime_settings)
    multilingual_speech = sensevoice_availability(app, runtime_settings)
    safety = runtime_settings.companion_safety
    web_search = WebSearchCapability()
    if composition_web_search_enabled(app):
        search_settings = await SQLAlchemyWebSearchSettingsRepository(session).get()
        web_search = WebSearchCapability(
            configuration=True,
            configured=search_settings is not None,
            backend=search_settings.backend if search_settings is not None else None,
            credential_state=web_search_credential_state(search_settings) if search_settings is not None else None,
        )
    return RuntimeCapabilities(
        chat=True,
        model_selection=True,
        model_role_selection=True,
        model_configuration=composition_model_policy(app).owner_models_enabled,
        provider_credentials=True,
        web_search=web_search,
        gemini_tts=gemini_tts_capability(),
        companion_safety=CompanionSafetyCapability(
            enabled=safety.enabled,
            ai_notice_enabled=safety.effective_ai_notice_enabled,
            crisis_detection_enabled=safety.effective_crisis_detection_enabled,
            operator_reminder_hours=safety.reminder_interval.total_seconds() / 3600,
        ),
        runtime_kind="desktop" if desktop else "self_hosted_web",
        # The local composition mounts upload and Anima-creation routes.
        chat_file_uploads=True,
        anima_creation=True,
        automatic_episode_processing=True,
        chatgpt_plan=True,
        local_filesystem_administration=True,
        native_features=desktop,
        offline_speech_enabled=speech.enabled,
        offline_speech_asset_version=speech.asset_version,
        offline_speech_gpu_asset_version=speech.gpu_asset_version,
        offline_multilingual_speech_enabled=multilingual_speech.enabled,
        offline_multilingual_speech_asset_version=multilingual_speech.asset_version,
        offline_multilingual_speech_gpu_asset_version=multilingual_speech.gpu_asset_version,
        user_file_processing=UserFileProcessingCapability(
            enabled=enabled,
            worker_state=state,
            last_heartbeat_at=last_heartbeat_at,
            pack_id="document-processing" if desktop else None,
            supported_extensions=sorted(ALLOWED_USER_FILE_EXTENSIONS) if enabled else [],
        ),
    )


__all__ = ["get_runtime_settings", "local_runtime_capabilities", "runtime_settings_for"]

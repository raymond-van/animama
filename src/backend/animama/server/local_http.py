"""Translate trusted local settings into the installation's HTTP components."""

from __future__ import annotations

import os

from fastapi import FastAPI

from animama.local.http.assets import LocalAssets
from animama.local.http.config import DesktopAccess, LocalHTTPConfig
from animama.local.http.telemetry import TelemetryConfig, TelemetryDestinations, TelemetryForwarder
from animama.server.chatgpt_plan import CALLBACK_PATH
from animama.server.config import Settings
from animama.server.model_assets import AssetStoreModelMounts


def local_http_config(settings: Settings) -> LocalHTTPConfig:
    """Require both desktop credentials; a partial launch cannot weaken policy."""
    renderer, control = settings.animama_desktop_renderer_capability, settings.animama_desktop_control_token
    if (renderer is None) != (control is None):
        raise ValueError("Desktop HTTP requires both renderer and control credentials")
    desktop = DesktopAccess(renderer, control) if renderer is not None and control is not None else None
    return LocalHTTPConfig(
        public_origin=settings.animama_public_origin, desktop=desktop, sign_in_return_path=CALLBACK_PATH
    )


def local_assets(settings: Settings, application: FastAPI) -> LocalAssets | None:
    """Development leaves build serving to Vite; built installations supply it.

    The ``asset-store`` speech model source serves sets installed in the
    application's model-asset store, resolved per request. The ``operator``
    source serves no models here: development's Vite serves the host sets.
    """
    if settings.animama_web_root is None:
        return None
    if settings.animama_parakeet_source == "asset-store":
        return LocalAssets(settings.animama_web_root, mount_source=AssetStoreModelMounts(application))
    return LocalAssets(settings.animama_web_root)


def local_telemetry(config: LocalHTTPConfig) -> TelemetryForwarder:
    """Keep desktop disabled and preserve the existing explicit web opt-outs."""

    def disabled(*names: str) -> bool:
        return any(os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"} for name in names)

    enabled = config.desktop is None and not disabled(
        "ANIMAMA_DISABLE_WEBUI_TELEMETRY", "NEXT_PUBLIC_ANIMAMA_DISABLE_WEBUI_TELEMETRY"
    )
    traces_enabled = not disabled("ANIMAMA_DISABLE_WEBUI_TRACES", "NEXT_PUBLIC_ANIMAMA_DISABLE_WEBUI_TRACES")

    def endpoint(signal: str) -> str:
        base = (
            os.getenv(f"OTEL_EXPORTER_OTLP_{signal.upper()}_ENDPOINT")
            or os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
            or "http://otel-collector:4318"
        ).rstrip("/")
        return base if base.endswith(f"/v1/{signal}") else f"{base}/v1/{signal}"

    destinations = (
        TelemetryDestinations(**{signal: endpoint(signal) for signal in ("traces", "metrics", "logs")})
        if enabled
        else None
    )
    return TelemetryForwarder(
        TelemetryConfig(enabled=enabled, traces_enabled=traces_enabled, destinations=destinations)
    )

"""Owner-visible runtime capability contract shared by every composition.

Compositions report what the current runtime admits; the UI decides what to
show from these values rather than from a build or deployment mode. The models
carry presentation metadata only, never executable paths or credentials.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from animama.app.contracts.gemini import GeminiTtsCapability


class UserFileProcessingCapability(BaseModel):
    enabled: bool
    worker_state: Literal["disabled", "starting", "ready", "stale"]
    last_heartbeat_at: datetime | None
    pack_id: Literal["document-processing"] | None
    supported_extensions: list[str]


class CompanionSafetyCapability(BaseModel):
    """Operator safety configuration; owner preferences are in user settings."""

    enabled: bool
    ai_notice_enabled: bool
    crisis_detection_enabled: bool
    operator_reminder_hours: float


class WebSearchCapability(BaseModel):
    configuration: bool = False
    """Whether the owner may configure application web search (local composition only)."""
    configured: bool = False
    """Whether a backend is configured, so tool-capable models can search."""
    backend: Literal["searxng", "brave"] | None = None
    credential_state: Literal["configured", "missing", "not_required"] | None = None
    """Whether the backend's key is set; searches fail with a tool error while it is ``missing``."""


class BrowserTelemetryCapability(BaseModel):
    """Browser telemetry export that the serving origin accepts.

    The web app posts bounded OTLP/HTTP JSON metrics and error logs to
    ``{path}/metrics`` and ``{path}/logs`` on its own origin; the embedded
    desktop app never exports. The path is relative to that origin, never a URL.
    """

    path: str = Field(default="/api/telemetry", max_length=128, pattern=r"^(/[A-Za-z0-9_-]+)+$")


class RuntimeCapabilities(BaseModel):
    schema_version: Literal[2] = 2
    runtime_kind: Literal["desktop", "self_hosted_web", "hosted"]
    """Presentation metadata only; capability fields, not this value, gate features.

    The local composition reports ``desktop`` or ``self_hosted_web`` and never
    ``hosted``.
    """
    chat: bool
    """Whether product chat is admitted; transient provider failures remain request errors."""
    model_selection: bool
    """Whether the owner may choose a model from the composition's admitted catalog."""
    model_role_selection: bool
    """Whether the owner may choose catalog models for application roles."""
    model_configuration: bool = False
    """Whether the owner may administer connections and add/remove catalog models."""
    provider_credentials: bool
    """Whether user-owned provider keys may be configured, independently of model choices."""
    chat_file_uploads: bool
    """Whether chat accepts owner file uploads; the UI hides upload entry points when false."""
    anima_creation: bool
    """Whether the owner may create Animas; the UI hides every create-Anima entry point when false."""
    automatic_episode_processing: bool = False
    """Whether the composition processes pending episode notes automatically.

    When true the UI shows the threshold setting and the chat's progress line, both
    served by ``/v1/memory/automatic-processing``. Absent means false.
    """
    chatgpt_plan: bool = False
    """Whether the owner may sign in with a ChatGPT plan (spec #919): local compositions only."""
    library_previews: bool = True
    """Whether Library cards load item previews; when false they show family icons and request none.

    Absent means true. The Library's Preview action and Avatar portraits do not depend on it.
    """
    local_filesystem_administration: bool
    """Whether host directories, catalog scans, paths and host logs may be administered.

    Logical memory files/folders, content assets and browser downloads are not
    host administration and do not depend on this permission.
    """
    native_features: bool
    """Whether Electron/native actions are offered; browser fullscreen/PiP use browser detection."""
    user_file_processing: UserFileProcessingCapability
    offline_speech_enabled: bool
    """Whether offline speech recognition (Parakeet) can be used now; read on every request."""
    offline_speech_asset_version: str | None
    """The active base Parakeet version, pinned by the browser with ``?v=``."""
    offline_speech_gpu_asset_version: str | None = None
    """The active WebGPU Parakeet version, or null when that set is unavailable."""
    offline_multilingual_speech_enabled: bool = False
    """Whether offline multilingual speech recognition (SenseVoice) can be used now; read on every request."""
    offline_multilingual_speech_asset_version: str | None = None
    """The active base SenseVoice version, pinned by the browser with ``?v=``."""
    offline_multilingual_speech_gpu_asset_version: str | None = None
    """The active WebGPU SenseVoice version, or null when that set is unavailable."""
    companion_safety: CompanionSafetyCapability
    web_search: WebSearchCapability = Field(default_factory=WebSearchCapability)
    gemini_tts: GeminiTtsCapability | None = None
    """Gemini voice models and prebuilt voices, present only where the composition offers Gemini voice."""
    browser_telemetry: BrowserTelemetryCapability | None = None
    """Present only where the composition forwards browser telemetry; absent, the web app exports nothing.

    The local composition never reports it.
    """


__all__ = [
    "BrowserTelemetryCapability",
    "CompanionSafetyCapability",
    "RuntimeCapabilities",
    "UserFileProcessingCapability",
    "WebSearchCapability",
]

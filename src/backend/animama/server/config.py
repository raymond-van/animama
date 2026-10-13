from __future__ import annotations

import logging
import os
from datetime import timedelta
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from animama.app.model_catalog import RETIRED_BUILTIN_REPLACEMENTS
from animama.app.safety.config import MAX_REMINDER_HOURS, MIN_REMINDER_HOURS, OperatorSafetyConfig, valid_reminder_hours
from animama.app.safety.crisis_resources import CrisisResourceTableError, crisis_resource_table


def _env_text(name: str) -> str | None:
    value = os.getenv(name)
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed or None


def _env_bool(name: str, default: bool) -> bool:
    value = _env_text(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def _env_float(name: str, default: float) -> float:
    value = _env_text(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number, got {value!r}") from exc


def _resolved_path(value: str) -> Path:
    """Resolve a configured root without requiring it to exist yet."""

    return Path(value).expanduser().resolve(strict=False)


def _env_path(name: str) -> Path | None:
    value = _env_text(name)
    return _resolved_path(value) if value else None


def _paths_overlap(first: Path, second: Path) -> bool:
    return first == second or first in second.parents or second in first.parents


class Settings(BaseModel):
    animama_content_root: Path = _resolved_path(os.getenv("ANIMAMA_CONTENT_ROOT", "content"))
    animama_data_root: Path = _resolved_path(os.getenv("ANIMAMA_DATA_ROOT", "data"))
    animama_included_content_sources_json: str | None = _env_text("ANIMAMA_INCLUDED_CONTENT_SOURCES_JSON")
    animama_local_content_root: Path | None = _env_path("ANIMAMA_LOCAL_CONTENT_ROOT")
    # Serving policy belongs to the installation composition. These inputs
    # never come from a browser request or an installation-owner assertion.
    animama_public_origin: str = Field(
        default_factory=lambda: os.getenv("ANIMAMA_PUBLIC_ORIGIN", "http://localhost:8000")
    )
    animama_web_root: Path | None = Field(default_factory=lambda: _env_path("ANIMAMA_WEB_ROOT"))
    animama_desktop_renderer_capability: str | None = Field(
        default_factory=lambda: _env_text("ANIMAMA_DESKTOP_RENDERER_CAPABILITY"), repr=False
    )
    animama_desktop_control_token: str | None = Field(
        default_factory=lambda: _env_text("ANIMAMA_DESKTOP_CONTROL_TOKEN"), repr=False
    )
    # Compose retains its existing processing deployment; desktop explicitly
    # disables it until main verifies the matching executable feature pack.
    animama_user_file_processing_enabled: bool = _env_bool("ANIMAMA_USER_FILE_PROCESSING_ENABLED", True)
    animama_document_worker_instance_id: str | None = _env_text("ANIMAMA_DOCUMENT_WORKER_INSTANCE_ID")
    animama_document_pack_version: str | None = _env_text("ANIMAMA_DOCUMENT_PACK_VERSION")
    animama_docling_artifacts_path: Path | None = _env_path("ANIMAMA_DOCLING_ARTIFACTS_PATH")
    animama_parakeet_stt_enabled: bool = _env_bool("ANIMAMA_PARAKEET_STT_ENABLED", True)
    # Where Parakeet sets come from: the backend model-asset store
    # ("asset-store", the default for packaged desktop, built self-host and
    # native launches), whose installs apply without a restart, or an
    # operator's host sets served by development Vite ("operator", set by the
    # development Compose override).
    animama_parakeet_source: Literal["asset-store", "operator"] = Field(
        default_factory=lambda: _env_text("ANIMAMA_PARAKEET_SOURCE") or "asset-store", validate_default=True
    )
    # Native/frozen entrypoints validate loopback. The dedicated Compose
    # entrypoint has a fixed container-network bind, published only on loopback.
    animama_local_bind_host: str = os.getenv("ANIMAMA_LOCAL_BIND_HOST", "127.0.0.1")
    animama_database_url: str = os.getenv(
        "ANIMAMA_DATABASE_URL", "postgresql+asyncpg://animama:a@localhost:5432/animama"
    )
    animama_database_pool_size: int = int(os.getenv("ANIMAMA_DATABASE_POOL_SIZE", "10"))
    animama_database_max_overflow: int = int(os.getenv("ANIMAMA_DATABASE_MAX_OVERFLOW", "20"))
    animama_database_pool_timeout_seconds: float = float(os.getenv("ANIMAMA_DATABASE_POOL_TIMEOUT_SECONDS", "30"))
    animama_database_pool_recycle_seconds: int = int(os.getenv("ANIMAMA_DATABASE_POOL_RECYCLE_SECONDS", "-1"))
    animama_database_pool_pre_ping: bool = _env_bool("ANIMAMA_DATABASE_POOL_PRE_PING", True)
    openai_base_url: str | None = _env_text("OPENAI_BASE_URL")
    private_upload_url_ttl_seconds: int = int(os.getenv("ANIMAMA_PRIVATE_UPLOAD_URL_TTL_SECONDS", "900"))
    anima_vrm_max_upload_bytes: int = int(os.getenv("ANIMAMA_VRM_MAX_UPLOAD_BYTES", str(100 * 1024 * 1024)))
    anima_pocket_voice_catalog_max_upload_bytes: int = int(
        os.getenv("ANIMAMA_POCKET_VOICE_CATALOG_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024))
    )
    anima_user_file_max_upload_bytes: int = int(os.getenv("ANIMAMA_USER_FILE_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
    anima_user_file_max_process_bytes: int = int(
        os.getenv("ANIMAMA_USER_FILE_MAX_PROCESS_BYTES", str(10 * 1024 * 1024))
    )
    anima_user_file_processing_poll_seconds: float = float(os.getenv("ANIMAMA_USER_FILE_PROCESSING_POLL_SECONDS", "2"))
    anima_user_file_processing_batch_size: int = int(os.getenv("ANIMAMA_USER_FILE_PROCESSING_BATCH_SIZE", "1"))
    anima_user_file_processing_lease_seconds: int = int(os.getenv("ANIMAMA_USER_FILE_PROCESSING_LEASE_SECONDS", "300"))
    anima_user_file_processing_max_attempts: int = int(os.getenv("ANIMAMA_USER_FILE_PROCESSING_MAX_ATTEMPTS", "3"))
    anima_user_file_docling_timeout_seconds: int = int(os.getenv("ANIMAMA_USER_FILE_DOCLING_TIMEOUT_SECONDS", "120"))
    anima_user_file_docling_enable_ocr: bool = _env_bool("ANIMAMA_USER_FILE_DOCLING_ENABLE_OCR", False)
    anima_user_file_docling_do_table_structure: bool = _env_bool(
        "ANIMAMA_USER_FILE_DOCLING_DO_TABLE_STRUCTURE",
        True,
    )
    anima_user_file_docling_accelerator: str = os.getenv("ANIMAMA_USER_FILE_DOCLING_ACCELERATOR", "cpu")
    anima_user_file_docling_num_threads: int = int(os.getenv("ANIMAMA_USER_FILE_DOCLING_NUM_THREADS", "4"))
    anima_user_file_docling_table_mode: str = os.getenv("ANIMAMA_USER_FILE_DOCLING_TABLE_MODE", "fast")
    anima_user_file_docling_warmup: bool = _env_bool("ANIMAMA_USER_FILE_DOCLING_WARMUP", True)
    anima_user_file_chunk_max_tokens: int = int(os.getenv("ANIMAMA_USER_FILE_CHUNK_MAX_TOKENS", "800"))
    # A tiktoken encoding name for chunk sizing only; tokenization runs offline.
    anima_user_file_chunk_tokenizer_model: str = (
        _env_text("ANIMAMA_USER_FILE_CHUNK_TOKENIZER_MODEL") or "text-embedding-3-small"
    )
    anima_memory_file_max_bytes: int = int(os.getenv("ANIMAMA_MEMORY_FILE_MAX_BYTES", str(32 * 1024)))
    anima_chat_compaction_enabled: bool = _env_bool("ANIMAMA_CHAT_COMPACTION_ENABLED", True)
    # Cap on the app-compaction trigger; a row with a context window triggers
    # earlier (see context_budget.ContextBudget.post_response_trigger_tokens).
    anima_chat_compaction_threshold_tokens: int = int(os.getenv("ANIMAMA_CHAT_COMPACTION_THRESHOLD_TOKENS", "90000"))
    anima_chat_compaction_recent_message_min_count: int = int(
        os.getenv("ANIMAMA_CHAT_COMPACTION_RECENT_MESSAGE_MIN_COUNT", "4")
    )
    # Upper bound on synchronous compaction before a turn is sent to a model
    # without native compaction; on timeout the turn trims history instead.
    anima_chat_presend_compaction_timeout_seconds: float = float(
        os.getenv("ANIMAMA_CHAT_PRESEND_COMPACTION_TIMEOUT_SECONDS", "90.0")
    )
    anima_default_model_provider_id: str = os.getenv(
        "ANIMAMA_DEFAULT_MODEL_PROVIDER_ID",
        "OpenAIResponsesHTTPAgent:gpt-6-luna",
    )
    # Operator defaults for model roles (catalog row ids). Unset utility and
    # memory-manager roles use the default chat model; embeddings stay off.
    anima_default_utility_model_provider_id: str | None = _env_text("ANIMAMA_DEFAULT_UTILITY_MODEL_PROVIDER_ID")
    anima_default_memory_manager_model_provider_id: str | None = _env_text(
        "ANIMAMA_DEFAULT_MEMORY_MANAGER_MODEL_PROVIDER_ID"
    )
    anima_default_embedding_model_provider_id: str | None = _env_text("ANIMAMA_DEFAULT_EMBEDDING_MODEL_PROVIDER_ID")
    anima_openai_responses_compaction_threshold_tokens: int = int(
        os.getenv("ANIMAMA_OPENAI_RESPONSES_COMPACTION_THRESHOLD_TOKENS", "90000")
    )
    anima_chat_compaction_prompt_version: str = os.getenv(
        "ANIMAMA_CHAT_COMPACTION_PROMPT_VERSION",
        "chat-compaction-v1",
    )
    anima_chat_title_generation_enabled: bool = _env_bool("ANIMAMA_CHAT_TITLE_GENERATION_ENABLED", True)
    anima_chat_title_generation_prompt_version: str = os.getenv(
        "ANIMAMA_CHAT_TITLE_GENERATION_PROMPT_VERSION",
        "chat-title-v1",
    )
    anima_chat_title_generation_max_chars: int = int(os.getenv("ANIMAMA_CHAT_TITLE_GENERATION_MAX_CHARS", "48"))
    anima_chat_title_generation_timeout_seconds: float = float(
        os.getenv("ANIMAMA_CHAT_TITLE_GENERATION_TIMEOUT_SECONDS", "20.0")
    )
    anima_chat_title_generation_reasoning_effort: str | None = (
        _env_text("ANIMAMA_CHAT_TITLE_GENERATION_REASONING_EFFORT") or "low"
    )
    anima_model_client_timeout_seconds: float = float(os.getenv("ANIMAMA_MODEL_CLIENT_TIMEOUT_SECONDS", "60.0"))
    # Host that local model-server presets (Ollama, LM Studio, llama.cpp, vLLM)
    # suggest; Compose sets host.docker.internal so containers reach the host.
    animama_local_model_host: str = os.getenv("ANIMAMA_LOCAL_MODEL_HOST", "127.0.0.1")
    elevenlabs_audio_max_upload_bytes: int = int(os.getenv("ELEVENLABS_AUDIO_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
    elevenlabs_max_in_flight: int = int(os.getenv("ELEVENLABS_MAX_IN_FLIGHT", "3"))
    elevenlabs_max_retries: int = int(os.getenv("ELEVENLABS_MAX_RETRIES", "2"))
    elevenlabs_retry_base_delay_seconds: float = float(os.getenv("ELEVENLABS_RETRY_BASE_DELAY_SECONDS", "0.75"))
    elevenlabs_retry_max_delay_seconds: float = float(os.getenv("ELEVENLABS_RETRY_MAX_DELAY_SECONDS", "8.0"))
    elevenlabs_concurrency_retry_delay_seconds: float = float(
        os.getenv("ELEVENLABS_CONCURRENCY_RETRY_DELAY_SECONDS", "1.5")
    )
    # Companion safety (spec R8). The global switch turns the AI notice, crisis
    # detection (including OpenAI Responses moderation) and the crisis card off together; the Companion
    # Guardrails in chat instructions are never configurable.
    companion_safety_enabled: bool = _env_bool("ANIMAMA_COMPANION_SAFETY_ENABLED", True)
    ai_notice_enabled: bool = _env_bool("ANIMAMA_AI_NOTICE_ENABLED", True)
    ai_notice_reminder_hours: float = _env_float("ANIMAMA_AI_NOTICE_REMINDER_HOURS", 3.0)
    crisis_detection_enabled: bool = _env_bool("ANIMAMA_CRISIS_DETECTION_ENABLED", True)
    crisis_resources_path: Path | None = _env_path("ANIMAMA_CRISIS_RESOURCES_PATH")
    avatar_upload_cleanup_interval_seconds: int = int(os.getenv("AVATAR_UPLOAD_CLEANUP_INTERVAL_SECONDS", "300"))
    avatar_upload_cleanup_batch_size: int = int(os.getenv("AVATAR_UPLOAD_CLEANUP_BATCH_SIZE", "50"))

    @model_validator(mode="after")
    def validate_local_roots(self) -> Settings:
        """Keep portable content and private data in disjoint trees."""

        content_root = self.animama_content_root.resolve(strict=False)
        data_root = self.animama_data_root.resolve(strict=False)
        if _paths_overlap(content_root, data_root):
            raise ValueError("ANIMAMA_CONTENT_ROOT and ANIMAMA_DATA_ROOT must be disjoint directories")
        self.animama_content_root = content_root
        self.animama_data_root = data_root
        return self

    @model_validator(mode="after")
    def replace_retired_model_defaults(self) -> Settings:
        """Point operator chat-model defaults that name a retired built-in at its replacement.

        An older `.env` may still pin a retired row; without this, Anima creation
        would refuse the inactive default and roles would resolve to off.
        """

        for field in (
            "anima_default_model_provider_id",
            "anima_default_utility_model_provider_id",
            "anima_default_memory_manager_model_provider_id",
        ):
            configured = getattr(self, field)
            replacement = RETIRED_BUILTIN_REPLACEMENTS.get(configured) if configured else None
            if replacement is not None:
                logging.getLogger(__name__).warning(
                    "Model default %s names retired %s; using %s", field, configured, replacement
                )
                setattr(self, field, replacement)
        return self

    @model_validator(mode="after")
    def validate_companion_safety(self) -> Settings:
        """Reject an unusable reminder interval or crisis resource table at startup."""

        if valid_reminder_hours(self.ai_notice_reminder_hours) is None:
            raise ValueError(
                "ANIMAMA_AI_NOTICE_REMINDER_HOURS must be a number of hours between "
                f"{MIN_REMINDER_HOURS:g} and {MAX_REMINDER_HOURS:g}"
            )
        try:
            crisis_resource_table(self.crisis_resources_path)
        except CrisisResourceTableError as exc:
            raise ValueError(f"ANIMAMA_CRISIS_RESOURCES_PATH: {exc}") from exc
        return self

    @property
    def companion_safety(self) -> OperatorSafetyConfig:
        return OperatorSafetyConfig(
            enabled=self.companion_safety_enabled,
            ai_notice_enabled=self.ai_notice_enabled,
            reminder_interval=timedelta(hours=self.ai_notice_reminder_hours),
            crisis_detection_enabled=self.crisis_detection_enabled,
            crisis_resources_path=self.crisis_resources_path,
        )


settings = Settings()

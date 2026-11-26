"""Defaults for common OpenAI-compatible model servers.

Presets only fill defaults when the owner adds a connection. Every owner
connection uses the same Chat Completions protocol behavior; the preset records
the usual endpoint, whether a key is expected and the request-shape options that
server family needs. The ``openai`` and ``anthropic`` presets describe the
built-in connections and are never owner-selectable. The owner can change any value afterwards, except a preset's
fixed request headers, which every request to a connection with that preset
carries.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType

from animama.domain.model_connection import (
    REASONING_MODE_DEEPSEEK_THINKING,
    REASONING_MODE_OMIT,
    REASONING_MODE_OPENAI_EFFORT,
    ModelConnectionCompatibility,
)

LOCAL_SERVER_TIMEOUT_SECONDS = 300.0
"""Local servers may load a model on the first request, which can take minutes."""

CLOUD_TIMEOUT_SECONDS = 60.0

DEEPSEEK_REASONING_EFFORTS = frozenset({"none", "high", "max"})
"""Values DeepSeek accepts; ``none`` disables thinking."""

PRESET_OPENAI = "openai"
PRESET_ANTHROPIC = "anthropic"
PRESET_CHATGPT_PLAN = "chatgpt_plan"
PRESET_OLLAMA = "ollama"
PRESET_LM_STUDIO = "lmstudio"
PRESET_LLAMA_CPP = "llamacpp"
PRESET_VLLM = "vllm"
PRESET_DEEPSEEK = "deepseek"
PRESET_HUGGINGFACE = "huggingface"
PRESET_OPENROUTER = "openrouter"
PRESET_CUSTOM = "custom"

_NON_OPENAI_COMPATIBILITY = ModelConnectionCompatibility(
    fold_developer_role=True,
    send_openai_extensions=False,
)

ANTHROPIC_CONNECTION_COMPATIBILITY = ModelConnectionCompatibility(
    send_openai_extensions=False,
    send_stream_usage=False,
    reasoning_mode=REASONING_MODE_OMIT,
)
"""Neutral options for the built-in Anthropic connection.

It speaks the Messages API, so none of the Chat Completions request-shape
options apply; these values only keep it from advertising OpenAI behaviour.
"""

OPENROUTER_ATTRIBUTION_HEADERS: Mapping[str, str] = MappingProxyType(
    {"X-Title": "Animama", "HTTP-Referer": "https://animama.ai"}
)
"""OpenRouter's optional app attribution, sent on every OpenRouter request."""


@dataclass(frozen=True, slots=True)
class ModelConnectionPreset:
    """Defaults for one server family.

    Local presets derive their base URL from the composition's local model host
    and ``default_port``; cloud presets have a fixed ``default_base_url``.
    ``request_headers`` are fixed, non-secret headers sent on every request to
    a connection created with this preset.
    """

    id: str
    label: str
    logo_provider: str | None
    local: bool
    expects_key: bool
    compatibility: ModelConnectionCompatibility
    timeout_seconds: float
    default_port: int | None = None
    default_base_url: str | None = None
    suggested_credential_env: str | None = None
    owner_selectable: bool = True
    request_headers: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))

    def base_url(self, *, local_host: str) -> str | None:
        """Return the default base URL, using ``local_host`` for local servers."""

        if self.default_port is not None:
            return f"http://{local_host}:{self.default_port}/v1"
        return self.default_base_url


MODEL_CONNECTION_PRESETS: dict[str, ModelConnectionPreset] = {
    preset.id: preset
    for preset in (
        ModelConnectionPreset(
            id=PRESET_OPENAI,
            label="OpenAI",
            logo_provider="openai",
            local=False,
            expects_key=True,
            compatibility=ModelConnectionCompatibility(),
            timeout_seconds=CLOUD_TIMEOUT_SECONDS,
            owner_selectable=False,
        ),
        ModelConnectionPreset(
            id=PRESET_ANTHROPIC,
            label="Anthropic",
            logo_provider="anthropic",
            local=False,
            expects_key=True,
            compatibility=ANTHROPIC_CONNECTION_COMPATIBILITY,
            timeout_seconds=CLOUD_TIMEOUT_SECONDS,
            owner_selectable=False,
        ),
        # A sign-in, not a key: the session's token is the credential (spec #919).
        ModelConnectionPreset(
            id=PRESET_CHATGPT_PLAN,
            label="ChatGPT plan",
            logo_provider="openai",
            local=False,
            expects_key=False,
            compatibility=ModelConnectionCompatibility(),
            timeout_seconds=CLOUD_TIMEOUT_SECONDS,
            owner_selectable=False,
        ),
        ModelConnectionPreset(
            id=PRESET_OLLAMA,
            label="Ollama",
            logo_provider="ollama",
            local=True,
            expects_key=False,
            compatibility=_NON_OPENAI_COMPATIBILITY,
            timeout_seconds=LOCAL_SERVER_TIMEOUT_SECONDS,
            default_port=11434,
        ),
        ModelConnectionPreset(
            id=PRESET_LM_STUDIO,
            label="LM Studio",
            logo_provider="lmstudio",
            local=True,
            expects_key=False,
            compatibility=_NON_OPENAI_COMPATIBILITY,
            timeout_seconds=LOCAL_SERVER_TIMEOUT_SECONDS,
            default_port=1234,
        ),
        ModelConnectionPreset(
            id=PRESET_LLAMA_CPP,
            label="llama.cpp",
            logo_provider="llamacpp",
            local=True,
            expects_key=False,
            compatibility=_NON_OPENAI_COMPATIBILITY,
            timeout_seconds=LOCAL_SERVER_TIMEOUT_SECONDS,
            default_port=8080,
        ),
        ModelConnectionPreset(
            id=PRESET_VLLM,
            label="vLLM",
            logo_provider="vllm",
            local=True,
            expects_key=False,
            compatibility=_NON_OPENAI_COMPATIBILITY,
            timeout_seconds=LOCAL_SERVER_TIMEOUT_SECONDS,
            default_port=8000,
        ),
        ModelConnectionPreset(
            id=PRESET_DEEPSEEK,
            label="DeepSeek",
            logo_provider="deepseek",
            local=False,
            expects_key=True,
            compatibility=ModelConnectionCompatibility(
                fold_developer_role=True,
                send_openai_extensions=False,
                reasoning_mode=REASONING_MODE_DEEPSEEK_THINKING,
            ),
            timeout_seconds=CLOUD_TIMEOUT_SECONDS,
            default_base_url="https://api.deepseek.com",
            suggested_credential_env="DEEPSEEK_API_KEY",
        ),
        ModelConnectionPreset(
            id=PRESET_HUGGINGFACE,
            label="Hugging Face",
            logo_provider="huggingface",
            local=False,
            expects_key=True,
            compatibility=ModelConnectionCompatibility(
                fold_developer_role=True,
                send_openai_extensions=False,
                send_stream_usage=False,
                strip_function_strict=True,
                reasoning_mode=REASONING_MODE_OMIT,
            ),
            timeout_seconds=CLOUD_TIMEOUT_SECONDS,
            default_base_url="https://router.huggingface.co/v1",
            suggested_credential_env="HF_TOKEN",
        ),
        ModelConnectionPreset(
            id=PRESET_OPENROUTER,
            label="OpenRouter",
            logo_provider="openrouter",
            local=False,
            expects_key=True,
            # OpenRouter ignores parameters a routed model does not support, so a
            # requested reasoning effort is safe to send.
            compatibility=ModelConnectionCompatibility(
                fold_developer_role=True,
                send_openai_extensions=False,
                reasoning_mode=REASONING_MODE_OPENAI_EFFORT,
            ),
            timeout_seconds=CLOUD_TIMEOUT_SECONDS,
            default_base_url="https://openrouter.ai/api/v1",
            suggested_credential_env="OPENROUTER_API_KEY",
            request_headers=OPENROUTER_ATTRIBUTION_HEADERS,
        ),
        ModelConnectionPreset(
            id=PRESET_CUSTOM,
            label="Custom",
            logo_provider=None,
            local=False,
            expects_key=False,
            compatibility=ModelConnectionCompatibility(
                fold_developer_role=True,
                send_openai_extensions=False,
                reasoning_mode=REASONING_MODE_OPENAI_EFFORT,
            ),
            timeout_seconds=CLOUD_TIMEOUT_SECONDS,
        ),
    )
}


def model_connection_preset(preset_id: str) -> ModelConnectionPreset:
    """Return a preset, falling back to Custom for unknown stored values."""

    return MODEL_CONNECTION_PRESETS.get(preset_id, MODEL_CONNECTION_PRESETS[PRESET_CUSTOM])


__all__ = [
    "CLOUD_TIMEOUT_SECONDS",
    "DEEPSEEK_REASONING_EFFORTS",
    "LOCAL_SERVER_TIMEOUT_SECONDS",
    "MODEL_CONNECTION_PRESETS",
    "PRESET_ANTHROPIC",
    "PRESET_CHATGPT_PLAN",
    "PRESET_CUSTOM",
    "PRESET_DEEPSEEK",
    "PRESET_HUGGINGFACE",
    "PRESET_LLAMA_CPP",
    "PRESET_LM_STUDIO",
    "PRESET_OLLAMA",
    "PRESET_OPENAI",
    "PRESET_OPENROUTER",
    "PRESET_VLLM",
    "OPENROUTER_ATTRIBUTION_HEADERS",
    "ModelConnectionPreset",
    "model_connection_preset",
]
